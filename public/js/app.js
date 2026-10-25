// NoStream v2 — interfaccia web.
// Tre schede (Cerca, Download, Impostazioni), scheda titolo con un tocco per scaricare,
// pannello per scegliere la fonte a mano, coda che lavora nel browser.

// ============================================================ Utilità

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  select: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

function toast(message, isError = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, isError ? 5000 : 3200);
}

window.addEventListener('error', e => { console.error(e.error || e.message); toast(t('error.generic', { msg: e.message }), true); });
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast(t('error.generic', { msg: (e.reason && e.reason.message) || e.reason }), true);
});

async function api(path, options = {}) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...options });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || t('error.http', { status: res.status }));
  return data;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatSize(bytes) {
  if (!bytes) return '';
  const nf = new Intl.NumberFormat(I18N.lang, { maximumFractionDigits: 1 });
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${nf.format(gb)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatDate(iso) {
  try { return new Intl.DateTimeFormat(I18N.lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso; }
}

function storageGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function posterEl(url, alt, cls = 'poster') {
  return el('div', { class: cls }, [alt && !url ? alt : null, url ? el('img', { src: url, alt: '', loading: 'lazy' }) : null]);
}

// ============================================================ Preferenze (per dispositivo)

const PREFS_KEY = 'nostream.prefs';
const PREF_DEFAULTS = {
  theme: 'auto',        // auto | light | dark
  uiLang: '',           // vuoto = lingua del browser
  dest: 'device',       // device | server
  quality: '1080',      // 2160 | 1080 | 720 | any
  audio: 'it',          // it | en | es | fr | de | any
  directFirst: true
};
const prefs = { ...PREF_DEFAULTS, ...(storageGet(PREFS_KEY) || {}) };

function setPref(key, value) {
  prefs[key] = value;
  storageSet(PREFS_KEY, prefs);
  if (key === 'theme') applyTheme();
}

const lightQuery = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const theme = prefs.theme === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : prefs.theme;
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f6f6f4' : '#0f1015');
}
lightQuery.addEventListener('change', () => { if (prefs.theme === 'auto') applyTheme(); });

// ============================================================ Scelta automatica della fonte

function streamText(s) { return `${s.name || ''} ${s.title || ''}`; }

function streamQuality(s) {
  const txt = streamText(s);
  if (/2160p|\b4k\b|\buhd\b/i.test(txt)) return 2160;
  if (/1080p|\bfhd\b/i.test(txt)) return 1080;
  if (/720p|\bhd\b/i.test(txt)) return 720;
  if (/576p|480p|\bsd\b/i.test(txt)) return 480;
  return 0;
}

const LANG_PATTERNS = {
  it: /\bita\b|italian|🇮🇹/i,
  en: /\beng\b|english|🇬🇧|🇺🇸/i,
  es: /\bspa\b|\besp\b|spanish|español|castellano|🇪🇸/i,
  fr: /\bfra\b|\bfre\b|french|français|vf\b|🇫🇷/i,
  de: /\bger\b|\bdeu\b|german|deutsch|🇩🇪/i
};

function streamLangs(s) {
  const txt = streamText(s);
  return Object.keys(LANG_PATTERNS).filter(l => LANG_PATTERNS[l].test(txt));
}

// Ordina gli stream scaricabili secondo le preferenze: lingua audio, poi file diretti,
// poi qualità più vicina a quella scelta. A parità resta l'ordine del server (che mette
// già davanti i diretti con dimensione nota).
function sortByPrefs(streams) {
  const wantQ = prefs.quality === 'any' ? null : Number(prefs.quality);
  const score = s => {
    let v = 0;
    if (prefs.audio !== 'any' && streamLangs(s).includes(prefs.audio)) v += 4000;
    if (prefs.directFirst && s.kind === 'direct') v += 2000;
    const q = streamQuality(s);
    if (q) {
      if (wantQ === null) v += q / 10;
      else if (q === wantQ) v += 1000;
      else if (q < wantQ) v += 800 - (wantQ - q) / 10;  // meglio un po' sotto che enormemente sopra
      else v += 600 - (q - wantQ) / 10;
    }
    if (s.kind === 'direct' && s.size) v += 50;
    return v;
  };
  return streams
    .map((s, i) => ({ s, i, v: score(s) }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .map(x => x.s);
}

function qualityLabel(s) {
  const q = streamQuality(s);
  return q === 2160 ? '4K' : q ? `${q}p` : '—';
}

// ============================================================ Stato e navigazione

const state = {
  query: '',
  results: null,       // null = nessuna ricerca fatta
  item: storageGet('nostream.item'),
  seasons: [],
  season: null,
  episodes: [],
  selecting: false,
  selected: new Set(),
  streamCache: new Map(),
  settings: null,      // impostazioni del server (/api/settings)
  addons: null
};

const ROUTES = {
  '': 'search',
  '#titolo': 'detail',
  '#download': 'downloads',
  '#impostazioni': 'settings',
  '#impostazioni/addon': 'settings',
  '#impostazioni/nuvio': 'settings',
  '#impostazioni/tmdb': 'settings',
  '#impostazioni/avanzate': 'settings',
  '#benvenuto': 'welcome'
};

function currentView() { return ROUTES[location.hash] || 'search'; }

function route() {
  let view = currentView();
  if (view === 'detail' && !state.item) { location.replace('#'); return; }
  $all('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $all('#tabbar a').forEach(a => a.classList.toggle('active',
    a.dataset.tab === view || (view === 'detail' && a.dataset.tab === 'search')));
  $('#tabbar').hidden = view === 'welcome';
  closeSheet();
  if (view !== 'detail') exitSelection(false);
  window.scrollTo(0, 0);
  if (view === 'search') renderSearch();
  if (view === 'detail') renderDetail();
  if (view === 'downloads') { renderDownloads(); refreshServerFiles(); }
  if (view === 'settings') renderSettings(location.hash.split('/')[1] || '');
  if (view === 'welcome') renderWelcome();
  updateSelbar();
}

function go(hash) {
  if (location.hash === hash || (!location.hash && hash === '')) route();
  else location.hash = hash;
}

// ============================================================ Cerca

const RECENT_KEY = 'nostream.recent';

function rememberRecent(item) {
  const list = (storageGet(RECENT_KEY) || []).filter(r => !(r.tmdbId === item.tmdbId && r.type === item.type));
  list.unshift(item);
  storageSet(RECENT_KEY, list.slice(0, 15));
}

function typeLabel(item) { return item.type === 'tv' ? t('kind.tv') : t('kind.movie'); }

function posterCard(item, meta) {
  return el('button', { class: 'poster-card', type: 'button', onclick: () => openDetail(item) }, [
    posterEl(item.posterUrl, item.title),
    el('div', { class: 'pt' }, item.title),
    el('div', { class: 'pm' }, meta || [typeLabel(item), item.year].filter(Boolean).join(' · '))
  ]);
}

function renderSearch() {
  const view = $('#view-search');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'appbar' }, [
    el('a', { class: 'logo', href: '#', onclick: e => { e.preventDefault(); state.results = null; state.query = ''; renderSearch(); } },
      [el('img', { src: '/logo.svg', alt: '' }), 'NoStream'])
  ]));

  const input = el('input', {
    type: 'search', id: 'search-input', placeholder: t('search.placeholder'),
    autocomplete: 'off', enterkeyhint: 'search', 'aria-label': t('search.placeholder')
  });
  input.value = state.query;
  const form = el('form', { class: 'search', role: 'search', onsubmit: e => { e.preventDefault(); runSearch(input.value); } }, [
    icon('search'), input,
    state.query ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': t('search.clear'),
      onclick: () => { state.query = ''; state.results = null; renderSearch(); $('#search-input').focus(); } }, icon('x')) : null
  ]);
  view.appendChild(form);

  const body = el('div', { id: 'search-body' });
  view.appendChild(body);

  if (state.settings && !state.settings.tmdbApiKey) {
    body.appendChild(el('div', { class: 'empty' }, [
      el('b', {}, t('search.setupTitle')), t('search.setupText'),
      el('div', {}, el('a', { class: 'btn primary', href: '#benvenuto' }, t('search.setupBtn')))
    ]));
    return;
  }

  if (state.results === 'loading') {
    body.appendChild(el('div', { class: 'empty' }, t('search.loading')));
    return;
  }
  if (Array.isArray(state.results)) {
    if (!state.results.length) {
      body.appendChild(el('div', { class: 'empty' }, [el('b', {}, t('search.noResults')), t('search.noResultsHint')]));
      return;
    }
    body.appendChild(el('div', { class: 'results' }, state.results.map(item => posterCard(item))));
    return;
  }

  // Pagina iniziale: download in corso, titoli recenti, file pronti sul server
  body.appendChild(el('div', { id: 'home-active' }));
  renderHomeActive();
  const recent = storageGet(RECENT_KEY) || [];
  if (recent.length) {
    body.appendChild(el('div', { class: 'sec' }, [t('home.recent'),
      el('button', { class: 'link-btn', type: 'button', onclick: () => { storageSet(RECENT_KEY, []); renderSearch(); } }, t('home.clearRecent'))]));
    body.appendChild(el('div', { class: 'shelf' }, recent.map(item => posterCard(item))));
  }
  body.appendChild(el('div', { id: 'home-ready' }));
  renderHomeReady();
  if (!recent.length && !serverFiles.length && !queue.items.length) {
    body.appendChild(el('div', { class: 'empty' }, [el('b', {}, t('home.emptyTitle')), t('home.emptyText')]));
  }
}

