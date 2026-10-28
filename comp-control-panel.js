import { tx } from './core-i18n.js';

export function controlPanel({ breadcrumb = [], search = true, buttons = '', views = null }) {
  const crumbs = breadcrumb.map((c, i) => {
    const isLast = i === breadcrumb.length - 1;
    const link = isLast ? `<span class="current">${c.label}</span>`
                        : `<a onclick="showPage('${c.page}')">${c.label}</a>`;
    return link + (isLast ? '' : '<span class="sep">/</span>');
  }).join('');
  return `
    <div class="o_control_panel">
      <div class="o_cp_top">
        <div class="o_breadcrumb">${crumbs}</div>
        ${search ? `<div class="o_search">
          <i class="fa-solid fa-magnifying-glass" style="color:#9ca3af;font-size:12px"></i>
          <input type="text" placeholder="${tx('بحث...', 'Search...')}">
        </div>` : ''}
      </div>
      <div class="o_cp_bottom">
        <div class="o_cp_buttons">${buttons}</div>
        ${views ? `<div class="o_view_switch">${views}</div>` : ''}
      </div>
    </div>`;
}