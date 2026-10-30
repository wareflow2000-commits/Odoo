// ============================================================================
// OW — Stocktake (cycle / full / surprise counts + settlement)
// ----------------------------------------------------------------------------
// Workflow (enforced by the database):
//   IN_PROGRESS + DRAFT      → counting
//   IN_PROGRESS + PENDING    → submitted for review
//   IN_PROGRESS + APPROVED   → settle lines (INCREASE / DECREASE)
//   IN_PROGRESS + APPROVED   → close once every line is settled
//   COMPLETED                → read only
// The creator/submitter may never approve their own session.
// ============================================================================
import { OW } from './core-registry.js';
import { tx, friendlyError } from './core-i18n.js';
import {
  pageHead, card, statCard, table, empty, statusBadge, statusbar, btn, alertBox,
  controlPanel, input, select, textarea, tabs, downloadCSV, printHTML
} from './core-ui.js';
import {
  store, pullAll, createStocktakeSession, saveStocktakeCount, submitStocktake,
  reviewStocktake, settleStocktake, closeStocktake,
  warehouseName, areaName, itemNameOnly, shelfPath, warehouseOptions, areaOptions,
  unitOptions, profileName, hasAnyEffectiveCachedGrant
} from './core-store.js';
import { canDatabasePermission } from './core-rbac.js';
import {
  fmtDateTime, fmtNum, statusLabel, todayISO, stocktakeTypeLabel, countModeLabel
} from './core-utils.js';
import { toast } from './core-toast.js';
import { modal, confirmDialog } from './core-modal.js';
import { openQrScanner } from './qr-scanner.js';

/* ── permissions ─────────────────────────────────────────────────────────── */

const sessionContext = (session, line = null) => session ? ({
  resource_type: 'stocktake_session',
  resource_id: session.id,
  warehouse_id: session.warehouse_id,
  owner_id: session.created_by,
  submitted_by: session.submitted_by || null,
  status: session.status,
  review_status: reviewOf(session),
  offline: !navigator.onLine || !!window.__session?.offline,
  ...(line ? { line_id: line.id, item_id: line.item_id, shelf_id: line.shelf_id } : {})
}) : {};
const canStart = (warehouseId = null, stocktakeType = null, countMode = null) => warehouseId
  ? canDatabasePermission('action:stocktake:start', {
      resource_type: 'stocktake_session', warehouse_id: warehouseId,
      owner_id: window.__session?.id, stocktake_type: stocktakeType, count_mode: countMode
    })
  : hasAnyEffectiveCachedGrant('action:stocktake:start');
const canCount = (session = null, line = null) => {
  if (!session) return hasAnyEffectiveCachedGrant('action:stocktake:count')
    || hasAnyEffectiveCachedGrant('action:stocktake:manage');
  const context = sessionContext(session, line);
  return canDatabasePermission('action:stocktake:count', context)
    || canDatabasePermission('action:stocktake:manage', context);
};
const canSubmit = session => session
  ? canDatabasePermission('action:stocktake:submit', sessionContext(session))
    || canDatabasePermission('action:stocktake:start', sessionContext(session))
  : hasAnyEffectiveCachedGrant('action:stocktake:submit') || hasAnyEffectiveCachedGrant('action:stocktake:start');
const canApprove = session => session
  ? canDatabasePermission('action:stocktake:approve', sessionContext(session))
  : hasAnyEffectiveCachedGrant('action:stocktake:approve');
const canSettle = session => session
  ? canDatabasePermission('action:stocktake:settle', sessionContext(session))
  : hasAnyEffectiveCachedGrant('action:stocktake:settle');
const canClose = session => session
  ? canDatabasePermission('action:stocktake:close', sessionContext(session))
  : hasAnyEffectiveCachedGrant('action:stocktake:close');
const showSystemColumn = session => session
  ? canDatabasePermission('action:stocktake:view_system_qty', sessionContext(session))
  : hasAnyEffectiveCachedGrant('action:stocktake:view_system_qty');