// Il server non conosce le locandine: le cerchiamo tra download e titoli recenti con lo
// stesso nome (il titolo del file è «Titolo S01E02» o «Titolo (2024)»).
function serverFilePoster(f) {
  const title = f.title || '';
  const q = queue.items.find(i => i.title === title && i.posterUrl);
  if (q) return q.posterUrl;
  const r = (storageGet(RECENT_KEY) || []).find(i => i.posterUrl && title.startsWith(i.title));
  return r ? r.posterUrl : null;
}

function renderHomeReady() {
  const box = $('#home-ready');
  if (!box) return;
  box.innerHTML = '';
  const ready = serverFiles.filter(f => f.status === 'done');
  if (!ready.length) return;
  box.appendChild(el('div', { class: 'sec' }, [t('home.readyOnServer'), el('a', { class: 'link-btn', href: '#download' }, t('home.all'))]));
  box.appendChild(el('div', { class: 'shelf' }, ready.map(f => el('a', { class: 'poster-card', href: f.path, download: '', title: t('common.download') }, [
    posterEl(serverFilePoster(f), f.title || f.filename),
    el('div', { class: 'pt' }, f.title || f.filename),
    el('div', { class: 'pm' }, [formatSize(f.size), t('common.download')].filter(Boolean).join(' · '))
  ]))));
}

function renderHomeActive() {
  const box = $('#home-active');
  if (!box) return;
  box.innerHTML = '';
  const active = queue.items.find(i => ACTIVE.has(i.status));
  if (!active) return;
  const waiting = queue.items.filter(i => i.status === 'pending').length;
  const card = el('a', { class: 'card', href: '#download', style: 'display:block;margin-top:14px;text-decoration:none;color:inherit' },
    el('div', { class: 'row', style: 'border:0;padding:0' }, [
      el('div', { class: 'thumb' }, active.posterUrl ? el('img', { src: active.posterUrl, alt: '' }) : null),
      el('div', { class: 'tx' }, [
        el('b', {}, active.title),
        el('span', {}, [progressText(active), waiting ? ` · ${t('home.moreQueued', { n: waiting })}` : ''].join('')),
        progressBar(active)
      ])
    ]));
  box.appendChild(card);
}

async function runSearch(raw) {
  const query = raw.trim();
  if (!query) return;
  state.query = query;
  state.results = 'loading';
  renderSearch();
  $('#search-input').blur();
  try {
    const { results } = await api(`/search?query=${encodeURIComponent(query)}`);
    if (state.query !== query) return;
    state.results = results;
  } catch (err) {
    state.results = null;
    toast(err.message, true);
  }
  if (currentView() === 'search') renderSearch();
}

// ============================================================ Scheda titolo

function fileLabel(item, season, episode) {
  return item.type === 'movie'
    ? `${item.title}${item.year ? ` (${item.year})` : ''}`
    : `${item.title} S${pad(season)}E${pad(episode)}`;
}

function openDetail(item) {
  const changed = !state.item || state.item.tmdbId !== item.tmdbId || state.item.type !== item.type;
  state.item = item;
  storageSet('nostream.item', item);
  rememberRecent(item);
  if (changed) {
    state.seasons = [];
    state.season = null;
    state.episodes = [];
    state.streamCache.clear();
  }
  go('#titolo');
}

function renderDetail() {
  const item = state.item;
  const view = $('#view-detail');
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'appbar' }, [
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.back'),
      onclick: () => (history.length > 1 ? history.back() : go('')) }, icon('back')),
    el('div', { class: 'ttl' }, '')
  ]));

  const overview = el('p', { class: 'overview', onclick: () => overview.classList.toggle('open') }, item.overview || t('detail.noOverview'));
  view.appendChild(el('div', { class: 'hero' }, [
    posterEl(item.posterUrl, item.title),
    el('div', { style: 'min-width:0' }, [
      el('h2', {}, item.title),
      el('div', { class: 'meta' }, [item.year, typeLabel(item),
        item.type === 'tv' && state.seasons.length ? t('detail.seasons', { n: state.seasons.filter(s => s.seasonNumber > 0).length }) : null
      ].filter(Boolean).join(' · ')),
      overview
    ])
  ]));

  if (item.type === 'movie') {
    view.appendChild(el('div', { id: 'movie-actions' }));
    renderMovieActions();
    return;
  }

  view.appendChild(el('div', { id: 'season-actions' }));
  view.appendChild(el('div', { class: 'tabs', id: 'season-tabs' }));
  view.appendChild(el('div', { id: 'episode-list' }));
  if (state.seasons.length) {
    renderSeasonTabs();
    renderEpisodes();
  } else {
    loadSeasons(item);
  }
}

// ---- Film

function renderMovieActions() {
  const box = $('#movie-actions');
  if (!box) return;
  const item = state.item;
  const q = queueItemFor(queueKey('movie', item.tmdbId));
  box.innerHTML = '';
  const busy = q && (q.status === 'pending' || ACTIVE.has(q.status));
  box.appendChild(el('div', { class: 'btn-row' }, [
    busy
      ? el('a', { class: 'btn', href: '#download' }, [icon('clock'), t('detail.inQueue')])
      : el('button', { class: 'btn primary', type: 'button', onclick: () => enqueue([{ item }]) },
        [icon('download'), q && q.status === 'done' ? t('detail.downloadAgain') : t('detail.downloadMovie')]),
    el('button', { class: 'btn', type: 'button', onclick: () => openSourceSheet({}) }, t('detail.chooseSource'))
  ]));
  box.appendChild(el('div', { class: 'status-line' }, q ? itemStatusText(q) : ''));
  if (q && ACTIVE.has(q.status)) box.appendChild(progressBar(q));
}

// ---- Serie

async function loadSeasons(item) {
  $('#episode-list').appendChild(el('div', { class: 'empty' }, t('detail.loadingSeasons')));
  try {
    const { seasons } = await api(`/seasons/${item.tmdbId}`);
    if (state.item !== item) return;
    state.seasons = seasons;
    const first = seasons.find(s => s.seasonNumber > 0) || seasons[0];
    if (currentView() === 'detail') renderDetail();
    if (first) selectSeason(first.seasonNumber);
  } catch (err) {
    $('#episode-list').innerHTML = '';
    toast(err.message, true);
  }
}

