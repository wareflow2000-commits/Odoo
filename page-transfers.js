// ============================================================================
// OW — Warehouse transfers & returns
// ============================================================================
import { OW } from './core-registry.js';
import { tx, friendlyError } from './core-i18n.js';
import {
  pageHead, card, statCard, table, empty, statusBadge, btn, alertBox,
  controlPanel, input, select, textarea, field, tabs, downloadCSV
} from './core-ui.js';
import {
  store, dispatchTransfer, receiveTransfer, rejectTransferReceipt,
  reviewTransferReturn, confirmTransferReturn, itemLabel, itemNameOnly,
  warehouseName, shelfPath, shelfOptions, shelvesForItem, warehouseOptions, itemOptions,
  unitOptions, uid
} from './core-store.js';
import { canTransfer, isElevated } from './core-rbac.js';
import { fmtDateTime, fmtNum, statusLabel, todayISO, round3 } from './core-utils.js';
import { toast } from './core-toast.js';
import { modal, confirmDialog, promptDialog } from './core-modal.js';

const F = { tab: 'orders', search: '' };

const IN_TRANSIT = ['IN_TRANSIT', 'PARTIALLY_RECEIVED'];
const RETURN_STATES = ['RETURN_IN_TRANSIT', 'RETURNED_TO_SOURCE'];

function baseUnitOf(t) {
  return t?.base_unit || store.byId('items', t?.item_id)?.base_unit || '';
}

function dispatchUnitText(t) {
  const base = baseUnitOf(t);
  const enteredUnit = t?.entered_unit || base;
  if (enteredUnit && base && enteredUnit !== base && t?.entered_quantity != null) {
    return `${fmtNum(t.entered_quantity)} ${enteredUnit} × ${fmtNum(t.conversion_factor)}<div class="o_cell_sub">${fmtNum(t.quantity)} ${base}</div>`;
  }
  return `${fmtNum(t.quantity)} ${base}`.trim();
}

function snapshotUnitText(qty, unit, fallbackBase) {
  return `${fmtNum(qty || 0)} ${unit || fallbackBase || ''}`.trim();
}

function dispatchUnitPlain(t) {
  const base = baseUnitOf(t);
  const enteredUnit = t?.entered_unit || base;
  if (enteredUnit && base && enteredUnit !== base && t?.entered_quantity != null) {
    return `${fmtNum(t.entered_quantity)} ${enteredUnit} × ${fmtNum(t.conversion_factor)} = ${fmtNum(t.quantity)} ${base}`;
  }
  return `${fmtNum(t.quantity)} ${base}`.trim();
}

function stockQty(itemId, shelfId) {
  return store.get('stock')
    .filter(s => s.item_id === itemId && s.shelf_id === shelfId)
    .reduce((n, s) => n + Number(s.quantity || 0), 0);
}

