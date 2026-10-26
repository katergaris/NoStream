// Collegamento all'account Nuvio: legge gli addon installati in Nuvio e li usa come fonti.
//
// Nuvio salva gli addon nell'account (backend Supabase, schema pubblico in
// github.com/NuvioMedia/self-host): tabella `addons` (url, name, enabled, sort_order,
// profile_id 1-6), leggibile solo dal proprietario; i profili si leggono con la funzione
// `sync_pull_profiles`, e un profilo può usare gli addon del principale
// (`uses_primary_addons`). Qui si legge soltanto: NoStream non scrive mai nell'account.
//
// Il login si fa una volta con email e password; si conserva solo il refresh token (che
// Supabase rinnova a ogni uso), mai la password.

const crypto = require('crypto');
const config = require('./config');
const plugins = require('./plugins');

// NUVIO_BACKEND serve per le prove o per un backend Nuvio self-hosted.
const DEFAULT_BACKEND = process.env.NUVIO_BACKEND || 'https://api.nuvio.tv';
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 10000;
const OWN_ADDON_ID = 'org.nuvio-offline';

let session = null;   // { accessToken, expiresAt } solo in memoria
let syncing = null;

function state() { return config.get().nuvio || null; }

function saveState(patch) {
  const cfg = config.get();
  cfg.nuvio = { ...(cfg.nuvio || {}), ...patch };
  config.save(cfg);
  return cfg.nuvio;
}

async function discover(backendUrl) {
  const res = await fetch(`${backendUrl}/.well-known/nuvio`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Nuvio non raggiungibile (HTTP ${res.status})`);
  const d = await res.json();
  if (!d.publishable_key) throw new Error('Risposta di Nuvio inattesa');
  return { backendUrl: d.backend_url || backendUrl, key: d.publishable_key };
}

async function authRequest(backendUrl, key, grant, body) {
  const res = await fetch(`${backendUrl}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.msg || data.error || `HTTP ${res.status}`;
    const e = new Error(/invalid login|invalid_grant|credentials/i.test(msg) ? 'Email o password non corrette' : msg);
    e.auth = true;
    throw e;
  }
  return data;
}

function remember(data) {
  session = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
  saveState({ refreshToken: data.refresh_token, userId: data.user && data.user.id, email: data.user && data.user.email });
}

async function login(email, password) {
  const { backendUrl, key } = await discover(DEFAULT_BACKEND);
  const data = await authRequest(backendUrl, key, 'password', { email: String(email).trim(), password: String(password) });
  saveState({ backendUrl, key, connectedAt: Date.now(), profileId: 1, excluded: [], error: null });
  remember(data);
  await sync();
  return status();
}

async function accessToken() {
  if (session && session.expiresAt > Date.now()) return session.accessToken;
  const s = state();
  if (!s || !s.refreshToken) throw new Error('Account Nuvio non collegato');
  try {
    const data = await authRequest(s.backendUrl, s.key, 'refresh_token', { refresh_token: s.refreshToken });
    remember(data);
  } catch (e) {
    if (e.auth) {
      // Sessione scaduta o revocata (es. cambio password): serve un nuovo login.
      saveState({ refreshToken: null, error: 'Sessione Nuvio scaduta: collega di nuovo l\'account' });
      session = null;
    }
    throw e;
  }
  return session.accessToken;
}

async function rest(pathAndQuery, { method = 'GET', body } = {}) {
  const s = state();
  const token = await accessToken();
  const res = await fetch(`${s.backendUrl}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: s.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Nuvio: HTTP ${res.status}`);
  return res.json();
}

function idFor(url) { return 'nv-' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 12); }