function renderSeasonTabs() {
  const bar = $('#season-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  // Gli speciali (stagione 0) in fondo, come fanno Stremio e Nuvio
  const ordered = [...state.seasons.filter(s => s.seasonNumber > 0), ...state.seasons.filter(s => s.seasonNumber === 0)];
  for (const s of ordered) {
    bar.appendChild(el('button', {
      type: 'button', class: 'tab' + (s.seasonNumber === state.season ? ' active' : ''),
      onclick: () => selectSeason(s.seasonNumber)
    }, s.seasonNumber === 0 ? t('detail.specials') : t('detail.season', { n: s.seasonNumber })));
  }
  const active = $('.tab.active', bar);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

async function selectSeason(number) {
  const item = state.item;
  if (state.season === number && state.episodes.length) return;
  state.season = number;
  state.episodes = [];
  exitSelection(false);
  renderSeasonTabs();
  renderSeasonActions();
  const list = $('#episode-list');
  list.innerHTML = '';
  list.appendChild(el('div', { class: 'empty' }, t('detail.loadingEpisodes')));
  try {
    const { episodes } = await api(`/episodes/${item.tmdbId}/${number}`);
    if (state.item !== item || state.season !== number) return;
    state.episodes = episodes;
    renderEpisodes();
  } catch (err) {
    list.innerHTML = '';
    toast(err.message, true);
  }
}

function episodeAired(ep) {
  const date = ep.airDate ? new Date(ep.airDate) : null;
  return !date || isNaN(date) || date <= new Date();
}

function episodeQueueItem(ep) {
  return queueItemFor(queueKey('tv', state.item.tmdbId, state.season, ep.episodeNumber));
}

// Episodi della stagione ancora da scaricare (non in coda, non già scaricati, già usciti).
function episodesToDownload() {
  return state.episodes.filter(ep => {
    const q = episodeQueueItem(ep);
    return episodeAired(ep) && (!q || q.status === 'error');
  });
}

function renderSeasonActions() {
  const box = $('#season-actions');
  if (!box) return;
  box.innerHTML = '';
  if (state.season === null || state.selecting) return;
  const todo = state.episodes.length ? episodesToDownload() : [];
  const label = !state.episodes.length
    ? t('detail.downloadSeason', { n: state.season })
    : todo.length === 0
      ? t('detail.seasonAllQueued')
      : todo.length === state.episodes.filter(episodeAired).length
        ? t('detail.downloadSeason', { n: state.season })
        : t('detail.downloadSeasonMissing', { s: state.season, n: todo.length });
  box.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn primary', type: 'button', disabled: !todo.length,
      onclick: () => enqueueEpisodes(todo) }, [icon('download'), label]),
    el('button', { class: 'btn square', type: 'button', title: t('detail.selectEpisodes'), 'aria-label': t('detail.selectEpisodes'),
      disabled: !state.episodes.length, onclick: () => enterSelection() }, icon('select'))
  ]));
}

function renderEpisodes() {
  const list = $('#episode-list');
  if (!list) return;
  list.innerHTML = '';
  renderSeasonActions();
  if (!state.episodes.length) {
    list.appendChild(el('div', { class: 'empty' }, t('detail.noEpisodes')));
    return;
  }
  for (const ep of state.episodes) list.appendChild(episodeRow(ep));
}

// Aggiorna solo le righe cambiate (la coda chiama questa funzione ogni 2 secondi).
function refreshEpisodeRows() {
  if (currentView() !== 'detail' || !state.item) return;
  if (state.item.type === 'movie') { renderMovieActions(); return; }
  for (const row of $all('#episode-list .row')) {
    const ep = state.episodes.find(e => e.episodeNumber === Number(row.dataset.ep));
    if (!ep) continue;
    const fresh = episodeRow(ep);
    if (fresh.dataset.sig !== row.dataset.sig) row.replaceWith(fresh);
  }
  renderSeasonActions();
}

function episodeSub(ep, q) {
  if (q) return itemStatusText(q);
  if (!episodeAired(ep)) return t('detail.airsOn', { date: formatDate(ep.airDate) });
  return [ep.runtime ? t('detail.minutes', { n: ep.runtime }) : null, ep.airDate ? formatDate(ep.airDate) : null].filter(Boolean).join(' · ');
}

function episodeRow(ep) {
  const n = ep.episodeNumber;
  const q = episodeQueueItem(ep);
  const aired = episodeAired(ep);
  const sub = episodeSub(ep, q);

  if (state.selecting) {
    const selectable = aired && (!q || q.status === 'error' || q.status === 'done');
    const on = state.selected.has(n);
    return el('button', {
      class: 'row tap' + (selectable ? '' : ' disabled'), type: 'button', 'data-ep': n, 'data-sig': `s${on}${selectable}`,
      disabled: !selectable, onclick: () => toggleSelected(n)
    }, [
      el('span', { class: 'cb' + (on ? ' on' : '') }, icon('check')),
      el('span', { class: 'tx' }, [el('b', {}, ep.name || t('detail.episode', { n })), el('span', {}, sub)])
    ]);
  }

  const sig = q ? `${q.status}|${progressPct(q)}|${sub}` : `none|${aired}`;
  return el('div', { class: 'row', 'data-ep': n, 'data-sig': sig }, [
    el('button', { class: 'main tap', type: 'button', disabled: !aired,
      onclick: () => openSourceSheet({ season: state.season, episode: n, epName: ep.name }) }, [
      el('span', { class: 'n' }, n),
      el('span', { class: 'tx' }, [
        el('b', {}, ep.name || t('detail.episode', { n })),
        el('span', { class: q && q.status === 'error' ? 'err' : '' }, sub)
      ])
    ]),
    aired ? statusButton(q, () => enqueueEpisodes([ep]), () => openSourceSheet({ season: state.season, episode: n, epName: ep.name })) : null
  ]);
}

// Pulsante rotondo di stato: ↓ (scarica) / in coda / anello di avanzamento / ✓ / errore.
function statusButton(q, onDownload, onOpen) {
  if (!q) {
    return el('button', { class: 'dl', type: 'button', 'aria-label': t('common.download'), onclick: onDownload }, icon('arrowDown'));
  }
  if (q.status === 'done') {
    return el('button', { class: 'dl done', type: 'button', 'aria-label': t('status.done'), onclick: onOpen }, icon('check'));
  }
  if (q.status === 'error') {
    return el('button', { class: 'dl err', type: 'button', 'aria-label': t('common.retry'), onclick: () => retryItem(q) }, icon('retry'));
  }
  if (q.status === 'pending') {
    return el('a', { class: 'dl queued', href: '#download', 'aria-label': t('status.pending') }, icon('clock'));
  }
  const pct = progressPct(q);
  return el('a', { class: 'dl prog' + (pct === null ? ' spin' : ''), href: '#download', style: `--p:${pct || 0}%`, 'aria-label': progressText(q) },
    pct === null ? el('small', {}, '') : el('small', {}, `${pct}%`));
}

// ---- Selezione di più episodi

function enterSelection() {
  state.selecting = true;
  state.selected.clear();
  renderEpisodes();
  renderSelectionHeader();
  updateSelbar();
}

function exitSelection(rerender = true) {
  if (!state.selecting) return;
  state.selecting = false;
  state.selected.clear();
  if (rerender && currentView() === 'detail') renderDetail();
  updateSelbar();
}

function toggleSelected(n) {
  if (state.selected.has(n)) state.selected.delete(n);
  else state.selected.add(n);
  refreshSelection();
}

function refreshSelection() {
  renderEpisodes();
  renderSelectionHeader();
  updateSelbar();
}

