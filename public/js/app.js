const state = {
  results: [],
  item: null,          // titolo aperto nella scheda
  seasons: [],
  season: null,
  episodes: [],
  selected: new Set(), // numeri degli episodi spuntati
  openEpisode: null,
  streamCache: new Map()
};

// ---- Utilities ----

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

window.addEventListener('error', e => {
  console.error(e.error || e.message);
  toast(`Errore: ${e.message}`, true);
});
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast(`Errore: ${(e.reason && e.reason.message) || e.reason}`, true);
});

function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    throw new Error((data && data.error) || `Errore ${res.status}`);
  }
  return data;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// La stagione resta attaccata sotto la topbar: serve sapere quanto è alta (su telefono va
// a capo e cambia altezza).
function trackTopbarHeight() {
  const bar = $('.topbar');
  const update = () => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  update();
  if (window.ResizeObserver) new ResizeObserver(update).observe(bar);
}

// ---- Navigazione (hash, così il tasto "indietro" del telefono funziona) ----

const VIEWS = { '': 'search', '#coda': 'queue', '#impostazioni': 'settings', '#titolo': 'detail' };

function route() {
  let view = VIEWS[location.hash] || 'search';
  if (view === 'detail' && !state.item) view = 'search';
  if (view === 'queue' || view === 'settings') window.scrollTo(0, 0);
  $all('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $all('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'settings') {
    loadAddons();
    loadSettings();
  }
  if (view === 'queue') renderQueue();
  renderActionBar(view);
}

function go(hash) {
  if (location.hash === hash || (!location.hash && hash === '')) route();
  else location.hash = hash;
}

// ---- Ricerca ----

function initSearch() {
  $('#search-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#search-input');
    const query = input.value.trim();
    if (!query) return;
    input.blur();
    go('');
    const results = $('#search-results');
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'empty' }, 'Ricerca in corso…'));
    try {
      const { results: items } = await api(`/search?query=${encodeURIComponent(query)}`);
      state.results = items;
      renderResults(items);
    } catch (err) {
      results.innerHTML = '';
      toast(err.message, true);
    }
  });

  $('#detail-back').addEventListener('click', () => history.back());
}

function renderResults(items) {
  const container = $('#search-results');
  container.innerHTML = '';
  if (!items.length) {
    container.appendChild(el('div', { class: 'empty' }, 'Nessun risultato'));
    return;
  }
  for (const item of items) {
    container.appendChild(el('button', { class: 'card', type: 'button', onclick: () => openDetail(item) }, [
      item.posterUrl
        ? el('img', { src: item.posterUrl, alt: '', loading: 'lazy' })
        : el('div', { class: 'placeholder' }, item.title),
      el('div', { class: 'info' }, [
        el('div', { class: 'title' }, item.title),
        el('div', { class: 'meta' }, `${item.type === 'tv' ? 'Serie TV' : 'Film'}${item.year ? ' · ' + item.year : ''}`)
      ])
    ]));
  }
}

// ---- Scheda film / serie ----

function fileLabel(item, season, episode) {
  return item.type === 'movie'
    ? `${item.title}${item.year ? ` (${item.year})` : ''}`
    : `${item.title} S${pad(season)}E${pad(episode)}`;
}

async function openDetail(item) {
  state.item = item;
  state.seasons = [];
  state.season = null;
  state.episodes = [];
  state.selected.clear();
  state.openEpisode = null;
  state.streamCache.clear();
  go('#titolo');
  window.scrollTo(0, 0);

  const content = $('#detail-content');
  content.innerHTML = '';
  const overview = el('p', { class: 'overview', onclick: () => overview.classList.toggle('open') },
    item.overview || 'Nessuna descrizione disponibile.');
  content.appendChild(el('div', { class: 'detail-header' }, [
    item.posterUrl ? el('img', { src: item.posterUrl, alt: '' }) : null,
    el('div', {}, [
      el('h3', {}, `${item.title}${item.year ? ` (${item.year})` : ''}`),
      el('div', { class: 'kind' }, item.type === 'tv' ? 'Serie TV' : 'Film'),
      overview
    ])
  ]));

  if (item.type === 'movie') {
    const streamsWrap = el('div', { class: 'stream-list' });
    content.appendChild(streamsWrap);
    renderActionBar('detail');
    await loadStreamsInto(streamsWrap, {});
    return;
  }

  content.appendChild(el('div', { id: 'season-bar', class: 'season-bar' }, el('span', { class: 'hint' }, 'Caricamento stagioni…')));
  content.appendChild(el('div', { id: 'episode-area' }));
  try {
    const { seasons } = await api(`/seasons/${item.tmdbId}`);
    if (state.item !== item) return;
    state.seasons = seasons;
    const first = seasons.find(s => s.seasonNumber > 0) || seasons[0];
    renderSeasonBar();
    if (first) selectSeason(first.seasonNumber);
  } catch (err) {
    $('#season-bar').innerHTML = '';
    toast(err.message, true);
  }
}

