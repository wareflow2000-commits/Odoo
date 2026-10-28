// ============================================================================
// OW — Orders (transfer orders)
// ----------------------------------------------------------------------------
// The "Orders" workspace is the operational view of transfer orders: one
// reference groups its dispatched lines, receipt progress and returns.
// ============================================================================
import { OW } from './core-registry.js';
import { tx } from './core-i18n.js';
import {
  pageHead, card, statCard, table, empty, statusBadge, btn, alertBox,
  controlPanel, tabs, printHTML
} from './core-ui.js';
import {
  store, pullAll, warehouseName, itemNameOnly, shelfPath, profileName, itemLabel
} from './core-store.js';
import { canTransfer } from './core-rbac.js';
import { fmtDateTime, fmtNum, statusLabel } from './core-utils.js';
import { toast } from './core-toast.js';
import { modal } from './core-modal.js';

const F = { tab: 'open', search: '' };
const OPEN_STATES = ['IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RETURN_IN_TRANSIT'];
const DONE_STATES = ['RECEIVED', 'RETURNED_TO_SOURCE'];

function linesOf(orderId) {
  return store.get('stock_transfers').filter(t => t.transfer_order_id === orderId);
}

function progress(order) {
  const lines = linesOf(order.id);
  const sent = lines.reduce((n, t) => n + Number(t.quantity || 0), 0);
  const received = lines.reduce((n, t) => n + Number(t.received_quantity || 0), 0);
  const returned = lines.reduce((n, t) => n + Number(t.returned_quantity || 0), 0);
  return { lines, sent, received, returned, pct: sent ? Math.min(100, Math.round((received / sent) * 100)) : 0 };
}

