// ============================================================================
// OW — searchable item selects
// ----------------------------------------------------------------------------
// Only item fields stay searchable. Each item <select> keeps its native
// element, value, name, FormData entry and change event; a compact combobox is
// layered on top so the user can type to filter a long item list.
// Every other dropdown remains a normal native select.
// ============================================================================
import { tx } from './core-i18n.js';

const MARK = 'owSs';
let active = null;
let refreshTimer = 0;

function isItemSelect(select) {
  const key = select.getAttribute('name') || select.dataset.k || select.id || '';
  return key === 'item_id' || key === 'itemId' || key === 'convItem' || key === 'item' || key === 'scanLine';
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const norm = value => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u064B-\u0652\u0670]/g, '')
  .toLocaleLowerCase()
  .trim();

function optionText(option) {
  return String(option?.label || option?.textContent || option?.value || '').replace(/\s+/g, ' ').trim();
}

function fieldLabel(select) {
  const holder = select.closest('.o_field');
  const label = holder?.querySelector('label');
  return label ? label.textContent.replace(/\*/g, '').trim() : '';
}

function refreshSelect(select) {
  if (!select || select.tagName !== 'SELECT') return;
  const wrap = select.closest('.o_ss');
  if (!wrap || !wrap.isConnected) return;
  const trigger = wrap.querySelector('.o_ss_trigger');
  const valueEl = wrap.querySelector('.o_ss_value');
  if (!trigger || !valueEl) return;

  const disabled = !!select.disabled;
  const current = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
  const text = current ? optionText(current) : '';
  valueEl.textContent = text || tx('اختر…', 'Select…');
  wrap.classList.toggle('is-disabled', disabled);
  trigger.disabled = disabled;
  trigger.setAttribute('aria-label', fieldLabel(select) || select.name || tx('قائمة', 'List'));
  trigger.setAttribute('aria-expanded', active?.select === select ? 'true' : 'false');
  wrap.classList.toggle('is-empty', !select.value && !text);
}

function refreshAll(root = document) {
  const list = root.querySelectorAll?.('select[data-ow-ss="1"]') || [];
  for (const select of list) refreshSelect(select);
}

function closePanel({ focus = false } = {}) {
  if (!active) return;
  const { panel, trigger, wrap, select } = active;
  active = null;
  if (panel) panel.hidden = true;
  wrap?.classList.remove('is-open');
  trigger?.setAttribute('aria-expanded', 'false');
  if (focus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  if (select?.isConnected) refreshSelect(select);
}

function positionPanel(panel, trigger) {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const margin = 8;
  const mobile = vw <= 760;

  panel.style.position = 'fixed';
  panel.style.zIndex = '4200';
  if (mobile) {
    // The on-screen keyboard resizes the visual viewport on phones. Lift the
    // sheet above it and size it against the visible area so focusing the
    // search field never hides the list (the old code closed it on resize).
    const vv = window.visualViewport;
    const visualHeight = vv?.height || vh;
    const keyboardInset = vv ? Math.max(0, vh - vv.height - vv.offsetTop) : 0;
    panel.classList.add('o_ss_panel_sheet');
    panel.style.left = margin + 'px';
    panel.style.right = margin + 'px';
    panel.style.width = 'auto';
    panel.style.top = 'auto';
    panel.style.bottom = `calc(${margin + keyboardInset}px + env(safe-area-inset-bottom))`;
    panel.style.maxHeight = `${Math.min(460, Math.max(180, visualHeight * 0.62))}px`;
    return;
  }

  panel.classList.remove('o_ss_panel_sheet');
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  const width = Math.min(Math.max(rect.width, 240), vw - margin * 2);
  let left = rect.left;
  if (left + width > vw - margin) left = vw - width - margin;
  left = Math.max(margin, left);
  const estimated = Math.min(320, Math.max(190, vh * 0.42));
  let top = rect.bottom + 6;
  if (top + estimated > vh - margin) top = Math.max(margin, rect.top - estimated - 6);
  panel.style.left = left + 'px';
  panel.style.width = width + 'px';
  panel.style.top = top + 'px';
  panel.style.maxHeight = Math.min(360, vh - margin * 2) + 'px';
}

function renderList(select, panel, query = '') {
  const list = panel.querySelector('.o_ss_list');
  const input = panel.querySelector('.o_ss_search');
  if (!list) return;
  const q = norm(query);
  const selectedIndex = select.selectedIndex;
  const options = [...select.options]
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !option.disabled)
    .filter(({ option }) => {
      if (!q) return true;
      return norm(optionText(option)).includes(q) || norm(option.value).includes(q);
    });

  list.innerHTML = '';
  if (!options.length) {
    list.innerHTML = `<div class="o_ss_empty"><i class="fa-regular fa-face-frown"></i><span>${esc(tx('لا توجد نتائج مطابقة', 'No matching options'))}</span></div>`;
    return;
  }

  let highlighted = options.findIndex(({ index }) => index === selectedIndex);
  if (highlighted < 0) highlighted = 0;

  const frag = document.createDocumentFragment();
  options.forEach(({ option, index }, pos) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'o_ss_option';
    item.dataset.idx = String(index);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
    if (index === selectedIndex) item.classList.add('is-selected');
    if (pos === highlighted) item.classList.add('is-active');
    item.innerHTML = `<span class="o_ss_opt_text"></span><i class="fa-solid fa-check o_ss_opt_check" aria-hidden="true"></i>`;
    item.querySelector('.o_ss_opt_text').textContent = optionText(option);
    frag.appendChild(item);
  });
  list.appendChild(frag);
  panel.dataset.highlight = String(highlighted);
  if (input) input.setAttribute('aria-activedescendant', '');
}