function renderSeasonBar() {
  const bar = $('#season-bar');
  bar.innerHTML = '';
  for (const s of state.seasons) {
    bar.appendChild(el('button', {
      type: 'button',
      class: 'season-chip' + (s.seasonNumber === state.season ? ' active' : ''),
      onclick: () => selectSeason(s.seasonNumber)
    }, [s.seasonNumber === 0 ? 'Speciali' : `Stagione ${s.seasonNumber}`, el('small', {}, String(s.episodeCount))]));
  }
  const active = $('.season-chip.active', bar);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

async function selectSeason(number) {
  const item = state.item;
  state.season = number;
  state.episodes = [];
  state.selected.clear();
  state.openEpisode = null;
  renderSeasonBar();
  renderActionBar('detail');
  const area = $('#episode-area');
  area.innerHTML = '';
  area.appendChild(el('div', { class: 'empty small' }, 'Caricamento episodi…'));
  try {
    const { episodes } = await api(`/episodes/${item.tmdbId}/${number}`);
    if (state.item !== item || state.season !== number) return;
    state.episodes = episodes;
    renderEpisodes();
  } catch (err) {
    area.innerHTML = '';
    toast(err.message, true);
  }
}

function renderEpisodes() {
  const area = $('#episode-area');
  area.innerHTML = '';
  if (!state.episodes.length) {
    area.appendChild(el('div', { class: 'empty small' }, 'Nessun episodio'));
    return;
  }

  const all = el('input', { type: 'checkbox', id: 'select-all' });
  all.checked = state.selected.size === state.episodes.length;
  all.addEventListener('change', () => {
    state.selected = all.checked ? new Set(state.episodes.map(e => e.episodeNumber)) : new Set();
    renderEpisodes();
  });
  area.appendChild(el('label', { class: 'select-all', for: 'select-all' }, [all, 'Seleziona tutti']));

  const list = el('div', { class: 'episode-list' });
  for (const ep of state.episodes) list.appendChild(renderEpisode(ep));
  area.appendChild(list);
  renderActionBar('detail');
}

function renderEpisode(ep) {
  const n = ep.episodeNumber;
  const open = state.openEpisode === n;
  const check = el('input', { type: 'checkbox', 'aria-label': `Seleziona episodio ${n}` });
  check.checked = state.selected.has(n);
  check.addEventListener('change', () => {
    if (check.checked) state.selected.add(n);
    else state.selected.delete(n);
    const all = $('#select-all');
    if (all) all.checked = state.selected.size === state.episodes.length;
    renderActionBar('detail');
  });

  const queued = queueItemFor(queueKey('tv', state.item.tmdbId, state.season, n));
  const box = el('div', { class: 'episode' + (open ? ' open' : ''), 'data-ep': n }, [
    el('div', { class: 'episode-head' }, [
      check,
      el('button', { type: 'button', class: 'episode-main', onclick: () => toggleEpisode(n) }, [
        el('span', { class: 'ep-num' }, `E${pad(n)}`),
        el('span', { class: 'ep-title' }, ep.name || `Episodio ${n}`),
        queued ? queueTag(queued) : null,
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')
      ])
    ])
  ]);
  if (open) {
    const streams = el('div', { class: 'episode-streams' });
    box.appendChild(streams);
    loadStreamsInto(streams, { season: state.season, episode: n });
  }
  return box;
}

function toggleEpisode(n) {
  state.openEpisode = state.openEpisode === n ? null : n;
  const list = $('.episode-list');
  if (!list) return;
  for (const box of $all('.episode', list)) {
    const ep = state.episodes.find(e => e.episodeNumber === Number(box.dataset.ep));
    box.replaceWith(renderEpisode(ep));
  }
  const opened = state.openEpisode !== null && $(`.episode[data-ep="${state.openEpisode}"]`);
  if (opened) opened.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function fetchStreams(tmdbId, type, season, episode) {
  const params = new URLSearchParams({ tmdbId, type });
  if (season !== undefined && season !== null) params.set('season', season);
  if (episode !== undefined && episode !== null) params.set('episode', episode);
  return api(`/streams?${params.toString()}`);
}

async function loadStreamsInto(wrap, { season, episode }) {
  const item = state.item;
  const cacheKey = `${season ?? ''}:${episode ?? ''}`;
  wrap.innerHTML = '';
  wrap.appendChild(el('div', { class: 'empty small' }, 'Cerco gli stream sugli addon…'));
  try {
    let data = state.streamCache.get(cacheKey);
    if (!data) {
      data = await fetchStreams(item.tmdbId, item.type, season, episode);
      state.streamCache.set(cacheKey, data);
    }
    if (state.item !== item) return;
    renderStreams(wrap, data, item, season, episode);
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', { class: 'empty small' }, err.message));
  }
}

function renderStreams(wrap, { streams, errors }, item, season, episode) {
  wrap.innerHTML = '';
  for (const e of errors || []) {
    wrap.appendChild(el('div', { class: 'empty small' }, `Addon "${e.addonName}": ${e.error}`));
  }
  if (!streams.length) {
    wrap.appendChild(el('div', { class: 'empty small' }, 'Nessuno stream trovato'));
    return;
  }
  const title = fileLabel(item, season, episode);
  let first = true;
  for (const s of streams) {
    const best = s.supported && first;
    if (s.supported) first = false;
    wrap.appendChild(el('div', { class: 'stream-row' + (s.supported ? '' : ' unsupported') + (best ? ' best' : '') }, [
      el('div', { class: 'stream-info' }, [
        el('div', {}, [
          best ? el('span', { class: 'tag done' }, 'consigliato') : null,
          s.kind === 'direct' ? el('span', { class: 'tag direct' }, `file diretto${s.size ? ' · ' + formatSize(s.size) : ''}`) : null,
          s.kind === 'hls' ? el('span', { class: 'tag hls' }, 'HLS · da convertire') : null,
          !s.supported ? el('span', { class: 'tag warn' }, 'non supportato (torrent)') : null
        ]),
        el('div', { class: 'stream-title' }, s.title),
        el('div', { class: 'stream-addon' }, (s.addonNames || [s.addonName]).join(', '))
      ]),
      s.supported ? el('div', { class: 'stream-actions' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => addToQueue([{ item, season, episode, pinned: s }]) }, '＋ CODA'),
        el('button', { class: 'btn btn-sm btn-accent', type: 'button', onclick: () => downloadNow(s, title, item.type) }, '⬇ SCARICA')
      ]) : null
    ]));
  }
}