function transfersFiltered() {
  let list = [...store.get('stock_transfers')];
  if (F.tab === 'transit') list = list.filter(t => IN_TRANSIT.includes(t.status));
  if (F.tab === 'returns') list = list.filter(t => RETURN_STATES.includes(t.status) || Number(t.return_requested_quantity || 0) > 0);
  if (F.tab === 'completed') list = list.filter(t => ['RECEIVED', 'RETURNED_TO_SOURCE'].includes(t.status));
  if (F.search) {
    const q = F.search.toLowerCase();
    list = list.filter(t => [t.reference_no, itemLabel(t.item_id), warehouseName(t.source_warehouse_id), warehouseName(t.destination_warehouse_id)]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function ordersFiltered() {
  let list = [...store.get('stock_transfer_orders')];
  if (F.search) {
    const q = F.search.toLowerCase();
    list = list.filter(o => [o.reference_no, warehouseName(o.source_warehouse_id), warehouseName(o.destination_warehouse_id), o.notes]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function orderProgress(order) {
  const lines = store.get('stock_transfers').filter(t => t.transfer_order_id === order.id);
  const sent = lines.reduce((n, t) => n + Number(t.quantity || 0), 0);
  const received = lines.reduce((n, t) => n + Number(t.received_quantity || 0), 0);
  const returned = lines.reduce((n, t) => n + Number(t.returned_quantity || 0), 0);
  return { lines, sent, received, returned, pct: sent ? Math.min(100, (received / sent) * 100) : 0 };
}

function render() {
  const lines = transfersFiltered();
  const orders = ordersFiltered();
  const totalSent = lines.reduce((n, t) => n + Number(t.quantity || 0), 0);
  const totalReceived = lines.reduce((n, t) => n + Number(t.received_quantity || 0), 0);
  const can = canTransfer();

  return `
  ${pageHead(tx('التحويلات', 'Transfers'),
    tx('تحويل البضائع بين المستودعات مع استلام جزئي ومرتجعات', 'Move goods between warehouses with partial receipt and returns'),
    `${can ? btn(`<i class="fa-solid fa-plus"></i> ${tx('طلب تحويل جديد', 'New transfer order')}`, 'onclick="OW.wms.newTransfer()"', 'primary') : ''}
     ${btn(`<i class="fa-solid fa-file-csv"></i> ${tx('تصدير', 'Export')}`, 'onclick="OW.wms.exportTransfers()"', 'secondary')}
     ${btn('', 'onclick="OW.wms.reloadTransfers()"', 'ghost', 'fa-solid fa-rotate')}`)}
  ${controlPanel({
    breadcrumb: [{ label: tx('العمليات', 'Operations') }, { label: tx('التحويلات', 'Transfers') }],
    searchPlaceholder: tx('ابحث بالمرجع أو الصنف أو المستودع…', 'Search reference, item or warehouse…')
  })}
  <div class="o_page_body">
    <div class="o_grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      ${statCard({ label: tx('طلبات التحويل', 'Transfer orders'), value: fmtNum(orders.length), icon: 'fa-solid fa-file-lines', tone: 'purple' })}
      ${statCard({ label: tx('قيد النقل', 'In transit'), value: fmtNum(store.get('stock_transfers').filter(t => IN_TRANSIT.includes(t.status)).length), icon: 'fa-solid fa-truck-fast', tone: 'blue' })}
      ${statCard({ label: tx('الكمية المرسلة', 'Sent qty'), value: fmtNum(totalSent), icon: 'fa-solid fa-boxes-packing', tone: 'amber' })}
      ${statCard({ label: tx('تم استلامه', 'Received'), value: fmtNum(totalReceived), icon: 'fa-solid fa-circle-check', tone: 'green' })}
    </div>
    ${tabs([
      { value: 'orders', label: tx('الطلبيات', 'Orders'), count: store.get('stock_transfer_orders').length, onclick: "OW.wms.transferTab('orders')" },
      { value: 'transit', label: tx('قيد النقل', 'In transit'), count: store.get('stock_transfers').filter(t => IN_TRANSIT.includes(t.status)).length, onclick: "OW.wms.transferTab('transit')" },
      { value: 'returns', label: tx('المرتجعات', 'Returns'), count: store.get('stock_transfers').filter(t => RETURN_STATES.includes(t.status) || Number(t.return_requested_quantity || 0) > 0).length, onclick: "OW.wms.transferTab('returns')" },
      { value: 'all', label: tx('كل الأسطر', 'All lines'), count: store.get('stock_transfers').length, onclick: "OW.wms.transferTab('all')" }
    ], F.tab)}
    ${F.tab === 'orders' ? renderOrders(orders) : renderLines(lines, can)}
  </div>`;
}

function renderOrders(orders) {
  return card('', table(
    [{ label: tx('المرجع', 'Reference') }, { label: tx('من', 'From') }, { label: tx('إلى', 'To') },
     { label: tx('التاريخ', 'Date') }, { label: tx('الحالة', 'Status') }, { label: tx('التقدم', 'Progress') }, { label: tx('إجراءات', 'Actions') }],
    orders.map(o => {
      const p = orderProgress(o);
      return {
        cells: [
          `<span class="o_cell_main">${o.reference_no || '—'}</span><div class="o_cell_sub">${p.lines.length} ${tx('سطر', 'lines')}</div>`,
          warehouseName(o.source_warehouse_id), warehouseName(o.destination_warehouse_id),
          fmtDateTime(o.created_at),
          statusBadge(o.status, statusLabel(o.status)),
          `<div class="o_progress"><div class="o_mini_bar"><span style="width:${p.pct}%"></span></div><small>${fmtNum(p.received)} / ${fmtNum(p.sent)}</small></div>`,
          `<div class="o_actions_cell">
            <button class="o_btn o_btn_ghost o_btn_sm" data-order="${o.id}" title="${tx('تفاصيل', 'Details')}"><i class="fa-solid fa-eye"></i></button>
          </div>`
        ]
      };
    }),
    { emptyTitle: tx('لا توجد طلبات تحويل', 'No transfer orders'), emptyNote: tx('أنشئ طلب تحويل لبدء نقل البضائع.', 'Create a transfer order to move goods.') }
  ), '', 'flush-body');
}

function renderLines(lines, can) {
  return card('', table(
    [{ label: tx('المرجع', 'Reference') }, { label: tx('الصنف', 'Item') }, { label: tx('من', 'From') },
     { label: tx('إلى', 'To') }, { label: tx('مرسل', 'Sent'), num: true }, { label: tx('مستلم', 'Received'), num: true },
     { label: tx('مرتجع', 'Returned'), num: true }, { label: tx('الحالة', 'Status') }, { label: tx('إجراءات', 'Actions') }],
    lines.map(t => ({
      cls: t.return_review_status === 'PENDING' ? 'rt-warn' : '',
      cells: [
        `<span class="o_cell_main">${t.reference_no || '—'}</span><div class="o_cell_sub">${fmtDateTime(t.created_at)}</div>`,
        `<span class="o_cell_main">${itemNameOnly(t.item_id)}</span><div class="o_cell_sub">${store.byId('items', t.item_id)?.code || ''}</div>`,
        `<span>${warehouseName(t.source_warehouse_id)}</span><div class="o_cell_sub">${t.source_shelf_id ? shelfPath(t.source_shelf_id) : '—'}</div>`,
        `<span>${warehouseName(t.destination_warehouse_id)}</span><div class="o_cell_sub">${t.destination_shelf_id ? shelfPath(t.destination_shelf_id) : tx('رف عند الاستلام', 'Shelf on receipt')}</div>`,
        dispatchUnitText(t),
        snapshotUnitText(t.received_quantity, t.received_base_unit || t.received_entered_unit, baseUnitOf(t)),
        snapshotUnitText(t.returned_quantity || t.return_requested_quantity,
          (t.returned_quantity ? t.returned_base_unit : null) || baseUnitOf(t), baseUnitOf(t)),
        statusBadge(t.status, statusLabel(t.status)),
        `<div class="o_actions_cell">
          ${IN_TRANSIT.includes(t.status) && can ? `<button class="o_btn o_btn_success o_btn_sm" data-receive="${t.id}">${tx('استلام', 'Receive')}</button>` : ''}
          ${t.return_review_status === 'PENDING' && can ? `<button class="o_btn o_btn_primary o_btn_sm" data-review="${t.id}">${tx('مراجعة المرتجع', 'Review return')}</button>` : ''}
          ${t.return_review_status === 'APPROVED' && t.status === 'RETURN_IN_TRANSIT' && can ? `<button class="o_btn o_btn_primary o_btn_sm" data-confirm-return="${t.id}">${tx('تأكيد المرتجع', 'Confirm return')}</button>` : ''}
          ${IN_TRANSIT.includes(t.status) && can ? `<button class="o_btn o_btn_danger o_btn_sm" data-reject="${t.id}" title="${tx('رفض الاستلام', 'Reject receipt')}"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>`
      ]
    })),
    { emptyTitle: tx('لا توجد تحويلات في هذه الحالة', 'No transfers in this state') }
  ), '', 'flush-body');
}

function bind(_params, main) {
  const search = main.querySelector('#oSearchInput');
  if (search) {
    search.value = F.search;
    search.addEventListener('input', () => { F.search = search.value; reload(); });
  }
  main.querySelectorAll('[data-order]').forEach(b => b.onclick = () => openOrder(b.dataset.order));
  main.querySelectorAll('[data-receive]').forEach(b => b.onclick = () => openReceive(b.dataset.receive));
  main.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => rejectReceipt(b.dataset.reject));
  main.querySelectorAll('[data-review]').forEach(b => b.onclick = () => reviewReturn(b.dataset.review));
  main.querySelectorAll('[data-confirm-return]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({
      title: tx('تأكيد المرتجع', 'Confirm return'),
      message: tx('سيتم إرجاع الكمية المتبقية إلى المستودع المصدر.', 'The remaining quantity will be returned to the source warehouse.'),
      confirmText: tx('تأكيد', 'Confirm')
    })) return;
    try {
      await confirmTransferReturn(b.dataset.confirmReturn);
      toast(tx('تم تأكيد المرتجع', 'Return confirmed'), 'success');
      reload();
    } catch (e) { toast(friendlyError(e), 'error'); }
  });
}

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('transfers'));
}

/* ── new transfer order ─────────────────────────────────────────────────── */

function openNewTransfer() {
  const warehouses = warehouseOptions();
  if (warehouses.length < 1) { toast(tx('أضف مستودعًا أولًا', 'Add a warehouse first'), 'warning'); return; }
  let sourceWh = store.get('warehouses')[0]?.id || '';
  let destWh = store.get('warehouses')[1]?.id || sourceWh;
  let lines = [{ key: 't1', item_id: '', source_shelf_id: '', destination_shelf_id: '', quantity: '', entered_unit: '', batch_no: '', expiry_date: '' }];
  let keySeq = 1;
  const dispatchOrderId = uid();

  const body = `<form id="trfForm" class="o_form_grid">
      ${select({ name: 'source_warehouse_id', label: tx('المستودع المصدر', 'Source warehouse'), options: warehouses, value: sourceWh, required: true })}
      ${select({ name: 'destination_warehouse_id', label: tx('المستودع الوجهة', 'Destination warehouse'), options: warehouses, value: destWh, required: true })}
      ${input({ name: 'reference_no', label: tx('المرجع', 'Reference'), value: 'TRF-' + Date.now().toString().slice(-9), required: true })}
      ${input({ name: 'notes', label: tx('ملاحظات', 'Notes') })}
    </form>
    <div class="o_section_label">${tx('أسطر التحويل', 'Transfer lines')}</div>
    <div class="o_list_wrap"><table class="o_list_table">
      <thead><tr>
        <th>${tx('الصنف', 'Item')}</th><th>${tx('رف المصدر', 'Source shelf')}</th>
        <th>${tx('الكمية / الوحدة', 'Qty / Unit')}</th><th>${tx('رف الوجهة', 'Destination shelf')}</th>
        <th>${tx('التشغيلة', 'Batch')}</th><th>${tx('الصلاحية', 'Expiry')}</th><th></th>
      </tr></thead><tbody id="trfLines"></tbody></table></div>
    <div class="o_line_tools">
      <button type="button" class="o_btn o_btn_secondary o_btn_sm" id="trfAddLine"><i class="fa-solid fa-plus"></i> ${tx('إضافة سطر', 'Add line')}</button>
      <span class="o_muted">${tx('التحويل داخل نفس المستودع يتطلب رف وجهة.', 'Same-warehouse transfers require a destination shelf.')}</span>
    </div>
    ${alertBox(tx('عند الإرسال تُخصم الكميات من المصدر وتظهر كقيد النقل حتى الاستلام.',
      'On dispatch, quantities leave the source and appear as in-transit until received.'), 'info')}`;

  modal({
    title: `<i class="fa-solid fa-truck-arrow-right"></i> ${tx('طلب تحويل جديد', 'New transfer order')}`,
    size: 'xl', body,
    footer: `<button class="o_btn o_btn_secondary" id="trfCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="trfSave"><i class="fa-solid fa-paper-plane"></i> ${tx('إرسال التحويل', 'Dispatch transfer')}</button>`,
    onMount: (el, close) => {
      const srcSel = el.querySelector('[name="source_warehouse_id"]');
      const dstSel = el.querySelector('[name="destination_warehouse_id"]');
      const tbody = el.querySelector('#trfLines');

      const lineHtml = (l) => {
        const srcWh = srcSel.value;
        const dstWh = dstSel.value;
        const shelves = shelfOptions({ warehouseId: srcWh });
        const destShelves = shelfOptions({ warehouseId: dstWh });
        const units = l.item_id ? unitOptions(l.item_id) : [];
        const unitValue = units.some(u => u.value === l.entered_unit)
          ? l.entered_unit
          : (units[0]?.value || '');
        return `<tr data-line="${l.key}">
          <td><select class="o_form_input tl-item" data-k="item_id">
            <option value="">${tx('اختر صنفًا', 'Select item')}</option>
            ${itemOptions().map(o => `<option value="${o.value}" ${l.item_id === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select><div class="o_cell_sub tl-avail"></div></td>
          <td><select class="o_form_input tl-src" data-k="source_shelf_id">
            <option value="">${tx('اختر رفًا', 'Select shelf')}</option>
            ${shelves.map(o => `<option value="${o.value}" ${l.source_shelf_id === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select></td>
          <td>
            <div style="display:flex;gap:6px;align-items:center">
              <input class="o_form_input tl-qty" data-k="quantity" type="number" min="0" step="any" value="${l.quantity ?? ''}" style="min-width:80px">
              <select class="o_form_input tl-unit" data-k="entered_unit" style="max-width:125px">
                ${units.length
                  ? units.map(u => `<option value="${u.value}" ${unitValue === u.value ? 'selected' : ''}>${u.label}</option>`).join('')
                  : `<option value="">—</option>`}
              </select>
            </div>
            <div class="o_cell_sub tl-avail"></div>
          </td>
          <td><select class="o_form_input tl-dst" data-k="destination_shelf_id">
            <option value="">${srcWh === dstWh ? tx('مطلوب', 'Required') : tx('عند الاستلام', 'On receipt')}</option>
            ${destShelves.map(o => `<option value="${o.value}" ${l.destination_shelf_id === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select></td>
          <td><input class="o_form_input tl-batch" data-k="batch_no" value="${l.batch_no || ''}"></td>
          <td><input class="o_form_input tl-exp" data-k="expiry_date" type="date" value="${l.expiry_date || ''}"></td>
          <td><button type="button" class="o_btn o_btn_ghost o_btn_sm tl-remove"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
      };

      const draw = () => {
        tbody.innerHTML = lines.map(lineHtml).join('');
        tbody.querySelectorAll('[data-line]').forEach(tr => {
          const line = lines.find(l => l.key === tr.dataset.line);
          const fillUnits = () => {
            const units = line.item_id ? unitOptions(line.item_id) : [];
            if (!units.some(u => u.value === line.entered_unit)) line.entered_unit = units[0]?.value || '';
            const sel = tr.querySelector('[data-k="entered_unit"]');
            if (!sel) return;
            sel.innerHTML = units.length
              ? units.map(u => `<option value="${u.value}">${u.label}</option>`).join('')
              : `<option value="">—</option>`;
            sel.value = line.entered_unit;
          };
          const updateAvailability = () => {
            const availEl = tr.querySelector('.tl-avail');
            if (!availEl) return;
            if (!line.item_id || !line.source_shelf_id) { availEl.textContent = ''; return; }
            const item = store.byId('items', line.item_id) || {};
            const units = unitOptions(line.item_id);
            const unit = units.find(u => u.value === line.entered_unit) || units[0];
            const factor = Number(unit?.factor || 1);
            const baseAvailable = Number(stockQty(line.item_id, line.source_shelf_id) || 0);
            availEl.textContent = `${tx('المتاح', 'Available')}: ${fmtNum(baseAvailable / factor)} ${unit?.value || ''} (${fmtNum(baseAvailable)} ${item.base_unit || ''})`;
          };
          tr.querySelectorAll('[data-k]').forEach(inp => {
            inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
              line[inp.dataset.k] = inp.value;
              if (inp.dataset.k === 'item_id') {
                line.entered_unit = '';
                line.quantity = '';
                const qtyInput = tr.querySelector('.tl-qty');
                if (qtyInput) qtyInput.value = '';
                fillUnits();
              }
              if (inp.dataset.k === 'source_shelf_id' || inp.dataset.k === 'item_id'
                  || inp.dataset.k === 'entered_unit') {
                updateAvailability();
              }
            });
          });
          tr.querySelector('.tl-remove').onclick = () => {
            if (lines.length === 1) { toast(tx('سطر واحد على الأقل', 'At least one line'), 'warning'); return; }
            lines = lines.filter(l => l.key !== line.key);
            draw();
          };
          fillUnits();
          updateAvailability();
        });
      };

      const redrawShelves = () => {
        draw();
      };
      srcSel.onchange = () => { sourceWh = srcSel.value; redrawShelves(); };
      dstSel.onchange = () => { destWh = dstSel.value; redrawShelves(); };

      el.querySelector('#trfAddLine').onclick = () => {
        lines.push({ key: 't' + (++keySeq), item_id: '', source_shelf_id: '', destination_shelf_id: '', quantity: '', entered_unit: '', batch_no: '', expiry_date: '' });
        draw();
      };
      el.querySelector('#trfCancel').onclick = close;
      el.querySelector('#trfSave').onclick = async () => {
        try {
          const d = Object.fromEntries(new FormData(el.querySelector('#trfForm')).entries());
          if (d.source_warehouse_id === d.destination_warehouse_id && lines.some(l => !l.destination_shelf_id)) {
            throw new Error(tx('التحويل داخل نفس المستودع يتطلب رف وجهة لكل سطر',
              'Same-warehouse transfer requires a destination shelf on every line'));
          }
          if (!lines.length) throw new Error(tx('أضف سطرًا واحدًا', 'Add at least one line'));
          const payloadLines = lines.map(l => {
            if (!l.item_id || !l.source_shelf_id) throw new Error(tx('أكمل الصنف ورف المصدر', 'Complete item and source shelf'));
            const item = store.byId('items', l.item_id);
            const units = unitOptions(l.item_id);
            const unit = units.find(u => u.value === l.entered_unit) || units[0];
            if (!item || !unit) throw new Error(tx('اختر وحدة صالحة للصنف', 'Select a valid item unit'));
            const factor = Number(unit.factor);
            const entered = Number(l.quantity);
            if (!Number.isFinite(entered) || entered <= 0) {
              throw new Error(tx('أدخل كمية موجبة', 'Enter a positive quantity'));
            }
            const qty = entered * factor;
            const srcShelf = store.byId('shelves', l.source_shelf_id);
            if (!srcShelf || srcShelf.warehouse_id !== d.source_warehouse_id) {
              throw new Error(tx('رف المصدر لا يتبع المستودع المحدد', 'Source shelf does not belong to the selected warehouse'));
            }
            if (l.destination_shelf_id) {
              const dstShelf = store.byId('shelves', l.destination_shelf_id);
              if (!dstShelf || dstShelf.warehouse_id !== d.destination_warehouse_id) {
                throw new Error(tx('رف الوجهة لا يتبع مستودع الوجهة', 'Destination shelf does not belong to the destination warehouse'));
              }
            }
            const available = Number(stockQty(l.item_id, l.source_shelf_id) || 0);
            if (qty > available + 1e-9) {
              const availableEntered = available / factor;
              throw new Error(tx(
                `الكمية أكبر من المتاح (${fmtNum(availableEntered)} ${unit.value} = ${fmtNum(available)} ${item.base_unit})`,
                `Quantity exceeds available stock (${fmtNum(availableEntered)} ${unit.value} = ${fmtNum(available)} ${item.base_unit})`
              ));
            }
            return {
              transfer_id: uid(), item_id: l.item_id, quantity: qty,
              entered_quantity: entered, entered_unit: unit.value,
              conversion_factor: factor, base_unit: item.base_unit,
              batch_no: l.batch_no || null, expiry_date: l.expiry_date || null,
              source_shelf_id: l.source_shelf_id,
              destination_shelf_id: l.destination_shelf_id || null
            };
          });
          await dispatchTransfer({
            orderId: dispatchOrderId,
            referenceNo: d.reference_no || null,
            sourceWarehouseId: d.source_warehouse_id,
            destinationWarehouseId: d.destination_warehouse_id,
            lines: payloadLines,
            notes: d.notes || null
          });
          close();
          toast(tx('تم إرسال التحويل', 'Transfer dispatched'), 'success');
          reload();
        } catch (e) { toast(friendlyError(e), 'error'); }
      };
      draw();
    }
  });
}

/* ── order details ──────────────────────────────────────────────────────── */

function openOrder(id) {
  const o = store.byId('stock_transfer_orders', id);
  if (!o) return;
  const p = orderProgress(o);
  const body = `
    <div class="o_tx_head"><div>
      <div class="o_tx_ref">${o.reference_no || '—'}</div>
      <div class="o_muted">${fmtDateTime(o.created_at)}</div>
    </div><div>${statusBadge(o.status, statusLabel(o.status))}</div></div>
    <dl class="o_kv">
      <dt>${tx('من', 'From')}</dt><dd>${warehouseName(o.source_warehouse_id)}</dd>
      <dt>${tx('إلى', 'To')}</dt><dd>${warehouseName(o.destination_warehouse_id)}</dd>
      <dt>${tx('الكمية المرسلة', 'Sent')}</dt><dd>${fmtNum(p.sent)} ${baseUnitOf(p.lines[0])}</dd>
      <dt>${tx('المستلمة', 'Received')}</dt><dd>${fmtNum(p.received)} ${baseUnitOf(p.lines[0])}</dd>
      <dt>${tx('المرتجعة', 'Returned')}</dt><dd>${fmtNum(p.returned)} ${baseUnitOf(p.lines[0])}</dd>
      ${o.notes ? `<dt>${tx('ملاحظات', 'Notes')}</dt><dd>${o.notes}</dd>` : ''}
    </dl>
    <div class="o_section_label">${tx('الأسطر', 'Lines')}</div>
    ${table(
      [{ label: tx('الصنف', 'Item') }, { label: tx('مرسل', 'Sent'), num: true }, { label: tx('مستلم', 'Received'), num: true },
       { label: tx('الحالة', 'Status') }, { label: tx('إجراء', 'Action') }],
      p.lines.map(t => ({
        cells: [
          `<span class="o_cell_main">${itemNameOnly(t.item_id)}</span><div class="o_cell_sub">${t.source_shelf_id ? shelfPath(t.source_shelf_id) : ''}</div>`,
          dispatchUnitText(t),
          snapshotUnitText(t.received_quantity, t.received_base_unit || t.received_entered_unit, baseUnitOf(t)),
          statusBadge(t.status, statusLabel(t.status)),
          IN_TRANSIT.includes(t.status) && canTransfer()
            ? `<button class="o_btn o_btn_success o_btn_sm" data-receive="${t.id}">${tx('استلام', 'Receive')}</button>` : ''
        ]
      }))
    )}`;
  modal({
    title: `<i class="fa-solid fa-file-lines"></i> ${tx('تفاصيل طلب التحويل', 'Transfer order')}`,
    size: 'lg', body,
    footer: `<button class="o_btn o_btn_primary" id="ordClose">${tx('إغلاق', 'Close')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#ordClose').onclick = close;
      el.querySelectorAll('[data-receive]').forEach(b => b.onclick = () => { close(); openReceive(b.dataset.receive); });
    }
  });
}

/* ── receive ────────────────────────────────────────────────────────────── */

function openReceive(id) {
  const t = store.byId('stock_transfers', id);
  if (!t) return;
  const receiptOperationId = uid();
  const remaining = Math.max(0, Number(t.quantity || 0) - Number(t.received_quantity || 0));
  const shelves = shelfOptions({ warehouseId: t.destination_warehouse_id });
  const body = `<div class="o_callout" style="margin-bottom:12px">
      <b>${itemNameOnly(t.item_id)}</b><br>
      ${tx('من', 'From')}: ${warehouseName(t.source_warehouse_id)} → ${tx('إلى', 'To')}: ${warehouseName(t.destination_warehouse_id)}<br>
      ${tx('المرسل', 'Sent')}: <b>${dispatchUnitPlain(t)}</b> ·
      ${tx('المستلم سابقًا', 'Already received')}: <b>${snapshotUnitText(t.received_quantity, t.received_base_unit || t.received_entered_unit, baseUnitOf(t))}</b> ·
      ${tx('المتبقي', 'Remaining')}: <b>${fmtNum(remaining)} ${baseUnitOf(t)}</b>
    </div>
    <form id="recForm" class="o_form_grid">
      ${input({ name: 'received_quantity', label: `${tx('الكمية المستلمة الآن', 'Received now')} (${baseUnitOf(t)})`, type: 'number', value: remaining, required: true, attrs: `min="0" max="${remaining}" step="any"` })}
      ${select({ name: 'destination_shelf_id', label: tx('رف الوجهة', 'Destination shelf'), options: shelves, value: t.destination_shelf_id || '', required: true, placeholder: tx('اختر رفًا', 'Select shelf') })}
      ${input({ name: 'batch_no', label: tx('التشغيلة (اختياري)', 'Batch (optional)'), value: t.batch_no || '', attrs: 'disabled' })}
      <div class="o_field full"><label class="o_checkbox"><input type="checkbox" name="return_remaining" ${remaining <= 0 ? 'checked' : ''}> ${tx('إرجاع الكمية المتبقية إلى المصدر', 'Return remaining quantity to source')}</label></div>
      ${textarea({ name: 'reason', label: tx('سبب الإرجاع (مطلوب عند إرجاع المتبقي)', 'Return reason (required when returning remainder)'), rows: 2 })}
    </form>`;
  modal({
    title: `<i class="fa-solid fa-box-open"></i> ${tx('استلام تحويل', 'Receive transfer')}`,
    size: 'md', body,
    footer: `<button class="o_btn o_btn_secondary" id="recCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_success" id="recSave">${tx('تأكيد الاستلام', 'Confirm receipt')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#recCancel').onclick = close;
      el.querySelector('#recSave').onclick = async () => {
        const d = Object.fromEntries(new FormData(el.querySelector('#recForm')).entries());
        const qty = Number(d.received_quantity || 0);
        const returnRemaining = !!d.return_remaining;
        if (qty < 0 || qty > remaining + 1e-9) { toast(tx('كمية غير صالحة', 'Invalid quantity'), 'warning'); return; }
        if (qty > 0 && !d.destination_shelf_id) { toast(tx('رف الوجهة مطلوب عند الاستلام', 'Destination shelf is required'), 'warning'); return; }
        if (returnRemaining && !String(d.reason || '').trim()) { toast(tx('سبب الإرجاع مطلوب', 'Return reason is required'), 'warning'); return; }
        try {
          await receiveTransfer({ transferId: id, qty, shelfId: d.destination_shelf_id, returnRemaining, reason: d.reason || null, operationId: receiptOperationId });
          close();
          toast(returnRemaining ? tx('تم الاستلام وإرجاع المتبقي', 'Received and remainder returned') : tx('تم الاستلام', 'Received'), 'success');
          reload();
        } catch (e) { toast(friendlyError(e), 'error'); }
      };
    }
  });
}

async function rejectReceipt(id) {
  const reason = await promptDialog({
    title: tx('رفض الاستلام', 'Reject receipt'),
    label: tx('سبب الرفض', 'Rejection reason'), required: true, multiline: true,
    confirmText: tx('رفض', 'Reject')
  });
  if (!reason) return;
  try {
    await rejectTransferReceipt(id, reason.trim());
    toast(tx('تم رفض الاستلام وإرجاع الكمية', 'Receipt rejected; quantity returned'), 'info');
    reload();
  } catch (e) { toast(friendlyError(e), 'error'); }
}

async function reviewReturn(id) {
  const t = store.byId('stock_transfers', id);
  const qty = Number(t?.return_requested_quantity || 0);
  const decision = await new Promise(resolve => {
    let settled = false;
    const done = v => { if (settled) return; settled = true; m.close(); resolve(v); };
    const m = modal({
      title: tx('مراجعة طلب المرتجع', 'Review return request'),
      size: 'sm',
      body: `<div class="o_callout">${tx('الكمية المطلوب إرجاعها', 'Requested return quantity')}: <b>${fmtNum(qty)}</b>
        ${t?.return_reason ? `<br>${tx('السبب', 'Reason')}: ${t.return_reason}` : ''}</div>
        <div class="o_field full" style="margin-top:10px"><label>${tx('ملاحظة المراجعة', 'Review note')}</label>
        <textarea class="o_form_input" id="revNote" rows="2"></textarea></div>`,
      footer: `<button class="o_btn o_btn_secondary" id="revCancel">${tx('إلغاء', 'Cancel')}</button>
               <button class="o_btn o_btn_danger" id="revReject">${tx('رفض', 'Reject')}</button>
               <button class="o_btn o_btn_success" id="revAccept">${tx('قبول', 'Accept')}</button>`,
      onMount: (el, close) => {
        el.querySelector('#revCancel').onclick = () => done(null);
        el.querySelector('#revReject').onclick = () => done({ decision: 'REJECT', note: el.querySelector('#revNote').value });
        el.querySelector('#revAccept').onclick = () => done({ decision: 'ACCEPT', note: el.querySelector('#revNote').value });
      }
    });
  });
  if (!decision) return;
  try {
    await reviewTransferReturn(id, decision.decision, decision.note);
    toast(tx('تمت مراجعة المرتجع', 'Return reviewed'), 'success');
    reload();
  } catch (e) { toast(friendlyError(e), 'error'); }
}

/* ── globals ────────────────────────────────────────────────────────────── */

OW.wms = OW.wms || {};
OW.wms.newTransfer = openNewTransfer;
OW.wms.receiveTransfer = openReceive;
OW.wms.transferTab = (tab) => { F.tab = tab; reload(); };
OW.wms.reloadTransfers = async () => {
  const { pullAll } = await import('./core-store.js');
  try { await pullAll(); } catch (e) { toast(friendlyError(e), 'error'); }
  reload();
};
OW.wms.exportTransfers = () => {
  const list = store.get('stock_transfers');
  downloadCSV(`transfers-${todayISO()}.csv`,
    [tx('المرجع', 'Reference'), tx('الصنف', 'Item'), tx('من', 'From'), tx('إلى', 'To'),
     tx('الكمية المدخلة', 'Entered qty'), tx('وحدة الإدخال', 'Entered unit'),
     tx('الكمية الأساسية', 'Base qty'), tx('الوحدة الأساسية', 'Base unit'),
     tx('مستلم', 'Received'), tx('مرتجع', 'Returned'), tx('الحالة', 'Status'), tx('التاريخ', 'Date')],
    list.map(t => [t.reference_no, itemLabel(t.item_id), warehouseName(t.source_warehouse_id),
      warehouseName(t.destination_warehouse_id), t.entered_quantity ?? t.quantity, t.entered_unit || baseUnitOf(t),
      t.quantity, baseUnitOf(t), t.received_quantity || 0,
      t.returned_quantity || 0, statusLabel(t.status), fmtDateTime(t.created_at)]));
};

OW.registerPage('transfers', {
  brand: { name: 'OW', icon: 'fa-solid fa-truck-arrow-right' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' },
    { label: tx('التحويلات', 'Transfers'), page: 'transfers' },
    { label: tx('الطلبيات', 'Orders'), page: 'orders' },
    { label: tx('الجرد', 'Stocktake'), page: 'stocktake' }
  ],
  render,
  mount: bind
});

export default OW.pages.transfers;
