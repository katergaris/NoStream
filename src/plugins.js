// Plugin di Nuvio (provider JavaScript) usati come fonti.
//
// I repository dei plugin arrivano dall'account Nuvio (src/nuvio.js). Ogni repository ha
// un manifest con l'elenco dei plugin («scrapers»: id, nome, file, tipi, lingue); il
// codice si scarica da lì e si esegue in un processo separato con il permission model di
// Node: niente accesso ai file del server (config.json, chiavi, download), niente altri
// processi. Vedi src/plugin-runner/runner.js.
//
// Tutto è spento finché l'utente non accende «Usa i plugin di Nuvio».

const crypto = require('crypto');
const path = require('path');
const { fork } = require('child_process');

const config = require('./config');

const RUNNER_DIR = path.join(__dirname, 'plugin-runner');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
const CALL_TIMEOUT_MS = 45000;

let runner = null;
let ready = null;
let nextId = 1;
const pending = new Map();
const code = new Map();     // chiave plugin -> { version, text }
const stats = new Map();    // chiave plugin -> { at, ms, count, error }

function settings() { return (config.get().nuvio && config.get().nuvio.plugins) || {}; }

function keyFor(repoUrl, scraperId) {
  return crypto.createHash('sha1').update(`${repoUrl}|${scraperId}`).digest('hex').slice(0, 12);
}

// ---- Lettura dei repository

async function fetchText(url, ms = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Legge i manifest dei repository e scarica il codice dei plugin. repos = righe della
// tabella `plugins` dell'account Nuvio (url, name, enabled, sort_order).
async function refresh(repos) {
  const report = [];
  for (const repo of repos) {
    const url = String(repo.url || '').trim();
    const entry = {
      id: keyFor(url, ''),
      name: repo.name || null,
      host: (() => { try { return new URL(url).hostname; } catch { return '?'; } })(),
      enabled: repo.enabled !== false,
      sortOrder: repo.sort_order,
      scrapers: [],
      error: null
    };
    report.push(entry);
    if (!entry.enabled || !url) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fetchText(url));
    } catch (e) {
      entry.error = e.name === 'TimeoutError' ? 'timeout' : e.message;
      continue;
    }
    entry.name = entry.name || manifest.name || entry.host;
    const scrapers = Array.isArray(manifest) ? manifest : (manifest.scrapers || []);
    await Promise.all(scrapers.map(async s => {
      if (!s || !s.id || !s.filename) return;
      const key = keyFor(url, s.id);
      const item = {
        key,
        id: s.id,
        name: s.name || s.id,
        version: s.version || '',
        types: s.supportedTypes || ['movie', 'tv'],
        langs: s.contentLanguage || [],
        formats: s.formats || [],
        enabledInRepo: s.enabled !== false,
        status: 'ok',
        error: null
      };
      entry.scrapers.push(item);
      const version = `${s.version || ''}|${s.filename}`;
      if (code.has(key) && code.get(key).version === version) return;
      try {
        const text = await fetchText(new URL(s.filename, url).href);
        code.set(key, { version, text, name: item.name, types: item.types });
      } catch (e) {
        item.status = 'unreachable';
        item.error = e.name === 'TimeoutError' ? 'timeout' : e.message;
      }
    }));
    entry.scrapers.sort((a, b) => a.name.localeCompare(b.name));
  }
  return report;
}

// ---- Processo chiuso

function startRunner() {
  if (runner) return ready;
  runner = fork(path.join(RUNNER_DIR, 'runner.js'), [], {
    execArgv: ['--experimental-permission', `--allow-fs-read=${path.join(RUNNER_DIR, '*')}`, `--allow-fs-read=${path.join(NODE_MODULES, '*')}`, '--no-warnings'],
    env: { NODE_PATH: NODE_MODULES },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  ready = new Promise(resolve => {
    runner.on('message', msg => {
      if (msg.type === 'ready') return resolve();
      if (msg.type === 'log') return console.log(`[plugin ${msg.key}] ${msg.msg}`);
      if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.streams);
      }
    });
  });
  runner.on('exit', () => {
    runner = null;
    ready = null;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('processo dei plugin terminato')); pending.delete(id); }
  });
  return ready;
}

// Un plugin che non risponde (o blocca la CPU) fa ripartire il processo.
function restartRunner() {
  if (runner) runner.kill('SIGKILL');
}

async function callPlugin(key, args) {
  const c = code.get(key);
  if (!c) throw new Error('codice non disponibile');
  await startRunner();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
      restartRunner();
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    runner.send({
      type: 'call', id, key, version: c.version, code: c.text, args,
      settings: {}, tmdbKey: config.get().tmdbApiKey
    });
  });
}

// ---- Stream per NoStream

function active() {
  const s = settings();
  if (!s.enabled) return [];
  const excluded = new Set(s.excluded || []);
  return [...code.keys()].filter(k => !excluded.has(k));
}

// Stream dei plugin attivi per un titolo, già nel formato degli stream degli addon.
async function getStreams(tmdbId, mediaType, season, episode, timeoutMs) {
  const keys = active().filter(k => (code.get(k).types || []).includes(mediaType));
  if (!keys.length || !tmdbId) return { streams: [], errors: [] };
  const args = { tmdbId, mediaType, season: season ?? null, episode: episode ?? null };
  const streams = [];
  const errors = [];
  await Promise.all(keys.map(async key => {
    const name = code.get(key).name;
    const start = Date.now();
    try {
      const list = await Promise.race([
        callPlugin(key, args),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs || CALL_TIMEOUT_MS))
      ]);
      stats.set(key, { at: Date.now(), ms: Date.now() - start, count: list.length, error: null });
      for (const s of list) {
        const url = s && (s.url || s.link);
        if (!url || typeof url !== 'string') continue;
        streams.push({
          addonId: `plugin:${key}`,
          addonName: `${name} (plugin)`,
          name: s.name || name,
          title: [s.title || s.name || 'Stream', s.quality, s.size].filter(Boolean).join(' · '),
          url,
          externalUrl: null,
          infoHash: null,
          headers: s.headers && typeof s.headers === 'object' ? s.headers : null,
          suggestedFilename: null,
          supported: /^https?:\/\//i.test(url)
        });
      }
    } catch (e) {
      stats.set(key, { at: Date.now(), ms: Date.now() - start, count: 0, error: e.message });
      errors.push({ addonName: `${name} (plugin)`, error: e.message });
    }
  }));
  return { streams, errors };
}

function statsFor(key) { return stats.get(key) || null; }

function hasCode(key) { return code.has(key); }

module.exports = { refresh, getStreams, statsFor, hasCode, settings };
