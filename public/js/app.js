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
  link: storageGet('nostream.link'),  // video o playlist aperta da link (yt-dlp)
  linkMode: 'video',   // video | audio
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
  '#impostazioni/link': 'settings',
  '#impostazioni/account-nuvio': 'settings',
  '#link': 'link',
  '#benvenuto': 'welcome'
};

function currentView() { return ROUTES[location.hash] || 'search'; }

function route() {
  let view = currentView();
  if (view === 'detail' && !state.item) { location.replace('#'); return; }
  if (view === 'link' && !state.link) { location.replace('#'); return; }
  $all('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $all('#tabbar a').forEach(a => a.classList.toggle('active',
    a.dataset.tab === view || ((view === 'detail' || view === 'link') && a.dataset.tab === 'search')));
  $('#tabbar').hidden = view === 'welcome';
  closeSheet();
  if (view !== 'detail' && view !== 'link') exitSelection(false);
  window.scrollTo(0, 0);
  if (view === 'search') renderSearch();
  if (view === 'detail') renderDetail();
  if (view === 'downloads') { renderDownloads(); refreshServerFiles(); }
  if (view === 'settings') renderSettings(location.hash.split('/')[1] || '');
  if (view === 'welcome') renderWelcome();
  if (view === 'link') renderLink();
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

function looksLikeUrl(s) { return /^https?:\/\/\S+$/i.test(s) || /^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i.test(s); }

async function runSearch(raw) {
  const query = raw.trim();
  if (!query) return;
  if (looksLikeUrl(query)) { openLink(/^https?:/i.test(query) ? query : `https://${query}`); return; }
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
  if (rerender && currentView() === 'link') renderLink();
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
  const view = currentView();
  const show = state.selecting && (view === 'detail' || view === 'link');
  bar.hidden = !show;
  document.body.classList.toggle('has-selbar', show);
  if (!show) return;
  bar.innerHTML = '';
  const n = state.selected.size;
  if (view === 'link') {
    bar.appendChild(el('button', { class: 'btn primary', type: 'button', disabled: !n, onclick: () => {
      const entries = state.link.entries.filter(e => state.selected.has(e.index));
      exitSelection(false);
      enqueueLinks(entries, { force: true });
      renderLink();
    } }, [icon('download'), n ? t('link.selectDownload', { n }) : t('link.selectHint')]));
    return;
  }
  bar.appendChild(el('button', { class: 'btn primary', type: 'button', disabled: !n, onclick: () => {
    const eps = state.episodes.filter(ep => state.selected.has(ep.episodeNumber));
    exitSelection(false);
    enqueueEpisodes(eps, { force: true });
    renderDetail();
  } }, [icon('download'), n ? t('select.download', { n }) : t('select.hint')]));
}

// ============================================================ Video da link (yt-dlp)

