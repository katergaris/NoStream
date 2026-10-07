// Preparazione dei file diretti sul disco del server.
//
// Il downloader di Nuvio interrompe la connessione ogni pochi secondi e dopo 4 errori si
// ferma: con una fonte lenta (0,5-4 MB/s) un episodio da 350 MB ne subisce decine. Qui
// NoStream scarica il file sul proprio disco a piena velocità, con una sola connessione
// lunga verso la fonte (che si ricollega da sola se cade), e lo serve al client mentre
// cresce, con la dimensione nota da subito. Le riprese del client partono così dal disco,
// alla velocità della rete di casa, e il download sul server prosegue anche mentre il
// telefono è in pausa. Un file già pronto arriva al telefono in pochi secondi.
//
// Lo stato di ogni lavoro è salvato accanto al file (JSON), così sopravvive ai riavvii.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const streamer = require('./streamer');

const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'prepared');
// Preparazioni in background (pulsante "Prepara sul server") contemporanee. Quelle con un
// client in attesa ("Scarica") partono sempre subito.
const MAX_BACKGROUND = 2;
// Tentativi consecutivi senza nessun progresso prima di dichiarare fallita la preparazione.
const MAX_FAILS_WITHOUT_PROGRESS = 15;
const SAVE_EVERY_MS = 5000;
const KEEP_DONE_MS = 3 * 24 * 60 * 60 * 1000;
const KEEP_FAILED_MS = 24 * 60 * 60 * 1000;
// Spazio da lasciare comunque libero sul disco oltre al file.
const FREE_MARGIN_BYTES = 1024 * 1024 * 1024;
const TAIL_POLL_MS = 300;
const READ_CHUNK = 256 * 1024;

const jobs = new Map();
let resolveSource = null;

// Identità stabile di uno stream: i link degli addon contengono token che cambiano a ogni
// richiesta, quindi la chiave usa titolo (id Stremio), addon e nome dello stream.
function keyFor(p) {
  const identity = p.vid
    ? `${p.vid}|${p.addonName || ''}|${p.streamTitle || ''}`
    : (p.externalUrl || p.sourceUrl || '');
  return crypto.createHash('sha1').update(identity).digest('hex').slice(0, 20);
}

function dataPath(key) { return path.join(DIR, `${key}.data`); }
function metaPath(key) { return path.join(DIR, `${key}.json`); }

function publicView(job) {
  return {
    key: job.key,
    title: job.title,
    filename: job.filename,
    size: job.size,
    written: job.written,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    lastAccess: job.lastAccess,
    path: `/api/prepared/${job.key}/${encodeURIComponent(job.filename)}`
  };
}

function save(job) {
  job.savedAt = Date.now();
  const { controller, cancelled, savedAt, ...persist } = job;
  fs.writeFile(metaPath(job.key), JSON.stringify(persist), () => {});
}

function setResolver(fn) { resolveSource = fn; }

function init() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      // Il file su disco fa fede su quanto è stato davvero scritto.
      try { job.written = Math.min(job.written || 0, fs.statSync(dataPath(job.key)).size); } catch { job.written = 0; }
      if (job.status === 'running' || job.status === 'queued') job.status = 'queued';
      jobs.set(job.key, job);
    } catch {
      // meta illeggibile: ignorato (verrà ripulito)
    }
  }
  setInterval(cleanup, 60 * 60 * 1000).unref();
  cleanup();
  schedule();
}

function get(key) { return jobs.get(key) || null; }

function list() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicView);
}

// Crea (o riprende) la preparazione di uno stream. onDemand = c'è un client che aspetta.
function ensure(params, { title, filename, onDemand = false }) {
  const key = keyFor(params);
  let job = jobs.get(key);
  if (job && job.status !== 'failed') {
    if (onDemand && job.status === 'queued') startJob(job);
    return job;
  }
  job = {
    key,
    title: title || filename,
    filename,
    params,
    size: job && job.size || null,
    contentType: null,
    written: 0,
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    lastAccess: Date.now()
  };
  try { fs.rmSync(dataPath(key), { force: true }); } catch {}
  jobs.set(key, job);
  save(job);
  if (onDemand) startJob(job);
  else schedule();
  return job;
}

