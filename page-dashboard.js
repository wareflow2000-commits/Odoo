// ============================================================================
// OW — Dashboard
// ============================================================================
import { OW } from './core-registry.js';
import { tx, LANG } from './core-i18n.js';
import {
  pageHead, card, statCard, table, empty, statusBadge, alertBox, btn, fmt
} from './core-ui.js';
import {
  store, pullAll, approveTransaction,
  itemNameOnly, warehouseName, queueSnapshot, setting
} from './core-store.js';
import { dashboardStats, latestInventoryLedger } from './core-api-supabase.js';
import { canApproveTransactions } from './core-rbac.js';
import { fmtDateTime, fmtNum, txLabel, statusLabel, daysUntil } from './core-utils.js';
import { toast } from './core-toast.js';
import { confirmDialog } from './core-modal.js';

const PENDING = ['PENDING_APPROVAL', 'PENDING', 'PENDING_SYNC'];

function syncBanner() {
  const q = queueSnapshot().filter(x => x.status !== 'SYNCED');
  if (!navigator.onLine) {
    return alertBox(`<b>${tx('وضع دون اتصال', 'Offline mode')}</b> — ${tx('يتم حفظ المسودات محليًا ومزامنتها عند عودة الاتصال. لا تُرحَّل أرصدة المخزون دون اتصال.',
      'Drafts are stored locally and synchronized when the connection returns. Stock balances are never posted offline.')}`, 'warning');
  }
  if (q.length) {
    return alertBox(`${tx('لديك', 'You have')} <b>${q.length}</b> ${tx('عملية بانتظار المزامنة.', 'operation(s) waiting to sync.')}
      <a onclick="showPage('sync')" style="font-weight:600">${tx('عرض قائمة الانتظار', 'Open queue')} →</a>`, 'info');
  }
  return '';
}

function warehouseSummary() {
  const stock = store.get('stock');
  return store.get('warehouses').map(w => {
    const rows = stock.filter(s => s.warehouse_id === w.id);
    const items = new Set(rows.map(s => s.item_id)).size;
    const qty = rows.reduce((n, s) => n + Number(s.quantity || 0), 0);
    const shelves = store.get('shelves').filter(s => s.warehouse_id === w.id).length;
    return { w, items, qty, shelves, rows: rows.length };
  });
}

function lowStockRows() {
  const byItem = new Map();
  for (const s of store.get('stock')) byItem.set(s.item_id, (byItem.get(s.item_id) || 0) + Number(s.quantity || 0));
  return store.get('items')
    .map(i => ({ i, qty: byItem.get(i.id) || 0 }))
    .filter(({ i, qty }) => qty <= Number(i.safety_stock || 0))
    .sort((a, b) => a.qty - b.qty)
    .slice(0, 8);
}

function expiryRows() {
  return store.get('stock')
    .filter(s => s.expiry_date)
    .map(s => ({ s, days: daysUntil(s.expiry_date) }))
    .filter(x => x.days != null && x.days <= 120)
    .sort((a, b) => a.days - b.days)
    .slice(0, 8);
}

function recentRows() {
  const ledger = store.get('inventory_ledger');
  if (ledger.length) {
    return [...ledger].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 9).map(r => ({
      cells: [
        fmtDateTime(r.occurred_at),
        `<span class="o_cell_main">${r.item_name || itemNameOnly(r.item_id)}</span><div class="o_cell_sub">${r.item_code || ''}</div>`,
        `<span class="${Number(r.delta) >= 0 ? 'o_pos' : 'o_neg'}">${Number(r.delta) > 0 ? '+' : ''}${fmtNum(r.delta)}</span>`,
        fmtNum(r.running_balance),
        warehouseName(r.warehouse_id)
      ]
    }));
  }
  return [...store.get('transactions')]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 9)
    .map(t => ({
      cells: [
        fmtDateTime(t.created_at),
        `<span class="o_cell_main">${t.reference_no || '—'}</span><div class="o_cell_sub">${txLabel(t.transaction_type)}</div>`,
        `<span class="o_cell_main">${fmtNum(t.total_qty)}</span>`,
        statusBadge(t.status, statusLabel(t.status)),
        warehouseName(t.warehouse_id)
      ]
    }));
}