function renderSelectionHeader() {
  const bar = $('#view-detail .appbar');
  if (!bar || !state.selecting) return;
  bar.innerHTML = '';
  const selectable = state.episodes.filter(ep => {
    const q = episodeQueueItem(ep);
    return episodeAired(ep) && (!q || q.status === 'error' || q.status === 'done');
  });
  const allOn = selectable.length && selectable.every(ep => state.selected.has(ep.episodeNumber));
  bar.appendChild(el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.cancel'), onclick: () => exitSelection() }, icon('x')));
  bar.appendChild(el('div', { class: 'ttl' }, t('select.count', { n: state.selected.size })));
  bar.appendChild(el('button', { class: 'btn sm', type: 'button', onclick: () => {
    state.selected = allOn ? new Set() : new Set(selectable.map(ep => ep.episodeNumber));
    refreshSelection();
  } }, allOn ? t('select.none') : t('select.all')));
}

function updateSelbar() {
  const bar = $('#selbar');
  const show = state.selecting && currentView() === 'detail';
  bar.hidden = !show;
  document.body.classList.toggle('has-selbar', show);
  if (!show) return;
  bar.innerHTML = '';
  const n = state.selected.size;
  bar.appendChild(el('button', { class: 'btn primary', type: 'button', disabled: !n, onclick: () => {
    const eps = state.episodes.filter(ep => state.selected.has(ep.episodeNumber));
    exitSelection(false);
    enqueueEpisodes(eps, { force: true });
    renderDetail();
  } }, [icon('download'), n ? t('select.download', { n }) : t('select.hint')]));
}

// ============================================================ Pannello «Scegli fonte»

async function fetchStreams(tmdbId, type, season, episode) {
  const params = new URLSearchParams({ tmdbId, type });
  if (season !== undefined && season !== null) params.set('season', season);
  if (episode !== undefined && episode !== null) params.set('episode', episode);
  const data = await api(`/streams?${params.toString()}`);
  for (const s of data.streams || []) s.vid = data.stremioId;  // serve a riconoscere i file già preparati
  return data;
}

function closeSheet() { $('#sheet-root').innerHTML = ''; }

function openSheet(build) {
  const root = $('#sheet-root');
  root.innerHTML = '';
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'grab' }));
  root.appendChild(el('div', { class: 'sheet-wrap' }, [el('div', { class: 'sheet-scrim', onclick: closeSheet }), sheet]));
  build(sheet);
  return sheet;
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

async function openSourceSheet({ season, episode, epName }) {
  const item = state.item;
  const isTv = item.type === 'tv';
  const sheet = openSheet(s => {
    s.appendChild(el('div', { class: 'kicker' }, isTv ? `S${season} · E${pad(episode)}` : item.title));
    s.appendChild(el('h3', {}, isTv ? (epName || t('detail.episode', { n: episode })) : t('sheet.chooseSource')));
    s.appendChild(el('div', { class: 'sheet-body' }, el('div', { class: 'empty' },
      t('sheet.searching', { n: (state.addons && state.addons.length) || '…' }))));
  });
  const body = $('.sheet-body', sheet);
  const cacheKey = `${item.tmdbId}:${season ?? ''}:${episode ?? ''}`;
  let data = state.streamCache.get(cacheKey);
  try {
    if (!data) {
      data = await fetchStreams(item.tmdbId, item.type, season, episode);
      state.streamCache.set(cacheKey, data);
    }
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'note err' }, [icon('alert'), el('span', {}, err.message)]));
    return;
  }
  if (!sheet.isConnected) return;
  renderSourceSheet(body, data, { item, season, episode, epName });
}

function renderSourceSheet(body, data, ctx) {
  body.innerHTML = '';
  const supported = sortByPrefs(data.streams.filter(s => s.supported));
  const unsupported = data.streams.filter(s => !s.supported).length;

  for (const e of data.errors || []) {
    body.appendChild(el('div', { class: 'note' }, [icon('info'), el('span', {}, t('sheet.addonError', { name: e.addonName, error: e.error }))]));
  }
  if (!supported.length) {
    body.appendChild(el('div', { class: 'empty' }, [el('b', {}, t('sheet.noStreams')),
      unsupported ? t('sheet.onlyUnsupported', { n: unsupported }) : t('sheet.noStreamsHint')]));
    return;
  }

  const best = supported[0];
  let dest = best.kind === 'direct' ? prefs.dest : 'device';
  const segBox = el('div');
  const renderSeg = s => {
    segBox.innerHTML = '';
    const canServer = s.kind === 'direct';
    if (!canServer) dest = 'device';
    segBox.appendChild(el('div', { class: 'seg' }, [
      el('button', { type: 'button', class: dest === 'device' ? 'on' : '', onclick: () => { dest = 'device'; renderSeg(s); } }, t('dest.device')),
      el('button', { type: 'button', class: dest === 'server' ? 'on' : '', disabled: !canServer, onclick: () => { dest = 'server'; renderSeg(s); } }, t('dest.server'))
    ]));
    if (!canServer) segBox.appendChild(el('div', { class: 'meta' }, t('sheet.hlsDeviceOnly')));
  };
  renderSeg(best);

  const done = s => {
    closeSheet();
    enqueue([{ item: ctx.item, season: ctx.season, episode: ctx.episode, epName: ctx.epName, pinned: s, dest, force: true }]);
  };

  body.appendChild(el('div', { class: 'best' }, [
    el('div', { class: 'chips' }, [el('span', { class: 'chip acc' }, t('sheet.auto')), kindChip(best), preparedChip(best.prepared)]),
    el('div', { class: 'what' }, streamSummary(best)),
    el('div', { class: 'meta' }, (best.addonNames || [best.addonName]).join(', ')),
    segBox,
    el('button', { class: 'btn primary block', type: 'button', style: 'margin-top:10px', onclick: () => done(best) },
      [icon('download'), t('common.download')])
  ]));

  if (supported.length > 1) {
    body.appendChild(el('div', { class: 'sec' }, t('sheet.otherSources', { n: supported.length - 1 })));
    for (const s of supported.slice(1)) {
      body.appendChild(el('button', { class: 'src tap', type: 'button', onclick: () => { dest = s.kind === 'direct' ? prefs.dest : 'device'; done(s); } }, [
        el('span', { class: 'q' }, qualityLabel(s)),
        el('span', { class: 'tx' }, [
          el('div', {}, s.title.split('\n')[0]),
          el('small', {}, [s.kind === 'hls' ? t('kind.hls') : t('kind.direct'), formatSize(s.size), (s.addonNames || [s.addonName]).join(', ')].filter(Boolean).join(' · '))
        ]),
        el('span', { class: 'dl sm' }, icon('arrowDown'))
      ]));
    }
  }
  if (unsupported) body.appendChild(el('div', { class: 'meta', style: 'text-align:center;margin-top:10px' }, t('sheet.hiddenUnsupported', { n: unsupported })));
}

function streamSummary(s) {
  return [s.title.replace(/\s*\n\s*/g, ' · '), formatSize(s.size)].filter(Boolean).join(' · ');
}

function kindChip(s) {
  return s.kind === 'hls' ? el('span', { class: 'chip warn' }, t('kind.hls')) : el('span', { class: 'chip ok' }, t('kind.direct'));
}

function preparedChip(p) {
  if (!p || p.status === 'failed') return null;
  if (p.status === 'done') return el('span', { class: 'chip ok' }, t('server.ready'));
  return el('span', { class: 'chip' }, t('server.preparingPct', { pct: p.size ? Math.floor((p.written / p.size) * 100) : 0 }));
}

// ============================================================ Coda
//
// Vive nel browser (localStorage): un elemento alla volta. Per ognuno si cercano gli
// stream al momento (i link degli addon scadono), si ordinano secondo le preferenze e si
// prova il primo; se fallisce si passa al successivo.
// - destinazione «dispositivo»: il browser scarica con un id e il server conta i byte
//   inviati (/api/progress), così sappiamo quando ha finito;
// - destinazione «prima sul server» (solo file diretti): il server scarica il file sul
//   proprio disco (/api/prepared), poi il browser lo prende da lì in pochi secondi.

const QUEUE_STORAGE = 'nostream.queue.v1';
const POLL_MS = 2000;
const START_TIMEOUT_MS = 90 * 1000;   // nessuna richiesta arrivata: il browser ha bloccato il download
const STALL_MS = 10 * 60 * 1000;      // nessun byte in più per 10 minuti: bloccato