function remove(key) {
  const job = jobs.get(key);
  if (!job) return false;
  job.cancelled = true;
  if (job.controller) job.controller.abort();
  jobs.delete(key);
  fs.rm(dataPath(key), { force: true }, () => {});
  fs.rm(metaPath(key), { force: true }, () => {});
  schedule();
  return true;
}

function schedule() {
  let running = [...jobs.values()].filter(j => j.status === 'running').length;
  for (const job of jobs.values()) {
    if (running >= MAX_BACKGROUND) break;
    if (job.status === 'queued') {
      startJob(job);
      running++;
    }
  }
}

function startJob(job) {
  if (job.status === 'running') return;
  job.status = 'running';
  job.error = null;
  save(job);
  runJob(job)
    .catch(e => {
      if (job.cancelled) return;
      job.status = 'failed';
      job.error = e.message;
      console.error(`Preparazione fallita: ${job.filename} — ${e.message}`);
    })
    .finally(() => {
      job.controller = null;
      if (!job.cancelled) save(job);
      schedule();
    });
}

function freeBytes() {
  try {
    const s = fs.statfsSync(DIR);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

async function runJob(job) {
  let src = await resolveSource(job.params, { fresh: false });
  if (streamer.detectType(src.url) === 'hls') {
    throw new Error('Stream HLS: la conversione avviene già sul server, usa "Scarica"');
  }

  const file = dataPath(job.key);
  const fh = await fsp.open(file, fs.existsSync(file) ? 'r+' : 'w+');
  let lastSave = Date.now();
  let failsWithoutProgress = 0;
  let spaceChecked = false;
  try {
    while (!job.cancelled && (job.size === null || job.written < job.size)) {
      let up = null;
      try {
        up = await streamer.fetchUpstream(src, `bytes=${job.written}-`);
        job.controller = up.controller;
        if (streamer.RESOLVABLE_STATUSES.has(up.res.status)) {
          streamer.discard(up);
          up = null;
          src = await resolveSource(job.params, { fresh: true });
          throw new Error(`fonte scaduta, link risolto di nuovo`);
        }
        if (!up.res.ok) throw new Error(`la fonte ha risposto ${up.res.status}`);

        const range = up.res.status === 206 ? streamer.parseContentRange(up.res.headers.get('content-range')) : null;
        if (range) {
          if (range.start !== job.written) throw new Error('la fonte ha restituito un tratto diverso da quello chiesto');
          if (range.total) job.size = range.total;
        } else {
          // La fonte ignora Range: si riparte da zero sovrascrivendo.
          job.written = 0;
          const len = parseInt(up.res.headers.get('content-length'), 10);
          if (Number.isFinite(len)) job.size = len;
        }
        if (!job.size) throw Object.assign(new Error('la fonte non dichiara la dimensione del file'), { fatal: true });
        job.contentType = job.contentType || up.res.headers.get('content-type') || 'video/mp4';
        if (!spaceChecked) {
          spaceChecked = true;
          if (freeBytes() < job.size - job.written + FREE_MARGIN_BYTES) {
            throw Object.assign(new Error('spazio su disco insufficiente sul server'), { fatal: true });
          }
        }

        const reader = up.res.body.getReader();
        const startedAt = job.written;
        try {
          while (!job.cancelled) {
            let timer;
            const stall = new Promise(resolve => { timer = setTimeout(() => resolve({ stall: true }), streamer.UPSTREAM_STALL_MS); });
            const r = await Promise.race([reader.read(), stall]);
            clearTimeout(timer);
            if (r.stall) throw new Error('fonte bloccata');
            if (r.done) break;
            await fh.write(r.value, 0, r.value.length, job.written);
            job.written += r.value.length;
            failsWithoutProgress = 0;
            if (Date.now() - lastSave > SAVE_EVERY_MS) {
              lastSave = Date.now();
              save(job);
            }
          }
        } finally {
          streamer.discard(up);
          reader.cancel().catch(() => {});
        }
        if (!job.cancelled && job.written < job.size && job.written === startedAt) {
          throw new Error('la fonte ha chiuso senza mandare dati');
        }
      } catch (e) {
        if (up) streamer.discard(up);
        if (job.cancelled) return;
        if (e.fatal) throw e;
        failsWithoutProgress++;
        if (failsWithoutProgress > MAX_FAILS_WITHOUT_PROGRESS) {
          throw new Error(`la fonte non risponde più (${e.message})`);
        }
        const reason = e.message === 'terminated' ? 'fonte interrotta' : e.message;
        console.log(`Preparazione ${job.filename}: ${reason} al byte ${job.written}, nuovo tentativo ${failsWithoutProgress}`);
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * failsWithoutProgress, 10000)));
      }
    }
    if (job.cancelled) return;
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  job.status = 'done';
  job.finishedAt = Date.now();
  console.log(`Preparazione completata: ${job.filename} (${job.size} byte)`);
}

