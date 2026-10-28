// ============================================================================
// OW - UI kit (warehouse primitives)
// All helpers return HTML strings so pages stay declarative and fast.
// ============================================================================
import { tx, isAr } from './core-i18n.js';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
export const e = esc;

/* ── layout ─────────────────────────────────────────────────────────────── */

export function pageHead(title, subtitle = '', actions = '') {
  return `<div class="o_page_head">
    <div class="o_page_head_titles">
      <h1 class="o_page_title">${esc(title)}</h1>
      ${subtitle ? `<p class="o_page_subtitle">${esc(subtitle)}</p>` : ''}
    </div>
    ${actions ? `<div class="o_page_actions">${actions}</div>` : ''}
  </div>`;
}

export function controlPanel({ title, breadcrumb = [], actions = '', search = true, searchPlaceholder = '', filters = '', views = [], more = '' } = {}) {
  const crumb = breadcrumb.length
    ? `<nav class="o_breadcrumb">${breadcrumb.map((b, i) => {
        if (i === breadcrumb.length - 1) return `<span class="current">${esc(b.label ?? b)}</span>`;
        return `${b.page ? `<a onclick="showPage('${b.page}')">${esc(b.label)}</a>` : `<span>${esc(b.label)}</span>`}<span class="sep">/</span>`;
      }).join('')}</nav>`
    : `<nav class="o_breadcrumb"><span class="current">${esc(title || '')}</span></nav>`;

  return `<div class="o_control_panel">
    <div class="o_cp_top">
      ${crumb}
      <div class="o_cp_buttons">${more}${actions}</div>
    </div>
    <div class="o_cp_bottom">
      <div class="o_cp_filters">
        ${search ? `<div class="o_search"><i class="fa-solid fa-magnifying-glass"></i><input id="oSearchInput" placeholder="${esc(searchPlaceholder || tx('بحث...', 'Search...'))}" autocomplete="off"></div>` : ''}
        ${filters}
      </div>
      <div class="o_cp_views">
        ${views.length ? `<div class="o_view_switch">${views.map(v => `<button class="${v.active ? 'active' : ''}" title="${esc(v.label)}" onclick="${v.onclick || ''}"><i class="${v.icon}"></i></button>`).join('')}</div>` : ''}
      </div>
    </div>
  </div>`;
}

export function card(title, body, actions = '', cls = '') {
  return `<section class="o_card ${cls}">
    ${title || actions ? `<div class="o_card_head">
      <div class="o_card_title">${title || ''}</div>
      <div class="o_card_actions">${actions}</div>
    </div>` : ''}
    <div class="o_card_body">${body}</div>
  </section>`;
}

export function statCard({ label, value, note = '', icon = 'fa-solid fa-cube', tone = 'purple', href = '' }) {
  return `<div class="o_stat o_stat_${tone}" ${href ? `onclick="showPage('${href}')" role="button" tabindex="0"` : ''}>
    <div class="o_stat_icon"><i class="${icon}"></i></div>
    <div class="o_stat_body">
      <div class="o_stat_label">${esc(label)}</div>
      <div class="o_stat_value">${esc(value)}</div>
      ${note ? `<div class="o_stat_note">${esc(note)}</div>` : ''}
    </div>
  </div>`;
}

export function empty(title = tx('لا توجد بيانات', 'No data'), note = '', icon = 'fa-regular fa-folder-open') {
  return `<div class="o_empty"><i class="${icon}"></i><strong>${esc(title)}</strong>${note ? `<span>${esc(note)}</span>` : ''}</div>`;
}

export function grid(cols, html, gap = 16) {
  return `<div class="o_grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr));gap:${gap}px">${html}</div>`;
}

/* ── table ──────────────────────────────────────────────────────────────── */