const ACTIVE = new Set(['resolving', 'starting', 'downloading', 'interrupted', 'preparing']);
const queue = { items: [], running: false };
let ticking = false;
let wakeLock = null;

function queueKey(type, tmdbId, season, episode) { return `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`; }
function queueItemFor(key) { return queue.items.find(i => i.key === key) || null; }
function streamKey(s) { return s.url || s.externalUrl; }

function loadQueue() {
  const saved = storageGet(QUEUE_STORAGE);
  if (saved && Array.isArray(saved.items)) {
    queue.items = saved.items;
    queue.running = !!saved.running;
  }
  for (const i of queue.items) if (i.status === 'resolving') i.status = 'pending';
}

function saveQueue() { storageSet(QUEUE_STORAGE, { items: queue.items, running: queue.running }); }

function enqueueEpisodes(episodes, opts = {}) {
  enqueue(episodes.map(ep => ({ item: state.item, season: state.season, episode: ep.episodeNumber, epName: ep.name, force: opts.force })));
}

function enqueue(entries) {
  let added = 0;
  for (const { item, season, episode, epName, pinned, dest, force } of entries) {
    const key = queueKey(item.type, item.tmdbId, season, episode);
    const existing = queueItemFor(key);
    if (existing && existing.status !== 'error' && !(force && existing.status === 'done')) continue;
    if (existing) queue.items.splice(queue.items.indexOf(existing), 1);
    queue.items.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      key,
      tmdbId: item.tmdbId,
      type: item.type,
      title: fileLabel(item, season, episode),
      subtitle: epName || null,
      posterUrl: item.posterUrl || null,
      season: season ?? null,
      episode: episode ?? null,
      pinned: pinned || null,
      dest: dest || prefs.dest,
      tried: [],
      status: 'pending',
      stream: null,
      sent: 0,
      total: null,
      error: null
    });
    added++;
  }
  if (!added) { toast(t('queue.already')); return; }
  queue.running = true;
  saveQueue();
  toast(t('queue.added', { n: added }));
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
      if (active.status === 'preparing') await pollPrepared(active);
      else if (active.status !== 'resolving') await pollItem(active);
    } else if (queue.running) {
      const next = queue.items.find(i => i.status === 'pending');
      if (next) await startItem(next);
      else {
        queue.running = false;
        saveQueue();
        releaseWakeLock();
        if (queue.items.some(i => i.status === 'done')) toast(t('queue.finished'));
      }
    }
  } finally {
    ticking = false;
    refreshQueueViews();
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
    vid: stream.vid,
    mediaType: mediaType === 'tv' ? 'series' : 'movie'
  };
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

async function startItem(item) {
  item.status = 'resolving';
  item.error = null;
  saveQueue();
  refreshQueueViews();

  let candidates;
  try {
    const data = await fetchStreams(item.tmdbId, item.type, item.season, item.episode);
    candidates = sortByPrefs(data.streams.filter(s => s.supported));
  } catch (err) {
    failItem(item, t('queue.searchFailed', { msg: err.message }));
    return;
  }
  if (!queue.items.includes(item)) return;  // tolto nel frattempo

  // Fonte scelta a mano: va per prima, nella versione appena ricevuta se c'è ancora.
  if (item.pinned) {
    const key = streamKey(item.pinned);
    const fresh = candidates.find(s => streamKey(s) === key);
    candidates = [fresh || item.pinned, ...candidates.filter(s => streamKey(s) !== key)];
  }
  candidates = candidates.filter(s => !item.tried.includes(streamKey(s)));
  if (!candidates.length) {
    failItem(item, item.tried.length
      ? t('queue.allFailed', { n: item.tried.length, msg: item.lastError || '?' })
      : t('queue.noStreams'));
    return;
  }

  const s = candidates[0];
  item.tried.push(streamKey(s));
  item.stream = { title: s.title, addon: (s.addonNames || [s.addonName]).join(', '), kind: s.kind || null, size: s.size || null, quality: streamQuality(s) ? qualityLabel(s) : null };
  item.sent = 0;
  item.total = s.size || null;
  item.startedAt = Date.now();
  item.lastChange = Date.now();

  // Già pronto sul server (o la destinazione è il server): si passa da lì.
  const viaServer = s.kind === 'direct' && (item.dest === 'server' || (s.prepared && s.prepared.status === 'done'));
  if (viaServer) {
    try {
      const { item: job } = await api('/prepared', {
        method: 'POST',
        body: JSON.stringify({ data: base64UrlEncode(JSON.stringify(downloadPayload(s, item.title, item.type))) })
      });
      item.prepKey = job.key;
      item.status = 'preparing';
      saveQueue();
      refreshServerFiles();
      return;
    } catch (err) {
      retryWithNext(item, err.message);
      return;
    }
  }

  item.dlId = `${item.id}-${item.tried.length}`;
  item.status = 'starting';
  saveQueue();
  triggerDownload(downloadUrl(s, item.title, item.type, item.dlId));
}

function failItem(item, message) {
  item.status = 'error';
  item.error = message;
  saveQueue();
}

function retryWithNext(item, message) {
  item.lastError = message;
  item.status = 'pending';
  saveQueue();
}

async function pollItem(item) {
  let data;
  try { data = await api(`/progress?ids=${encodeURIComponent(item.dlId)}`); }
  catch { return; }  // server momentaneamente irraggiungibile
  const p = data[item.dlId];
  const now = Date.now();
  if (!p) {
    if (now - item.startedAt > START_TIMEOUT_MS) failItem(item, t('queue.blocked'));
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
      if (now - item.lastChange > STALL_MS) failItem(item, p.status === 'interrupted' ? t('queue.notResumed') : t('queue.stalled'));
      break;
    case 'done':
      item.status = 'done';
      break;
    case 'external':
      item.status = 'done';
      item.note = 'external';
      break;
    case 'error':
      retryWithNext(item, p.error);
      break;
  }
  saveQueue();
}

