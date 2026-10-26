// Traduzioni lato server: messaggi d'errore delle API, voci di NoStream dentro Nuvio,
// pagina «Prepara sul server». Usa gli stessi file dell'interfaccia
// (public/i18n/<lingua>.json, chiavi «srv.*»), così ogni lingua ha un solo file.
//
// Lingua della richiesta: header X-NoStream-Lang (la manda la web app), poi
// Accept-Language (Nuvio, browser), poi la lingua dei metadati in config.json.
// I log per chi gestisce il server restano in italiano.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DIR = path.join(__dirname, '..', 'public', 'i18n');
const FALLBACK = 'it';
const strings = {};
for (const file of fs.readdirSync(DIR)) {
  if (!file.endsWith('.json')) continue;
  try { strings[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch {}
}
const LANGS = Object.keys(strings);

function tr(lang, key, vars = {}) {
  let s = (strings[lang] && strings[lang][key]) ?? strings[FALLBACK][key];
  if (s === undefined) return key;
  if (typeof s === 'object') {
    const rule = new Intl.PluralRules(lang).select(Number(vars.n));
    s = s[rule] !== undefined ? s[rule] : s.other;
  }
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function pick(req) {
  const wanted = [
    req.get('x-nostream-lang'),
    ...String(req.get('accept-language') || '').split(',').map(p => p.split(';')[0]),
    config.get().language
  ];
  for (const w of wanted) {
    const l = String(w || '').trim().slice(0, 2).toLowerCase();
    if (LANGS.includes(l)) return l;
  }
  return FALLBACK;
}

function middleware(req, res, next) {
  req.lang = pick(req);
  req.t = (key, vars) => tr(req.lang, key, vars);
  next();
}

// Errore con un messaggio traducibile: il testo italiano resta in .message (log).
class AppError extends Error {
  constructor(key, vars = {}, status) {
    super(tr(FALLBACK, key, vars));
    this.key = key;
    this.vars = vars;
    if (status) this.status = status;
  }
}

// Testo di un errore nella lingua voluta.
function msgOf(e, lang) {
  if (!e) return tr(lang, 'srv.internal');
  if (e.key) return tr(lang, e.key, e.vars);
  return e.message || tr(lang, 'srv.internal');
}

// Errore salvato in un lavoro (preparazione, yt-dlp, account Nuvio): chiave + valori.
function saveError(e) {
  return e && e.key ? { error: e.message, errorKey: e.key, errorVars: e.vars } : { error: e ? e.message || String(e) : null, errorKey: null, errorVars: null };
}

function errorText(obj, lang) {
  if (!obj) return null;
  if (obj.errorKey) return tr(lang, obj.errorKey, obj.errorVars || {});
  return obj.error || null;
}

module.exports = { tr, pick, middleware, AppError, msgOf, saveError, errorText, LANGS };