function downloadPayload(stream, title, mediaType) {
  return {
    addonName: stream.addonName,
    sourceUrl: stream.url,
    externalUrl: stream.externalUrl,
    infoHash: stream.infoHash,
    headers: stream.headers,
    streamTitle: stream.title,
    title,
    mediaType: mediaType === 'tv' ? 'series' : 'movie'
  };
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function downloadUrl(stream, title, mediaType, dlId) {
  let url = '/api/download?data=' + base64UrlEncode(JSON.stringify(downloadPayload(stream, title, mediaType)));
  if (dlId) url += '&dl=' + encodeURIComponent(dlId);
  return url;
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', '');
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadNow(stream, title, mediaType) {
  triggerDownload(downloadUrl(stream, title, mediaType));
  toast('Download avviato: controlla le notifiche di download del browser');
}

// ---- Barra azioni in basso ----

function renderActionBar(view) {
  const bar = $('#action-bar');
  bar.innerHTML = '';
  let show = false;
  const item = state.item;

  if (view === 'detail' && item) {
    if (item.type === 'movie') {
      show = true;
      bar.appendChild(el('button', {
        class: 'btn btn-yellow', type: 'button',
        onclick: () => addToQueue([{ item }])
      }, '＋ AGGIUNGI ALLA CODA'));
    } else if (state.episodes.length) {
      show = true;
      const sel = state.episodes.filter(e => state.selected.has(e.episodeNumber));
      if (sel.length) {
        bar.appendChild(el('button', {
          class: 'btn', type: 'button',
          onclick: () => { state.selected.clear(); renderEpisodes(); }
        }, 'ANNULLA'));
        bar.appendChild(el('button', {
          class: 'btn btn-yellow', type: 'button',
          onclick: () => addEpisodesToQueue(sel)
        }, `＋ CODA: ${sel.length} ${sel.length === 1 ? 'EPISODIO' : 'EPISODI'}`));
      } else {
        bar.appendChild(el('button', {
          class: 'btn btn-yellow', type: 'button',
          onclick: () => addEpisodesToQueue(state.episodes)
        }, `＋ CODA: TUTTA LA STAGIONE (${state.episodes.length})`));
      }
    }
  }

  bar.hidden = !show;
  document.body.classList.toggle('has-action-bar', show);
}

function addEpisodesToQueue(episodes) {
  const item = state.item;
  addToQueue(episodes.map(ep => ({ item, season: state.season, episode: ep.episodeNumber, epName: ep.name })));
  state.selected.clear();
  renderEpisodes();
}

// ---- Coda ----
//
// Vive nel browser (localStorage): un download alla volta. Per ogni elemento si cercano gli
// stream al momento (i link degli addon scadono), si prende il migliore e lo si fa scaricare
// al browser con un id; il server conta i byte inviati per quell'id (/api/progress) e così
// sappiamo quando è finito e possiamo passare al successivo. Se uno stream fallisce si prova
// il successivo della lista.

const QUEUE_STORAGE = 'nostream.queue.v1';
const POLL_MS = 2000;
// Nessuna richiesta arrivata al server: probabilmente il browser ha bloccato il download.
const START_TIMEOUT_MS = 90 * 1000;
// Nessun byte in più per così tanto (anche dopo un'interruzione non ripresa): bloccato.
const STALL_MS = 10 * 60 * 1000;

const ACTIVE = new Set(['resolving', 'starting', 'downloading', 'interrupted']);

const queue = { items: [], running: false };
let ticking = false;
let wakeLock = null;

function queueKey(type, tmdbId, season, episode) {
  return `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`;
}

function queueItemFor(key) {
  return queue.items.find(i => i.key === key) || null;
}

function streamKey(s) {
  return s.url || s.externalUrl;
}

function loadQueue() {
  const saved = storageGet(QUEUE_STORAGE);
  if (saved && Array.isArray(saved.items)) {
    queue.items = saved.items;
    queue.running = !!saved.running;
  }
  // La ricerca degli stream non sopravvive a un ricaricamento della pagina: si rifà.
  for (const i of queue.items) if (i.status === 'resolving') i.status = 'pending';
}

function saveQueue() {
  storageSet(QUEUE_STORAGE, { items: queue.items, running: queue.running });
}

function addToQueue(entries) {
  let added = 0;
  for (const { item, season, episode, epName, pinned } of entries) {
    const key = queueKey(item.type, item.tmdbId, season, episode);
    const existing = queueItemFor(key);
    if (existing && existing.status !== 'done' && existing.status !== 'error') continue;
    if (existing) queue.items.splice(queue.items.indexOf(existing), 1);
    queue.items.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      key,
      tmdbId: item.tmdbId,
      type: item.type,
      title: fileLabel(item, season, episode),
      subtitle: epName || null,
      season: season ?? null,
      episode: episode ?? null,
      pinned: pinned || null,
      tried: [],
      status: 'pending',
      stream: null,
      sent: 0,
      total: null,
      error: null
    });
    added++;
  }
  if (!added) {
    toast('Già in coda');
    return;
  }
  queue.running = true;
  saveQueue();
  toast(`${added} ${added === 1 ? 'elemento aggiunto' : 'elementi aggiunti'} alla coda`);
  refreshQueueViews();
  acquireWakeLock();
  tick();
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const active = queue.items.find(i => ACTIVE.has(i.status));
    if (active) {
      if (active.status !== 'resolving') await pollItem(active);
    } else if (queue.running) {
      const next = queue.items.find(i => i.status === 'pending');
      if (next) {
        await startItem(next);
      } else {
        queue.running = false;
        saveQueue();
        releaseWakeLock();
        if (queue.items.length) toast('Coda completata');
      }
    }
  } finally {
    ticking = false;
    refreshQueueViews();
  }
}

