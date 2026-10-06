const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const config = require('./config');

const FIRST_BYTE_TIMEOUT_MS = 30000;
// Il download nativo di Nuvio (OkHttp, readTimeout 60s) abbandona da solo dopo 60s senza
// byte: oltre questa soglia non ha senso tenere vivo ffmpeg.
const STALL_TIMEOUT_MS = 60000;
// Timeout di lettura per ogni richiesta HTTP di ffmpeg (playlist, chiave, segmenti), in
// microsecondi. Senza, ffmpeg resta appeso per sempre quando il CDN lascia cadere una
// connessione senza chiuderla (succede di continuo con vixsrc), e il download muore lì.
const FFMPEG_RW_TIMEOUT_US = 15000000;
const STDERR_TAIL_BYTES = 4000;

let active = 0;

function sanitizeFilename(name) {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    .replace(/[/\\?%*:|"<>\x00-\x1F]/g, '')
    .replace(/\.\.+/g, '.')
    .trim();
  return cleaned.slice(0, 180).trim() || 'file';
}

function detectType(url) {
  const clean = url.split('?')[0].split('#')[0];
  return /\.m3u8$/i.test(clean) ? 'hls' : 'direct';
}

function guessExtension(url) {
  const clean = url.split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase();
  const known = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.ts'];
  return known.includes(ext) ? ext : '.mp4';
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function prepareDownload({ sourceUrl, headers, title, streamTitle }) {
  if (!sourceUrl || /^magnet:/i.test(sourceUrl)) {
    const err = new Error('Stream non supportato: nessun URL diretto disponibile (solo infoHash/torrent)');
    err.status = 400;
    throw err;
  }
  const type = detectType(sourceUrl);
  const ext = type === 'hls' ? '.ts' : guessExtension(sourceUrl);
  const baseName = sanitizeFilename(title || streamTitle || 'download');
  return { sourceUrl, headers: headers || null, filename: `${baseName}${ext}`, type };
}

async function streamDownload({ sourceUrl, headers, filename, type }, req, res) {
  if (active >= (config.get().concurrentDownloads || 1)) {
    res.status(429).json({ error: 'Troppi download in corso, riprova tra poco' });
    return;
  }
  active++;
  try {
    if (type === 'hls') {
      await streamHls(sourceUrl, headers, filename, res);
    } else {
      await streamDirect(sourceUrl, headers, filename, req, res);
    }
  } finally {
    active--;
  }
}

async function streamDirect(sourceUrl, headers, filename, req, res) {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);

  // Nuvio, quando riprende un download interrotto, chiede solo i byte mancanti con
  // "Range: bytes=N-": inoltrandolo alla fonte la ripresa riparte da lì invece che da zero
  // (senza, un film da 1+ GB su connessione instabile rischia di non finire mai).
  const upstreamHeaders = { ...(headers || {}) };
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(sourceUrl, { headers: upstreamHeaders, signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutTimer);
    const message = e.name === 'AbortError'
      ? `Timeout: lo stream non ha risposto entro ${FIRST_BYTE_TIMEOUT_MS / 1000}s`
      : `Impossibile contattare lo stream: ${e.message}`;
    res.status(502).json({ error: message });
    return;
  }
  clearTimeout(timeoutTimer);

  if (upstream.status === 403) {
    // Alcuni CDN legano l'URL firmato all'IP/contesto di chi lo ha generato (il device
    // dove gira Nuvio): il nostro server, scaricando da un IP diverso, viene rifiutato
    // anche con gli stessi header. Come fallback, reindirizziamo il browser a scaricare
    // direttamente dalla fonte: perdiamo il controllo su Content-Disposition/header
    // custom, ma l'IP torna a combaciare con quello atteso dal CDN.
    res.redirect(302, sourceUrl);
    return;
  }

  if (upstream.status === 416) {
    res.status(416);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.end();
    return;
  }

  if (!upstream.ok) {
    res.status(502).json({ error: `Il server dello stream ha risposto ${upstream.status} ${upstream.statusText}` });
    return;
  }

  const partial = upstream.status === 206 && upstream.headers.get('content-range');
  if (partial) {
    res.status(206);
    res.setHeader('Content-Range', upstream.headers.get('content-range'));
  }
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  if (upstream.headers.get('accept-ranges') === 'bytes') res.setHeader('Accept-Ranges', 'bytes');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);

  const nodeStream = Readable.fromWeb(upstream.body);
  res.on('close', () => {
    if (!res.writableEnded) nodeStream.destroy();
  });

  try {
    await pipeline(nodeStream, res);
  } catch {
    // client disconnected mid-transfer, nothing more to do
  }
}

let ffmpegOk = null;
function ffmpegAvailable() {
  if (ffmpegOk === null) {
    ffmpegOk = !spawnSync('ffmpeg', ['-version']).error;
  }
  return ffmpegOk;
}

// In un master playlist ffmpeg crea un "programma" per ogni variante, nell'ordine in cui
// compaiono: con "-map 0:v:0" finiva sempre sulla prima, che per vixsrc è la 480p.
// Qui scegliamo l'indice della variante con BANDWIDTH più alta; se la playlist non è un
// master (o non è leggibile) resta il programma 0, cioè l'unico presente.
async function pickBestVariant(sourceUrl, headers) {
  try {
    const r = await fetch(sourceUrl, {
      headers: headers || {},
      signal: AbortSignal.timeout(FIRST_BYTE_TIMEOUT_MS)
    });
    if (!r.ok) return 0;
    const lines = (await r.text()).split(/\r?\n/);
    let best = 0;
    let bestBandwidth = -1;
    let index = 0;
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const m = line.match(/[:,]BANDWIDTH=(\d+)/);
      const bw = m ? parseInt(m[1], 10) : 0;
      if (bw > bestBandwidth) {
        bestBandwidth = bw;
        best = index;
      }
      index++;
    }
    return best;
  } catch {
    return 0;
  }
}

