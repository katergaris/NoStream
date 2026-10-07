const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const config = require('./config');

const FIRST_BYTE_TIMEOUT_MS = 30000;
// ffmpeg che non scrive più nulla per questo tempo (nonostante timeout e nuovi tentativi
// sui segmenti) viene considerato bloccato e la conversione fallita.
const STALL_TIMEOUT_MS = 60000;
// Timeout di lettura per ogni richiesta HTTP di ffmpeg (playlist, chiave, segmenti), in
// microsecondi. Senza, ffmpeg resta appeso per sempre quando il CDN lascia cadere una
// connessione senza chiuderla (succede di continuo con vixsrc), e il download muore lì.
const FFMPEG_RW_TIMEOUT_US = 15000000;
const STDERR_TAIL_BYTES = 4000;

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

async function streamDownload({ sourceUrl, sourceKey, headers, filename, type, refreshSource }, req, res) {
  const limit = config.get().concurrentDownloads || 1;
  if (type === 'hls') {
    // Il limite conta le conversioni ffmpeg in corso, non le connessioni: le riprese di
    // Nuvio si agganciano a un lavoro esistente e non devono mai ricevere 429.
    if (runningHlsJobs() >= limit) {
      res.status(429).json({ error: 'Troppe conversioni in corso, riprova tra poco' });
      return;
    }
    if (!ffmpegAvailable()) {
      res.status(500).json({ error: 'ffmpeg non è installato o non è nel PATH' });
      return;
    }
    const job = startHlsJob(sourceKey || sourceUrl, sourceUrl, headers, filename);
    await serveHlsJob(job, req, res, { fresh: true });
    return;
  }

  // I file diretti non hanno limite: sono un semplice inoltro di byte, senza carico sulla
  // RPi. Contare le connessioni faceva rifiutare con 429 proprio le riprese di Nuvio: dopo
  // un cambio di rete la connessione vecchia resta aperta lato server (il telefono non
  // riesce a chiuderla, e senza timeout dei socket può durare minuti), occupa il posto e la
  // ripresa viene respinta — il download resta in pausa finché non si preme di nuovo play.
  await streamDirect(sourceUrl, headers, filename, req, res, refreshSource);
}

// Fonte che non manda byte per così tanto: considerata bloccata, ci si ricollega. Deve
// restare ben sotto il timeout di lettura di Nuvio (60 s), che altrimenti conta un errore.
const UPSTREAM_STALL_MS = parseInt(process.env.NOSTREAM_STALL_MS, 10) || 20000;
// Riconnessioni alla fonte consentite per una singola connessione del client.
const UPSTREAM_MAX_RECONNECTS = 30;
const RESOLVABLE_STATUSES = new Set([403, 404, 410]);

// "bytes 100-199/1000" -> { start: 100, end: 199, total: 1000 }
function parseContentRange(header) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(header || '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

async function fetchUpstream(src, range) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);
  const headers = { ...(src.headers || {}) };
  if (range) headers.Range = range;
  try {
    const res = await fetch(src.url, { headers, signal: controller.signal });
    return { res, controller };
  } finally {
    clearTimeout(timer);
  }
}

function discard(upstream) {
  if (upstream) {
    upstream.res.body?.cancel().catch(() => {});
    upstream.controller.abort();
  }
}