function pendingRows() {
  return [...store.get('transactions')]
    .filter(t => PENDING.includes(t.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 8)
    .map(t => ({
      cells: [
        `<span class="o_cell_main">${t.reference_no || '—'}</span><div class="o_cell_sub">${fmtDateTime(t.created_at)}</div>`,
        txLabel(t.transaction_type),
        `${fmtNum(t.total_qty)}`,
        statusBadge(t.status, statusLabel(t.status)),
        `<div class="o_actions_cell">
          <button class="o_btn o_btn_ghost o_btn_sm" data-view="${t.id}" title="${tx('تفاصيل', 'Details')}"><i class="fa-solid fa-eye"></i></button>
          ${canApproveTransactions() && t.status !== 'PENDING_SYNC'
            ? `<button class="o_btn o_btn_success o_btn_sm" data-approve="${t.id}">${tx('اعتماد', 'Approve')}</button>` : ''}
        </div>`
      ]
    }));
}

async function renderDashboard() {
  const stats = await dashboardStats();
  const ws = warehouseSummary();
  const low = lowStockRows();
  const exp = expiryRows();
  const pending = pendingRows();
  const recent = recentRows();
  const user = window.__session;

  return `
  ${pageHead(
    tx('لوحة التحكم', 'Dashboard'),
    tx(`نظرة تشغيلية مباشرة — ${user?.name || ''}`, `Live operational overview — ${user?.name || ''}`),
    `${btn(`<i class="fa-solid fa-arrow-down-to-line"></i> ${tx('توريد', 'Receive')}`, `onclick="OW.wms.newTx('GRN')"`, 'success')}
     ${btn(`<i class="fa-solid fa-arrow-up-from-line"></i> ${tx('صرف', 'Issue')}`, `onclick="OW.wms.newTx('ISSUE')"`, 'primary')}
     ${btn(`<i class="fa-solid fa-truck-arrow-right"></i> ${tx('تحويل', 'Transfer')}`, `onclick="showPage('transfers')"`, 'secondary')}
     ${btn('', `onclick="OW.wms.refreshDashboard()" title="${tx('تحديث', 'Refresh')}"`, 'ghost', 'fa-solid fa-rotate')}`
  )}
  <div class="o_page_body">
    ${syncBanner()}
    <div class="o_grid" style="grid-template-columns:repeat(6,minmax(0,1fr));margin-top:${syncBanner() ? 14 : 0}px">
      ${statCard({ label: tx('إجمالي الكمية', 'Total stock'), value: fmtNum(stats.totalQty), note: tx('وحدة أساسية', 'base units'), icon: 'fa-solid fa-cubes-stacked', tone: 'purple' })}
      ${statCard({ label: tx('الأصناف', 'Items'), value: fmtNum(stats.items), note: `${fmtNum(stats.shelves)} ${tx('رف', 'shelves')}`, icon: 'fa-solid fa-boxes-stacked', tone: 'blue', href: 'inventory' })}
      ${statCard({ label: tx('مخزون منخفض', 'Low stock'), value: fmtNum(stats.lowStock), note: tx('أقل من حد الأمان', 'below safety stock'), icon: 'fa-solid fa-triangle-exclamation', tone: 'amber' })}
      ${statCard({ label: tx('بانتظار الاعتماد', 'Pending'), value: fmtNum(stats.pending), note: tx('معاملات', 'transactions'), icon: 'fa-solid fa-hourglass-half', tone: 'amber', href: 'transactions' })}
      ${statCard({ label: tx('تحويلات قيد النقل', 'In transit'), value: fmtNum(stats.transfersInTransit), note: tx('بين المستودعات', 'between warehouses'), icon: 'fa-solid fa-truck-fast', tone: 'blue', href: 'transfers' })}
      ${statCard({ label: tx('جلسات جرد مفتوحة', 'Open counts'), value: fmtNum(stats.sessionsOpen), note: tx('اليوم', 'today'), icon: 'fa-solid fa-clipboard-check', tone: 'green', href: 'stocktake' })}
    </div>

    <div class="o_grid" style="grid-template-columns:1.25fr 1fr;margin-top:16px">
      ${card(`<i class="fa-solid fa-clock-rotate-left"></i> ${tx('أحدث الحركات', 'Recent movements')}`,
        table(
          [{ label: tx('التاريخ', 'Date') }, { label: tx('الصنف', 'Item') }, { label: tx('التغير', 'Change'), num: true }, { label: tx('الرصيد', 'Balance'), num: true }, { label: tx('المستودع', 'Warehouse') }],
          recent,
          { emptyTitle: tx('لا توجد حركات بعد', 'No movements yet') }
        ), `<a onclick="showPage('reports')" class="o_muted">${tx('كل الحركات', 'All movements')} →</a>`, 'flush-body')}
      ${card(`<i class="fa-solid fa-circle-check"></i> ${tx('بانتظار الاعتماد', 'Awaiting approval')}`,
        table(
          [{ label: tx('المرجع', 'Reference') }, { label: tx('النوع', 'Type') }, { label: tx('الكمية', 'Qty'), num: true }, { label: tx('الحالة', 'Status') }, { label: tx('إجراءات', 'Actions') }],
          pending,
          { emptyTitle: tx('لا توجد معاملات معلّقة', 'Nothing pending') }
        ), `<a onclick="showPage('transactions')" class="o_muted">${tx('عرض الكل', 'View all')} →</a>`, 'flush-body')}
    </div>

    <div class="o_grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      ${card(`<i class="fa-solid fa-warehouse"></i> ${tx('ملخص المستودعات', 'Warehouse summary')}`,
        table(
          [{ label: tx('المستودع', 'Warehouse') }, { label: tx('أصناف', 'Items'), num: true }, { label: tx('أرفف', 'Shelves'), num: true }, { label: tx('الكمية', 'Qty'), num: true }],
          ws.map(({ w, items, shelves, qty }) => ({
            cells: [
              `<span class="o_cell_main">${w.name}</span><div class="o_cell_sub">${w.code}</div>`,
              fmtNum(items), fmtNum(shelves), `<b>${fmtNum(qty)}</b>`
            ]
          })),
          { emptyTitle: tx('لا توجد مستودعات', 'No warehouses') }
        ), `<a onclick="showPage('facilities')" class="o_muted">${tx('إدارة المواقع', 'Manage locations')} →</a>`, 'flush-body')}
      ${card(`<i class="fa-solid fa-triangle-exclamation"></i> ${tx('تنبيهات المخزون', 'Stock alerts')}`,
        low.length
          ? table(
              [{ label: tx('الصنف', 'Item') }, { label: tx('المتاح', 'On hand'), num: true }, { label: tx('حد الأمان', 'Safety'), num: true }, { label: '', width: '90px' }],
              low.map(({ i, qty }) => ({
                cells: [
                  `<span class="o_cell_main">${itemNameOnly(i)}</span><div class="o_cell_sub">${i.code}</div>`,
                  `<span class="${qty <= 0 ? 'o_neg' : ''}">${fmtNum(qty)}</span>`,
                  fmtNum(i.safety_stock),
                  `<div class="o_mini_bar"><span style="width:${Math.min(100, Number(i.safety_stock) ? (qty / Number(i.safety_stock)) * 100 : 0)}%;background:${qty <= 0 ? '#a61b1b' : '#c98a3d'}"></span></div>`
                ]
              }))
            )
          : empty(tx('كل الأصناف فوق حد الأمان', 'All items above safety stock'), '', 'fa-regular fa-circle-check'),
        `<a onclick="showPage('inventory')" class="o_muted">${tx('كل الأصناف', 'All items')} →</a>`, 'flush-body')}
    </div>

    <div class="o_grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      ${card(`<i class="fa-solid fa-calendar-xmark"></i> ${tx('تنبيهات الصلاحية', 'Expiry alerts')}`,
        exp.length
          ? table(
              [{ label: tx('الصنف', 'Item') }, { label: tx('التشغيلة', 'Batch') }, { label: tx('الصلاحية', 'Expiry') }, { label: tx('متبقي', 'Left') }],
              exp.map(({ s, days }) => ({
                cls: days < 0 ? 'rt-danger' : days < 30 ? 'rt-warn' : '',
                cells: [
                  `<span class="o_cell_main">${itemNameOnly(s.item_id)}</span>`,
                  s.batch_no || '—',
                  s.expiry_date,
                  `<span class="o_badge o_badge_${days < 0 ? 'red' : days < 30 ? 'orange' : 'gray'}">${days < 0 ? tx('منتهي', 'Expired') : `${days} ${tx('يوم', 'days')}`}</span>`
                ]
              }))
            )
          : empty(tx('لا توجد صلاحيات قريبة', 'No upcoming expiries'), '', 'fa-regular fa-calendar-check'),
        '', 'flush-body')}
      ${card(`<i class="fa-solid fa-bolt"></i> ${tx('إجراءات سريعة', 'Quick actions')}`,
        `<div class="o_quick_actions">
          <a class="o_quick o_quick_scan" onclick="OW.wms.quickScan()">
            <span class="o_quick_icon" style="background:#714B67;color:#fff"><i class="fa-solid fa-qrcode"></i></span>
            <span>${tx('مسح QR', 'Scan QR')}</span></a>
          ${quick('GRN', 'fa-arrow-down-to-line', tx('توريد بضاعة', 'Goods receipt'), '#0b6b3a')}
          ${quick('ISSUE', 'fa-arrow-up-from-line', tx('صرف مخزون', 'Issue stock'), '#714B67')}
          ${quick('ADJUSTMENT_IN', 'fa-plus', tx('تسوية زيادة', 'Adjustment +'), '#5B899E')}
          ${quick('ADJUSTMENT_OUT', 'fa-minus', tx('تسوية نقص', 'Adjustment −'), '#a24689')}
          <a class="o_quick" onclick="showPage('transfers')"><span class="o_quick_icon" style="background:#ede5eb;color:#714B67"><i class="fa-solid fa-truck-arrow-right"></i></span><span>${tx('تحويل مخزني', 'Stock transfer')}</span></a>
          <a class="o_quick" onclick="showPage('stocktake')"><span class="o_quick_icon" style="background:#e8f0f3;color:#4b7587"><i class="fa-solid fa-clipboard-check"></i></span><span>${tx('بدء جرد', 'Start a count')}</span></a>
        </div>`)}
    </div>
  </div>`;
}

function quick(type, icon, label, color) {
  return `<a class="o_quick" onclick="OW.wms.newTx('${type}')">
    <span class="o_quick_icon" style="background:${color}18;color:${color}"><i class="fa-solid ${icon}"></i></span>
    <span>${label}</span></a>`;
}

async function mount(_, main) {
  main.querySelectorAll('[data-approve]').forEach(b => {
    b.onclick = async () => {
      if (!await confirmDialog({
        title: tx('اعتماد المعاملة', 'Approve transaction'),
        message: tx('سيتم ترحيل الكميات إلى المخزون. هل تريد المتابعة؟',
          'Stock balances will be posted. Continue?'),
        confirmText: tx('اعتماد', 'Approve')
      })) return;
      b.disabled = true;
      try {
        await approveTransaction(b.dataset.approve);
        toast(tx('تم اعتماد المعاملة', 'Transaction approved'), 'success');
        OW.wms.refreshDashboard();
      } catch (e) {
        toast(String(e.message || e), 'error');
        b.disabled = false;
      }
    };
  });
  main.querySelectorAll('[data-view]').forEach(b => {
    b.onclick = () => OW.wms.openTransaction(b.dataset.view);
  });
}

OW.wms = OW.wms || {};
OW.wms.refreshDashboard = async () => {
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  const { showPage } = await import('./core-router.js');
  showPage('dashboard');
};

OW.registerPage('dashboard', {
  brand: { name: 'OW', icon: 'fa-solid fa-gauge-high' },
  menu: [
    { label: tx('نظرة عامة', 'Overview'), page: 'dashboard' },
    { label: tx('المخزون', 'Inventory'), page: 'inventory' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' },
    { label: tx('التقارير', 'Reports'), page: 'reports' },
    { label: tx('المزامنة', 'Synchronization'), page: 'sync' }
  ],
  render: renderDashboard,
  mount
});

export default OW.pages.dashboard;
