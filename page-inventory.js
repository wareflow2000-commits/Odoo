// ============================================================================
// OW — Inventory (items, balances, locations)
// ============================================================================
import { OW } from './core-registry.js';
import { tx, friendlyError } from './core-i18n.js';
import {
  pageHead, card, statCard, table, empty, statusBadge, btn, alertBox,
  controlPanel, input, select, textarea, field, fmt, downloadCSV, printHTML, printDocument, esc
} from './core-ui.js';
import {
  store, insertRow, updateRow, deleteRow, itemLabel, itemNameOnly,
  warehouseName, shelfPath, warehouseOptions, shelfOptions, areaOptions,
  zoneOptions, stockQty, stockByItem, setting,
  itemBaseUnitLockReason, itemUnitFactor
} from './core-store.js';
import { canDatabasePermission } from './core-rbac.js';
import { fmtNum, fmtMoney, fmtDateTime, todayISO } from './core-utils.js';
import { toast } from './core-toast.js';
import { modal, confirmDialog } from './core-modal.js';
import { qrSvg } from './core-qr.js';

const F = { search: '', category: '', warehouse: '', status: 'ACTIVE', view: 'list' };

function categories() { return store.get('item_categories'); }
function categoryName(id) { return store.byId('item_categories', id)?.name || '—'; }

function baseUnitLockText(reason) {
  if (reason === 'CONVERSIONS') {
    return tx('احذف معاملات التحويل المعتمدة لهذا الصنف أولًا إذا كنت تحتاج فعلاً لتغيير وحدته الأساسية.',
      'Delete this item’s approved conversion factors first if you really need to change its base unit.');
  }
  if (reason) {
    return tx('الوحدة الأساسية مقفلة بعد بدء الحركات المخزنية. لا يؤثر وجود رصيد صفري في ذلك.',
      'The base unit is locked after stock movements begin. A zero balance does not unlock it.');
  }
  return tx('قابلة للتعديل قبل أول حركة مخزنية أو اعتماد تحويل فقط.',
    'Editable only before the first stock movement or approved conversion.');
}

