// ============================================================================
// OW — apps launcher
// ============================================================================
import { tx } from './core-i18n.js';

export function appsList() {
  return [
    { name: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard', icon: 'fa-solid fa-gauge-high', color: '#714B67', desc: tx('نظرة تشغيلية', 'Operational overview') },
    { name: tx('المناقشات', 'Discuss'), page: 'discuss', icon: 'fa-regular fa-comments', color: '#5B899E', desc: tx('محادثات الفريق', 'Team chat') },
    { name: tx('التقويم', 'Calendar'), page: 'calendar', icon: 'fa-regular fa-calendar', color: '#985184', desc: tx('المواعيد والأحداث', 'Events & meetings') },
    { name: tx('المخزون', 'Inventory'), page: 'inventory', icon: 'fa-solid fa-boxes-stacked', color: '#985184', desc: tx('الأصناف والأرصدة', 'Items & balances') },
    { name: tx('المعاملات', 'Transactions'), page: 'transactions', icon: 'fa-solid fa-right-left', color: '#875A7B', desc: tx('توريد وصرف وتسويات', 'Receipts, issues & adjustments') },
    { name: tx('التحويلات', 'Transfers'), page: 'transfers', icon: 'fa-solid fa-truck-arrow-right', color: '#a24689', desc: tx('بين المستودعات', 'Between warehouses') },
    { name: tx('الجرد', 'Stocktake'), page: 'stocktake', icon: 'fa-solid fa-clipboard-check', color: '#5B899E', desc: tx('الجرد والتسويات', 'Counts & reconciliation') },
    { name: tx('المستودعات', 'Facilities'), page: 'facilities', icon: 'fa-solid fa-warehouse', color: '#5B899E', desc: tx('المواقع والتخزين', 'Locations & storage') },
    { name: tx('التقارير', 'Reports'), page: 'reports', icon: 'fa-solid fa-chart-line', color: '#a24689', desc: tx('الحركات والأرصدة', 'Movements & balances') },
    { name: tx('المزامنة', 'Synchronization'), page: 'sync', icon: 'fa-solid fa-rotate', color: '#7C6B8A', desc: tx('قائمة الانتظار', 'Offline queue') },
    { name: tx('الإعدادات', 'Settings'), page: 'settings', icon: 'fa-solid fa-gear', color: '#5B899E', desc: tx('المستخدمون والنظام', 'Users & system') },
    { name: tx('الملف', 'Profile'), page: 'profile', icon: 'fa-regular fa-circle-user', color: '#714B67', desc: tx('حسابي', 'My account') },
    { name: tx('حول النظام', 'About'), page: 'about', icon: 'fa-solid fa-circle-info', color: '#6B7280', desc: tx('معلومات الإصدار', 'Version information') }
  ];
}

export function renderAppsPanel() {
  document.getElementById('appsPanel').innerHTML = `
    <div class="o_apps_header">${tx('التطبيقات', 'Apps')}</div>
    <div class="o_apps_grid">
      ${appsList().map(a => `
        <a class="o_app_item" onclick="showPage('${a.page}')">
          <div class="o_app_icon" style="background:${a.color}"><i class="${a.icon}"></i></div>
          <span class="o_app_name">${a.name}</span>
          <small>${a.desc}</small>
        </a>`).join('')}
    </div>`;
}

export function renderQuickSearch() {
  // Lightweight command palette: pages + items + warehouses.
  import('./core-store.js').then(({ store, itemLabel }) => {
    const pages = appsList().map(a => ({ type: 'page', label: a.name, hint: a.desc, page: a.page }));
    const items = store.get('items').slice(0, 60).map(i => ({
      type: 'item', label: itemLabel(i), hint: i.code, page: 'inventory'
    }));
    const whs = store.get('warehouses').map(w => ({
      type: 'warehouse', label: w.name, hint: w.code, page: 'facilities'
    }));
    const all = [...pages, ...whs, ...items];
    const root = document.getElementById('modalRoot');
    const overlay = document.createElement('div');
    overlay.className = 'o_modal_overlay o_palette_overlay';
    overlay.innerHTML = `<div class="o_palette">
      <div class="o_palette_input"><i class="fa-solid fa-magnifying-glass"></i>
        <input id="paletteInput" placeholder="${tx('ابحث عن صفحة أو صنف أو مستودع…', 'Search a page, item or warehouse…')}" autocomplete="off">
        <kbd>Esc</kbd>
      </div>
      <div class="o_palette_results" id="paletteResults"></div>
    </div>`;
    root.appendChild(overlay);
    const input = overlay.querySelector('#paletteInput');
    const results = overlay.querySelector('#paletteResults');
    const close = () => overlay.remove();
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const list = all.filter(x => !q || `${x.label} ${x.hint}`.toLowerCase().includes(q)).slice(0, 12);
      results.innerHTML = list.length ? list.map(x => `
        <button class="o_palette_item" data-page="${x.page}">
          <span class="o_palette_type">${x.type === 'page' ? '<i class="fa-solid fa-square"></i>' : x.type === 'warehouse' ? '<i class="fa-solid fa-warehouse"></i>' : '<i class="fa-solid fa-cube"></i>'}</span>
          <span class="o_palette_label">${x.label}</span>
          <small>${x.hint || ''}</small>
        </button>`).join('') : `<div class="o_empty">${tx('لا توجد نتائج', 'No results')}</div>`;
      results.querySelectorAll('[data-page]').forEach(b => b.onclick = () => {
        close(); window.showPage(b.dataset.page);
      });
    };
    input.addEventListener('input', draw);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { results.querySelector('[data-page]')?.click(); }
    });
    draw();
    setTimeout(() => input.focus(), 30);
  });
}
