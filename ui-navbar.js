// ============================================================================
// OW — top navbar
// ============================================================================
import { OW } from './core-registry.js';
import { currentUser } from './core-auth.js';
import { tx, LANG, toggleLang } from './core-i18n.js';
import { queueSnapshot } from './core-store.js';
import { isSoundMuted, syncSoundControls } from './core-sound.js';

const MOBILE_ITEMS = [
  { page: 'apps',        icon: 'fa-solid fa-grip',            ar: 'التطبيقات',    en: 'Apps' },
  { page: 'dashboard',   icon: 'fa-solid fa-gauge-high',      ar: 'لوحة التحكم', en: 'Dashboard' },
  { scan: true,          icon: 'fa-solid fa-qrcode',          ar: 'مسح',          en: 'Scan' },
  { page: 'calendar',    icon: 'fa-regular fa-calendar',      ar: 'التقويم',      en: 'Calendar' },
  { page: 'inventory',   icon: 'fa-solid fa-boxes-stacked',   ar: 'المخزون',      en: 'Inventory' },
  { more: true,          icon: 'fa-solid fa-ellipsis',        ar: 'المزيد',       en: 'More' }
];

function mobileNavHTML() {
  return MOBILE_ITEMS.map(item => {
    const attrs = item.more
      ? 'id="mobileMore"'
      : item.scan
        ? 'id="mobileScan" onclick="OW.wms.quickScan && OW.wms.quickScan()"'
        : `onclick="showPage('${item.page}')"`;
    return `
    <button class="o_mobile_nav_item ${item.scan ? 'o_mobile_nav_scan' : ''}" data-mobile-page="${item.page || ''}" ${attrs}
      title="${tx(item.ar, item.en)}" aria-label="${tx(item.ar, item.en)}">
      <i class="${item.icon}"></i>
      <span>${tx(item.ar, item.en)}</span>
    </button>`;
  }).join('');
}

export function updateMobileNav(current = OW.currentPage) {
  const nav = document.getElementById('mobileNav');
  if (!nav) return;
  const mainPages = new Set(MOBILE_ITEMS.filter(i => i.page).map(i => i.page));
  nav.querySelectorAll('[data-mobile-page]').forEach(btn => {
    const page = btn.dataset.mobilePage;
    const isScan = btn.id === 'mobileScan';
    const active = isScan
      ? false
      : page
        ? (current === page || (page === 'inventory' && ['inventory-form', 'stocktake', 'facilities'].includes(current)))
        : !mainPages.has(current) && current !== 'apps';
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function renderMobileNav() {
  const nav = document.getElementById('mobileNav');
  if (!nav) return;
  nav.innerHTML = mobileNavHTML();
  const more = document.getElementById('mobileMore');
  if (more) {
    more.onclick = e => {
      e.stopPropagation();
      document.getElementById('userMenu').classList.toggle('open');
      document.getElementById('appsPanel').classList.remove('open');
    };
  }
  updateMobileNav();
}

export function renderNavbar() {
  const u = currentUser();
  const pending = queueSnapshot().filter(x => x.status !== 'SYNCED').length;
  const online = navigator.onLine;

  document.getElementById('navbar').innerHTML = `
    <div class="o_nav_left">
      <button class="o_nav_btn" id="appsToggle" title="${tx('التطبيقات', 'Apps')}">
        <i class="fa-solid fa-grip"></i>
      </button>
      <button class="o_nav_btn o_nav_home" onclick="showPage('apps')" title="${tx('التطبيقات', 'Apps')}">
        <i class="fa-solid fa-house"></i>
      </button>
      <span class="o_nav_brand" id="navBrand" onclick="showPage('apps')" title="OW">
        <img src="assets/logo.png" alt="OW" class="o_nav_logo">
      </span>
    </div>

    <div class="o_nav_center">
      <button class="o_nav_search" onclick="OW.openSearch?.()">
        <i class="fa-solid fa-magnifying-glass"></i>
        <span>${tx('بحث سريع…', 'Quick search…')}</span>
        <kbd>Ctrl K</kbd>
      </button>
    </div>

    <div class="o_nav_right">
      <span class="o_net ${online ? 'online' : 'offline'}" id="netStatus" title="${online ? tx('متصل', 'Online') : tx('غير متصل', 'Offline')}">
        <span class="dot"></span>
        <span class="label">${online ? tx('متصل', 'Online') : tx('غير متصل', 'Offline')}</span>
      </span>
      <button class="o_nav_btn" onclick="showPage('sync')" title="${tx('المزامنة', 'Synchronization')}">
        <i class="fa-solid fa-rotate"></i>
        ${pending ? `<span class="o_nav_badge">${pending > 99 ? '99+' : pending}</span>` : ''}
      </button>
      <button class="o_nav_btn" data-sound-toggle aria-pressed="${isSoundMuted()}"
        title="${isSoundMuted() ? tx('تشغيل الأصوات', 'Unmute sounds') : tx('كتم الأصوات', 'Mute sounds')}"
        aria-label="${tx('الأصوات', 'Sounds')}">
        <i class="fa-solid ${isSoundMuted() ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>
      </button>
      <button class="o_nav_btn" id="langToggle" title="${tx('التبديل إلى الإنجليزية', 'Switch to Arabic')}" aria-label="${tx('تغيير اللغة', 'Change language')}">
        <i class="fa-solid fa-language"></i>
        <span class="o_nav_lang">${LANG === 'ar' ? 'EN' : 'AR'}</span>
      </button>
      <button class="o_nav_btn o_nav_reports" onclick="showPage('reports')" title="${tx('التقارير', 'Reports')}">
        <i class="fa-solid fa-chart-line"></i>
      </button>
      <button class="o_nav_btn o_nav_profile" onclick="showPage('profile')" title="${tx('الملف الشخصي', 'Profile')}">
        ${u?.name
          ? `<span class="o_nav_avatar">${String(u.name).trim().slice(0, 1).toUpperCase()}</span>`
          : `<i class="fa-regular fa-circle-user"></i>`}
      </button>
      <button class="o_nav_btn o_nav_user" id="userToggle" title="${tx('القائمة', 'Menu')}">
        <i class="fa-solid fa-ellipsis-vertical"></i>
      </button>
    </div>`;

  renderMobileNav();

  document.getElementById('appsToggle').onclick = e => {
    e.stopPropagation();
    document.getElementById('appsPanel').classList.toggle('open');
    document.getElementById('userMenu').classList.remove('open');
  };
  document.getElementById('userToggle').onclick = e => {
    e.stopPropagation();
    document.getElementById('userMenu').classList.toggle('open');
    document.getElementById('appsPanel').classList.remove('open');
  };
  document.getElementById('langToggle').onclick = e => {
    e.stopPropagation();
    toggleLang();
  };
  syncSoundControls();
}

OW.closeAllPanels = () => {
  document.getElementById('appsPanel')?.classList.remove('open');
  document.getElementById('userMenu')?.classList.remove('open');
};
OW.updateMobileNav = updateMobileNav;

window.addEventListener('online', renderNavbar);
window.addEventListener('offline', renderNavbar);
window.addEventListener('orshap-master-queue-changed', renderNavbar);
window.addEventListener('orshap-outbox-changed', renderNavbar);