function filteredItems() {
  const byItem = stockByItem();
  let list = store.get('items').map(i => ({ ...i, total_qty: byItem.get(i.id) || 0 }));
  if (F.status) list = list.filter(i => (i.status || 'ACTIVE') === F.status);
  if (F.category) list = list.filter(i => i.category_id === F.category);
  if (F.warehouse) {
    const ids = new Set(store.get('stock').filter(s => s.warehouse_id === F.warehouse).map(s => s.item_id));
    list = list.filter(i => ids.has(i.id));
  }
  if (F.search) {
    const q = F.search.toLowerCase();
    list = list.filter(i => [i.code, i.item_number, i.name_ar, i.name_en, i.category, i.supplier]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

function locationsFor(itemId) {
  return store.get('stock').filter(s => s.item_id === itemId && Number(s.quantity || 0) !== 0);
}

function render() {
  const list = filteredItems();
  const totalQty = list.reduce((n, i) => n + Number(i.total_qty), 0);
  const low = list.filter(i => Number(i.total_qty) <= Number(i.safety_stock || 0)).length;
  const out = list.filter(i => Number(i.total_qty) <= 0).length;
  const openingBalance = OW.wms?.canOpenOpeningBalances?.()
    ? btn(`<i class="fa-solid fa-scale-balanced"></i> ${tx('أرصدة افتتاحية', 'Opening balances')}`, 'onclick="OW.wms.openOpeningBalances()"', 'secondary')
    : '';

  return `
  ${pageHead(tx('المخزون', 'Inventory'),
    tx('الأصناف والأرصدة والمواقع — مع دعم باركود QR', 'Items, balances and locations with QR labels'),
    `${openingBalance}
     ${canDatabasePermission('action:item:create') ? btn(`<i class="fa-solid fa-plus"></i> ${tx('صنف جديد', 'New item')}`, 'onclick="OW.wms.itemModal()"', 'primary') : ''}
     ${btn(`<i class="fa-solid fa-qrcode"></i> ${tx('طباعة ملصقات', 'Print labels')}`, 'onclick="OW.wms.printAllLabels()"', 'secondary')}
     ${btn(`<i class="fa-solid fa-file-csv"></i> ${tx('تصدير', 'Export')}`, 'onclick="OW.wms.exportItems()"', 'secondary')}`)}
  ${controlPanel({
    breadcrumb: [{ label: tx('العمليات', 'Operations') }, { label: tx('المخزون', 'Inventory') }],
    searchPlaceholder: tx('ابحث بالرمز أو الاسم أو المورد…', 'Search code, name or supplier…'),
    filters: `
      <select class="o_filter_select" id="invCat">
        <option value="">${tx('كل الفئات', 'All categories')}</option>
        ${categories().map(c => `<option value="${c.id}" ${F.category === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
      <select class="o_filter_select" id="invWh">
        <option value="">${tx('كل المستودعات', 'All warehouses')}</option>
        ${warehouseOptions().map(o => `<option value="${o.value}" ${F.warehouse === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <select class="o_filter_select" id="invStatus">
        <option value="ACTIVE" ${F.status === 'ACTIVE' ? 'selected' : ''}>${tx('النشطة', 'Active')}</option>
        <option value="" ${F.status === '' ? 'selected' : ''}>${tx('الكل', 'All')}</option>
        <option value="INACTIVE" ${F.status === 'INACTIVE' ? 'selected' : ''}>${tx('غير النشطة', 'Inactive')}</option>
      </select>`,
    actions: `${btn('', 'onclick="OW.wms.reloadInventory()"', 'ghost', 'fa-solid fa-rotate')}`
  })}
  <div class="o_page_body">
    <div class="o_grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      ${statCard({ label: tx('الأصناف', 'Items'), value: fmtNum(list.length), icon: 'fa-solid fa-boxes-stacked', tone: 'purple' })}
      ${statCard({ label: tx('إجمالي الكمية', 'Total qty'), value: fmtNum(totalQty), icon: 'fa-solid fa-cubes-stacked', tone: 'blue' })}
      ${statCard({ label: tx('مخزون منخفض', 'Low stock'), value: fmtNum(low), icon: 'fa-solid fa-triangle-exclamation', tone: 'amber' })}
      ${statCard({ label: tx('نافد', 'Out of stock'), value: fmtNum(out), icon: 'fa-solid fa-ban', tone: 'red' })}
    </div>
    ${card('', table(
      [
        { label: tx('الرمز', 'Code') }, { label: tx('الصنف', 'Item') }, { label: tx('الفئة', 'Category') },
        { label: tx('الوحدة', 'Unit') }, { label: tx('المتاح', 'On hand'), num: true },
        { label: tx('حد الأمان', 'Safety'), num: true }, { label: tx('المواقع', 'Locations'), num: true },
        { label: tx('الحالة', 'Status') }, { label: tx('إجراءات', 'Actions') }
      ],
      list.map(i => {
        const locs = locationsFor(i.id).length;
        const qty = Number(i.total_qty);
        return {
          cls: qty <= 0 ? 'rt-danger' : (Number(i.safety_stock || 0) > 0 && qty < Number(i.safety_stock)) ? 'rt-warn' : '',
          cells: [
            `<code>${i.code || '—'}</code>`,
            `<span class="o_cell_main">${itemNameOnly(i)}</span>${i.item_number ? `<div class="o_cell_sub">${i.item_number}</div>` : ''}`,
            categoryName(i.category_id) !== '—' ? categoryName(i.category_id) : (i.category || '—'),
            i.base_unit || '—',
            `<b>${fmtNum(qty)}</b>`,
            fmtNum(i.safety_stock),
            fmtNum(locs),
            statusBadge(i.status || 'ACTIVE', i.status === 'INACTIVE' ? tx('غير نشط', 'Inactive') : tx('نشط', 'Active')),
            `<div class="o_actions_cell">
              <button class="o_btn o_btn_ghost o_btn_sm" data-view="${i.id}" title="${tx('تفاصيل', 'Details')}"><i class="fa-solid fa-eye"></i></button>
              ${canDatabasePermission('action:item:update') ? `<button class="o_btn o_btn_ghost o_btn_sm" data-edit="${i.id}" title="${tx('تعديل', 'Edit')}"><i class="fa-solid fa-pen"></i></button>` : ''}
              <button class="o_btn o_btn_ghost o_btn_sm" data-qr="${i.id}" title="QR"><i class="fa-solid fa-qrcode"></i></button>
              ${canDatabasePermission('action:item:delete') ? `<button class="o_btn o_btn_ghost o_btn_sm" data-del="${i.id}" title="${tx('حذف', 'Delete')}"><i class="fa-solid fa-trash"></i></button>` : ''}
            </div>`
          ]
        };
      }),
      { emptyTitle: tx('لا توجد أصناف', 'No items'), emptyNote: tx('أضف صنفًا للبدء.', 'Add an item to get started.') }
    ), '', 'flush-body')}
  </div>`;
}

function bind(_params, main) {
  const search = main.querySelector('#oSearchInput');
  if (search) {
    search.value = F.search;
    search.addEventListener('input', () => { F.search = search.value; reload(); });
  }
  const cat = main.querySelector('#invCat'); cat && (cat.onchange = () => { F.category = cat.value; reload(); });
  const wh = main.querySelector('#invWh'); wh && (wh.onchange = () => { F.warehouse = wh.value; reload(); });
  const st = main.querySelector('#invStatus'); st && (st.onchange = () => { F.status = st.value; reload(); });

  main.querySelectorAll('[data-view]').forEach(b => b.onclick = () => openDetails(b.dataset.view));
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => itemModal(b.dataset.edit));
  main.querySelectorAll('[data-qr]').forEach(b => b.onclick = () => printLabels([store.byId('items', b.dataset.qr)]));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removeItem(b.dataset.del));
}

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('inventory'));
}

/* ── item form ──────────────────────────────────────────────────────────── */

function itemModal(id = null) {
  const permission = id ? 'action:item:update' : 'action:item:create';
  if (!canDatabasePermission(permission)) {
    toast(tx('لا تملك صلاحية تنفيذ هذا الإجراء.', 'You are not authorized to perform this action.'), 'error');
    return;
  }
  const it = id ? store.byId('items', id) : {};
  const catOpts = categories().map(c => ({ value: c.id, label: c.name }));
  const units = store.get('units');
  const unitCodes = [...new Set([...units.map(u => u.code), 'PCS', 'KG', 'L', 'BOX', 'PACK'])]
    .filter(Boolean).map(u => ({ value: String(u).toUpperCase(), label: String(u).toUpperCase() }));
  const lockReason = id ? itemBaseUnitLockReason(id) : '';
  const purchaseFactor = it.purchase_unit ? itemUnitFactor(id || '', it.purchase_unit) : 1;

  const whId = it.default_warehouse_id || store.get('warehouses')[0]?.id || '';
  const areas = areaOptions(whId);

  const body = `<form id="itemForm" class="o_form_grid">
    ${input({ name: 'code', label: tx('رمز الصنف', 'Item code'), value: it.code || '', required: true })}
    ${input({ name: 'item_number', label: tx('رقم الصنف', 'Item number'), value: it.item_number || '' })}
    ${input({ name: 'name_ar', label: tx('الاسم بالعربية', 'Arabic name'), value: it.name_ar || '' })}
    ${input({ name: 'name_en', label: tx('الاسم بالإنجليزية', 'English name'), value: it.name_en || '', required: true })}
    ${select({ name: 'category_id', label: tx('الفئة', 'Category'), options: catOpts, value: it.category_id || '', placeholder: tx('بدون فئة', 'No category') })}
    ${select({ name: 'status', label: tx('الحالة', 'Status'), options: [{ value: 'ACTIVE', label: tx('نشط', 'Active') }, { value: 'INACTIVE', label: tx('غير نشط', 'Inactive') }], value: it.status || 'ACTIVE' })}
    ${field(tx('الوحدة الأساسية', 'Base unit'),
      `<select class="o_form_input" name="base_unit" required ${lockReason ? 'disabled' : ''}>
        ${unitCodes.map(u => `<option value="${esc(u.value)}" ${String(u.value) === String(it.base_unit || 'PCS').toUpperCase() ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}
      </select>`,
      { required: true, hint: baseUnitLockText(lockReason) })}
    ${select({ name: 'purchase_unit', label: tx('وحدة الشراء', 'Purchase unit'), options: unitCodes, value: it.purchase_unit || '', placeholder: tx('نفس الوحدة الأساسية', 'Same as base') })}
    ${field(tx('معامل وحدة الشراء', 'Purchase-unit factor'),
      `<div class="o_form_input" style="display:flex;align-items:center;min-height:38px;background:#f7f7f8">
        ${it.purchase_unit
          ? (purchaseFactor && Number.isFinite(Number(purchaseFactor))
            ? `1 ${esc(it.purchase_unit)} = ${fmtNum(purchaseFactor)} ${esc(it.base_unit || 'PCS')}`
            : tx('غير مهيأ — اعتمد المعامل من الإعدادات', 'Not configured — approve it in Settings'))
          : tx('لا توجد وحدة شراء منفصلة', 'No separate purchase unit')}
      </div>`,
      { hint: tx('تُدار معاملات التحويل من الإعدادات > تحويلات الوحدات. لا تُستخدم القيمة القديمة في أي حساب.',
        'Conversion factors are managed in Settings > Unit conversions. The legacy value is never used in calculations.') })}
    ${input({ name: 'safety_stock', label: tx('حد الأمان', 'Safety stock'), type: 'number', value: it.safety_stock ?? 0, attrs: 'min="0" step="any"' })}
    ${field(tx('التكلفة', 'Cost'),
      `<input class="o_form_input" name="cost" type="number" min="0" step="any" value="${esc(it.cost ?? 0)}">`,
      { hint: it.purchase_unit
        ? tx(`لكل ${it.purchase_unit}. سعر الوحدة الأساسية = التكلفة ÷ معامل ${it.purchase_unit}.`,
          `Per ${it.purchase_unit}. Base-unit cost = cost ÷ ${it.purchase_unit} factor.`)
        : tx('لكل وحدة أساسية.', 'Per base unit.') })}
    ${input({ name: 'supplier', label: tx('المورد', 'Supplier'), value: it.supplier || '' })}
    ${select({ name: 'default_warehouse_id', label: tx('المستودع الافتراضي', 'Default warehouse'), options: warehouseOptions(), value: whId, placeholder: tx('بدون', 'None') })}
    ${select({ name: 'default_storage_area_id', label: tx('منطقة التخزين', 'Storage area'), options: areas, value: it.default_storage_area_id || '', placeholder: tx('بدون', 'None') })}
    ${select({ name: 'default_shelf_id', label: tx('الرف الافتراضي', 'Default shelf'), options: shelfOptions({ warehouseId: whId }), value: it.default_shelf_id || '', placeholder: tx('بدون', 'None') })}
    <div class="o_field full"><label class="o_checkbox"><input type="checkbox" name="hazardous" ${it.hazardous ? 'checked' : ''}> ${tx('مادة خطرة', 'Hazardous material')}</label></div>
    ${textarea({ name: 'description', label: tx('الوصف', 'Description'), rows: 2 })}
  </form>`;

  modal({
    title: `<i class="fa-solid fa-box"></i> ${id ? tx('تعديل صنف', 'Edit item') : tx('صنف جديد', 'New item')}`,
    size: 'lg', body,
    footer: `<button class="o_btn o_btn_secondary" id="itemCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="itemSave"><i class="fa-solid fa-floppy-disk"></i> ${tx('حفظ', 'Save')}</button>`,
    onMount: (el, close) => {
      const whSel = el.querySelector('[name="default_warehouse_id"]');
      const areaSel = el.querySelector('[name="default_storage_area_id"]');
      const shelfSel = el.querySelector('[name="default_shelf_id"]');
      whSel.onchange = () => {
        const opts = shelfOptions({ warehouseId: whSel.value });
        shelfSel.innerHTML = `<option value="">${tx('بدون', 'None')}</option>` + opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
        const ars = areaOptions(whSel.value);
        areaSel.innerHTML = `<option value="">${tx('بدون', 'None')}</option>` + ars.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
      };
      el.querySelector('#itemCancel').onclick = close;
      el.querySelector('#itemSave').onclick = async () => {
        const d = Object.fromEntries(new FormData(el.querySelector('#itemForm')).entries());
        if (!d.code.trim() || !d.name_en.trim()) {
          toast(tx('الرمز والاسم الإنجليزي مطلوبان', 'Code and English name are required'), 'warning'); return;
        }
        const payload = {
          code: d.code.trim(), item_number: d.item_number || null,
          name_ar: d.name_ar || null, name_en: d.name_en.trim(),
          category_id: d.category_id || null,
          status: d.status || 'ACTIVE',
          base_unit: lockReason ? (it.base_unit || 'PCS') : (String(d.base_unit || 'PCS').toUpperCase()),
          purchase_unit: d.purchase_unit ? String(d.purchase_unit).toUpperCase() : null,
          safety_stock: Number(d.safety_stock || 0),
          cost: Number(d.cost || 0),
          supplier: d.supplier || null,
          hazardous: !!d.hazardous,
          default_warehouse_id: d.default_warehouse_id || null,
          default_storage_area_id: d.default_storage_area_id || null,
          default_shelf_id: d.default_shelf_id || null,
          description: d.description || null,
          updated_at: new Date().toISOString()
        };
        try {
          if (id) await updateRow('items', id, payload);
          else await insertRow('items', { ...payload, created_at: new Date().toISOString() });
          close();
          toast(tx('تم حفظ الصنف', 'Item saved'), 'success');
          reload();
        } catch (e) { toast(friendlyError(e), 'error'); }
      };
    }
  });
}