function moveHighlight(panel, delta) {
  const options = [...panel.querySelectorAll('.o_ss_option')];
  if (!options.length) return;
  let current = options.findIndex(o => o.classList.contains('is-active'));
  if (current < 0) current = 0;
  const next = Math.max(0, Math.min(options.length - 1, current + delta));
  options.forEach((o, i) => o.classList.toggle('is-active', i === next));
  panel.dataset.highlight = String(next);
  options[next].scrollIntoView({ block: 'nearest' });
}

function choose(select, index) {
  const option = select.options[index];
  if (!option || option.disabled) return;
  select.selectedIndex = index;
  refreshSelect(select);
  closePanel({ focus: true });
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function openPanel(select, { query = '' } = {}) {
  const wrap = select.closest('.o_ss');
  const panel = wrap?.querySelector('.o_ss_panel');
  const trigger = wrap?.querySelector('.o_ss_trigger');
  const input = panel?.querySelector('.o_ss_search');
  if (!wrap || !panel || !trigger) return;
  if (select.disabled) return;
  if (active?.select === select && !panel.hidden) return;

  closePanel();
  refreshSelect(select);
  input.value = query;
  renderList(select, panel, query);
  positionPanel(panel, trigger);
  panel.hidden = false;
  wrap.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');
  active = { select, wrap, panel, trigger };
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    input.select?.();
  });
}

