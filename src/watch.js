// Addon «NoStream ▶ Streaming»: per un titolo restituisce a Nuvio un solo link per
// risoluzione, scelto tra le fonti (addon, account Nuvio, plugin) e VERIFICATO: si prova
// davvero a leggere l'inizio del video (file diretto) o la playlist e il primo segmento
// (HLS). Il secondo addon, quello per i download, resta /manifest.json.
//
// I link passano da NoStream (/play/...): la fonte vede le stesse richieste fatte durante
// la verifica (header, IP del server), quindi quello che è stato provato è quello che il
// telefono riceve. Per gli HLS la playlist viene riscritta così che anche segmenti e
// chiavi passino da qui.

const streamer = require('./streamer');

const CACHE_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 7000;
const TRY_PER_RESOLUTION = 3;
const ORDER = [2160, 1080, 720, 480, 0];

const cache = new Map();

function quality(s) {
  const txt = `${s.name || ''} ${s.title || ''}`;
  if (/2160p|\b4k\b|\buhd\b/i.test(txt)) return 2160;
  if (/1080p|\bfhd\b/i.test(txt)) return 1080;
  if (/720p|\bhd\b/i.test(txt)) return 720;
  if (/576p|480p|360p|240p|\bsd\b/i.test(txt)) return 480;
  return 0;
}

const LANG = {
  it: /\bita\b|italian|🇮🇹/i, en: /\beng\b|english|🇬🇧|🇺🇸/i, es: /\bspa\b|\besp\b|spanish|español|🇪🇸/i,
  fr: /\bfra\b|\bfre\b|french|français|🇫🇷/i, de: /\bger\b|\bdeu\b|german|deutsch|🇩🇪/i
};

// Ordine dei candidati dentro una risoluzione: lingua dell'utente, poi file diretti con
// dimensione (si avviano subito e permettono di saltare), poi l'ordine delle fonti.
function rank(list, lang) {
  const re = LANG[lang];
  const score = s => (re && re.test(`${s.name || ''} ${s.title || ''}`) ? 4 : 0) + (s.kind === 'direct' ? 2 : 0) + (s.size ? 1 : 0);
  return list.map((s, i) => ({ s, i, v: score(s) })).sort((a, b) => b.v - a.v || a.i - b.i).map(x => x.s);
}

// Inizio di un file video riconoscibile: MP4/MOV (ftyp), Matroska/WebM, MPEG-TS, AVI.
function looksLikeVideo(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return true;
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') return true;
  return false;
}

