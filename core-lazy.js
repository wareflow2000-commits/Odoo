// Lazy loaders for page modules and their optional stylesheet.
import { tx } from './core-i18n.js';

const cssCache = new Map();
const modCache = new Map();

// Pages that actually ship a dedicated stylesheet. Shared WMS styling lives in
// style-wms.css, so requesting a missing page-<name>.css would only produce 404s.
const CSS_PAGES = new Set();

export async function loadCSS(name) {
  if (!CSS_PAGES.has(name)) return;
  const href = `page-${name}.css`;
  if (cssCache.has(href)) return cssCache.get(href);
  const p = new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = resolve;
    document.head.appendChild(link);
  });
  cssCache.set(href, p);
  return p;
}

export async function loadPage(name) {
  if (modCache.has(name)) return modCache.get(name);
  const p = import(`./page-${name}.js`)
    .then(m => m.default || m.page)
    .catch(err => {
      console.error(`[lazy] failed to load page: ${name}`, err);
      modCache.delete(name);
      throw new Error(tx(
        'تعذر تحميل الصفحة المطلوبة. أعد تحميل التطبيق ثم حاول مرة أخرى.',
        'The requested page could not be loaded. Reload the app and try again.'));
    });
  modCache.set(name, p);
  return p;
}

export function isPageCached(name) { return modCache.has(name); }