async function openLink(url) {
  state.results = 'loading';
  renderSearch();
  $('#search-input').blur();
  const body = $('#search-body');
  body.innerHTML = '';
  body.appendChild(el('div', { class: 'empty' }, [el('b', {}, t('link.reading')), t('link.readingHint')]));
  try {
    const info = await api('/link/info', { method: 'POST', body: JSON.stringify({ url }) });
    state.link = info;
    storageSet('nostream.link', info);
    state.results = null;
    state.query = '';
    exitSelection(false);
    go('#link');
  } catch (err) {
    state.results = null;
    if (currentView() === 'search') renderSearch();
    toast(t('link.failed', { msg: err.message }), true);
  }
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatLongDuration(sec) {
  if (sec < 60) return formatDuration(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? t('link.hoursMinutes', { h, m }) : t('detail.minutes', { n: m });
}

function linkQueueItem(entry) { return queueItemFor(linkKey(entry, state.linkMode)); }

function linkEntriesToDownload() {
  return state.link.entries.filter(e => {
    const q = linkQueueItem(e);
    return !q || q.status === 'error';
  });
}

function renderLink() {
  const link = state.link;
  const view = $('#view-link');
  view.innerHTML = '';
  const isList = link.kind === 'playlist';

  if (state.selecting) {
    const all = link.entries.filter(e => { const q = linkQueueItem(e); return !q || q.status === 'error' || q.status === 'done'; });
    const allOn = all.length && all.every(e => state.selected.has(e.index));
    view.appendChild(el('div', { class: 'appbar' }, [
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.cancel'), onclick: () => exitSelection() }, icon('x')),
      el('div', { class: 'ttl' }, t('select.count', { n: state.selected.size })),
      el('button', { class: 'btn sm', type: 'button', onclick: () => {
        state.selected = allOn ? new Set() : new Set(all.map(e => e.index));
        renderLink();
        updateSelbar();
      } }, allOn ? t('select.none') : t('select.all'))
    ]));
  } else {
    view.appendChild(el('div', { class: 'appbar' }, [
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.back'),
        onclick: () => (history.length > 1 ? history.back() : go('')) }, icon('back')),
      el('div', { class: 'ttl' }, '')
    ]));
  }

  view.appendChild(el('div', { class: 'hero link-hero' }, [
    el('div', { class: 'poster wide' }, link.thumbnail ? el('img', { src: link.thumbnail, alt: '', loading: 'lazy' }) : null),
    el('div', { style: 'min-width:0' }, [
      el('span', { class: 'chip' }, [link.site || t('link.site'), ' · ', isList ? t('link.playlist') : t('link.video')]),
      el('h2', { style: 'margin-top:6px' }, link.title),
      el('div', { class: 'meta' }, [
        link.uploader,
        isList ? t('link.videos', { n: link.entries.length }) : null,
        link.duration ? formatLongDuration(link.duration) : null
      ].filter(Boolean).join(' · '))
    ])
  ]));

  view.appendChild(el('div', { class: 'seg' }, [
    el('button', { type: 'button', class: state.linkMode === 'video' ? 'on' : '', onclick: () => { state.linkMode = 'video'; exitSelection(false); renderLink(); } }, t('link.modeVideo')),
    el('button', { type: 'button', class: state.linkMode === 'audio' ? 'on' : '', onclick: () => { state.linkMode = 'audio'; exitSelection(false); renderLink(); } }, t('link.modeAudio'))
  ]));

  if (!state.selecting) view.appendChild(linkActions());

  const list = el('div', { id: 'link-list', style: 'margin-top:10px' });
  for (const e of link.entries) list.appendChild(linkEntryRow(e));
  view.appendChild(list);
}

function linkActions() {
  const link = state.link;
  const isList = link.kind === 'playlist';
  const todo = linkEntriesToDownload();
  const label = !todo.length
    ? t('link.allQueued')
    : isList
      ? (todo.length === link.entries.length ? t('link.downloadPlaylist', { n: todo.length }) : t('link.downloadMissing', { n: todo.length }))
      : state.linkMode === 'audio' ? t('link.downloadAudio') : t('link.downloadVideo');
  return el('div', { class: 'btn-row', id: 'link-actions', 'data-sig': `${todo.length}|${label}` }, [
    el('button', { class: 'btn primary', type: 'button', disabled: !todo.length, onclick: () => enqueueLinks(todo) }, [icon('download'), label]),
    isList ? el('button', { class: 'btn square', type: 'button', title: t('link.selectVideos'), 'aria-label': t('link.selectVideos'),
      onclick: () => { state.selecting = true; state.selected.clear(); renderLink(); updateSelbar(); } }, icon('select')) : null
  ]);
}

function linkEntryRow(e) {
  const q = linkQueueItem(e);
  const sub = q ? itemStatusText(q) : formatDuration(e.duration);
  if (state.selecting) {
    const selectable = !q || q.status === 'error' || q.status === 'done';
    const on = state.selected.has(e.index);
    return el('button', {
      class: 'row tap' + (selectable ? '' : ' disabled'), type: 'button', 'data-i': e.index, 'data-sig': `s${on}${selectable}`,
      disabled: !selectable, onclick: () => {
        if (state.selected.has(e.index)) state.selected.delete(e.index); else state.selected.add(e.index);
        renderLink();
        updateSelbar();
      }
    }, [el('span', { class: 'cb' + (on ? ' on' : '') }, icon('check')), el('span', { class: 'tx' }, [el('b', {}, e.title), el('span', {}, sub)])]);
  }
  const sig = q ? `${q.status}|${progressPct(q)}|${sub}` : 'none';
  return el('div', { class: 'row', 'data-i': e.index, 'data-sig': sig }, [
    state.link.kind === 'playlist' ? el('span', { class: 'n' }, e.index) : null,
    el('span', { class: 'tx' }, [el('b', {}, e.title), el('span', { class: q && q.status === 'error' ? 'err' : '' }, sub)]),
    statusButton(q, () => enqueueLinks([e]), () => enqueueLinks([e], { force: true }))
  ]);
}

