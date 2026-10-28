// ============================================================================
// OW — i18n layer (Arabic default / English instant toggle)
// ----------------------------------------------------------------------------
// New pages call tx('نص عربي','English text').
// Legacy pages keep their Arabic markup; localizeDom() translates their text
// nodes and attributes at runtime, so the toggle stays instant everywhere.
// ============================================================================

const LS_LANG = 'orshap_lang';

export let LANG = (localStorage.getItem(LS_LANG) || 'ar').toLowerCase() === 'en' ? 'en' : 'ar';

export const isAr = () => LANG === 'ar';
export const tx = (ar, en) => (LANG === 'ar' ? ar : en);
export const dir = () => (LANG === 'ar' ? 'rtl' : 'ltr');

/**
 * Turn any thrown value into a short, translated message that is safe to show
 * to a user. Raw browser/Supabase errors (TypeError, PGRST*, RLS policy text…)
 * stay in the console; the UI only receives an understandable explanation.
 */
export function friendlyError(error, fallback = '') {
  const raw = String(error?.message ?? error ?? '').trim();
  const generic = fallback || tx(
    'حدث خطأ غير متوقع. حاول مرة أخرى، وإذا تكرر الخطأ فأعد تحميل الصفحة.',
    'Something went wrong. Please try again, or reload the page if it persists.'
  );
  if (!raw) return generic;
  if (/^(undefined|null|\[object (object|promise)\]|nan)$/i.test(raw)) return generic;

  // Messages authored by the app are already translated and user-friendly.
  if (/[\u0600-\u06FF]/.test(raw)) return raw;

  // Live backup / restore errors are guarded and must never leak SQL details.
  if (/SNAPSHOT_FORMAT_INVALID|SNAPSHOT_TABLE_INVALID|SNAPSHOT_EMPTY/i.test(raw)) {
    return tx('الملف المختار ليس نسخة احتياطية صالحة لنظام WMS. اختر ملفًا ناتجًا من زر «تنزيل نسخة الخادم الحية».',
      'The selected file is not a valid WMS snapshot. Choose a file created by “Download live server snapshot”.');
  }
  if (/SNAPSHOT_VERSION_UNSUPPORTED/i.test(raw)) {
    return tx('إصدار النسخة الاحتياطية غير مدعوم في هذا النظام. حدّث النظام أو استخدم نسخة أحدث.',
      'This snapshot version is not supported. Update the system or use a newer snapshot.');
  }
  if (/SNAPSHOT_SUPER_ADMIN_REQUIRED/i.test(raw)) {
    return tx('النسخ الكامل والاستعادة متاحان لمدير النظام الأعلى فقط.',
      'Full backup and restore are available to SUPER_ADMIN only.');
  }
  if (/SNAPSHOT_CONFIRMATION_REQUIRED/i.test(raw)) {
    return tx('تأكيد الاستعادة غير مكتمل. أعد المحاولة واكتب RESTORE عند الطلب.',
      'Restore confirmation is missing. Try again and type RESTORE when prompted.');
  }
  if (/SNAPSHOT_CURRENT_USER_MISSING/i.test(raw)) {
    return tx('لا تحتوي هذه النسخة على حسابك كمدير نظام أعلى نشط، لذلك رُفضت الاستعادة لحماية وصولك.',
      'This snapshot does not contain your account as an active SUPER_ADMIN, so the restore was refused to protect your access.');
  }
  if (/SNAPSHOT_AUTH_USER_MISSING/i.test(raw)) {
    return tx('بعض حسابات المستخدمين في النسخة غير موجودة في مشروع Supabase الحالي. استعد النسخة إلى المشروع الأصلي أو أنشئ الحسابات أولًا.',
      'Some user accounts in the snapshot do not exist in the current Supabase project. Restore into the original project or create those auth accounts first.');
  }
  if (/SNAPSHOT_FK_CYCLE/i.test(raw)) {
    return tx('تعذر ترتيب جداول النسخة بسبب علاقات دائرية. تواصل مع مسؤول النظام.',
      'The snapshot tables could not be ordered because of circular relationships. Contact the system administrator.');
  }

  // Unit-accounting errors are deliberately specific: show the corrective step
  // instead of a generic database/constraint message.
  if (/UNIT_NOT_CONFIGURED/i.test(raw)) {
    return tx('الوحدة المختارة غير مهيأة لهذا الصنف. اعتمد معامل التحويل أولاً من الإعدادات > تحويلات الوحدات.',
      'The selected unit is not configured for this item. Approve its conversion factor in Settings > Unit conversions.');
  }
  if (/UNIT_FACTOR_CHANGED/i.test(raw)) {
    return tx('تغيّر معامل التحويل بعد إنشاء السند. راجع السند وأعد إدخال الكمية بالوحدة الحالية قبل الاعتماد.',
      'The conversion factor changed after this voucher was created. Review it and re-enter the quantity using the current factor before approval.');
  }
  if (/BASE_UNIT_LOCKED/i.test(raw)) {
    return tx('لا يمكن تغيير الوحدة الأساسية بعد بدء الحركات المخزنية، حتى لو كان الرصيد الحالي صفرًا.',
      'The base unit cannot be changed after stock movements begin, even if the current balance is zero.');
  }
  if (/BASE_UNIT_HAS_CONVERSIONS/i.test(raw)) {
    return tx('احذف معاملات التحويل المعتمدة لهذا الصنف قبل تغيير وحدته الأساسية.',
      'Delete this item’s approved conversion factors before changing its base unit.');
  }
  if (/BASE_UNIT_CHANGED/i.test(raw)) {
    return tx('تغيّرت الوحدة الأساسية للصنف بعد إنشاء السند. راجع السند قبل الاعتماد.',
      'The item base unit changed after this voucher was created. Review the voucher before approval.');
  }
  if (/UNIT_QUANTITY_MISMATCH|BASE_UNIT_QUANTITY_MISMATCH|INVALID_BASE_QUANTITY|ENTERED_QUANTITY_REQUIRED|INVALID_CONVERSION_FACTOR|ITEM_BASE_UNIT_MISSING/i.test(raw)) {
    return tx('بيانات الكمية أو الوحدة غير متسقة. راجع الكمية والوحدة والمعامل ثم أعد المحاولة.',
      'The quantity or unit data is inconsistent. Review the quantity, unit and factor, then try again.');
  }
  if (/POSTED_TRANSACTION_LINE_IMMUTABLE/i.test(raw)) {
    return tx('لا يمكن تعديل بنود سند معتمد. أنشئ سندًا جديدًا للتصحيح.',
      'Approved voucher lines cannot be changed. Create a new correcting voucher.');
  }

  if (/invalid login credentials|invalid credentials|wrong password/i.test(raw)) {
    return tx('بيانات الدخول غير صحيحة. تحقق من البريد وكلمة المرور.',
      'Incorrect sign-in details. Check your email and password.');
  }
  if (/email not confirmed|confirm your email|email.*not verified/i.test(raw)) {
    return tx('يجب تأكيد البريد الإلكتروني أولاً. راجع بريدك ثم أعد المحاولة.',
      'Please confirm your email first, then try again.');
  }
  if (/signups? not allowed|signups? (are )?disabled|registration.*disabled/i.test(raw)) {
    return tx('إنشاء الحسابات غير مفعّل حالياً. تواصل مع مدير النظام.',
      'Account creation is currently disabled. Contact your administrator.');
  }
  if (/rate limit|too many requests|429/i.test(raw)) {
    return tx('محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.',
      'Too many attempts. Please wait a moment and try again.');
  }
  if (/jwt|session.*(expired|missing|invalid)|refresh token|not authenticated|unauthorized|401/i.test(raw)) {
    return tx('انتهت جلسة الدخول. سجّل الدخول من جديد ثم أعد المحاولة.',
      'Your session has expired. Sign in again and retry.');
  }
  if (/permission denied|row-level security|rls|policy|42501|forbidden|not allowed|403/i.test(raw)) {
    return tx('لا تملك الصلاحية اللازمة لتنفيذ هذه العملية. تواصل مع مدير النظام.',
      'You do not have permission to perform this action. Contact your administrator.');
  }
  if (/duplicate|unique constraint|already exists|23505/i.test(raw)) {
    return tx('هذا السجل موجود مسبقاً. استخدم رمزاً أو اسماً مختلفاً.',
      'This record already exists. Use a different code or name.');
  }
  if (/foreign key|constraint|23503|referenced|still referenced/i.test(raw)) {
    return tx('لا يمكن إتمام العملية لوجود بيانات مرتبطة بهذا السجل.',
      'This cannot be completed because related records still reference it.');
  }
  if (/not found|no rows|pgrst116|404/i.test(raw)) {
    return tx('لم يتم العثور على السجل المطلوب. حدّث الصفحة ثم حاول مجدداً.',
      'The requested record was not found. Refresh the page and try again.');
  }
  if (/supabase|apikey|api key|anon key|service role|environment variable|not configured|missing config|pgrst\d+/i.test(raw)) {
    return tx('تعذر الاتصال بإعدادات النظام. تواصل مع مدير النظام.',
      'System configuration is unavailable. Contact your administrator.');
  }
  if (/failed to fetch|networkerror|network error|load failed|fetch failed|econn|enotfound|timed out|timeout|offline|internet/i.test(raw)) {
    return tx('تعذر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.',
      'Could not reach the server. Check your connection and try again.');
  }
  if (/quota|storage.*(full|exceeded)|indexeddb|disk.*(full|space)/i.test(raw)) {
    return tx('تعذر حفظ البيانات على هذا الجهاز. حرّر مساحة ثم أعد المحاولة.',
      'Could not save data on this device. Free some space and try again.');
  }
  if (/invalid input|invalid syntax|syntaxerror|could not parse|json|22007|22p02|unexpected token/i.test(raw)) {
    return tx('البيانات المدخلة غير صحيحة. راجع الحقول ثم أعد المحاولة.',
      'The entered data is invalid. Review the fields and try again.');
  }
  if (/relation .* does not exist|column .* does not exist|function .* does not exist|schema cache/i.test(raw)) {
    return tx('تعذر إكمال العملية بسبب مشكلة في إعدادات النظام. تواصل مع مدير النظام.',
      'This could not be completed because of a system configuration issue. Contact your administrator.');
  }
  if (/\b(typeerror|referenceerror|rangeerror|evalerror|aborterror|securityerror|notsupportederror|unknownerror|uncaught|cannot read|cannot set|undefined is not|null is not|reading '|is not defined|is undefined|is null|not a function|not iterable|assignment to constant|maximum call stack|failed to execute|invalid or unexpected token|script error)\b/i.test(raw)) {
    return generic;
  }
  if (/^(error|failed|exception|uncaught)\b/i.test(raw) && raw.split(/\s+/).length <= 7) return generic;
  if (raw.length > 260) return generic;

  // A short plain-language message written by the app/server is safe to show.
  return raw;
}

// Arabic → English dictionary used by legacy markup and dynamic text nodes.
const EN = {
  // ── shell / navigation ────────────────────────────────────────────────────
  'لوحة التحكم': 'Dashboard', 'نظرة عامة': 'Overview', 'المخزون': 'Inventory', 'المعاملات': 'Transactions',
  'الطلبيات': 'Orders', 'التحويلات': 'Transfers', 'الجرد': 'Stocktake',
  'المستودعات': 'Facilities', 'التقارير': 'Reports', 'الإعدادات': 'Settings',
  'الملف': 'Profile', 'ملفي': 'My profile', 'حول النظام': 'About', 'الرئيسية': 'Home',
  'المناقشات': 'Discuss', 'التقويم': 'Calendar', 'جهات الاتصال': 'Contacts',
  'الموقع': 'Website', 'الموظفون': 'Employees', 'المنتجات': 'Products',
  'نقطة البيع': 'Point of Sale', 'المحاسبة': 'Accounting',
  'التطبيقات': 'Apps', 'المزيد': 'More', 'تسجيل الخروج': 'Sign out',
  'اللغة': 'Language', 'العربية': 'Arabic', 'الإنجليزية': 'English',
  'التنقل السريع': 'Quick navigation',
  'تحديث': 'Refresh', 'بحث': 'Search', 'بحث...': 'Search...',
  'إلغاء': 'Cancel', 'حفظ': 'Save', 'إضافة': 'Add', 'جديد': 'New',
  'تعديل': 'Edit', 'حذف': 'Delete', 'إجراءات': 'Actions', 'تفاصيل': 'Details',
  'طباعة': 'Print', 'تصدير': 'Export', 'استيراد': 'Import', 'تصفية': 'Filter',
  'تطبيق': 'Apply', 'إعادة المحاولة': 'Retry', 'إغلاق': 'Close',
  'المزامنة': 'Synchronization', 'مزامنة': 'Sync', 'حول': 'About',
  'نعم': 'Yes', 'لا': 'No', 'الكل': 'All', 'اليوم': 'Today',
  'جارٍ التحميل...': 'Loading...', 'لا توجد بيانات': 'No data',
  'لا توجد نتائج': 'No results', 'تم الحفظ': 'Saved', 'فشل الحفظ': 'Save failed',
  'تم الحذف': 'Deleted', 'فشل الحذف': 'Delete failed',

  // ── common fields ─────────────────────────────────────────────────────────
  'الرمز': 'Code', 'الاسم': 'Name', 'الوصف': 'Description', 'الحالة': 'Status',
  'التاريخ': 'Date', 'الوقت': 'Time', 'المستخدم': 'User', 'الكمية': 'Quantity',
  'الوحدة': 'Unit', 'الصنف': 'Item', 'المستودع': 'Warehouse', 'المخزن': 'Storage area',
  'منطقة التخزين': 'Storage area', 'منطقة تخزين': 'Storage area', 'أقسام': 'Sections',
  'طباعة QR للأرفف': 'Print shelf QR', 'المنطقة': 'Area', 'القسم': 'Section',
  'الرف': 'Shelf', 'المسار الكامل': 'Full path', 'المرجع': 'Reference',
  'النوع': 'Type', 'المورد': 'Supplier', 'المستلم': 'Receiver',
  'ملاحظات': 'Notes', 'الرصيد': 'Balance', 'الرصيد الحالي': 'Current balance',
  'حد الأمان': 'Safety stock', 'الوحدة الأساسية': 'Base unit',
  'وحدة الشراء': 'Purchase unit', 'معامل التحويل': 'Conversion factor',
  'الفئة': 'Category', 'الوزن': 'Weight', 'التكلفة': 'Cost',
  'التشغيلة': 'Batch', 'الصلاحية': 'Expiry', 'البريد الإلكتروني': 'Email',
  'كلمة المرور': 'Password', 'الاسم الكامل': 'Full name', 'الدور': 'Role',
  'إظهار كلمة المرور': 'Show password', 'إخفاء كلمة المرور': 'Hide password',
  'الصلاحيات': 'Permissions', 'المستودعات المتاحة': 'Assigned warehouses',
  'الكمية الفعلية': 'Actual count', 'كمية النظام': 'System quantity',
  'الفرق': 'Variance', 'الاتجاه': 'Direction', 'التعليق': 'Comment',
  'مفتوح': 'Open', 'مغلق': 'Closed', 'نشط': 'Active', 'غير نشط': 'Inactive',
  'معطلة': 'Inactive', 'نشطة': 'Active', 'الكل': 'All',
  'المصدر': 'Source', 'الوجهة': 'Destination', 'المتاح': 'Available',
  'الكمية المحولة': 'Transfer quantity', 'الكمية المستلمة': 'Received quantity',
  'الكمية المرتجعة': 'Returned quantity', 'بانتظار الاستلام': 'Awaiting receipt',
  'قيد النقل': 'In transit', 'مستلم': 'Received', 'مرفوض': 'Rejected',
  'معتمد': 'Approved', 'مسودة': 'Draft', 'بانتظار الاعتماد': 'Pending approval',
  'استلام جزئي': 'Partially received', 'مرتجع قيد النقل': 'Return in transit',
  'أعيد للمصدر': 'Returned to source', 'قيد التنفيذ': 'In progress',
  'بانتظار المراجعة': 'Pending review', 'مقدم للمراجعة': 'Submitted for review',

  // ── facilities page ───────────────────────────────────────────────────────
  'مناطق التخزين': 'Storage areas', 'الأقسام': 'Sections', 'الأرفف': 'Shelves',
  'مناطق': 'Areas', 'أرفف': 'Shelves', 'اختر مستودعًا أولًا.':
    'Choose a warehouse first.', 'لا توجد مناطق': 'No storage areas',
  'أضف منطقة أولًا': 'Add a storage area first', 'بدون قسم': 'No section',
  'بدون منطقة': 'No storage area', 'المستودع الحالي': 'Current warehouse',
  'القسم (اختياري)': 'Section (optional)',
  'المسار الكامل (يُبنى تلقائيًا إن تركته فارغًا)':
    'Full path (built automatically when left empty)',
  'الأقسام مواقع داخلية اختيارية.':
    'Sections are optional internal locations.',
  'الأرفف هي أصغر وحدة تخزين.': 'Shelves are the smallest storage unit.',
  'تعديل مستودع': 'Edit warehouse', 'مستودع جديد': 'New warehouse',
  'تعديل منطقة تخزين': 'Edit storage area', 'منطقة تخزين جديدة': 'New storage area',
  'تعديل قسم': 'Edit section', 'قسم جديد': 'New section',
  'تعديل رف': 'Edit shelf', 'رف جديد': 'New shelf',
  'منطقة': 'Area', 'قسم': 'Section', 'رف': 'Shelf', 'مستودع': 'Warehouse',
  'الرمز والاسم مطلوبان': 'Code and name are required',
  'المستودع والرمز والاسم مطلوبة': 'Warehouse, code and name are required',
  'كل الحقول مطلوبة': 'All fields are required',
  'المنطقة لا تنتمي للمستودع المحدد':
    'The storage area does not belong to the selected warehouse',
  'المستودع ومنطقة التخزين والرمز مطلوبة':
    'Warehouse, storage area and code are required',
  'منطقة التخزين لا تنتمي للمستودع المحدد':
    'The storage area does not belong to the selected warehouse',
  'تنبيه: يوجد': 'Warning:', 'احذف العناصر التابعة أولًا.':
    'Delete dependent records first.',
  'قد تكون هناك سجلات تابعة': 'Dependent records may exist',
  'حدد سجلًا واحدًا على الأقل': 'Select at least one record',
  'اسمح بالنوافذ المنبثقة': 'Allow pop-up windows',
  'تحقق من الإنترنت': 'Check your internet connection',
  'السجل غير موجود': 'Record not found',
  'لا توجد أرفف في هذا المستودع': 'No shelves in this warehouse',
  'تعذر تحميل بيانات المستودعات': 'Could not load facilities data',
  'للأرفف': 'for shelves', 'ربط أحداث النموذج': 'Bind form events',
  'النموذج المنبثق': 'Modal form',
  'إدارة المستودعات والهيكل التنظيمي': 'Facilities & organization',
  'بطاقات إحصائية': 'Statistics', 'جدول المستودعات': 'Warehouses table',
  'جدول مناطق التخزين': 'Storage areas table', 'جدول الأقسام': 'Sections table',
  'جدول الأرفف': 'Shelves table',
  'لا توجد مستودعات. اضغط "مستودع جديد" للبدء.':
    'No warehouses. Press "New warehouse" to start.',

  // ── login / auth ──────────────────────────────────────────────────────────
  'تسجيل الدخول': 'Sign in', 'إنشاء حساب': 'Create account',
  'مرحبًا بعودتك': 'Welcome back', 'دخول': 'Sign in',
  'جارٍ التحقق…': 'Checking…', 'فشل الدخول': 'Sign-in failed',
  'الحساب غير نشط. راجع المدير.': 'This account is inactive. Contact your administrator.',
  'الرجاء إدخال البريد وكلمة المرور': 'Enter your email and password',
  'تم إنشاء الحساب. يلزم تفعيل المدير قبل الدخول.':
    'Account created. An administrator must activate it before you can sign in.',
  'وضع عدم الاتصال': 'Offline mode', 'لا يوجد اتصال': 'You are offline',

  // ── dashboard / inventory / transactions ─────────────────────────────────
  'إجمالي الوحدات': 'Total units', 'أصناف منخفضة': 'Low-stock items',
  'معاملات معلقة': 'Pending transactions', 'إجمالي الأصناف': 'Total items',
  'أحدث المعاملات': 'Recent transactions', 'تنبيهات': 'Alerts',
  'لا توجد تنبيهات': 'No alerts', 'لا توجد معاملات': 'No transactions',
  'لا توجد أصناف': 'No items', 'صنف جديد': 'New item', 'صنف': 'Item',
  'تعديل الصنف': 'Edit item', 'حذف الصنف': 'Delete item',
  'منخفض': 'Low', 'طبيعي': 'Normal', 'متوقف': 'Inactive',
  'معاملة جديدة': 'New transaction', 'سند توريد': 'Goods receipt (GRN)',
  'سند صرف': 'Issue', 'تسوية زيادة': 'Adjustment increase',
  'تسوية نقص': 'Adjustment decrease', 'رصيد افتتاحي': 'Opening balance',
  'مرتجع من الاستخدام': 'Return from usage', 'مرتجع من عميل': 'Customer return',
  'مرتجع إلى المورد': 'Return to supplier', 'تحويل مخزني': 'Stock transfer',
  'اعتماد': 'Approve', 'رفض': 'Reject', 'سبب الرفض:': 'Rejection reason:',
  'تم الاعتماد': 'Approved', 'تم الرفض': 'Rejected',
  'المورد/المستلم': 'Supplier / receiver', 'معلقة': 'Pending',
  'معتمدة': 'Approved', 'مرفوضة': 'Rejected', 'الكل': 'All',

  // ── stocktake ─────────────────────────────────────────────────────────────
  'جلسة جرد': 'Stocktake session', 'بدء جلسة جديدة': 'Start new session',
  'جلسات الجرد': 'Stocktake sessions', 'نوع الجرد': 'Stocktake type',
  'نمط العد': 'Count mode', 'جرد دوري': 'Cycle count', 'جرد شامل': 'Full count',
  'جرد مفاجئ': 'Surprise count', 'إعادة عد': 'Recount', 'جرد معلن': 'Visible count',
  'جرد أعمى': 'Blind count', 'إرسال للمراجعة': 'Submit for review',
  'اعتماد الجرد': 'Approve count', 'رفض وإعادة العد': 'Reject / recount',
  'تسوية الأسطر المحددة': 'Settle selected lines', 'إنهاء الجلسة': 'Close session',
  'أسطر تم عدها': 'Lines counted', 'مجموع ما تم عده': 'Total counted',
  'لا توجد جلسات جرد': 'No stocktake sessions', 'الجرد': 'Stocktake',

  // ── reports ───────────────────────────────────────────────────────────────
  'مركز التقارير': 'Reports center', 'نتائج التقرير': 'Report results',
  'عدد الصفوف': 'Rows', 'حركة المخزون التفصيلية': 'Detailed stock movements',
  'أرصدة المخزون الحالية': 'Current stock balances',
  'بطاقة حركة الصنف': 'Item ledger card',
  'الأصناف تحت حد الأمان': 'Low / critical stock',
  'تقرير التوريدات والاستلام': 'Receipts report',
  'تقرير الصرف والاستهلاك': 'Issues & consumption',
  'ملخص المعاملات حسب الحالة': 'Transaction status summary',
  'ملخص المستودعات': 'Warehouse summary',
  'التحويلات بين المستودعات': 'Warehouse transfers',
  'المرتجعات والاسترداد': 'Returns & recovery',
  'نتائج الجرد وفروقات التسوية': 'Stocktake & variances',
  'سجل التدقيق والعمليات': 'Audit trail',
  'الدفعات والصلاحية': 'Batch & expiry',
  'المعاملات بانتظار الاعتماد': 'Pending approvals',
  'اختر تقريرًا': 'Choose a report',
  'من': 'From', 'إلى': 'To', 'كل المستودعات': 'All warehouses',
  'لا توجد نتائج مطابقة للفلاتر': 'No rows match the selected filters',
  'طباعة / PDF': 'Print / PDF', 'كل التقارير': 'All reports',
  'الرصيد الافتتاحي': 'Opening balance', 'الوارد': 'Inbound', 'الصادر': 'Outbound',
  'التوريد': 'Receipts', 'الصرف': 'Issues', 'الإجمالي': 'Total',
  'ملاحظة: هذا تقرير لقطة حالية؛ الفترة الزمنية لا تعيد بناء رصيد تاريخي.':
    'Note: this is a current snapshot; the date range does not rebuild historical balances.',

  // ── settings / profile / about ────────────────────────────────────────────
  'إعدادات النظام': 'System settings', 'المستخدمون': 'Users',
  'الوحدات': 'Units', 'المظهر': 'Appearance', 'بيانات الشركة': 'Company data',
  'أدوات البيانات': 'Data tools', 'إعدادات الطباعة': 'Print settings',
  'اسم الشركة': 'Company name', 'الهاتف': 'Phone', 'العنوان': 'Address',
  'الوضع الليلي': 'Dark mode', 'لون الواجهة': 'Theme',
  'معلومات الحساب': 'Account information', 'الملف الشخصي': 'Profile',
  'تغيير كلمة المرور': 'Change password', 'الصلاحيات الفعلية': 'Effective permissions',
  'حول النظام والصيغ': 'About & formulas', 'صيغ الحساب': 'Formulas',
  'مصفوفة الأدوار': 'Role matrix', 'المسؤول': 'Administrator',
  'مشرف مستودع': 'Warehouse manager', 'أمين مخزن': 'Storekeeper', 'مدقق': 'Auditor'
};

// English → Arabic dictionary used by legacy pages that still render English
// markup. It is built from the reverse of EN first, then extended with the
// labels that only exist in the legacy demo screens.
const AR = {};
for (const [ar, en] of Object.entries(EN)) {
  if (!(en in AR)) AR[en] = ar;
}
Object.assign(AR, {
  // shell / navigation / auth
  'Profile': 'الملف الشخصي', 'My profile': 'ملفي', 'Sign in': 'تسجيل الدخول',
  'Sign-in failed': 'فشل تسجيل الدخول', 'Create account': 'إنشاء حساب',
  'Sign out': 'تسجيل الخروج', 'Language': 'اللغة', 'English': 'الإنجليزية',
  'Warehouse Management System': 'نظام إدارة المستودعات',
  'Switch to English': 'التبديل إلى الإنجليزية', 'Switch to Arabic': 'التبديل إلى العربية',

  // common fields / actions
  'Invoicing': 'الفواتير', 'Invoices': 'الفواتير', 'Customer Invoices': 'فواتير العملاء',
  'New invoice': 'فاتورة جديدة', 'Number': 'الرقم', 'Customer': 'العميل',
  'Due': 'الاستحقاق', 'Residual': 'المتبقي', 'Paid': 'مدفوعة', 'Overdue': 'متأخرة',
  'Contacts': 'جهات الاتصال', 'New contact': 'جهة اتصال جديدة',
  'Company': 'شركة', 'Company · Customer': 'شركة · عميل', 'Street': 'الشارع',
  'City': 'المدينة', 'Country': 'الدولة', 'Salesperson': 'المندوب',
  'CRM': 'إدارة العملاء', 'Pipeline': 'مسار المبيعات', 'Reporting': 'التقارير',
  'Configuration': 'الإعدادات', 'Qualified': 'مؤهل', 'Proposition': 'عرض سعر',
  'Won': 'تم الفوز', 'Contact': 'جهة اتصال', 'Expected Revenue': 'الإيرادات المتوقعة',
  'Probability': 'الاحتمالية', 'Employees': 'الموظفون', 'New employee': 'موظف جديد',
  'Department': 'القسم', 'Job Title': 'المسمى الوظيفي', 'Manager': 'المدير',
  'Join Date': 'تاريخ الانضمام', 'Sales Manager': 'مدير المبيعات',
  'Sales': 'المبيعات', 'Account Manager': 'مدير حسابات', 'Sales Rep': 'مندوب مبيعات',
  'Products': 'المنتجات', 'Storable': 'مخزّن', 'Storable Product': 'منتج مخزّن',
  'On Hand': 'المتاح', 'Free to Use': 'المتاح للاستخدام', 'Available': 'متاح',
  'Low Stock': 'مخزون منخفض', 'Out of Stock': 'نفد المخزون',
  'Point of Sale': 'نقطة البيع', 'Guest Customer': 'عميل زائر', 'Subtotal': 'المجموع الفرعي',
  'Tax 15%': 'ضريبة 15%', 'Pay': 'دفع', 'Cart is empty': 'السلة فارغة',
  'Payment confirmed ✔': 'تم تأكيد الدفع ✔', 'Product Name': 'اسم المنتج',
  'e.g. Office Desk': 'مثال: مكتب', 'Project': 'المشروع', 'Tasks': 'المهام',
  'New Task': 'مهمة جديدة', 'New task': 'مهمة جديدة', 'To Do': 'قيد الانتظار',
  'In Progress': 'قيد التنفيذ', 'Review': 'مراجعة', 'Done': 'منتهية',
  'Assignee': 'المسؤول', 'Priority': 'الأولوية', 'High': 'عالية', 'Medium': 'متوسطة',
  'Low': 'منخفضة', 'Deadline': 'الموعد النهائي', 'Estimated Hours': 'الساعات المقدرة',
  'Tags': 'الوسوم', 'Website': 'الموقع', 'My Company Website': 'موقع الشركة',
  'Edit': 'تعديل', 'Publish': 'نشر', 'Published': 'منشور', 'Draft': 'مسودة',
  'Welcome to My Company': 'مرحباً بكم في شركتنا',
  'Furniture and office supplies for modern businesses': 'أثاث ومستلزمات مكتبية للشركات الحديثة',
  'Get in Touch': 'تواصل معنا', 'Home': 'الرئيسية', 'About Us': 'من نحن',
  'Blog': 'المدونة', 'Pricing': 'الأسعار', 'Orders': 'الطلبيات',
  'Quotation': 'عرض سعر', 'Quotation Sent': 'عرض سعر مرسل',
  'Sales Order': 'أمر بيع', 'Cancelled': 'ملغى', 'Delivery': 'التسليم',
  'Locked': 'مقفل', 'Order Date': 'تاريخ الطلب',
  'Expiration Date': 'تاريخ الانتهاء', 'Delivery Address': 'عنوان التسليم',
  'Payment Terms': 'شروط الدفع', 'Invoice Date': 'تاريخ الفاتورة',
  'Due Date': 'تاريخ الاستحقاق', 'Posted': 'مرحّل', 'Journal': 'دفتر اليومية',
  'Customer Invoice': 'فاتورة عميل', 'Reference': 'المرجع', 'Category': 'الفئة',
  'Sales Price': 'سعر البيع', 'Cost': 'التكلفة', 'units': 'وحدات',
  'Total Revenue': 'إجمالي الإيرادات', 'Confirmed Orders': 'الطلبيات المؤكدة',
  'Average Order Value': 'متوسط قيمة الطلب', 'Quotations Sent': 'عروض الأسعار المرسلة',
  'Revenue by Month': 'الإيرادات حسب الشهر',
  'Jan': 'يناير', 'Feb': 'فبراير', 'Mar': 'مارس', 'Apr': 'أبريل', 'May': 'مايو',
  'Jun': 'يونيو', 'Jul': 'يوليو', 'Aug': 'أغسطس', 'Sep': 'سبتمبر', 'Oct': 'أكتوبر',
  'Nov': 'نوفمبر', 'Dec': 'ديسمبر',
  'Save': 'حفظ', 'Discard': 'تجاهل', 'Saved': 'تم الحفظ', 'Saved ✔': 'تم الحفظ ✔',
  'Page': 'صفحة', 'All': 'الكل', 'Search': 'بحث', 'Search...': 'بحث...',
  'Search apps...': 'ابحث عن تطبيقات…', 'No records': 'لا توجد سجلات',
  'General': 'عام', 'general': 'عام', 'sales': 'المبيعات', 'support': 'الدعم',
  'Channels': 'القنوات', 'New channel': 'قناة جديدة',
  'Write a message...': 'اكتب رسالة...', 'Send': 'إرسال', 'User': 'مستخدم',
  'Editor opened': 'تم فتح المحرر',
  'Person': 'شخص', 'Furniture / Office': 'أثاث / مكتبي',
  'Furniture / Seating': 'أثاث / مقاعد', 'Furniture / Storage': 'أثاث / تخزين',
  'Lighting': 'إضاءة', '30% Advance, Balance on delivery': '30% دفعة مقدمة، والباقي عند التسليم',
  'Design': 'تصميم', 'Frontend': 'واجهة أمامية', 'Design, Frontend': 'تصميم، واجهة أمامية',
  'ACTIVE': 'نشط', 'INACTIVE': 'غير نشط', 'SUSPENDED': 'موقوف',
  'Pending': 'بانتظار', 'Completed': 'مكتمل', 'Closed': 'مغلق',
  'In progress': 'قيد التنفيذ', 'In transit': 'قيد النقل',
  'Partially received': 'استلام جزئي', 'Return in transit': 'مرتجع قيد النقل',
  'Received': 'مستلم', 'Returned to source': 'أعيد للمصدر',
  'Pending review': 'بانتظار المراجعة', 'Submitted for review': 'مقدم للمراجعة',
  'Pending sync': 'بانتظار المزامنة', 'Error': 'خطأ', 'Conflict': 'تعارض',
  'Archived': 'مؤرشف', 'Approved': 'معتمد', 'Rejected': 'مرفوض',
  'Pending approval': 'بانتظار الاعتماد', 'Failed': 'فشل', 'Synced': 'تمت المزامنة'
});

// Dynamic phrases rendered as a single text node (variables inside).
const PATTERNS = [
  [/^لا توجد مستودعات\. اضغط\s*"?(.+?)"?\s*للبدء\.?$/s, (m) => `No warehouses. Press "${m[1].trim()}" to start.`],
  [/^لا توجد مناطق تخزين في\s+(.+)$/s, (m) => `No storage areas in ${m[1]}`],
  [/^لا توجد أقسام في\s+(.+)$/s, (m) => `No sections in ${m[1]}`],
  [/^لا توجد أرفف في\s+(.+)$/s, (m) => `No shelves in ${m[1]}`],
  [/^تنبيه: يوجد\s+(.+)$/s, (m) => `Warning: ${m[1]}`],
  [/^لا توجد أرفف في هذا المستودع\s*(.*)$/s, () => 'No shelves in this warehouse'],
  [/^تعذر تحميل بيانات المستودعات\s*(.*)$/s, () => 'Could not load facilities data'],
  [/^اختر مستودعًا أولًا\.?$/s, () => 'Choose a warehouse first.'],
  [/^(\d+)\s*صنف$/, (m) => `${m[1]} items`],
  [/^(\d+)\s*مستودع$/, (m) => `${m[1]} warehouses`],
  [/^(\d+)\s*منطقة$/, (m) => `${m[1]} areas`],
  [/^(\d+)\s*قسم$/, (m) => `${m[1]} sections`],
  [/^(\d+)\s*رف$/, (m) => `${m[1]} shelves`]
];

// English → Arabic dynamic phrases (legacy screens).
const AR_PATTERNS = [
  [/^Published\s*·\s*(\d+)\s+sections?$/i, (m) => `منشور · ${m[1]} أقسام`],
  [/^Published\s*·\s*(\d+)\s+items?$/i, (m) => `منشور · ${m[1]} عناصر`],
  [/^Published\s*·\s*(\d+)\s+posts?$/i, (m) => `منشور · ${m[1]} مقالات`],
  [/^On hand:\s*(.+)$/i, (m) => `المتاح: ${m[1]}`],
  [/^Page\s+(\d+)$/i, (m) => `صفحة ${m[1]}`],
  [/^(\d+)\s*\/\s*(\d+)$/i, (m) => `${m[1]} / ${m[2]}`],
  [/^Opportunity\s*·\s*(.+)$/i, (m) => `فرصة · ${m[1]}`],
  [/^Storable Product\s*·\s*(.+)$/i, (m) => `منتج مخزّن · ${m[1]}`],
  [/^Customer Invoice\s*·\s*(.+)$/i, (m) => `فاتورة عميل · ${m[1]}`],
  [/^Sales Order\s*·\s*(.+)$/i, (m) => `أمر بيع · ${m[1]}`],
  [/^Company\s*·\s*Customer$/i, () => 'شركة · عميل'],
  [/^Sales Manager\s*·\s*Sales$/i, () => 'مدير المبيعات · المبيعات'],
  [/^Website Redesign\s*·\s*To Do$/i, () => 'إعادة تصميم الموقع · قيد الانتظار'],
  [/^March\s+(\d{4})$/i, (m) => `مارس ${m[1]}`],
  [/^Tax\s+(\d+)%$/i, (m) => `ضريبة ${m[1]}%`],
  [/^(\d+)\s+Invoices?$/i, (m) => `${m[1]} فواتير`],
  [/^(\d+)\s+Delivery$/i, (m) => `${m[1]} تسليم`],
  [/^(\d+)\s+units?$/i, (m) => `${m[1]} وحدات`],
  [/^(\d+(?:\.\d+)?)\s*h$/i, (m) => `${m[1]} ساعة`],
  [/^Payment confirmed\s*✔$/i, () => 'تم تأكيد الدفع ✔'],
  [/^Saved\s*✔$/i, () => 'تم الحفظ ✔']
];

const ATTRS = ['placeholder', 'title', 'aria-label', 'value'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

function translateText(raw) {
  if (!raw) return null;
  const lead = raw.match(/^\s*/)[0];
  const tail = raw.match(/\s*$/)[0];
  const core = raw.trim();
  if (!core) return null;
  const dictionary = LANG === 'ar' ? AR : EN;
  if (dictionary[core] != null) return lead + dictionary[core] + tail;
  const patterns = LANG === 'ar' ? AR_PATTERNS : PATTERNS;
  for (const [re, fn] of patterns) {
    const m = core.match(re);
    if (m) return lead + fn(m) + tail;
  }
  return null;
}

const seenNodes = new WeakSet();

/** Translate an already-rendered DOM subtree in either direction. */
export function localizeDom(root = document.body) {
  if (!root) return false;
  let changed = false;

  // Text nodes
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('[data-no-i18n]')) return NodeFilter.FILTER_REJECT;
      if (seenNodes.has(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const next = translateText(node.nodeValue);
    if (next != null && next !== node.nodeValue) {
      node.nodeValue = next;
      changed = true;
    }
    seenNodes.add(node);
  }

  // Attributes
  const els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label]') : [];
  for (const el of els) {
    if (el.closest('[data-no-i18n]')) continue;
    for (const a of ATTRS) {
      const v = el.getAttribute?.(a);
      if (!v) continue;
      const next = translateText(v);
      if (next != null && next !== v) { el.setAttribute(a, next); changed = true; }
    }
  }
  return changed;
}

let observer = null;
function startObserver() {
  if (observer || typeof MutationObserver === 'undefined') return;
  let scheduled = false;
  observer = new MutationObserver((records) => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach(n => {
            if (n.nodeType === 1) localizeDom(n);
            else if (n.nodeType === 3) {
              const next = translateText(n.nodeValue);
              if (next != null) n.nodeValue = next;
            }
          });
        }
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function applyDocumentLang() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = dir();
  document.documentElement.classList.toggle('lang-en', LANG === 'en');
  document.documentElement.classList.toggle('lang-ar', LANG === 'ar');
  localStorage.setItem(LS_LANG, LANG);
}

export function setLang(lang) {
  LANG = String(lang).toLowerCase() === 'en' ? 'en' : 'ar';
  applyDocumentLang();
  // Re-localize static shell attributes (for example the mobile nav label)
  // that are not re-rendered by the page router on a language switch.
  localizeDom(document.body);
  window.dispatchEvent(new CustomEvent('orshap-lang-changed', { detail: { lang: LANG } }));
}

export function toggleLang() {
  setLang(LANG === 'ar' ? 'en' : 'ar');
  return LANG;
}

export function initI18n() {
  applyDocumentLang();
  startObserver();
}
