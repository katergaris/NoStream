// Processo che esegue i plugin di Nuvio (provider JavaScript scritti da terzi).
//
// Gira con il permission model di Node (vedi src/plugins.js): può leggere solo questa
// cartella e le librerie, non può scrivere file né avviare altri processi; può usare la
// rete, che serve ai plugin. Il codice dei plugin arriva dal processo principale via IPC.
//
// Ricrea l'ambiente dell'app Nuvio (composeApp/.../plugins/runtime/js/JsBindings.kt):
// fetch, timer, atob/btoa, URL, AbortController, TextEncoder, globali SCRAPER_ID,
// SCRAPER_SETTINGS e TMDB_API_KEY, e require() solo per cheerio e crypto-js.
// Ogni plugin ha un contesto vm suo, così i plugin non si vedono tra loro.

const vm = require('vm');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const FETCH_TIMEOUT_MS = 20000;
const compiled = new Map();  // chiave del plugin -> { version, context }

// I plugin compilati con esbuild leggono a volte `require(x).default`: lo offriamo.
const cheerioModule = { ...cheerio, default: { ...cheerio } };
const cryptoModule = Object.assign(Object.create(CryptoJS), { default: CryptoJS });

function pluginRequire(name) {
  if (name === 'cheerio' || name === 'cheerio-without-node-native' || name === 'react-native-cheerio') return cheerioModule;
  if (name === 'crypto-js') return cryptoModule;
  throw new Error(`Module '${name}' is not available`);
}

// fetch con un tempo massimo: un plugin che aspetta per sempre non blocca gli altri.
function limitedFetch(url, options = {}) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal });
}

function makeContext(key, settings, tmdbKey) {
  const sandbox = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => process.send({ type: 'log', key, msg: a.map(String).join(' ').slice(0, 300) }) },
    fetch: limitedFetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController, AbortSignal,
    TextEncoder, TextDecoder, atob, btoa,
    Headers, Request, Response, FormData,
    crypto: globalThis.crypto,
    SCRAPER_ID: key,
    SCRAPER_SETTINGS: settings || {},
    TMDB_API_KEY: tmdbKey || '',
    require: pluginRequire
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  return vm.createContext(sandbox, { name: `plugin:${key}` });
}

function load(msg) {
  const cached = compiled.get(msg.key);
  if (cached && cached.version === msg.version) return cached.context;
  const context = makeContext(msg.key, msg.settings, msg.tmdbKey);
  context.module = { exports: {} };
  context.exports = context.module.exports;
  vm.runInContext(msg.code, context, { filename: `${msg.key}.js`, timeout: 5000 });
  compiled.set(msg.key, { version: msg.version, context });
  return context;
}

async function call(msg) {
  const context = load(msg);
  const getStreams = (context.module.exports && context.module.exports.getStreams) || context.getStreams;
  if (typeof getStreams !== 'function') throw new Error('getStreams non trovato');
  const a = msg.args;
  const result = await getStreams(String(a.tmdbId), a.mediaType, a.season ?? undefined, a.episode ?? undefined);
  // Solo dati semplici tornano al processo principale
  return JSON.parse(JSON.stringify(Array.isArray(result) ? result : []));
}

process.on('message', async msg => {
  if (msg.type !== 'call') return;
  try {
    const streams = await call(msg);
    process.send({ type: 'result', id: msg.id, streams });
  } catch (e) {
    process.send({ type: 'result', id: msg.id, error: (e && e.message ? e.message : String(e)).slice(0, 300) });
  }
});

// Un errore non gestito dentro un plugin non deve far cadere il processo.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', e => {
  try { process.send({ type: 'log', key: '-', msg: `eccezione: ${e && e.message}` }); } catch {}
});

process.send({ type: 'ready' });