// Un addon serve a NoStream se offre stream per film o serie con id IMDb.
function analyseManifest(m) {
  if (m.id === OWN_ADDON_ID) return { usable: false, reason: 'self' };
  const resources = (m.resources || []).map(r => (typeof r === 'string' ? { name: r } : r));
  const stream = resources.find(r => r.name === 'stream');
  if (!stream) return { usable: false, reason: 'noStreams' };
  const types = stream.types || m.types || [];
  if (!types.some(t => t === 'movie' || t === 'series')) return { usable: false, reason: 'noMovies' };
  const prefixes = stream.idPrefixes || m.idPrefixes;
  if (prefixes && prefixes.length && !prefixes.some(p => 'tt'.startsWith(p) || p.startsWith('tt'))) return { usable: false, reason: 'noImdb' };
  return { usable: true, reason: null };
}

async function probe(url) {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - start };
    const m = await res.json();
    return { ok: true, manifest: m, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message, ms: Date.now() - start };
  }
}

// Legge profili e addon dall'account, controlla ogni addon e aggiorna le fonti di
// NoStream: gli addon «da Nuvio» sono sostituiti da quelli attuali, quelli aggiunti a
// mano restano.
function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const s = state();
    if (!s || !s.refreshToken) throw new Error('Account Nuvio non collegato');

    const profiles = await rest('rpc/sync_pull_profiles', { method: 'POST', body: {} }).catch(() => []);
    const profileId = s.profileId || 1;
    const profile = profiles.find(p => p.profile_index === profileId);
    const source = profile && profile.uses_primary_addons ? 1 : profileId;
    const rows = await rest(`addons?select=url,name,enabled,sort_order,profile_id&profile_id=eq.${source}&order=sort_order.asc`);
    // Plugin (provider JavaScript): repository nella tabella `plugins`, stessa logica dei profili
    const pluginSource = profile && profile.uses_primary_plugins ? 1 : profileId;
    const pluginRows = await rest(`plugins?select=url,name,enabled,sort_order,profile_id,repo_type&profile_id=eq.${pluginSource}&order=sort_order.asc`).catch(() => []);
    const pluginReport = await plugins.refresh(pluginRows);

    const seen = new Set();
    const report = await Promise.all(rows.map(async row => {
      const url = String(row.url || '').trim();
      const entry = { id: idFor(url), url, name: row.name || null, enabled: row.enabled !== false, sortOrder: row.sort_order };
      if (seen.has(url)) return { ...entry, status: 'duplicate' };
      seen.add(url);
      if (!entry.enabled) return { ...entry, status: 'disabled' };
      const p = await probe(url);
      if (!p.ok) return { ...entry, status: 'unreachable', error: p.error, ms: p.ms };
      const a = analyseManifest(p.manifest);
      return {
        ...entry,
        name: p.manifest.name || entry.name,
        version: p.manifest.version || null,
        ms: p.ms,
        status: a.usable ? 'usable' : a.reason
      };
    }));

    // Fonti: quelle a mano + quelle di Nuvio utilizzabili e non escluse dall'utente.
    const cfg = config.get();
    const excluded = new Set((cfg.nuvio && cfg.nuvio.excluded) || []);
    const manual = cfg.addons.filter(a => a.origin !== 'nuvio');
    const manualUrls = new Set(manual.map(a => a.manifestUrl));
    const fromNuvio = report
      .filter(r => r.status === 'usable' && !excluded.has(r.id) && !manualUrls.has(r.url))
      .map(r => ({ id: r.id, name: r.name || new URL(r.url).hostname, manifestUrl: r.url, origin: 'nuvio' }));
    cfg.addons = [...manual, ...fromNuvio];
    cfg.nuvio = {
      ...cfg.nuvio,
      profiles: profiles.map(p => ({ index: p.profile_index, name: p.name, usesPrimary: !!p.uses_primary_addons })),
      report,
      pluginReport,
      lastSync: Date.now(),
      error: null
    };
    config.save(cfg);
    console.log(`[nuvio] sincronizzati ${rows.length} addon (profilo ${profileId}), ${fromNuvio.length} usati come fonti; ${pluginReport.reduce((n, r) => n + r.scrapers.length, 0)} plugin in ${pluginReport.length} repository`);
    return status();
  })().catch(e => {
    saveState({ error: e.message });
    throw e;
  }).finally(() => { syncing = null; });
  return syncing;
}