async function startItem(item) {
  item.status = 'resolving';
  item.error = null;
  saveQueue();
  refreshQueueViews();

  let candidates;
  try {
    const { streams } = await fetchStreams(item.tmdbId, item.type, item.season, item.episode);
    candidates = streams.filter(s => s.supported);
  } catch (err) {
    failItem(item, `Ricerca stream fallita: ${err.message}`);
    return;
  }
  if (!queue.items.includes(item)) return; // rimosso nel frattempo

  // Stream scelto a mano ("+ CODA" su uno stream): va per primo, nella versione appena
  // ricevuta se c'è ancora (link fresco), altrimenti quella salvata.
  if (item.pinned) {
    const key = streamKey(item.pinned);
    const fresh = candidates.find(s => streamKey(s) === key);
    candidates = [fresh || item.pinned, ...candidates.filter(s => streamKey(s) !== key)];
  }
  candidates = candidates.filter(s => !item.tried.includes(streamKey(s)));

  if (!candidates.length) {
    failItem(item, item.tried.length
      ? `Nessuno stream ha funzionato (${item.tried.length} provati). Ultimo errore: ${item.lastError || 'sconosciuto'}`
      : 'Nessuno stream scaricabile trovato');
    return;
  }

  const s = candidates[0];
  item.tried.push(streamKey(s));
  item.stream = {
    title: s.title,
    addon: (s.addonNames || [s.addonName]).join(', '),
    kind: s.kind || null,
    size: s.size || null
  };
  item.dlId = `${item.id}-${item.tried.length}`;
  item.status = 'starting';
  item.sent = 0;
  item.total = s.size || null;
  item.startedAt = Date.now();
  item.lastChange = Date.now();
  saveQueue();
  triggerDownload(downloadUrl(s, item.title, item.type, item.dlId));
}