const F = { tab: 'active', search: '' };
const TYPES = ['CYCLE', 'FULL', 'SURPRISE', 'RECOUNT'];
const MODES = ['VISIBLE', 'ANNOUNCED', 'BLIND'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

/* ── session helpers ─────────────────────────────────────────────────────── */

const reviewOf = s => String(s.review_status || 'DRAFT').toUpperCase();
const isOpen = s => s.status === 'IN_PROGRESS';
const linesOf = s => store.get('stocktake_lines').filter(l => l.session_id === s.id);

function sessionProgress(s) {
  const lines = linesOf(s);
  const counted = lines.filter(l => l.counted_qty != null).length;
  const settled = lines.filter(l => l.is_settled).length;
  const varianceLines = lines.filter(l => l.variance != null && Number(l.variance) !== 0);
  const variance = varianceLines.reduce((n, l) => n + Math.abs(Number(l.variance)), 0);
  return {
    lines, total: lines.length, counted, settled, varianceLines: varianceLines.length,
    variance, pct: lines.length ? Math.round((counted / lines.length) * 100) : 0,
    settledPct: lines.length ? Math.round((settled / lines.length) * 100) : 0
  };
}

function bucket(s) {
  if (s.status === 'COMPLETED') return 'completed';
  const r = reviewOf(s);
  if (r === 'PENDING_REVIEW') return 'review';
  if (r === 'APPROVED') return 'settle';
  return 'active';
}

const TABS = [
  { value: 'active', label: () => tx('جلسات جارية', 'In progress') },
  { value: 'review', label: () => tx('بانتظار المراجعة', 'Pending review') },
  { value: 'settle', label: () => tx('جاهزة للتسوية', 'Ready to settle') },
  { value: 'completed', label: () => tx('مكتملة', 'Completed') },
  { value: 'all', label: () => tx('الكل', 'All') }
];

function filtered() {
  let list = [...store.get('stocktake_sessions')];
  if (F.tab !== 'all') list = list.filter(s => bucket(s) === F.tab);
  if (F.search) {
    const q = F.search.toLowerCase();
    list = list.filter(s => [
      s.id, warehouseName(s.warehouse_id), areaName(s.storage_area_id),
      stocktakeTypeLabel(s.stocktake_type), countModeLabel(s.count_mode),
      statusLabel(s.status), statusLabel(reviewOf(s))
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function tabCount(v) {
  const all = store.get('stocktake_sessions');
  return v === 'all' ? all.length : all.filter(s => bucket(s) === v).length;
}

/* ── render ──────────────────────────────────────────────────────────────── */

function render() {
  const sessions = filtered();
  const all = store.get('stocktake_sessions');
  const lines = store.get('stocktake_lines');
  const openCount = all.filter(s => isOpen(s) && bucket(s) === 'active').length;
  const reviewCount = all.filter(s => bucket(s) === 'review').length;
  const settleCount = all.filter(s => bucket(s) === 'settle').length;

  return `
  ${pageHead(tx('الجرد', 'Stocktake'),
    tx('جرد دوري وكامل ومفاجئ مع مراجعة وتسوية فروقات', 'Cycle, full and surprise counts with review and variance settlement'),
    `${canStart() ? btn(`<i class="fa-solid fa-plus"></i> ${tx('بدء جرد', 'Start a count')}`, `onclick="OW.wms.newStocktake()"`, 'primary') : ''}
     ${canCount() ? btn(`<i class="fa-solid fa-qrcode"></i> ${tx('مسح QR', 'Scan QR')}`, `onclick="OW.wms.stocktakeScan()"`, 'secondary') : ''}
     ${btn(`<i class="fa-solid fa-file-csv"></i> ${tx('تصدير', 'Export')}`, `onclick="OW.wms.exportStocktake()"`, 'secondary')}
     ${btn('', 'onclick="OW.wms.reloadStocktake()"', 'ghost', 'fa-solid fa-rotate')} `)}
  ${controlPanel({
    breadcrumb: [{ label: tx('العمليات', 'Operations') }, { label: tx('الجرد', 'Stocktake') }],
    searchPlaceholder: tx('ابحث بالمستودع أو النوع أو الحالة…', 'Search warehouse, type or status…')
  })}
  <div class="o_page_body">
    <div class="o_grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      ${statCard({ label: tx('جلسات الجرد', 'Sessions'), value: fmtNum(all.length), icon: 'fa-solid fa-clipboard-list', tone: 'purple' })}
      ${statCard({ label: tx('قيد العد', 'Counting'), value: fmtNum(openCount), note: tx('بانتظار الإدخال', 'awaiting counts'), icon: 'fa-solid fa-pen-to-square', tone: 'blue' })}
      ${statCard({ label: tx('بانتظار المراجعة', 'Pending review'), value: fmtNum(reviewCount), icon: 'fa-solid fa-user-check', tone: 'amber' })}
      ${statCard({ label: tx('جاهزة للتسوية', 'Ready to settle'), value: fmtNum(settleCount), note: tx('معتمدة', 'approved'), icon: 'fa-solid fa-scale-balanced', tone: 'green' })}
    </div>
    ${tabs(TABS.map(t => ({ value: t.value, label: t.label(), count: tabCount(t.value), onclick: `OW.wms.stocktakeTab('${t.value}')` })), F.tab)}
    <div class="o_list_summary">
      <span>${fmtNum(sessions.length)} ${tx('جلسة', 'sessions')}</span>
      <span>${tx('إجمالي الأسطر', 'Total lines')}: <b>${fmtNum(lines.length)}</b></span>
    </div>
    ${card('', table(
      [{ label: tx('الجلسة', 'Session') }, { label: tx('المستودع / المنطقة', 'Warehouse / area') },
       { label: tx('النوع', 'Type') }, { label: tx('الوضع', 'Mode') }, { label: tx('التقدم', 'Progress') },
       { label: tx('الفروقات', 'Variances') }, { label: tx('الحالة', 'Status') }, { label: tx('إجراءات', 'Actions') }],
      sessions.map(s => {
        const p = sessionProgress(s);
        const r = reviewOf(s);
        return {
          cells: [
            `<span class="o_cell_main">#${String(s.id).slice(0, 8)}</span><div class="o_cell_sub">${fmtDateTime(s.created_at)}</div>`,
            `<span class="o_cell_main">${warehouseName(s.warehouse_id)}</span><div class="o_cell_sub">${s.storage_area_id ? areaName(s.storage_area_id) : tx('كامل المستودع', 'Whole warehouse')}</div>`,
            stocktakeTypeLabel(s.stocktake_type),
            countModeLabel(s.count_mode),
            `<div class="o_progress"><div class="o_mini_bar"><span style="width:${p.pct}%"></span></div><small>${fmtNum(p.counted)} / ${fmtNum(p.total)}</small></div>`,
            p.varianceLines
              ? `<span class="o_badge o_badge_orange">${fmtNum(p.varianceLines)}</span> <span class="o_muted">(${fmtNum(p.variance)})</span>`
              : '<span class="o_muted">—</span>',
            `<div class="o_status_stack">${statusBadge(s.status, statusLabel(s.status))}${statusBadge(r, statusLabel(r))}</div>`,
            `<div class="o_actions_cell">
              <button class="o_btn o_btn_ghost o_btn_sm" data-open="${s.id}" title="${tx('فتح', 'Open')}"><i class="fa-solid fa-eye"></i></button>
              ${isOpen(s) && r !== 'PENDING_REVIEW' && canSubmit(s)
                ? `<button class="o_btn o_btn_primary o_btn_sm" data-submit="${s.id}">${tx('إرسال', 'Submit')}</button>` : ''}
            </div>`
          ]
        };
      }),
      { emptyTitle: tx('لا توجد جلسات جرد في هذه الحالة', 'No stocktake sessions in this state'),
        emptyNote: tx('ابدأ جردًا جديدًا لعدّ الأرصدة وتسوية الفروقات.', 'Start a new count to verify balances and settle variances.') }
    ), '', 'flush-body')}
  </div>`;
}

/* ── mount ───────────────────────────────────────────────────────────────── */

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('stocktake'));
}

function bind(_, main) {
  const search = main.querySelector('#oSearchInput');
  if (search) {
    search.value = F.search;
    search.addEventListener('input', () => { F.search = search.value; reload(); });
  }
  main.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openSession(b.dataset.open));
  main.querySelectorAll('[data-submit]').forEach(b => b.onclick = () => doSubmit(b.dataset.submit));
}

async function doSubmit(id) {
  if (!await confirmDialog({
    title: tx('إرسال الجرد للمراجعة', 'Submit stocktake for review'),
    message: tx('يجب عدّ جميع الأسطر قبل الإرسال. لن تتمكن من التعديل بعد الإرسال.',
      'Every line must be counted before submission. Counts are locked afterwards.'),
    confirmText: tx('إرسال', 'Submit')
  })) return;
  try {
    await submitStocktake(id);
    toast(tx('تم إرسال الجرد للمراجعة', 'Stocktake submitted for review'), 'success');
    reload();
  } catch (e) { toast(String(e.message || e), 'error'); }
}

/* ── new session ─────────────────────────────────────────────────────────── */

function openNew() {
  const warehouses = warehouseOptions();
  if (!warehouses.length) { toast(tx('أضف مستودعًا أولًا', 'Add a warehouse first'), 'warning'); return; }

  const body = `<form id="stForm" class="o_form_grid">
      ${select({ name: 'warehouse_id', label: tx('المستودع', 'Warehouse'), options: warehouses, value: warehouses[0].value, required: true })}
      ${select({ name: 'storage_area_id', label: tx('منطقة التخزين', 'Storage area'), options: [], placeholder: tx('كامل المستودع', 'Whole warehouse') })}
      ${select({ name: 'stocktake_type', label: tx('نوع الجرد', 'Count type'), options: TYPES.map(t => ({ value: t, label: stocktakeTypeLabel(t) })), value: 'CYCLE', required: true })}
      ${select({ name: 'count_mode', label: tx('وضع العد', 'Count mode'), options: MODES.map(m => ({ value: m, label: countModeLabel(m) })), value: 'VISIBLE', required: true })}
      ${textarea({ name: 'notes', label: tx('ملاحظات', 'Notes'), rows: 2 })}
    </form>
    ${alertBox(tx('وضع العد الأعمى يخفي الرصيد الدفتري حتى الإرسال. إعادة الجرد تُنشئ جلسة جديدة على نفس النطاق.',
      'Blind mode hides the book balance until submission. Recount creates a new session over the same scope.'), 'info')}
    ${alertBox(tx('لا يمكن لمن أنشأ الجلسة أو أرسلها اعتمادها — يلزم مستخدم آخر.',
      'The creator or submitter cannot approve their own session — a different user is required.'), 'warning')}`;

  modal({
    title: `<i class="fa-solid fa-clipboard-check"></i> ${tx('بدء جلسة جرد', 'Start a stocktake')}`,
    size: 'md', body,
    footer: `<button class="o_btn o_btn_secondary" id="stCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="stSave">${tx('بدء الجرد', 'Start count')}</button>`,
    onMount: (el, close) => {
      const wh = el.querySelector('[name="warehouse_id"]');
      const area = el.querySelector('[name="storage_area_id"]');
      const fill = () => {
        const opts = areaOptions(wh.value);
        area.innerHTML = `<option value="">${tx('كامل المستودع', 'Whole warehouse')}</option>` +
          opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
      };
      wh.onchange = fill; fill();
      el.querySelector('#stCancel').onclick = close;
      el.querySelector('#stSave').onclick = async () => {
        const d = Object.fromEntries(new FormData(el.querySelector('#stForm')).entries());
        try {
          if (!canStart(d.warehouse_id, d.stocktake_type, d.count_mode)) {
          toast(tx('لا تملك تفويض بدء الجرد في هذا المستودع.', 'You do not have a stocktake-start grant for this warehouse.'), 'error');
          return;
        }
        const res = await createStocktakeSession({
            warehouseId: d.warehouse_id,
            storageAreaId: d.storage_area_id || null,
            type: d.stocktake_type,
            mode: d.count_mode,
            notes: d.notes || null
          });
          const id = res?.session_id || res?.sessionId || res?.id;
          close();
          toast(tx(`تم بدء الجرد (${res?.line_count ?? '—'} سطر)`, `Stocktake started (${res?.line_count ?? '—'} lines)`), 'success');
          if (id) openSession(id); else reload();
        } catch (e) { toast(String(e.message || e), 'error'); }
      };
    }
  });
}

