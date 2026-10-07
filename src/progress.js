// Avanzamento dei download avviati dalla coda della piattaforma web.
//
// Il browser non dice alla pagina quando un download è finito: lo sa solo il server, che
// vede passare i byte. Ogni download della coda porta un id (?dl=...) e qui contiamo i
// byte inviati per quell'id, su tutte le connessioni (anche le riprese con Range), così la
// pagina può interrogare /api/progress e passare all'episodio successivo a fine invio.

const KEEP_MS = 24 * 60 * 60 * 1000;

const entries = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of entries) {
    if (now - e.updatedAt > KEEP_MS) entries.delete(id);
  }
}, 60 * 60 * 1000).unref();

function entry(id) {
  let e = entries.get(id);
  if (!e) {
    e = { status: 'starting', sent: 0, total: null, error: null, updatedAt: Date.now() };
    entries.set(id, e);
  }
  return e;
}

// "bytes 100-199/1000" -> { start: 100, total: 1000 }; totale "*" -> null.
function parseContentRange(header) {
  const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(String(header || '').trim());
  if (!m) return null;
  return { start: parseInt(m[1], 10), total: m[2] === '*' ? null : parseInt(m[2], 10) };
}

function track(id, res) {
  const e = entry(id);
  e.status = 'starting';
  e.error = null;
  e.updatedAt = Date.now();

  let offset = null;
  let counted = 0;
  let errorBody = '';

  // Alla prima scrittura gli header sono definitivi: da lì si ricava da che byte parte
  // questa connessione e quanto è grande il file.
  const onFirstWrite = () => {
    if (offset !== null) return;
    offset = 0;
    if (res.statusCode >= 400 || res.statusCode === 302) return;
    const range = res.statusCode === 206 ? parseContentRange(res.getHeader('Content-Range')) : null;
    if (range) {
      offset = range.start;
      if (range.total) e.total = range.total;
    } else {
      const len = parseInt(res.getHeader('Content-Length'), 10);
      if (Number.isFinite(len)) e.total = len;
    }
    e.status = 'downloading';
  };

  const count = chunk => {
    if (!chunk || typeof chunk === 'function') return;
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (res.statusCode >= 400) {
      if (errorBody.length < 2000) errorBody += chunk.toString();
      return;
    }
    counted += len;
    e.sent = Math.max(e.sent, offset + counted);
    e.updatedAt = Date.now();
  };

  const write = res.write;
  res.write = function (chunk, ...rest) {
    onFirstWrite();
    count(chunk);
    return write.call(this, chunk, ...rest);
  };
  const end = res.end;
  res.end = function (chunk, ...rest) {
    onFirstWrite();
    count(chunk);
    return end.call(this, chunk, ...rest);
  };

  res.on('close', () => {
    e.updatedAt = Date.now();
    if (res.statusCode === 302) {
      // Fallback del 403: il browser scarica direttamente dalla fonte, senza passare di qui.
      e.status = 'external';
    } else if (res.statusCode >= 400) {
      e.status = 'error';
      let message = errorBody;
      try { message = JSON.parse(errorBody).error || errorBody; } catch {}
      e.error = message || `Errore ${res.statusCode}`;
    } else if (res.writableFinished && (e.total === null || e.sent >= e.total)) {
      e.status = 'done';
    } else {
      // Connessione caduta a metà: il download manager del browser di solito riprende da
      // solo con una nuova richiesta (stesso id), che riporta lo stato a "downloading".
      e.status = 'interrupted';
    }
  });
}

function get(ids) {
  const out = {};
  for (const id of ids) {
    const e = entries.get(id);
    if (e) out[id] = { status: e.status, sent: e.sent, total: e.total, error: e.error, updatedAt: e.updatedAt };
  }
  return out;
}

module.exports = { track, get };
