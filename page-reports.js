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
  { value: 'expiry', icon: 'fa-solid fa-calendar-xmark', label: () => tx('الصلاحيات', 'Expiry') },
  { value: 'pending', icon: 'fa-solid fa-hourglass-half', label: () => tx('بانتظار الاعتماد', 'Pending approval') }
];

const F = {
  kind: 'movements', from: startOfMonthISO(), to: todayISO(),
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
  if (F.area && String(shelfArea(sh)) !== F.area) return false;
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
    const viaLines = txLines(t.id).some(l => String(l.storage_area_id || store.byId('shelves', l.shelf_id)?.storage_area_id || '') === F.area);
    if (!direct && !viaLines) return false;
  }
  if (F.shelf && !txLines(t.id).some(l => l.shelf_id === F.shelf)) return false;
  if (F.search) {
    const hide = [t.supplier, t.receiver_name, t.reference_no, t.notes].some(v => String(v || '').toLowerCase().includes(F.search.toLowerCase()));
    const viaItem = txLines(t.id).some(l => textMatch(l.item_id));
    if (!hide && !viaItem) return false;
  }
  return true;
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
          h('المستودع', 'Warehouse'), h('التفاصيل', 'Details')],
        rows: rows.map(a => {
          let details = a.details;
          if (details && typeof details !== 'string') { try { details = JSON.stringify(details); } catch (_) { details = ''; } }
          return [fmtDateTime(dateOf(a)), profileName(a.user_id), a.action || '—', a.entity || '—',
            a.entity_id ? String(a.entity_id).slice(0, 8) : '—', a.reference || '',
            a.warehouse_id ? warehouseName(a.warehouse_id) : '', details || ''];
        })
      };
    }

    case 'stocktake': {
      const sessions = store.get('stocktake_sessions')
        .filter(s => inRange(dateOf(s)))
        .filter(s => !F.warehouse || s.warehouse_id === F.warehouse)
        .filter(s => !F.area || String(s.storage_area_id || s.zone_id || '') === F.area)
        .filter(s => !F.status || s.status === F.status || s.review_status === F.status);
      const ids = new Set(sessions.map(s => s.id));
      const rows = store.get('stocktake_lines')
        .filter(l => ids.has(l.session_id))
        .filter(l => !F.shelf || l.shelf_id === F.shelf)
        .filter(l => textMatch(l.item_id))
        .map(l => {
          const s = store.byId('stocktake_sessions', l.session_id) || {};
          const dir = String(l.settlement_direction || '').toUpperCase();
          return [fmtDateTime(dateOf(s)), String(l.session_id).slice(0, 8),
            store.byId('items', l.item_id)?.code || '', shelfName(l.shelf_id),
            l.system_qty == null ? '—' : fmtNum(l.system_qty),
            l.counted_qty == null ? '—' : fmtNum(l.counted_qty),
            l.variance == null ? '—' : fmtNum(l.variance),
            dir === 'INCREASE' ? tx('زيادة', 'Increase') : dir === 'DECREASE' ? tx('نقص', 'Decrease') : '',
            l.settlement_comment || statusLabel(s.review_status || s.status)];
        });
      return {
        headers: [h('تاريخ الجلسة', 'Session date'), h('الجلسة', 'Session'), h('رمز الصنف', 'SKU'), h('الرف', 'Shelf'),
          h('كمية النظام', 'System qty'), h('العد الفعلي', 'Counted qty'), h('الفرق', 'Variance'),
          h('اتجاه التسوية', 'Settlement direction'), h('التعليق / الحالة', 'Comment / status')],
        rows
      };
    }

    case 'balances': {
      const rows = store.get('stock').filter(stockMatch).map(s => {
        const sh = store.byId('shelves', s.shelf_id) || {};
        return [store.byId('items', s.item_id)?.code || '', itemNameOnly(s.item_id),
          warehouseName(s.warehouse_id || sh.warehouse_id), areaName(sh.storage_area_id) !== '—' ? areaName(sh.storage_area_id) : zoneName(sh.zone_id),
          shelfName(s.shelf_id), s.batch_no || '', s.expiry_date || '', Number(s.quantity || 0)];
      });
      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('المستودع', 'Warehouse'), h('منطقة التخزين', 'Storage area'),
          h('الرف', 'Shelf'), h('الدفعة', 'Batch'), h('الصلاحية', 'Expiry'), h('الرصيد', 'Balance')],
        rows, numeric: [7]
      };
    }

    case 'low-stock': {
      const rows = store.get('items')
        .filter(i => textMatch(i.id))
        .map(i => {
          const matches = store.get('stock').filter(s => s.item_id === i.id && stockMatch(s));
          const qty = matches.reduce((n, s) => n + Number(s.quantity || 0), 0);
          return { i, qty, matches };
        })
        .filter(x => x.qty <= Number(x.i.safety_stock || 0))
        .filter(x => (!F.warehouse && !F.area && !F.shelf) || x.matches.length > 0)
        .map(({ i, qty, matches }) => [i.code || '', itemNameOnly(i.id), qty, Number(i.safety_stock || 0),
          [...new Set(matches.map(s => warehouseName(s.warehouse_id || store.byId('shelves', s.shelf_id)?.warehouse_id)).filter(n => n && n !== '—'))].join(', ')]);
      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الرصيد الحالي', 'Current qty'),
          h('حد الأمان', 'Safety stock'), h('المستودعات', 'Warehouses')],
        rows, numeric: [2, 3]
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
          return [w.code || '', w.name || '', new Set(list.map(s => s.item_id)).size,
            list.reduce((n, s) => n + Number(s.quantity || 0), 0), list.length];
        });
      return {
        headers: [h('الرمز', 'Code'), h('المستودع', 'Warehouse'), h('عدد الأصناف', 'Item count'),
          h('إجمالي الكمية', 'Total qty'), h('صفوف الرصيد', 'Balance rows')],
        rows, numeric: [2, 3, 4]
      };
    }

    case 'tx-summary': {
      // Use the inventory ledger as the single movement source. Summing voucher lines
      // or transfer tables alongside it would double-count the same stock movements.
      const fromAt = F.from ? new Date(`${F.from}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
      const toAt = F.to ? new Date(`${F.to}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
      const ledgerRows = store.get('inventory_ledger')
        .map(l => {
          const sh = store.byId('shelves', l.shelf_id) || {};
          const date = dateOf(l);
          return {
            ...l,
            _reportAt: date ? new Date(date).getTime() : NaN,
            _reportWarehouseId: l.warehouse_id || sh.warehouse_id || '',
            _reportAreaId: l.storage_area_id || sh.storage_area_id || sh.zone_id || ''
          };
        })
        .filter(l => Number.isFinite(l._reportAt))
        .filter(l => !F.warehouse || l._reportWarehouseId === F.warehouse)
        .filter(l => !F.area || l._reportAreaId === F.area)
        .filter(l => !F.shelf || l.shelf_id === F.shelf)
        .filter(l => textMatch(l.item_id, [l.item_code, l.item_name].filter(Boolean).join(' ')))
        .sort((a, b) => a._reportAt - b._reportAt
          || String(a.created_at || '').localeCompare(String(b.created_at || ''))
          || String(a.id || '').localeCompare(String(b.id || '')));

      const groups = new Map();
      for (const l of ledgerRows) {
        const key = `${l.item_id}|${l._reportWarehouseId}`;
        if (!groups.has(key)) {
          groups.set(key, {
            itemId: l.item_id,
            warehouseId: l._reportWarehouseId,
            itemCode: l.item_code || '',
            itemName: l.item_name || '',
            rows: [],
            buckets: new Map()
          });
        }
        const group = groups.get(key);
        if (!group.itemCode && l.item_code) group.itemCode = l.item_code;
        if (!group.itemName && l.item_name) group.itemName = l.item_name;
        group.rows.push(l);

        // running_balance is maintained per item + shelf + batch; do not sum a
        // running balance from one batch with another. Aggregate buckets afterward.
        const locationKey = l.shelf_id || `AREA:${l._reportAreaId}`;
        const bucketKey = `${locationKey}|${String(l.batch_no || '')}`;
        if (!group.buckets.has(bucketKey)) group.buckets.set(bucketKey, []);
        group.buckets.get(bucketKey).push(l);
      }

      // Anchor each bucket at the balance immediately before its first ledger
      // row, then roll forward deltas. This also supports a history whose earliest
      // retained row is not an opening-balance voucher.
      const balanceAt = (bucketRows, cutoff) => {
        if (!bucketRows.length) return 0;
        const first = bucketRows[0];
        const firstDelta = Number(first.delta || 0);
        const firstBalance = Number(first.running_balance);
        const hasFirstBalance = first.running_balance != null && Number.isFinite(firstBalance);
        const anchor = hasFirstBalance ? firstBalance - firstDelta : 0;
        return anchor + bucketRows.reduce((sum, l) => {
          return l._reportAt <= cutoff ? sum + Number(l.delta || 0) : sum;
        }, 0);
      };

      const reportRows = [];
      for (const group of groups.values()) {
        const periodRows = group.rows.filter(l => l._reportAt >= fromAt && l._reportAt <= toAt);
        const openingCutoff = Number.isFinite(fromAt) ? fromAt - 1 : Number.NEGATIVE_INFINITY;
        const opening = [...group.buckets.values()]
          .reduce((sum, bucketRows) => sum + balanceAt(bucketRows, openingCutoff), 0);
        const inbound = periodRows.reduce((sum, l) => sum + Math.max(0, Number(l.delta || 0)), 0);
        const outbound = periodRows.reduce((sum, l) => sum + Math.max(0, -Number(l.delta || 0)), 0);
        const closing = [...group.buckets.values()]
          .reduce((sum, bucketRows) => sum + balanceAt(bucketRows, toAt), 0);

        // Omit items with neither stock nor movement in the selected period.
        if (!periodRows.length && Math.abs(opening) < 1e-9 && Math.abs(closing) < 1e-9) continue;

        const item = store.byId('items', group.itemId) || {};
        const catalogName = itemNameOnly(group.itemId);
        const displayName = catalogName && catalogName !== '—' ? catalogName : (group.itemName || '—');
        const code = item.code || group.itemCode || '';
        const unit = item.base_unit || group.rows.find(l => l.unit)?.unit || '—';
        const warehouse = group.warehouseId ? warehouseName(group.warehouseId) : '—';
        reportRows.push({
          code,
          warehouse,
          values: [code, displayName, unit, warehouse,
            Math.abs(opening) < 1e-10 ? 0 : opening,
            Math.abs(inbound) < 1e-10 ? 0 : inbound,
            Math.abs(outbound) < 1e-10 ? 0 : outbound,
            Math.abs(closing) < 1e-10 ? 0 : closing]
        });
      }
      reportRows.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true })
        || String(a.warehouse).localeCompare(String(b.warehouse)));

      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الوحدة الأساسية', 'Base unit'),
          h('المستودع', 'Warehouse'), h('رصيد أول المدة', 'Opening balance'),
          h('إجمالي الوارد', 'Total inbound'), h('إجمالي المنصرف', 'Total outbound'),
          h('رصيد آخر المدة', 'Closing balance')],
        rows: reportRows.map(r => r.values), numeric: [4, 5, 6, 7]
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
        .filter(x => textMatch(x.item_id))
        .filter(x => kind === 'returns'
          ? String(x.status || '').includes('RETURN') || Number(x.return_requested_quantity || 0) > 0
          : !String(x.status || '').includes('RETURN'))
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))));
      return {
        headers: [h('التاريخ', 'Date'), h('المرجع', 'Reference'), h('من مستودع', 'Source warehouse'),
          h('إلى مستودع', 'Destination warehouse'), h('الصنف', 'Item'), h('المرسل', 'Sent qty'),
          h('المستلم', 'Received qty'), h('طلب الإرجاع', 'Return requested'), h('المرتجع', 'Returned qty'),
          h('الحالة', 'Status')],
        rows: rows.map(x => [fmtDateTime(dateOf(x)), x.reference_no || String(x.id).slice(0, 8),
          warehouseName(x.source_warehouse_id), warehouseName(x.destination_warehouse_id),
          store.byId('items', x.item_id)?.code || '', x.quantity ?? '',
          x.received_quantity ?? '', x.return_requested_quantity ?? '', x.returned_quantity ?? '',
          statusLabel(x.status)]),
        numeric: [5, 6, 7, 8]
      };
    }

    case 'expiry': {
      const rows = store.get('stock')
        .filter(x => x.expiry_date)
        .filter(x => (!F.from || String(x.expiry_date) >= F.from) && (!F.to || String(x.expiry_date) <= F.to))
        .filter(stockMatch)
        .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)))
        .map(x => [store.byId('items', x.item_id)?.code || '', itemNameOnly(x.item_id), x.batch_no || '',
          x.expiry_date || '', warehouseName(x.warehouse_id || store.byId('shelves', x.shelf_id)?.warehouse_id),
          shelfName(x.shelf_id), Number(x.quantity || 0)]);
      return {
        headers: [h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('الدفعة', 'Batch'), h('تاريخ الصلاحية', 'Expiry date'),
          h('المستودع', 'Warehouse'), h('الرف', 'Shelf'), h('الكمية', 'Quantity')],
        rows, numeric: [6]
      };
    }

    case 'inbound':
    case 'outbound':
    case 'pending': {
      let list = store.get('transactions').filter(txMatch);
      if (kind === 'pending') list = list.filter(t => ['PENDING', 'PENDING_APPROVAL', 'SUBMITTED', 'PENDING_SYNC'].includes(String(t.status || '')));
      if (kind === 'inbound') list = list.filter(t => ['GRN', 'RECEIPT', 'RECEIVING', 'INBOUND', 'ADJUSTMENT_IN', 'OPENING_BALANCE'].includes(String(t.transaction_type || '')));
      if (kind === 'outbound') list = list.filter(t => ['ISSUE', 'OUTBOUND', 'ADJUSTMENT_OUT'].includes(String(t.transaction_type || '')));
      const rows = list
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))))
        .map(t => [fmtDateTime(dateOf(t)), t.reference_no || '', txLabel(t.transaction_type),
          warehouseName(t.warehouse_id), t.supplier || '', t.receiver_name || '',
          statusLabel(t.status),
          txLines(t.id).reduce((n, l) => n + Number(l.quantity || 0), Number(t.total_qty || 0))]);
      return {
        headers: [h('التاريخ', 'Date'), h('المرجع', 'Reference'), h('النوع', 'Type'), h('المستودع', 'Warehouse'),
          h('المورد', 'Supplier'), h('المستلم', 'Recipient'), h('الحالة', 'Status'), h('الكمية', 'Qty')],
        rows, numeric: [7]
      };
    }

    case 'item-card': {
      const rows = store.get('inventory_ledger')
        .filter(l => inRange(dateOf(l)))
        .filter(l => !F.warehouse || l.warehouse_id === F.warehouse)
        .filter(l => !F.area || [l.storage_area_id, l.zone_id].filter(Boolean).includes(F.area))
        .filter(l => !F.shelf || l.shelf_id === F.shelf)
        .filter(l => textMatch(l.item_id, [l.item_code, l.item_name].filter(Boolean).join(' ')))
        .sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))))
        .map(l => [fmtDateTime(dateOf(l)), l.item_code || store.byId('items', l.item_id)?.code || '',
          l.item_name || itemNameOnly(l.item_id), l.source_ref || l.source_id || '',
          l.delta ?? '', l.running_balance == null ? '' : Number(l.running_balance) - Number(l.delta || 0),
          l.running_balance ?? '', warehouseName(l.warehouse_id)]);
      return {
        headers: [h('التاريخ', 'Date'), h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('المرجع', 'Reference'),
          h('التغير', 'Delta'), h('قبل', 'Before'), h('بعد', 'After'), h('المستودع', 'Warehouse')],
        rows, numeric: [4, 5, 6]
      };
    }

    case 'movements':
    default: {
      const rows = store.get('inventory_ledger')
        .filter(l => inRange(dateOf(l)))
        .filter(l => !F.warehouse || l.warehouse_id === F.warehouse)
        .filter(l => !F.area || [l.storage_area_id, l.zone_id].filter(Boolean).includes(F.area))
        .filter(l => !F.shelf || l.shelf_id === F.shelf)
        .filter(l => textMatch(l.item_id, [l.item_code, l.item_name].filter(Boolean).join(' ')))
        .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))))
        .map(l => [fmtDateTime(dateOf(l)), store.byId('items', l.item_id)?.code || l.item_code || '',
          itemNameOnly(l.item_id) || l.item_name || '', l.source_ref || l.source_id || '',
          l.delta ?? 0, l.running_balance == null ? '' : Number(l.running_balance) - Number(l.delta || 0),
          l.running_balance ?? '', warehouseName(l.warehouse_id)]);
      return {
        headers: [h('التاريخ', 'Date'), h('رمز الصنف', 'SKU'), h('الصنف', 'Item'), h('المرجع', 'Reference'),
          h('التغير', 'Delta'), h('قبل', 'Before'), h('بعد', 'After'), h('المستودع', 'Warehouse')],
        rows, numeric: [4, 5, 6]
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
  const statuses = [...new Set(store.get('transactions').map(t => t.status).filter(Boolean))];
  const types = [...new Set(store.get('transactions').map(t => t.transaction_type).filter(Boolean))];

  return `
  ${pageHead(tx('التقارير', 'Reports'),
    tx('14 تقريرًا تشغيليًا موحدًا مع تصفية وتصدير وطباعة', '14 operational reports with shared filters, export and printing'),
    `${btn(`<i class="fa-solid fa-file-csv"></i> ${tx('CSV', 'CSV')}`, `onclick="OW.wms.reportExport()"`, 'secondary')}
     ${btn(`<i class="fa-solid fa-print"></i> ${tx('طباعة / PDF', 'Print / PDF')}`, `onclick="OW.wms.reportPrint()"`, 'secondary')}
     ${btn('', 'onclick="OW.wms.reloadReports()"', 'ghost', 'fa-solid fa-rotate')}`)}
  ${controlPanel({
    breadcrumb: [{ label: tx('التحليلات', 'Analytics') }, { label: tx('التقارير', 'Reports') }, { label: kindLabel(F.kind) }],
    searchPlaceholder: tx('ابحث بالصنف أو المرجع…', 'Search item or reference…'),
    filters: `
      <select class="o_filter_select" id="rpWarehouse">
        <option value="">${tx('كل المستودعات', 'All warehouses')}</option>
        ${warehouseOptions().map(o => `<option value="${o.value}" ${F.warehouse === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <select class="o_filter_select" id="rpArea">
        <option value="">${tx('كل المناطق', 'All areas')}</option>
        ${areaOptions(F.warehouse).map(o => `<option value="${o.value}" ${F.area === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <select class="o_filter_select" id="rpShelf">
        <option value="">${tx('كل الأرفف', 'All shelves')}</option>
        ${shelfOptions({ warehouseId: F.warehouse, storageAreaId: F.area }).map(o => `<option value="${o.value}" ${F.shelf === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <input type="date" class="o_filter_input" id="rpFrom" value="${F.from}" title="${tx('من', 'From')}">
      <input type="date" class="o_filter_input" id="rpTo" value="${F.to}" title="${tx('إلى', 'To')}">
      <select class="o_filter_select" id="rpStatus">
        <option value="">${tx('كل الحالات', 'All statuses')}</option>
        ${statuses.map(s => `<option value="${s}" ${F.status === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
      </select>
      <select class="o_filter_select" id="rpType">
        <option value="">${tx('كل الأنواع', 'All types')}</option>
        ${types.map(t => `<option value="${t}" ${F.type === t ? 'selected' : ''}>${txLabel(t)}</option>`).join('')}
      </select>
      <button class="o_btn o_btn_ghost o_btn_sm" id="rpReset">${tx('مسح', 'Reset')}</button>`
  })}
  <div class="o_page_body">
    <div class="o_report_grid">
      ${KINDS.map(k => `<button class="o_report_chip ${k.value === F.kind ? 'active' : ''}" data-kind="${k.value}">
        <i class="${k.icon}"></i><span>${k.label()}</span></button>`).join('')}
    </div>
    <div class="o_list_summary">
      <span><b>${kindLabel(F.kind)}</b> — ${fmtNum(count)} ${tx('سطر', 'rows')}</span>
      <span>${F.from || '—'} → ${F.to || '—'}</span>
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
  wire('#rpFrom', 'from');
  wire('#rpTo', 'to');
  wire('#rpStatus', 'status');
  wire('#rpType', 'type');
  const reset = main.querySelector('#rpReset');
  if (reset) reset.onclick = () => {
    Object.assign(F, { warehouse: '', area: '', shelf: '', status: '', type: '', search: '', from: startOfMonthISO(), to: todayISO() });
    reload();
  };
  main.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { F.kind = b.dataset.kind; reload(); });
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
