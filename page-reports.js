// ============================================================================
// OW — Reports
// ----------------------------------------------------------------------------
// 14 operational reports built from the local snapshot (works offline).
// Every report shares the same filter bar, CSV export and print/PDF output.
// ============================================================================
import { OW } from './core-registry.js';
import { tx } from './core-i18n.js';
import {
  pageHead, card, table, empty, badge, btn, alertBox, controlPanel,
  input, select, downloadCSV, printHTML, fmt
} from './core-ui.js';
import {
  store, pullAll, itemNameOnly, warehouseName, areaName, zoneName, shelfName,
  shelfPath, warehouseOptions, areaOptions, shelfOptions, profileName,
  itemLabel
} from './core-store.js';
import {
  fmtDateTime, fmtNum, statusLabel, txLabel, todayISO, startOfMonthISO
} from './core-utils.js';
import { toast } from './core-toast.js';

const KINDS = [
  { value: 'movements', icon: 'fa-solid fa-arrow-right-arrow-left', label: () => tx('حركة المخزون', 'Stock movements') },
  { value: 'balances', icon: 'fa-solid fa-scale-balanced', label: () => tx('أرصدة المخزون', 'Stock balances') },
  { value: 'item-card', icon: 'fa-solid fa-id-card', label: () => tx('كارت الصنف', 'Item card') },
  { value: 'low-stock', icon: 'fa-solid fa-triangle-exclamation', label: () => tx('مخزون منخفض', 'Low stock') },
  { value: 'inbound', icon: 'fa-solid fa-arrow-down-to-line', label: () => tx('التوريدات', 'Inbound') },
  { value: 'outbound', icon: 'fa-solid fa-arrow-up-from-line', label: () => tx('الصرفيات', 'Outbound') },
  { value: 'tx-summary', icon: 'fa-solid fa-table-cells', label: () => tx('ملخص حركة الأصناف', 'Item movement summary') },
  { value: 'warehouse-summary', icon: 'fa-solid fa-warehouse', label: () => tx('ملخص المستودعات', 'Warehouse summary') },
  { value: 'transfers', icon: 'fa-solid fa-truck-arrow-right', label: () => tx('التحويلات', 'Transfers') },
  { value: 'returns', icon: 'fa-solid fa-rotate-left', label: () => tx('المرتجعات', 'Returns') },
  { value: 'stocktake', icon: 'fa-solid fa-clipboard-check', label: () => tx('الجرد', 'Stocktake') },
  { value: 'audit', icon: 'fa-solid fa-shield-halved', label: () => tx('سجل التدقيق', 'Audit trail') },
  { value: 'expiry', icon: 'fa-solid fa-calendar-xmark', label: () => tx('تواريخ الصلاحية', 'Expiry dates') },
  { value: 'pending', icon: 'fa-solid fa-hourglass-half', label: () => tx('بانتظار الاعتماد', 'Pending approval') }
];