function waitDrain(res) {
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

// Copia i byte della fonte verso il client finché la fonte non finisce ('end'), non si
// blocca per UPSTREAM_STALL_MS ('stall'), non cade ('error') o il client non chiude.
async function pump(upstream, res, onBytes) {
  const reader = upstream.res.body.getReader();
  try {
    while (!res.destroyed) {
      let timer;
      const stall = new Promise(resolve => { timer = setTimeout(() => resolve({ stall: true }), UPSTREAM_STALL_MS); });
      const r = await Promise.race([reader.read(), stall]);
      clearTimeout(timer);
      if (r.stall) return 'stall';
      if (r.done) return 'end';
      onBytes(r.value.length);
      if (!res.write(r.value)) await waitDrain(res);
    }
    return 'closed';
  } catch {
    return 'error';
  } finally {
    upstream.controller.abort();
    reader.cancel().catch(() => {});
  }
}

// File diretto: proxy verso la fonte con supporto Range. Se la fonte cade o si blocca a
// metà, NoStream si ricollega da solo dal byte a cui era arrivato e continua sulla stessa
// connessione verso il client: Nuvio non vede l'interruzione. Ogni errore che arriva a
// Nuvio, invece, gli costa una pausa (30 s, 60 s, 120 s…) e dopo 4 errori il download si
// ferma finché non si preme di nuovo play.
async function streamDirect(sourceUrl, headers, filename, req, res, refreshSource) {
  let src = { url: sourceUrl, headers: headers || {} };

  // Nuvio, quando riprende un download interrotto, chiede solo i byte mancanti con
  // "Range: bytes=N-": inoltrandolo alla fonte la ripresa riparte da lì invece che da zero
  // (senza, un film da 1+ GB su connessione instabile rischia di non finire mai).
  const clientRange = req.headers.range || null;

  let first;
  try {
    first = await fetchUpstream(src, clientRange);
    // Link della fonte preso dalla cache e nel frattempo scaduto: si risolve di nuovo.
    if (refreshSource && RESOLVABLE_STATUSES.has(first.res.status)) {
      discard(first);
      src = await refreshSource();
      first = await fetchUpstream(src, clientRange);
    }
  } catch (e) {
    const message = e.name === 'AbortError'
      ? `Timeout: lo stream non ha risposto entro ${FIRST_BYTE_TIMEOUT_MS / 1000}s`
      : `Impossibile contattare lo stream: ${e.message}`;
    res.status(502).json({ error: message });
    return;
  }
  const upstream = first.res;

  if (upstream.status === 403) {
    // Alcuni CDN legano l'URL firmato all'IP/contesto di chi lo ha generato (il device
    // dove gira Nuvio): il nostro server, scaricando da un IP diverso, viene rifiutato
    // anche con gli stessi header. Come fallback, reindirizziamo il browser a scaricare
    // direttamente dalla fonte: perdiamo il controllo su Content-Disposition/header
    // custom, ma l'IP torna a combaciare con quello atteso dal CDN.
    discard(first);
    res.redirect(302, src.url);
    return;
  }

  if (upstream.status === 416) {
    discard(first);
    res.status(416);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.end();
    return;
  }

  if (!upstream.ok) {
    discard(first);
    res.status(502).json({ error: `Il server dello stream ha risposto ${upstream.status} ${upstream.statusText}` });
    return;
  }

  const range = upstream.status === 206 ? parseContentRange(upstream.headers.get('content-range')) : null;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', upstream.headers.get('content-range'));
  }
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  if (range || upstream.headers.get('accept-ranges') === 'bytes') res.setHeader('Accept-Ranges', 'bytes');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  // Servono al client per verificare (If-Range) che il file non sia cambiato tra una
  // ripresa e l'altra.
  for (const h of ['etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  // HEAD (controllo del link prima del download): solo gli header. Altrimenti Express
  // avrebbe scaricato dalla fonte l'intero file solo per buttarlo via.
  if (req.method === 'HEAD') {
    discard(first);
    res.end();
    return;
  }

  // Tratto da consegnare [pos, end]: serve per sapere da dove ricollegarsi alla fonte.
  let pos = range ? range.start : 0;
  const end = range ? range.end : (len ? Number(len) - 1 : null);
  const resumable = end !== null && (range !== null || upstream.headers.get('accept-ranges') === 'bytes');

  let current = first;
  res.on('close', () => discard(current));

  for (let reconnects = 0; ; ) {
    const outcome = await pump(current, res, n => { pos += n; });
    if (outcome === 'closed' || res.destroyed) return;
    if (end === null ? outcome === 'end' : pos > end) {
      res.end();
      return;
    }

    // La fonte è caduta o si è bloccata prima della fine: ci si ricollega dal byte mancante.
    let resumed = null;
    while (!resumed && resumable && reconnects < UPSTREAM_MAX_RECONNECTS && !res.destroyed) {
      reconnects++;
      console.log(`Fonte ${outcome === 'stall' ? 'bloccata' : 'interrotta'} per ${filename} al byte ${pos}: riconnessione ${reconnects}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * reconnects, 5000)));
      if (res.destroyed) return;
      try {
        let next = await fetchUpstream(src, `bytes=${pos}-${end}`);
        if (refreshSource && RESOLVABLE_STATUSES.has(next.res.status)) {
          discard(next);
          src = await refreshSource();
          next = await fetchUpstream(src, `bytes=${pos}-${end}`);
        }
        const r = parseContentRange(next.res.headers.get('content-range'));
        if (next.res.status === 206 && r && r.start === pos) resumed = next;
        else discard(next);
      } catch {
        // fonte ancora irraggiungibile: si riprova al giro successivo
      }
    }
    if (!resumed) {
      // Impossibile continuare: interrompere la connessione (invece di chiuderla
      // normalmente) fa capire al client che il file non è completo.
      console.error(`Fonte persa definitivamente per ${filename} al byte ${pos}`);
      res.destroy();
      return;
    }
    current = resumed;
  }
}

// ---------------------------------------------------------------
// HLS: conversione su disco, indipendente dalla connessione del client
// ---------------------------------------------------------------
//
// Su Android 14+ Nuvio chiude e riapre la connessione del download a ogni cambio di rete
// (JobService.onNetworkChanged), chiedendo i byte mancanti con "Range: bytes=N-". Se la
// conversione fosse legata alla connessione, ogni riapertura ripartirebbe da zero (download
// che arriva a 1 MB, torna a 0, arriva a 5 MB, torna a 0...).
// Per questo ogni stream HLS diventa un "lavoro": ffmpeg scrive un .ts su disco a velocità
// piena, e ogni richiesta (prima o ripresa) legge il file dal byte richiesto, seguendolo
// mentre cresce. A conversione finita il file si serve come un normale file con dimensione
// e Range, quindi Nuvio mostra anche la percentuale.

const HLS_CACHE_DIR = path.join(os.tmpdir(), 'nostream-hls');
// Lavoro non ancora finito e senza nessun client collegato da questo tempo: abbandonato.
const HLS_ORPHAN_MS = 10 * 60 * 1000;
// File convertito consegnato per intero al telefono: si cancella dopo questo margine (per
// un'eventuale ultima riconnessione di Nuvio proprio sul finale).
const HLS_DELIVERED_GRACE_MS = 2 * 60 * 1000;
// Rete di sicurezza per i download lasciati a metà: file cancellato dopo questo tempo
// dall'ultimo accesso anche se il telefono non l'ha mai ricevuto tutto.
const HLS_KEEP_MS = 6 * 60 * 60 * 1000;
const TAIL_POLL_MS = 500;
const TAIL_CHUNK_BYTES = 256 * 1024;
// "Content-Range" di una ripresa mentre la conversione è in corso: la fine non è ancora
// nota, ma il parser di Nuvio vuole comunque un numero ("bytes N-M/*"). Con totale "*"
// Nuvio non controlla la lunghezza e legge fino alla chiusura della connessione.
const OPEN_ENDED_RANGE_SPAN = 1e15;

const hlsJobs = new Map();

fs.rmSync(HLS_CACHE_DIR, { recursive: true, force: true });
fs.mkdirSync(HLS_CACHE_DIR, { recursive: true });

setInterval(() => {
  const now = Date.now();
  for (const job of hlsJobs.values()) {
    if (job.status === 'running' || job.clients > 0) continue;
    const idle = now - job.lastAccess;
    if ((job.delivered && idle > HLS_DELIVERED_GRACE_MS) || idle > HLS_KEEP_MS) {
      console.log(`HLS rimosso dal disco: ${job.filename}${job.delivered ? ' (consegnato)' : ' (scaduto)'}`);
      removeHlsJob(job);
    }
  }
}, 30 * 1000).unref();

function removeHlsJob(job) {
  hlsJobs.delete(job.key);
  fs.rm(job.file, { force: true }, () => {});
}

function hlsCacheKey(sourceKey) {
  return crypto.createHash('sha1').update(String(sourceKey)).digest('hex').slice(0, 24);
}

// Lavoro HLS già esistente e riutilizzabile per questa sorgente (in corso o finito).
// Un lavoro fallito viene scartato, così la prossima richiesta ne avvia uno nuovo.
function getHlsJob(sourceKey) {
  const job = hlsJobs.get(hlsCacheKey(sourceKey));
  if (!job) return null;
  if (job.status === 'failed') {
    if (job.clients === 0) removeHlsJob(job);
    return null;
  }
  return job;
}

function runningHlsJobs() {
  let n = 0;
  for (const job of hlsJobs.values()) if (job.status === 'running') n++;
  return n;
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

// Avvia ffmpeg (HLS -> MPEG-TS su file). MPEG-TS e non MKV: il file viene letto mentre è
// ancora in scrittura, e ExoPlayer riesce a navigare in un .ts anche senza indice.
function startHlsJob(sourceKey, sourceUrl, headers, filename) {
  const key = hlsCacheKey(sourceKey);
  const job = {
    key,
    file: path.join(HLS_CACHE_DIR, `${key}.ts`),
    filename,
    written: 0,
    status: 'running',
    clients: 0,
    lastAccess: Date.now(),
    ff: null
  };
  hlsJobs.set(key, job);
  runHlsJob(job, sourceUrl, headers).catch(e => {
    console.error(`HLS fallito: ${filename} — ${e.message}`);
    job.status = 'failed';
  });
  return job;
}

async function runHlsJob(job, sourceUrl, headers) {
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
    job.file
  );

  const ff = spawn('ffmpeg', args);
  job.ff = ff;

  // Tiene solo la coda del log di ffmpeg: serve a capire perché un remux è fallito.
  let stderrTail = '';
  ff.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });

  let lastGrowth = Date.now();
  let reason = null;
  const watch = setInterval(() => {
    fs.stat(job.file, (err, st) => {
      if (!err && st.size > job.written) {
        job.written = st.size;
        lastGrowth = Date.now();
      }
      const now = Date.now();
      if (now - lastGrowth > STALL_TIMEOUT_MS) {
        reason = `nessun dato da ffmpeg per ${STALL_TIMEOUT_MS / 1000}s`;
        ff.kill('SIGKILL');
      } else if (job.clients === 0 && now - job.lastAccess > HLS_ORPHAN_MS) {
        reason = 'nessun client collegato, conversione abbandonata';
        ff.kill('SIGKILL');
      }
    });
  }, 1000);

  const exitCode = await new Promise(resolve => {
    ff.on('error', () => resolve(-1));
    ff.on('close', code => resolve(code));
  });
  clearInterval(watch);

  try {
    job.written = fs.statSync(job.file).size;
  } catch {
    // file mai creato: ffmpeg è fallito prima di scrivere
  }

  if (exitCode === 0 && !reason) {
    job.status = 'done';
    console.log(`HLS completato: ${job.filename} (${job.written} byte)`);
  } else {
    job.status = 'failed';
    console.error(`HLS fallito: ${job.filename} dopo ${job.written} byte — ${reason || `ffmpeg uscito con codice ${exitCode}`}\n${stderrTail}`);
  }
}

// "Range: bytes=N-" -> N (solo la forma aperta, l'unica usata dai download manager).
function rangeStart(header) {
  const m = /^bytes=(\d+)-$/.exec(String(header || '').trim());
  return m ? parseInt(m[1], 10) : 0;
}

async function serveHlsJob(job, req, res, { fresh }) {
  // Su un lavoro appena avviato non c'è niente da cui riprendere: si riparte da zero e lo
  // si dichiara con un 200 (Nuvio allora riscrive il file dall'inizio).
  const start = fresh ? 0 : rangeStart(req.headers.range);

  if (job.status === 'failed') {
    res.status(502).json({ error: 'Conversione HLS fallita, riprova' });
    return;
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Content-Disposition', contentDisposition(job.filename));
  res.setHeader('Accept-Ranges', 'bytes');

  job.clients++;
  job.lastAccess = Date.now();
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  res.on('error', () => {}); // assorbe errori di scrittura dopo la disconnessione del client

  try {
    if (job.status === 'done') {
      const total = job.written;
      if (start >= total && total > 0) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        res.end();
        return;
      }
      if (start > 0) {
        res.status(206).setHeader('Content-Range', `bytes ${start}-${total - 1}/${total}`);
      }
      res.setHeader('Content-Length', String(total - start));
      try {
        await pipeline(fs.createReadStream(job.file, { start }), res);
        job.delivered = true;
      } catch {
        // client disconnected mid-transfer, nothing more to do
      }
      return;
    }

    // Conversione in corso: si segue il file mentre cresce.
    if (start > 0) {
      res.status(206).setHeader('Content-Range', `bytes ${start}-${start + OPEN_ENDED_RANGE_SPAN}/*`);
    }
    res.flushHeaders();

    let fd = null;
    let pos = start;
    const buffer = Buffer.alloc(TAIL_CHUNK_BYTES);
    while (!closed) {
      if (fd === null) {
        try {
          fd = fs.openSync(job.file, 'r');
        } catch {
          // ffmpeg non ha ancora creato il file
        }
      }
      if (fd !== null && pos < job.written) {
        const n = fs.readSync(fd, buffer, 0, Math.min(TAIL_CHUNK_BYTES, job.written - pos), pos);
        if (n > 0) {
          pos += n;
          if (!res.write(Buffer.from(buffer.subarray(0, n)))) {
            await new Promise(resolve => {
              // Entrambi i listener vanno tolti a ogni giro: altrimenti a ogni pausa di
              // scrittura se ne accumula uno su "close" (MaxListenersExceededWarning).
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.on('drain', done);
              res.on('close', done);
            });
          }
          continue;
        }
      }
      if (job.status === 'done' && pos >= job.written) {
        res.end(() => {
          job.delivered = true;
        });
        break;
      }
      if (job.status === 'failed') {
        // Interrompere la connessione (invece di chiuderla normalmente) fa risultare il
        // download fallito in Nuvio, invece di un file troncato segnato come completato.
        res.destroy();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, TAIL_POLL_MS));
    }
    if (fd !== null) fs.closeSync(fd);
  } finally {
    job.clients--;
    job.lastAccess = Date.now();
  }
}

// Serve una richiesta HLS se per questa sorgente esiste già un lavoro (ripresa di Nuvio o
// secondo download): non serve risolvere di nuovo lo stream né riavviare ffmpeg.
async function serveExistingHls(sourceKey, req, res) {
  const job = getHlsJob(sourceKey);
  if (!job) return false;
  await serveHlsJob(job, req, res, { fresh: false });
  return true;
}

module.exports = {
  prepareDownload,
  streamDownload,
  serveExistingHls,
  sanitizeFilename,
  detectType,
  guessExtension
};