async function pollPrepared(item) {
  await refreshServerFiles();
  const job = serverFiles.find(f => f.key === item.prepKey);
  if (!job) { retryWithNext(item, t('queue.serverGone')); return; }
  item.sent = job.written || 0;
  if (job.size) item.total = job.size;
  if (job.status === 'done') {
    item.status = 'done';
    item.note = 'server';
    triggerDownload(job.path);
  } else if (job.status === 'failed') {
    retryWithNext(item, job.error || t('queue.serverFailed'));
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
  const wasActive = ACTIVE.has(item.status) && item.status !== 'resolving' && item.status !== 'preparing';
  queue.items.splice(queue.items.indexOf(item), 1);
  saveQueue();
  refreshQueueViews();
  if (wasActive) toast(t('queue.removedActive'));
  tick();
}

function moveUp(item) {
  const pending = queue.items.filter(i => i.status === 'pending');
  const idx = pending.indexOf(item);
  if (idx <= 0) return;
  const a = queue.items.indexOf(item);
  const b = queue.items.indexOf(pending[idx - 1]);
  [queue.items[a], queue.items[b]] = [queue.items[b], queue.items[a]];
  saveQueue();
  renderDownloads();
}

function progressPct(item) {
  if (!ACTIVE.has(item.status) || !item.total) return null;
  return Math.min(100, Math.round((item.sent / item.total) * 100));
}

function progressBar(item) {
  const pct = progressPct(item);
  return el('div', { class: 'bar' + (pct === null ? ' indeterminate' : '') }, el('i', { style: `width:${pct || 0}%` }));
}

function progressText(item) {
  const of = item.total ? t('progress.of', { sent: formatSize(item.sent) || '0 MB', total: formatSize(item.total) }) : formatSize(item.sent);
  switch (item.status) {
    case 'resolving': return t('status.resolving');
    case 'starting': return item.stream && item.stream.kind === 'hls' ? t('status.startingHls') : t('status.starting');
    case 'downloading': return item.sent ? t('status.downloadingOf', { of }) : t('status.downloading');
    case 'interrupted': return t('status.interrupted', { of: of || '0 MB' });
    case 'preparing': return item.sent ? t('status.preparingOf', { of }) : t('status.preparing');
    default: return '';
  }
}

function itemStatusText(item) {
  switch (item.status) {
    case 'pending': return item.lastError ? t('status.retrying') : t('status.pending');
    case 'done': {
      const where = item.note === 'server' ? t('status.doneServer') : item.note === 'external' ? t('status.doneExternal') : t('status.done');
      const st = item.stream || {};
      const details = [st.quality, formatSize(item.total || st.size)].filter(Boolean);
      return details.length ? [...details, where].join(' · ') : t('status.doneOnly', { where });
    }
    case 'error': return item.error || t('status.error');
    default: return progressText(item);
  }
}

function refreshQueueViews() {
  const open = queue.items.filter(i => i.status === 'pending' || ACTIVE.has(i.status)).length;
  const badge = $('#dl-badge');
  badge.textContent = String(open);
  badge.hidden = open === 0;
  const view = currentView();
  if (view === 'downloads') renderDownloads();
  if (view === 'detail') refreshEpisodeRows();
  if (view === 'search') renderHomeActive();
}

// Tiene acceso lo schermo mentre la coda lavora: con lo schermo spento il browser del
// telefono congela la pagina e la coda non passa all'elemento successivo.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ============================================================ Pagina Download

function renderDownloads() {
  const view = $('#view-downloads');
  view.innerHTML = '';
  const hasPending = queue.items.some(i => i.status === 'pending');
  view.appendChild(el('div', { class: 'appbar' }, [
    el('h1', {}, t('downloads.title')),
    queue.running
      ? el('button', { class: 'btn sm', type: 'button', onclick: () => toggleQueue(false) }, [icon('pause'), t('downloads.pause')])
      : hasPending ? el('button', { class: 'btn sm primary', type: 'button', onclick: () => toggleQueue(true) }, [icon('play'), t('downloads.resume')]) : null
  ]));

  const active = queue.items.filter(i => ACTIVE.has(i.status));
  const pending = queue.items.filter(i => i.status === 'pending' || i.status === 'error');
  const done = queue.items.filter(i => i.status === 'done');

  if (queue.running) {
    view.appendChild(el('div', { class: 'note' }, [icon('sun'), el('span', {}, t('downloads.keepOpen'))]));
  } else if (hasPending) {
    view.appendChild(el('div', { class: 'note' }, [icon('pause'), el('span', {}, t('downloads.paused'))]));
  }

  if (!queue.items.length && !serverFiles.length) {
    view.appendChild(el('div', { class: 'empty' }, [el('b', {}, t('downloads.emptyTitle')), t('downloads.emptyText'),
      el('div', {}, el('a', { class: 'btn primary', href: '#' }, [icon('search'), t('downloads.goSearch')]))]));
    return;
  }

  if (active.length) {
    view.appendChild(el('div', { class: 'sec' }, t('downloads.active')));
    for (const item of active) {
      view.appendChild(el('div', { class: 'card' }, el('div', { class: 'row', style: 'border:0;padding:0' }, [
        el('div', { class: 'thumb' }, item.posterUrl ? el('img', { src: item.posterUrl, alt: '' }) : null),
        el('div', { class: 'tx' }, [
          el('b', {}, item.title),
          el('span', {}, progressText(item)),
          item.stream ? el('span', {}, [item.stream.kind === 'hls' ? t('kind.hls') : t('kind.direct'), item.stream.addon].join(' · ')) : null,
          progressBar(item)
        ]),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('downloads.remove'), onclick: () => removeItem(item) }, icon('x'))
      ])));
    }
  }

  if (pending.length) {
    view.appendChild(el('div', { class: 'sec' }, t('downloads.queued', { n: pending.length })));
    const list = el('div');
    pending.forEach((item, i) => {
      const isErr = item.status === 'error';
      list.appendChild(el('div', { class: 'row' }, [
        el('div', { class: 'thumb' }, item.posterUrl ? el('img', { src: item.posterUrl, alt: '' }) : null),
        el('div', { class: 'tx' }, [
          el('b', {}, item.title),
          item.subtitle ? el('span', {}, item.subtitle) : null,
          el('span', { class: isErr ? 'err' : '' }, [itemStatusText(item), item.dest === 'server' ? ` · ${t('dest.serverShort')}` : ''].join(''))
        ]),
        isErr
          ? el('button', { class: 'btn sm', type: 'button', onclick: () => retryItem(item) }, t('common.retry'))
          : i > 0 && item.status === 'pending'
            ? el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('downloads.moveUp'), onclick: () => moveUp(item) }, icon('up'))
            : null,
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('downloads.remove'), onclick: () => removeItem(item) }, icon('x'))
      ]));
    });
    view.appendChild(list);
  }

  view.appendChild(el('div', { id: 'server-files' }));
  renderServerFiles();

  if (done.length) {
    view.appendChild(el('div', { class: 'sec' }, [t('downloads.done', { n: done.length }),
      el('button', { class: 'link-btn', type: 'button', onclick: () => {
        queue.items = queue.items.filter(i => i.status !== 'done');
        saveQueue();
        refreshQueueViews();
      } }, t('downloads.clearDone'))]));
    const list = el('div');
    for (const item of done.slice().reverse()) {
      list.appendChild(el('div', { class: 'row' }, [
        el('div', { class: 'thumb' }, item.posterUrl ? el('img', { src: item.posterUrl, alt: '' }) : null),
        el('div', { class: 'tx' }, [el('b', {}, item.title), el('span', {}, itemStatusText(item))]),
        el('span', { class: 'dl done sm' }, icon('check'))
      ]));
    }
    view.appendChild(list);
  }
}

function toggleQueue(run) {
  queue.running = run;
  saveQueue();
  if (run) { acquireWakeLock(); tick(); }
  else { releaseWakeLock(); toast(t('downloads.pausedToast')); }
  renderDownloads();
}

// ---- File preparati sul server

let serverFiles = [];

async function refreshServerFiles() {
  try {
    const { items } = await api('/prepared');
    serverFiles = items;
  } catch { return; }
  renderServerFiles();
}

function serverFileRow(f) {
  const pct = f.size ? Math.min(100, Math.floor((f.written / f.size) * 100)) : 0;
  const status = {
    queued: t('server.queued'),
    running: f.size ? t('server.running', { of: t('progress.of', { sent: formatSize(f.written) || '0 MB', total: formatSize(f.size) }) }) : t('server.connecting'),
    done: t('server.done', { size: formatSize(f.size) }),
    failed: t('server.failed', { msg: f.error || '?' })
  }[f.status] || f.status;
  return el('div', { class: 'row' }, [
    el('div', { class: 'thumb', style: 'display:grid;place-items:center;color:var(--muted)' }, icon('server')),
    el('div', { class: 'tx' }, [
      el('b', {}, f.title || f.filename),
      el('span', { class: f.status === 'failed' ? 'err' : '' }, status),
      f.status === 'running' || f.status === 'queued'
        ? el('div', { class: 'bar' + (f.size ? '' : ' indeterminate') }, el('i', { style: `width:${pct}%` })) : null
    ]),
    f.status === 'done'
      ? el('a', { class: 'btn sm', href: f.path, download: '' }, [icon('download'), t('common.download')])
      : null,
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('server.delete'), onclick: () => deleteServerFile(f) }, icon('trash'))
  ]);
}

function renderServerFiles() {
  renderHomeReady();
  const box = $('#server-files');
  if (!box) return;
  box.innerHTML = '';
  if (!serverFiles.length) return;
  box.appendChild(el('div', { class: 'sec' }, t('downloads.onServer', { n: serverFiles.length })));
  for (const f of serverFiles) box.appendChild(serverFileRow(f));
  box.appendChild(el('div', { class: 'meta' }, t('downloads.serverHint')));
}