async function readSome(url, headers, bytes, signal) {
  const res = await fetch(url, { headers: { ...(headers || {}), Range: `bytes=0-${bytes - 1}` }, signal, redirect: 'follow' });
  if (!res.ok) {
    if (res.body) res.body.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  reader.cancel().catch(() => {});
  return { buf: Buffer.concat(chunks.map(c => Buffer.from(c))), type: res.headers.get('content-type') || '', finalUrl: res.url };
}

function absolute(uri, base) {
  try { return new URL(uri, base).href; } catch { return null; }
}

// Verifica di un candidato. Restituisce { ok, kind, url, headers, ms } o { ok:false, error }.
async function verify(s, resolve) {
  const start = Date.now();
  const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  try {
    let url = s.url;
    let headers = s.headers || null;
    if (!url && s.externalUrl) {
      const r = await resolve(s.externalUrl);
      url = r.url;
      headers = { ...(headers || {}), ...(r.headers || {}) };
    }
    if (!url) return { ok: false, error: 'no url' };

    const first = await readSome(url, headers, 64 * 1024, signal);
    const text = first.buf.slice(0, 16).toString('latin1');
    if (text.startsWith('#EXTM3U') || /mpegurl/i.test(first.type)) {
      // HLS: playlist principale → variante con più banda → primo segmento
      let playlistUrl = first.finalUrl || url;
      let body = first.buf.toString('utf8');
      if (/#EXT-X-STREAM-INF/i.test(body)) {
        const lines = body.split(/\r?\n/);
        let best = null;
        for (let i = 0; i < lines.length; i++) {
          const m = /BANDWIDTH=(\d+)/i.exec(lines[i]);
          if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) {
            const bw = Number(m[1]);
            if (!best || bw > best.bw) best = { bw, uri: lines[i + 1].trim() };
          }
        }
        if (!best) return { ok: false, error: 'empty master playlist' };
        playlistUrl = absolute(best.uri, playlistUrl);
        body = (await readSome(playlistUrl, headers, 256 * 1024, signal)).buf.toString('utf8');
      }
      const seg = body.split(/\r?\n/).find(l => l && !l.startsWith('#'));
      if (!seg) return { ok: false, error: 'no segments' };
      const segData = await readSome(absolute(seg.trim(), playlistUrl), headers, 4096, signal);
      // Segmenti cifrati (EXT-X-KEY) non sono leggibili come TS: basta che arrivino byte.
      const encrypted = /#EXT-X-KEY:METHOD=(?!NONE)/i.test(body);
      if (!segData.buf.length || (!encrypted && !looksLikeVideo(segData.buf) && !/video|mp2t|octet|mp4/i.test(segData.type))) {
        return { ok: false, error: 'segment is not video' };
      }
      return { ok: true, kind: 'hls', url, headers, ms: Date.now() - start };
    }
    if (!looksLikeVideo(first.buf) && !/^video\//i.test(first.type)) return { ok: false, error: `not video (${first.type || '?'})` };
    return { ok: true, kind: 'direct', url, headers, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// Un link verificato per risoluzione. streams = stream scaricabili delle fonti.
async function pick(cacheKey, streams, { lang, resolve }) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const groups = new Map();
  for (const s of streams) {
    const q = quality(s);
    if (!groups.has(q)) groups.set(q, []);
    groups.get(q).push(s);
  }
  const result = [];
  await Promise.all([...groups.entries()].map(async ([q, list]) => {
    // I primi candidati in parallelo; vince il primo dell'ordine che funziona.
    const candidates = rank(list, lang);
    for (let i = 0; i < candidates.length; i += TRY_PER_RESOLUTION) {
      const batch = candidates.slice(i, i + TRY_PER_RESOLUTION);
      const checks = await Promise.all(batch.map(s => verify(s, resolve)));
      const idx = checks.findIndex(c => c.ok);
      if (idx >= 0) {
        result.push({ quality: q, stream: batch[idx], check: checks[idx], tried: i + idx + 1 });
        return;
      }
      if (i + TRY_PER_RESOLUTION >= 6) return;  // al massimo 6 tentativi per risoluzione
    }
  }));
  result.sort((a, b) => ORDER.indexOf(a.quality) - ORDER.indexOf(b.quality));
  cache.set(cacheKey, { at: Date.now(), result });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return result;
}

// ---- Proxy di riproduzione

// Nome con cui il proxy espone un pezzo dello stream. Alcuni player (ffmpeg, mpv, VLC)
// accettano solo segmenti con estensioni note: quelli «travestiti» (.jpg, .png, senza
// estensione) diventano .ts, che è quello che contengono.
const SEGMENT_EXT = new Set(['ts', 'm4s', 'mp4', 'm4v', 'aac', 'm4a', 'mp3', 'ac3', 'ec3', 'vtt', 'webvtt']);
function partName(abs, isPlaylistLine, { subtitles = false } = {}) {
  let ext = '';
  try { ext = (new URL(abs).pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || ''; } catch {}
  ext = ext.toLowerCase();
  if (ext === 'm3u8' || isPlaylistLine) return subtitles ? 'subs.m3u8' : 'index.m3u8';
  // Nelle tracce di sottotitoli i segmenti sono WebVTT anche quando l'URL dice .ts
  // (alcuni proxy HLS chiamano «segment.ts» ogni pezzo).
  if (subtitles) return 'seg.vtt';
  return `seg.${SEGMENT_EXT.has(ext) ? ext : 'ts'}`;
}

// Playlist HLS: ogni URI (segmenti, varianti, chiavi, sottotitoli) passa da NoStream.
// subtitles: questa è la playlist di una traccia di sottotitoli (segmenti WebVTT).
function rewritePlaylist(body, baseUrl, proxied, { subtitles = false } = {}) {
  const lines = body.split(/\r?\n/);
  return lines.map((line, i) => {
    if (!line) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const abs = absolute(uri, baseUrl);
        if (!abs) return m;
        const name = /^#EXT-X-(KEY|SESSION-KEY)/i.test(line)
          ? 'key.bin'
          : partName(abs, /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/i.test(line), { subtitles: /TYPE=SUBTITLES/i.test(line) });
        return `URI="${proxied(abs, name)}"`;
      });
    }
    const abs = absolute(line.trim(), baseUrl);
    // La riga dopo #EXT-X-STREAM-INF è una playlist variante
    const variant = i > 0 && /^#EXT-X-STREAM-INF/i.test(lines[i - 1]);
    return abs ? proxied(abs, partName(abs, variant, { subtitles })) : line;
  }).join('\n');
}

// GET di un pezzo di uno stream HLS (playlist o segmento) con gli header della fonte.
async function serveHlsPart(target, headers, req, res, proxied, { subtitles = false } = {}) {
  const up = await fetch(target, {
    headers: { ...(headers || {}), ...(req.headers.range ? { Range: req.headers.range } : {}) },
    redirect: 'follow'
  });
  const type = up.headers.get('content-type') || '';
  if (!up.ok) {
    res.status(up.status === 404 ? 404 : 502).end();
    if (up.body) up.body.cancel().catch(() => {});
    return;
  }
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(target);
  if (isPlaylist) {
    const body = await up.text();
    if (body.startsWith('#EXTM3U')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewritePlaylist(body, up.url || target, proxied, { subtitles }));
      return;
    }
    res.type(type || 'application/octet-stream').send(body);
    return;
  }
  res.status(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  const reader = up.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r));
  }
  res.end();
}

// File diretto: stesso inoltro con Range dei download, senza «allegato».
function serveDirect(url, headers, req, res) {
  return streamer.streamDirect(url, headers, null, req, res, null);
}

module.exports = { pick, quality, serveHlsPart, serveDirect, partName, ORDER };
