const express = require('express');
const path = require('path');

const config = require('./src/config');
const addons = require('./src/addons');
const streamer = require('./src/streamer');
const extractor = require('./src/extractor');

const cfg = config.get();

const APP_VERSION = '1.6.1';

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

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---- Search / TMDB ----

app.get('/api/search', asyncRoute(async (req, res) => {
  const { query } = req.query;
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: 'Parametro query mancante' });
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
    return res.status(400).json({ error: 'Parametri tmdbId e type richiesti' });
  }
  if (type === 'tv' && (!season || !episode)) {
    return res.status(400).json({ error: 'Parametri season ed episode richiesti per le serie' });
  }

  const stremioType = type === 'tv' ? 'series' : 'movie';
  const imdbId = await addons.getImdbId(tmdbId, type, cfg.tmdbApiKey);
  if (!imdbId) {
    return res.status(404).json({ error: 'IMDb ID non trovato per questo titolo' });
  }

  const stremioId = addons.buildStremioId(imdbId, stremioType, season, episode);
  const addonList = config.listAddons();
  if (addonList.length === 0) {
    return res.status(400).json({ error: 'Nessun addon configurato (vai nella tab Addon)' });
  }

  const { streams, errors } = await addons.getStreamsForAllAddons(addonList, stremioType, stremioId);
  res.json({ imdbId, stremioId, streams, errors });
}));

// ---- Impostazioni ----

app.get('/api/settings', (req, res) => {
  const current = config.get();
  res.json({
    tmdbApiKey: current.tmdbApiKey,
    language: current.language,
    concurrentDownloads: current.concurrentDownloads,
    addonTimeoutMs: current.addonTimeoutMs,
    version: APP_VERSION
  });
});

app.post('/api/settings', (req, res) => {
  const updated = config.updateSettings(req.body || {});
  res.json({
    tmdbApiKey: updated.tmdbApiKey,
    language: updated.language,
    concurrentDownloads: updated.concurrentDownloads,
    addonTimeoutMs: updated.addonTimeoutMs,
    version: APP_VERSION
  });
});

// ---- Addons CRUD ----

app.get('/api/addons', (req, res) => {
  res.json({ addons: config.listAddons() });
});

app.post('/api/addons', (req, res) => {
  const { name, manifestUrl } = req.body || {};
  if (!name || !manifestUrl) {
    return res.status(400).json({ error: 'name e manifestUrl richiesti' });
  }
  const addon = config.addAddon({ name, manifestUrl });
  res.status(201).json({ addon });
});

app.delete('/api/addons/:id', (req, res) => {
  const removed = config.removeAddon(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Addon non trovato' });
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
    return res.status(400).json({ error: 'Parametro data non valido' });
  }

  // Ripresa di un download HLS (Nuvio riapre la connessione a ogni cambio di rete): ci si
  // aggancia alla conversione già in corso o finita invece di risolvere di nuovo lo stream
  // (che per gli externalUrl darebbe un URL con token diverso) e di ripartire da zero.
  const sourceKey = params.externalUrl || params.sourceUrl;
  if (sourceKey && await streamer.serveExistingHls(sourceKey, req, res)) return;

  // Stream "scraper" (solo externalUrl): risolvi lato server nel vero URL dello stream
  // prima di avviare il download.
  if (!params.sourceUrl && params.externalUrl) {
    let resolved;
    try {
      resolved = await extractor.resolveExternalUrl(params.externalUrl);
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message });
    }
    params.sourceUrl = resolved.sourceUrl;
    params.headers = { ...(params.headers || {}), ...(resolved.headers || {}) };
  }

  let prepared;
  try {
    prepared = streamer.prepareDownload(params);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  await streamer.streamDownload({ ...prepared, sourceKey }, req, res);
}

// Formato con estensione nel path (es. /api/download/<dati>/Titolo.ts): alcune app,
// incluso il download nativo di Nuvio, decidono se un link è "un file diretto scaricabile"
// guardando l'estensione nell'URL — un endpoint puramente query-string come
// /api/download?data=... non ne ha nessuna e viene scartato. Il segmento finale è solo
// cosmetico: il nome file vero per l'header Content-Disposition è ricalcolato lato server.
app.get('/api/download/:data/:filename', asyncRoute(async (req, res) => {
  await handleDownload(req.params.data, req, res);
}));

