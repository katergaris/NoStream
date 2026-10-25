// Video da link (YouTube e gli altri siti supportati da yt-dlp).
//
// yt-dlp scarica sempre sul disco del server: con YouTube video e audio arrivano separati
// e vanno uniti con ffmpeg, cosa impossibile «al volo» verso il telefono. Il file pronto
// arriva poi al dispositivo come i file preparati (stessa pagina Download, stesso Range).
//
// Il programma è l'eseguibile ufficiale (zipapp Python). Quello compreso nell'immagine
// Docker invecchia in fretta, perché YouTube cambia spesso: gli aggiornamenti si scaricano
// in data/bin e hanno la precedenza. Per le verifiche JavaScript di YouTube yt-dlp usa il
// Node che fa già girare NoStream.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const streamer = require('./streamer');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA, 'links');
const BIN_DIR = path.join(DATA, 'bin');
const UPDATED_BIN = path.join(BIN_DIR, 'yt-dlp');
const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

const MAX_RUNNING = 2;
const INFO_TIMEOUT_MS = 90 * 1000;
const KEEP_DONE_MS = 3 * 24 * 60 * 60 * 1000;
const KEEP_FAILED_MS = 24 * 60 * 60 * 1000;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = { maxHeight: 1080, audioFormat: 'm4a', embedSubs: false, numberFiles: true, autoUpdate: true };

const jobs = new Map();
let cachedVersion = null;
let updating = null;

function settings() {
  return { ...DEFAULTS, ...(config.get().ytdlp || {}) };
}

function binPath() {
  if (fs.existsSync(UPDATED_BIN)) return UPDATED_BIN;
  return process.env.YTDLP_PATH || 'yt-dlp';
}

function baseArgs() {
  return ['--js-runtimes', `node:${process.execPath}`, '--no-warnings', '--ignore-config'];
}

// Esegue yt-dlp e raccoglie l'output. onLine riceve ogni riga di stdout mentre arriva.
function run(args, { timeoutMs = 0, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binPath(), [...baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let partial = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      if (!onLine) return;
      partial += s;
      const lines = partial.split('\n');
      partial = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error('yt-dlp non è installato sul server') : e);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (partial && onLine) onLine(partial);
      resolve({ code, out, err, child });
    });
    run.last = child;
  });
}

// Messaggio d'errore leggibile dall'output di yt-dlp (le righe «ERROR: ...»).
function errorMessage(stderr, fallback) {
  const lines = String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
  const err = lines.reverse().find(l => l.startsWith('ERROR:'));
  return (err ? err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : lines[0]) || fallback;
}

// ---- Informazioni su un link (video singolo o playlist)

function pickThumb(d) {
  if (d.thumbnail) return d.thumbnail;
  const list = d.thumbnails || [];
  return list.length ? list[list.length - 1].url : null;
}

// Nome del sito da mostrare: «YoutubeTab» → «YouTube», altrimenti il dominio.
const SITE_NAMES = { youtube: 'YouTube', youtubetab: 'YouTube', vimeo: 'Vimeo', twitch: 'Twitch', dailymotion: 'Dailymotion', rai: 'RaiPlay', raiplay: 'RaiPlay', soundcloud: 'SoundCloud' };
function siteName(d) {
  const key = String(d.extractor_key || d.extractor || '').toLowerCase().replace(/[^a-z]/g, '');
  if (SITE_NAMES[key]) return SITE_NAMES[key];
  const domain = d.webpage_url_domain || (() => { try { return new URL(d.webpage_url).hostname; } catch { return null; } })();
  return domain ? domain.replace(/^www\./, '') : (d.extractor_key || null);
}

