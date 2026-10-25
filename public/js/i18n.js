// Traduzioni dell'interfaccia. Ogni testo è una chiave in /i18n/<lingua>.json; l'italiano
// è la lingua di riferimento e fa da riserva per le chiavi mancanti nelle altre lingue.
// Segnaposto: {nome} → t('chiave', { nome: 'valore' }).
// Plurali: una chiave può avere le varianti "one" e "other": t('chiave', { n: 3 }).

const I18N = {
  // Le lingue disponibili compaiono nelle impostazioni; per aggiungerne una basta il file JSON.
  available: { it: 'Italiano' },
  fallback: 'it',
  lang: 'it',
  strings: {},
  base: {}
};

async function loadLang(lang) {
  const res = await fetch(`/i18n/${lang}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`i18n ${lang}: HTTP ${res.status}`);
  return res.json();
}

async function initI18n(preferred) {
  const wanted = [preferred, ...(navigator.languages || [navigator.language || ''])]
    .filter(Boolean)
    .map(l => l.slice(0, 2).toLowerCase())
    .find(l => I18N.available[l]) || I18N.fallback;
  I18N.base = await loadLang(I18N.fallback);
  I18N.strings = wanted === I18N.fallback ? I18N.base : { ...I18N.base, ...(await loadLang(wanted).catch(() => ({}))) };
  I18N.lang = wanted;
  document.documentElement.lang = wanted;
}

function t(key, vars = {}) {
  let s = I18N.strings[key];
  if (s === undefined) s = I18N.base[key];
  if (s === undefined) {
    console.warn('i18n: chiave mancante', key);
    return key;
  }
  if (typeof s === 'object') {
    const rule = new Intl.PluralRules(I18N.lang).select(Number(vars.n));
    s = s[rule] !== undefined ? s[rule] : s.other;
  }
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// Applica le traduzioni agli elementi statici con data-t="chiave".
function translateStatic(root = document) {
  root.querySelectorAll('[data-t]').forEach(n => { n.textContent = t(n.dataset.t); });
}