// "bytes=a-b" | "bytes=a-" | "bytes=-n" -> { start, end } (end incluso), null se assente.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

// Serve il file preparato (anche mentre è in scrittura). Restituisce false se la
// dimensione non si è potuta conoscere: il chiamante ripiega sul proxy diretto.
async function serve(job, req, res) {
  job.lastAccess = Date.now();
  const waitUntil = Date.now() + 45000;
  while (!job.size && job.status !== 'failed' && Date.now() < waitUntil && !res.destroyed) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (res.destroyed) return true;
  if (!job.size) return false;

  const size = job.size;
  const range = parseRange(req.headers.range, size);
  if (range && range.start >= size) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return true;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Type', job.contentType || 'video/mp4');
  res.setHeader('Content-Disposition', streamer.contentDisposition(job.filename));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(end - start + 1));
  // Validatore stabile: le riprese con If-Range combaciano sempre.
  res.setHeader('ETag', `"${job.key}-${size}"`);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  let closed = false;
  res.on('close', () => { closed = true; });
  res.on('error', () => {});
  const fh = await fsp.open(dataPath(job.key), 'r');
  const buffer = Buffer.alloc(READ_CHUNK);
  let pos = start;
  try {
    while (!closed && pos <= end) {
      const available = Math.min(job.written - 1, end);
      if (pos <= available) {
        const { bytesRead } = await fh.read(buffer, 0, Math.min(READ_CHUNK, available - pos + 1), pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        job.lastAccess = Date.now();
        if (!res.write(Buffer.from(buffer.subarray(0, bytesRead)))) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.on('drain', done);
            res.on('close', done);
          });
        }
        continue;
      }
      if (job.status === 'failed' || job.cancelled) {
        // Interrompere (invece di chiudere normalmente) segnala al client il file incompleto.
        res.destroy();
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, TAIL_POLL_MS));
    }
    if (!closed && pos > end) res.end();
  } finally {
    await fh.close().catch(() => {});
  }
  return true;
}

function cleanup() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    const idle = now - (job.lastAccess || job.createdAt);
    if ((job.status === 'done' && idle > KEEP_DONE_MS) || (job.status === 'failed' && idle > KEEP_FAILED_MS)) {
      console.log(`File preparato rimosso dal disco: ${job.filename}`);
      remove(job.key);
    }
  }
  // File di dati rimasti senza stato
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (name.endsWith('.data') && !jobs.has(name.slice(0, -5))) fs.rm(path.join(DIR, name), { force: true }, () => {});
    }
  } catch {}
}

module.exports = { init, setResolver, keyFor, get, list, ensure, remove, serve, publicView };