async function info(url) {
  const { code, out, err } = await run(['-J', '--flat-playlist', url], { timeoutMs: INFO_TIMEOUT_MS });
  if (code !== 0) throw new Error(errorMessage(err, 'Link non supportato o non raggiungibile'));
  let d;
  try { d = JSON.parse(out); } catch { throw new Error('Risposta di yt-dlp non leggibile'); }

  const isPlaylist = d._type === 'playlist';
  const entries = isPlaylist
    ? (d.entries || []).filter(Boolean).map((e, i) => ({
      id: e.id || String(i + 1),
      index: i + 1,
      url: e.url && /^https?:/.test(e.url) ? e.url : (e.webpage_url || e.url),
      title: e.title || `Video ${i + 1}`,
      duration: e.duration || null,
      thumbnail: pickThumb(e)
    })).filter(e => e.url && e.title !== '[Private video]' && e.title !== '[Deleted video]')
    : [{ id: d.id, index: 1, url: d.webpage_url || url, title: d.title, duration: d.duration || null, thumbnail: pickThumb(d) }];

  return {
    kind: isPlaylist ? 'playlist' : 'video',
    id: d.id,
    url: d.webpage_url || url,
    title: d.title || url,
    uploader: d.uploader || d.channel || null,
    site: siteName(d),
    thumbnail: pickThumb(d) || (entries[0] && entries[0].thumbnail) || null,
    duration: entries.reduce((sum, e) => sum + (e.duration || 0), 0) || null,
    entries
  };
}

// ---- Lavori di download

function keyFor(url, mode) {
  const s = settings();
  const variant = mode === 'audio' ? `audio:${s.audioFormat}` : `video:${s.maxHeight}:${s.embedSubs}`;
  return 'y' + crypto.createHash('sha1').update(`${url}|${variant}`).digest('hex').slice(0, 19);
}

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
    source: 'link',
    path: `/api/link/${job.key}/${encodeURIComponent(job.filename)}`
  };
}

function save(job) {
  const { child, ...persist } = job;
  fs.writeFile(metaPath(job.key), JSON.stringify(persist), () => {});
}

function init() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      if (job.status === 'running') job.status = 'queued';  // interrotto da un riavvio: si rifà
      if (job.status === 'done' && !(job.file && fs.existsSync(job.file))) continue;
      jobs.set(job.key, job);
    } catch {}
  }
  setInterval(cleanup, 60 * 60 * 1000).unref();
  cleanup();
  schedule();
  if (settings().autoUpdate) {
    update().catch(e => console.log(`[yt-dlp] aggiornamento automatico non riuscito: ${e.message}`));
    setInterval(() => { if (settings().autoUpdate) update().catch(() => {}); }, UPDATE_EVERY_MS).unref();
  }
}

function get(key) { return jobs.get(key) || null; }

function list() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicView);
}

function ensure({ url, mode, title, index }) {
  mode = mode === 'audio' ? 'audio' : 'video';
  const key = keyFor(url, mode);
  let job = jobs.get(key);
  if (job && job.status !== 'failed') return job;
  const s = settings();
  const prefix = s.numberFiles && index ? `${String(index).padStart(2, '0')} - ` : '';
  job = {
    key,
    url,
    mode,
    title: title || url,
    // Nome definitivo (con l'estensione vera) quando il file è pronto
    filename: streamer.sanitizeFilename(`${prefix}${title || 'video'}`) + (mode === 'audio' ? `.${s.audioFormat}` : '.mp4'),
    file: null,
    size: null,
    written: 0,
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    lastAccess: Date.now()
  };
  jobs.set(key, job);
  save(job);
  schedule();
  return job;
}

function remove(key) {
  const job = jobs.get(key);
  if (!job) return false;
  job.cancelled = true;
  if (job.child) job.child.kill('SIGKILL');
  jobs.delete(key);
  removeFiles(key);
  schedule();
  return true;
}

function removeFiles(key, { keepMeta = false } = {}) {
  for (const name of fs.readdirSync(DIR)) {
    if (!name.startsWith(key)) continue;
    if (keepMeta && name === `${key}.json`) continue;
    fs.rm(path.join(DIR, name), { force: true }, () => {});
  }
}

function schedule() {
  let running = [...jobs.values()].filter(j => j.status === 'running').length;
  for (const job of jobs.values()) {
    if (running >= MAX_RUNNING) break;
    if (job.status !== 'queued') continue;
    running++;
    start(job);
  }
}