function status() {
  const s = state();
  if (!s || (!s.refreshToken && !s.error)) return { connected: false };
  const excluded = new Set(s.excluded || []);
  return {
    connected: !!s.refreshToken,
    email: s.email || null,
    profileId: s.profileId || 1,
    profiles: s.profiles || [],
    lastSync: s.lastSync || null,
    error: s.error || null,
    // Gli URL possono contenere chiavi personali: all'interfaccia va solo il dominio.
    addons: (s.report || []).map(r => ({
      id: r.id,
      name: r.name,
      host: (() => { try { return new URL(r.url).hostname; } catch { return '?'; } })(),
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      status: r.status,
      error: r.error || null,
      ms: r.ms || null,
      version: r.version || null,
      used: r.status === 'usable' && !excluded.has(r.id)
    })),
    plugins: pluginStatus(s)
  };
}

function pluginStatus(s) {
  const ps = s.plugins || {};
  const excluded = new Set(ps.excluded || []);
  return {
    enabled: !!ps.enabled,
    repos: (s.pluginReport || []).map(r => ({
      id: r.id, name: r.name, host: r.host, enabled: r.enabled, error: r.error,
      scrapers: r.scrapers.map(x => {
        const st = plugins.statsFor(x.key);
        return {
          key: x.key, name: x.name, version: x.version, types: x.types, langs: x.langs, formats: x.formats,
          status: x.status === 'ok' && !plugins.hasCode(x.key) ? 'unreachable' : x.status,
          error: x.error,
          used: !excluded.has(x.key) && x.status === 'ok',
          animationOnly: plugins.animationOnly(x.name),
          last: st
        };
      })
    }))
  };
}

function setPluginsEnabled(enabled) {
  const s = state() || {};
  saveState({ plugins: { ...(s.plugins || {}), enabled: !!enabled } });
  return status();
}

function setPluginUsed(key, used) {
  const s = state() || {};
  const ps = s.plugins || {};
  const excluded = new Set(ps.excluded || []);
  if (used) excluded.delete(key); else excluded.add(key);
  saveState({ plugins: { ...ps, excluded: [...excluded] } });
  return status();
}

async function setProfile(profileId) {
  const n = parseInt(profileId, 10);
  if (!(n >= 1 && n <= 6)) throw new Error('Profilo non valido');
  saveState({ profileId: n });
  return sync();
}

function setUsed(id, used) {
  const s = state() || {};
  const excluded = new Set(s.excluded || []);
  if (used) excluded.delete(id); else excluded.add(id);
  saveState({ excluded: [...excluded] });
  // Applica subito senza rileggere l'account
  const cfg = config.get();
  const r = (s.report || []).find(x => x.id === id);
  cfg.addons = cfg.addons.filter(a => a.id !== id);
  if (used && r && r.status === 'usable') cfg.addons.push({ id: r.id, name: r.name || new URL(r.url).hostname, manifestUrl: r.url, origin: 'nuvio' });
  config.save(cfg);
  return status();
}

function logout() {
  const cfg = config.get();
  cfg.addons = cfg.addons.filter(a => a.origin !== 'nuvio');
  delete cfg.nuvio;
  config.save(cfg);
  session = null;
  return { connected: false };
}

function init() {
  const run = () => {
    const s = state();
    if (s && s.refreshToken) sync().catch(e => console.log(`[nuvio] sincronizzazione non riuscita: ${e.message}`));
  };
  setTimeout(run, 5000).unref();
  setInterval(run, SYNC_EVERY_MS).unref();
}

module.exports = { init, login, sync, status, setProfile, setUsed, setPluginsEnabled, setPluginUsed, logout };