async function deleteServerFile(f) {
  if (!confirm(t('server.confirmDelete', { name: f.title || f.filename }))) return;
  try { await api(`/prepared/${f.key}`, { method: 'DELETE' }); }
  catch (err) { toast(err.message, true); }
  state.streamCache.clear();
  refreshServerFiles();
}

// ============================================================ Impostazioni

const QUALITY_OPTIONS = ['2160', '1080', '720', 'any'];
const AUDIO_OPTIONS = ['it', 'en', 'es', 'fr', 'de', 'any'];
const META_LANGS = { 'it-IT': 'Italiano', 'en-US': 'English', 'es-ES': 'Español', 'fr-FR': 'Français', 'de-DE': 'Deutsch' };

function selectRow(label, value, options, onChange) {
  const select = el('select', { 'aria-label': label, onchange: e => onChange(e.target.value) },
    options.map(([v, text]) => {
      const o = el('option', { value: v }, text);
      if (v === value) o.selected = true;
      return o;
    }));
  const current = (options.find(([v]) => v === value) || options[0])[1];
  return el('label', { class: 'set tap' }, [el('span', {}, label), el('span', { class: 'v' }, [current, icon('chevron')]), select]);
}

function switchRow(label, checked, onChange, hint) {
  const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label, onchange: e => onChange(e.target.checked) });
  input.checked = checked;
  return el('label', { class: 'set' }, [el('span', {}, [label, hint ? el('small', {}, hint) : null]), el('span', { class: 'switch' }, [input, el('span')])]);
}

function linkRow(label, value, href) {
  return el('a', { class: 'set tap', href }, [el('span', {}, label), el('span', { class: 'v' }, [value, icon('chevron')])]);
}

function subAppbar(title) {
  return el('div', { class: 'appbar' }, [
    el('a', { class: 'icon-btn', href: '#impostazioni', 'aria-label': t('common.back') }, icon('back')),
    el('div', { class: 'ttl' }, title)
  ]);
}

async function loadServerSettings() {
  state.settings = await api('/settings');
  return state.settings;
}

async function loadAddons() {
  const { addons } = await api('/addons');
  state.addons = addons;
  return addons;
}

function renderSettings(page) {
  const view = $('#view-settings');
  view.innerHTML = '';
  if (page === 'addon') return renderAddonsPage(view);
  if (page === 'nuvio') return renderNuvioPage(view);
  if (page === 'tmdb') return renderTmdbPage(view);
  if (page === 'avanzate') return renderAdvancedPage(view);

  const s = state.settings || {};
  const rerender = () => renderSettings('');
  view.appendChild(el('div', { class: 'appbar' }, el('h1', {}, t('settings.title'))));

  view.appendChild(el('div', { class: 'sec' }, t('settings.download')));
  view.appendChild(el('div', { class: 'group' }, [
    selectRow(t('settings.dest'), prefs.dest, [['device', t('dest.device')], ['server', t('dest.server')]], v => { setPref('dest', v); rerender(); }),
    selectRow(t('settings.quality'), prefs.quality, QUALITY_OPTIONS.map(q => [q, t(`quality.${q}`)]), v => { setPref('quality', v); rerender(); }),
    selectRow(t('settings.audio'), prefs.audio, AUDIO_OPTIONS.map(l => [l, t(`lang.${l}`)]), v => { setPref('audio', v); rerender(); }),
    switchRow(t('settings.directFirst'), prefs.directFirst, v => setPref('directFirst', v), t('settings.directFirstHint'))
  ]));
  view.appendChild(el('div', { class: 'meta', style: 'margin:6px 4px 0' }, t('settings.prefsHint')));

  view.appendChild(el('div', { class: 'sec' }, t('settings.sources')));
  const n = state.addons ? state.addons.length : null;
  view.appendChild(el('div', { class: 'group' }, [
    linkRow(t('settings.addons'), n === null ? '' : el('span', { class: n ? 'chip ok' : 'chip warn' }, t('settings.addonsCount', { n })), '#impostazioni/addon'),
    linkRow(t('settings.nuvio'), t('settings.nuvioValue'), '#impostazioni/nuvio')
  ]));

  view.appendChild(el('div', { class: 'sec' }, t('settings.general')));
  view.appendChild(el('div', { class: 'group' }, [
    selectRow(t('settings.uiLang'), prefs.uiLang || '', [['', t('settings.uiLangAuto')], ...Object.entries(I18N.available)],
      async v => { setPref('uiLang', v); await initI18n(v); translateStatic(); rerender(); }),
    selectRow(t('settings.theme'), prefs.theme, [['auto', t('theme.auto')], ['light', t('theme.light')], ['dark', t('theme.dark')]], v => { setPref('theme', v); rerender(); }),
    linkRow(t('settings.tmdb'), s.tmdbApiKey ? el('span', { class: 'chip ok' }, t('settings.tmdbSet')) : el('span', { class: 'chip err' }, t('settings.tmdbMissing')), '#impostazioni/tmdb')
  ]));

  view.appendChild(el('div', { class: 'sec' }, t('settings.advanced')));
  view.appendChild(el('div', { class: 'group' }, linkRow(t('settings.advancedRow'), '', '#impostazioni/avanzate')));

  view.appendChild(el('p', { class: 'version-line' }, `NoStream ${s.version ? 'v' + s.version : ''}`));

  if (!state.settings || !state.addons) {
    Promise.all([loadServerSettings(), loadAddons()]).then(() => { if (location.hash === '#impostazioni') rerender(); }).catch(err => toast(err.message, true));
  }
}

// ---- Addon

function renderAddonsPage(view) {
  view.appendChild(subAppbar(t('settings.addons')));
  view.appendChild(el('p', { class: 'lead' }, t('addons.lead')));
  view.appendChild(addonForm(() => renderSettings('addon')));
  const list = el('div', { class: 'group', style: 'margin-top:16px' });
  view.appendChild(list);
  fillAddonList(list, () => renderSettings('addon'));
}

function addonForm(after) {
  const input = el('input', { class: 'input mono', type: 'url', placeholder: 'https://…/manifest.json', autocomplete: 'off', inputmode: 'url', 'aria-label': t('addons.url') });
  const btn = el('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:10px' }, [icon('plus'), t('addons.add')]);
  return el('form', { onsubmit: async e => {
    e.preventDefault();
    const manifestUrl = input.value.trim();
    if (!manifestUrl) return;
    btn.disabled = true;
    try {
      const { addon } = await api('/addons', { method: 'POST', body: JSON.stringify({ manifestUrl }) });
      toast(t('addons.added', { name: addon.name }));
      input.value = '';
      await loadAddons();
      after();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  } }, [el('label', { class: 'field' }, [el('span', {}, t('addons.url')), input]), btn]);
}

async function fillAddonList(list, after) {
  list.innerHTML = '';
  let addons;
  try { addons = await loadAddons(); }
  catch (err) { toast(err.message, true); return; }
  if (!addons.length) {
    list.replaceWith(el('div', { class: 'empty' }, [el('b', {}, t('addons.emptyTitle')), t('addons.emptyText')]));
    return;
  }
  for (const a of addons) {
    const status = el('span', { class: 'chip' }, t('addons.checking'));
    list.appendChild(el('div', { class: 'set' }, [
      el('span', { style: 'min-width:0' }, [a.name, el('small', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, a.manifestUrl)]),
      el('span', { class: 'v', style: 'flex:none' }, [
        status,
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('addons.remove', { name: a.name }), onclick: async () => {
          if (!confirm(t('addons.confirmRemove', { name: a.name }))) return;
          try { await api(`/addons/${a.id}`, { method: 'DELETE' }); }
          catch (err) { toast(err.message, true); }
          state.streamCache.clear();
          await loadAddons();
          after();
        } }, icon('trash'))
      ])
    ]));
    api(`/addons/${a.id}/check`).then(r => {
      const sec = new Intl.NumberFormat(I18N.lang, { maximumFractionDigits: 1 }).format(r.ms / 1000);
      status.className = 'chip ' + (r.ok ? (r.ms > 5000 ? 'warn' : 'ok') : 'err');
      status.textContent = r.ok ? t('addons.responds', { s: sec }) : t('addons.down');
      if (!r.ok) status.title = r.error;
    }).catch(() => { status.className = 'chip err'; status.textContent = t('addons.down'); });
  }
}