function refreshLinkRows() {
  if (currentView() !== 'link' || !state.link || state.selecting) return;
  for (const row of $all('#link-list .row')) {
    const e = state.link.entries.find(x => x.index === Number(row.dataset.i));
    if (!e) continue;
    const fresh = linkEntryRow(e);
    if (fresh.dataset.sig !== row.dataset.sig) row.replaceWith(fresh);
  }
  const actions = $('#link-actions');
  if (actions) {
    const fresh = linkActions();
    if (fresh.dataset.sig !== actions.dataset.sig) actions.replaceWith(fresh);
  }
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

function linkKey(entry, mode) { return `link:${mode}:${entry.url}`; }

function enqueueLinks(entries, opts = {}) {
  const link = state.link;
  const mode = state.linkMode;
  enqueue(entries.map(e => ({
    link: { url: e.url, mode, index: link.kind === 'playlist' ? e.index : null },
    key: linkKey(e, mode),
    title: e.title,
    epName: link.kind === 'playlist' ? link.title : (link.uploader || null),
    posterUrl: e.thumbnail || link.thumbnail,
    force: opts.force
  })));
}

function enqueueEpisodes(episodes, opts = {}) {
  enqueue(episodes.map(ep => ({ item: state.item, season: state.season, episode: ep.episodeNumber, epName: ep.name, force: opts.force })));
}

function enqueue(entries) {
  let added = 0;
  for (const entry of entries) {
    const { item, season, episode, epName, pinned, dest, force } = entry;
    const key = entry.link ? entry.key : queueKey(item.type, item.tmdbId, season, episode);
    const existing = queueItemFor(key);
    if (existing && existing.status !== 'error' && !(force && existing.status === 'done')) continue;
    if (existing) queue.items.splice(queue.items.indexOf(existing), 1);
    if (entry.link) {
      queue.items.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        key,
        type: 'link',
        link: entry.link,
        title: entry.title,
        subtitle: epName || null,
        posterUrl: entry.posterUrl || null,
        dest: 'server',
        tried: [],
        status: 'pending',
        sent: 0,
        total: null,
        error: null
      });
      added++;
      continue;
    }
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

async function startLinkItem(item) {
  item.status = 'resolving';
  item.error = null;
  saveQueue();
  try {
    const { item: job } = await api('/link/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: item.link.url, mode: item.link.mode, title: item.title, index: item.link.index })
    });
    if (!queue.items.includes(item)) return;
    item.prepKey = job.key;
    item.stream = { kind: 'link', quality: item.link.mode === 'audio' ? t('link.audioShort') : null };
    item.status = 'preparing';
    item.sent = 0;
    item.total = null;
  } catch (err) {
    failItem(item, err.message);
  }
  saveQueue();
  refreshServerFiles();
}

