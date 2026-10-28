// ============================================================================
// OW — user menu
// ============================================================================
import { currentUser } from './core-auth.js';
import { tx, toggleLang } from './core-i18n.js';
import { roleLabel } from './core-utils.js';

export function renderUserMenu() {
  const u = currentUser();
  document.getElementById('userMenu').innerHTML = `
    <div class="o_user_menu_head">
      <div class="o_user_avatar">${String(u?.name || '?').trim().slice(0, 1).toUpperCase()}</div>
      <div>
        <b>${u?.name || tx('زائر', 'Guest')}</b>
        <small>${roleLabel(u?.role)}${u?.offline ? ' • ' + tx('دون اتصال', 'Offline') : ''}</small>
      </div>
    </div>
    <hr>
    <a onclick="showPage('profile')"><i class="fa-solid fa-user"></i> ${tx('الملف الشخصي', 'Profile')}</a>
    <a onclick="showPage('settings')"><i class="fa-solid fa-gear"></i> ${tx('الإعدادات', 'Settings')}</a>
    <a onclick="showPage('sync')"><i class="fa-solid fa-rotate"></i> ${tx('المزامنة', 'Synchronization')}</a>
    <a onclick="window.__toggleLang()" data-no-i18n><i class="fa-solid fa-language"></i> ${tx('الإنجليزية', 'Arabic')}</a>
    <a onclick="showPage('about')"><i class="fa-solid fa-circle-info"></i> ${tx('حول النظام', 'About')}</a>
    <hr>
    <a onclick="window.__logout()" class="danger"><i class="fa-solid fa-right-from-bracket"></i> ${tx('تسجيل الخروج', 'Sign out')}</a>`;
}

window.__toggleLang = () => {
  toggleLang();
};

document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  const apps = document.getElementById('appsPanel');
  if (menu && !menu.contains(e.target) && !e.target.closest('#userToggle') && !e.target.closest('#mobileMore')) menu.classList.remove('open');
  if (apps && !apps.contains(e.target) && !e.target.closest('#appsToggle')) apps.classList.remove('open');
});