function formatArgs(job) {
  const s = settings();
  if (job.mode === 'audio') {
    return ['-f', 'ba/b', '-x', '--audio-format', s.audioFormat, '--embed-metadata'];
  }
  // H.264 + AAC dove esiste: si apre su qualunque telefono, TV o lettore.
  const args = ['-f', 'bv*+ba/b', '-S', `res:${s.maxHeight},vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4', '--embed-metadata'];
  if (s.embedSubs) {
    const lang = String(config.get().language || 'it').slice(0, 2);
    args.push('--embed-subs', '--sub-langs', `${lang}.*,en.*`);
  }
  return args;
}

async function start(job) {
  job.status = 'running';
  job.error = null;
  job.written = 0;
  job.size = null;
  save(job);
  removeFiles(job.key, { keepMeta: true });  // avanzi di un tentativo precedente
  console.log(`[yt-dlp] avvio ${job.mode}: ${job.title}`);

  let finalFile = null;
  const args = [
    ...formatArgs(job),
    '--no-playlist', '--newline', '--no-mtime',
    '--progress-template', 'download:NSPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
    '--print', 'after_move:NSFILE %(filepath)s',
    '-o', path.join(DIR, `${job.key}.%(ext)s`),
    job.url
  ];
  const promise = run(args, {
    onLine: line => {
      if (line.startsWith('NSPROG ')) {
        const [done, total, estimate] = line.slice(7).split(' ').map(Number);
        if (Number.isFinite(done)) job.written = done;
        const size = Number.isFinite(total) ? total : Number.isFinite(estimate) ? Math.round(estimate) : null;
        if (size) job.size = size;
      } else if (line.startsWith('NSFILE ')) {
        finalFile = line.slice(7).trim();
      }
    }
  });
  job.child = run.last;

  let result;
  try { result = await promise; } catch (e) { result = { code: -1, err: e.message }; }
  job.child = null;
  if (job.cancelled) return;

  if (result.code === 0 && finalFile && fs.existsSync(finalFile)) {
    const size = fs.statSync(finalFile).size;
    job.file = finalFile;
    job.size = size;
    job.written = size;
    job.filename = job.filename.replace(/\.[^.]+$/, '') + path.extname(finalFile);
    job.status = 'done';
    console.log(`[yt-dlp] completato: ${job.title} (${Math.round(size / 1024 / 1024)} MB)`);
  } else {
    job.status = 'failed';
    job.error = errorMessage(result.err, `yt-dlp è uscito con codice ${result.code}`);
    console.log(`[yt-dlp] fallito: ${job.title} — ${job.error}`);
  }
  job.lastAccess = Date.now();
  save(job);
  schedule();
}

// Consegna il file pronto (Range gestito da Express).
function serve(job, req, res) {
  if (job.status !== 'done' || !job.file) {
    res.status(409).json({ error: 'File non ancora pronto' });
    return;
  }
  job.lastAccess = Date.now();
  save(job);
  res.download(job.file, job.filename, { headers: { 'Cache-Control': 'no-store' } }, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File non più presente sul server' });
  });
}

function cleanup() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    const age = now - (job.lastAccess || job.createdAt);
    if ((job.status === 'done' && age > KEEP_DONE_MS) || (job.status === 'failed' && age > KEEP_FAILED_MS)) {
      console.log(`[yt-dlp] rimosso dal disco: ${job.title}`);
      remove(job.key);
    }
  }
}

// ---- Versione e aggiornamento

async function version() {
  if (cachedVersion) return cachedVersion;
  try {
    const { code, out } = await run(['--version'], { timeoutMs: 20000 });
    cachedVersion = code === 0 ? out.trim() : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

// Scarica l'ultima versione ufficiale in data/bin (sostituisce quella dell'immagine).
function update() {
  if (updating) return updating;
  updating = (async () => {
    const before = await version();
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const res = await fetch(RELEASE_URL, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`download non riuscito (HTTP ${res.status})`);
    const tmp = UPDATED_BIN + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    fs.renameSync(tmp, UPDATED_BIN);
    cachedVersion = null;
    const after = await version();
    if (after !== before) console.log(`[yt-dlp] aggiornato: ${before || '?'} → ${after}`);
    return { before, after };
  })().finally(() => { updating = null; });
  return updating;
}

module.exports = { DEFAULTS, settings, info, init, get, list, ensure, remove, serve, version, update, publicView };