/* ── session detail ──────────────────────────────────────────────────────── */

function statusSteps(s) {
  const r = reviewOf(s);
  const p = sessionProgress(s);
  const allSettled = p.total > 0 && p.settled === p.total;
  let current = 'DRAFT';
  if (s.status === 'COMPLETED') current = 'CLOSED';
  else if (allSettled) current = 'SETTLED';
  else if (r === 'APPROVED') current = 'APPROVED';
  else if (r === 'PENDING_REVIEW') current = 'PENDING_REVIEW';
  else if (r === 'REJECTED') current = 'DRAFT';
  return statusbar([
    { value: 'DRAFT', label: tx('مسودة', 'Draft') },
    { value: 'PENDING_REVIEW', label: tx('بانتظار المراجعة', 'Review') },
    { value: 'APPROVED', label: tx('معتمد', 'Approved') },
    { value: 'SETTLED', label: tx('مسوّى', 'Settled') },
    { value: 'CLOSED', label: tx('مغلق', 'Closed') }
  ], current);
}

function openSession(id) {
  const s = store.byId('stocktake_sessions', id);
  if (!s) { toast(tx('الجلسة غير موجودة', 'Session not found'), 'error'); return; }
  const p = sessionProgress(s);
  const r = reviewOf(s);
  const showSystem = showSystemColumn(s) && !(String(s.count_mode).toUpperCase() === 'BLIND' && ['DRAFT', 'REJECTED'].includes(r));
  const editable = isOpen(s) && ['DRAFT', 'REJECTED'].includes(r) && canCount(s);
  const currentUser = window.__session?.id;
  const ownSession = currentUser && (s.created_by === currentUser || s.submitted_by === currentUser);

  const linesHtml = table(
    [{ label: '#', width: '44px' }, { label: tx('الصنف', 'Item') }, { label: tx('الرف', 'Shelf') },
     { label: tx('التشغيلة', 'Batch') },
     ...(showSystem ? [{ label: tx('الدفتري', 'System'), num: true }] : []),
     { label: tx('العد الفعلي', 'Counted'), num: true },
     ...(showSystem ? [{ label: tx('الفرق', 'Variance'), num: true }] : []),
     { label: tx('الحالة', 'Status') }, { label: tx('ملاحظة', 'Comment') }],
    p.lines.map((l, i) => {
      const item = store.byId('items', l.item_id);
      const baseUnit = item?.base_unit || l.base_unit || '';
      const altSnapshot = l.entered_unit && l.entered_unit !== baseUnit && l.counted_qty != null
        ? `<div class="o_cell_sub o_count_alt">${fmtNum(l.entered_quantity)} ${esc(l.entered_unit)} × ${fmtNum(l.conversion_factor)}</div>`
        : '<div class="o_cell_sub o_count_alt"></div>';
      const baseSnapshot = `<div class="o_cell_sub o_count_base">${esc(baseUnit)}</div>`;
      return {
        cls: l.is_settled ? 'rt-done' : '',
        cells: [
          i + 1,
          `<span class="o_cell_main">${itemNameOnly(l.item_id)}</span><div class="o_cell_sub">${item?.code || ''}</div>`,
          shelfPath(l.shelf_id),
          l.batch_no || '—',
          ...(showSystem ? [l.system_qty == null ? '—' : fmtNum(l.system_qty)] : []),
          editable && !l.is_settled
            ? `<input class="o_form_input o_count_input" type="number" min="0" step="any" data-count="${l.id}" value="${l.counted_qty ?? ''}" placeholder="—">${baseSnapshot}${altSnapshot}`
            : (l.counted_qty == null ? '—' : `${fmtNum(l.counted_qty)}${baseSnapshot}${altSnapshot}`),
          ...(showSystem ? [`<span class="o_var_cell ${Number(l.variance) > 0 ? 'o_pos' : Number(l.variance) < 0 ? 'o_neg' : 'o_muted'}">${l.variance == null ? '—' : (Number(l.variance) > 0 ? '+' : '') + fmtNum(l.variance)}</span>`] : []),
          l.is_settled
            ? `<span class="o_badge o_badge_green">${tx('مسوّى', 'Settled')}</span>`
            : l.counted_qty == null
              ? `<span class="o_badge o_badge_gray">${tx('لم يُعد', 'Not counted')}</span>`
              : `<span class="o_badge o_badge_blue">${tx('معدود', 'Counted')}</span>`,
          l.settlement_comment || '—'
        ]
      };
    }),
    { emptyTitle: tx('لا توجد أسطر في هذه الجلسة', 'This session has no lines') }
  );

  const unsettled = p.lines.filter(l => !l.is_settled && l.counted_qty != null);
  const allSettled = p.total > 0 && p.settled === p.total;
  const canSettleNow = isOpen(s) && r === 'APPROVED' && canSettle(s) && unsettled.length > 0;
  const canCloseNow = isOpen(s) && r === 'APPROVED' && allSettled && canClose(s);

  const body = `
    <div class="o_tx_head"><div>
      <div class="o_tx_ref">#${String(s.id).slice(0, 8)}</div>
      <div class="o_muted">${fmtDateTime(s.created_at)} • ${s._creator?.name || s._creator?.email || '—'}</div>
    </div><div class="o_status_stack">${statusBadge(s.status, statusLabel(s.status))}${statusBadge(r, statusLabel(r))}</div></div>
    ${statusSteps(s)}
    <div class="o_detail_grid">
      <div><small>${tx('المستودع', 'Warehouse')}</small><b>${warehouseName(s.warehouse_id)}</b></div>
      <div><small>${tx('المنطقة', 'Area')}</small><b>${s.storage_area_id ? areaName(s.storage_area_id) : tx('كامل المستودع', 'Whole warehouse')}</b></div>
      <div><small>${tx('نوع الجرد', 'Count type')}</small><b>${stocktakeTypeLabel(s.stocktake_type)}</b></div>
      <div><small>${tx('وضع العد', 'Mode')}</small><b>${countModeLabel(s.count_mode)}</b></div>
      <div data-stk-lines-progress><small>${tx('الأسطر', 'Lines')}</small><b>${fmtNum(p.counted)} / ${fmtNum(p.total)} ${tx('معدود', 'counted')}</b></div>
      <div><small>${tx('الفروقات', 'Variances')}</small><b>${fmtNum(p.varianceLines)} (${fmtNum(p.variance)})</b></div>
      <div><small>${tx('مسوّى', 'Settled')}</small><b>${fmtNum(p.settled)} / ${fmtNum(p.total)}</b></div>
      <div><small>${tx('المراجع', 'Reviewer')}</small><b>${s.reviewed_by ? profileName(s.reviewed_by) : '—'}</b></div>
    </div>
    <div class="o_progress" style="margin:12px 0"><div class="o_mini_bar"><span style="width:${p.pct}%"></span></div><small>${p.pct}%</small></div>
    ${s.notes ? `<div class="o_callout" style="margin-bottom:12px">${s.notes}</div>` : ''}
    ${s.review_comment ? alertBox(`<b>${tx('ملاحظة المراجعة', 'Review comment')}:</b> ${s.review_comment}`,
      r === 'REJECTED' ? 'danger' : 'info') : ''}
    ${r === 'REJECTED' ? alertBox(tx('أُعيد الجرد — عدّل الكميات ثم أرسله مرة أخرى.',
      'The count was rejected — adjust quantities and submit again.'), 'warning') : ''}
    ${editable ? alertBox(tx('تُحفظ الكميات تلقائيًا عند مغادرة الحقل. أرسل الجرد عند اكتمال جميع الأسطر.',
      'Counts save automatically when you leave a field. Submit once every line is counted.'), 'info') : ''}
    <div class="o_section_label">${tx('أسطر الجرد', 'Count lines')}</div>
    ${linesHtml}`;

  const footer = `
    <button class="o_btn o_btn_secondary" id="stkPrint"><i class="fa-solid fa-print"></i> ${tx('طباعة', 'Print')}</button>
    ${editable ? `<button class="o_btn o_btn_secondary" id="stkScan"><i class="fa-solid fa-qrcode"></i> ${tx('مسح رف', 'Scan shelf')}</button>` : ''}
    ${isOpen(s) && ['DRAFT', 'REJECTED'].includes(r) && canSubmit(s)
      ? `<button class="o_btn o_btn_primary" id="stkSubmit">${tx('إرسال للمراجعة', 'Submit for review')}</button>` : ''}
    ${isOpen(s) && r === 'PENDING_REVIEW' && canApprove(s) && !ownSession
      ? `<button class="o_btn o_btn_danger" id="stkReject">${tx('رفض', 'Reject')}</button>
         <button class="o_btn o_btn_success" id="stkApprove">${tx('اعتماد', 'Approve')}</button>` : ''}
    ${canSettleNow ? `<button class="o_btn o_btn_primary" id="stkSettle">${tx('تسوية الفروقات', 'Settle variances')}</button>` : ''}
    ${canCloseNow ? `<button class="o_btn o_btn_success" id="stkClose">${tx('إغلاق الجلسة', 'Close session')}</button>` : ''}
    <button class="o_btn o_btn_secondary" id="stkDone">${tx('إغلاق', 'Close')}</button>`;

  modal({
    title: `<i class="fa-solid fa-clipboard-check"></i> ${tx('جلسة جرد', 'Stocktake session')}`,
    size: 'xl', body, footer,
    onMount: (el, close) => {
      el.querySelector('#stkDone').onclick = close;
      el.querySelector('#stkPrint').onclick = () => printSession(s, p, showSystem);
      const scanBtn = el.querySelector('#stkScan');
      if (scanBtn) scanBtn.onclick = () => scanStocktake(s.id, (lineId, qty, line) => {
        updateSessionCount(el, p, lineId, qty, line);
      });

      const submitBtn = el.querySelector('#stkSubmit');
      if (submitBtn) submitBtn.onclick = async () => {
        const uncounted = p.lines.filter(l => l.counted_qty == null).length;
        if (uncounted) { toast(tx(`ما زال ${uncounted} سطرًا بدون عد`, `${uncounted} line(s) still uncounted`), 'warning'); return; }
        close(); await doSubmit(s.id);
      };

      const rejectBtn = el.querySelector('#stkReject');
      if (rejectBtn) rejectBtn.onclick = () => review(s, false, close);
      const approveBtn = el.querySelector('#stkApprove');
      if (approveBtn) approveBtn.onclick = () => review(s, true, close);

      const settleBtn = el.querySelector('#stkSettle');
      if (settleBtn) settleBtn.onclick = () => { close(); openSettlement(s); };

      const closeBtn = el.querySelector('#stkClose');
      if (closeBtn) closeBtn.onclick = async () => {
        if (!await confirmDialog({
          title: tx('إغلاق جلسة الجرد', 'Close stocktake session'),
          message: tx('سيتم إغلاق الجلسة نهائيًا بعد تسوية كل الأسطر. هل تريد المتابعة؟',
            'The session will be closed permanently after all lines are settled. Continue?'),
          confirmText: tx('إغلاق', 'Close')
        })) return;
        try {
          await closeStocktake(s.id);
          close();
          toast(tx('تم إغلاق جلسة الجرد', 'Stocktake session closed'), 'success');
          reload();
        } catch (e) { toast(String(e.message || e), 'error'); }
      };

      if (editable) bindCountInputs(el, p.lines);
    }
  });
}