export function table(headers, rows = [], opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const head = headers.map(h => {
    const label = typeof h === 'string' ? h : h.label;
    const num = typeof h === 'object' && h.num;
    return `<th class="${num ? 'num' : ''}" ${h.width ? `style="width:${h.width}"` : ''}>${esc(label)}</th>`;
  }).join('');
  const body = list.length
    ? list.map(r => {
        if (typeof r === 'string') return r;
        return `<tr ${r.id ? `data-id="${esc(r.id)}"` : ''} ${r.onclick ? `onclick="${r.onclick}"` : ''} class="${r.cls || ''}">
          ${(r.cells || r).map((c, i) => {
            const h = headers[i];
            const num = typeof h === 'object' && h.num;
            return `<td class="${num ? 'num' : ''}">${c ?? ''}</td>`;
          }).join('')}
        </tr>`;
      }).join('')
    : `<tr><td colspan="${headers.length}">${empty(opts.emptyTitle || tx('لا توجد بيانات', 'No data'), opts.emptyNote || '')}</td></tr>`;
  return `<div class="o_list_wrap"><table class="o_list_table ${opts.cls || ''}">
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export const badge = (text, tone = 'gray') => `<span class="o_badge o_badge_${tone}">${esc(text)}</span>`;

const STATUS_TONES = {
  APPROVED: 'green', RECEIVED: 'green', COMPLETED: 'green', CLOSED: 'gray',
  SYNCED: 'green', POSTED: 'green', ACTIVE: 'green',
  PENDING_APPROVAL: 'orange', PENDING_REVIEW: 'orange', PENDING: 'orange',
  SUBMITTED: 'blue', IN_PROGRESS: 'blue', IN_TRANSIT: 'blue', PENDING_SYNC: 'purple',
  PARTIALLY_RECEIVED: 'blue', RETURN_IN_TRANSIT: 'orange',
  REJECTED: 'red', CANCELLED: 'red', ERROR: 'red', CONFLICT: 'red', FAILED: 'red',
  DRAFT: 'gray', RETURNED_TO_SOURCE: 'gray', OPEN: 'blue', ARCHIVED: 'gray'
};
export const statusBadge = (status, label) =>
  badge(label || status || '—', STATUS_TONES[String(status || '').toUpperCase()] || 'gray');

export function statusbar(steps, current) {
  const idx = steps.findIndex(s => s.value === current);
  return `<div class="o_statusbar">${steps.map((s, i) => `
    <div class="step ${i === idx ? 'active' : i < idx ? 'done' : ''}" title="${esc(s.label)}">${esc(s.label)}</div>`).join('')}</div>`;
}

/* ── forms ──────────────────────────────────────────────────────────────── */

export function field(label, control, { full = false, hint = '', required = false, cls = '' } = {}) {
  return `<div class="o_field ${full ? 'full' : ''} ${cls}">
    <label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${control}
    ${hint ? `<small class="o_hint">${esc(hint)}</small>` : ''}
  </div>`;
}

export function input({ name, label, value = '', type = 'text', placeholder = '', required = false, full = false, attrs = '', hint = '' }) {
  return field(label, `<input class="o_form_input" name="${esc(name)}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${attrs}>`,
    { full, required, hint });
}

export function textarea({ name, label, value = '', rows = 3, full = true, placeholder = '' }) {
  return field(label, `<textarea class="o_form_input" name="${esc(name)}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`, { full });
}