const addDaysISO = (date, days) => {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

const F = {
  kind: 'movements', from: startOfMonthISO(), to: todayISO(),
  expiryFrom: '', expiryTo: addDaysISO(todayISO(), 90),
  warehouse: '', area: '', shelf: '', status: '', type: '', search: ''
};

const kindLabel = v => (KINDS.find(k => k.value === v)?.label() || v);

/* ── filter helpers ──────────────────────────────────────────────────────── */

const dateOf = x => x?.occurred_at || x?.created_at || x?.transaction_date || x?.dispatched_at || x?.updated_at;
const inRange = d => {
  if (!F.from && !F.to) return true;
  const x = new Date(d || 0);
  if (isNaN(x.getTime())) return false;
  if (F.from && x < new Date(F.from + 'T00:00:00')) return false;
  if (F.to && x > new Date(F.to + 'T23:59:59')) return false;
  return true;
};
const textMatch = (itemId, extra = '') => {
  const it = store.byId('items', itemId);
  const hay = [it?.code, it?.name_ar, it?.name_en, extra].filter(Boolean).join(' ').toLowerCase();
  return !F.search || hay.includes(F.search.toLowerCase());
};
function shelfArea(shelf) {
  return shelf?.storage_area_id || shelf?.zone_id || '';
}
function stockMatch(s) {
  const sh = store.byId('shelves', s.shelf_id) || s._shelf || {};
  const wh = s.warehouse_id || sh.warehouse_id;
  if (F.warehouse && wh !== F.warehouse) return false;
  const areaId = s.storage_area_id || shelfArea(sh);
  if (F.area && String(areaId) !== F.area) return false;
  if (F.shelf && s.shelf_id !== F.shelf) return false;
  return textMatch(s.item_id, s.batch_no);
}
const txLines = id => store.get('transaction_lines').filter(l => l.transaction_id === id);
function txMatch(t) {
  if (!inRange(dateOf(t))) return false;
  if (F.warehouse && t.warehouse_id !== F.warehouse) return false;
  if (F.status && t.status !== F.status) return false;
  if (F.type && t.transaction_type !== F.type) return false;
  if (F.area) {
    const direct = [t.storage_area_id, t.zone_id].filter(Boolean).includes(F.area);
    const viaLines = txLines(t.id).some(l => {
      const shelf = store.byId('shelves', l.shelf_id) || {};
      return String(l.storage_area_id || shelf.storage_area_id || shelf.zone_id || '') === F.area;
    });
    if (!direct && !viaLines) return false;
  }
  if (F.shelf && !txLines(t.id).some(l => l.shelf_id === F.shelf)) return false;
  if (F.search) {
    const hide = [t.supplier, t.receiver_name, t.reference_no, t.external_reference, t.notes]
      .some(v => String(v || '').toLowerCase().includes(F.search.toLowerCase()));
    const viaItem = txLines(t.id).some(l => textMatch(l.item_id, [l.batch_no, l.notes].filter(Boolean).join(' ')));
    if (!hide && !viaItem) return false;
  }
  return true;
}

function ledgerWarehouseId(l) {
  return l?.warehouse_id || store.byId('shelves', l?.shelf_id)?.warehouse_id || '';
}
function ledgerAreaId(l) {
  const shelf = store.byId('shelves', l?.shelf_id) || {};
  return l?.storage_area_id || shelf.storage_area_id || l?.zone_id || shelf.zone_id || '';
}
function ledgerLocationLabel(l) {
  if (l?.shelf_id) return shelfPath(l.shelf_id);
  if (l?.storage_area_id) return areaName(l.storage_area_id);
  return '—';
}
function ledgerMatchesLocation(l) {
  return (!F.warehouse || ledgerWarehouseId(l) === F.warehouse)
    && (!F.area || String(ledgerAreaId(l)) === F.area)
    && (!F.shelf || l.shelf_id === F.shelf);
}
function ledgerMatchesScope(l) {
  // Summary filters must select the item, not discard individual dated rows by
  // matching a batch or reference; otherwise opening/closing balances would be understated.
  return ledgerMatchesLocation(l)
    && textMatch(l.item_id, [l.item_code, l.item_name].filter(Boolean).join(' '));
}
function ledgerMatchesFilters(l) {
  return inRange(dateOf(l)) && ledgerMatchesLocation(l)
    && textMatch(l.item_id, [l.item_code, l.item_name, l.batch_no, l.source_ref].filter(Boolean).join(' '));
}
function ledgerMovementTypeLabel(l) {
  const type = String(l?.source_type || '').toUpperCase();
  const ref = String(l?.source_ref || '').toUpperCase();
  if (type === 'OPENING_BALANCE') return h('رصيد افتتاحي', 'Opening balance');
  if (type === 'GRN' || type === 'RECEIPT' || type === 'RECEIVING' || type === 'INBOUND') return h('توريد', 'Receipt');
  if (type === 'ISSUE' || type === 'OUTBOUND') return h('صرف', 'Issue');
  if (type === 'TRANSFER_IN') return h('استلام تحويل', 'Transfer receipt');
  if (type === 'TRANSFER_RETURN') return h('مرتجع تحويل', 'Transfer return');
  if (type === 'ADJUSTMENT_OUT' && ref.startsWith('TRF-')) return h('تحويل صادر', 'Transfer out');
  if (type === 'ADJUSTMENT_IN') return h('تسوية بالزيادة', 'Positive adjustment');
  if (type === 'ADJUSTMENT_OUT') return h('تسوية بالنقص', 'Negative adjustment');
  return type ? type.replace(/_/g, ' ') : '—';
}
function ledgerMovementRow(l) {
  const item = store.byId('items', l.item_id) || {};
  const name = itemNameOnly(l.item_id);
  const delta = Number(l.delta || 0);
  const before = l.running_balance == null ? '' : Number(l.running_balance) - delta;
  const after = l.running_balance == null ? '' : Number(l.running_balance);
  return [
    fmtDateTime(dateOf(l)), l.source_ref || l.source_id || '',
    ledgerMovementTypeLabel(l), item.code || l.item_code || '',
    name && name !== '—' ? name : (l.item_name || '—'), l.batch_no || '',
    warehouseName(ledgerWarehouseId(l)), ledgerLocationLabel(l),
    delta, l.unit || item.base_unit || '—', before, after
  ];
}
function transactionLineMatchesScope(line) {
  const shelf = store.byId('shelves', line.shelf_id) || {};
  const areaId = line.storage_area_id || shelf.storage_area_id || shelf.zone_id || '';
  return (!F.area || String(areaId) === F.area) && (!F.shelf || line.shelf_id === F.shelf);
}
function transactionHeaderMatchesSearch(t) {
  if (!F.search) return true;
  const needle = F.search.toLowerCase();
  return [t.supplier, t.receiver_name, t.reference_no, t.notes, t.external_reference]
    .some(v => String(v || '').toLowerCase().includes(needle));
}
function transactionReportLine(t, line) {
  const item = store.byId('items', line?.item_id) || {};
  const location = line?.shelf_id ? shelfPath(line.shelf_id) : '—';
  const enteredQty = line ? (line.entered_quantity ?? line.quantity ?? '') : '';
  const enteredUnit = line ? (line.entered_unit || line.base_unit || item.base_unit || '—') : '';
  const baseQty = line ? (line.quantity ?? '') : '';
  const baseUnit = line ? (line.base_unit || item.base_unit || line.entered_unit || '—') : '';
  const itemName = line ? itemNameOnly(line.item_id) : '';
  return [
    fmtDateTime(dateOf(t)), t.reference_no || '', txLabel(t.transaction_type),
    item.code || '', itemName && itemName !== '—' ? itemName : (line ? '—' : ''),
    warehouseName(t.warehouse_id), location,
    enteredQty, enteredUnit, baseQty, baseUnit,
    t.supplier || '', t.receiver_name || '', statusLabel(t.status)
  ];
}

/* ── report definitions ──────────────────────────────────────────────────── */

function reportData(kind) {
  switch (kind) {
    case 'audit': {
      const rows = store.get('audit_logs')
        .filter(a => inRange(dateOf(a)))
        .filter(a => !F.warehouse || a.warehouse_id === F.warehouse)
        .filter(a => !F.status || a.action === F.status)
        .filter(a => !F.search || [a.action, a.entity, a.entity_id, a.reference, a.item_code, a.item_name]
          .some(v => String(v || '').toLowerCase().includes(F.search.toLowerCase())))
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))));
      return {
        headers: [h('التاريخ والوقت', 'Date / Time'), h('المستخدم', 'User'), h('الإجراء', 'Action'),
          h('الكيان', 'Entity'), h('معرّف السجل', 'Record ID'), h('المرجع', 'Reference'),
          h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('المستودع', 'Warehouse'),
          h('الرصيد قبل', 'Qty before'), h('الرصيد بعد', 'Qty after'), h('التفاصيل', 'Details')],
        rows: rows.map(a => {
          let details = a.details;
          if (details && typeof details !== 'string') { try { details = JSON.stringify(details); } catch (_) { details = ''; } }
          return [fmtDateTime(dateOf(a)), profileName(a.user_id), a.action || '—', a.entity || '—',
            a.entity_id || '—', a.reference || '', a.item_code || '', a.item_name || '',
            a.warehouse_id ? warehouseName(a.warehouse_id) : '',
            a.quantity_before ?? '', a.quantity_after ?? '', details || ''];
        }),
        numeric: [9, 10]
      };
    }

    case 'stocktake': {
      const sessions = store.get('stocktake_sessions')
        .filter(s => inRange(dateOf(s)))
        .filter(s => !F.warehouse || s.warehouse_id === F.warehouse)
        .filter(s => !F.area || String(s.storage_area_id || s.zone_id || '') === F.area
          || store.get('stocktake_lines').some(l => l.session_id === s.id
            && String(shelfArea(store.byId('shelves', l.shelf_id) || {})) === F.area))
        .filter(s => !F.status || s.status === F.status || s.review_status === F.status);
      const ids = new Set(sessions.map(s => s.id));
      const rows = store.get('stocktake_lines')
        .filter(l => ids.has(l.session_id))
        .filter(l => !F.shelf || l.shelf_id === F.shelf)
        .filter(l => !F.area || String(l.storage_area_id || shelfArea(store.byId('shelves', l.shelf_id) || {})) === F.area)
        .filter(l => textMatch(l.item_id, l.batch_no || ''))
        .map(l => {
          const s = store.byId('stocktake_sessions', l.session_id) || {};
          const item = store.byId('items', l.item_id) || {};
          const dir = String(l.settlement_direction || '').toUpperCase();
          return [fmtDateTime(dateOf(s)), String(l.session_id || '').slice(0, 8),
            warehouseName(s.warehouse_id), item.code || '', itemNameOnly(l.item_id), l.batch_no || '',
            shelfPath(l.shelf_id), l.base_unit || item.base_unit || '—',
            l.system_qty == null ? '' : Number(l.system_qty),
            l.counted_qty == null ? '' : Number(l.counted_qty),
            l.variance == null ? '' : Number(l.variance),
            dir === 'INCREASE' ? tx('زيادة', 'Increase') : dir === 'DECREASE' ? tx('نقص', 'Decrease') : '',
            statusLabel(s.review_status || s.status), l.settlement_comment || ''];
        });
      return {
        headers: [h('تاريخ الجلسة', 'Session date'), h('الجلسة', 'Session'), h('المستودع', 'Warehouse'),
          h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الدفعة', 'Batch'), h('الموقع', 'Location'),
          h('الوحدة الأساسية', 'Base unit'), h('كمية النظام', 'System qty'), h('العد الفعلي', 'Counted qty'),
          h('الفرق', 'Variance'), h('اتجاه التسوية', 'Settlement direction'),
          h('حالة الجلسة', 'Session status'), h('تعليق التسوية', 'Settlement comment')],
        rows, numeric: [8, 9, 10]
      };
    }

    case 'balances': {
      const rows = store.get('stock').filter(stockMatch).map(s => {
        const sh = store.byId('shelves', s.shelf_id) || {};
        const item = store.byId('items', s.item_id) || {};
        const areaId = s.storage_area_id || sh.storage_area_id || sh.zone_id;
        return [item.code || '', itemNameOnly(s.item_id), item.base_unit || '—',
          warehouseName(s.warehouse_id || sh.warehouse_id),
          areaName(areaId) !== '—' ? areaName(areaId) : zoneName(sh.zone_id),
          shelfName(s.shelf_id), s.batch_no || '', s.expiry_date || '', Number(s.quantity || 0)];
      });
      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الوحدة الأساسية', 'Base unit'),
          h('المستودع', 'Warehouse'), h('منطقة التخزين', 'Storage area'), h('الرف', 'Shelf'),
          h('الدفعة', 'Batch'), h('الصلاحية', 'Expiry'), h('الرصيد', 'Balance')],
        rows, numeric: [8]
      };
    }

    case 'low-stock': {
      const rows = store.get('items')
        .filter(i => textMatch(i.id))
        .map(i => {
          const matches = store.get('stock').filter(s => s.item_id === i.id && stockMatch(s));
          const qty = matches.reduce((n, s) => n + Number(s.quantity || 0), 0);
          const byWarehouse = new Map();
          for (const s of matches) {
            const sh = store.byId('shelves', s.shelf_id) || {};
            const warehouseId = s.warehouse_id || sh.warehouse_id || '';
            const key = warehouseId || '—';
            byWarehouse.set(key, (byWarehouse.get(key) || 0) + Number(s.quantity || 0));
          }
          const distribution = [...byWarehouse.entries()]
            .map(([id, quantity]) => (id === '—' ? '—' : warehouseName(id)) + ': ' + fmtNum(quantity))
            .join('، ');
          return { i, qty, matches, distribution };
        })
        .filter(x => x.qty <= Number(x.i.safety_stock || 0))
        .filter(x => (!F.area && !F.shelf) || x.matches.length > 0)
        .map(({ i, qty, distribution }) => [i.code || '', itemNameOnly(i.id), i.base_unit || '—',
          qty, Number(i.safety_stock || 0), distribution || tx('لا يوجد رصيد', 'No stock')]);
      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الوحدة الأساسية', 'Base unit'),
          h('الرصيد الحالي', 'Current qty'), h('حد الأمان', 'Safety stock'),
          h('توزيع الرصيد حسب المستودع', 'Stock by warehouse')],
        rows, numeric: [3, 4]
      };
    }

    case 'warehouse-summary': {
      const rows = store.get('warehouses')
        .filter(w => !F.warehouse || w.id === F.warehouse)
        .map(w => {
          const list = store.get('stock').filter(s => {
            const sh = store.byId('shelves', s.shelf_id) || {};
            return (s.warehouse_id || sh.warehouse_id) === w.id && stockMatch(s);
          });
          const quantities = new Map();
          for (const s of list) quantities.set(s.item_id, (quantities.get(s.item_id) || 0) + Number(s.quantity || 0));
          const itemsOnHand = new Set([...quantities.entries()].filter(([, qty]) => qty > 0).map(([id]) => id));
          const occupiedShelves = new Set(list.filter(s => Number(s.quantity || 0) > 0).map(s => s.shelf_id).filter(Boolean));
          const lowStockItems = [...quantities.entries()].filter(([id, qty]) => {
            const item = store.byId('items', id) || {};
            const safety = Number(item.safety_stock || 0);
            return safety > 0 && qty <= safety;
          }).length;
          return [w.code || '', w.name || '', itemsOnHand.size, occupiedShelves.size, list.length, lowStockItems];
        });
      return {
        headers: [h('الرمز', 'Code'), h('المستودع', 'Warehouse'), h('أصناف لها رصيد', 'Items on hand'),
          h('أرفف مشغولة', 'Occupied shelves'), h('سجلات الرصيد', 'Stock records'),
          h('أصناف دون حد الأمان', 'Low-stock items')],
        rows, numeric: [2, 3, 4, 5]
      };
    }

    case 'tx-summary': {
      // The ledger is the one movement source. Never join transactions/transfers here,
      // because the same posted movement is represented in more than one table.
      const fromAt = F.from ? new Date(F.from + 'T00:00:00').getTime() : Number.NEGATIVE_INFINITY;
      const toAt = F.to ? new Date(F.to + 'T23:59:59.999').getTime() : Number.POSITIVE_INFINITY;
      const ledgerRows = store.get('inventory_ledger')
        .filter(ledgerMatchesScope)
        .map(l => {
          const date = dateOf(l);
          return { ...l, _reportAt: date ? new Date(date).getTime() : NaN,
            _reportWarehouseId: ledgerWarehouseId(l), _reportAreaId: ledgerAreaId(l) };
        })
        .filter(l => Number.isFinite(l._reportAt))
        .sort((a, b) => a._reportAt - b._reportAt
          || String(a.created_at || '').localeCompare(String(b.created_at || ''))
          || String(a.id || '').localeCompare(String(b.id || '')));

      const groups = new Map();
      for (const l of ledgerRows) {
        const key = String(l.item_id) + '|' + String(l._reportWarehouseId);
        if (!groups.has(key)) groups.set(key, {
          itemId: l.item_id, warehouseId: l._reportWarehouseId,
          itemCode: l.item_code || '', itemName: l.item_name || '', rows: [], buckets: new Map()
        });
        const group = groups.get(key);
        if (!group.itemCode && l.item_code) group.itemCode = l.item_code;
        if (!group.itemName && l.item_name) group.itemName = l.item_name;
        group.rows.push(l);
        // running_balance is a bucket balance. Sum only after calculating each
        // item + shelf + batch bucket separately.
        const bucketKey = String(l.shelf_id || ('AREA:' + l._reportAreaId)) + '|' + String(l.batch_no || '');
        if (!group.buckets.has(bucketKey)) group.buckets.set(bucketKey, []);
        group.buckets.get(bucketKey).push(l);
      }

      const balanceAt = (bucketRows, cutoff) => {
        if (!bucketRows.length) return 0;
        const first = bucketRows[0];
        const delta = Number(first.delta || 0);
        const balance = Number(first.running_balance);
        const anchor = first.running_balance != null && Number.isFinite(balance) ? balance - delta : 0;
        return anchor + bucketRows.reduce((sum, l) => l._reportAt <= cutoff ? sum + Number(l.delta || 0) : sum, 0);
      };

      const reportRows = [];
      for (const group of groups.values()) {
        const periodRows = group.rows.filter(l => l._reportAt >= fromAt && l._reportAt <= toAt);
        const openingCutoff = Number.isFinite(fromAt) ? fromAt - 1 : Number.NEGATIVE_INFINITY;
        let opening = 0;
        const openingBaselineRows = new Set();
        for (const bucketRows of group.buckets.values()) {
          opening += balanceAt(bucketRows, openingCutoff);
          const first = bucketRows[0];
          const firstType = String(first?.source_type || '').toUpperCase();
          // If the earliest retained event is an opening balance during this report
          // window, treat it as the starting stock baseline rather than an inbound.
          // This prevents initialization stock from appearing as a supplier receipt.
          if (first && firstType === 'OPENING_BALANCE'
            && first._reportAt >= fromAt && first._reportAt <= toAt) {
            opening += Number(first.delta || 0);
            openingBaselineRows.add(first);
          }
        }
        const operationalRows = periodRows.filter(l => !openingBaselineRows.has(l));
        const movementType = l => String(l?.source_type || '').toUpperCase();
        const isTransferOut = l => movementType(l) === 'ADJUSTMENT_OUT'
          && (Boolean(l?.metadata?.transfer_id) || String(l?.source_ref || '').toUpperCase().startsWith('TRF-'));
        const isTransferIn = l => movementType(l) === 'TRANSFER_IN';
        const isTransferReturn = l => movementType(l) === 'TRANSFER_RETURN';
        const regularRows = operationalRows.filter(l => !isTransferOut(l) && !isTransferIn(l) && !isTransferReturn(l));
        const inbound = regularRows.reduce((sum, l) => sum + Math.max(0, Number(l.delta || 0)), 0);
        const outbound = regularRows.reduce((sum, l) => sum + Math.max(0, -Number(l.delta || 0)), 0);
        const transferReceived = operationalRows.filter(isTransferIn)
          .reduce((sum, l) => sum + Math.max(0, Number(l.delta || 0)), 0);
        const transferReturned = operationalRows.filter(isTransferReturn)
          .reduce((sum, l) => sum + Math.max(0, Number(l.delta || 0)), 0);
        const transferDispatched = operationalRows.filter(isTransferOut)
          .reduce((sum, l) => sum + Math.max(0, -Number(l.delta || 0)), 0);
        const closing = [...group.buckets.values()].reduce((sum, bucketRows) => sum + balanceAt(bucketRows, toAt), 0);

        if (!periodRows.length && Math.abs(opening) < 1e-9 && Math.abs(closing) < 1e-9) continue;
        const item = store.byId('items', group.itemId) || {};
        const name = itemNameOnly(group.itemId);
        const code = item.code || group.itemCode || '';
        const unit = item.base_unit || group.rows.find(l => l.unit)?.unit || '—';
        reportRows.push({
          code,
          warehouse: group.warehouseId ? warehouseName(group.warehouseId) : '—',
          values: [code, name && name !== '—' ? name : (group.itemName || '—'), unit,
            group.warehouseId ? warehouseName(group.warehouseId) : '—',
            Math.abs(opening) < 1e-10 ? 0 : opening,
            Math.abs(inbound) < 1e-10 ? 0 : inbound,
            Math.abs(transferReceived) < 1e-10 ? 0 : transferReceived,
            Math.abs(transferReturned) < 1e-10 ? 0 : transferReturned,
            Math.abs(outbound) < 1e-10 ? 0 : outbound,
            Math.abs(transferDispatched) < 1e-10 ? 0 : transferDispatched,
            Math.abs(closing) < 1e-10 ? 0 : closing]
        });
      }
      reportRows.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true })
        || String(a.warehouse).localeCompare(String(b.warehouse)));

      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الوحدة الأساسية', 'Base unit'),
          h('المستودع', 'Warehouse'), h('رصيد أول المدة', 'Opening balance'),
          h('وارد التوريدات والتسويات', 'Regular inbound'), h('وارد التحويلات', 'Transfer received'),
          h('مرتجع التحويلات', 'Transfer returned'), h('منصرف الاستخدام', 'Operational outbound'),
          h('صادر التحويلات', 'Transfer dispatched'), h('رصيد آخر المدة', 'Closing balance')],
        rows: reportRows.map(r => r.values), numeric: [4, 5, 6, 7, 8, 9, 10]
      };
    }

    case 'transfers':
    case 'returns': {
      const rows = store.get('stock_transfers')
        .filter(x => inRange(dateOf(x)))
        .filter(x => !F.warehouse || [x.source_warehouse_id, x.destination_warehouse_id].includes(F.warehouse))
        .filter(x => !F.area || [x.source_storage_area_id, x.destination_storage_area_id,
          store.byId('shelves', x.source_shelf_id)?.storage_area_id,
          store.byId('shelves', x.destination_shelf_id)?.storage_area_id].filter(Boolean).includes(F.area))
        .filter(x => !F.shelf || [x.source_shelf_id, x.destination_shelf_id].includes(F.shelf))
        .filter(x => !F.status || x.status === F.status)
        .filter(x => textMatch(x.item_id, [x.reference_no, x.notes, x.batch_no].filter(Boolean).join(' ')))
        .filter(x => kind === 'returns'
          ? String(x.status || '').toUpperCase().includes('RETURN') || Number(x.return_requested_quantity || 0) > 0
          : !String(x.status || '').toUpperCase().includes('RETURN'))
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))));
      return {
        headers: [h('التاريخ', 'Date'), h('المرجع', 'Reference'), h('رمز الصنف', 'SKU'), h('الصنف', 'Item'),
          h('من مستودع', 'Source warehouse'), h('من موقع', 'Source location'),
          h('إلى مستودع', 'Destination warehouse'), h('إلى موقع', 'Destination location'),
          h('المرسل', 'Sent qty'), h('الوحدة الأساسية', 'Base unit'), h('المستلم', 'Received qty'),
          h('طلب الإرجاع', 'Return requested'), h('المرتجع', 'Returned qty'), h('الحالة', 'Status')],
        rows: rows.map(x => {
          const item = store.byId('items', x.item_id) || {};
          return [fmtDateTime(dateOf(x)), x.reference_no || String(x.id).slice(0, 8),
            item.code || '', itemNameOnly(x.item_id),
            warehouseName(x.source_warehouse_id), shelfPath(x.source_shelf_id),
            warehouseName(x.destination_warehouse_id), shelfPath(x.destination_shelf_id),
            x.quantity ?? '', x.base_unit || item.base_unit || '—',
            x.received_quantity ?? '', x.return_requested_quantity ?? '', x.returned_quantity ?? '',
            statusLabel(x.status)];
        }),
        numeric: [8, 10, 11, 12]
      };
    }

    case 'expiry': {
      const today = todayISO();
      const todayAt = new Date(today + 'T00:00:00').getTime();
      const rows = store.get('stock')
        .filter(x => x.expiry_date)
        .filter(x => (!F.expiryFrom || String(x.expiry_date) >= F.expiryFrom)
          && (!F.expiryTo || String(x.expiry_date) <= F.expiryTo))
        .filter(stockMatch)
        .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)))
        .map(x => {
          const item = store.byId('items', x.item_id) || {};
          const days = Math.ceil((new Date(String(x.expiry_date) + 'T00:00:00').getTime() - todayAt) / 86400000);
          const state = days < 0 ? h('منتهي', 'Expired')
            : days <= 30 ? h('ينتهي خلال 30 يومًا', 'Expires within 30 days')
            : h('ساري', 'Valid');
          return [item.code || '', itemNameOnly(x.item_id), item.base_unit || '—', x.batch_no || '',
            x.expiry_date || '', days, state,
            warehouseName(x.warehouse_id || store.byId('shelves', x.shelf_id)?.warehouse_id),
            shelfPath(x.shelf_id), Number(x.quantity || 0)];
        });
      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الوحدة الأساسية', 'Base unit'),
          h('الدفعة', 'Batch'), h('تاريخ الصلاحية', 'Expiry date'), h('الأيام المتبقية', 'Days remaining'),
          h('حالة الصلاحية', 'Expiry status'), h('المستودع', 'Warehouse'), h('الموقع', 'Location'),
          h('الكمية', 'Quantity')],
        rows, numeric: [5, 9]
      };
    }

    case 'inbound':
    case 'outbound':
    case 'pending': {
      let list = store.get('transactions').filter(txMatch);
      if (kind === 'pending') list = list.filter(t => ['PENDING', 'PENDING_APPROVAL', 'SUBMITTED', 'PENDING_SYNC'].includes(String(t.status || '').toUpperCase()));
      if (kind === 'inbound') list = list.filter(t => ['GRN', 'RECEIPT', 'RECEIVING', 'INBOUND', 'ADJUSTMENT_IN'].includes(String(t.transaction_type || '').toUpperCase()));
      if (kind === 'outbound') list = list.filter(t => ['ISSUE', 'OUTBOUND', 'ADJUSTMENT_OUT'].includes(String(t.transaction_type || '').toUpperCase()));
      const rows = list
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))))
        .flatMap(t => {
          let lines = txLines(t.id).filter(transactionLineMatchesScope);
          if (F.search && !transactionHeaderMatchesSearch(t)) {
            lines = lines.filter(l => textMatch(l.item_id, [l.batch_no, l.notes].filter(Boolean).join(' ')));
          }
          if (!lines.length) return [transactionReportLine(t, null)];
          return lines.map(l => transactionReportLine(t, l));
        });
      return {
        headers: [h('التاريخ', 'Date'), h('المرجع', 'Reference'), h('النوع', 'Type'),
          h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('المستودع', 'Warehouse'),
          h('الموقع', 'Location'), h('الكمية المدخلة', 'Entered qty'), h('وحدة الإدخال', 'Entry unit'),
          h('كمية المخزون', 'Stock qty'), h('الوحدة الأساسية', 'Base unit'),
          h('المورد', 'Supplier'), h('المستلم', 'Recipient'), h('الحالة', 'Status')],
        rows, numeric: [7, 9]
      };
    }

    case 'item-card': {
      const rows = store.get('inventory_ledger')
        .filter(ledgerMatchesFilters)
        .sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b)))
          || String(a.created_at || '').localeCompare(String(b.created_at || '')))
        .map(ledgerMovementRow);
      return {
        headers: [h('التاريخ', 'Date'), h('المرجع', 'Reference'), h('نوع الحركة', 'Movement type'),
          h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الدفعة', 'Batch'),
          h('المستودع', 'Warehouse'), h('الموقع', 'Location'), h('التغير', 'Delta'),
          h('الوحدة', 'Unit'), h('الرصيد قبل', 'Before'), h('الرصيد بعد', 'After')],
        rows, numeric: [8, 10, 11]
      };
    }

    case 'movements':
    default: {
      const rows = store.get('inventory_ledger')
        .filter(ledgerMatchesFilters)
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a)))
          || String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .map(ledgerMovementRow);
      return {
        headers: [h('التاريخ', 'Date'), h('المرجع', 'Reference'), h('نوع الحركة', 'Movement type'),
          h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الدفعة', 'Batch'),
          h('المستودع', 'Warehouse'), h('الموقع', 'Location'), h('التغير', 'Delta'),
          h('الوحدة', 'Unit'), h('الرصيد قبل', 'Before'), h('الرصيد بعد', 'After')],
        rows, numeric: [8, 10, 11]
      };
    }

  }
}