function filtered() {
  let list = [...store.get('stock_transfer_orders')];
  if (F.tab === 'open') list = list.filter(o => OPEN_STATES.includes(o.status));
  if (F.tab === 'done') list = list.filter(o => DONE_STATES.includes(o.status));
  if (F.tab === 'returns') list = list.filter(o => o.status === 'RETURNED_TO_SOURCE' || linesOf(o.id).some(l => Number(l.return_requested_quantity || 0) > 0));
  if (F.search) {
    const q = F.search.toLowerCase();
    list = list.filter(o => [
      o.reference_no, warehouseName(o.source_warehouse_id), warehouseName(o.destination_warehouse_id),
      o.notes, ...linesOf(o.id).map(l => itemNameOnly(l.item_id))
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function tabCount(v) {
  const all = store.get('stock_transfer_orders');
  if (v === 'open') return all.filter(o => OPEN_STATES.includes(o.status)).length;
  if (v === 'done') return all.filter(o => DONE_STATES.includes(o.status)).length;
  if (v === 'returns') return all.filter(o => o.status === 'RETURNED_TO_SOURCE' || linesOf(o.id).some(l => Number(l.return_requested_quantity || 0) > 0)).length;
  return all.length;
}

function render() {
  const orders = filtered();
  const all = store.get('stock_transfer_orders');
  const open = all.filter(o => OPEN_STATES.includes(o.status));
  const lines = store.get('stock_transfers');

  return `
  ${pageHead(tx('الطلبيات', 'Orders'),
    tx('طلبيات التحويل بين المستودعات ومتابعة الاستلام', 'Inter-warehouse transfer orders and receipt tracking'),
    `${canTransfer() ? btn(`<i class="fa-solid fa-plus"></i> ${tx('طلبية جديدة', 'New order')}`, `onclick="OW.wms.newTransfer()"`, 'primary') : ''}
     ${btn(`<i class="fa-solid fa-truck-arrow-right"></i> ${tx('كل التحويلات', 'All transfers')}`, `onclick="showPage('transfers')"`, 'secondary')}
     ${btn('', 'onclick="OW.wms.reloadOrders()"', 'ghost', 'fa-solid fa-rotate')}`)}
  ${controlPanel({
    breadcrumb: [{ label: tx('العمليات', 'Operations') }, { label: tx('الطلبيات', 'Orders') }],
    searchPlaceholder: tx('ابحث بالمرجع أو المستودع أو الصنف…', 'Search reference, warehouse or item…')
  })}
  <div class="o_page_body">
    <div class="o_grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      ${statCard({ label: tx('إجمالي الطلبيات', 'Orders'), value: fmtNum(all.length), icon: 'fa-solid fa-file-lines', tone: 'purple' })}
      ${statCard({ label: tx('مفتوحة', 'Open'), value: fmtNum(open.length), note: tx('قيد النقل أو الاستلام', 'in transit or receiving'), icon: 'fa-solid fa-truck-fast', tone: 'blue' })}
      ${statCard({ label: tx('مكتملة', 'Completed'), value: fmtNum(all.filter(o => o.status === 'RECEIVED').length), icon: 'fa-solid fa-circle-check', tone: 'green' })}
      ${statCard({ label: tx('أسطر التحويل', 'Transfer lines'), value: fmtNum(lines.length), icon: 'fa-solid fa-bars-staggered', tone: 'amber' })}
    </div>
    ${tabs([
      { value: 'open', label: tx('مفتوحة', 'Open'), count: tabCount('open') },
      { value: 'done', label: tx('مكتملة', 'Completed'), count: tabCount('done') },
      { value: 'returns', label: tx('مرتجعات', 'Returns'), count: tabCount('returns') },
      { value: 'all', label: tx('الكل', 'All'), count: tabCount('all') }
    ].map(t => ({ ...t, onclick: `OW.wms.orderTab('${t.value}')` })), F.tab)}
    ${card('', table(
      [{ label: tx('الطلبية', 'Order') }, { label: tx('المسار', 'Route') }, { label: tx('الأسطر', 'Lines'), num: true },
       { label: tx('المرسل', 'Sent'), num: true }, { label: tx('المستلم', 'Received'), num: true },
       { label: tx('التقدم', 'Progress') }, { label: tx('الحالة', 'Status') }, { label: tx('إجراءات', 'Actions') }],
      orders.map(o => {
        const p = progress(o);
        return {
          cells: [
            `<span class="o_cell_main">${o.reference_no || String(o.id).slice(0, 8)}</span><div class="o_cell_sub">${fmtDateTime(o.created_at)}</div>`,
            `<span class="o_cell_main">${warehouseName(o.source_warehouse_id)}</span><div class="o_cell_sub">→ ${warehouseName(o.destination_warehouse_id)}</div>`,
            fmtNum(p.lines.length), fmtNum(p.sent), fmtNum(p.received),
            `<div class="o_progress"><div class="o_mini_bar"><span style="width:${p.pct}%"></span></div><small>${p.pct}%</small></div>`,
            statusBadge(o.status, statusLabel(o.status)),
            `<div class="o_actions_cell">
              <button class="o_btn o_btn_ghost o_btn_sm" data-order="${o.id}" title="${tx('تفاصيل', 'Details')}"><i class="fa-solid fa-eye"></i></button>
              ${OPEN_STATES.includes(o.status) && canTransfer()
                ? `<button class="o_btn o_btn_success o_btn_sm" data-receive-line="${(p.lines.find(l => OPEN_STATES.includes(l.status)) || {}).id || ''}">${tx('استلام', 'Receive')}</button>` : ''}
            </div>`
          ]
        };
      }),
      { emptyTitle: tx('لا توجد طلبيات في هذه الحالة', 'No orders in this state'),
        emptyNote: tx('أنشئ طلبية تحويل لنقل البضائع بين المستودعات.', 'Create a transfer order to move goods between warehouses.') }
    ), '', 'flush-body')}
  </div>`;
}

function bind(_, main) {
  const search = main.querySelector('#oSearchInput');
  if (search) {
    search.value = F.search;
    search.addEventListener('input', () => { F.search = search.value; reload(); });
  }
  main.querySelectorAll('[data-order]').forEach(b => b.onclick = () => openOrder(b.dataset.order));
  main.querySelectorAll('[data-receive-line]').forEach(b => b.onclick = () => {
    if (b.dataset.receiveLine) OW.wms.receiveTransfer?.(b.dataset.receiveLine);
    else openOrder(b.closest('tr')?.dataset.order || '');
  });
}

function openOrder(id) {
  const o = store.byId('stock_transfer_orders', id);
  if (!o) return;
  const p = progress(o);
  const body = `
    <div class="o_tx_head"><div>
      <div class="o_tx_ref">${o.reference_no || String(o.id).slice(0, 8)}</div>
      <div class="o_muted">${fmtDateTime(o.created_at)} • ${profileName(o.created_by)}</div>
    </div><div>${statusBadge(o.status, statusLabel(o.status))}</div></div>
    <div class="o_detail_grid">
      <div><small>${tx('من', 'From')}</small><b>${warehouseName(o.source_warehouse_id)}</b></div>
      <div><small>${tx('إلى', 'To')}</small><b>${warehouseName(o.destination_warehouse_id)}</b></div>
      <div><small>${tx('النوع', 'Type')}</small><b>${o.operation_type || 'TRANSFER'}</b></div>
      <div><small>${tx('الأسطر', 'Lines')}</small><b>${fmtNum(p.lines.length)}</b></div>
      <div><small>${tx('المرسل', 'Sent')}</small><b>${fmtNum(p.sent)}</b></div>
      <div><small>${tx('المستلم', 'Received')}</small><b>${fmtNum(p.received)}</b></div>
      <div><small>${tx('المرتجع', 'Returned')}</small><b>${fmtNum(p.returned)}</b></div>
      <div><small>${tx('التقدم', 'Progress')}</small><b>${p.pct}%</b></div>
    </div>
    ${o.notes ? `<div class="o_callout" style="margin:12px 0">${o.notes}</div>` : ''}
    <div class="o_section_label">${tx('أسطر الطلبية', 'Order lines')}</div>
    ${table(
      [{ label: tx('الصنف', 'Item') }, { label: tx('من رف', 'Source shelf') }, { label: tx('إلى رف', 'Destination shelf') },
       { label: tx('المرسل', 'Sent'), num: true }, { label: tx('المستلم', 'Received'), num: true },
       { label: tx('المرتجع', 'Returned'), num: true }, { label: tx('الحالة', 'Status') }, { label: '', width: '100px' }],
      p.lines.map(l => ({
        cells: [
          `<span class="o_cell_main">${itemNameOnly(l.item_id)}</span><div class="o_cell_sub">${l.batch_no || ''}</div>`,
          l.source_shelf_id ? shelfPath(l.source_shelf_id) : '—',
          l.destination_shelf_id ? shelfPath(l.destination_shelf_id) : '—',
          fmtNum(l.quantity), fmtNum(l.received_quantity), fmtNum(l.returned_quantity || l.return_requested_quantity),
          statusBadge(l.status, statusLabel(l.status)),
          OPEN_STATES.includes(l.status) && canTransfer()
            ? `<button class="o_btn o_btn_success o_btn_sm" data-line-receive="${l.id}">${tx('استلام', 'Receive')}</button>` : ''
        ]
      })),
      { emptyTitle: tx('لا توجد أسطر', 'No lines') }
    )}`;
  modal({
    title: `<i class="fa-solid fa-file-lines"></i> ${tx('تفاصيل الطلبية', 'Order details')}`,
    size: 'lg', body,
    footer: `<button class="o_btn o_btn_secondary" id="ordPrint"><i class="fa-solid fa-print"></i> ${tx('طباعة', 'Print')}</button>
             <button class="o_btn o_btn_primary" id="ordClose">${tx('إغلاق', 'Close')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#ordClose').onclick = close;
      el.querySelector('#ordPrint').onclick = () => printOrder(o, p);
      el.querySelectorAll('[data-line-receive]').forEach(b => b.onclick = () => {
        close();
        OW.wms.receiveTransfer?.(b.dataset.lineReceive);
      });
    }
  });
}

function printOrder(o, p) {
  const html = table(
    [{ label: tx('الصنف', 'Item') }, { label: tx('من رف', 'From shelf') }, { label: tx('إلى رف', 'To shelf') },
     { label: tx('المرسل', 'Sent'), num: true }, { label: tx('المستلم', 'Received'), num: true }, { label: tx('الحالة', 'Status') }],
    p.lines.map(l => ({
      cells: [itemLabel(l.item_id), l.source_shelf_id ? shelfPath(l.source_shelf_id) : '—',
        l.destination_shelf_id ? shelfPath(l.destination_shelf_id) : '—', fmtNum(l.quantity),
        fmtNum(l.received_quantity), statusLabel(l.status)]
    }))
  );
  printHTML(`${tx('طلبية تحويل', 'Transfer order')} ${o.reference_no || ''}`,
    `<div style="margin-bottom:10px">
      <b>${tx('من', 'From')}:</b> ${warehouseName(o.source_warehouse_id)} &nbsp;
      <b>${tx('إلى', 'To')}:</b> ${warehouseName(o.destination_warehouse_id)} &nbsp;
      <b>${tx('الحالة', 'Status')}:</b> ${statusLabel(o.status)}
    </div>${html}`, { subtitle: fmtDateTime(o.created_at) });
}

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('orders'));
}

OW.wms = OW.wms || {};
OW.wms.orderTab = v => { F.tab = v; reload(); };
OW.wms.reloadOrders = async () => {
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  reload();
};

OW.registerPage('orders', {
  brand: { name: 'OW', icon: 'fa-solid fa-file-lines' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('الطلبيات', 'Orders'), page: 'orders' },
    { label: tx('التحويلات', 'Transfers'), page: 'transfers' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' }
  ],
  render,
  mount: bind
});

export default OW.pages.orders;