function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.multiple) return;
  if (!isItemSelect(select)) return;
  if (select.dataset[MARK] === '1') return;
  if (select.closest('.o_ss')) { select.dataset[MARK] = '1'; return; }

  const wrap = document.createElement('div');
  wrap.className = 'o_ss' + (select.classList.contains('o_filter_select') ? ' o_ss_filter' : '');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'o_ss_trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<span class="o_ss_value"></span><i class="fa-solid fa-chevron-down o_ss_chevron" aria-hidden="true"></i>`;

  const panel = document.createElement('div');
  panel.className = 'o_ss_panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="o_ss_search_box">
      <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input class="o_ss_search" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(tx('اكتب للبحث…', 'Type to search…'))}" aria-label="${esc(tx('بحث في القائمة', 'Search list'))}">
      <button type="button" class="o_ss_clear" aria-label="${esc(tx('مسح البحث', 'Clear search'))}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="o_ss_list" role="listbox"></div>`;

  const parent = select.parentNode;
  if (!parent) return;
  select.dataset[MARK] = '1';
  parent.insertBefore(wrap, select);
  wrap.appendChild(select);
  wrap.appendChild(trigger);
  wrap.appendChild(panel);
  select.classList.add('o_ss_native');
  select.setAttribute('tabindex', '-1');

  trigger.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (active?.select === select) closePanel({ focus: true });
    else openPanel(select);
  });
  trigger.addEventListener('keydown', event => {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      openPanel(select);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      openPanel(select, { query: event.key });
    }
  });

  select.addEventListener('change', () => refreshSelect(select));
  select.addEventListener('focus', () => refreshSelect(select));

  const input = panel.querySelector('.o_ss_search');
  const clear = panel.querySelector('.o_ss_clear');
  input.addEventListener('input', () => renderList(select, panel, input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveHighlight(panel, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveHighlight(panel, -1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const options = [...panel.querySelectorAll('.o_ss_option')];
      const activeOption = panel.querySelector('.o_ss_option.is-active') || options[0];
      if (activeOption) choose(select, Number(activeOption.dataset.idx));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePanel({ focus: true });
    } else if (event.key === 'Tab') {
      closePanel();
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    renderList(select, panel, '');
    input.focus();
  });
  panel.querySelector('.o_ss_list').addEventListener('click', event => {
    const option = event.target.closest('.o_ss_option');
    if (option) choose(select, Number(option.dataset.idx));
  });

  refreshSelect(select);
}

function scan(root = document) {
  if (!root || root.nodeType !== 1) return;
  if (root.tagName === 'SELECT') enhanceSelect(root);
  root.querySelectorAll?.('select').forEach(enhanceSelect);
}

export function enhanceSearchableSelects(root = document) {
  scan(root);
}

export function refreshSearchableSelects(root = document) {
  refreshAll(root);
}

export function closeSearchableSelect() {
  closePanel();
}

function scheduleRefresh(select) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshSelect(select), 0);
}

function start() {
  if (typeof document === 'undefined') return;
  scan(document.body);

  document.addEventListener('pointerdown', event => {
    if (!active) return;
    if (active.wrap.contains(event.target) || active.panel.contains(event.target) || active.trigger.contains(event.target)) return;
    closePanel();
  }, true);

  const repositionActivePanel = () => {
    if (!active || !active.panel?.isConnected) return;
    positionPanel(active.panel, active.trigger);
  };

  window.addEventListener('resize', () => {
    if (!active) return;
    // A phone keyboard opens as a viewport resize. Keep the panel open while
    // its search field is focused and simply move the sheet.
    if (active.panel.contains(document.activeElement)) { repositionActivePanel(); return; }
    closePanel();
  });
  window.addEventListener('scroll', event => {
    if (!active) return;
    if (active.panel.contains(event.target) || active.panel.contains(document.activeElement)) return;
    closePanel();
  }, true);
  window.visualViewport?.addEventListener('resize', repositionActivePanel);
  window.visualViewport?.addEventListener('scroll', repositionActivePanel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      closePanel({ focus: true });
    }
  });
  window.addEventListener('orshap-lang-changed', () => {
    closePanel();
    refreshAll();
    document.querySelectorAll('.o_ss_search').forEach(input => {
      input.placeholder = tx('اكتب للبحث…', 'Type to search…');
      input.setAttribute('aria-label', tx('بحث في القائمة', 'Search list'));
    });
  });

  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') {
          record.addedNodes.forEach(node => {
            if (node.nodeType === 1) scan(node);
          });
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          const select = target?.closest?.('select');
          if (select) scheduleRefresh(select);
          if (active && !active.select.isConnected) {
            active.panel.remove();
            active = null;
          }
        } else if (record.type === 'characterData') {
          const select = record.target.parentElement?.closest?.('select');
          if (select) scheduleRefresh(select);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Some screens assign select.value after rendering without firing an event.
  // A lightweight visible-only sync keeps the custom trigger in step.
  setInterval(() => {
    if (document.hidden) return;
    refreshAll();
  }, 900);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

export default { enhanceSearchableSelects, refreshSearchableSelects, closeSearchableSelect };