function failItem(item, message) {
  item.status = 'error';
  item.error = message;
  saveQueue();
}

// Lo stream corrente ha fallito: si riprova lo stesso elemento con lo stream successivo.
function retryWithNext(item, message) {
  item.lastError = message;
  item.status = 'pending';
  saveQueue();
}

async function pollItem(item) {
  let data;
  try {
    data = await api(`/progress?ids=${encodeURIComponent(item.dlId)}`);
  } catch {
    return; // server momentaneamente irraggiungibile: si riprova al prossimo giro
  }
  const p = data[item.dlId];
  const now = Date.now();

  if (!p) {
    if (now - item.startedAt > START_TIMEOUT_MS) {
      failItem(item, 'Il download non è partito: il browser potrebbe averlo bloccato. Consenti i download multipli per questo sito e premi Riprova.');
    }
    return;
  }

  if (p.sent !== item.sent || p.status !== item.status) item.lastChange = now;
  item.sent = p.sent;
  if (p.total) item.total = p.total;

  switch (p.status) {
    case 'starting':
    case 'downloading':
    case 'interrupted':
      item.status = p.status;
      if (now - item.lastChange > STALL_MS) {
        failItem(item, p.status === 'interrupted'
          ? 'Download interrotto e non ripreso dal browser'
          : 'Download bloccato: nessun dato da 10 minuti');
      }
      break;
    case 'done':
      item.status = 'done';
      break;
    case 'external':
      item.status = 'done';
      item.note = 'Scaricato direttamente dalla fonte (avanzamento non visibile)';
      break;
    case 'error':
      retryWithNext(item, p.error);
      break;
  }
  saveQueue();
}

function retryItem(item) {
  item.tried = [];
  item.status = 'pending';
  item.error = null;
  item.lastError = null;
  queue.running = true;
  saveQueue();
  acquireWakeLock();
  refreshQueueViews();
  tick();
}

function removeItem(item) {
  const wasActive = ACTIVE.has(item.status) && item.status !== 'resolving';
  queue.items.splice(queue.items.indexOf(item), 1);
  saveQueue();
  refreshQueueViews();
  if (wasActive) toast('Tolto dalla coda: il download già avviato nel browser continua');
  tick();
}

function moveItem(item, delta) {
  const i = queue.items.indexOf(item);
  const j = i + delta;
  if (j < 0 || j >= queue.items.length) return;
  [queue.items[i], queue.items[j]] = [queue.items[j], queue.items[i]];
  saveQueue();
  renderQueue();
}

