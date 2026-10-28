// ============================================================================
// OW — Synchronization & offline queue
// ============================================================================
import { OW } from './core-registry.js';
import { tx, friendlyError } from './core-i18n.js';
import { pageHead, card, statCard, table, empty, statusBadge, badge, btn, alertBox, esc } from './core-ui.js';
import { store, syncAll, retryQueueErrors, queueSnapshot } from './core-store.js';
import { fmtDateTime, fmtNum, statusLabel } from './core-utils.js';
import { toast } from './core-toast.js';
import { confirmDialog } from './core-modal.js';

function rows() {
  return queueSnapshot().sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

function render() {
  const q = rows();
  const pending = q.filter(x => x.status === 'PENDING' || !x.status);
  const errors = q.filter(x => x.status === 'ERROR');
  const conflicts = q.filter(x => x.status === 'CONFLICT');
  const canSync = navigator.onLine && !!window.__session?.id;

  return `
  ${pageHead(tx('المزامنة', 'Synchronization'),
    tx('قائمة العمليات المحلية وحالة الاتصال بالخادم', 'Local operation queue and server connectivity'),
    `${btn(`<i class="fa-solid fa-rotate"></i> ${tx('مزامنة الآن', 'Sync now')}`, `onclick="OW.wms.syncNow()" ${canSync ? '' : 'disabled'}`, 'primary')}
     ${btn(`<i class="fa-solid fa-arrows-rotate"></i> ${tx('إعادة المحاولة', 'Retry failed')}`, 'onclick="OW.wms.retryFailed()"', 'secondary')}
     ${btn('', 'onclick="OW.wms.refreshSync()"', 'ghost', 'fa-solid fa-rotate')}`)}
  <div class="o_page_body">
    ${!navigator.onLine
      ? alertBox(`<b>${tx('لا يوجد اتصال', 'No connection')}</b> — ${tx('تُحفظ العمليات محليًا ولن تُرحَّل أرصدة المخزون حتى يعود الاتصال.',
        'Operations are stored locally; stock balances are never posted until the connection returns.')}`, 'warning')
      : window.__session?.offline
        ? alertBox(tx('جلستك محفوظة محليًا. ستحاول المزامنة استعادة جلسة الخادم تلقائيًا؛ إذا فشلت فسجّل الدخول عبر الإنترنت مرة واحدة.',
          'Your session is local. Sync will try to restore the server session automatically; if that fails, sign in online once.'), 'warning')
        : alertBox(tx('العمليات المعلّقة تُرسل بالترتيب. تبقى البيانات المحلية متاحة دائمًا.',
          'Queued operations replay in order. Local data stays available at all times.'), 'info')}
    <div class="o_grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:14px">
      ${statCard({ label: tx('بانتظار الإرسال', 'Pending'), value: fmtNum(pending.length), icon: 'fa-solid fa-hourglass-half', tone: 'amber' })}
      ${statCard({ label: tx('أخطاء', 'Errors'), value: fmtNum(errors.length), icon: 'fa-solid fa-triangle-exclamation', tone: 'red' })}
      ${statCard({ label: tx('تعارضات', 'Conflicts'), value: fmtNum(conflicts.length), icon: 'fa-solid fa-code-branch', tone: 'purple' })}
      ${statCard({ label: tx('آخر تحديث', 'Last refresh'), value: store.lastSync ? fmtDateTime(store.lastSync) : '—', icon: 'fa-solid fa-cloud-arrow-down', tone: 'blue' })}
    </div>
    ${card(`<i class="fa-solid fa-list-check"></i> ${tx('قائمة العمليات', 'Operation queue')}`,
      table(
        [{ label: tx('المصدر', 'Source') }, { label: tx('الجدول', 'Table') }, { label: tx('العملية', 'Operation') },
         { label: tx('السجل', 'Record') }, { label: tx('الحالة', 'Status') }, { label: tx('المحاولات', 'Attempts'), num: true },
         { label: tx('الوقت', 'Time') }, { label: tx('الخطأ', 'Error') }],
        q.map(x => {
          const errorText = x.error ? friendlyError(x.error) : '';
          return {
            cls: x.status === 'ERROR' ? 'rt-danger' : x.status === 'CONFLICT' ? 'rt-warn' : '',
            cells: [
              x.source === 'transaction' ? badge(tx('معاملة', 'Transaction'), 'purple') : badge(tx('بيانات أساسية', 'Master data'), 'blue'),
              `<code>${esc(x.table || '—')}</code>`,
              esc(x.operation || '—'),
              x.record ? esc(String(x.record).slice(0, 24)) : '—',
              statusBadge(x.status, statusLabel(x.status)),
              fmtNum(x.attempts || 0),
              x.time ? fmtDateTime(x.time) : '—',
              errorText ? `<span class="o_error_text" title="${esc(errorText)}">${esc(errorText.slice(0, 90))}</span>` : '—'
            ]
          };
        }),
        { emptyTitle: tx('قائمة المزامنة فارغة', 'The queue is empty'),
          emptyNote: tx('كل العمليات مُزامنة مع الخادم.', 'Everything is synced with the server.') }
      ), `<span class="o_muted">${fmtNum(q.length)} ${tx('عملية', 'operations')}</span>`, 'flush-body')}
  </div>`;
}

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('sync'));
}

let syncing = false;

async function syncNow() {
  if (syncing) return;
  if (!navigator.onLine) { toast(tx('لا يوجد اتصال بالإنترنت', 'No internet connection'), 'warning'); return; }
  if (!window.__session?.id) {
    toast(tx('سجّل الدخول أولًا', 'Sign in first'), 'warning'); return;
  }
  syncing = true;
  try {
    const res = await syncAll();
    const n = Number(res.master || 0) + Number(res.transactions || 0);
    const remaining = Number(res.remaining || 0);
    if (remaining) {
      toast(n
        ? tx(`تمت مزامنة ${n} عملية، وما زالت ${remaining} عملية بانتظار المعالجة.`,
          `Synced ${n} operation(s); ${remaining} still require attention.`)
        : tx(`تعذر إكمال المزامنة — ${remaining} عملية بانتظار المعالجة.`,
          `Sync incomplete — ${remaining} operation(s) still require attention.`), 'warning');
    } else if (res.refreshError) {
      toast(tx('تمت مزامنة العمليات، لكن تعذر تحديث البيانات من الخادم.',
        'Operations synced, but refreshing data from the server failed.'), 'warning');
    } else {
      toast(n ? tx(`تمت مزامنة ${n} عملية`, `Synced ${n} operation(s)`) : tx('كل شيء مُزامن', 'Everything is synced'),
        'success');
    }
    reload();
  } catch (e) { toast(String(e.message || e), 'error'); }
  finally { syncing = false; }
}

OW.wms = OW.wms || {};
OW.wms.syncNow = syncNow;
OW.wms.retryFailed = async () => {
  const n = await retryQueueErrors();
  toast(n ? tx(`أُعيد جدولة ${n} عملية`, `${n} operation(s) re-queued`) : tx('لا توجد عمليات فاشلة', 'Nothing to retry'),
    n ? 'info' : 'success');
  if (n && navigator.onLine) await syncNow(); else reload();
};
OW.wms.refreshSync = async () => {
  await syncNow();
};

OW.registerPage('sync', {
  brand: { name: 'OW', icon: 'fa-solid fa-rotate' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المزامنة', 'Synchronization'), page: 'sync' },
    { label: tx('الإعدادات', 'Settings'), page: 'settings' }
  ],
  render,
  mount: () => {}
});

export default OW.pages.sync;
