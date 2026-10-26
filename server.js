const express = require('express');
const path = require('path');

const config = require('./src/config');
const addons = require('./src/addons');
const streamer = require('./src/streamer');
const extractor = require('./src/extractor');
const progress = require('./src/progress');
const prepared = require('./src/prepared');
const ytdlp = require('./src/ytdlp');
const nuvio = require('./src/nuvio');
const plugins = require('./src/plugins');
const i18n = require('./src/i18n');

const cfg = config.get();

// Come ottenere il vero URL della fonte da un payload di download (risolvendo gli
// externalUrl degli addon "scraper"); fresh = ignora la cache dei link risolti.
async function resolvePayloadSource(p, { fresh = false } = {}) {
  if (!p.sourceUrl && p.externalUrl) {
    const r = await extractor.resolveExternalUrl(p.externalUrl, { fresh });
    return { url: r.sourceUrl, headers: { ...(p.headers || {}), ...(r.headers || {}) } };
  }
  return { url: p.sourceUrl, headers: p.headers || {} };
}
prepared.setResolver(resolvePayloadSource);
prepared.init();
ytdlp.init();
nuvio.init();

// Nome del file preparato: titolo + estensione della fonte (gli scraper danno .mp4).
function preparedFilename(p) {
  const ext = p.sourceUrl ? streamer.guessExtension(p.sourceUrl) : '.mp4';
  return `${streamer.sanitizeFilename(p.title || p.streamTitle || 'download')}${ext}`;
}

const APP_VERSION = '2.0.0-dev';