function statusLabel(item) {
  switch (item.status) {
    case 'pending': return item.lastError ? 'Riprovo con un altro stream…' : 'In attesa';
    case 'resolving': return 'Cerco lo stream migliore…';
    case 'starting': return item.stream && item.stream.kind === 'hls'
      ? 'Conversione in avvio sul server…'
      : 'Avvio del download…';
    case 'downloading': return 'In download';
    case 'interrupted': return 'Connessione interrotta, in attesa che il browser riprenda…';
    case 'done': return item.note || 'Completato';
    case 'error': return item.error || 'Errore';
    default: return item.status;
  }
}

function queueTag(item) {
  if (item.status === 'done') return el('span', { class: 'tag done' }, 'scaricato');
  if (item.status === 'error') return el('span', { class: 'tag error' }, 'errore');
  if (ACTIVE.has(item.status)) return el('span', { class: 'tag queued' }, 'in download');
  return el('span', { class: 'tag queued' }, 'in coda');
}

function refreshQueueViews() {
  const open = queue.items.filter(i => i.status !== 'done' && i.status !== 'error').length;
  const badge = $('#queue-badge');
  badge.textContent = String(open);
  badge.hidden = open === 0;
  if ($('#view-queue').classList.contains('active')) renderQueue();
  // Etichette "in coda / scaricato" sugli episodi della scheda aperta
  if ($('#view-detail').classList.contains('active') && state.item && state.item.type === 'tv') {
    for (const box of $all('.episode')) {
      const key = queueKey('tv', state.item.tmdbId, state.season, Number(box.dataset.ep));
      const item = queueItemFor(key);
      const main = $('.episode-main', box);
      const old = $('.tag', main);
      const tag = item ? queueTag(item) : null;
      if (old && tag) old.replaceWith(tag);
      else if (old) old.remove();
      else if (tag) main.insertBefore(tag, $('.chevron', main));
    }
  }
}

function renderQueue() {
  const list = $('#queue-list');
  list.innerHTML = '';
  const counts = { active: 0, pending: 0, done: 0, error: 0 };
  for (const i of queue.items) {
    if (ACTIVE.has(i.status)) counts.active++;
    else counts[i.status] = (counts[i.status] || 0) + 1;
  }

  $('#queue-summary').textContent = queue.items.length
    ? [
      counts.active ? `${counts.active} in corso` : null,
      counts.pending ? `${counts.pending} in attesa` : null,
      counts.done ? `${counts.done} completati` : null,
      counts.error ? `${counts.error} con errore` : null
    ].filter(Boolean).join(' · ')
    : 'La coda è vuota. Apri una serie e usa "Coda: tutta la stagione".';

  const toggle = $('#queue-toggle');
  toggle.textContent = queue.running ? '⏸ PAUSA' : '▶ AVVIA';
  toggle.disabled = !queue.running && !queue.items.some(i => i.status === 'pending');

  if (!queue.items.length) {
    list.appendChild(el('div', { class: 'empty' }, 'Niente in coda'));
    return;
  }

  queue.items.forEach((item, index) => {
    const active = ACTIVE.has(item.status);
    const pct = item.total ? Math.min(100, Math.round((item.sent / item.total) * 100)) : null;
    let status = statusLabel(item);
    if (item.status === 'downloading' || item.status === 'interrupted') {
      status += ` · ${formatSize(item.sent) || '0 MB'}${item.total ? ` di ${formatSize(item.total)} (${pct}%)` : ''}`;
    }

    list.appendChild(el('div', { class: 'queue-item' + (active ? ' active' : '') + (item.status === 'done' ? ' done' : '') }, [
      el('div', { class: 'queue-top' }, [
        el('div', { class: 'queue-title' }, [
          item.title,
          item.subtitle ? el('small', {}, item.subtitle) : null,
          item.stream && item.status !== 'pending' ? el('small', {}, `${item.stream.kind === 'hls' ? 'HLS' : 'Diretto'} · ${item.stream.addon}`) : null
        ]),
        el('div', { class: 'queue-actions' }, [
          item.status === 'pending' && index > 0
            ? el('button', { class: 'icon-btn', type: 'button', title: 'Sposta su', onclick: () => moveItem(item, -1) }, '↑')
            : null,
          item.status === 'error'
            ? el('button', { class: 'icon-btn', type: 'button', title: 'Riprova', onclick: () => retryItem(item) }, '↻')
            : null,
          el('button', { class: 'icon-btn', type: 'button', title: 'Togli dalla coda', onclick: () => removeItem(item) }, '✕')
        ])
      ]),
      active && item.status !== 'resolving'
        ? el('div', { class: 'progress' + (pct === null ? ' indeterminate' : '') }, el('div', { style: `width:${pct ?? 0}%` }))
        : null,
      el('div', { class: 'queue-status' + (item.status === 'error' ? ' error' : '') }, status)
    ]));
  });
}