app.get('/api/download', asyncRoute(async (req, res) => {
  await handleDownload(req.query.data, req, res);
}));

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
    const total = (r.headers.get('content-range') || '').split('/')[1];
    const size = parseInt(total || (r.status === 200 ? r.headers.get('content-length') : ''), 10);
    return r.ok && Number.isFinite(size) && size > 0 ? size : null;
  })();
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), SIZE_PROBE_TIMEOUT_MS));
  return Promise.race([probe.catch(() => null), timeout]);
}

function formatSize(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
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
    description: 'Scarica sul dispositivo i contenuti trovati dagli addon configurati in NoStream',
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
  if (!addonList.length) return res.json({ streams: [] });

  const { streams } = await addons.getStreamsForAllAddons(addonList, type, id);
  const downloadable = streams.filter(s => s.supported);
  if (!downloadable.length) return res.json({ streams: [] });

  const { imdbId, season, episode } = parseStremioId(id);
  let label = id;
  try {
    const info = await addons.findByImdbId(imdbId, type, cfg.tmdbApiKey, cfg.language);
    if (info && info.title) {
      label = type === 'series'
        ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : `${info.title}${info.year ? ` (${info.year})` : ''}`;
    }
  } catch {
    // TMDB non configurata/raggiungibile: usa l'id grezzo come titolo del file
  }

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
    e.size = await probeDirectSize(e);
  }));

  // File diretti prima (scaricano a velocità piena, con dimensione e ripresa), poi gli HLS
  // (conversione al volo, senza dimensione). Tra i diretti, quelli con dimensione nota
  // davanti; l'ordine originale degli addon resta come criterio finale.
  const rank = e => (e.kind === 'direct' ? (e.size ? 0 : 1) : 2);
  entries.sort((a, b) => rank(a) - rank(b));

  const base = `${publicProtocol(req)}://${req.get('host')}`;
  const result = entries.map(s => {
    const payload = {
      addonName: s.addonName,
      sourceUrl: s.url || undefined,
      externalUrl: s.externalUrl || undefined,
      headers: s.headers,
      streamTitle: s.title,
      title: label
    };
    // Nuvio dà al file scaricato l'estensione che trova in questo URL.
    const ext = s.kind === 'direct'
      ? (s.url ? streamer.guessExtension(s.url) : '.mp4')
      : '.ts';
    const cosmeticFilename = encodeURIComponent(`${label}${ext}`);
    const downloadUrl = `${base}/api/download/${encodeDownloadPayload(payload)}/${cosmeticFilename}`;
    const provider = s.externalUrl ? extractor.providerFromUrl(s.externalUrl) : null;
    const details = s.kind === 'direct'
      ? `File diretto${s.size ? ` · ${formatSize(s.size)}` : ''} · download a velocità piena, riprendibile`
      : 'HLS · convertito al volo sul server: dimensione nota solo a conversione finita, riprendibile';
    const hints = { filename: `${label}${ext}` };
    if (s.size) hints.videoSize = s.size;
    return {
      // Il "name" è anche il criterio con cui Nuvio ordina gli stream di un addon:
      // "⬇️" viene prima di "🔄", così i file diretti restano in cima in ogni caso.
      name: s.kind === 'direct' ? '⬇️ Scaricabile' : '🔄 Da convertire',
      title: [details, s.title, `${s.addonNames.join(', ')}${provider ? ` · ${provider}` : ''}`].join('\n'),
      url: downloadUrl,
      behaviorHints: hints
    };
  });

  res.json({ streams: result });
}));

// ---- Static files ----

app.use(express.static(path.join(__dirname, 'public')));

// ---- Error handler ----

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.message || 'Errore interno' });
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
  console.error(`CLIENT ERROR: richiesta malformata rifiutata prima di Express — ${err.message}`);
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
});