const app = express();
app.set('etag', false);

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const start = Date.now();
  console.log(`--> ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(express.json());
app.use(i18n.middleware);

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---- Search / TMDB ----

app.get('/api/search', asyncRoute(async (req, res) => {
  const { query } = req.query;
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: req.t('srv.missingQuery') });
  }
  const results = await addons.searchMulti(String(query).trim(), cfg.tmdbApiKey, cfg.language);
  res.json({ results });
}));

app.get('/api/seasons/:tmdbId', asyncRoute(async (req, res) => {
  const seasons = await addons.getSeasons(req.params.tmdbId, cfg.tmdbApiKey, cfg.language);
  res.json({ seasons });
}));

app.get('/api/episodes/:tmdbId/:season', asyncRoute(async (req, res) => {
  const episodes = await addons.getEpisodes(req.params.tmdbId, req.params.season, cfg.tmdbApiKey, cfg.language);
  res.json({ episodes });
}));

// ---- Streams (Stremio addon protocol) ----

app.get('/api/streams', asyncRoute(async (req, res) => {
  const { tmdbId, type, season, episode } = req.query;
  if (!tmdbId || !type) {
    return res.status(400).json({ error: req.t('srv.missingParams') });
  }
  if (type === 'tv' && (!season || !episode)) {
    return res.status(400).json({ error: req.t('srv.missingEpisode') });
  }

  const stremioType = type === 'tv' ? 'series' : 'movie';
  const imdbId = await addons.getImdbId(tmdbId, type, cfg.tmdbApiKey);
  if (!imdbId) {
    return res.status(404).json({ error: req.t('srv.noImdb') });
  }

  const stremioId = addons.buildStremioId(imdbId, stremioType, season, episode);
  const addonList = config.listAddons();
  const pluginsOn = !!plugins.settings().enabled;
  if (addonList.length === 0 && !pluginsOn) {
    return res.status(400).json({ error: req.t('srv.noAddons') });
  }

  const [fromAddons, fromPlugins] = await Promise.all([
    addons.getStreamsForAllAddons(addonList, stremioType, stremioId),
    pluginsOn
      ? addons.isAnimation(tmdbId, type, cfg.tmdbApiKey).catch(() => false)
        .then(animation => plugins.getStreams(tmdbId, type === 'tv' ? 'tv' : 'movie', season ? Number(season) : null, episode ? Number(episode) : null, cfg.addonTimeoutMs, { animation }))
      : { streams: [], errors: [] }
  ]);
  const streams = [...fromAddons.streams, ...fromPlugins.streams];
  const errors = [...fromAddons.errors, ...fromPlugins.errors];
  // Stessi criteri dell'addon per Nuvio: diretti con dimensione nota in cima, poi HLS;
  // i non supportati (torrent) in fondo, solo per informazione.
  const ranked = await rankDownloadable(streams.filter(s => s.supported));
  for (const s of ranked) {
    const job = prepared.get(prepared.keyFor({ vid: stremioId, addonName: s.addonName, streamTitle: s.title }));
    if (job) s.prepared = prepared.publicView(job, req.lang);
  }
  const unsupported = streams.filter(s => !s.supported);
  res.json({ imdbId, stremioId, streams: [...ranked, ...unsupported], errors });
}));

// ---- Impostazioni ----

function settingsView(current) {
  return {
    tmdbApiKey: current.tmdbApiKey,
    language: current.language,
    concurrentDownloads: current.concurrentDownloads,
    addonTimeoutMs: current.addonTimeoutMs,
    ytdlp: ytdlp.settings(),
    version: APP_VERSION
  };
}

app.get('/api/settings', (req, res) => {
  res.json(settingsView(config.get()));
});

app.post('/api/settings', (req, res) => {
  res.json(settingsView(config.updateSettings(req.body || {})));
});

// ---- Addons CRUD ----

app.get('/api/addons', (req, res) => {
  // Gli URL degli addon presi da Nuvio possono contenere chiavi personali: solo il dominio.
  const addons = config.listAddons().map(a => (a.origin === 'nuvio'
    ? { ...a, manifestUrl: (() => { try { return `${new URL(a.manifestUrl).origin}/…`; } catch { return '…'; } })() }
    : a));
  res.json({ addons });
});

// Legge il manifest di un addon: serve a ricavarne il nome e a dire se risponde e quanto
// ci mette.
async function fetchManifest(manifestUrl) {
  const start = Date.now();
  const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const manifest = await res.json();
  return { manifest, ms: Date.now() - start };
}

app.post('/api/addons', asyncRoute(async (req, res) => {
  const { manifestUrl } = req.body || {};
  let { name } = req.body || {};
  if (!manifestUrl || !/^https?:\/\//i.test(String(manifestUrl).trim())) {
    return res.status(400).json({ error: req.t('srv.badManifestUrl') });
  }
  // Il nome si può omettere: lo prendiamo dal manifest.
  if (!name) {
    try {
      const { manifest } = await fetchManifest(String(manifestUrl).trim());
      name = manifest.name || new URL(manifestUrl).hostname;
    } catch (e) {
      return res.status(400).json({ error: req.t('srv.manifestUnreachable', { msg: e.name === 'TimeoutError' ? 'timeout' : e.message }) });
    }
  }
  const addon = config.addAddon({ name, manifestUrl });
  res.status(201).json({ addon });
}));

app.get('/api/addons/:id/check', asyncRoute(async (req, res) => {
  const addon = config.listAddons().find(a => a.id === req.params.id);
  if (!addon) return res.status(404).json({ error: req.t('srv.addonNotFound') });
  try {
    const { ms } = await fetchManifest(addon.manifestUrl);
    res.json({ ok: true, ms });
  } catch (e) {
    res.json({ ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message });
  }
}));

app.delete('/api/addons/:id', (req, res) => {
  // Gli addon presi da Nuvio non si cancellano (tornerebbero alla prossima lettura):
  // si escludono dalle fonti.
  const fromNuvio = config.listAddons().find(a => a.id === req.params.id && a.origin === 'nuvio');
  if (fromNuvio) {
    nuvio.setUsed(req.params.id, false);
    return res.status(204).end();
  }
  const removed = config.removeAddon(req.params.id);
  if (!removed) return res.status(404).json({ error: req.t('srv.addonNotFound') });
  res.status(204).end();
});

// ---- Download (streaming diretto verso il dispositivo, nessuno storage sul server) ----

function decodeDownloadPayload(raw) {
  if (!raw) return {};
  // Formato preferito: base64url (nessun carattere speciale, sopravvive a qualunque
  // ri-codifica imperfetta lungo il tragitto browser/app -> proxy -> server).
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // Fallback per compatibilità con eventuali link vecchio formato (JSON + encodeURIComponent).
    return JSON.parse(raw);
  }
}

function encodeDownloadPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

async function handleDownload(rawData, req, res) {
  let params;
  try {
    params = decodeDownloadPayload(rawData);
  } catch {
    return res.status(400).json({ error: req.t('srv.badData') });
  }

  // Ripresa di un download HLS (Nuvio riapre la connessione a ogni cambio di rete): ci si
  // aggancia alla conversione già in corso o finita invece di risolvere di nuovo lo stream
  // (che per gli externalUrl darebbe un URL con token diverso) e di ripartire da zero.
  const sourceKey = params.externalUrl || params.sourceUrl;
  if (sourceKey && await streamer.serveExistingHls(sourceKey, req, res)) return;

  // File già preparato (o in preparazione) sul server: si serve dal disco, senza toccare
  // la fonte. Le riprese di Nuvio arrivano così alla velocità della rete di casa.
  const original = { ...params };
  const useDisk = req.method !== 'HEAD';
  if (useDisk) {
    const existing = prepared.get(prepared.keyFor(original));
    if (existing && existing.status !== 'failed' && await prepared.serve(existing, req, res)) return;
  }

  // Stream "scraper" (solo externalUrl): risolvi lato server nel vero URL dello stream
  // prima di avviare il download. Il risultato resta in memoria qualche minuto; se intanto
  // il link scade, refreshSource lo risolve di nuovo durante il download.
  let refreshSource = null;
  if (!params.sourceUrl && params.externalUrl) {
    const baseHeaders = params.headers || {};
    let resolved;
    try {
      resolved = await extractor.resolveExternalUrl(params.externalUrl);
    } catch (e) {
      return res.status(e.status || 502).json({ error: i18n.msgOf(e, req.lang) });
    }
    params.sourceUrl = resolved.sourceUrl;
    params.headers = { ...baseHeaders, ...(resolved.headers || {}) };
    refreshSource = async () => {
      const fresh = await extractor.resolveExternalUrl(params.externalUrl, { fresh: true });
      return { url: fresh.sourceUrl, headers: { ...baseHeaders, ...(fresh.headers || {}) } };
    };
  }

  let preparedDl;
  try {
    preparedDl = streamer.prepareDownload(params);
  } catch (e) {
    return res.status(e.status || 400).json({ error: i18n.msgOf(e, req.lang) });
  }

  // File diretto: NoStream lo scarica sul proprio disco a piena velocità e intanto lo passa
  // al client. Se la dimensione non è nota (o manca spazio) si ripiega sul proxy diretto.
  if (useDisk && preparedDl.type === 'direct') {
    const job = prepared.ensure(original, { title: original.title, filename: preparedDl.filename, onDemand: true });
    if (await prepared.serve(job, req, res)) return;
  }

  await streamer.streamDownload({ ...preparedDl, sourceKey, refreshSource }, req, res);
}

// Formato con estensione nel path (es. /api/download/<dati>/Titolo.ts): alcune app,
// incluso il download nativo di Nuvio, decidono se un link è "un file diretto scaricabile"
// guardando l'estensione nell'URL — un endpoint puramente query-string come
// /api/download?data=... non ne ha nessuna e viene scartato. Il segmento finale è solo
// cosmetico: il nome file vero per l'header Content-Disposition è ricalcolato lato server.
// Download avviati dalla coda web: "?dl=<id>" ne traccia l'avanzamento (vedi /api/progress).
function trackDownload(req, res) {
  if (req.query.dl && req.method !== 'HEAD') progress.track(String(req.query.dl).slice(0, 64), res);
  logDownloadConnection(req, res);
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Una riga di log per ogni connessione di download: da che byte parte, quanto ha mandato,
// quanto è durata e come è finita. Serve a capire le pause dei download (es. in Nuvio).
function logDownloadConnection(req, res) {
  const start = Date.now();
  const via = req.headers['x-forwarded-for'] ? `proxy, client ${req.headers['x-forwarded-for']}` : req.socket.remoteAddress;
  let bytes = 0;
  const count = chunk => {
    if (chunk && typeof chunk !== 'function') bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  };
  const write = res.write;
  res.write = function (chunk, ...rest) { count(chunk); return write.call(this, chunk, ...rest); };
  const end = res.end;
  res.end = function (chunk, ...rest) { count(chunk); return end.call(this, chunk, ...rest); };
  res.on('close', () => {
    const name = req.params.filename ? decodeURIComponent(req.params.filename) : 'download';
    const how = res.writableFinished ? 'completata' : 'chiusa prima della fine';
    console.log(`[download] ${name} ${req.method} range=${req.headers.range || '-'} -> ${res.statusCode}, ${formatMB(bytes)} in ${((Date.now() - start) / 1000).toFixed(1)} s, ${how} (${via})`);
  });
}

app.get('/api/progress', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 50);
  res.json(progress.get(ids));
});

app.get('/api/download/:data/:filename', asyncRoute(async (req, res) => {
  trackDownload(req, res);
  await handleDownload(req.params.data, req, res);
}));

app.get('/api/download', asyncRoute(async (req, res) => {
  trackDownload(req, res);
  await handleDownload(req.query.data, req, res);
}));

// ---- Preparazione sul server ----

// File sul server: preparati dagli addon e scaricati da link con yt-dlp, in un'unica lista.
app.get('/api/prepared', (req, res) => {
  const items = [...prepared.list(req.lang), ...ytdlp.list(req.lang)].sort((a, b) => b.createdAt - a.createdAt);
  res.json({ items });
});

app.post('/api/prepared', (req, res) => {
  let params;
  try {
    params = decodeDownloadPayload(req.body && req.body.data);
  } catch {
    return res.status(400).json({ error: req.t('srv.badData') });
  }
  if (!params.sourceUrl && !params.externalUrl) return res.status(400).json({ error: req.t('srv.noUrl') });
  const job = prepared.ensure(params, { title: params.title, filename: preparedFilename(params) });
  res.status(201).json({ item: prepared.publicView(job, req.lang) });
});

app.delete('/api/prepared/:key', (req, res) => {
  if (!prepared.remove(req.params.key) && !ytdlp.remove(req.params.key)) return res.status(404).json({ error: req.t('srv.notFound') });
  res.status(204).end();
});

app.get('/api/prepared/:key/:filename', asyncRoute(async (req, res) => {
  logDownloadConnection(req, res);
  const job = prepared.get(req.params.key);
  if (!job) return res.status(404).json({ error: req.t('srv.fileGone') });
  if (!(await prepared.serve(job, req, res)) && !res.headersSent) {
    res.status(502).json({ error: i18n.errorText(job, req.lang) || req.t('srv.prepFailed') });
  }
}));

// ---- Account Nuvio (addon come fonti) ----

function nuvioRoute(fn) {
  return asyncRoute(async (req, res) => {
    try {
      await fn(req);
      res.json(nuvio.status(req.lang));
    } catch (e) {
      res.status(e.auth ? 401 : 502).json({ error: i18n.msgOf(e, req.lang) });
    }
  });
}

app.get('/api/nuvio', (req, res) => res.json(nuvio.status(req.lang)));
app.post('/api/nuvio/login', nuvioRoute(req => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    const e = new i18n.AppError('srv.nuvioNeedLogin');
    e.auth = true;
    throw e;
  }
  return nuvio.login(email, password);
}));
app.post('/api/nuvio/sync', nuvioRoute(() => nuvio.sync()));
app.post('/api/nuvio/profile', nuvioRoute(req => nuvio.setProfile((req.body || {}).profileId)));
app.post('/api/nuvio/addons/:id', nuvioRoute(req => nuvio.setUsed(req.params.id, !!(req.body || {}).used)));
app.post('/api/nuvio/plugins', nuvioRoute(req => nuvio.setPluginsEnabled(!!(req.body || {}).enabled)));
app.post('/api/nuvio/plugins/:key', nuvioRoute(req => nuvio.setPluginUsed(req.params.key, !!(req.body || {}).used)));
app.post('/api/nuvio/logout', nuvioRoute(() => nuvio.logout()));

// ---- Video da link (yt-dlp) ----

function checkLinkUrl(url) {
  if (!url || !/^https?:\/\//i.test(String(url).trim())) {
    const e = new i18n.AppError('srv.badLink', {}, 400);
    throw e;
  }
  return String(url).trim();
}

app.post('/api/link/info', asyncRoute(async (req, res) => {
  const url = checkLinkUrl(req.body && req.body.url);
  try {
    res.json(await ytdlp.info(url));
  } catch (e) {
    res.status(422).json({ error: i18n.msgOf(e, req.lang) });
  }
}));

app.post('/api/link/jobs', (req, res) => {
  const { url, mode, title, index } = req.body || {};
  const job = ytdlp.ensure({ url: checkLinkUrl(url), mode, title, index: parseInt(index, 10) || null });
  res.status(201).json({ item: ytdlp.publicView(job, req.lang) });
});

app.get('/api/link/:key/:filename', (req, res) => {
  logDownloadConnection(req, res);
  const job = ytdlp.get(req.params.key);
  if (!job) return res.status(404).json({ error: req.t('srv.fileGone') });
  ytdlp.serve(job, req, res);
});

// Indirizzi IPv4 del server nella rete locale: servono quando la pagina è aperta da
// localhost (versione portable sul PC) per dare al telefono l'URL giusto dell'addon.
app.get('/api/network', (req, res) => {
  const ips = Object.values(require('os').networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address))
    .map(i => i.address);
  res.json({ port: cfg.port, ips, portable: !!process.env.NOSTREAM_PORTABLE });
});

app.get('/api/ytdlp', asyncRoute(async (req, res) => {
  res.json({ version: await ytdlp.version(), settings: ytdlp.settings() });
}));

app.post('/api/ytdlp/update', asyncRoute(async (req, res) => {
  try {
    res.json(await ytdlp.update());
  } catch (e) {
    res.status(502).json({ error: req.t('srv.updateFailed', { msg: i18n.msgOf(e, req.lang) }) });
  }
}));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pagina aperta da Nuvio toccando "📦 Prepara sul server" (stream con solo externalUrl,
// che Nuvio apre nel browser): avvia la preparazione e ne mostra l'avanzamento.
app.get('/prepare/:data', (req, res) => {
  let params;
  try {
    params = decodeDownloadPayload(req.params.data);
  } catch {
    return res.status(400).send(req.t('srv.badLink'));
  }
  const job = prepared.ensure(params, { title: params.title, filename: preparedFilename(params) });
  const pct = job.size ? Math.floor((job.written / job.size) * 100) : 0;
  const state = {
    queued: req.t('srv.prep.queued'),
    running: job.size ? req.t('srv.prep.running', { pct, sent: formatSize(job.written), total: formatSize(job.size) }) : req.t('srv.prep.connecting'),
    done: req.t('srv.prep.done', { size: formatSize(job.size) }),
    failed: req.t('srv.prep.failed', { msg: i18n.errorText(job, req.lang) || '?' })
  }[job.status];
  const finished = job.status === 'done' || job.status === 'failed';
  res.type('html').send(`<!DOCTYPE html><html lang="${req.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${finished ? '' : '<meta http-equiv="refresh" content="4">'}
<title>NoStream · ${escapeHtml(req.t('srv.prep.title'))}</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
:root{--bg:#f6f6f4;--surface:#fff;--line:#e2e2dc;--text:#17181c;--muted:#676b74;--accent:#f5c542;--ok:#138a56;--err:#d23535}
@media (prefers-color-scheme:dark){:root{--bg:#0f1015;--surface:#181a22;--line:#2a2d3a;--text:#eceef3;--muted:#959bab;--ok:#3ecf8e;--err:#ff6b6b}}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);padding:28px 16px}
.box{max-width:520px;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:1.15rem;margin:12px 0 4px}p{line-height:1.5;margin:10px 0}.muted{color:var(--muted);font-size:.95rem}
.bar{height:8px;border-radius:99px;overflow:hidden;background:var(--line)}.bar div{height:100%;background:var(--accent)}
.ok{color:var(--ok);font-weight:650}.ko{color:var(--err);font-weight:650}
</style></head><body><div class="box">
<img src="/logo.svg" alt="" width="40" height="40">
<h1>${escapeHtml(req.t('srv.prep.title'))}</h1>
<p><strong>${escapeHtml(job.title || job.filename)}</strong></p>
<div class="bar"><div style="width:${job.status === 'done' ? 100 : pct}%"></div></div>
<p class="${job.status === 'done' ? 'ok' : job.status === 'failed' ? 'ko' : ''}">${escapeHtml(state)}</p>
<p class="muted">${escapeHtml(req.t('srv.prep.hint'))}</p>
</div></body></html>`);
});

// ---- Stremio/Nuvio addon (NoStream installato come addon dentro Nuvio) ----
//
// Espone questo stesso server come addon: quando Nuvio interroga /stream/:type/:id.json,
// NoStream ri-interroga gli addon "sorgente" configurati (stessa logica di
// /api/streams), tiene solo gli stream scaricabili e li restituisce come voci con `url`
// puntato a /api/download/... — un link che si comporta come un normale file video diretto
// (risponde con Content-Type/Content-Length/Content-Disposition validi una volta pronto),
// così il download nativo di Nuvio lo riconosce e lo scarica da solo sul device, senza
// passare dal browser esterno.

// ID storico, da non cambiare: Nuvio riconosce l'addon da qui, e con un ID nuovo
// andrebbe reinstallato su ogni dispositivo.
const ADDON_ID = 'org.nuvio-offline';

function addonCors(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}

// Protocollo con cui il client ha raggiunto davvero il server. Dietro un reverse proxy
// HTTPS (es. `tailscale serve` su https://pve.van-pike.ts.net:4321) a Node arriva HTTP
// in chiaro: costruendo i link di download con req.protocol uscivano "http://" verso una
// porta HTTPS, e il proxy rispondeva 400 "Client sent an HTTP request to an HTTPS server".
function publicProtocol(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') return forwarded;
  // tailscale serve espone sempre i nomi *.ts.net in HTTPS
  if (/\.ts\.net(:\d+)?$/i.test(req.get('host') || '')) return 'https';
  return req.protocol;
}

// "direct" = file video che NoStream inoltra così com'è (con dimensione e Range);
// "hls" = playlist .m3u8 da convertire con ffmpeg. Per gli stream con solo externalUrl
// il tipo si conosce solo dopo la risoluzione: gx (MixDrop) dà sempre un .mp4 diretto,
// gli altri provider (css, dd, sp3, voe) una playlist HLS.
const DIRECT_PROVIDERS = new Set(['gx']);
function streamKind(s) {
  if (s.url) return streamer.detectType(s.url) === 'hls' ? 'hls' : 'direct';
  return DIRECT_PROVIDERS.has(extractor.providerFromUrl(s.externalUrl)) ? 'direct' : 'hls';
}

const SIZE_PROBE_TIMEOUT_MS = 8000;

// Dimensione del file diretto (in byte) chiedendo alla fonte il solo primo byte; null se la
// fonte non risponde in tempo o non la dichiara. Non blocca mai la risposta oltre il timeout.
async function probeDirectSize(s) {
  const probe = (async () => {
    let sourceUrl = s.url;
    let headers = s.headers || {};
    if (!sourceUrl) {
      const resolved = await extractor.resolveExternalUrl(s.externalUrl);
      sourceUrl = resolved.sourceUrl;
      headers = { ...headers, ...(resolved.headers || {}) };
    }
    const r = await fetch(sourceUrl, {
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(SIZE_PROBE_TIMEOUT_MS)
    });
    if (r.body) r.body.cancel().catch(() => {});
    // Playlist HLS con un URL senza «.m3u8» (succede con alcuni plugin e addon)
    if (/mpegurl/i.test(r.headers.get('content-type') || '')) return { hls: true, size: null };
    const total = (r.headers.get('content-range') || '').split('/')[1];
    const size = parseInt(total || (r.status === 200 ? r.headers.get('content-length') : ''), 10);
    return { hls: false, size: r.ok && Number.isFinite(size) && size > 0 ? size : null };
  })();
  const timeout = new Promise(resolve => setTimeout(() => resolve({ hls: false, size: null }), SIZE_PROBE_TIMEOUT_MS));
  return Promise.race([probe.catch(() => ({ hls: false, size: null })), timeout]);
}

function formatSize(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Stream scaricabili deduplicati e ordinati dal migliore: usato sia dall'addon per Nuvio
// sia dalla piattaforma web (la coda prende il primo e, se fallisce, il successivo).
async function rankDownloadable(downloadable) {
  // Lo stesso link può arrivare da più addon (es. più installazioni dello stesso addon):
  // ne teniamo uno solo, con i nomi di tutti gli addon che lo hanno proposto.
  const unique = new Map();
  for (const s of downloadable) {
    const key = s.url || s.externalUrl;
    const existing = unique.get(key);
    if (existing) {
      if (!existing.addonNames.includes(s.addonName)) existing.addonNames.push(s.addonName);
    } else {
      unique.set(key, { ...s, addonNames: [s.addonName], kind: streamKind(s) });
    }
  }
  const entries = [...unique.values()];

  // Per i file diretti chiediamo subito la dimensione alla fonte: Nuvio la mostra come
  // badge (behaviorHints.videoSize) e conferma che il link è davvero scaricabile.
  await Promise.all(entries.filter(e => e.kind === 'direct').map(async e => {
    const probed = await probeDirectSize(e);
    if (probed.hls) e.kind = 'hls';
    else e.size = probed.size;
  }));

  // File diretti prima (scaricano a velocità piena, con dimensione e ripresa), poi gli HLS
  // (conversione al volo, senza dimensione). Tra i diretti, quelli con dimensione nota
  // davanti; l'ordine originale degli addon resta come criterio finale.
  const rank = e => (e.kind === 'direct' ? (e.size ? 0 : 1) : 2);
  entries.sort((a, b) => rank(a) - rank(b));
  return entries;
}

function parseStremioId(id) {
  const [imdbId, season, episode] = id.split(':');
  return { imdbId, season, episode };
}

app.get('/manifest.json', addonCors, (req, res) => {
  res.json({
    id: ADDON_ID,
    version: '1.0.0',
    name: 'NoStream',
    logo: `${publicProtocol(req)}://${req.get('host')}/logo-256.png`,
    description: req.t('srv.addon.description'),
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: false }
  });
});

