// Rete più robusta per le linee che perdono connessioni (es. 5G con NAT dell'operatore).
// Si carica sia nel server sia nel processo dei plugin: sta in questa cartella perché il
// processo dei plugin può leggere solo qui (permission model, vedi src/plugins.js).
//
// 1. Con IPv6 non raggiungibile Node prova ogni indirizzo per soli 250 ms: se gli IPv4
//    rispondono più lenti fetch fallisce a caso. Prima gli IPv4 e 3 s a tentativo.
// 2. Se una connessione non si apre (pacchetto perso, DNS che non risponde), fetch
//    riprova fino a due volte invece di fallire con "fetch failed".

const dns = require('dns');
const net = require('net');

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);

// Errori prima che la richiesta parta: si può riprovare qualunque metodo.
const CONNECT_ERRORS = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'
]);
// Connessione caduta a metà: si riprova solo se la richiesta non cambia nulla.
const SOCKET_ERRORS = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
const DELAYS_MS = [500, 1500];

function errorCode(e) {
  const c = e && e.cause;
  return (c && (c.code || (c.errors && c.errors[0] && c.errors[0].code))) || null;
}

function canRetry(e, method, body, signal) {
  if (signal && signal.aborted) return false;
  if (!(e instanceof TypeError)) return false;  // AbortError, errori del chiamante
  if (body && typeof body.getReader === 'function') return false;  // stream: non si rilegge
  const code = errorCode(e);
  if (CONNECT_ERRORS.has(code)) return true;
  return SOCKET_ERRORS.has(code) && (method === 'GET' || method === 'HEAD');
}

function install() {
  const original = globalThis.fetch;
  if (!original || original.netRetry) return;
  const wrapped = async function fetchWithRetry(input, init = {}) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    if (isRequest && input.body) return original(input, init);
    const method = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase();
    const signal = init.signal || (isRequest ? input.signal : null);
    for (let attempt = 0; ; attempt++) {
      try {
        return await original(input, init);
      } catch (e) {
        if (attempt >= DELAYS_MS.length || !canRetry(e, method, init.body, signal)) throw e;
        await new Promise(r => setTimeout(r, DELAYS_MS[attempt]));
        if (signal && signal.aborted) throw e;
      }
    }
  };
  wrapped.netRetry = true;
  globalThis.fetch = wrapped;
}

install();

module.exports = { install };