async function startItem(item) {
  if (item.type === 'link') return startLinkItem(item);
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
  if (!job) {
    if (item.type === 'link') failItem(item, t('queue.serverGone'));
    else retryWithNext(item, t('queue.serverGone'));
    return;
  }
  item.sent = job.written || 0;
  if (job.size) item.total = job.size;
  if (job.status === 'done') {
    item.status = 'done';
    item.note = 'server';
    triggerDownload(job.path);
  } else if (job.status === 'failed') {
    // Per i link non ci sono fonti alternative: l'errore di yt-dlp va mostrato così com'è.
    if (item.type === 'link') failItem(item, job.error || t('queue.serverFailed'));
    else retryWithNext(item, job.error || t('queue.serverFailed'));
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
    case 'preparing':
      if (item.type === 'link') return item.sent ? t('status.linkOf', { of }) : t('status.linkStarting');
      return item.sent ? t('status.preparingOf', { of }) : t('status.preparing');
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
  if (view === 'link') refreshLinkRows();
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
          item.stream && item.stream.kind !== 'link' ? el('span', {}, [item.stream.kind === 'hls' ? t('kind.hls') : t('kind.direct'), item.stream.addon].join(' · ')) : null,
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
          el('span', { class: isErr ? 'err' : '' }, [itemStatusText(item), item.dest === 'server' && item.type !== 'link' ? ` · ${t('dest.serverShort')}` : ''].join(''))
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

async function loadNuvio() {
  state.nuvio = await api('/nuvio');
  return state.nuvio;
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
  if (page === 'link') return renderLinkSettingsPage(view);
  if (page === 'account-nuvio') return renderNuvioAccountPage(view);

  const s = state.settings || {};
  const rerender = () => renderSettings('');
  view.appendChild(el('div', { class: 'appbar' }, el('h1', {}, t('settings.title'))));

  view.appendChild(el('div', { class: 'sec' }, t('settings.download')));
  view.appendChild(el('div', { class: 'group' }, [
    selectRow(t('settings.dest'), prefs.dest, [['device', t('dest.device')], ['server', t('dest.server')]], v => { setPref('dest', v); rerender(); }),
    selectRow(t('settings.quality'), prefs.quality, QUALITY_OPTIONS.map(q => [q, t(`quality.${q}`)]), v => { setPref('quality', v); rerender(); }),
    selectRow(t('settings.audio'), prefs.audio, AUDIO_OPTIONS.map(l => [l, t(`lang.${l}`)]), v => { setPref('audio', v); rerender(); }),
    switchRow(t('settings.directFirst'), prefs.directFirst, v => setPref('directFirst', v), t('settings.directFirstHint')),
    linkRow(t('settings.linkVideos'), t('settings.linkVideosValue'), '#impostazioni/link')
  ]));
  view.appendChild(el('div', { class: 'meta', style: 'margin:6px 4px 0' }, t('settings.prefsHint')));

  view.appendChild(el('div', { class: 'sec' }, t('settings.sources')));
  const n = state.addons ? state.addons.length : null;
  view.appendChild(el('div', { class: 'group' }, [
    linkRow(t('settings.addons'), n === null ? '' : el('span', { class: n ? 'chip ok' : 'chip warn' }, t('settings.addonsCount', { n })), '#impostazioni/addon'),
    linkRow(t('settings.nuvioAccount'), state.nuvio && state.nuvio.connected
      ? el('span', { class: 'chip ok' }, t('nuvioAcc.connectedChip'))
      : state.nuvio && state.nuvio.error ? el('span', { class: 'chip err' }, t('nuvioAcc.errorChip')) : t('nuvioAcc.notConnected'), '#impostazioni/account-nuvio'),
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

  if (!state.settings || !state.addons || !state.nuvio) {
    Promise.all([loadServerSettings(), loadAddons(), loadNuvio()]).then(() => { if (location.hash === '#impostazioni') rerender(); }).catch(err => toast(err.message, true));
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
      el('span', { style: 'min-width:0' }, [a.name, a.origin === 'nuvio' ? el('span', { class: 'chip acc', style: 'margin-left:6px' }, t('addons.fromNuvio')) : null,
        el('small', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, a.origin === 'nuvio' ? hostOf(a.manifestUrl) : a.manifestUrl)]),
      el('span', { class: 'v', style: 'flex:none' }, [
        status,
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('addons.remove', { name: a.name }), onclick: async () => {
          if (!confirm(t(a.origin === 'nuvio' ? 'addons.confirmUnuse' : 'addons.confirmRemove', { name: a.name }))) return;
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

// ---- Account Nuvio (gli addon di Nuvio come fonti)

function hostOf(url) { try { return new URL(url).hostname; } catch { return url; } }

const NUVIO_STATUS = {
  usable: ['ok', 'nuvioAcc.st.usable'],
  self: ['', 'nuvioAcc.st.self'],
  noStreams: ['', 'nuvioAcc.st.noStreams'],
  noMovies: ['', 'nuvioAcc.st.noMovies'],
  noImdb: ['', 'nuvioAcc.st.noImdb'],
  disabled: ['', 'nuvioAcc.st.disabled'],
  duplicate: ['warn', 'nuvioAcc.st.duplicate'],
  unreachable: ['err', 'nuvioAcc.st.unreachable']
};

function renderNuvioAccountPage(view) {
  view.appendChild(subAppbar(t('settings.nuvioAccount')));
  const n = state.nuvio;
  if (!n) {
    view.appendChild(el('div', { class: 'empty' }, t('common.loading')));
    loadNuvio().then(() => renderSettings('account-nuvio')).catch(err => toast(err.message, true));
    return;
  }
  const rerender = data => { state.nuvio = data; state.addons = null; renderSettings('account-nuvio'); };

  if (!n.connected) {
    view.appendChild(el('p', { class: 'lead' }, t('nuvioAcc.lead')));
    if (n.error) view.appendChild(el('div', { class: 'note err' }, [icon('alert'), el('span', {}, n.error)]));
    const email = el('input', { class: 'input', type: 'email', autocomplete: 'username', placeholder: 'nome@esempio.it', 'aria-label': t('nuvioAcc.email') });
    if (n.email) email.value = n.email;
    const pass = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': t('nuvioAcc.password') });
    const btn = el('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:16px' }, t('nuvioAcc.connect'));
    view.appendChild(el('form', { onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = t('nuvioAcc.connecting');
      try {
        const data = await api('/nuvio/login', { method: 'POST', body: JSON.stringify({ email: email.value, password: pass.value }) });
        pass.value = '';
        toast(t('nuvioAcc.connected'));
        rerender(data);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = t('nuvioAcc.connect');
      }
    } }, [
      el('label', { class: 'field' }, [el('span', {}, t('nuvioAcc.email')), email]),
      el('label', { class: 'field' }, [el('span', {}, t('nuvioAcc.password')), pass]),
      btn
    ]));
    view.appendChild(el('div', { class: 'note' }, [icon('info'), el('span', {}, t('nuvioAcc.privacy'))]));
    return;
  }

  if (n.error) view.appendChild(el('div', { class: 'note err' }, [icon('alert'), el('span', {}, n.error)]));
  const syncBtn = el('button', { class: 'btn sm', type: 'button', onclick: async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = t('nuvioAcc.syncing');
    try { rerender(await api('/nuvio/sync', { method: 'POST' })); toast(t('nuvioAcc.synced')); }
    catch (err) { toast(err.message, true); syncBtn.disabled = false; syncBtn.textContent = t('nuvioAcc.syncNow'); }
  } }, t('nuvioAcc.syncNow'));
  const profiles = n.profiles.length ? n.profiles : [{ index: 1, name: t('nuvioAcc.mainProfile') }];
  view.appendChild(el('div', { class: 'group', style: 'margin-top:8px' }, [
    el('div', { class: 'set' }, [el('span', {}, t('nuvioAcc.account')), el('span', { class: 'v nochev' }, n.email || '')]),
    selectRow(t('nuvioAcc.profile'), String(n.profileId), profiles.map(p => [String(p.index), p.name || t('nuvioAcc.profileN', { n: p.index })]),
      async v => { try { rerender(await api('/nuvio/profile', { method: 'POST', body: JSON.stringify({ profileId: Number(v) }) })); } catch (err) { toast(err.message, true); } }),
    el('div', { class: 'set' }, [el('span', {}, [t('nuvioAcc.lastSync'), el('small', {}, n.lastSync ? formatDateTime(n.lastSync) : '—')]), syncBtn])
  ]));

  const used = n.addons.filter(a => a.used).length;
  view.appendChild(el('div', { class: 'sec' }, t('nuvioAcc.addonsTitle', { n: n.addons.length, used })));
  if (!n.addons.length) {
    view.appendChild(el('div', { class: 'empty' }, t('nuvioAcc.noAddons')));
  } else {
    const group = el('div', { class: 'group' });
    for (const a of n.addons.slice().sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0))) {
      const [cls, key] = NUVIO_STATUS[a.status] || ['', a.status];
      const detail = [a.host, a.ms && a.status !== 'unreachable' ? t('addons.responds', { s: new Intl.NumberFormat(I18N.lang, { maximumFractionDigits: 1 }).format(a.ms / 1000) }) : null].filter(Boolean).join(' · ');
      const right = a.status === 'usable'
        ? (() => {
          const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': t('nuvioAcc.use', { name: a.name }), onchange: async e => {
            try { rerender(await api(`/nuvio/addons/${a.id}`, { method: 'POST', body: JSON.stringify({ used: e.target.checked }) })); }
            catch (err) { toast(err.message, true); }
          } });
          input.checked = a.used;
          return el('span', { class: 'switch' }, [input, el('span')]);
        })()
        : el('span', { class: `chip ${cls}`, title: a.error || '' }, t(key));
      group.appendChild(el('div', { class: 'set' }, [
        el('span', { style: 'min-width:0' }, [a.name || a.host, el('small', {}, a.status === 'usable' ? detail : [detail, a.error].filter(Boolean).join(' · '))]),
        right
      ]));
    }
    view.appendChild(group);
    view.appendChild(el('div', { class: 'meta', style: 'margin:6px 4px 0' }, t('nuvioAcc.hint')));
  }

  view.appendChild(el('button', { class: 'btn danger block', type: 'button', style: 'margin-top:24px', onclick: async () => {
    if (!confirm(t('nuvioAcc.confirmLogout'))) return;
    try { rerender(await api('/nuvio/logout', { method: 'POST' })); } catch (err) { toast(err.message, true); }
  } }, t('nuvioAcc.logout')));
}

function formatDateTime(ms) {
  try { return new Intl.DateTimeFormat(I18N.lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); }
  catch { return ''; }
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

// ---- Video da link

async function saveYtdlp(patch) {
  try {
    state.settings = await api('/settings', { method: 'POST', body: JSON.stringify({ ytdlp: { ...(state.settings.ytdlp || {}), ...patch } }) });
  } catch (err) { toast(err.message, true); }
  renderSettings('link');
}

function renderLinkSettingsPage(view) {
  const y = (state.settings && state.settings.ytdlp) || {};
  view.appendChild(subAppbar(t('settings.linkVideos')));
  view.appendChild(el('p', { class: 'lead' }, t('ytdlp.lead')));
  view.appendChild(el('div', { class: 'sec' }, t('ytdlp.format')));
  view.appendChild(el('div', { class: 'group' }, [
    selectRow(t('ytdlp.maxHeight'), String(y.maxHeight || 1080), ['2160', '1440', '1080', '720', '480'].map(h => [h, h === '2160' ? '4K (2160p)' : `${h}p`]),
      v => saveYtdlp({ maxHeight: Number(v) })),
    selectRow(t('ytdlp.audioFormat'), y.audioFormat || 'm4a', [['m4a', 'm4a (AAC)'], ['mp3', 'mp3'], ['opus', 'opus']], v => saveYtdlp({ audioFormat: v })),
    switchRow(t('ytdlp.embedSubs'), !!y.embedSubs, v => saveYtdlp({ embedSubs: v })),
    switchRow(t('ytdlp.numberFiles'), y.numberFiles !== false, v => saveYtdlp({ numberFiles: v }), t('ytdlp.numberFilesHint'))
  ]));
  view.appendChild(el('div', { class: 'sec' }, 'yt-dlp'));
  const versionVal = el('span', { class: 'v' }, '…');
  const updateBtn = el('button', { class: 'btn sm', type: 'button', onclick: async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = t('ytdlp.updating');
    try {
      const r = await api('/ytdlp/update', { method: 'POST' });
      toast(r.before === r.after ? t('ytdlp.upToDate', { v: r.after }) : t('ytdlp.updated', { v: r.after }));
      versionVal.textContent = r.after || '?';
    } catch (err) { toast(err.message, true); }
    updateBtn.disabled = false;
    updateBtn.textContent = t('ytdlp.updateNow');
  } }, t('ytdlp.updateNow'));
  view.appendChild(el('div', { class: 'group' }, [
    el('div', { class: 'set' }, [el('span', {}, t('ytdlp.version')), versionVal]),
    switchRow(t('ytdlp.autoUpdate'), y.autoUpdate !== false, v => saveYtdlp({ autoUpdate: v }), t('ytdlp.autoUpdateHint')),
    el('div', { class: 'set' }, [el('span', {}, t('ytdlp.update')), updateBtn])
  ]));
  view.appendChild(el('div', { class: 'note' }, [icon('info'), el('span', {}, t('ytdlp.note'))]));
  api('/ytdlp').then(r => { versionVal.textContent = r.version || t('ytdlp.missing'); }).catch(() => { versionVal.textContent = '?'; });
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
    view.appendChild(el('a', { class: 'btn block', href: '#impostazioni/account-nuvio', style: 'margin:6px 0 4px' }, t('welcome.fromNuvio')));
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