app.get('/stream/:type/:id.json', addonCors, asyncRoute(async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'movie' && type !== 'series') return res.json({ streams: [] });

  const addonList = config.listAddons();
  const pluginsOn = !!plugins.settings().enabled;
  if (!addonList.length && !pluginsOn) return res.json({ streams: [] });

  const { imdbId, season, episode } = parseStremioId(id);
  // L'id TMDB serve ai plugin (e il titolo al nome del file): si chiede in parallelo agli addon.
  const infoPromise = addons.findByImdbId(imdbId, type, cfg.tmdbApiKey, cfg.language).catch(() => null);
  const [fromAddons, fromPlugins] = await Promise.all([
    addons.getStreamsForAllAddons(addonList, type, id),
    pluginsOn
      ? infoPromise.then(info => (info && info.tmdbId
        ? plugins.getStreams(info.tmdbId, type === 'series' ? 'tv' : 'movie', season ? Number(season) : null, episode ? Number(episode) : null, cfg.addonTimeoutMs, { animation: info.animation })
        : { streams: [] }))
      : { streams: [] }
  ]);
  const downloadable = [...fromAddons.streams, ...fromPlugins.streams].filter(s => s.supported);
  if (!downloadable.length) return res.json({ streams: [] });

  let label = id;
  try {
    const info = await infoPromise;
    if (info && info.title) {
      label = type === 'series'
        ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : `${info.title}${info.year ? ` (${info.year})` : ''}`;
    }
  } catch {
    // TMDB non configurata/raggiungibile: usa l'id grezzo come titolo del file
  }

  const entries = await rankDownloadable(downloadable);

  const base = `${publicProtocol(req)}://${req.get('host')}`;
  const result = entries.flatMap(s => {
    const payload = {
      addonName: s.addonName,
      sourceUrl: s.url || undefined,
      externalUrl: s.externalUrl || undefined,
      headers: s.headers,
      streamTitle: s.title,
      title: label,
      vid: id,
      kind: s.kind
    };
    // Nuvio dà al file scaricato l'estensione che trova in questo URL.
    const ext = s.kind === 'direct'
      ? (s.url ? streamer.guessExtension(s.url) : '.mp4')
      : '.ts';
    const cosmeticFilename = encodeURIComponent(`${label}${ext}`);
    const downloadUrl = `${base}/api/download/${encodeDownloadPayload(payload)}/${cosmeticFilename}`;
    const provider = s.externalUrl ? extractor.providerFromUrl(s.externalUrl) : null;
    const details = s.kind === 'direct'
      ? req.t('srv.addon.directDetails', { size: s.size ? ` · ${formatSize(s.size)}` : '' })
      : req.t('srv.addon.hlsDetails');
    const hints = { filename: `${label}${ext}` };
    if (s.size) hints.videoSize = s.size;
    const origin = `${s.addonNames.join(', ')}${provider ? ` · ${provider}` : ''}`;

    // Il "name" è anche il criterio con cui Nuvio ordina gli stream di un addon:
    // "⏳"/"✅" (sul server) prima di "⬇️", poi "📦" e infine "🔄".
    const job = s.kind === 'direct' ? prepared.get(prepared.keyFor(payload)) : null;
    if (job && job.status !== 'failed') {
      const view = prepared.publicView(job);
      const pct = job.size ? Math.floor((job.written / job.size) * 100) : 0;
      const ready = job.status === 'done';
      const readyHints = { filename: `${label}${ext}` };
      if (job.size) readyHints.videoSize = job.size;
      return [{
        name: ready ? req.t('srv.addon.ready') : req.t('srv.addon.onServer', { pct }),
        title: [
          ready
            ? req.t('srv.addon.readyDetails', { size: job.size ? ` · ${formatSize(job.size)}` : '' })
            : req.t('srv.addon.preparingDetails'),
          s.title,
          origin
        ].join('\n'),
        url: `${base}${view.path.replace(/[^/]+$/, cosmeticFilename)}`,
        behaviorHints: readyHints
      }];
    }

    const items = [{
      name: s.kind === 'direct' ? req.t('srv.addon.direct') : req.t('srv.addon.hls'),
      title: [details, s.title, origin].join('\n'),
      url: downloadUrl,
      behaviorHints: hints
    }];
    if (s.kind === 'direct') {
      items.push({
        name: req.t('srv.addon.prepare'),
        title: [
          req.t('srv.addon.prepareDetails'),
          s.title,
          origin
        ].join('\n'),
        externalUrl: `${base}/prepare/${encodeDownloadPayload(payload)}`
      });
    }
    return items;
  });

  res.json({ streams: result });
}));