function initQueue() {
  loadQueue();
  $('#queue-toggle').addEventListener('click', () => {
    queue.running = !queue.running;
    saveQueue();
    if (queue.running) {
      acquireWakeLock();
      tick();
    } else {
      releaseWakeLock();
      toast('Coda in pausa: il download già avviato continua, i prossimi aspettano');
    }
    renderQueue();
  });
  $('#queue-clear-done').addEventListener('click', () => {
    queue.items = queue.items.filter(i => i.status !== 'done');
    saveQueue();
    refreshQueueViews();
  });
  $('#queue-clear-all').addEventListener('click', () => {
    if (!queue.items.length) return;
    if (!confirm('Svuotare tutta la coda? I download già avviati nel browser continuano.')) return;
    queue.items = [];
    queue.running = false;
    saveQueue();
    releaseWakeLock();
    refreshQueueViews();
  });

  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (queue.running) acquireWakeLock();
      tick();
    }
  });
  refreshQueueViews();
  if (queue.running) acquireWakeLock();
  tick();
}

// Tiene acceso lo schermo mentre la coda lavora: con lo schermo spento il browser del
// telefono congela la pagina e la coda non passa all'episodio successivo.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ---- Addon ----

async function loadAddons() {
  const container = $('#addon-list');
  try {
    const { addons } = await api('/addons');
    renderAddons(addons);
  } catch (e) {
    container.innerHTML = '';
    toast(e.message, true);
  }
}

function renderAddons(addons) {
  const container = $('#addon-list');
  container.innerHTML = '';
  if (!addons.length) {
    container.appendChild(el('div', { class: 'empty' }, 'Nessun addon configurato'));
    return;
  }
  for (const a of addons) {
    container.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-top' }, [
        el('div', {}, [
          el('div', { class: 'row-title' }, a.name),
          el('div', { class: 'row-meta' }, a.manifestUrl)
        ]),
        el('div', { class: 'row-actions' }, [
          el('button', { class: 'btn btn-danger', onclick: () => deleteAddon(a.id) }, 'RIMUOVI')
        ])
      ])
    ]));
  }
}

function initAddonForm() {
  $('#addon-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#addon-name').value.trim();
    const manifestUrl = $('#addon-url').value.trim();
    if (!name || !manifestUrl) return;
    try {
      await api('/addons', { method: 'POST', body: JSON.stringify({ name, manifestUrl }) });
      $('#addon-name').value = '';
      $('#addon-url').value = '';
      loadAddons();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function deleteAddon(id) {
  try {
    await api(`/addons/${id}`, { method: 'DELETE' });
    loadAddons();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Impostazioni ----

async function loadSettings() {
  try {
    const settings = await api('/settings');
    $('#settings-tmdb-key').value = settings.tmdbApiKey || '';
    $('#settings-language').value = settings.language || 'it-IT';
    $('#settings-concurrent').value = settings.concurrentDownloads || 2;
    $('#settings-addon-timeout').value = Math.round((settings.addonTimeoutMs || 60000) / 1000);
  } catch (e) {
    toast(e.message, true);
  }
}

function initSettingsForm() {
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/settings', {
        method: 'POST',
        body: JSON.stringify({
          tmdbApiKey: $('#settings-tmdb-key').value.trim(),
          language: $('#settings-language').value,
          concurrentDownloads: $('#settings-concurrent').value,
          addonTimeoutMs: parseInt($('#settings-addon-timeout').value, 10) * 1000
        })
      });
      toast('Impostazioni salvate');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function loadVersion() {
  try {
    const settings = await api('/settings');
    $('#app-version').textContent = `v${settings.version || '?'}`;
  } catch {
    $('#app-version').textContent = 'v?';
  }
}

// ---- Init ----

trackTopbarHeight();
initSearch();
initAddonForm();
initSettingsForm();
initQueue();
window.addEventListener('hashchange', route);
route();
loadVersion();