// Remux HLS -> MPEG-TS in streaming: l'output di ffmpeg viene inoltrato al client man mano
// che viene prodotto, invece di bufferizzare l'intero file su disco prima di rispondere.
// È necessario perché il download nativo di Nuvio abbandona dopo 60s senza ricevere byte:
// con un remux "buffer-first" l'intero contenuto restava in attesa per minuti.
// MPEG-TS e non MKV: su una pipe ffmpeg non può tornare indietro a scrivere l'indice
// (Cues) del MKV, e ExoPlayer considera un MKV senza indice non navigabile; un .ts si
// riesce invece a navigare anche senza indice.
async function streamHls(sourceUrl, headers, filename, res) {
  if (!ffmpegAvailable()) {
    res.status(500).json({ error: 'ffmpeg non è installato o non è nel PATH' });
    return;
  }

  const variant = await pickBestVariant(sourceUrl, headers);

  const args = ['-hide_banner', '-nostats', '-y'];
  if (headers && Object.keys(headers).length) {
    const headerStr = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n';
    args.push('-headers', headerStr);
  }
  args.push(
    // Tolleranza ai CDN instabili: timeout per ogni richiesta, riconnessione sugli errori
    // di rete e nuovi tentativi sul singolo segmento prima di arrendersi.
    '-rw_timeout', String(FFMPEG_RW_TIMEOUT_US),
    '-reconnect', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '5',
    '-seg_max_retry', '10',
    '-i', sourceUrl,
    '-map', `0:p:${variant}:v:0`,
    '-map', `0:p:${variant}:a:0?`,
    // L'audio viene ricodificato (non copiato) perché diversi stream HLS (es. css /
    // StreamingCommunity) hanno extradata AAC malformato: con "-c:a copy" ffmpeg fallisce
    // con "Error parsing AAC extradata, unable to determine samplerate" e non produce nulla.
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'mpegts',
    '-flush_packets', '1',
    'pipe:1'
  );

  const ff = spawn('ffmpeg', args);

  // Manda subito gli header: da qui in poi il client vede un download "attivo" con
  // progresso reale invece di restare appeso in attesa del remux completo.
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.flushHeaders();

  let bytes = 0;
  let lastSize = 0;
  let stalledSince = Date.now();
  let stalled = false;
  const stallCheck = setInterval(() => {
    if (bytes > lastSize) {
      lastSize = bytes;
      stalledSince = Date.now();
    } else if (Date.now() - stalledSince > STALL_TIMEOUT_MS) {
      stalled = true;
      ff.kill('SIGKILL');
    }
  }, 2000);

  let clientGone = false;
  const onClientAbort = () => {
    clientGone = true;
    ff.kill('SIGKILL');
  };
  res.on('close', onClientAbort);
  res.on('error', () => {}); // assorbe errori di scrittura dopo la disconnessione del client

  // Tiene solo la coda del log di ffmpeg: serve a capire perché un remux è fallito.
  let stderrTail = '';
  ff.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });

  ff.stdout.on('data', chunk => { bytes += chunk.length; });
  ff.stdout.pipe(res, { end: false });

  const exitCode = await new Promise(resolve => {
    ff.on('error', () => resolve(-1));
    ff.on('close', code => resolve(code));
  });

  clearInterval(stallCheck);
  res.removeListener('close', onClientAbort);
  if (clientGone) return;

  if (exitCode === 0) {
    if (!res.writableEnded) res.end();
    console.log(`HLS completato: ${filename} (${bytes} byte)`);
    return;
  }

  // Remux fallito a metà: chiudere la risposta "normalmente" farebbe credere a Nuvio che
  // il file sia completo (senza Content-Length non ha modo di accorgersene) e lascerebbe
  // un film troncato segnato come scaricato. Interrompere la connessione lo fa invece
  // risultare fallito, così si può riprovare.
  const reason = stalled ? `nessun dato da ffmpeg per ${STALL_TIMEOUT_MS / 1000}s` : `ffmpeg uscito con codice ${exitCode}`;
  console.error(`HLS fallito: ${filename} dopo ${bytes} byte — ${reason}\n${stderrTail}`);
  res.destroy();
}

module.exports = { prepareDownload, streamDownload, sanitizeFilename, detectType, guessExtension };
