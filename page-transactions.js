// ============================================================================
// OW — Transactions (review gate, usage party, opening balances)
// ----------------------------------------------------------------------------
// Ported from OW v13.9.58. The module keeps the OW shell but replaces the
// previous transaction workspace as a whole; no legacy transaction form or
// save path remains. Every write goes through a review screen first, and
// opening balances use the dedicated atomic RPC (never direct stock writes).
// ============================================================================
import { OW } from './core-registry.js';
import { tx, friendlyError } from './core-i18n.js';
import {
  pageHead, card, table, empty, statusBadge, btn, alertBox,
  controlPanel, input, select, textarea, field, printHTML, downloadCSV, tabs
} from './core-ui.js';
import {
  store, pullAll, createTransactionBundle, createStockReturnRequest, approveTransaction,
  rejectTransaction, requestTransactionReference,
  offlineTransactionTypeAllowed, offlineWarehouseAllowed,
  itemLabel, warehouseName, shelfPath, shelfOptions, shelvesForItem,
  warehouseOptions, itemOptions, unitOptions
} from './core-store.js';
import {
  canApproveTransactions, isElevated, can, role, canAccessWarehouse
} from './core-rbac.js';
import {
  fmtDateTime, fmtNum, txLabel, statusLabel, todayISO
} from './core-utils.js';
import { toast } from './core-toast.js';
import { modal, confirmDialog, promptDialog } from './core-modal.js';
import { rpc } from './core-supabase.js';
import { ensureOnlineSession } from './core-auth.js';
import { openQrScanner } from './qr-scanner.js';

const FILTERS = {
  tab: 'ALL', search: '', type: '', warehouse: '',
  from: '', to: ''
};

const STATUS_TABS = [
  { value: 'ALL', label: () => tx('الكل', 'All') },
  { value: 'PENDING_APPROVAL', label: () => tx('بانتظار الاعتماد', 'Pending') },
  { value: 'APPROVED', label: () => tx('معتمد', 'Approved') },
  { value: 'REJECTED', label: () => tx('مرفوض', 'Rejected') },
  { value: 'PENDING_SYNC', label: () => tx('بانتظار المزامنة', 'Pending sync') }
];

// Opening balances deliberately do not appear here: they are created through
// the dedicated workspace so the atomic RPC and manager-only gate always apply.
const TX_TYPES = [
  { value: 'GRN', label: () => tx('توريد', 'Goods receipt') },
  { value: 'ISSUE', label: () => tx('صرف', 'Issue') },
  { value: 'ADJUSTMENT_IN', label: () => tx('تسوية زيادة', 'Adjustment +') },
  { value: 'ADJUSTMENT_OUT', label: () => tx('تسوية نقص', 'Adjustment −') }
];

const escHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function filtered() {
  let list = [...store.get('transactions')];
  if (FILTERS.tab !== 'ALL') list = list.filter(t => t.status === FILTERS.tab);
  if (FILTERS.type) list = list.filter(t => t.transaction_type === FILTERS.type);
  if (FILTERS.warehouse) list = list.filter(t => t.warehouse_id === FILTERS.warehouse);
  if (FILTERS.from) list = list.filter(t => (t.created_at || '').slice(0, 10) >= FILTERS.from);
  if (FILTERS.to) list = list.filter(t => (t.created_at || '').slice(0, 10) <= FILTERS.to);
  if (FILTERS.search) {
    const q = FILTERS.search.toLowerCase();
    list = list.filter(t => [
      t.reference_no, t.supplier, t.receiver_name, t.usage_party, t.external_reference,
      t.notes, txLabel(t.transaction_type), statusLabel(t.status)
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function tabCount(v) {
  const all = store.get('transactions');
  return v === 'ALL' ? all.length : all.filter(t => t.status === v).length;
}

function availableQty(itemId, shelfId, batchNo = null) {
  return store.get('stock')
    .filter(s => s.item_id === itemId && s.shelf_id === shelfId
      && (!batchNo || String(s.batch_no || '') === String(batchNo)))
    .reduce((n, s) => n + Number(s.quantity || 0), 0);
}

function rowHtml(t) {
  return `<tr>
    <td><span class="o_cell_main">${escHtml(t.reference_no || '—')}</span>
      ${t.external_reference ? `<div class="o_cell_sub">${escHtml(t.external_reference)}</div>` : ''}</td>
    <td>${txLabel(t.transaction_type)}</td>
    <td>${escHtml(warehouseName(t.warehouse_id))}</td>
    <td>${escHtml(t._creator?.name || t._creator?.email || '—')}</td>
    <td>${escHtml(fmtDateTime(t.created_at))}</td>
    <td class="num"><b>${fmtNum(t.total_qty)}</b><div class="o_cell_sub">${t.line_count || 0} ${tx('سطر', 'lines')}</div></td>
    <td>${statusBadge(t.status, statusLabel(t.status))}</td>
    <td><div class="o_actions_cell">
      <button class="o_btn o_btn_ghost o_btn_sm" data-view="${escHtml(t.id)}" title="${tx('تفاصيل', 'Details')}"><i class="fa-solid fa-eye"></i></button>
      <button class="o_btn o_btn_ghost o_btn_sm" data-print="${escHtml(t.id)}" title="${tx('طباعة', 'Print')}"><i class="fa-solid fa-print"></i></button>
      ${canApproveTransactions() && ['PENDING_APPROVAL', 'PENDING'].includes(t.status)
        ? `<button class="o_btn o_btn_success o_btn_sm" data-approve="${escHtml(t.id)}">${tx('اعتماد', 'Approve')}</button>
           <button class="o_btn o_btn_danger o_btn_sm" data-reject="${escHtml(t.id)}">${tx('رفض', 'Reject')}</button>` : ''}
    </div></td>
  </tr>`;
}

/* ── list / register ───────────────────────────────────────────────────── */

function typeFilterOptions() {
  const seen = new Set(store.get('transactions').map(t => t.transaction_type).filter(Boolean));
  for (const t of TX_TYPES) seen.add(t.value);
  return [...seen].sort().map(v => ({ value: v, label: txLabel(v) }));
}

function listHtml() {
  const rows = filtered();
  return `${tabs(STATUS_TABS.map(s => ({
    value: s.value,
    label: s.label(),
    count: tabCount(s.value),
    onclick: `OW.wms.txTab('${s.value}')`
  })), FILTERS.tab)}
  ${rows.length
    ? table([
        { label: tx('المرجع', 'Reference') },
        { label: tx('النوع', 'Type') },
        { label: tx('المستودع', 'Warehouse') },
        { label: tx('أنشأه', 'Created by') },
        { label: tx('التاريخ', 'Date') },
        { label: tx('الكمية', 'Qty'), num: true },
        { label: tx('الحالة', 'Status') },
        { label: '' }
      ], rows.map(rowHtml))
    : empty(tx('لا توجد سندات مطابقة', 'No matching vouchers'),
        tx('غيّر عوامل التصفية أو أنشئ سنداً جديداً.', 'Change filters or create a new voucher.'))}`;
}

function filterHtml() {
  const typeOptions = typeFilterOptions();
  return `<select class="o_filter_select" id="txFilterType">
      <option value="">${tx('كل الأنواع', 'All types')}</option>
      ${typeOptions.map(o => `<option value="${escHtml(o.value)}" ${o.value === FILTERS.type ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
    </select>
    <select class="o_filter_select" id="txFilterWarehouse">
      <option value="">${tx('كل المستودعات', 'All warehouses')}</option>
      ${warehouseOptions().map(o => `<option value="${escHtml(o.value)}" ${o.value === FILTERS.warehouse ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
    </select>
    <input class="o_filter_input" id="txFilterFrom" type="date" value="${escHtml(FILTERS.from)}" title="${tx('من تاريخ', 'From date')}">
    <input class="o_filter_input" id="txFilterTo" type="date" value="${escHtml(FILTERS.to)}" title="${tx('إلى تاريخ', 'To date')}">
    <button class="o_btn o_btn_ghost o_btn_sm" id="txClearFilters" title="${tx('مسح التصفية', 'Clear filters')}"><i class="fa-solid fa-filter-circle-xmark"></i></button>`;
}

function canViewRegister() {
  return isElevated() || can('table:transactions:view');
}

function render() {
  if (!canViewRegister()) {
    return pageHead(tx('سندات المخزون', 'Voucher register'),
      tx('مراجعة واعتماد سندات التوريد والصرف والتسويات والمرتجعات', 'Review and approve receipts, issues, adjustments and returns'))
      + card('', empty(tx('لا تملك صلاحية عرض السندات', 'You do not have permission to view vouchers')));
  }
  const canNew = ['GRN', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'].some(canCreateType);
  const canCustomerReturn = isElevated() || can('action:transaction:grn:create');
  const canSupplierReturn = isElevated() || can('action:transaction:issue:create');
  const actions = `${canNew ? btn(`<i class="fa-solid fa-plus"></i> ${tx('سند جديد', 'New voucher')}`, 'onclick="OW.wms.newTx()"', 'primary') : ''}
    ${canCustomerReturn ? btn(`<i class="fa-solid fa-rotate-left"></i> ${tx('مرتجع من عميل', 'Customer return')}`, 'onclick="OW.wms.openReturn(\'RETURN_FROM_CUSTOMER\')"', 'secondary') : ''}
    ${canCustomerReturn ? btn(`<i class="fa-solid fa-arrow-rotate-left"></i> ${tx('مرتجع من الاستخدام', 'Return from usage')}`, 'onclick="OW.wms.openReturn(\'RETURN_FROM_USAGE\')"', 'secondary') : ''}
    ${canSupplierReturn ? btn(`<i class="fa-solid fa-arrow-up-from-bracket"></i> ${tx('مرتجع إلى مورد', 'Supplier return')}`, 'onclick="OW.wms.openReturn(\'RETURN_TO_SUPPLIER\')"', 'secondary') : ''}
    ${btn(`<i class="fa-solid fa-qrcode"></i> ${tx('مسح QR', 'Scan QR')}`, 'onclick="OW.wms.scanTransaction()"', 'secondary')}`;
  return pageHead(
    tx('سندات المخزون', 'Voucher register'),
    tx('مراجعة واعتماد سندات التوريد والصرف والتسويات والمرتجعات', 'Review and approve receipts, issues, adjustments and returns'),
    actions
  ) + card('', `${controlPanel({
    title: tx('السندات', 'Vouchers'),
    searchPlaceholder: tx('ابحث بالمرجع أو المورد أو المستلم...', 'Search reference, supplier or receiver...'),
    filters: filterHtml(),
    actions: `${btn('', 'onclick="OW.wms.printTxRegister()"', 'ghost', 'fa-solid fa-print')}
      ${btn('', 'onclick="OW.wms.exportTxs()"', 'ghost', 'fa-solid fa-file-csv')}`
  })}<div id="txListBody">${listHtml()}</div>`);
}

function refreshList(main) {
  const box = main.querySelector('#txListBody');
  if (box) box.innerHTML = listHtml();
}

function bind(_params, root) {
  const main = root || document.getElementById('mainContent');
  if (!canViewRegister()) return;
  const search = main.querySelector('#oSearchInput');
  if (search) {
    search.value = FILTERS.search;
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        FILTERS.search = search.value.trim();
        refreshList(main);
      }, 160);
    });
  }

  const apply = (id, key, event = 'change') => {
    const el = main.querySelector(id);
    if (!el) return;
    el.addEventListener(event, () => {
      FILTERS[key] = el.value;
      reloadTransactions();
    });
  };
  apply('#txFilterType', 'type');
  apply('#txFilterWarehouse', 'warehouse');
  apply('#txFilterFrom', 'from');
  apply('#txFilterTo', 'to');

  const clear = main.querySelector('#txClearFilters');
  if (clear) clear.onclick = () => {
    FILTERS.search = '';
    FILTERS.type = '';
    FILTERS.warehouse = '';
    FILTERS.from = '';
    FILTERS.to = '';
    FILTERS.tab = 'ALL';
    reloadTransactions();
  };

  const listBody = main.querySelector('#txListBody');
  if (listBody) listBody.addEventListener('click', async e => {
    const view = e.target.closest('[data-view]');
    if (view) return openTransaction(view.dataset.view);
    const print = e.target.closest('[data-print]');
    if (print) {
      const t = store.byId('transactions', print.dataset.print);
      if (t) printTransaction(t);
      return;
    }
    const approve = e.target.closest('[data-approve]');
    if (approve) return doApprove(approve.dataset.approve);
    const reject = e.target.closest('[data-reject]');
    if (reject) return doReject(reject.dataset.reject);
  });
}

function reloadTransactions() {
  if (OW.currentPage === 'dashboard' && typeof OW.wms?.refreshDashboard === 'function') {
    OW.wms.refreshDashboard();
    return;
  }
  if (typeof window.showPage === 'function') window.showPage('transactions');
}

function txTab(value) {
  FILTERS.tab = value;
  reloadTransactions();
}

/* ── shared helpers ────────────────────────────────────────────────────── */

function selectHtml(cls, key, options, value, placeholder = '—') {
  return `<select class="o_form_input ${cls}" data-k="${key}">
    <option value="">${escHtml(placeholder)}</option>
    ${options.map(o => `<option value="${escHtml(o.value)}" ${String(o.value) === String(value || '') ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
  </select>`;
}

function accessibleWarehouseOptions() {
  return warehouseOptions().filter(o => canAccessWarehouse(o.value));
}

function canCreateType(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'GRN' || t.startsWith('RETURN_FROM')) return isElevated() || can('action:transaction:grn:create');
  if (t === 'ISSUE' || t === 'RETURN_TO_SUPPLIER') return isElevated() || can('action:transaction:issue:create');
  return isElevated() || can('action:transaction:adjustment:create');
}

function availableLabel(itemId, shelfId, batchNo) {
  if (!itemId || !shelfId) return '';
  const n = availableQty(itemId, shelfId, batchNo || null);
  const base = store.byId('items', itemId)?.base_unit || '';
  return `${tx('المتاح', 'Available')}: ${fmtNum(n)}${base ? ` ${base}` : ''}`;
}

/* ── create transaction + review gate ──────────────────────────────────── */

function blankLine() {
  return {
    item_id: '', shelf_id: '',
    quantity: '', unit: '', batch_no: '', expiry_date: ''
  };
}

function lineRowHtml(line, index, warehouseId, type) {
  const items = itemOptions({ activeOnly: true });
  const shelves = shelfOptions({ warehouseId, itemId: line.item_id });
  // الحقول المنسدلة الذكية: إذا كان الصنف موجودًا في رف واحد داخل المستودع المحدد، حدده تلقائياً
  if (line.item_id && !line.shelf_id && warehouseId) {
    const smart = shelvesForItem(line.item_id, { warehouseId, onlyWithStock: ['ISSUE', 'ADJUSTMENT_OUT'].includes(String(type||'').toUpperCase()) });
    if (smart.length === 1) {
      line.shelf_id = smart[0].value;
    } else if (smart.length === 0) {
      const any = shelvesForItem(line.item_id, { warehouseId, onlyWithStock: false });
      if (any.length === 1) line.shelf_id = any[0].value;
    }
  }
  const shelfOpts = shelves.length ? shelves : shelfOptions({ warehouseId });
  const item = store.byId('items', line.item_id);
  const units = unitOptions(line.item_id);
  if (!line.unit || !units.some(u => u.value === line.unit)) line.unit = units[0]?.value || '';
  const unconfiguredPurchase = item?.purchase_unit
    && String(item.purchase_unit).toUpperCase() !== String(item.base_unit || '').toUpperCase()
    && !units.some(u => u.value === String(item.purchase_unit).toUpperCase());
  const avail = availableLabel(line.item_id, line.shelf_id, line.batch_no);
  return `<tr data-line="${index}">
    <td class="tx-line-idx">${index + 1}</td>
    <td>${selectHtml('tx-line-item', 'item_id', items, line.item_id, tx('اختر الصنف', 'Select item'))}</td>
    <td>${selectHtml('tx-line-shelf', 'shelf_id', shelfOpts, line.shelf_id, tx('اختر الرف', 'Select shelf'))}</td>
    <td>
      <input class="o_form_input tx-line-qty" data-k="quantity" type="number" min="0.001" step="any" value="${escHtml(line.quantity)}" placeholder="0">
      ${avail ? `<div class="o_cell_sub">${escHtml(avail)}</div>` : ''}
    </td>
    <td>${selectHtml('tx-line-unit', 'unit', units, line.unit, '—')}
      ${unconfiguredPurchase ? `<div class="o_cell_sub" style="color:#b26a00">${escHtml(tx(`وحدة ${item.purchase_unit} غير مهيأة لهذا الصنف`, `${item.purchase_unit} is not configured for this item`))}</div>` : ''}
    </td>
    <td><input class="o_form_input" data-k="batch_no" value="${escHtml(line.batch_no)}" placeholder="${tx('تشغيلة', 'Batch')}"></td>
    <td><input class="o_form_input" data-k="expiry_date" type="date" value="${escHtml(line.expiry_date)}"></td>
    <td><button type="button" class="o_btn o_btn_ghost o_btn_sm tx-line-remove" data-remove="${index}" title="${tx('حذف', 'Remove')}"><i class="fa-solid fa-trash"></i></button></td>
  </tr>`;
}

function syncTypeFields(root) {
  const form = root.querySelector('#txForm');
  if (!form) return;
  const type = String(form.querySelector('[name="transaction_type"]')?.value || 'GRN').toUpperCase();
  const show = (name, visible, required) => {
    const control = form.querySelector(`[name="${name}"]`);
    if (!control) return;
    const wrap = control.closest('.o_field');
    if (wrap) wrap.style.display = visible ? '' : 'none';
    control.required = !!required;
  };
  show('supplier', type === 'GRN', type === 'GRN');
  show('receiver_name', type === 'ISSUE', type === 'ISSUE');
  show('usage_party', type === 'ISSUE', type === 'ISSUE');
  show('adjustment_reason', type.startsWith('ADJUSTMENT'), type.startsWith('ADJUSTMENT'));

  let hint = '';
  if (type === 'GRN') hint = alertBox(tx('أدخل المورد. سيُضاف الرصيد إلى الرف المحدد لكل سطر عند الاعتماد.', 'Enter the supplier. Stock is added to the shelf selected on each line when approved.'), 'info');
  else if (type === 'ISSUE') hint = alertBox(tx('اكتب جهة الاستخدام والمستلم، ثم حدد الصنف والرف في كل سطر. لا يمكن الصرف بأكثر من المتاح.', 'Type the usage party and receiver, then select the item and shelf on each line. You cannot issue more than available.'), 'warning');
  else if (type.startsWith('ADJUSTMENT')) hint = alertBox(tx('سبب التسوية مطلوب. التسويات الناقصة تتحقق من الرصيد المتاح على الرف.', 'An adjustment reason is required. Decrease adjustments are checked against available shelf stock.'), 'warning');
  else hint = alertBox(tx('سيُضاف المرتجع إلى الرف المحدد لكل سطر بعد الاعتماد.', 'The return is added to the shelf selected on each line after approval.'), 'info');
  const box = root.querySelector('#txTypeHint');
  if (box) box.innerHTML = hint;
}

function drawLines(root, lines) {
  const tbody = root.querySelector('#txLinesBody');
  if (!tbody) return;
  const form = root.querySelector('#txForm');
  const type = String(form?.querySelector('[name="transaction_type"]')?.value || 'GRN');
  const warehouseId = String(form?.querySelector('[name="warehouse_id"]')?.value || '');
  tbody.innerHTML = lines.map((line, i) => lineRowHtml(line, i, warehouseId, type)).join('');
  tbody.querySelectorAll('tr[data-line]').forEach(tr => {
    const index = Number(tr.dataset.line);
    const line = lines[index];
    const bind = (key, event, fn) => {
      const input = tr.querySelector(`[data-k="${key}"]`);
      if (input) input.addEventListener(event, e => fn(e.target.value));
    };
    bind('item_id', 'change', value => {
      line.item_id = value;
      const item = store.byId('items', value);
      const typeNow = String(form?.querySelector('[name="transaction_type"]')?.value || 'GRN').toUpperCase();
      // الحقول المنسدلة الذكية: عرض رفوف الصنف فقط، وتعيين تلقائياً إذا كان رف واحد
      const smart = shelvesForItem(value, { warehouseId, onlyWithStock: ['ISSUE', 'ADJUSTMENT_OUT'].includes(typeNow) });
      if (smart.length === 1) {
        line.shelf_id = smart[0].value;
      } else if (smart.length > 1) {
        // إبق على ما يمكن إن كان موجودًا ضمن القائمة، وإلا مسحه للسماح بالاختيار اليدوي
        if (!smart.some(s => s.value === line.shelf_id)) line.shelf_id = '';
      } else {
        // لا رصيد — ابحث عن أي رفوف للصنف داخل المستودع
        const any = shelvesForItem(value, { warehouseId, onlyWithStock: false });
        if (any.length === 1) line.shelf_id = any[0].value;
        else if (any.length === 0) line.shelf_id = '';
        else if (!any.some(s => s.value === line.shelf_id)) line.shelf_id = '';
      }
      line.unit = unitOptions(value)[0]?.value || '';
      drawLines(root, lines);
    });
    bind('shelf_id', 'change', value => {
      line.shelf_id = value;
      drawLines(root, lines);
    });
    bind('quantity', 'input', value => { line.quantity = value; });
    bind('unit', 'change', value => { line.unit = value; });
    bind('batch_no', 'input', value => { line.batch_no = value; });
    bind('expiry_date', 'change', value => { line.expiry_date = value; });
    const remove = tr.querySelector('[data-remove]');
    if (remove) remove.onclick = () => {
      lines.splice(index, 1);
      if (!lines.length) lines.push(blankLine());
      drawLines(root, lines);
    };
  });
}

function openNewTx(requested = null, prefill = {}) {
  const wanted = requested ? String(requested).toUpperCase() : '';
  const allowed = TX_TYPES.filter(t => canCreateType(t.value));
  if (!allowed.length) return toast(tx('لا تملك صلاحية إنشاء سندات مخزون.', 'You do not have permission to create stock vouchers.'), 'error');
  if (wanted && !allowed.some(t => t.value === wanted)) {
    return toast(tx('لا تملك صلاحية إنشاء هذا النوع من السندات.', 'You do not have permission to create this voucher type.'), 'error');
  }
  const type = wanted || allowed[0].value;
  const warehouses = accessibleWarehouseOptions();
  let warehouseId = warehouses[0]?.value || '';
  const lines = [blankLine()];
  const prefillItem = prefill.itemId ? store.byId('items', prefill.itemId) : null;
  if (prefillItem || prefill.shelfId) {
    const accessibleIds = new Set(warehouses.map(w => w.value));
    const stockRow = prefillItem
      ? store.get('stock').find(s => s.item_id === prefillItem.id && Number(s.quantity || 0) > 0
          && accessibleIds.has(store.byId('shelves', s.shelf_id)?.warehouse_id))
      : null;
    let shelfId = prefill.shelfId || stockRow?.shelf_id || prefillItem?.default_shelf_id || '';
    const shelf = store.byId('shelves', shelfId);
    if (shelf && accessibleIds.has(shelf.warehouse_id)) warehouseId = shelf.warehouse_id;
    else shelfId = '';
    lines[0].item_id = prefillItem?.id || '';
    lines[0].shelf_id = shelfId;
    lines[0].batch_no = prefill.batchNo || stockRow?.batch_no || '';
    lines[0].unit = prefillItem ? (unitOptions(prefillItem.id)[0]?.value || '') : '';
  }
  const body = `<form id="txForm" class="o_form_grid">
      ${select({ name: 'transaction_type', label: tx('نوع السند', 'Voucher type'), options: allowed.map(t => ({ value: t.value, label: t.label() })), value: type, required: true })}
      ${field(tx('رقم السند', 'Voucher reference'),
        `<div style="display:flex;gap:8px;align-items:center">
          <input class="o_form_input" name="reference_no" id="txReference" readonly placeholder="${tx('يُولّد تلقائياً', 'Generated automatically')}">
          <button type="button" class="o_btn o_btn_secondary o_btn_sm" id="txRefRetry" hidden title="${tx('إعادة المحاولة', 'Retry')}"><i class="fa-solid fa-rotate"></i></button>
        </div>
        <small class="o_hint" id="txRefState"></small>`, { required: true })}
      ${select({ name: 'warehouse_id', label: tx('المستودع', 'Warehouse'), options: warehouses, value: warehouseId, required: true })}
      ${input({ name: 'supplier', label: tx('المورد', 'Supplier'), placeholder: tx('اسم المورد', 'Supplier name') })}
      ${input({ name: 'receiver_name', label: tx('اسم المستلم', 'Receiver name'), placeholder: tx('من استلم البضاعة', 'Who received the goods') })}
      ${input({ name: 'usage_party', label: tx('جهة الاستخدام', 'Usage party'), placeholder: tx('اكتب جهة الاستخدام', 'Type the usage party') })}
      ${input({ name: 'adjustment_reason', label: tx('سبب التسوية', 'Adjustment reason'), placeholder: tx('سبب الزيادة أو النقص', 'Reason for the increase/decrease') })}
      ${input({ name: 'external_reference', label: tx('المرجع الخارجي', 'External reference'), placeholder: tx('فاتورة، أمر شراء، محضر...', 'Invoice, PO, minutes...') })}
      ${textarea({ name: 'notes', label: tx('ملاحظات', 'Notes'), rows: 2, placeholder: tx('ملاحظات السند', 'Voucher notes') })}
    </form>
    <div id="txTypeHint"></div>
    <div class="o_tx_lines_head">
      <h4><i class="fa-solid fa-list-check"></i> ${tx('بنود السند', 'Voucher lines')}</h4>
      <div class="o_tx_line_actions">
        <button class="o_btn o_btn_secondary o_btn_sm" id="txScanItem" type="button"><i class="fa-solid fa-qrcode"></i> ${tx('مسح صنف', 'Scan item')}</button>
        <button class="o_btn o_btn_secondary o_btn_sm" id="txAddLine" type="button"><i class="fa-solid fa-plus"></i> ${tx('إضافة سطر', 'Add line')}</button>
      </div>
    </div>
    <div class="o_list_wrap"><table class="o_list_table tx-lines-table">
      <thead><tr>
        <th>#</th><th>${tx('الصنف', 'Item')}</th><th>${tx('الرف', 'Shelf')}</th>
        <th>${tx('الكمية', 'Qty')}</th><th>${tx('الوحدة', 'Unit')}</th><th>${tx('التشغيلة', 'Batch')}</th><th>${tx('الصلاحية', 'Expiry')}</th><th></th>
      </tr></thead>
      <tbody id="txLinesBody"></tbody>
    </table></div>
    <div id="txFormError"></div>`;

  modal({
    title: `<i class="fa-solid fa-${prefill.quick ? 'bolt' : 'file-circle-plus'}"></i> ${prefill.quick
      ? tx('صرف سريع من QR', 'Quick issue from QR')
      : tx('سند مخزون جديد', 'New stock voucher')}`,
    size: 'xl',
    body,
    footer: `<button class="o_btn o_btn_secondary" id="txCancel">${tx('إلغاء', 'Cancel')}</button>
      <button class="o_btn o_btn_primary" id="txReview"><i class="fa-solid fa-magnifying-glass-chart"></i> ${tx('مراجعة السند', 'Review voucher')}</button>`,
    onMount: (el, close) => {
      const form = el.querySelector('#txForm');
      const typeEl = form.querySelector('[name="transaction_type"]');
      const whEl = form.querySelector('[name="warehouse_id"]');
      const refInput = form.querySelector('[name="reference_no"]');
      const refRetry = el.querySelector('#txRefRetry');
      const refState = el.querySelector('#txRefState');
      const reviewBtn = el.querySelector('#txReview');
      const draw = () => drawLines(el, lines);
      let referenceRequest = 0;
      const loadReference = async () => {
        const requestId = ++referenceRequest;
        reviewBtn.disabled = true;
        refRetry.hidden = true;
        refRetry.disabled = true;
        refState.textContent = tx('جارٍ توليد رقم السند…', 'Generating voucher reference…');
        try {
          const result = await requestTransactionReference();
          if (!el.isConnected || requestId !== referenceRequest) return;
          refInput.value = result.reference;
          refState.textContent = result.provisional
            ? tx('رقم محلي مؤقت — سيُستبدل بالرقم الرسمي عند المزامنة.', 'Temporary local reference — replaced with the official number during sync.')
            : tx('رقم سند رسمي من الخادم.', 'Official server reference.');
        } catch (e) {
          if (!el.isConnected || requestId !== referenceRequest) return;
          refInput.value = '';
          refState.textContent = friendlyError(e);
          refRetry.hidden = false;
        } finally {
          if (el.isConnected && requestId === referenceRequest) {
            refRetry.disabled = false;
            reviewBtn.disabled = !refInput.value.trim();
          }
        }
      };
      refRetry.onclick = loadReference;
      syncTypeFields(el);
      draw();
      if (prefill.quick) {
        setTimeout(() => {
          const qty = el.querySelector('.tx-line-qty');
          qty?.focus({ preventScroll: true });
          qty?.select?.();
        }, 120);
      }
      loadReference();
      typeEl.addEventListener('change', () => {
        syncTypeFields(el);
        draw();
      });
      whEl.addEventListener('change', () => {
        const allowedShelves = shelfOptions({ warehouseId: whEl.value });
        for (const l of lines) {
          if (l.shelf_id && !allowedShelves.some(s => s.value === l.shelf_id)) l.shelf_id = '';
        }
        draw();
      });
      el.querySelector('#txAddLine').onclick = () => { lines.push(blankLine()); draw(); };
      el.querySelector('#txScanItem').onclick = () => openQrScanner({
        mode: 'lookup',
        onResolved: resolved => {
          const allowedShelves = shelfOptions({ warehouseId: whEl.value });
          if (resolved.kind === 'item') {
            let target = lines.find(line => !line.item_id);
            if (!target) {
              target = blankLine();
              lines.push(target);
            }
            const item = resolved.record;
            target.item_id = item.id;
            const typeNow = String(form?.querySelector('[name="transaction_type"]')?.value || 'GRN').toUpperCase();
            const smart = shelvesForItem(item.id, { warehouseId: whEl.value, onlyWithStock: ['ISSUE', 'ADJUSTMENT_OUT'].includes(typeNow) });
            if (smart.length === 1) {
              target.shelf_id = smart[0].value;
            } else if (smart.length === 0) {
              const any = shelvesForItem(item.id, { warehouseId: whEl.value, onlyWithStock: false });
              if (any.length === 1) target.shelf_id = any[0].value;
              else if (target.shelf_id && !allowedShelves.some(option => option.value === target.shelf_id)) target.shelf_id = '';
            } else if (target.shelf_id && !allowedShelves.some(option => option.value === target.shelf_id)) {
              target.shelf_id = '';
            }
            target.unit = unitOptions(item.id)[0]?.value || '';
            draw();
            toast(tx(`أُضيف الصنف ${itemLabel(item)} إلى السند.`, `Item ${itemLabel(item)} added to the voucher.`), 'success');
            return;
          }
          if (resolved.kind === 'shelf') {
            let target = lines.find(line => !line.shelf_id) || lines[0];
            if (!target) {
              target = blankLine();
              lines.push(target);
            }
            target.shelf_id = resolved.id;
            draw();
            toast(tx(`تم اختيار الرف ${shelfPath(resolved.id)}.`, `Shelf ${shelfPath(resolved.id)} selected.`), 'success');
            return;
          }
          toast(tx('امسح QR صنف أو رف لإضافته إلى السند.', 'Scan an item or shelf QR to add it to the voucher.'), 'warning');
        }
      });
      el.querySelector('#txCancel').onclick = () => close();
      el.querySelector('#txReview').onclick = () => {
        if (!refInput.value.trim()) {
          const box = el.querySelector('#txFormError');
          box.innerHTML = alertBox(tx('انتظر توليد رقم السند أو أعد المحاولة قبل المراجعة.',
            'Wait for the voucher reference or retry before reviewing.'), 'danger');
          return;
        }
        const draft = collectDraft(el, lines);
        openReview(el, draft, close);
      };
    }
  });
}

function collectDraft(root, lines) {
  const form = root.querySelector('#txForm');
  const raw = form ? Object.fromEntries(new FormData(form).entries()) : {};
  const meta = {};
  for (const [k, v] of Object.entries(raw)) meta[k] = typeof v === 'string' ? v.trim() : v;
  const type = String(meta.transaction_type || 'GRN').toUpperCase();
  const warehouseId = meta.warehouse_id || '';
  const warehouse = store.byId('warehouses', warehouseId);
  const reference = String(meta.reference_no || '').trim();
  const provisional = /^LOCAL-/i.test(reference);
  const errors = [];

  if (!reference) errors.push(tx('انتظر توليد رقم السند أو أعد المحاولة.', 'Wait for the voucher reference or retry.'));
  if (!warehouse) errors.push(tx('اختر مستودعاً صالحاً.', 'Select a valid warehouse.'));
  else if (!canAccessWarehouse(warehouse.id)) errors.push(tx('لا تملك صلاحية العمل في هذا المستودع.', 'You do not have permission to work in this warehouse.'));
  if (!canCreateType(type)) errors.push(tx('لا تملك صلاحية إنشاء هذا النوع من السندات.', 'You do not have permission to create this voucher type.'));
  if (!navigator.onLine || provisional) {
    if (!offlineTransactionTypeAllowed(type)) {
      errors.push(tx('دون اتصال: يُسمح بالتوريد والصرف فقط. تحتاج التسويات إلى اتصال مباشر.',
        'Offline mode supports receipts and issues only. Adjustments require a live connection.'));
    }
    if (!offlineWarehouseAllowed(warehouseId)) {
      errors.push(tx('دون اتصال: يلزم مستودع واحد معيّن صراحةً لحسابك.',
        'Offline mode requires exactly one explicitly assigned warehouse.'));
    }
  }
  if (type === 'GRN' && !meta.supplier) errors.push(tx('اسم المورد مطلوب لسند التوريد.', 'Supplier is required for a goods receipt.'));
  if (type === 'ISSUE' && !meta.receiver_name) errors.push(tx('اسم المستلم مطلوب لسند الصرف.', 'Receiver name is required for an issue.'));
  if (type === 'ISSUE' && !meta.usage_party) errors.push(tx('جهة الاستخدام مطلوبة لسند الصرف.', 'Usage party is required for an issue.'));
  if (type.startsWith('ADJUSTMENT') && !meta.adjustment_reason) errors.push(tx('سبب التسوية مطلوب.', 'Adjustment reason is required.'));

  const rows = lines.map((line, i) => {
    const item = store.byId('items', line.item_id);
    const shelf = store.byId('shelves', line.shelf_id);
    const units = unitOptions(line.item_id);
    const unit = units.find(u => u.value === line.unit) || null;
    const factor = Number(unit?.factor);
    const qty = Number(line.quantity);
    const baseQty = unit && Number.isFinite(factor) && factor > 0 ? qty * factor : NaN;
    const rowErrors = [];
    const prefix = `#${i + 1} `;
    if (!item) rowErrors.push(tx('الصنف مطلوب.', 'Item is required.'));
    if (!shelf) rowErrors.push(tx('الرف مطلوب.', 'Shelf is required.'));
    if (shelf && warehouse && shelf.warehouse_id !== warehouse.id) rowErrors.push(tx('الرف لا يتبع المستودع المحدد.', 'The shelf does not belong to the selected warehouse.'));
    if (item && (!unit || !Number.isFinite(factor) || factor <= 0)) {
      rowErrors.push(tx('الوحدة المختارة غير مهيأة لهذا الصنف. اعتمد معامل التحويل من الإعدادات أولاً.',
        'The selected unit is not configured for this item. Approve its factor in Settings first.'));
    }
    if (!Number.isFinite(qty) || qty <= 0) rowErrors.push(tx('الكمية يجب أن تكون رقماً موجباً.', 'Quantity must be a positive number.'));
    if (line.expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(line.expiry_date)) rowErrors.push(tx('تاريخ الصلاحية غير صالح.', 'Expiry date is invalid.'));
    if (['ISSUE', 'ADJUSTMENT_OUT'].includes(type) && item && shelf && Number.isFinite(baseQty) && baseQty > 0) {
      const available = availableQty(item.id, shelf.id, line.batch_no);
      if (baseQty > available + 1e-9) {
        rowErrors.push(`${tx('المتاح', 'Available')} ${fmtNum(available)} ${item.base_unit || ''} — ${tx('الكمية المطلوبة أكبر من الرصيد.', 'Requested quantity exceeds stock.')}`);
      }
    }
    for (const message of rowErrors) errors.push(prefix + message);
    return { line, item, shelf, unit, qty, factor, baseQty, rowErrors };
  });

  if (!rows.length) errors.push(tx('أضف سطراً واحداً على الأقل.', 'Add at least one line.'));

  const payloadLines = rows
    .filter(r => r.item && r.shelf && Number.isFinite(r.baseQty) && r.baseQty > 0)
    .map(r => ({
      item_id: r.item.id,
      shelf_id: r.shelf.id,
      storage_area_id: r.shelf.storage_area_id || null,
      quantity: r.baseQty,
      entered_quantity: r.qty,
      entered_unit: r.unit.value,
      conversion_factor: r.factor,
      base_unit: r.item.base_unit || 'PCS',
      batch_no: String(r.line.batch_no || '').trim() || null,
      expiry_date: String(r.line.expiry_date || '').trim() || null,
      notes: null
    }));

  const total = rows.reduce((n, r) => n + (Number.isFinite(r.baseQty) && r.baseQty > 0 ? r.baseQty : 0), 0);
  return {
    meta, type, warehouse, rows, errors, total,
    payload: {
      type,
      reference_no: reference,
      warehouse_id: warehouseId || null,
      supplier: type === 'GRN' ? (meta.supplier || null) : null,
      receiver_name: type === 'ISSUE' ? (meta.receiver_name || null) : null,
      usage_party: type === 'ISSUE' ? (meta.usage_party || null) : null,
      adjustment_reason: type.startsWith('ADJUSTMENT') ? (meta.adjustment_reason || null) : null,
      external_reference: meta.external_reference || null,
      notes: meta.notes || null,
      lines: payloadLines
    }
  };
}

function reviewMeta(draft) {
  const items = [
    [tx('رقم السند', 'Voucher reference'), draft.payload.reference_no || '—'],
    [tx('النوع', 'Type'), txLabel(draft.type)],
    [tx('المستودع', 'Warehouse'), draft.warehouse?.name || '—'],
    [tx('المورد', 'Supplier'), draft.meta.supplier || '—'],
    [tx('المستلم', 'Receiver'), draft.meta.receiver_name || '—'],
    [tx('جهة الاستخدام', 'Usage party'), draft.meta.usage_party || '—'],
    [tx('سبب التسوية', 'Adjustment reason'), draft.meta.adjustment_reason || '—'],
    [tx('إجمالي الكمية الأساسية', 'Total base quantity'), fmtNum(draft.total)]
  ];
  return `<div class="o_detail_grid">${items.map(([label, value]) => `
    <div class="o_detail_item"><span>${escHtml(label)}</span><b>${escHtml(value)}</b></div>`).join('')}</div>`;
}

function openReview(root, draft, closeTx) {
  const errorHtml = draft.errors.length
    ? alertBox(`<strong>${tx('راجع الأخطاء قبل الحفظ', 'Review the errors before saving')}</strong><ul>${draft.errors.map(e => `<li>${escHtml(e)}</li>`).join('')}</ul>`, 'danger')
    : alertBox(tx('كل البيانات صالحة. لن تتغير الأرصدة إلا بعد الاعتماد.', 'All data is valid. Stock will not change until approval.'), 'success');

  const rows = draft.rows.map((r, i) => {
    const entered = r.unit && r.unit.value !== r.item?.base_unit
      ? `<div class="o_cell_sub">${fmtNum(r.qty)} ${escHtml(r.unit.value)} × ${fmtNum(r.factor)}</div>`
      : '';
    return `<tr>
      <td>${i + 1}</td>
      <td>${escHtml(r.item ? itemLabel(r.item) : '—')}</td>
      <td>${escHtml(r.shelf ? shelfPath(r.shelf.id) : '—')}</td>
      <td class="num">${Number.isFinite(r.baseQty) ? fmtNum(r.baseQty) : '—'}${entered}</td>
      <td>${escHtml(r.item?.base_unit || r.unit?.value || '')}</td>
      <td>${escHtml(r.line.batch_no || '—')}</td>
      <td>${escHtml(r.line.expiry_date || '—')}</td>
    </tr>`;
  }).join('');

  const body = `${reviewMeta(draft)}
    ${errorHtml}
    <div class="o_list_wrap"><table class="o_list_table">
      <thead><tr><th>#</th><th>${tx('الصنف', 'Item')}</th><th>${tx('الرف', 'Shelf')}</th><th class="num">${tx('الكمية الأساسية', 'Base qty')}</th><th>${tx('الوحدة الأساسية', 'Base unit')}</th><th>${tx('التشغيلة', 'Batch')}</th><th>${tx('الصلاحية', 'Expiry')}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7">${tx('لا توجد بنود', 'No lines')}</td></tr>`}</tbody>
    </table></div>`;

  modal({
    title: `<i class="fa-solid fa-magnifying-glass-chart"></i> ${tx('مراجعة السند قبل الحفظ', 'Review voucher before saving')}`,
    size: 'xl',
    body,
    footer: `<button class="o_btn o_btn_secondary" id="txReviewBack">${tx('رجوع', 'Back')}</button>
      <button class="o_btn o_btn_ghost" id="txReviewPrint"><i class="fa-solid fa-print"></i> ${tx('معاينة الطباعة', 'Print preview')}</button>
      <button class="o_btn o_btn_primary" id="txReviewConfirm" ${draft.errors.length ? 'disabled' : ''}><i class="fa-solid fa-check"></i> ${tx('تأكيد الحفظ', 'Confirm save')}</button>`,
    onMount: (el, closeReview) => {
      el.querySelector('#txReviewBack').onclick = () => closeReview();
      el.querySelector('#txReviewPrint').onclick = () => printDraft(draft);
      const confirm = el.querySelector('#txReviewConfirm');
      confirm.onclick = async () => {
        if (draft.errors.length) return;
        confirm.disabled = true;
        try {
          const result = await createTransactionBundle(draft.payload);
          closeReview();
          closeTx();
          if (result?.queued) toast(tx('تم حفظ السند في قائمة الانتظار المحلية وسيُزامن تلقائياً عند توفر الاتصال.',
            'Voucher queued locally and will sync automatically when the connection is available.'), 'warning');
          else if (result?.approved) toast(tx('تم إنشاء السند واعتماده.', 'Voucher created and approved.'), 'success');
          else toast(tx('تم إنشاء السند بانتظار الاعتماد.', 'Voucher created, pending approval.'), 'success');
          reloadTransactions();
        } catch (e) {
          confirm.disabled = false;
          toast(escHtml(friendlyError(e)), 'error');
        }
      };
    }
  });
}

function draftPrintHtml(draft) {
  const headers = [tx('الصنف', 'Item'), tx('الرف', 'Shelf'), tx('الكمية', 'Qty'), tx('الوحدة', 'Unit'), tx('التشغيلة', 'Batch'), tx('الصلاحية', 'Expiry')];
  const rows = draft.rows.map(r => [
    escHtml(r.item ? itemLabel(r.item) : '—'),
    escHtml(r.shelf ? shelfPath(r.shelf.id) : '—'),
    escHtml(Number.isFinite(r.baseQty)
      ? `${fmtNum(r.baseQty)}${r.unit && r.unit.value !== r.item?.base_unit ? ` (${fmtNum(r.qty)} ${r.unit.value} × ${fmtNum(r.factor)})` : ''}`
      : '—'),
    escHtml(r.item?.base_unit || r.unit?.value || ''),
    escHtml(r.line.batch_no || ''),
    escHtml(r.line.expiry_date || '')
  ]);
  const meta = `${draft.payload.reference_no || '—'} · ${txLabel(draft.type)} · ${draft.warehouse?.name || '—'} · ${tx('الإجمالي', 'Total')}: ${fmtNum(draft.total)}`;
  return `<p>${escHtml(meta)}</p>${table(headers, rows)}`;
}

function printDraft(draft) {
  printHTML(tx('معاينة سند مخزون', 'Stock voucher preview'), draftPrintHtml(draft), { subtitle: txLabel(draft.type) });
}

/* ── transaction details / approval ────────────────────────────────────── */

function detailMeta(t) {
  const items = [
    [tx('المستودع', 'Warehouse'), warehouseName(t.warehouse_id)],
    [tx('المورد', 'Supplier'), t.supplier || '—'],
    [tx('المستلم', 'Receiver'), t.receiver_name || '—'],
    [tx('جهة الاستخدام', 'Usage party'), t.usage_party || '—'],
    [tx('سبب التسوية', 'Adjustment reason'), t.adjustment_reason || '—'],
    [tx('المرجع الخارجي', 'External reference'), t.external_reference || '—'],
    [tx('أنشأه', 'Created by'), t._creator?.name || t._creator?.email || '—'],
    [tx('التاريخ', 'Date'), fmtDateTime(t.created_at)]
  ];
  return `<div class="o_detail_grid">${items.map(([label, value]) => `<div class="o_detail_item"><span>${escHtml(label)}</span><b>${escHtml(value)}</b></div>`).join('')}</div>`;
}

function detailTable(t) {
  const lines = t.transaction_lines || [];
  return table([
    tx('الصنف', 'Item'), tx('الرف', 'Shelf'),
    { label: tx('الكمية الأساسية', 'Base qty'), num: true },
    tx('الوحدة الأساسية', 'Base unit'),
    tx('الكمية المدخلة', 'Entered'),
    tx('التشغيلة', 'Batch'), tx('الصلاحية', 'Expiry'), tx('ملاحظات', 'Notes')
  ], lines.map(l => {
    const item = l._item || store.byId('items', l.item_id);
    const baseUnit = l.base_unit || item?.base_unit || '';
    const entered = l.entered_unit && l.entered_unit !== baseUnit
      ? `${fmtNum(l.entered_quantity)} ${escHtml(l.entered_unit)} × ${fmtNum(l.conversion_factor)}`
      : '—';
    return [
      escHtml(item ? itemLabel(item) : itemLabel(l.item_id)),
      escHtml(l._shelf ? (l._shelf.full_path || l._shelf.code) : shelfPath(l.shelf_id)),
      `<span class="num">${fmtNum(l.quantity)}</span>`,
      escHtml(baseUnit),
      entered === '—' ? '—' : `<span class="num">${entered}</span>`,
      escHtml(l.batch_no || '—'),
      escHtml(l.expiry_date || '—'),
      escHtml(l.notes || '—')
    ];
  }));
}

function openTransaction(id) {
  const t = store.byId('transactions', id);
  if (!t) return;
  const canAct = canApproveTransactions() && ['PENDING_APPROVAL', 'PENDING'].includes(t.status);
  const body = `<div class="o_detail_head">
      <div><span class="o_detail_ref">${escHtml(t.reference_no || '—')}</span> ${statusBadge(t.status, statusLabel(t.status))}</div>
      <div class="o_detail_type">${txLabel(t.transaction_type)}</div>
    </div>
    ${detailMeta(t)}
    ${t.rejection_reason ? alertBox(`${tx('سبب الرفض', 'Rejection reason')}: ${escHtml(t.rejection_reason)}`, 'danger') : ''}
    ${t.notes ? alertBox(escHtml(t.notes), 'info') : ''}
    <h4 class="o_section_title">${tx('بنود السند', 'Voucher lines')}</h4>
    ${detailTable(t)}`;

  modal({
    title: `${tx('سند', 'Voucher')} ${escHtml(t.reference_no || '')}`,
    size: 'xl',
    body,
    footer: `<button class="o_btn o_btn_secondary" id="txViewClose">${tx('إغلاق', 'Close')}</button>
      <button class="o_btn o_btn_ghost" id="txViewPrint"><i class="fa-solid fa-print"></i> ${tx('طباعة', 'Print')}</button>
      ${canAct ? `<button class="o_btn o_btn_danger" id="txViewReject">${tx('رفض', 'Reject')}</button>
        <button class="o_btn o_btn_success" id="txViewApprove">${tx('اعتماد', 'Approve')}</button>` : ''}`,
    onMount: (el, close) => {
      el.querySelector('#txViewClose').onclick = close;
      el.querySelector('#txViewPrint').onclick = () => printTransaction(t);
      if (canAct) {
        el.querySelector('#txViewApprove').onclick = async () => {
          const ok = await confirmDialog({
            title: tx('اعتماد السند', 'Approve voucher'),
            message: tx('سيؤدي الاعتماد إلى ترحيل الكميات ودفاتر الحركة. هل تريد المتابعة؟', 'Approval posts quantities and stock ledgers. Continue?'),
            confirmText: tx('اعتماد', 'Approve')
          });
          if (!ok) return;
          try {
            await approveTransaction(t.id);
            close();
            toast(tx('تم اعتماد السند.', 'Voucher approved.'), 'success');
            reloadTransactions();
          } catch (e) { toast(escHtml(friendlyError(e)), 'error'); }
        };
        el.querySelector('#txViewReject').onclick = async () => {
          const reason = await promptDialog({
            title: tx('رفض السند', 'Reject voucher'),
            label: tx('سبب الرفض', 'Rejection reason'),
            multiline: true,
            confirmText: tx('رفض', 'Reject')
          });
          if (reason == null) return;
          try {
            await rejectTransaction(t.id, reason);
            close();
            toast(tx('تم رفض السند.', 'Voucher rejected.'), 'success');
            reloadTransactions();
          } catch (e) { toast(escHtml(friendlyError(e)), 'error'); }
        };
      }
    }
  });
}

async function doApprove(id) {
  const t = store.byId('transactions', id);
  if (!t) return;
  const ok = await confirmDialog({
    title: tx('اعتماد السند', 'Approve voucher'),
    message: `${t.reference_no || ''} — ${tx('سيتم ترحيل الكميات إلى المخزون.', 'Quantities will be posted to stock.')}`,
    confirmText: tx('اعتماد', 'Approve')
  });
  if (!ok) return;
  try {
    await approveTransaction(id);
    toast(tx('تم اعتماد السند.', 'Voucher approved.'), 'success');
    reloadTransactions();
  } catch (e) { toast(escHtml(friendlyError(e)), 'error'); }
}

async function doReject(id) {
  const reason = await promptDialog({
    title: tx('رفض السند', 'Reject voucher'),
    label: tx('سبب الرفض', 'Rejection reason'),
    multiline: true,
    confirmText: tx('رفض', 'Reject')
  });
  if (reason == null) return;
  try {
    await rejectTransaction(id, reason);
    toast(tx('تم رفض السند.', 'Voucher rejected.'), 'success');
    reloadTransactions();
  } catch (e) { toast(escHtml(friendlyError(e)), 'error'); }
}

function printTransaction(t) {
  const lines = t.transaction_lines || [];
  const meta = [
    [tx('المرجع', 'Reference'), t.reference_no || '—'],
    [tx('النوع', 'Type'), txLabel(t.transaction_type)],
    [tx('الحالة', 'Status'), statusLabel(t.status)],
    [tx('المستودع', 'Warehouse'), warehouseName(t.warehouse_id)],
    [tx('المورد', 'Supplier'), t.supplier || '—'],
    [tx('المستلم', 'Receiver'), t.receiver_name || '—'],
    [tx('جهة الاستخدام', 'Usage party'), t.usage_party || '—'],
    [tx('سبب التسوية', 'Adjustment reason'), t.adjustment_reason || '—'],
    [tx('التاريخ', 'Date'), fmtDateTime(t.created_at)]
  ];
  const metaHtml = `<table>${meta.map(([k, v]) => `<tr><th style="width:32%">${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('')}</table>`;
  const body = `${metaHtml}<h3>${tx('البنود', 'Lines')}</h3>${detailTable(t)}`;
  printHTML(`${tx('سند مخزون', 'Stock voucher')} ${t.reference_no || ''}`, body, { subtitle: statusLabel(t.status) });
}

function printRegister() {
  const rows = filtered();
  const body = table([
    tx('المرجع', 'Reference'), tx('النوع', 'Type'), tx('المستودع', 'Warehouse'),
    tx('أنشأه', 'Created by'), tx('التاريخ', 'Date'), tx('الكمية', 'Qty'), tx('الحالة', 'Status')
  ], rows.map(t => [
    escHtml(t.reference_no || '—'), escHtml(txLabel(t.transaction_type)), escHtml(warehouseName(t.warehouse_id)),
    escHtml(t._creator?.name || t._creator?.email || '—'), escHtml(fmtDateTime(t.created_at)), fmtNum(t.total_qty), escHtml(statusLabel(t.status))
  ]));
  printHTML(tx('سجل السندات', 'Voucher register'), body);
}

function exportTxs() {
  const rows = filtered();
  downloadCSV(`vouchers-${todayISO()}.csv`,
    [tx('المرجع', 'Reference'), tx('النوع', 'Type'), tx('المستودع', 'Warehouse'), tx('المورد', 'Supplier'), tx('المستلم', 'Receiver'), tx('جهة الاستخدام', 'Usage party'), tx('الحالة', 'Status'), tx('الكمية', 'Qty'), tx('التاريخ', 'Date')],
    rows.map(t => [t.reference_no || '', txLabel(t.transaction_type), warehouseName(t.warehouse_id), t.supplier || '', t.receiver_name || '', t.usage_party || '', statusLabel(t.status), t.total_qty || 0, t.created_at || '']));
}

/* ── returns ───────────────────────────────────────────────────────────── */

function openReturn(type) {
  const returnType = String(type || 'RETURN_FROM_CUSTOMER').toUpperCase();
  const permission = returnType === 'RETURN_TO_SUPPLIER' ? 'action:transaction:issue:create' : 'action:transaction:grn:create';
  if (!(isElevated() || can(permission))) return toast(tx('لا تملك صلاحية إنشاء هذا المرتجع.', 'You do not have permission to create this return.'), 'error');
  const warehouses = accessibleWarehouseOptions();
  const warehouseId = warehouses[0]?.value || '';
  const shelves = shelfOptions({ warehouseId });
  const title = returnType === 'RETURN_TO_SUPPLIER'
    ? tx('مرتجع إلى مورد', 'Return to supplier')
    : returnType === 'RETURN_FROM_USAGE'
      ? tx('مرتجع من الاستخدام', 'Return from usage')
      : tx('مرتجع من عميل', 'Customer return');
  const needsDocumentReference = returnType !== 'RETURN_TO_SUPPLIER';
  const body = `<div id="retError"></div>
    <form id="returnForm" class="o_form_grid">
      ${field(tx('رقم السند', 'Voucher reference'),
        `<div style="display:flex;gap:8px;align-items:center">
          <input class="o_form_input" name="reference_no" id="retReference" readonly placeholder="${tx('يُولّد تلقائياً', 'Generated automatically')}">
          <button type="button" class="o_btn o_btn_secondary o_btn_sm" id="retRefRetry" hidden title="${tx('إعادة المحاولة', 'Retry')}"><i class="fa-solid fa-rotate"></i></button>
        </div>
        <small class="o_hint" id="retRefState"></small>`, { required: true })}
      ${select({ name: 'warehouse_id', label: tx('المستودع', 'Warehouse'), options: warehouses, value: warehouseId, required: true })}
      ${select({ name: 'item_id', label: tx('الصنف', 'Item'), options: itemOptions({ activeOnly: true }), required: true, placeholder: tx('اختر الصنف', 'Select item') })}
      ${select({ name: 'shelf_id', label: tx('الرف', 'Shelf'), options: shelves, value: shelves[0]?.value || '', required: true, placeholder: tx('اختر الرف', 'Select shelf') })}
      ${input({ name: 'quantity', label: tx('الكمية', 'Quantity'), type: 'number', required: true, attrs: 'min="0.001" step="any"', placeholder: '0' })}
      ${input({ name: 'batch_no', label: tx('التشغيلة', 'Batch'), placeholder: 'OPENING' })}
      ${input({ name: 'expiry_date', label: tx('تاريخ الصلاحية', 'Expiry date'), type: 'date' })}
      ${returnType === 'RETURN_TO_SUPPLIER' ? input({ name: 'supplier', label: tx('المورد', 'Supplier'), required: true, placeholder: tx('اسم المورد', 'Supplier name') }) : ''}
      ${input({ name: 'external_reference', label: tx('مرجع المستند', 'Document reference'), required: needsDocumentReference, placeholder: tx('مرجع المستند', 'Document reference') })}
      ${textarea({ name: 'notes', label: tx('ملاحظات', 'Notes'), rows: 2, placeholder: tx('سبب الإرجاع', 'Reason for return') })}
    </form>
    <div id="retAvailable" class="o_hint"></div>`;
  modal({
    title: `<i class="fa-solid fa-rotate-left"></i> ${title}`,
    size: 'lg',
    body,
    footer: `<button class="o_btn o_btn_secondary" id="retCancel">${tx('إلغاء', 'Cancel')}</button>
      <button class="o_btn o_btn_primary" id="retCreate"><i class="fa-solid fa-check"></i> ${tx('إنشاء المرتجع', 'Create return')}</button>`,
    onMount: (el, close) => {
      const form = el.querySelector('#returnForm');
      const wh = form.querySelector('[name="warehouse_id"]');
      const item = form.querySelector('[name="item_id"]');
      const shelf = form.querySelector('[name="shelf_id"]');
      const qty = form.querySelector('[name="quantity"]');
      const batch = form.querySelector('[name="batch_no"]');
      const refInput = form.querySelector('[name="reference_no"]');
      const refRetry = el.querySelector('#retRefRetry');
      const refState = el.querySelector('#retRefState');
      const createBtn = el.querySelector('#retCreate');
      const err = el.querySelector('#retError');
      const avail = el.querySelector('#retAvailable');
      let referenceRequest = 0;
      const loadReference = async () => {
        const requestId = ++referenceRequest;
        createBtn.disabled = true;
        refRetry.hidden = true;
        refRetry.disabled = true;
        refState.textContent = tx('جارٍ توليد رقم السند…', 'Generating voucher reference…');
        try {
          const result = await requestTransactionReference();
          if (!el.isConnected || requestId !== referenceRequest) return;
          if (result.provisional) {
            refInput.value = '';
            refState.textContent = tx('المرتجعات تتطلب اتصالاً مباشراً بقاعدة البيانات. أعد الاتصال ثم حاول مجددًا.',
              'Returns require a live database connection. Reconnect and try again.');
            refRetry.hidden = false;
            return;
          }
          refInput.value = result.reference;
          refState.textContent = tx('رقم سند رسمي من الخادم.', 'Official server reference.');
        } catch (e) {
          if (!el.isConnected || requestId !== referenceRequest) return;
          refInput.value = '';
          refState.textContent = friendlyError(e);
          refRetry.hidden = false;
        } finally {
          if (el.isConnected && requestId === referenceRequest) {
            refRetry.disabled = false;
            createBtn.disabled = !refInput.value.trim();
          }
        }
      };
      const refreshShelves = () => {
        const list = shelfOptions({ warehouseId: wh.value });
        shelf.innerHTML = `<option value="">${tx('اختر الرف', 'Select shelf')}</option>` + list.map(o => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join('');
        if (list.length === 1) shelf.value = list[0].value;
      };
      const refreshAvail = () => {
        if (!item.value || !shelf.value) { avail.textContent = ''; return; }
        avail.textContent = availableLabel(item.value, shelf.value, batch.value);
      };
      wh.addEventListener('change', () => { refreshShelves(); refreshAvail(); });
      item.addEventListener('change', refreshAvail);
      shelf.addEventListener('change', refreshAvail);
      batch.addEventListener('input', refreshAvail);
      refRetry.onclick = loadReference;
      el.querySelector('#retCancel').onclick = close;
      createBtn.onclick = async () => {
        err.innerHTML = '';
        const data = Object.fromEntries(new FormData(form).entries());
        const q = Number(data.quantity);
        const shelfRow = store.byId('shelves', data.shelf_id);
        const reference = String(data.reference_no || '').trim();
        const problems = [];
        if (!reference || /^LOCAL-/i.test(reference)) problems.push(tx('انتظر توليد رقم السند الرسمي. المرتجعات تتطلب اتصالاً مباشراً.',
          'Wait for the official voucher reference. Returns require a live connection.'));
        if (!data.warehouse_id) problems.push(tx('اختر المستودع.', 'Select a warehouse.'));
        if (!data.item_id) problems.push(tx('اختر الصنف.', 'Select an item.'));
        if (!data.shelf_id || !shelfRow || shelfRow.warehouse_id !== data.warehouse_id) problems.push(tx('اختر رفاً يتبع المستودع.', 'Select a shelf in that warehouse.'));
        if (!Number.isFinite(q) || q <= 0) problems.push(tx('أدخل كمية موجبة.', 'Enter a positive quantity.'));
        if (returnType === 'RETURN_TO_SUPPLIER' && !String(data.supplier || '').trim()) problems.push(tx('اسم المورد مطلوب للمرتجع إلى المورد.', 'Supplier is required for a supplier return.'));
        if (needsDocumentReference && !String(data.external_reference || '').trim()) problems.push(tx('مرجع مستند المرتجع مطلوب.', 'The return document reference is required.'));
        if (['RETURN_TO_SUPPLIER', 'RETURN_FROM_USAGE'].includes(returnType) && data.item_id && data.shelf_id) {
          const available = availableQty(data.item_id, data.shelf_id, data.batch_no);
          if (q > available + 1e-9) problems.push(`${tx('المتاح', 'Available')}: ${fmtNum(available)}`);
        }
        if (problems.length) {
          err.innerHTML = alertBox(`<ul>${problems.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>`, 'danger');
          return;
        }
        createBtn.disabled = true;
        try {
          await createStockReturnRequest({
            returnType,
            referenceNo: reference,
            itemId: data.item_id,
            quantity: q,
            batchNo: data.batch_no || null,
            expiryDate: data.expiry_date || null,
            shelfId: data.shelf_id,
            supplier: data.supplier || null,
            externalReference: data.external_reference || null,
            notes: data.notes || null
          });
          close();
          toast(tx('تم إنشاء طلب المرتجع بانتظار المراجعة.', 'Return request created, pending review.'), 'success');
          reloadTransactions();
        } catch (e) {
          createBtn.disabled = false;
          err.innerHTML = alertBox(escHtml(friendlyError(e)), 'danger');
        }
      };
      loadReference();
    }
  });
}

/* ── opening balances (manager-only atomic RPC) ────────────────────────── */

function openingBalanceAllowed() {
  return ['SUPER_ADMIN', 'MANAGER'].includes(String(role() || '').toUpperCase())
    && can('action:transaction:adjustment:create');
}

function activeRows(table) {
  return store.get(table).filter(x => x.is_active !== false && String(x.status || 'ACTIVE').toUpperCase() !== 'INACTIVE');
}

function codeOf(x) {
  return String(x?.code || x?.department_code || x?.item_code || '');
}

function openingName(x) {
  return String(tx(x?.name_ar || x?.name || '', x?.name_en || x?.name || '') || codeOf(x));
}

function openingOptions(rows, selected, label, placeholder) {
  return `<option value="">— ${escHtml(placeholder)} —</option>` + rows.map(x =>
    `<option value="${escHtml(x.id)}" ${x.id === selected ? 'selected' : ''}>${escHtml(label(x))}</option>`).join('');
}

function accessibleWarehouses() {
  return activeRows('warehouses').filter(w => canAccessWarehouse(w.id));
}

function openingBalanceBody() {
  const warehouses = accessibleWarehouses();
  const items = activeRows('items');
  const areas = activeRows('storage_areas');
  const shelves = activeRows('shelves');
  const wh = warehouses.length === 1 ? warehouses[0].id : '';
  const areaRows = areas.filter(x => x.warehouse_id === wh);
  const area = areaRows.length === 1 ? areaRows[0].id : '';
  const shelfRows = shelves.filter(x => x.warehouse_id === wh && (!area || x.storage_area_id === area));
  const shelf = shelfRows.length === 1 ? shelfRows[0].id : '';

  const manual = `<div class="o_alert o_alert_warning"><i class="fa-solid fa-triangle-exclamation"></i><div>${tx('هذا النموذج ينشئ سند رصيد افتتاحي بحالة «بانتظار الاعتماد». لا يكتب الأرصدة مباشرة؛ تُحدّث الكميات ودفاتر الحركة عند الاعتماد فقط.', 'This creates an opening-balance voucher in Pending Approval. It never writes stock directly; stock and ledgers change only when approved.')}</div></div>
    <form id="obManualForm" class="o_form_grid">
      ${field(tx('الصنف', 'Item'), `<select class="o_form_input" name="item_id" required>${openingOptions(items, '', x => `${codeOf(x)} · ${openingName(x)}`, tx('اختر الصنف', 'Select item'))}</select>`, { required: true })}
      ${field(tx('المستودع', 'Warehouse'), `<select class="o_form_input" name="warehouse_id" id="obWarehouse" required>${openingOptions(warehouses, wh, x => `${codeOf(x)} · ${openingName(x)}`, tx('اختر المستودع', 'Select warehouse'))}</select>`, { required: true })}
      ${field(tx('منطقة التخزين', 'Storage area'), `<select class="o_form_input" name="storage_area_id" id="obArea" required>${openingOptions(areaRows, area, x => `${codeOf(x)} · ${openingName(x)}`, tx('اختر المنطقة', 'Select storage area'))}</select>`, { required: true })}
      ${field(tx('الرف', 'Shelf'), `<select class="o_form_input" name="shelf_id" id="obShelf" required>${openingOptions(shelfRows, shelf, x => `${codeOf(x)} · ${x.full_path || openingName(x)}`, tx('اختر الرف', 'Select shelf'))}</select>`, { required: true })}
      ${field(tx('الكمية الافتتاحية', 'Opening quantity'), `<input class="o_form_input" name="quantity" type="number" min="0.001" step="any" required>`, { required: true })}
      ${field(tx('رقم التشغيلة', 'Batch number'), `<input class="o_form_input" name="batch_no" placeholder="OPENING">`)}
      ${field(tx('تاريخ الصلاحية', 'Expiry date'), `<input class="o_form_input" name="expiry_date" type="date">`)}
      ${field(tx('ملاحظات ومصدر الرصيد', 'Notes / balance source'), `<textarea class="o_form_input" name="notes" rows="2" placeholder="${tx('محضر الجرد أو مرجع الرصيد الافتتاحي', 'Opening inventory sheet or source reference')}"></textarea>`, { full: true })}
    </form>
    <div id="obManualError"></div>
    <div class="o_form_actions"><button class="o_btn o_btn_primary" id="obSaveManual"><i class="fa-solid fa-check"></i> ${tx('إنشاء سند الرصيد', 'Create opening voucher')}</button></div>`;

  const csv = `<p class="o_hint">${tx('اربط كل صف بصنف ومستودع ومنطقة ورف. يمكن للملف أن يحتوي عدة مستودعات؛ ينشئ النظام سنداً مستقلاً لكل مستودع، وتُنشأ جميع السندات أو لا يُنشأ أي منها.', 'Map every row to an item, warehouse, storage area and shelf. A file may contain multiple warehouses; one voucher is created per warehouse, atomically for the whole batch.')}</p>
    <label class="o_field"><span>CSV</span><input class="o_form_input" type="file" id="obCsvFile" accept=".csv,text/csv"></label>
    <div id="obCsvStatus" class="o_hint"></div>
    <div class="o_form_actions">
      <button class="o_btn o_btn_secondary" id="obImportCsv"><i class="fa-solid fa-file-import"></i> ${tx('التحقق وإنشاء السندات', 'Validate & create vouchers')}</button>
      <button class="o_btn o_btn_ghost" id="obTemplate"><i class="fa-solid fa-download"></i> ${tx('تنزيل القالب', 'Download template')}</button>
    </div>`;

  return `${card(tx('إدخال يدوي', 'Manual entry'), manual)}${card(tx('رفع الأرصدة من CSV', 'Import balances from CSV'), csv)}`;
}

function fillOpeningSelect(selectEl, rows, selected, placeholder, label) {
  if (!selectEl) return;
  selectEl.innerHTML = openingOptions(rows, selected, label, placeholder);
  if (!selectEl.value && rows.length === 1) selectEl.value = rows[0].id;
}

function bindOpening(el, close) {
  const areas = activeRows('storage_areas');
  const shelves = activeRows('shelves');
  const form = el.querySelector('#obManualForm');
  if (!form) return;
  const wh = form.querySelector('#obWarehouse');
  const area = form.querySelector('#obArea');
  const shelf = form.querySelector('#obShelf');
  const error = el.querySelector('#obManualError');

  const fillShelves = (warehouseId, areaId, selected = '') => {
    const rows = shelves.filter(x => x.warehouse_id === warehouseId && (!areaId || x.storage_area_id === areaId));
    fillOpeningSelect(shelf, rows, selected, tx('اختر الرف', 'Select shelf'), x => `${codeOf(x)} · ${x.full_path || openingName(x)}`);
  };
  const fillAreas = (warehouseId, selected = '') => {
    const rows = areas.filter(x => x.warehouse_id === warehouseId);
    fillOpeningSelect(area, rows, selected, tx('اختر المنطقة', 'Select storage area'), x => `${codeOf(x)} · ${openingName(x)}`);
    fillShelves(warehouseId, area.value, '');
  };

  fillAreas(wh.value, area.value);
  fillShelves(wh.value, area.value, shelf.value);

  wh.addEventListener('change', () => { error.innerHTML = ''; fillAreas(wh.value); });
  area.addEventListener('change', () => { error.innerHTML = ''; fillShelves(wh.value, area.value); });

  el.querySelector('#obSaveManual').onclick = async () => {
    error.innerHTML = '';
    const data = Object.fromEntries(new FormData(form).entries());
    data._manual = true;
    data._row = 1;
    try {
      await submitOpeningRows([data], close);
    } catch (e) {
      error.innerHTML = alertBox(escHtml(friendlyError(e)), 'danger');
    }
  };
  el.querySelector('#obImportCsv').onclick = async () => {
    const status = el.querySelector('#obCsvStatus');
    error.innerHTML = '';
    if (status) status.textContent = '';
    const file = el.querySelector('#obCsvFile')?.files?.[0];
    if (!file) {
      if (status) status.textContent = tx('اختر ملف CSV أولاً.', 'Choose a CSV file first.');
      return;
    }
    try {
      const text = await file.text();
      const rows = parseOpeningCsv(text);
      if (status) status.textContent = tx('تم التحقق من بنية الملف. جارٍ التحقق من المراجع والكميات…', 'CSV structure parsed. Validating references and quantities…');
      await submitOpeningRows(rows, close);
    } catch (e) {
      if (status) status.textContent = friendlyError(e);
      error.innerHTML = alertBox(escHtml(friendlyError(e)), 'danger');
    }
  };
  el.querySelector('#obTemplate').onclick = downloadOpeningTemplate;
}

function openOpeningBalances() {
  if (!openingBalanceAllowed()) {
    return toast(tx('إنشاء الأرصدة الافتتاحية متاح للمدير أو المدير الأعلى فقط.', 'Opening balances are restricted to managers and super administrators.'), 'error');
  }
  modal({
    title: `<i class="fa-solid fa-scale-balanced"></i> ${tx('إدارة الأرصدة الافتتاحية', 'Opening balance management')}`,
    size: 'xl',
    body: openingBalanceBody(),
    footer: `<button class="o_btn o_btn_secondary" id="obClose">${tx('إلغاء', 'Cancel')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#obClose').onclick = close;
      bindOpening(el, close);
    }
  });
}

function parseOpeningCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell.trim()); cell = ''; }
    else if (c === '\n') { row.push(cell.trim()); if (row.some(v => v !== '')) rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (quoted) throw new Error(tx('ملف CSV يحتوي على علامة اقتباس غير مغلقة.', 'CSV contains an unclosed quote.'));
  if (cell !== '' || row.length) { row.push(cell.trim()); if (row.some(v => v !== '')) rows.push(row); }
  if (rows.length < 2) throw new Error(tx('يجب أن يحتوي الملف على صف عناوين وصف بيانات واحد على الأقل.', 'CSV needs a header and at least one data row.'));

  const norm = v => String(v || '').toLowerCase().replace(/[\s_\-./()]+/g, '');
  const aliases = {
    item_code: ['itemcode', 'sku', 'code', 'رمزالصنف', 'كودالصنف', 'الصنف'],
    warehouse_code: ['warehousecode', 'warehouseid', 'رمزالمستودع', 'كودالمستودع'],
    storage_area_code: ['storageareacode', 'storageareaid', 'zonecode', 'رمزمنطقةالتخزين', 'رمزالمنطقة'],
    shelf_code: ['shelfcode', 'shelfid', 'رمزالرف', 'كودالرف'],
    quantity: ['quantity', 'qty', 'openingquantity', 'openingbalance', 'الكمية', 'الرصيدالافتتاحي'],
    batch_no: ['batchno', 'batch', 'رقمالتشغيلة', 'التشغيلة'],
    expiry_date: ['expirydate', 'expirationdate', 'تاريخالصلاحية'],
    notes: ['notes', 'ملاحظات', 'البيان']
  };
  const headers = rows[0].map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const index = {};
  for (const field of Object.keys(aliases)) index[field] = headers.findIndex(h => aliases[field].includes(norm(h)));
  const required = ['item_code', 'warehouse_code', 'shelf_code', 'quantity'];
  const missing = required.filter(k => index[k] < 0);
  if (missing.length) throw new Error(tx('أعمدة مطلوبة مفقودة: ', 'Missing required CSV columns: ') + missing.join(', '));
  return rows.slice(1).map((r, i) => {
    const out = { _row: i + 2 };
    for (const k of Object.keys(index)) if (index[k] >= 0) out[k] = String(r[index[k]] ?? '').trim();
    return out;
  }).filter(r => Object.values(r).some(v => String(v || '').trim() !== ''));
}

function resolveOpening(table, value, warehouseId) {
  const v = String(value || '').trim();
  if (!v) return null;
  return store.get(table).find(x => x.id === v) ||
    store.get(table).find(x => String(x.code || '').toLowerCase() === v.toLowerCase()
      && (!warehouseId || x.warehouse_id === warehouseId)) || null;
}

function makeOpeningLine(raw, manual = false) {
  const item = manual ? store.byId('items', raw.item_id) : resolveOpening('items', raw.item_code);
  const warehouse = manual ? store.byId('warehouses', raw.warehouse_id) : resolveOpening('warehouses', raw.warehouse_code);
  const shelf = manual ? store.byId('shelves', raw.shelf_id) : resolveOpening('shelves', raw.shelf_code, warehouse?.id);
  const area = manual
    ? store.byId('storage_areas', raw.storage_area_id)
    : (raw.storage_area_code ? resolveOpening('storage_areas', raw.storage_area_code, warehouse?.id) : store.byId('storage_areas', shelf?.storage_area_id));
  const quantity = Number(raw.quantity);
  const suffix = raw._row ? ` · row ${raw._row}` : '';
  const fail = message => { throw new Error(message + suffix); };

  if (!item) fail(tx('الصنف غير معروف', 'Unknown item'));
  if (!warehouse) fail(tx('المستودع غير معروف', 'Unknown warehouse'));
  if (!canAccessWarehouse(warehouse.id)) fail(tx('لا تملك صلاحية العمل في هذا المستودع', 'You do not have permission to work in this warehouse'));
  if (!shelf || shelf.warehouse_id !== warehouse.id) fail(tx('الرف غير معروف أو لا يتبع المستودع المحدد', 'Shelf is unknown or belongs to a different warehouse'));
  if (!area || area.warehouse_id !== warehouse.id || shelf.storage_area_id !== area.id) {
    fail(tx('منطقة التخزين لا تطابق الرف والمستودع', 'Storage area does not match the shelf and warehouse'));
  }
  if (!Number.isFinite(quantity) || quantity <= 0) fail(tx('الكمية يجب أن تكون رقماً موجباً', 'Quantity must be a positive finite number'));
  const expiry = String(raw.expiry_date || '').trim();
  if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) fail(tx('تاريخ الصلاحية يجب أن يكون بصيغة YYYY-MM-DD', 'Expiry date must use YYYY-MM-DD'));

  return {
    warehouse_id: warehouse.id,
    line: {
      item_id: item.id,
      shelf_id: shelf.id,
      storage_area_id: area.id,
      quantity,
      batch_no: String(raw.batch_no || '').trim(),
      expiry_date: expiry || null,
      notes: String(raw.notes || '').trim() || null
    }
  };
}

async function submitOpeningRows(rows, close) {
  if (!navigator.onLine) throw new Error(tx('يتطلب إنشاء الأرصدة اتصالاً مباشراً بقاعدة البيانات.', 'Opening-balance creation requires a live database connection.'));
  const liveSession = await ensureOnlineSession();
  if (!liveSession?.id) throw new Error(tx('يتطلب إنشاء الأرصدة جلسة خادم نشطة. سجّل الدخول عبر الإنترنت ثم أعد المحاولة.', 'Opening balances require an active server session. Sign in online and try again.'));
  if (!openingBalanceAllowed()) throw new Error(tx('إنشاء الأرصدة الافتتاحية متاح للمدير أو المدير الأعلى فقط.', 'Opening balances are restricted to managers and super administrators.'));
  const grouped = new Map();
  const dupes = new Set();
  for (const raw of rows) {
    const made = makeOpeningLine(raw, !!raw._manual);
    const key = [made.warehouse_id, made.line.item_id, made.line.shelf_id, made.line.batch_no].join('|');
    if (dupes.has(key)) throw new Error(tx('يوجد تكرار للصنف والرف والتشغيلة في الملف؛ اجمع الكميات في صف واحد.', 'Duplicate item/shelf/batch row found; combine its quantity into one row.'));
    dupes.add(key);
    if (!grouped.has(made.warehouse_id)) {
      grouped.set(made.warehouse_id, {
        warehouse_id: made.warehouse_id,
        notes: tx('رصيد افتتاحي وارد من واجهة إدارة الأرصدة', 'Opening balance submitted through the opening-balance workspace'),
        lines: []
      });
    }
    grouped.get(made.warehouse_id).lines.push(made.line);
  }
  const vouchers = [...grouped.values()];
  if (!vouchers.length) throw new Error(tx('لا توجد صفوف صالحة.', 'No valid rows found.'));
  toast(tx('جارٍ التحقق وإنشاء سندات الأرصدة الافتتاحية…', 'Validating and creating opening-balance vouchers…'), 'info');
  const result = await rpc('create_opening_balance_vouchers', { p_vouchers: vouchers });
  const created = result?.created || [];
  await pullAll({ silent: true }).catch(() => {});
  close?.();
  toast(tx('تم إنشاء ', 'Created ') + created.length + tx(' سند رصيد افتتاحي بانتظار الاعتماد. لم تُرحّل الكميات بعد.', ' opening-balance voucher(s), pending approval. Quantities are not posted yet.'), 'success');
  await OW.wms.reloadInventory?.();
}

function downloadOpeningTemplate() {
  const headers = ['item_code', 'warehouse_code', 'storage_area_code', 'shelf_code', 'quantity', 'batch_no', 'expiry_date', 'notes'];
  const sample = ['ITEM-001', 'WH-001', 'AREA-001', 'SHELF-001', '10', 'OPENING', '', 'Opening balance source reference'];
  downloadCSV('OW-opening-balances-template.csv', headers, [sample]);
}

/* ── globals + registration ────────────────────────────────────────────── */

OW.wms = OW.wms || {};
OW.wms.newTx = openNewTx;
OW.wms.quickIssue = (itemId = null, options = {}) => openNewTx('ISSUE', {
  itemId: itemId || options.itemId || null,
  shelfId: options.shelfId || null,
  batchNo: options.batchNo || null,
  quick: true
});
OW.wms.openTransaction = openTransaction;
OW.wms.openReturn = openReturn;
OW.wms.reloadTransactions = reloadTransactions;
OW.wms.txTab = txTab;
OW.wms.printTxRegister = printRegister;
OW.wms.exportTxs = exportTxs;
OW.wms.openOpeningBalances = openOpeningBalances;
OW.wms.canOpenOpeningBalances = openingBalanceAllowed;
OW.wms.scanTransaction = () => openQrScanner({ mode: 'lookup' });

OW.registerPage('transactions', {
  brand: { name: 'OW', icon: 'fa-solid fa-file-invoice' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المخزون', 'Inventory'), page: 'inventory' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' },
    { label: tx('التحويلات', 'Transfers'), page: 'transfers' },
    { label: tx('التقارير', 'Reports'), page: 'reports' }
  ],
  render,
  mount: bind
});

export default OW.pages.transactions;