// ---- Nuvio

function manifestUrl() { return `${location.origin}/manifest.json`; }

function nuvioBlock() {
  const url = manifestUrl();
  return el('div', {}, [
    el('label', { class: 'field' }, [el('span', {}, t('nuvio.url')), el('input', { class: 'input mono', readonly: true, value: url, onclick: e => e.target.select() })]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast(t('nuvio.copied')); }
        catch { toast(t('nuvio.copyFailed'), true); }
      } }, [icon('copy'), t('nuvio.copy')])
    ]),
    el('div', { class: 'note' }, [icon('info'), el('span', {}, t('nuvio.howto'))])
  ]);
}

function renderNuvioPage(view) {
  view.appendChild(subAppbar(t('settings.nuvio')));
  view.appendChild(el('p', { class: 'lead' }, t('nuvio.lead')));
  view.appendChild(nuvioBlock());
}

// ---- TMDB

function tmdbForm(onSaved, submitLabel) {
  const s = state.settings || {};
  const input = el('input', { class: 'input mono', type: 'text', placeholder: t('tmdb.placeholder'), autocomplete: 'off', spellcheck: 'false', 'aria-label': t('tmdb.key') });
  input.value = s.tmdbApiKey || '';
  const lang = el('select', { class: 'input', 'aria-label': t('tmdb.metaLang') },
    Object.entries(META_LANGS).map(([v, label]) => {
      const o = el('option', { value: v }, label);
      if (v === (s.language || 'it-IT')) o.selected = true;
      return o;
    }));
  const btn = el('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:16px' }, submitLabel || t('tmdb.save'));
  return el('form', { onsubmit: async e => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    btn.disabled = true;
    try {
      await api('/settings', { method: 'POST', body: JSON.stringify({ tmdbApiKey: key, language: lang.value }) });
      await loadServerSettings();
      // Verifica: una ricerca qualsiasi deve funzionare con la nuova key.
      await api('/search?query=matrix');
      toast(t('tmdb.ok'));
      onSaved();
    } catch (err) {
      toast(t('tmdb.invalid', { msg: err.message }), true);
    } finally {
      btn.disabled = false;
    }
  } }, [
    el('label', { class: 'field' }, [el('span', {}, t('tmdb.key')), input]),
    el('label', { class: 'field' }, [el('span', {}, t('tmdb.metaLang')), lang]),
    btn
  ]);
}

function renderTmdbPage(view) {
  view.appendChild(subAppbar(t('settings.tmdb')));
  view.appendChild(el('p', { class: 'lead' }, t('tmdb.lead')));
  view.lastChild.append(' ', el('a', { href: 'https://www.themoviedb.org/settings/api', target: '_blank', rel: 'noopener' }, 'themoviedb.org/settings/api'));
  view.appendChild(tmdbForm(() => go('#impostazioni')));
}

// ---- Avanzate

function renderAdvancedPage(view) {
  const s = state.settings || {};
  view.appendChild(subAppbar(t('settings.advanced')));
  const timeout = el('input', { class: 'input', type: 'number', min: 5, max: 300, step: 5, value: Math.round((s.addonTimeoutMs || 60000) / 1000) });
  const hls = el('input', { class: 'input', type: 'number', min: 1, max: 10, step: 1, value: s.concurrentDownloads || 2 });
  view.appendChild(el('form', { onsubmit: async e => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'POST', body: JSON.stringify({
        addonTimeoutMs: parseInt(timeout.value, 10) * 1000,
        concurrentDownloads: hls.value
      }) });
      await loadServerSettings();
      toast(t('common.saved'));
    } catch (err) { toast(err.message, true); }
  } }, [
    el('label', { class: 'field' }, [el('span', {}, t('advanced.timeout')), timeout, el('div', { class: 'meta' }, t('advanced.timeoutHint'))]),
    el('label', { class: 'field' }, [el('span', {}, t('advanced.hls')), hls, el('div', { class: 'meta' }, t('advanced.hlsHint'))]),
    el('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:18px' }, t('common.save'))
  ]));
}

// ============================================================ Primo avvio

let welcomeStep = 0;

function renderWelcome() {
  const view = $('#view-welcome');
  view.innerHTML = '';
  view.className = 'view active wizard';
  view.appendChild(el('div', { class: 'appbar' }, el('span', { class: 'logo' }, [el('img', { src: '/logo.svg', alt: '' }), 'NoStream'])));
  view.appendChild(el('div', { class: 'steps' }, [0, 1, 2].map(i => el('i', { class: i <= welcomeStep ? 'on' : '' }))));
  view.appendChild(el('div', { class: 'kicker' }, t('welcome.step', { n: welcomeStep + 1, total: 3 })));
  const next = () => { welcomeStep++; renderWelcome(); };
  const prev = welcomeStep > 0 ? el('button', { class: 'btn', type: 'button', onclick: () => { welcomeStep--; renderWelcome(); } }, t('common.back')) : null;

  if (welcomeStep === 0) {
    view.appendChild(el('h2', {}, t('welcome.tmdbTitle')));
    view.appendChild(el('p', { class: 'lead' }, t('welcome.tmdbText')));
    view.lastChild.append(' ', el('a', { href: 'https://www.themoviedb.org/settings/api', target: '_blank', rel: 'noopener' }, 'themoviedb.org/settings/api'));
    view.appendChild(tmdbForm(next, t('welcome.verifyContinue')));
  } else if (welcomeStep === 1) {
    view.appendChild(el('h2', {}, t('welcome.addonsTitle')));
    view.appendChild(el('p', { class: 'lead' }, t('welcome.addonsText')));
    view.appendChild(addonForm(() => renderWelcome()));
    const list = el('div', { class: 'group', style: 'margin-top:16px' });
    view.appendChild(list);
    fillAddonList(list, () => renderWelcome());
    view.appendChild(el('div', { class: 'wizard-nav' }, [prev,
      el('button', { class: 'btn primary', type: 'button', onclick: next }, t('common.next'))]));
  } else {
    view.appendChild(el('h2', {}, t('welcome.nuvioTitle')));
    view.appendChild(el('p', { class: 'lead' }, t('welcome.nuvioText')));
    view.appendChild(nuvioBlock());
    view.appendChild(el('div', { class: 'wizard-nav' }, [prev,
      el('button', { class: 'btn primary', type: 'button', onclick: () => {
        storageSet('nostream.welcomed', true);
        welcomeStep = 0;
        go('');
      } }, t('welcome.finish'))]));
  }
}

// ============================================================ Avvio

function initQueue() {
  loadQueue();
  setInterval(tick, POLL_MS);
  setInterval(() => { if (currentView() === 'downloads') refreshServerFiles(); }, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (queue.running) acquireWakeLock();
      tick();
    }
  });
  if (queue.running) acquireWakeLock();
}

async function init() {
  applyTheme();
  await initI18n(prefs.uiLang);
  $all('[data-icon]').forEach(n => n.replaceWith(icon(n.dataset.icon)));
  translateStatic();
  initQueue();
  window.addEventListener('hashchange', route);
  try {
    await Promise.all([loadServerSettings(), loadAddons()]);
  } catch (err) {
    toast(err.message, true);
  }
  // Primo avvio: senza API key TMDB si parte dalla configurazione guidata.
  if (state.settings && !state.settings.tmdbApiKey && !storageGet('nostream.welcomed') && !location.hash) {
    location.replace('#benvenuto');
  }
  route();
  refreshQueueViews();
  refreshServerFiles();
  tick();
}

init();