// ---- Static files ----

app.use(express.static(path.join(__dirname, 'public')));

// ---- Error handler ----

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: i18n.msgOf(err, req.lang || 'it') });
});

const httpServer = app.listen(cfg.port, () => {
  console.log(`NoStream v${APP_VERSION} in ascolto su http://localhost:${cfg.port}`);
});

// Node tronca da solo una richiesta che impiega troppo a ricevere risposta completa
// (requestTimeout, default 5 minuti dalla v18) o una connessione inattiva troppo a lungo
// (timeout dei socket, storicamente 2 minuti). Un remux HLS completo su un film intero
// può legittimamente richiedere più di 5 minuti prima di iniziare a rispondere: senza
// disattivare questi timeout, è lo stesso Node — non la rete, non Tailscale, non il
// client — a interrompere la connessione, con l'effetto "sito non disponibile" lato
// browser qualunque sia il dispositivo o il protocollo usato.
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 0;
httpServer.timeout = 0;

// Se il parser HTTP di Node riceve una richiesta malformata (es. un URL con byte grezzi
// non percent-encoded), la rifiuta PRIMA che arrivi alle route Express: senza questo
// listener quel rifiuto è silenzioso (nessuna riga di log), il che rende impossibile
// distinguere "la richiesta non è mai arrivata" da "il server l'ha processata e ha
// risposto qualcos'altro". Logghiamo esplicitamente e rispondiamo 400 come farebbe
// comunque Node di default.
httpServer.on('clientError', (err, socket) => {
  // ECONNRESET/EPIPE: il client ha chiuso la connessione (normale quando Nuvio riparte),
  // non è una richiesta malformata.
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    socket.destroy();
    return;
  }
  console.error(`CLIENT ERROR: richiesta malformata rifiutata prima di Express — ${err.message}`);
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
});