async function removeItem(id) {
  if (!canDatabasePermission('action:item:delete')) {
    toast(tx('لا تملك صلاحية حذف الأصناف.', 'You are not authorized to delete items.'), 'error');
    return;
  }
  const it = store.byId('items', id);
  if (!it) return;
  const qty = stockQty(id);
  const ok = await confirmDialog({
    title: tx('حذف صنف', 'Delete item'),
    message: `<b>${itemNameOnly(it)}</b><br>${qty > 0
      ? tx('تحذير: لهذا الصنف رصيد مخزون. قد يفشل الحذف بسبب قيود قاعدة البيانات.',
        'Warning: this item has stock. Deletion may be blocked by database constraints.')
      : tx('هل تريد الحذف نهائيًا؟', 'Delete permanently?')}`,
    confirmText: tx('حذف', 'Delete'), dangerous: true
  });
  if (!ok) return;
  try {
    await deleteRow('items', id);
    toast(tx('تم حذف الصنف', 'Item deleted'), 'success');
    reload();
  } catch (e) { toast(friendlyError(e), 'error'); }
}

/* ── item details ───────────────────────────────────────────────────────── */

function openDetails(id) {
  const it = store.byId('items', id);
  if (!it) return;
  const locs = locationsFor(id);
  const total = locs.reduce((n, s) => n + Number(s.quantity || 0), 0);
  const purchaseFactor = it.purchase_unit ? itemUnitFactor(id, it.purchase_unit) : null;
  const costNumber = Number(it.cost || 0);
  const baseCost = purchaseFactor && purchaseFactor > 0
    ? costNumber / purchaseFactor
    : (it.purchase_unit ? null : costNumber);
  const body = `
    <div class="o_item_head">
      <div class="o_item_avatar"><i class="fa-solid fa-box"></i></div>
      <div>
        <div class="o_tx_ref">${itemNameOnly(it)}</div>
        <div class="o_muted">${it.code} ${it.item_number ? '• ' + it.item_number : ''}</div>
      </div>
      <div class="o_item_total"><small>${tx('المتاح', 'On hand')}</small><b>${fmtNum(total)}</b><span>${it.base_unit || ''}</span></div>
    </div>
    <dl class="o_kv">
      <dt>${tx('الفئة', 'Category')}</dt><dd>${categoryName(it.category_id)}</dd>
      <dt>${tx('الوحدة الأساسية', 'Base unit')}</dt><dd>${it.base_unit || '—'}</dd>
      <dt>${tx('وحدة الشراء', 'Purchase unit')}</dt><dd>${it.purchase_unit
        ? (purchaseFactor && Number.isFinite(Number(purchaseFactor))
          ? `${it.purchase_unit} — 1 = ${fmtNum(purchaseFactor)} ${it.base_unit || 'PCS'}`
          : `${it.purchase_unit} — ${tx('غير مهيأة', 'not configured')}`)
        : '—'}</dd>
      <dt>${tx('حد الأمان', 'Safety stock')}</dt><dd>${fmtNum(it.safety_stock)}</dd>
      <dt>${tx('التكلفة', 'Cost')}</dt><dd>${fmtMoney(it.cost)}
        <small class="o_muted">/ ${it.purchase_unit || it.base_unit || 'PCS'}</small>
        ${costNumber > 0 && baseCost != null ? `<br><small class="o_muted">${fmtMoney(baseCost)} / ${it.base_unit || 'PCS'}</small>` : ''}
      </dd>
      <dt>${tx('المورد', 'Supplier')}</dt><dd>${it.supplier || '—'}</dd>
      <dt>${tx('الموقع الافتراضي', 'Default location')}</dt><dd>${it.default_shelf_id ? shelfPath(it.default_shelf_id) : (it.default_warehouse_id ? warehouseName(it.default_warehouse_id) : '—')}</dd>
      <dt>${tx('الحالة', 'Status')}</dt><dd>${statusBadge(it.status || 'ACTIVE', it.status === 'INACTIVE' ? tx('غير نشط', 'Inactive') : tx('نشط', 'Active'))}</dd>
    </dl>
    <div class="o_section_label">${tx('الأرصدة حسب الموقع', 'Balances by location')}</div>
    ${table(
      [{ label: tx('المستودع', 'Warehouse') }, { label: tx('الموقع', 'Location') }, { label: tx('التشغيلة', 'Batch') },
       { label: tx('الصلاحية', 'Expiry') }, { label: tx('الكمية', 'Quantity'), num: true }],
      locs.map(s => ({
        cells: [warehouseName(s.warehouse_id), shelfPath(s.shelf_id), s.batch_no || '—', s.expiry_date || '—', fmtNum(s.quantity)]
      })),
      { emptyTitle: tx('لا يوجد رصيد', 'No stock') }
    )}`;

  modal({
    title: `<i class="fa-solid fa-box"></i> ${tx('تفاصيل الصنف', 'Item details')}`,
    size: 'lg', body,
    footer: `<button class="o_btn o_btn_secondary" id="dQr"><i class="fa-solid fa-qrcode"></i> ${tx('ملصق QR', 'QR label')}</button>
      ${canDatabasePermission('action:transaction:issue:create') ? `<button class="o_btn o_btn_secondary" id="dIssue">${tx('صرف', 'Issue')}</button>` : ''}
      ${canDatabasePermission('action:item:update') ? `<button class="o_btn o_btn_secondary" id="dEdit">${tx('تعديل', 'Edit')}</button>` : ''}
      <button class="o_btn o_btn_primary" id="dClose">${tx('إغلاق', 'Close')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#dClose').onclick = close;
      el.querySelector('#dQr').onclick = () => printLabels([it]);
      el.querySelector('#dIssue')?.addEventListener('click', () => { close(); OW.wms.newTx('ISSUE'); });
      el.querySelector('#dEdit')?.addEventListener('click', () => { close(); itemModal(id); });
    }
  });
}

/* ── QR labels ──────────────────────────────────────────────────────────── */

function qrPayload(kind, record) {
  return JSON.stringify({
    app: 'OW-WMS', version: 1, type: kind, id: record.id,
    code: record.code || record.item_number || '',
    name: record.name || record.name_ar || record.name_en || record.full_path || ''
  });
}

function printLabels(items) {
  if (!items.length) { toast(tx('لا توجد سجلات للطباعة', 'Nothing to print'), 'warning'); return; }
  const ar = document.documentElement.lang === 'ar';
  let labels = '';
  try {
    labels = items.map(it => {
      const code = it.code || it.item_number || '';
      const name = itemNameOnly(it);
      const detail = `${fmtNum(stockQty(it.id))} ${it.base_unit || ''}`.trim();
      return `<div class="label">
        <div class="qr">${qrSvg(qrPayload('item', it), { cellSize: 5, label: code || name })}</div>
        <h3>${esc(code || name)}</h3>
        <p>${esc(name)}${detail ? ` — ${esc(detail)}` : ''}</p>
      </div>`;
    }).join('');
  } catch (e) {
    console.error(e);
    toast(tx('تعذر توليد رموز QR. أعد تحميل الصفحة ثم حاول مرة أخرى.',
      'Could not generate QR codes. Reload the page and try again.'), 'error');
    return;
  }
  const html = `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
  <title>${ar ? 'ملصقات QR' : 'QR Labels'}</title>
  <style>body{font-family:Arial,Tahoma,sans-serif;margin:12mm;color:#231a20;direction:${ar ? 'rtl' : 'ltr'}}
  h2{font-size:15px}.labels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8mm}
  .label{border:1px solid #cbd5e1;border-radius:8px;padding:6mm 3mm;text-align:center;break-inside:avoid;min-height:48mm}
  .label h3{font-size:11pt;margin:3mm 0 1mm;overflow-wrap:anywhere}.label p{font-size:8pt;color:#475569;margin:1mm 0}
  .qr{display:flex;justify-content:center;min-height:32mm}
  .qr svg{display:block;width:30mm;height:30mm}
  @page{size:A4;margin:8mm}@media print{body{margin:4mm}}</style></head><body>
  <h2>OW — ${ar ? 'ملصقات الأصناف' : 'Item labels'}</h2>
  <div class="labels">${labels}</div></body></html>`;
  if (!printDocument(html)) {
    toast(tx('اسمح بالنوافذ المنبثقة لطباعة الملصقات', 'Allow pop-ups to print labels'), 'error');
  }
}

/* ── globals ────────────────────────────────────────────────────────────── */

OW.wms = OW.wms || {};
OW.wms.itemModal = itemModal;
OW.wms.openItemDetails = openDetails;
OW.wms.printAllLabels = () => {
  const list = filteredItems();
  if (list.length > 60 && !confirm(tx('عدد الملصقات كبير. المتابعة؟', 'Many labels. Continue?'))) return;
  printLabels(list);
};
OW.wms.reloadInventory = async () => {
  const { pullAll } = await import('./core-store.js');
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  reload();
};
OW.wms.exportItems = () => {
  const list = filteredItems();
  downloadCSV(`items-${todayISO()}.csv`,
    [tx('الرمز', 'Code'), tx('رقم الصنف', 'Item number'), tx('الاسم', 'Name'), tx('الفئة', 'Category'),
     tx('الوحدة', 'Unit'), tx('المتاح', 'On hand'), tx('حد الأمان', 'Safety stock'), tx('الحالة', 'Status')],
    list.map(i => [i.code, i.item_number || '', itemNameOnly(i), categoryName(i.category_id),
      i.base_unit || '', i.total_qty, i.safety_stock || 0, i.status || 'ACTIVE']));
};

OW.registerPage('inventory', {
  brand: { name: 'OW', icon: 'fa-solid fa-boxes-stacked' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المخزون', 'Inventory'), page: 'inventory' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' },
    { label: tx('المستودعات', 'Facilities'), page: 'facilities' },
    { label: tx('التقارير', 'Reports'), page: 'reports' }
  ],
  render,
  mount: bind
});

export default OW.pages.inventory;