function h(ar, en) { return tx(ar, en); }

/* ── render ──────────────────────────────────────────────────────────────── */

function reportBody(kind) {
  const { headers: heads, rows, numeric = [] } = reportData(kind);
  const tableHeaders = heads.map((label, i) => ({ label, num: numeric.includes(i) }));
  const body = rows.map(cells => ({
    cells: cells.map((c, i) => (numeric.includes(i) && c !== '' && c != null && !isNaN(Number(c)))
      ? fmtNum(Number(c)) : (c === '' || c == null ? '—' : c))
  }));
  return { heads: tableHeaders, rows: body, count: rows.length };
}

function render() {
  const active = KINDS.find(k => k.value === F.kind) || KINDS[0];
  const { heads, rows, count } = reportBody(F.kind);
  const statusOptions = F.kind === 'audit'
    ? [...new Set(store.get('audit_logs').map(a => a.action).filter(Boolean))]
    : F.kind === 'stocktake'
      ? [...new Set(store.get('stocktake_sessions').flatMap(s => [s.status, s.review_status]).filter(Boolean))]
      : (F.kind === 'transfers' || F.kind === 'returns')
        ? [...new Set(store.get('stock_transfers').map(x => x.status).filter(Boolean))]
        : [...new Set(store.get('transactions').map(t => t.status).filter(Boolean))];
  const typeOptions = [...new Set(store.get('transactions').map(t => t.transaction_type).filter(Boolean))];
  const showStatusFilter = ['audit', 'stocktake', 'transfers', 'returns', 'inbound', 'outbound', 'pending'].includes(F.kind);
  const showTypeFilter = ['inbound', 'outbound', 'pending'].includes(F.kind);
  const showDateFilters = !['balances', 'low-stock', 'warehouse-summary'].includes(F.kind);
  const showLocationFilters = F.kind !== 'audit';
  const reportFrom = F.kind === 'expiry' ? F.expiryFrom : F.from;
  const reportTo = F.kind === 'expiry' ? F.expiryTo : F.to;
  const reportRangeLabel = showDateFilters
    ? (reportFrom || '—') + ' → ' + (reportTo || '—')
    : tx('الرصيد الحالي', 'Current stock');

  return `
  ${pageHead(tx('التقارير', 'Reports'),
    tx('14 تقريرًا تشغيليًا موحدًا مع تصفية وتصدير وطباعة', '14 operational reports with shared filters, export and printing'),
    `${btn(`<i class="fa-solid fa-file-csv"></i> ${tx('CSV', 'CSV')}`, `onclick="OW.wms.reportExport()"`, 'secondary')}
     ${btn(`<i class="fa-solid fa-print"></i> ${tx('طباعة / PDF', 'Print / PDF')}`, `onclick="OW.wms.reportPrint()"`, 'secondary')}
     ${btn('', 'onclick="OW.wms.reloadReports()"', 'ghost', 'fa-solid fa-rotate')}`)}
  ${controlPanel({
    breadcrumb: [{ label: tx('التحليلات', 'Analytics') }, { label: tx('التقارير', 'Reports') }, { label: kindLabel(F.kind) }],
    searchPlaceholder: F.kind === 'tx-summary' || F.kind === 'low-stock' || F.kind === 'balances' || F.kind === 'warehouse-summary'
      ? tx('ابحث بالصنف أو رمزه…', 'Search item or SKU…')
      : F.kind === 'expiry' ? tx('ابحث بالصنف أو الدفعة…', 'Search item or batch…')
      : F.kind === 'stocktake' ? tx('ابحث بالصنف أو الدفعة…', 'Search item or batch…')
      : tx('ابحث بالصنف أو المرجع…', 'Search item or reference…'),
    filters: `
      <select class="o_filter_select" id="rpWarehouse">
        <option value="">${tx('كل المستودعات', 'All warehouses')}</option>
        ${warehouseOptions().map(o => `<option value="${o.value}" ${F.warehouse === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
${showLocationFilters ? `
      <select class="o_filter_select" id="rpArea">
        <option value="">${tx('كل المناطق', 'All areas')}</option>
        ${areaOptions(F.warehouse).map(o => `<option value="${o.value}" ${F.area === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <select class="o_filter_select" id="rpShelf">
        <option value="">${tx('كل الأرفف', 'All shelves')}</option>
        ${shelfOptions({ warehouseId: F.warehouse, storageAreaId: F.area }).map(o => `<option value="${o.value}" ${F.shelf === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>` : ''}
      ${showDateFilters ? `
      <input type="date" class="o_filter_input" id="rpFrom" value="${reportFrom}" title="${F.kind === 'expiry' ? tx('تاريخ الصلاحية من', 'Expiry from') : tx('من', 'From')}">
      <input type="date" class="o_filter_input" id="rpTo" value="${reportTo}" title="${F.kind === 'expiry' ? tx('تاريخ الصلاحية إلى', 'Expiry to') : tx('إلى', 'To')}">` : ''}
      ${showStatusFilter ? `
      <select class="o_filter_select" id="rpStatus">
        <option value="">${tx('كل الحالات', 'All statuses')}</option>
        ${statusOptions.map(s => `<option value="${s}" ${F.status === s ? 'selected' : ''}>${F.kind === 'audit' ? String(s).replace(/_/g, ' ') : statusLabel(s)}</option>`).join('')}
      </select>` : ''}
      ${showTypeFilter ? `
      <select class="o_filter_select" id="rpType">
        <option value="">${tx('كل الأنواع', 'All types')}</option>
        ${typeOptions.map(t => `<option value="${t}" ${F.type === t ? 'selected' : ''}>${txLabel(t)}</option>`).join('')}
      </select>` : ''}
      <button class="o_btn o_btn_ghost o_btn_sm" id="rpReset">${tx('مسح', 'Reset')}</button>`
  })}
  <div class="o_page_body">
    <div class="o_report_grid">
      ${KINDS.map(k => `<button class="o_report_chip ${k.value === F.kind ? 'active' : ''}" data-kind="${k.value}">
        <i class="${k.icon}"></i><span>${k.label()}</span></button>`).join('')}
    </div>
    <div class="o_list_summary">
      <span><b>${kindLabel(F.kind)}</b> — ${fmtNum(count)} ${tx('سطر', 'rows')}</span>
      <span>${reportRangeLabel}</span>
    </div>
    ${card('', table(heads, rows, {
      emptyTitle: tx('لا توجد بيانات مطابقة', 'No matching data'),
      emptyNote: tx('وسّع نطاق التاريخ أو غيّر عوامل التصفية.', 'Widen the date range or change the filters.')
    }), '', 'flush-body')}
    ${F.kind === 'item-card' ? alertBox(tx('حدد صنفًا في البحث لعرض كارت صنف واحد. الأرصدة تُحسب تراكميًا من سجل الحركة.',
      'Search for an item to narrow the card. Balances are the running balance from the movement ledger.'), 'info') : ''}
  </div>`;
}

/* ── interactions ────────────────────────────────────────────────────────── */

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('reports'));
}

function bind(_, main) {
  const search = main.querySelector('#oSearchInput');
  if (search) {
    search.value = F.search;
    search.addEventListener('input', () => { F.search = search.value; clearTimeout(search.__t); search.__t = setTimeout(reload, 350); });
  }
  const wire = (id, key, after) => {
    const el = main.querySelector(id);
    if (!el) return;
    el.onchange = () => { F[key] = el.value; after ? after() : reload(); };
  };
  wire('#rpWarehouse', 'warehouse', () => { F.area = ''; F.shelf = ''; reload(); });
  wire('#rpArea', 'area', () => { F.shelf = ''; reload(); });
  wire('#rpShelf', 'shelf');
  wire('#rpFrom', F.kind === 'expiry' ? 'expiryFrom' : 'from');
  wire('#rpTo', F.kind === 'expiry' ? 'expiryTo' : 'to');
  wire('#rpStatus', 'status');
  wire('#rpType', 'type');
  const reset = main.querySelector('#rpReset');
  if (reset) reset.onclick = () => {
    Object.assign(F, { warehouse: '', area: '', shelf: '', status: '', type: '', search: '',
      from: startOfMonthISO(), to: todayISO(), expiryFrom: '', expiryTo: addDaysISO(todayISO(), 90) });
    reload();
  };
  main.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    const nextKind = b.dataset.kind;
    if (nextKind !== F.kind) {
      F.status = '';
      F.type = '';
      if (nextKind === 'audit') { F.area = ''; F.shelf = ''; }
    }
    F.kind = nextKind;
    reload();
  });
}

/* ── export / print ──────────────────────────────────────────────────────── */

OW.wms = OW.wms || {};
OW.wms.reports = { reportData, kindLabel };

OW.wms.reportExport = () => {
  const { headers: heads } = reportData(F.kind);
  const plain = heads.map(hh => (typeof hh === 'string' ? hh : hh.label));
  const { rows } = reportData(F.kind);
  downloadCSV(`${F.kind}-${todayISO()}.csv`, plain, rows.map(r => r.map(c => stripTags(c))));
  toast(tx('تم تصدير التقرير', 'Report exported'), 'success');
};

OW.wms.reportPrint = () => {
  const { headers: heads, rows } = reportData(F.kind);
  const head = heads.map(hh => (typeof hh === 'string' ? hh : hh.label));
  const html = table(head, rows.map(r => ({ cells: r.map(c => stripTags(c)) })));
  printHTML(kindLabel(F.kind), `<div style="margin-bottom:10px">
      <b>${tx('الفترة', 'Period')}:</b> ${F.from || '—'} → ${F.to || '—'} &nbsp;
      <b>${tx('المستودع', 'Warehouse')}:</b> ${F.warehouse ? warehouseName(F.warehouse) : tx('الكل', 'All')}
    </div>${html}`, { subtitle: `${kindLabel(F.kind)} • ${fmtDateTime(new Date().toISOString())}` });
};

OW.wms.reloadReports = async () => {
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  reload();
};

function stripTags(v) {
  return String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

OW.registerPage('reports', {
  brand: { name: 'OW', icon: 'fa-solid fa-chart-line' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' },
    { label: tx('التحويلات', 'Transfers'), page: 'transfers' },
    { label: tx('الجرد', 'Stocktake'), page: 'stocktake' },
    { label: tx('التقارير', 'Reports'), page: 'reports' }
  ],
  render,
  mount: bind
});

export default OW.pages.reports;
