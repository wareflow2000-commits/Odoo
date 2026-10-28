// ============================================================================
// OW — shared utilities
// ============================================================================
import { isAr, tx } from './core-i18n.js';

export function uuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const b = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Numbers and dates always use Western (English) digits. Language only changes
// text direction and alignment; it never changes the numerals themselves.
const LOCALE = () => 'en-GB';
const NUMBER_LOCALE = 'en-US';

export function fmtDate(d, opts = {}) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleDateString(LOCALE(), opts.dateStyle ? opts : { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (_) { return date.toISOString().slice(0, 10); }
}

export function fmtDateTime(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString(LOCALE(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return date.toISOString().slice(0, 16).replace('T', ' '); }
}

export function fmtTime(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(LOCALE(), { hour: '2-digit', minute: '2-digit' });
}

export function fmtNum(n, digits = 3) {
  const x = Number(n);
  if (!isFinite(x)) return '—';
  return x.toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: digits });
}

export function fmtQty(n) { return fmtNum(n, 3); }

/** Round to 3 decimals (quantities in the WMS are stored with 3dp precision). */
export function round3(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 1000) / 1000;
}

export function fmtMoney(n) {
  const x = Number(n || 0);
  return x.toLocaleString(NUMBER_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function toDateInput(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
export function toDateTimeInput(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const off = date.getTimezoneOffset();
  return new Date(date.getTime() - off * 60000).toISOString().slice(0, 16);
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function sortBy(list, key, dir = 1) {
  return [...list].sort((a, b) => {
    const av = typeof key === 'function' ? key(a) : a[key];
    const bv = typeof key === 'function' ? key(b) : b[key];
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), isAr() ? 'ar' : 'en') * dir;
  });
}

/* ── bilingual labels ───────────────────────────────────────────────────── */

export const TX_TYPE_LABELS = {
  GRN: 'توريد', ISSUE: 'صرف',
  ADJUSTMENT_IN: 'تسوية زيادة', ADJUSTMENT_OUT: 'تسوية نقص',
  OPENING_BALANCE: 'رصيد افتتاحي', TRANSFER: 'تحويل مخزني',
  RETURN_TO_LOCATION: 'مرتجع إلى المستودع',
  RETURN_TO_SUPPLIER: 'مرتجع إلى المورد',
  RETURN_FROM_USAGE: 'مرتجع من الاستخدام',
  RETURN_FROM_CUSTOMER: 'مرتجع من عميل',
  STOCKTAKE: 'جرد', STOCKTAKE_ADJUSTMENT: 'تسوية جرد',
  STOCK_TRANSFER: 'تحويل مخزني'
};
const TX_TYPE_EN = {
  GRN: 'Goods receipt', ISSUE: 'Issue',
  ADJUSTMENT_IN: 'Adjustment increase', ADJUSTMENT_OUT: 'Adjustment decrease',
  OPENING_BALANCE: 'Opening balance', TRANSFER: 'Stock transfer',
  RETURN_TO_LOCATION: 'Return to warehouse',
  RETURN_TO_SUPPLIER: 'Return to supplier',
  RETURN_FROM_USAGE: 'Return from usage',
  RETURN_FROM_CUSTOMER: 'Customer return',
  STOCKTAKE: 'Stocktake', STOCKTAKE_ADJUSTMENT: 'Stocktake adjustment',
  STOCK_TRANSFER: 'Stock transfer'
};

export const STATUS_LABELS = {
  DRAFT: 'مسودة', PENDING: 'قيد الانتظار', PENDING_APPROVAL: 'بانتظار الاعتماد',
  APPROVED: 'معتمد', REJECTED: 'مرفوض', CANCELLED: 'ملغى', COMPLETED: 'مكتمل',
  IN_PROGRESS: 'قيد التنفيذ', CLOSED: 'مغلق', POSTED: 'مرحّل', FAILED: 'فشل',
  SYNCED: 'تمت المزامنة', IN_TRANSIT: 'قيد النقل',
  PARTIALLY_RECEIVED: 'استلام جزئي', PARTIALLY_RETURNED: 'مرتجع جزئي',
  RETURN_IN_TRANSIT: 'مرتجع قيد النقل', RETURNED: 'مرتجع',
  RECEIVED: 'تم الاستلام', RETURNED_TO_SOURCE: 'أعيد للمصدر',
  PENDING_REVIEW: 'بانتظار المراجعة', SUBMITTED: 'مقدم للمراجعة',
  OPEN: 'مفتوح', PENDING_SYNC: 'بانتظار المزامنة', ERROR: 'خطأ', CONFLICT: 'تعارض',
  ACTIVE: 'نشط', INACTIVE: 'غير نشط', SUSPENDED: 'موقوف', ARCHIVED: 'مؤرشف',
  SENT: 'تم الإرسال', RECEIVING: 'قيد الاستلام', COUNTING: 'قيد العد',
  SETTLED: 'تمت التسوية', PARTIALLY_SETTLED: 'تسوية جزئية'
};
const STATUS_EN = {
  DRAFT: 'Draft', PENDING: 'Pending', PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled',
  COMPLETED: 'Completed', IN_PROGRESS: 'In progress', CLOSED: 'Closed',
  POSTED: 'Posted', FAILED: 'Failed', SYNCED: 'Synced', IN_TRANSIT: 'In transit',
  PARTIALLY_RECEIVED: 'Partially received', PARTIALLY_RETURNED: 'Partially returned',
  RETURN_IN_TRANSIT: 'Return in transit', RETURNED: 'Returned',
  RECEIVED: 'Received', RETURNED_TO_SOURCE: 'Returned to source',
  PENDING_REVIEW: 'Pending review', SUBMITTED: 'Submitted for review',
  OPEN: 'Open', PENDING_SYNC: 'Pending sync', ERROR: 'Error', CONFLICT: 'Conflict',
  ACTIVE: 'Active', INACTIVE: 'Inactive', SUSPENDED: 'Suspended', ARCHIVED: 'Archived',
  SENT: 'Sent', RECEIVING: 'Receiving', COUNTING: 'Counting',
  SETTLED: 'Settled', PARTIALLY_SETTLED: 'Partially settled'
};

export function txLabel(k) {
  const key = String(k || '').toUpperCase();
  return (isAr() ? TX_TYPE_LABELS : TX_TYPE_EN)[key] || k || '—';
}
export function statusLabel(k) {
  const key = String(k || '').toUpperCase();
  return (isAr() ? STATUS_LABELS : STATUS_EN)[key] || k || '—';
}

export const ROLE_LABELS = {
  SUPER_ADMIN: ['مدير النظام', 'Super admin'],
  ADMIN: ['مدير', 'Administrator'],
  MANAGER: ['مدير عام', 'Manager'],
  WAREHOUSE_MANAGER: ['مدير مستودع', 'Warehouse manager'],
  CLERK: ['موظف', 'Clerk'],
  VIEWER: ['مطّلع', 'Viewer']
};
export function roleLabel(r) {
  const v = ROLE_LABELS[String(r || '').toUpperCase()];
  return v ? v[isAr() ? 0 : 1] : (r || '—');
}

/* ── permissions (Arabic presentation of database keys) ─────────────────── */
export const PERMISSION_GROUP_LABELS = {
  action: ['الإجراءات', 'Actions'],
  table: ['الجداول', 'Tables'],
  page: ['الصفحات', 'Pages'],
  widget: ['المكوّنات', 'Widgets'],
  other: ['أخرى', 'Other']
};
export function permissionGroupLabel(group) {
  const row = PERMISSION_GROUP_LABELS[String(group || '').toLowerCase()];
  return row ? row[isAr() ? 0 : 1] : tx('أخرى', 'Other');
}

// [Arabic label, English label, Arabic description, English description]
const PERMISSION_TEXT = {
  'page:dashboard:access': ['لوحة التحكم', 'Dashboard', 'عرض صفحة لوحة التحكم والمؤشرات التشغيلية.', 'View the dashboard page and its operational indicators.'],
  'widget:total_stock:view': ['إجمالي المخزون', 'Total stock', 'عرض بطاقة إجمالي الكميات في لوحة التحكم.', 'Show the total stock card on the dashboard.'],
  'widget:alerts:view': ['تنبيهات المخزون', 'Stock alerts', 'عرض تنبيهات الأصناف التي وصلت إلى حد الأمان.', 'Show alerts for items at or below their safety stock.'],
  'widget:recent_activity:view': ['النشاط الأخير', 'Recent activity', 'عرض آخر العمليات والحركات في لوحة التحكم.', 'Show recent operations and movements on the dashboard.'],
  'page:inventory:access': ['قائمة المخزون', 'Inventory list', 'الوصول إلى صفحة الأصناف والأرصدة.', 'Access the items and stock page.'],
  'table:inventory:view': ['جدول المخزون', 'Inventory table', 'عرض جدول الأصناف وأرصدة المخزون.', 'View the items and stock balances table.'],
  'table:inventory:column:cost:view': ['التكلفة والسعر', 'Cost and price', 'عرض عمودي التكلفة والسعر في المخزون.', 'Show the cost and price columns in inventory.'],
  'table:inventory:column:supplier:view': ['المورد', 'Supplier', 'عرض بيانات المورد المرتبط بالصنف.', 'Show the supplier linked to each item.'],
  'table:inventory:column:quantity:view': ['الكميات', 'Quantities', 'عرض كميات المخزون المتاحة.', 'Show available stock quantities.'],
  'table:inventory:column:opening_balance:view': ['الرصيد الافتتاحي', 'Opening balance', 'عرض الرصيد الافتتاحي للصنف.', 'Show the item opening balance.'],
  'table:inventory:column:location:view': ['الموقع', 'Location', 'عرض المستودع ومنطقة التخزين والرف.', 'Show the warehouse, storage area and shelf.'],
  'table:inventory:column:weight:view': ['الوزن', 'Weight', 'عرض وزن الصنف.', 'Show the item weight.'],
  'table:inventory:column:code:view': ['الرمز والباركود', 'Code and barcode', 'عرض رمز الصنف والباركود.', 'Show the item code and barcode.'],
  'action:item:create': ['إضافة صنف', 'Create item', 'إنشاء أصناف جديدة.', 'Create new items.'],
  'action:item:update': ['تعديل صنف', 'Update item', 'تعديل بيانات الأصناف الحالية.', 'Update existing item details.'],
  'action:item:delete': ['حذف صنف', 'Delete item', 'حذف الأصناف من النظام.', 'Delete items from the system.'],
  'action:inventory:export': ['تصدير المخزون', 'Export inventory', 'تصدير بيانات المخزون إلى ملف.', 'Export inventory data to a file.'],
  'action:label:print': ['طباعة الملصقات', 'Print labels', 'طباعة ملصقات QR للأصناف.', 'Print QR labels for items.'],
  'page:transactions:access': ['المعاملات', 'Transactions', 'الوصول إلى سجل المعاملات.', 'Access the transactions history.'],
  'table:transactions:view': ['جدول المعاملات', 'Transactions table', 'عرض جدول المعاملات المخزنية.', 'View the stock transactions table.'],
  'action:transaction:grn:create': ['إنشاء توريد', 'Create receipt', 'إنشاء سند استلام أو توريد.', 'Create an inbound receipt (GRN).'],
  'action:transaction:issue:create': ['إنشاء صرف', 'Create issue', 'إنشاء سند صرف مخزني.', 'Create an outbound issue.'],
  'action:transaction:adjustment:create': ['إنشاء تسوية', 'Create adjustment', 'إنشاء تسوية زيادة أو نقص.', 'Create a stock increase or decrease adjustment.'],
  'table:transactions:column:reference:view': ['رقم المرجع', 'Reference number', 'عرض أرقام مراجع المعاملات.', 'Show transaction reference numbers.'],
  'table:transactions:column:user:view': ['منشئ المعاملة', 'Created by', 'عرض اسم منشئ المعاملة.', 'Show who created the transaction.'],
  'table:transactions:column:date:view': ['تاريخ المعاملة', 'Transaction date', 'عرض تاريخ ووقت المعاملة.', 'Show the transaction date and time.'],
  'action:transaction:approve': ['اعتماد المعاملات', 'Approve transactions', 'اعتماد المعاملات المعلقة.', 'Approve pending transactions.'],
  'action:transaction:reject': ['رفض المعاملات', 'Reject transactions', 'رفض المعاملات المعلقة.', 'Reject pending transactions.'],
  'action:transaction:auto_approve': ['اعتماد تلقائي', 'Auto-approve', 'اعتماد مدخلات المستخدم تلقائياً عند الحفظ.', 'Automatically approve the user’s entries on save.'],
  'action:transaction:view_others': ['معاملات الآخرين', 'Others’ transactions', 'عرض معاملات المستخدمين الآخرين.', 'View transactions created by other users.'],
  'action:transaction:create': ['إنشاء معاملة', 'Create transaction', 'إنشاء معاملات مخزنية عامة.', 'Create general stock transactions.'],
  'action:transaction:return:create': ['إنشاء مرتجع', 'Create return', 'إنشاء طلبات إرجاع مخزني.', 'Create stock return requests.'],
  'page:stocktake:access': ['الجرد', 'Stocktake', 'الوصول إلى صفحة الجرد.', 'Access the stocktake page.'],
  'table:stocktake:view': ['جدول الجرد', 'Stocktake table', 'عرض جلسات وأسطر الجرد.', 'View stocktake sessions and lines.'],
  'action:stocktake:start': ['بدء جرد', 'Start stocktake', 'بدء جلسات جرد جديدة.', 'Start new count sessions.'],
  'action:stocktake:count': ['عد الأسطر', 'Count lines', 'إدخال الكميات الفعلية لأسطر الجرد.', 'Enter actual quantities on stocktake lines.'],
  'action:stocktake:submit': ['إرسال الجرد', 'Submit count', 'إرسال الجرد للمراجعة.', 'Submit the count for review.'],
  'action:stocktake:close': ['إغلاق الجلسة', 'Close session', 'إنهاء وإغلاق جلسات الجرد.', 'Finalize and close stocktake sessions.'],
  'action:stocktake:settle': ['تسوية الفروقات', 'Settle variances', 'اعتماد تسويات فروقات الجرد.', 'Settle stocktake variances.'],
  'action:stocktake:approve': ['اعتماد الجرد', 'Approve stocktake', 'اعتماد أو رفض جلسات الجرد.', 'Approve or reject stocktake sessions.'],
  'action:stocktake:view_system_qty': ['كمية النظام', 'System quantity', 'عرض كمية النظام أثناء الجرد.', 'View the system quantity during stocktake.'],
  'page:facilities:access': ['المستودعات', 'Facilities', 'الوصول إلى صفحة المستودعات والهيكل التنظيمي.', 'Access the facilities and hierarchy page.'],
  'table:facilities:view': ['جدول المستودعات', 'Facilities table', 'عرض جدول المستودعات ومناطق التخزين.', 'View the warehouses and storage areas table.'],
  'action:warehouse:manage': ['إدارة المستودعات', 'Manage warehouses', 'إدارة كاملة للمستودعات والأرفف.', 'Full management of warehouses and shelves.'],
  'action:facility:manage': ['إدارة الهيكل', 'Manage facilities', 'إدارة المستودعات ومناطق التخزين والأرفف.', 'Manage warehouses, storage areas and shelves.'],
  'action:stock_transfer:create': ['إنشاء تحويل', 'Create transfer', 'إنشاء وإرسال تحويل مخزني.', 'Create and dispatch a stock transfer.'],
  'action:stock_transfer:receive': ['استلام تحويل', 'Receive transfer', 'استلام تحويل بين المستودعات.', 'Receive an inter-warehouse transfer.'],
  'action:stock_transfer:view': ['عرض التحويلات', 'View transfers', 'عرض التحويلات المخزنية.', 'View stock transfers.'],
  'page:reports:access': ['التقارير', 'Reports', 'الوصول إلى مركز التقارير.', 'Access the reports center.'],
  'table:reports:view': ['جدول التقارير', 'Reports table', 'عرض بيانات التقارير.', 'View report data.'],
  'table:inventory_valuation:view': ['تقييم المخزون', 'Inventory valuation', 'عرض تقييم قيمة المخزون.', 'View the inventory valuation.'],
  'table:audit_logs:view': ['سجل التدقيق', 'Audit log', 'عرض سجل تغييرات النظام.', 'View the system audit log.'],
  'action:users:manage': ['إدارة المستخدمين', 'Manage users', 'إدارة حسابات المستخدمين والأدوار.', 'Manage user accounts and roles.'],
  'action:users:approve': ['اعتماد التسجيلات', 'Approve signups', 'اعتماد حسابات المستخدمين الجديدة.', 'Approve new user signups.'],
  'action:settings:manage': ['إعدادات النظام', 'System settings', 'تعديل إعدادات النظام العامة.', 'Change global system settings.'],
  'action:data:import': ['استيراد البيانات', 'Data import', 'استيراد البيانات الأساسية من ملف.', 'Import master data from a file.'],
  'action:system:export': ['تصدير النظام', 'System export', 'تصدير بيانات النظام بالكامل.', 'Export the full system data.'],
  'page:settings:access': ['الإعدادات', 'Settings', 'الوصول إلى صفحة الإعدادات.', 'Access the settings page.'],
  'page:transfers:access': ['التحويلات', 'Transfers', 'الوصول إلى صفحة التحويلات المخزنية.', 'Access the stock transfers page.'],
  'page:orders:access': ['الطلبيات', 'Orders', 'الوصول إلى صفحة طلبيات التحويل.', 'Access the transfer orders page.'],
  'page:apps:access': ['التطبيقات', 'Apps', 'الوصول إلى لوحة التطبيقات.', 'Access the apps launcher.'],
  'page:discuss:access': ['المناقشات', 'Discuss', 'الوصول إلى محادثات الفريق.', 'Access team discussions.'],
  'page:calendar:access': ['التقويم', 'Calendar', 'الوصول إلى التقويم والمواعيد.', 'Access the calendar and events.'],
  'page:profile:access': ['الملف الشخصي', 'Profile', 'عرض الملف الشخصي للمستخدم.', 'View the user profile.'],
  'page:about:access': ['حول النظام', 'About', 'عرض معلومات النظام.', 'View system information.'],
  'page:sync:access': ['المزامنة', 'Synchronization', 'عرض قائمة المزامنة والعمليات المعلقة.', 'View the sync queue and pending operations.']
};

function permissionFallback(key) {
  return isAr()
    ? tx('صلاحية إضافية', 'Additional permission')
    : (String(key || '').split(':').filter(Boolean).join(' ') || 'Permission');
}

export function permissionLabel(key) {
  const row = PERMISSION_TEXT[String(key || '')];
  if (row) return row[isAr() ? 0 : 1];
  return permissionFallback(key);
}

export function permissionDescription(key, fallback = '') {
  const row = PERMISSION_TEXT[String(key || '')];
  if (row) return row[isAr() ? 2 : 3];
  if (isAr()) return tx('صلاحية مرتبطة بهذا العنصر. راجع مدير النظام لمعرفة تفاصيلها.',
    'A permission linked to this item. Contact your administrator for details.');
  const clean = String(fallback || '').trim();
  // Never surface a raw database key (for example "page:transfers:access").
  if (!clean || clean.toLowerCase().includes(String(key || '').toLowerCase())) {
    return 'A permission linked to this item. Contact your administrator for details.';
  }
  return clean;
}

export const STOCKTAKE_TYPE_LABELS = {
  CYCLE: ['جرد دوري', 'Cycle count'],
  FULL: ['جرد كامل', 'Full count'],
  SURPRISE: ['جرد مفاجئ', 'Surprise count'],
  RECOUNT: ['إعادة جرد', 'Recount']
};
export function stocktakeTypeLabel(v) {
  const x = STOCKTAKE_TYPE_LABELS[String(v || '').toUpperCase()];
  return x ? x[isAr() ? 0 : 1] : (v || '—');
}
export const COUNT_MODE_LABELS = {
  ANNOUNCED: ['معلن', 'Announced'],
  BLIND: ['أعمى', 'Blind'],
  VISIBLE: ['مرئي', 'Visible']
};
export function countModeLabel(v) {
  const x = COUNT_MODE_LABELS[String(v || '').toUpperCase()];
  return x ? x[isAr() ? 0 : 1] : (v || '—');
}
export const DIRECTIONS = {
  INCREASE: ['زيادة', 'Increase'],
  DECREASE: ['نقص', 'Decrease']
};

export function csvSafe(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}
export function buildCSV(headers, rows) {
  return '\ufeff' + [headers, ...rows].map(r => r.map(csvSafe).join(',')).join('\n');
}

export function nowISO() { return new Date().toISOString(); }
export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function startOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
export function startOfYearISO() {
  const d = new Date();
  return new Date(d.getFullYear(), 0, 1).toISOString().slice(0, 10);
}
export function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}
