// ============================================================================
// OW — page router
// ============================================================================
import { OW } from './core-registry.js';
import { loadPage, loadCSS } from './core-lazy.js';
import { localizeDom, friendlyError, tx } from './core-i18n.js';
import { esc } from './core-utils.js';

let navSeq = 0;

function showLoading() {
  const main = document.getElementById('mainContent');
  if (main) main.innerHTML = `<div class="o_loading"><div class="o_spinner"></div></div>`;
}

function renderMenu(items, current) {
  const bar = document.getElementById('menubar');
  if (!bar) return;
  if (!items || !items.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = items.map(m => {
    const active = (current === m.page || String(current).startsWith(m.page + '-')) ? 'active' : '';
    return `<a class="o_menu_item ${active}" onclick="showPage('${m.page}')">${m.label}</a>`;
  }).join('');
}

function updateBrand() {
  const el = document.getElementById('navBrand');
  if (el) {
    el.innerHTML = `<img src="assets/logo.png" alt="OW" class="o_nav_logo">`;
  }
}

export async function showPage(name, params = {}) {
  if (!name) return;
  const seq = ++navSeq;
  showLoading();
  OW.closeAllPanels?.();
  try {
    const cssPromise = loadCSS(name);
    let page = OW.pages[name];
    if (!page) {
      page = await loadPage(name);
      OW.pages[name] = page;
    }
    await cssPromise;
    if (seq !== navSeq) return;

    OW.currentPage = name;
    OW.pageParams = params;
    const html = typeof page.render === 'function' ? await page.render(params) : (page.render || '');
    if (seq !== navSeq) return;
    const main = document.getElementById('mainContent');
    main.innerHTML = html;
    main.className = `o_main o_page_${name}`;
    renderMenu(page.menu || [], name);
    updateBrand(page.brand);
    OW.updateMobileNav?.(name);
    localizeDom(main);

    if (page.mount) await page.mount(params, main);
    if (seq !== navSeq) return;

    OW.closeAllPanels?.();
    try { history.replaceState(null, '', `#${name}`); } catch (_) {}
    window.scrollTo(0, 0);
  } catch (err) {
    console.error('[router]', err);
    const main = document.getElementById('mainContent');
    if (main) main.innerHTML = `<div class="o_page_error">
      <h2><i class="fa-solid fa-triangle-exclamation"></i> ${tx('تعذر تحميل الصفحة', 'Could not load the page')}</h2>
      <p>${esc(friendlyError(err, tx('تعذر تحميل الصفحة المطلوبة. أعد المحاولة بعد تحديث الصفحة.',
        'The requested page could not be loaded. Refresh and try again.')))}</p>
      <button class="o_btn o_btn_primary" onclick="showPage('apps')">${tx('العودة إلى التطبيقات', 'Back to apps')}</button>
      <p class="hint">${tx('تأكد من تشغيل المشروع عبر HTTP Server.', 'Make sure the project is served through an HTTP server.')}</p>
    </div>`;
  }
}

export function reloadCurrentPage() {
  if (OW.currentPage) return showPage(OW.currentPage, OW.pageParams || {});
}

// Re-render current page so tx('ar','en') text follows the instant toggle.
window.addEventListener('orshap-lang-changed', () => {
  if (OW.currentPage) reloadCurrentPage();
});

// Deep links and back/forward navigation: #page selects a registered page.
window.addEventListener('hashchange', () => {
  const name = (location.hash || '').replace('#', '');
  if (!name || name === OW.currentPage) return;
  if (OW.pages[name]) showPage(name);
});

window.showPage = showPage;