export function select({ name, label, options = [], value = '', required = false, full = false, attrs = '', placeholder = '' }) {
  const opts = options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? (o.label ?? o.value) : o;
    return `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
  }).join('');
  return field(label, `<select class="o_form_input" name="${esc(name)}" ${required ? 'required' : ''} ${attrs}>
    ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}${opts}
  </select>`, { full, required });
}

export function formValues(formEl) {
  if (!formEl) return {};
  return Object.fromEntries(new FormData(formEl).entries());
}

export function tabs(items, active) {
  return `<div class="o_notebook">${items.map(t => `
    <div class="o_notebook_tab ${t.value === active ? 'active' : ''}" onclick="${t.onclick}">
      ${esc(t.label)}${t.count != null ? `<span class="o_tab_count">${t.count}</span>` : ''}
    </div>`).join('')}</div>`;
}

/* ── feedback / actions ─────────────────────────────────────────────────── */

export const btn = (label, attrs = '', tone = 'secondary', icon = '') =>
  `<button class="o_btn o_btn_${tone}" ${attrs}>${icon ? `<i class="${icon}"></i>` : ''}${label ? `<span>${label}</span>` : ''}</button>`;

export const iconBtn = (icon, attrs = '', title = '') =>
  `<button class="o_btn o_btn_ghost o_icon_btn" ${attrs} title="${esc(title)}"><i class="${icon}"></i></button>`;

export function loadingRow(text = tx('جارٍ التحميل...', 'Loading...')) {
  return `<div class="o_loading"><div class="o_spinner"></div><span>${esc(text)}</span></div>`;
}

export function alertBox(text, tone = 'info') {
  return `<div class="o_alert o_alert_${tone}"><i class="fa-solid ${tone === 'danger' ? 'fa-triangle-exclamation' : tone === 'warning' ? 'fa-circle-exclamation' : 'fa-circle-info'}"></i><div>${text}</div></div>`;
}

/* ── export helpers ─────────────────────────────────────────────────────── */

export function downloadCSV(filename, headers, rows) {
  const csv = '\ufeff' + [headers, ...rows]
    .map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 600);
}

export function printHTML(title, bodyHTML, { landscape = true, subtitle = '' } = {}) {
  const ar = isAr();
  const html = `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head>
    <meta charset="utf-8"><title>${esc(title)}</title>
    <style>
      body{font-family:Arial,Tahoma,sans-serif;padding:22px;color:#1f2937}
      h1{font-size:20px;margin:0 0 4px}
      .sub{color:#6b7280;font-size:12px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th,td{border:1px solid #cbd5e1;padding:6px 7px;text-align:start;vertical-align:top}
      th{background:#f1eef3;color:#4b2f45}
      thead{display:table-header-group}tr{break-inside:avoid}
      .badge{border-radius:9px;padding:1px 6px;background:#eee}
      @page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:10mm}
      @media print{body{padding:0}}
    </style></head><body>
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle || new Date().toLocaleString('en-GB'))}</div>
    ${bodyHTML}
  </body></html>`;
  return printDocument(html);
}

/**
 * Open a print window, write a full HTML document and trigger printing once
 * the document (and its fonts) has actually laid out. Using a load signal plus
 * a bounded safety timer avoids both blank pages and the old fixed delays.
 */
export function printDocument(html) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  printWhenReady(w);
  return true;
}

function printWhenReady(w) {
  let printed = false;
  const trigger = () => {
    if (printed) return;
    printed = true;
    try {
      w.focus();
      w.print();
    } catch (_) { /* window closed before printing */ }
  };

  const afterLayout = () => {
    const raf = typeof w.requestAnimationFrame === 'function'
      ? cb => w.requestAnimationFrame(cb)
      : cb => w.setTimeout(cb, 16);
    raf(() => raf(trigger));
  };

  const onLoaded = () => {
    const fonts = w.document?.fonts?.ready;
    if (fonts && typeof fonts.then === 'function') {
      fonts.then(afterLayout).catch(afterLayout);
    } else {
      afterLayout();
    }
    // Safety net: never leave the print window hanging if a font or image
    // never resolves its readiness promise.
    try { w.setTimeout(trigger, 1200); } catch (_) { trigger(); }
  };

  if (w.document.readyState === 'complete') onLoaded();
  else {
    try { w.addEventListener('load', onLoaded, { once: true }); }
    catch (_) { w.onload = onLoaded; }
  }
}

export function fmt(n, digits = 2) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
}
