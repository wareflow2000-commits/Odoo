// ============================================================================
// OW — full-screen apps home
// ============================================================================
import { appsList } from './ui-apps-panel.js';
import { tx } from './core-i18n.js';

export default {
  name: 'apps',
  brand: { name: 'OW', icon: 'fa-solid fa-grip' },
  menu: [],
  render() {
    return `
      <div class="o_apps_home">
        <div class="o_apps_home_head">
          <h1>${tx('التطبيقات', 'Apps')}</h1>
          <p>${tx('اختر تطبيقاً للبدء', 'Choose an app to get started')}</p>
        </div>
        <div class="o_apps_home_search">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input id="appsHomeSearch" type="text" autocomplete="off"
            placeholder="${tx('ابحث عن تطبيق…', 'Search apps…')}">
        </div>
        <div class="o_apps_home_grid" id="appsHomeGrid">
          ${appsList().map(a => `
            <a class="o_apps_home_item" data-search="${`${a.name} ${a.desc || ''}`.toLowerCase()}"
               onclick="showPage('${a.page}')">
              <span class="o_apps_home_icon" style="background:${a.color}"><i class="${a.icon}"></i></span>
              <span class="o_apps_home_name">${a.name}</span>
              <small>${a.desc || ''}</small>
            </a>`).join('')}
        </div>
        <div class="o_apps_home_empty" id="appsHomeEmpty" style="display:none">
          <i class="fa-regular fa-folder-open"></i>
          <p>${tx('لا توجد نتائج', 'No results')}</p>
        </div>
      </div>`;
  },
  mount() {
    const input = document.getElementById('appsHomeSearch');
    const grid = document.getElementById('appsHomeGrid');
    const empty = document.getElementById('appsHomeEmpty');
    if (!input || !grid) return;
    const items = Array.from(grid.querySelectorAll('.o_apps_home_item'));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let visible = 0;
      for (const el of items) {
        const show = !q || (el.dataset.search || '').includes(q);
        el.style.display = show ? '' : 'none';
        if (show) visible++;
      }
      if (empty) empty.style.display = visible ? 'none' : 'block';
    });
  }
};