/* ── camera / QR counting ────────────────────────────────────────────────── */

function latestScannableSession() {
  return [...store.get('stocktake_sessions')]
    .filter(s => s.status === 'IN_PROGRESS' && ['DRAFT', 'REJECTED'].includes(reviewOf(s)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

function scanStocktake(sessionId, onSaved) {
  const session = sessionId ? store.byId('stocktake_sessions', sessionId) : latestScannableSession();
  if (!canCount(session)) {
    toast(tx('لا تملك صلاحية عدّ الجرد في نطاق هذه الجلسة.', 'You do not have count permission within this stocktake session scope.'), 'error');
    return;
  }
  if (!session) {
    toast(tx('افتح جلسة جرد نشطة أولاً ثم امسح رمز الرف.',
      'Open an active stocktake session first, then scan a shelf QR.'), 'warning');
    return;
  }
  if (session.status !== 'IN_PROGRESS' || !['DRAFT', 'REJECTED'].includes(reviewOf(session))) {
    toast(tx('هذه الجلسة غير قابلة للعد حالياً.', 'This session is not editable right now.'), 'warning');
    return;
  }
  openQrScanner({
    mode: 'stocktake',
    sessionId: session.id,
    onResolved: resolution => openScanCount(resolution.session, resolution.lines, {
      onSaved: onSaved || (() => reload())
    })
  });
}

function openScanCount(session, scannedLines, { onSaved } = {}) {
  const lines = (scannedLines || []).filter(line => !line.is_settled);
  if (!lines.length) {
    toast(tx('كل أسطر هذا الموقع مسوّاة بالفعل.', 'Every line at this location is already settled.'), 'info');
    return;
  }

  const canSeeSystem = showSystemColumn(store.byId('stocktake_sessions', lines[0]?.session_id));
  const firstUncounted = lines.find(line => line.counted_qty == null) || lines[0];
  const lineOption = line => {
    const item = store.byId('items', line.item_id) || {};
    const base = `${item.code || ''} — ${itemNameOnly(line.item_id)}`.trim();
    return {
      value: line.id,
      label: canSeeSystem && line.system_qty != null
        ? `${base} (${tx('النظام', 'System')}: ${fmtNum(line.system_qty)} ${item.base_unit || ''})`
        : base
    };
  };
  const systemText = line => {
    if (!canSeeSystem || line?.system_qty == null) return '';
    const item = store.byId('items', line.item_id);
    return `<div class="o_callout" data-scan-system>${tx('كمية النظام', 'System quantity')}: <b>${fmtNum(line.system_qty)} ${esc(item?.base_unit || '')}</b> · ${tx('التشغيلة', 'Batch')}: <b>${esc(line.batch_no || '—')}</b></div>`;
  };
  const selectedUnit = line => {
    const units = unitOptions(line.item_id);
    return units.some(u => u.value === line.entered_unit)
      ? line.entered_unit
      : (units[0]?.value || '');
  };
  const firstShelf = lines.find(line => line.shelf_id)?.shelf_id || '';

  const body = `
    <div class="o_detail_grid">
      <div><small>${tx('الجلسة', 'Session')}</small><b>#${esc(String(session.id).slice(0, 8))}</b></div>
      <div><small>${tx('المستودع', 'Warehouse')}</small><b>${esc(warehouseName(session.warehouse_id))}</b></div>
      <div><small>${tx('الموقع', 'Location')}</small><b>${esc(firstShelf ? shelfPath(firstShelf) : '—')}</b></div>
      <div><small>${tx('الأسطر', 'Lines')}</small><b>${fmtNum(lines.length)}</b></div>
    </div>
    <div class="o_form_grid" style="margin-top:12px">
      ${lines.length > 1 ? select({
        name: 'scanLine',
        label: tx('الصنف على الموقع', 'Item at this location'),
        options: lines.map(lineOption),
        value: firstUncounted.id,
        required: true
      }) : ''}
      <div class="o_field">
        <label>${tx('الكمية الفعلية', 'Actual quantity')} <span class="req">*</span></label>
        <input class="o_form_input" id="stkScanQty" type="number" min="0" step="any" inputmode="decimal" value="${esc(firstUncounted.entered_quantity ?? firstUncounted.counted_qty ?? '')}" placeholder="0">
      </div>
      <div class="o_field">
        <label>${tx('وحدة العد', 'Count unit')} <span class="req">*</span></label>
        <select class="o_form_input" id="stkScanUnit"></select>
        <small class="o_hint" id="stkScanFactor"></small>
      </div>
    </div>
    <div data-scan-system-slot style="margin-top:10px">${systemText(firstUncounted)}</div>
    <div id="stkScanError"></div>
    ${canSeeSystem ? '' : alertBox(tx('وضع العد الأعمى يخفي كمية النظام حتى إرسال الجرد.',
      'Blind count mode hides the system quantity until submission.'), 'info')}`;

  modal({
    title: `<i class="fa-solid fa-qrcode"></i> ${tx('عدّ من رمز QR', 'Count from QR')}`,
    size: 'md',
    body,
    footer: `<button class="o_btn o_btn_secondary" id="stkScanCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="stkScanSave">${tx('حفظ العد', 'Save count')}</button>`,
    onMount: (el, close) => {
      const lineSelect = el.querySelector('[name="scanLine"]');
      const qty = el.querySelector('#stkScanQty');
      const unitSel = el.querySelector('#stkScanUnit');
      const factorHint = el.querySelector('#stkScanFactor');
      const systemSlot = el.querySelector('[data-scan-system-slot]');
      const error = el.querySelector('#stkScanError');
      const save = el.querySelector('#stkScanSave');
      const cancel = el.querySelector('#stkScanCancel');
      let selectedId = firstUncounted.id;

      const currentLine = () => lines.find(line => line.id === selectedId) || firstUncounted;
      const paintFactor = () => {
        const line = currentLine();
        const item = store.byId('items', line.item_id);
        const unit = unitOptions(line.item_id).find(u => u.value === unitSel.value);
        if (!unit || !item) {
          factorHint.textContent = '';
          return;
        }
        factorHint.textContent = unit.value === item.base_unit
          ? tx(`الوحدة الأساسية: ${item.base_unit}`, `Base unit: ${item.base_unit}`)
          : tx(`1 ${unit.value} = ${fmtNum(unit.factor)} ${item.base_unit}`,
            `1 ${unit.value} = ${fmtNum(unit.factor)} ${item.base_unit}`);
      };
      const fillLine = () => {
        const line = currentLine();
        qty.value = line.entered_quantity ?? line.counted_qty ?? '';
        const units = unitOptions(line.item_id);
        unitSel.innerHTML = units.map(u => `<option value="${esc(u.value)}">${esc(u.label)}</option>`).join('');
        unitSel.value = selectedUnit(line);
        paintFactor();
        if (systemSlot) systemSlot.innerHTML = systemText(line);
      };
      unitSel.addEventListener('change', paintFactor);
      if (lineSelect) {
        lineSelect.addEventListener('change', () => {
          selectedId = lineSelect.value;
          fillLine();
          setTimeout(() => qty.focus({ preventScroll: true }), 60);
        });
      }
      fillLine();
      cancel.onclick = close;
      save.onclick = async () => {
        const line = currentLine();
        const raw = qty.value.trim();
        const value = Number(raw);
        if (raw === '' || !Number.isFinite(value) || value < 0) {
          error.innerHTML = alertBox(tx('أدخل كمية صحيحة غير سالبة.', 'Enter a valid non-negative quantity.'), 'danger');
          qty.focus({ preventScroll: true });
          return;
        }
        if (!unitSel.value) {
          error.innerHTML = alertBox(tx('اختر وحدة عد صالحة.', 'Select a valid count unit.'), 'danger');
          return;
        }
        error.innerHTML = '';
        save.disabled = true;
        cancel.disabled = true;
        try {
          const saved = await saveStocktakeCount(line.id, value, unitSel.value);
          line.counted_qty = Number(saved.counted_qty);
          line.entered_quantity = Number(saved.entered_quantity);
          line.entered_unit = saved.entered_unit;
          line.conversion_factor = Number(saved.conversion_factor);
          line.base_unit = saved.base_unit;
          line.variance = Number(saved.counted_qty) - Number(line.system_qty || 0);
          close();
          toast(saved.pending_sync
            ? tx('حُفظ العد محلياً وسيُزامن عند عودة الاتصال.', 'Count saved locally and will sync when connection returns.')
            : (saved.entered_unit === saved.base_unit
              ? tx('تم حفظ العد من رمز QR.', 'Count saved from the QR scan.')
              : tx(`تم حفظ ${fmtNum(saved.entered_quantity)} ${saved.entered_unit} = ${fmtNum(saved.counted_qty)} ${saved.base_unit}.`,
                `Saved ${fmtNum(saved.entered_quantity)} ${saved.entered_unit} = ${fmtNum(saved.counted_qty)} ${saved.base_unit}.`)),
          saved.pending_sync ? 'warning' : 'success');
          onSaved?.(line.id, Number(saved.counted_qty), line);
        } catch (e) {
          error.innerHTML = alertBox(esc(friendlyError(e)), 'danger');
          save.disabled = false;
          cancel.disabled = false;
        }
      };
      setTimeout(() => qty.focus({ preventScroll: true }), 80);
    }
  });
}

function updateSessionCount(root, progress, lineId, qty, savedLine = null) {
  const line = progress.lines.find(item => item.id === lineId);
  if (line) {
    line.counted_qty = qty;
    line.variance = qty - Number(line.system_qty || 0);
    if (savedLine) {
      line.entered_quantity = savedLine.entered_quantity;
      line.entered_unit = savedLine.entered_unit;
      line.conversion_factor = savedLine.conversion_factor;
      line.base_unit = savedLine.base_unit;
    }
  }
  progress.counted = progress.lines.filter(item => item.counted_qty != null).length;
  progress.pct = progress.total ? Math.round((progress.counted / progress.total) * 100) : 0;

  const input = root.querySelector(`[data-count="${lineId}"]`);
  if (input) {
    input.value = qty;
    input.classList.add('saved');
    const row = input.closest('tr');
    const base = row?.querySelector('.o_count_base');
    if (base) base.textContent = line?.base_unit || '';
    const alt = row?.querySelector('.o_count_alt');
    if (alt) {
      alt.textContent = line?.entered_unit && line.entered_unit !== line.base_unit
        ? `${fmtNum(line.entered_quantity)} ${line.entered_unit} × ${fmtNum(line.conversion_factor)}`
        : '';
    }
    const variance = row?.querySelector('.o_var_cell');
    if (variance && line) {
      const delta = Number(line.variance || 0);
      variance.textContent = delta > 0 ? `+${fmtNum(delta)}` : fmtNum(delta);
      variance.className = `o_var_cell ${delta > 0 ? 'o_pos' : delta < 0 ? 'o_neg' : 'o_muted'}`;
    }
    const badge = row?.querySelector('.o_badge');
    if (badge) {
      badge.className = 'o_badge o_badge_blue';
      badge.textContent = tx('معدود', 'Counted');
    }
  }
  const bar = root.querySelector('.o_progress .o_mini_bar span');
  if (bar) bar.style.width = `${progress.pct}%`;
  const progressText = root.querySelector('[data-stk-lines-progress] b');
  if (progressText) {
    progressText.textContent = `${fmtNum(progress.counted)} / ${fmtNum(progress.total)} ${tx('معدود', 'counted')}`;
  }
  const clock = root.querySelector('.o_progress small:last-child');
  if (clock) clock.textContent = `${progress.pct}%`;
}

function bindCountInputs(root, lines) {
  const timers = new Map();
  root.querySelectorAll('[data-count]').forEach(inp => {
    const line = lines.find(l => l.id === inp.dataset.count);
    const commit = async () => {
      const raw = inp.value.trim();
      if (raw === '') return;
      const qty = Number(raw);
      if (!isFinite(qty) || qty < 0) { toast(tx('أدخل كمية صحيحة غير سالبة', 'Enter a valid non-negative quantity'), 'warning'); return; }
      if (line && Number(line.counted_qty) === qty) return;
      inp.disabled = true;
      try {
        const saved = await saveStocktakeCount(inp.dataset.count, qty);
        if (line) {
          line.counted_qty = Number(saved.counted_qty);
          line.entered_quantity = Number(saved.entered_quantity);
          line.entered_unit = saved.entered_unit;
          line.conversion_factor = Number(saved.conversion_factor);
          line.base_unit = saved.base_unit;
          line.variance = Number(saved.counted_qty) - Number(line.system_qty || 0);
        }
        inp.classList.add('saved');
        const varCell = inp.closest('tr')?.querySelector('.o_var_cell');
        if (varCell && line) varCell.textContent = fmtNum(line.variance);
        const alt = inp.closest('tr')?.querySelector('.o_count_alt');
        if (alt) alt.textContent = '';
        toast(saved.pending_sync
          ? tx('حُفظ العد محلياً وسيُزامن عند عودة الاتصال', 'Count saved locally; it will sync when connection returns')
          : tx('تم حفظ العد', 'Count saved'), saved.pending_sync ? 'warning' : 'info', { duration: 2200 });
      } catch (e) { toast(String(e.message || e), 'error'); }
      finally { inp.disabled = false; }
    };
    inp.addEventListener('input', () => {
      clearTimeout(timers.get(inp));
      timers.set(inp, setTimeout(commit, 650));
    });
    inp.addEventListener('blur', () => { clearTimeout(timers.get(inp)); commit(); });
  });
}

async function review(s, approve, close) {
  const note = await new Promise(resolve => {
    let settled = false;
    const done = v => { if (settled) return; settled = true; m.close(); resolve(v); };
    const m = modal({
      title: approve ? tx('اعتماد الجرد', 'Approve stocktake') : tx('رفض الجرد', 'Reject stocktake'),
      size: 'sm',
      body: `<div class="o_callout">${tx('الفروقات', 'Variances')}: <b>${fmtNum(sessionProgress(s).varianceLines)}</b> ·
        ${tx('إجمالي الفرق', 'Total variance')}: <b>${fmtNum(sessionProgress(s).variance)}</b></div>
        <div class="o_field full" style="margin-top:10px"><label>${tx('ملاحظة المراجعة', 'Review comment')}</label>
        <textarea class="o_form_input" id="stkNote" rows="2" placeholder="${tx('اختياري', 'Optional')}"></textarea></div>`,
      footer: `<button class="o_btn o_btn_secondary" id="stkNoteCancel">${tx('إلغاء', 'Cancel')}</button>
               <button class="o_btn ${approve ? 'o_btn_success' : 'o_btn_danger'}" id="stkNoteOk">${approve ? tx('اعتماد', 'Approve') : tx('رفض', 'Reject')}</button>`,
      onMount: (el, cl) => {
        el.querySelector('#stkNoteCancel').onclick = () => done(null);
        el.querySelector('#stkNoteOk').onclick = () => done(el.querySelector('#stkNote').value || '');
      }
    });
  });
  if (note == null) return;
  try {
    await reviewStocktake(s.id, approve, note || null);
    close();
    toast(approve ? tx('تم اعتماد الجرد', 'Stocktake approved') : tx('تم رفض الجرد', 'Stocktake rejected'),
      approve ? 'success' : 'info');
    reload();
  } catch (e) { toast(String(e.message || e), 'error'); }
}

/* ── settlement ──────────────────────────────────────────────────────────── */

function openSettlement(s) {
  const p = sessionProgress(s);
  const unsettled = p.lines.filter(l => !l.is_settled && l.counted_qty != null);
  if (!unsettled.length) { toast(tx('لا توجد أسطر جاهزة للتسوية', 'No lines ready to settle'), 'warning'); return; }
  const allIncrease = unsettled.every(l => Number(l.variance || 0) >= 0);
  let direction = allIncrease ? 'INCREASE' : 'DECREASE';
  const selected = new Set(unsettled.map(l => l.id));

  const rowsHtml = () => unsettled.map(l => {
    const variance = Number(l.variance || 0);
    const conflict = (direction === 'INCREASE' && variance < 0) || (direction === 'DECREASE' && variance > 0);
    return `<tr data-line="${l.id}">
      <td><input type="checkbox" class="o_stk_pick" ${selected.has(l.id) ? 'checked' : ''}></td>
      <td><span class="o_cell_main">${itemNameOnly(l.item_id)}</span><div class="o_cell_sub">${shelfPath(l.shelf_id)}${l.batch_no ? ' · ' + l.batch_no : ''}</div></td>
      <td class="num">${l.system_qty == null ? '—' : fmtNum(l.system_qty)}</td>
      <td class="num">${fmtNum(l.counted_qty)}</td>
      <td class="num ${variance > 0 ? 'o_pos' : variance < 0 ? 'o_neg' : ''}">${variance > 0 ? '+' : ''}${fmtNum(variance)}</td>
      <td><input class="o_form_input o_stk_comment" data-comment="${l.id}" placeholder="${conflict ? tx('مطلوب — الاتجاه يعاكس الفرق', 'Required — direction conflicts') : tx('اختياري', 'Optional')}"></td>
    </tr>`;
  }).join('');

  const body = `
    ${alertBox(tx('التسوية تُنشئ معاملة تسوية معتمدة لكل سطر. الاتجاه يحدد إشارة التطبيق مقابل الفرق المعدود.',
      'Settlement posts an approved adjustment transaction per line. Direction controls the applied sign versus the counted variance.'), 'info')}
    <div class="o_form_grid" style="margin-bottom:12px">
      <div class="o_field"><label>${tx('اتجاه التسوية', 'Settlement direction')}</label>
        <div class="o_radio_row">
          <label class="o_checkbox"><input type="radio" name="stkDir" value="INCREASE" ${direction === 'INCREASE' ? 'checked' : ''}> ${tx('زيادة المخزون', 'Increase stock')}</label>
          <label class="o_checkbox"><input type="radio" name="stkDir" value="DECREASE" ${direction === 'DECREASE' ? 'checked' : ''}> ${tx('نقص المخزون', 'Decrease stock')}</label>
        </div>
      </div>
      <div class="o_field"><label>${tx('الأسطر المختارة', 'Selected lines')}</label>
        <div class="o_muted"><span id="stkSelectedCount">${selected.size}</span> / ${unsettled.length}</div>
      </div>
    </div>
    <div class="o_list_wrap"><table class="o_list_table" id="stkSettleTable">
      <thead><tr>
        <th style="width:38px"><input type="checkbox" id="stkPickAll" checked></th>
        <th>${tx('الصنف', 'Item')}</th><th class="num">${tx('الدفتري', 'System')}</th>
        <th class="num">${tx('العد', 'Counted')}</th><th class="num">${tx('الفرق', 'Variance')}</th>
        <th>${tx('ملاحظة السطر', 'Line comment')}</th>
      </tr></thead><tbody>${rowsHtml()}</tbody></table></div>`;

  modal({
    title: `<i class="fa-solid fa-scale-balanced"></i> ${tx('تسوية فروقات الجرد', 'Settle stocktake variances')}`,
    size: 'lg', body,
    footer: `<button class="o_btn o_btn_secondary" id="stkSetCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="stkSetSave">${tx('تسوية المحدد', 'Settle selected')}</button>`,
    onMount: (el, close) => {
      const countEl = el.querySelector('#stkSelectedCount');
      const sync = () => {
        selected.clear();
        el.querySelectorAll('.o_stk_pick').forEach(c => { if (c.checked) selected.add(c.closest('tr').dataset.line); });
        countEl.textContent = selected.size;
      };
      el.querySelectorAll('.o_stk_pick').forEach(c => c.onchange = sync);
      el.querySelector('#stkPickAll').onchange = e => {
        el.querySelectorAll('.o_stk_pick').forEach(c => { c.checked = e.target.checked; });
        sync();
      };
      el.querySelectorAll('[name="stkDir"]').forEach(r => r.onchange = () => {
        direction = el.querySelector('[name="stkDir"]:checked').value;
        el.querySelector('#stkSettleTable tbody').innerHTML = rowsHtml();
        el.querySelectorAll('.o_stk_pick').forEach(c => c.onchange = sync);
        sync();
      });
      el.querySelector('#stkSetCancel').onclick = close;
      el.querySelector('#stkSetSave').onclick = async () => {
        if (!selected.size) { toast(tx('اختر سطرًا واحدًا على الأقل', 'Select at least one line'), 'warning'); return; }
        const comments = {};
        el.querySelectorAll('[data-comment]').forEach(inp => {
          if (inp.value.trim()) comments[inp.dataset.comment] = inp.value.trim();
        });
        const conflict = unsettled.find(l => selected.has(l.id) &&
          ((direction === 'INCREASE' && Number(l.variance || 0) < 0) || (direction === 'DECREASE' && Number(l.variance || 0) > 0)) &&
          !comments[l.id]);
        if (conflict) { toast(tx('أضف ملاحظة لكل سطر يعاكس فيه الاتجاه الفرق',
          'Add a comment for every line where direction conflicts with variance'), 'warning'); return; }
        try {
          await settleStocktake(s.id, [...selected], direction, comments);
          close();
          toast(tx('تمت تسوية الأسطر المحددة', 'Selected lines settled'), 'success');
          reload();
        } catch (e) { toast(String(e.message || e), 'error'); }
      };
    }
  });
}

/* ── print / export ──────────────────────────────────────────────────────── */

function printSession(s, p, showSystem) {
  const headers = [
    { label: tx('الصنف', 'Item') }, { label: tx('الرف', 'Shelf') }, { label: tx('التشغيلة', 'Batch') },
    ...(showSystem ? [{ label: tx('الدفتري', 'System'), num: true }] : []),
    { label: tx('العد', 'Counted'), num: true },
    ...(showSystem ? [{ label: tx('الفرق', 'Variance'), num: true }] : []),
    { label: tx('مسوّى', 'Settled') }
  ];
  const body = table(headers, p.lines.map(l => ({
    cells: [
      itemNameOnly(l.item_id), shelfPath(l.shelf_id), l.batch_no || '—',
      ...(showSystem ? [l.system_qty == null ? '—' : fmtNum(l.system_qty)] : []),
      l.counted_qty == null ? '—' : fmtNum(l.counted_qty),
      ...(showSystem ? [l.variance == null ? '—' : fmtNum(l.variance)] : []),
      l.is_settled ? tx('نعم', 'Yes') : tx('لا', 'No')
    ]
  })));
  printHTML(`${tx('جلسة جرد', 'Stocktake session')} #${String(s.id).slice(0, 8)}`,
    `<div style="margin-bottom:10px">
      <b>${tx('المستودع', 'Warehouse')}:</b> ${warehouseName(s.warehouse_id)} &nbsp;
      <b>${tx('النوع', 'Type')}:</b> ${stocktakeTypeLabel(s.stocktake_type)} &nbsp;
      <b>${tx('الوضع', 'Mode')}:</b> ${countModeLabel(s.count_mode)} &nbsp;
      <b>${tx('الحالة', 'Status')}:</b> ${statusLabel(s.status)} / ${statusLabel(reviewOf(s))}
    </div>${body}`,
    { subtitle: `${fmtDateTime(s.created_at)}` });
}

/* ── globals ─────────────────────────────────────────────────────────────── */

OW.wms = OW.wms || {};
OW.wms.newStocktake = openNew;
OW.wms.stocktakeScan = (sessionId, onSaved) => scanStocktake(sessionId, onSaved);
OW.wms.openStocktake = openSession;
OW.wms.openSettlement = (id) => {
  const s = store.byId('stocktake_sessions', id);
  if (s) openSettlement(s);
};
OW.wms.stocktakeTab = v => { F.tab = v; reload(); };
OW.wms.reloadStocktake = async () => {
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  reload();
};
OW.wms.exportStocktake = () => {
  const list = filtered();
  downloadCSV(`stocktake-sessions-${todayISO()}.csv`,
    [tx('الجلسة', 'Session'), tx('المستودع', 'Warehouse'), tx('المنطقة', 'Area'),
     tx('النوع', 'Type'), tx('الوضع', 'Mode'), tx('الحالة', 'Status'), tx('المراجعة', 'Review'),
     tx('الأسطر', 'Lines'), tx('معدود', 'Counted'), tx('الفروقات', 'Variances'),
     tx('إجمالي الفرق', 'Total variance'), tx('التاريخ', 'Date')],
    list.map(s => {
      const p = sessionProgress(s);
      return [String(s.id).slice(0, 8), warehouseName(s.warehouse_id),
        s.storage_area_id ? areaName(s.storage_area_id) : '', stocktakeTypeLabel(s.stocktake_type),
        countModeLabel(s.count_mode), statusLabel(s.status), statusLabel(reviewOf(s)),
        p.total, p.counted, p.varianceLines, p.variance, fmtDateTime(s.created_at)];
    }));
};

OW.registerPage('stocktake', {
  brand: { name: 'OW', icon: 'fa-solid fa-clipboard-check' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المخزون', 'Inventory'), page: 'inventory' },
    { label: tx('المعاملات', 'Transactions'), page: 'transactions' },
    { label: tx('الجرد', 'Stocktake'), page: 'stocktake' },
    { label: tx('التقارير', 'Reports'), page: 'reports' }
  ],
  render,
  mount: bind
});

export default OW.pages.stocktake;
