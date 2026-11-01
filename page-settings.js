// ============================================================================
// OW — Settings
// ----------------------------------------------------------------------------
// General system flags, users & roles, permission matrix, units/conversions,
// item categories, local cache tools, and live server snapshot / restore.
// All writes go through guarded store mutations and require a live server connection.
// ============================================================================
import { OW } from './core-registry.js';
import { tx, friendlyError } from './core-i18n.js';
import {
  pageHead, card, table, empty, badge, btn, alertBox, controlPanel, tabs,
  input, select, textarea, downloadCSV, esc
} from './core-ui.js';
import {
  store, pullAll, upsertSetting, setting, queueSnapshot, itemNameOnly,
  insertRow, updateRow
} from './core-store.js';
import {
  updateUser, replaceRolePermissions, adminLinkProfile,
  createUnit, updateUnit, deleteUnit,
  createUnitConversion, updateUnitConversion, deleteUnitConversion,
  createCategory, updateCategory, deleteCategory
} from './core-api-supabase.js';
import {
  canManageSettings, canManageSystemSettings, canAdministerProfiles,
  canAccessWarehouse, isAdmin, can, role as userRole
} from './core-rbac.js';
import { rpc } from './core-supabase.js';
import {
  roleLabel, statusLabel, fmtDateTime, fmtNum, todayISO,
  permissionLabel, permissionDescription, permissionGroupLabel
} from './core-utils.js';
import { toast } from './core-toast.js';
import { isSoundMuted } from './core-sound.js';
import { modal, confirmDialog, promptDialog } from './core-modal.js';

const F = {
  tab: 'general', role: 'CLERK', permSearch: '', item: '',
  import: {
    entity: 'warehouses', fileName: '', headers: [], rows: [], mapping: {},
    result: null, busy: false, updateExisting: false
  },
  backup: {
    busy: false, fileName: '', fileSize: 0, snapshot: null, summary: null
  },
  authorizationGrants: [],
  authorizationDecisions: [],
  authorizationLoaded: false,
  authorizationLoading: false,
  authorizationError: '',
  authorizationGrantFilter: { subject: 'ALL', effect: 'ALL', status: 'ALL', search: '' }
};

const LIVE_BACKUP_META = 'orshap_live_backup_meta_v1';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'WAREHOUSE_MANAGER', 'CLERK', 'VIEWER'];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];

/* ── master-data import wizard ──────────────────────────────────────────── */
// Field aliases let the same CSV work with English keys, Arabic headers and
// the field labels from the source import workbook. Columns are mapped in the
// browser; nothing is uploaded until the user presses Import.
const IMPORT_ENTITIES = {
  warehouses: {
    table: 'warehouses',
    icon: 'fa-warehouse',
    label: ['المستودعات', 'Warehouses'],
    hint: ['ابدأ بالمستودعات، ثم مناطق التخزين، ثم الأرفف.', 'Start with warehouses, then storage areas, then shelves.'],
    fields: [
      { key: 'code', label: ['رمز المستودع', 'Warehouse code'], required: true,
        aliases: ['code', 'warehousecode', 'warehouse', 'رمزالمستودع', 'الكود', 'رمز'] },
      { key: 'name', label: ['اسم المستودع', 'Warehouse name'], required: true,
        aliases: ['name', 'warehousename', 'اسمالمستودع', 'الاسم'] }
    ]
  },
  storage_areas: {
    table: 'storage_areas',
    icon: 'fa-layer-group',
    label: ['مناطق التخزين', 'Storage areas'],
    hint: ['كل منطقة تخزين تحتاج رمز مستودع موجود مسبقًا.', 'Each storage area needs an existing warehouse code.'],
    fields: [
      { key: 'warehouse_code', label: ['رمز المستودع', 'Warehouse code'], required: true,
        aliases: ['warehousecode', 'warehouse', 'parentwarehousecode', 'المستودع', 'رمزالمستودع', 'كودالمستودع'] },
      { key: 'code', label: ['رمز منطقة التخزين', 'Storage-area code'], required: true,
        aliases: ['code', 'storageareacode', 'areacode', 'area', 'رمزمنطقةالتخزين', 'رمزالمنطقة', 'المنطقة', 'الكود'] },
      { key: 'name', label: ['اسم منطقة التخزين', 'Storage-area name'], required: true,
        aliases: ['name', 'storageareaname', 'areaname', 'اسممنطقةالتخزين', 'اسمالمخزن', 'الاسم'] },
      { key: 'is_active', label: ['نشطة (true/false)', 'Active (true/false)'],
        aliases: ['isactive', 'active', 'نشط', 'نشطة', 'الحالة'] }
    ]
  },
  shelves: {
    table: 'shelves',
    icon: 'fa-bars-staggered',
    label: ['الأرفف', 'Shelves'],
    hint: ['المستودع ومنطقة التخزين والرمز مطلوبة. المسار الكامل اختياري.', 'Warehouse, storage area and code are required. Full path is optional.'],
    fields: [
      { key: 'warehouse_code', label: ['رمز المستودع', 'Warehouse code'], required: true,
        aliases: ['warehousecode', 'warehouse', 'parentwarehousecode', 'المستودع', 'رمزالمستودع'] },
      { key: 'storage_area_code', label: ['رمز منطقة التخزين', 'Storage-area code'], required: true,
        aliases: ['storageareacode', 'areacode', 'area', 'منطقةالتخزين', 'المنطقة', 'رمزمنطقةالتخزين', 'رمزالمنطقة'] },
      { key: 'code', label: ['رمز الرف', 'Shelf code'], required: true,
        aliases: ['code', 'shelfcode', 'رقمالرف', 'رمزالرف', 'الكود'] },
      { key: 'full_path', label: ['المسار الكامل', 'Full path'],
        aliases: ['fullpath', 'path', 'المسارالكامل', 'المسار', 'الموقع'] }
    ]
  },
  items: {
    table: 'items',
    icon: 'fa-box',
    label: ['الأصناف', 'Items'],
    hint: ['يمكن استيراد الأصناف بعد المستودعات والمواقع. الكميات الافتتاحية تُدار من شاشة الأرصدة الافتتاحية.', 'Import items after warehouses and locations. Opening quantities are handled in the opening-balance workspace.'],
    fields: [
      { key: 'code', label: ['رمز الصنف / SKU', 'Item code / SKU'], required: true,
        aliases: ['code', 'sku', 'itemcode', 'itemnumber', 'رمزالصنف', 'كودالصنف', 'الرمز'] },
      { key: 'item_number', label: ['رقم الصنف', 'Item number'],
        aliases: ['itemnumber', 'number', 'رقمالصنف'] },
      { key: 'name_ar', label: ['الاسم بالعربية', 'Arabic item name'],
        aliases: ['namear', 'arabicname', 'arabicitemname', 'الاسمبالعربية', 'الاسمالعربي', 'الاسم'] },
      { key: 'name_en', label: ['الاسم بالإنجليزية', 'English item name'],
        aliases: ['nameen', 'englishname', 'name', 'itemname', 'englishitemname', 'الاسمبالإنجليزية', 'الاسمالإنجليزي'] },
      { key: 'category', label: ['الفئة', 'Category'],
        aliases: ['category', 'categoryname', 'الفئة', 'التصنيف'] },
      { key: 'category_id', label: ['معرف الفئة', 'Category ID'],
        aliases: ['categoryid', 'معرفالفئة'] },
      { key: 'status', label: ['الحالة (ACTIVE/INACTIVE)', 'Status (ACTIVE/INACTIVE)'],
        aliases: ['status', 'state', 'الحالة', 'الوضع'] },
      { key: 'base_unit', label: ['الوحدة الأساسية', 'Base unit'],
        aliases: ['baseunit', 'unit', 'الوحدةالأساسية', 'الوحدة'] },
      { key: 'purchase_unit', label: ['وحدة الشراء', 'Purchase unit'],
        aliases: ['purchaseunit', 'الوحدةالشراء', 'وحدةالشراء'] },
      { key: 'safety_stock', label: ['حد الأمان', 'Safety stock'],
        aliases: ['safetystock', 'minstock', 'حدالأمان', 'الحدالأدنى'] },
      { key: 'weight', label: ['الوزن', 'Weight'],
        aliases: ['weight', 'الوزن'] },
      { key: 'cost', label: ['التكلفة', 'Cost'],
        aliases: ['cost', 'price', 'التكلفة', 'السعر'] },
      { key: 'supplier', label: ['المورد', 'Supplier'],
        aliases: ['supplier', 'vendor', 'المورد'] },
      { key: 'hazardous', label: ['مادة خطرة (true/false)', 'Hazardous (true/false)'],
        aliases: ['hazardous', 'dangerous', 'مادةخطرة', 'خطرة', 'خطر'] },
      { key: 'default_warehouse_code', label: ['رمز المستودع الافتراضي', 'Default warehouse code'],
        aliases: ['defaultwarehousecode', 'warehousecode', 'المستودعالافتراضي', 'رمزالمستودعالافتراضي'] },
      { key: 'default_storage_area_code', label: ['رمز منطقة التخزين الافتراضية', 'Default storage-area code'],
        aliases: ['defaultstorageareacode', 'storageareacode', 'منطقةالتخزينالافتراضية', 'رمزمنطقةالتخزينالافتراضية'] },
      { key: 'default_shelf_code', label: ['رمز الرف الافتراضي', 'Default shelf code'],
        aliases: ['defaultshelfcode', 'shelfcode', 'الرفالافتراضي', 'رمزالرفالافتراضي'] },
      { key: 'description', label: ['الوصف', 'Description'],
        aliases: ['description', 'notes', 'الوصف', 'ملاحظات'] }
    ]
  }
};

const IMPORT_MAX_ROWS = 5000;
const IMPORT_TRUE = new Set(['true', '1', 'yes', 'y', 'active', 'نشط', 'نشطة', 'نعم', 'فعال']);
const IMPORT_FALSE = new Set(['false', '0', 'no', 'n', 'inactive', 'غيرنشط', 'غيرنشطة', 'لا', 'معطل', 'معطلة']);

const FLAGS = [
  { key: 'USE_UNIT_CONVERSION', def: true,
    ar: ['تفعيل تحويل الوحدات', 'Enable unit conversion'],
    descAr: 'السماح بإدخال الكميات بوحدات الشراء والتحويل إلى الوحدة الأساسية.',
    descEn: 'Allow quantities in purchase units and convert to the base unit.' },
  { key: 'FEATURE_USE_COST_SUPPLIER', def: false,
    ar: ['تكلفة الصنف والمورد', 'Item cost & supplier'],
    descAr: 'إظهار حقول التكلفة والمورد في نماذج الأصناف والتقارير.',
    descEn: 'Show cost and supplier fields on item forms and reports.' }
];

const FALLBACK_PERMISSIONS = [
  'page:dashboard:access', 'page:inventory:access', 'page:transactions:access',
  'page:transfers:access', 'page:stocktake:access', 'page:facilities:access',
  'page:reports:access', 'page:settings:access',
  'action:transaction:create', 'action:transaction:grn:create', 'action:transaction:issue:create',
  'action:transaction:adjustment:create', 'action:transaction:return:create',
  'action:transaction:approve', 'action:transaction:reject',
  'action:stock_transfer:create', 'action:stock_transfer:view',
  'action:stocktake:start', 'action:stocktake:count', 'action:stocktake:submit',
  'action:stocktake:approve', 'action:stocktake:settle', 'action:stocktake:close',
  'action:stocktake:view_system_qty', 'action:settings:manage',
  'action:chat:manage', 'action:transaction:opening_balance:create',
  'table:inventory_ledger:view', 'table:transaction_ledger:view', 'table:audit_logs:view'
];

/* ── small helpers ───────────────────────────────────────────────────────── */

function canManage() { return canManageSettings(); }

function canManageImportEntity(entity, action = 'create', existing = null, row = null) {
  if (entity === 'warehouses') {
    if (action === 'create') {
      const assigned = window.__session?.profile?.assigned_warehouse_ids;
      return userRole() === 'SUPER_ADMIN'
        || (Array.isArray(assigned) && assigned.length === 0 && can('action:warehouse:manage'));
    }
    return can('action:warehouse:manage')
      && (!existing || canAccessWarehouse(existing.id));
  }
  if (entity === 'storage_areas' || entity === 'shelves') {
    const warehouseId = existing?.warehouse_id || row?._warehouse_id || null;
    return can('action:facility:manage')
      && (!warehouseId || canAccessWarehouse(warehouseId));
  }
  if (entity === 'items') {
    return can(action === 'update' ? 'action:item:update' : 'action:item:create');
  }
  return false;
}

function flagValue(flag) {
  const v = setting(flag.key, flag.def);
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  return flag.def;
}
function permCatalog() {
  const rows = store.get('permissions');
  if (rows.length) return rows.map(r => ({ key: r.key, description: r.description || '' }));
  const keys = new Set(FALLBACK_PERMISSIONS);
  for (const r of store.get('role_permissions')) keys.add(r.permission_key);
  return [...keys].sort().map(key => ({ key, description: '' }));
}
function groupedPermissions() {
  const map = new Map();
  for (const p of permCatalog()) {
    const group = p.key.includes(':') ? p.key.split(':')[0] : 'other';
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(p);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
function roleKeys(roleName) {
  return store.get('role_permissions')
    .filter(p => String(p.role_name).toUpperCase() === roleName)
    .map(p => p.permission_key);
}

function reload() {
  import('./core-router.js').then(({ showPage }) => showPage('settings'));
}

/* ── render ──────────────────────────────────────────────────────────────── */

function render() {
  const banned = !canManage();
  return `
  ${pageHead(tx('الإعدادات', 'Settings'),
    tx('إعدادات النظام والمستخدمين والصلاحيات والوحدات', 'System flags, users, permissions and units'),
    `${btn(`<i class="fa-solid fa-rotate"></i> ${tx('تحديث', 'Refresh')}`, 'onclick="OW.wms.reloadSettings()"', 'secondary')}`)}
  ${controlPanel({
    breadcrumb: [{ label: tx('النظام', 'System') }, { label: tx('الإعدادات', 'Settings') }],
    search: false
  })}
  <div class="o_page_body">
    ${banned ? alertBox(tx('ليست لديك صلاحية إدارة الإعدادات — العرض للقراءة فقط.',
      'You do not have settings management permission — read-only view.'), 'warning') : ''}
    ${tabs([
      { value: 'general', label: tx('عام', 'General') },
      { value: 'users', label: tx('المستخدمون', 'Users'), count: store.get('profiles').length },
      { value: 'roles', label: tx('مصفوفة الصلاحيات', 'Permission matrix'), count: store.get('role_permissions').length },
      { value: 'authorization', label: tx('التفويض المتقدم', 'Advanced authorization'), count: F.authorizationGrants.filter(g => !g.revoked_at).length },
      { value: 'units', label: tx('الوحدات والتحويلات', 'Units & conversions'), count: store.get('units').length },
      { value: 'categories', label: tx('تصنيفات الأصناف', 'Item categories'), count: store.get('item_categories').length },
      { value: 'import', label: tx('استيراد البيانات', 'Data import') },
      { value: 'data', label: tx('البيانات والنسخ', 'Data & backup') }
    ].map(t => ({ ...t, onclick: `OW.wms.settingsTab('${t.value}')` })), F.tab)}
    ${F.tab === 'general' ? `${!canManageSystemSettings() ? alertBox(tx('تعديل أعلام النظام يتطلب منحة صريحة لصلاحية إدارة الإعدادات.', 'System settings require an explicit settings-management grant.'), 'warning') : ''}${renderGeneral(banned || !canManageSystemSettings())}`
      : F.tab === 'users' ? `${!canAdministerProfiles() ? alertBox(tx('إدارة ملفات المستخدمين متاحة للمسؤول الأعلى فقط.', 'Profile administration is restricted to SUPER_ADMIN. Database authorization remains authoritative.'), 'warning') : ''}${renderUsers(banned || !canAdministerProfiles())}`
      : F.tab === 'roles' ? `${!canAdministerProfiles() ? alertBox(tx('إدارة صلاحيات الأدوار متاحة للمسؤول الأعلى فقط.', 'Role-permission administration is restricted to SUPER_ADMIN.'), 'warning') : ''}${renderRoles(banned || !canAdministerProfiles())}`
      : F.tab === 'authorization' ? (canAdministerProfiles()
        ? renderAuthorization(banned)
        : alertBox(tx('إدارة التفويض المتقدم متاحة للمسؤول الأعلى فقط.', 'Advanced authorization administration is restricted to SUPER_ADMIN.'), 'warning'))
      : F.tab === 'units' ? `${!canManageSystemSettings() ? alertBox(tx('إدارة الوحدات والتحويلات تتطلب منحة صريحة لصلاحية إدارة الإعدادات.', 'Unit and conversion administration requires an explicit settings-management grant.'), 'warning') : ''}${renderUnits(banned || !canManageSystemSettings())}`
      : F.tab === 'categories' ? renderCategories()
      : F.tab === 'import' ? renderImport(banned)
      : renderData(banned)}
  </div>`;
}

function renderGeneral(banned) {
  const q = queueSnapshot();
  const canWrite = !banned && navigator.onLine && !window.__session?.offline;
  return `
    <div class="o_grid" style="grid-template-columns:1.4fr 1fr">
      ${card(`<i class="fa-solid fa-sliders"></i> ${tx('أعلام النظام', 'System flags')}`,
        `${alertBox(tx('لا يمنح الدور أو الإعداد العام حق اعتماد السند الذي أنشأه المستخدم. الاعتماد الذاتي يتطلب تفويضاً فردياً صريحاً وتفعيل السماح بالاعتماد الذاتي في ملف المستخدم.', 'A role or global setting does not grant permission to approve a voucher created by the same user. Self-approval requires an explicit user-scoped delegation and the user profile self-approval flag.'), 'info')}
        <div class="o_setting_list">
          ${FLAGS.map(f => {
            const on = flagValue(f);
            return `<div class="o_setting_row">
              <div><b>${f.ar[0] && (tx(f.ar[0], f.ar[1]))}</b>
                <p>${tx(f.descAr, f.descEn)}</p></div>
              <label class="o_switch">
                <input type="checkbox" data-flag="${f.key}" ${on ? 'checked' : ''} ${canWrite ? '' : 'disabled'}>
                <span class="o_switch_slider"></span>
              </label>
            </div>`;
          }).join('')}
        </div>
        <p class="o_hint" style="margin-top:10px">${tx('تعديل أعلام النظام يتطلب اتصالًا مباشرًا بالخادم.',
          'System flag changes require a live server connection.')}</p>`)}
      ${card(`<i class="fa-solid fa-heart-pulse"></i> ${tx('حالة النظام', 'System health')}`,
        `<dl class="o_kv">
          <dt>${tx('المستخدم', 'User')}</dt><dd>${window.__session?.name || '—'}</dd>
          <dt>${tx('الدور', 'Role')}</dt><dd>${roleLabel(window.__session?.role)}</dd>
          <dt>${tx('الاتصال', 'Connection')}</dt><dd>${navigator.onLine ? tx('متصل', 'Online') : tx('دون اتصال', 'Offline')}</dd>
          <dt>${tx('آخر تحديث للبيانات', 'Last data refresh')}</dt><dd>${store.lastSync ? fmtDateTime(store.lastSync) : '—'}</dd>
          <dt>${tx('عمليات معلّقة', 'Queued operations')}</dt><dd>${fmtNum(q.length)}</dd>
          <dt>${tx('المستودعات', 'Warehouses')}</dt><dd>${fmtNum(store.get('warehouses').length)}</dd>
          <dt>${tx('الأصناف', 'Items')}</dt><dd>${fmtNum(store.get('items').length)}</dd>
          <dt>${tx('صفوف المخزون', 'Stock rows')}</dt><dd>${fmtNum(store.get('stock').length)}</dd>
        </dl>
        <div style="margin-top:12px"><a class="o_btn o_btn_secondary o_btn_sm" onclick="showPage('sync')">
          <i class="fa-solid fa-rotate"></i> ${tx('فتح قائمة المزامنة', 'Open sync queue')}</a></div>`)}
    </div>
    ${card(`<i class="fa-solid fa-volume-high"></i> ${tx('أصوات الواجهة', 'Interface sounds')}`,
      `<div class="o_setting_list">
        <div class="o_setting_row">
          <div><b>${tx('تشغيل الأصوات', 'Play interface sounds')}</b>
            <p>${tx('نقرات، تنبيهات، رسائل دردشة، ونجاح/خطأ. يُحفظ الاختيار على هذا الجهاز ويمكن كتمه من الشريط العلوي.',
              'Clicks, alerts, chat messages and success/error tones. The preference is saved on this device and can be muted from the top bar.')}</p></div>
          <label class="o_switch">
            <input type="checkbox" data-sound-toggle-input ${isSoundMuted() ? '' : 'checked'}>
            <span class="o_switch_slider"></span>
          </label>
        </div>
      </div>`)}`;
}

function renderUsers(banned) {
  const canWrite = !banned && navigator.onLine && !window.__session?.offline;
  const users = [...store.get('profiles')].sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  return card('', table(
    [{ label: tx('المستخدم', 'User') }, { label: tx('البريد', 'Email') }, { label: tx('الدور', 'Role') },
     { label: tx('الحالة', 'Status') }, { label: tx('المستودعات', 'Warehouses'), num: true },
     { label: tx('إجراءات', 'Actions') }],
    users.map(u => ({
      cells: [
        `<span class="o_cell_main">${u.name || '—'}</span><div class="o_cell_sub">${String(u.id).slice(0, 8)}</div>`,
        u.email || '—',
        badge(roleLabel(u.role), u.role === 'SUPER_ADMIN' ? 'purple' : u.role === 'CLERK' ? 'gray' : 'blue'),
        badge(u.status ? statusLabel(u.status) : '—', (u.status || '') === 'ACTIVE' ? 'green' : 'red'),
        fmtNum((u.assigned_warehouse_ids || []).length),
        `<div class="o_actions_cell">
          ${canWrite ? `<button class="o_btn o_btn_ghost o_btn_sm" data-user="${u.id}" title="${tx('تعديل', 'Edit')}"><i class="fa-solid fa-pen"></i></button>` : ''}
        </div>`
      ]
    })),
    { emptyTitle: tx('لا يوجد مستخدمون', 'No users') }
  ), `<button class="o_btn o_btn_primary o_btn_sm" onclick="OW.wms.linkUser()" ${canWrite ? '' : 'disabled'}>
        <i class="fa-solid fa-user-plus"></i> ${tx('ربط مستخدم', 'Link user')}</button>`, 'flush-body');
}

function renderRoles(banned) {
  const canWrite = !banned && navigator.onLine && !window.__session?.offline;
  const perms = permCatalog().filter(p => {
    if (!F.permSearch) return true;
    const hay = [p.key, p.description, permissionLabel(p.key), permissionDescription(p.key, p.description)]
      .join(' ').toLowerCase();
    return hay.includes(F.permSearch.toLowerCase());
  });
  const active = new Set(roleKeys(F.role));
  const roleScope = store.get('role_warehouse_scopes').find(row =>
    String(row.role_name || '').toUpperCase() === F.role
  ) || null;
  const scopeMode = String(roleScope?.scope_mode || 'INHERIT').toUpperCase();
  const selectedWarehouseIds = new Set(Array.isArray(roleScope?.warehouse_ids) ? roleScope.warehouse_ids : []);
  const warehouses = [...store.get('warehouses')].sort((a, b) =>
    String(a.code || '').localeCompare(String(b.code || ''))
  );
  const groups = new Map();
  for (const p of perms) {
    const g = p.key.includes(':') ? p.key.split(':')[0] : 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  return `
    ${card(`<i class="fa-solid fa-warehouse"></i> ${tx('نطاق المستودعات للدور', 'Role warehouse scope')}`,
      `<p class="o_hint">${tx(
        'يحدد هذا النطاق الحد الأعلى لمستودعات الدور. إذا كانت للمستخدم مستودعات معيّنة، يُطبّق التقاطع بينها وبين نطاق الدور؛ وإذا لم تكن له تعيينات فردية، يصبح نطاق الدور المحدد هو نطاقه الفعلي.',
        'This is the role-level warehouse ceiling. If a user has explicit warehouse assignments, access is their intersection with this role scope; if not, the role scope supplies the effective warehouse set.'
      )}</p>
      <div class="o_field">
        <label for="roleScopeMode">${tx('طريقة تحديد النطاق', 'Scope mode')}</label>
        <select id="roleScopeMode" class="o_filter_select" ${canWrite ? '' : 'disabled'}>
          <option value="INHERIT" ${scopeMode === 'INHERIT' ? 'selected' : ''}>${tx('يرث نطاق المستخدم', 'Inherit user scope')}</option>
          <option value="SELECTED" ${scopeMode === 'SELECTED' ? 'selected' : ''}>${tx('مستودعات محددة', 'Selected warehouses')}</option>
          <option value="ALL" ${scopeMode === 'ALL' ? 'selected' : ''}>${tx('كل المستودعات', 'All warehouses')}</option>
        </select>
      </div>
      <div class="o_check_grid" id="roleScopeWarehouses" style="margin-top:10px">
        ${warehouses.map(w => `<label class="o_checkbox">
          <input type="checkbox" data-role-warehouse="${esc(w.id)}" ${selectedWarehouseIds.has(w.id) ? 'checked' : ''}
            ${canWrite && scopeMode === 'SELECTED' ? '' : 'disabled'}>
          ${esc(w.code || '')} — ${esc(w.name || '')}
        </label>`).join('') || `<span class="o_muted">${tx('لا توجد مستودعات معرفة.', 'No warehouses are defined.')}</span>`}
      </div>
      <small class="o_hint">${tx(
        'تنبيه: «كل المستودعات» لا يتجاوز تعيين المستودعات الفردي إن كان موجوداً. لا تستخدمه إلا عندما يكون نطاق الدور العام مقصوداً.',
        'Warning: “All warehouses” does not override an individual user assignment when one exists. Use it only when broad role scope is intentional.'
      )}</small>`, '', 'flush-body')}
    <div class="o_perm_bar">
      <select class="o_filter_select" id="permRole">
        ${ROLES.filter(r => r !== 'SUPER_ADMIN').map(r => `<option value="${r}" ${F.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}
      </select>
      <input class="o_filter_input" id="permSearch" placeholder="${tx('تصفية الصلاحيات…', 'Filter permissions…')}" value="${F.permSearch}">
      <button class="o_btn o_btn_ghost o_btn_sm" id="permAll">${tx('تحديد الكل', 'Select all')}</button>
      <button class="o_btn o_btn_ghost o_btn_sm" id="permNone">${tx('إلغاء الكل', 'Clear')}</button>
      <button class="o_btn o_btn_primary o_btn_sm" id="permSave" ${canWrite ? '' : 'disabled'}>
        <i class="fa-solid fa-floppy-disk"></i> ${tx('حفظ صلاحيات الدور', 'Save role permissions')}</button>
    </div>
    ${alertBox(tx(
      'صلاحيات الدور تُطبّق داخل نطاق مستودعاته الفعلي. تجاوز الطوارئ للمسؤول الأعلى فقط ولا يُدار من مصفوفة الأدوار.',
      'Role grants apply only within the role/user effective warehouse scope. SUPER_ADMIN break-glass is not managed in the role matrix.'
    ), 'info')}
    <div class="o_perm_groups">
      ${[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, list]) => `
        <div class="o_perm_group">
          <div class="o_perm_group_head"><b>${esc(permissionGroupLabel(g))}</b><span class="o_muted">${list.length}</span></div>
          ${list.map(p => `<label class="o_checkbox o_perm_item" title="${esc(permissionDescription(p.key, p.description))}">
            <input type="checkbox" data-perm="${esc(p.key)}" ${active.has(p.key) ? 'checked' : ''} ${canWrite ? '' : 'disabled'}>
            <span><b class="o_perm_label">${esc(permissionLabel(p.key))}</b><small>${esc(permissionDescription(p.key, p.description))}</small></span>
          </label>`).join('')}
        </div>`).join('')}
    </div>`;
}

function renderAuthorization(banned) {
  const canWrite = !banned && canAdministerProfiles() && navigator.onLine && !window.__session?.offline;
  if (F.authorizationLoading || (!F.authorizationLoaded && !F.authorizationError)) {
    return card(tx('محرك التفويض المؤسسي', 'Institutional authorization engine'),
      `<div class="o_empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>${tx('جارٍ تحميل سياسات التفويض وسجل القرارات…', 'Loading grants and authorization decisions…')}</p></div>`);
  }
  if (F.authorizationError) {
    return card(tx('محرك التفويض المؤسسي', 'Institutional authorization engine'),
      alertBox(esc(F.authorizationError), 'warning'),
      `<button class="o_btn o_btn_secondary o_btn_sm" id="authReload">${tx('إعادة المحاولة', 'Retry')}</button>`);
  }
  const grants = F.authorizationGrants || [];
  const decisions = F.authorizationDecisions || [];
  const warehouseName = id => {
    if (!id) return '—';
    const w = store.byId('warehouses', id);
    return w ? `${w.code || ''} — ${w.name || ''}` : String(id).slice(0, 8);
  };
  const actorName = id => {
    if (!id) return '—';
    const p = store.byId('profiles', id);
    return p?.name || p?.email || String(id).slice(0, 8);
  };
  const filter = F.authorizationGrantFilter;
  const now = Date.now();
  const grantStatus = g => {
    if (g.revoked_at) return 'REVOKED';
    if (new Date(g.valid_from).getTime() > now) return 'SCHEDULED';
    if (g.valid_until && new Date(g.valid_until).getTime() <= now) return 'EXPIRED';
    return 'ACTIVE';
  };
  const grantRows = grants.filter(g => {
    const status = grantStatus(g);
    const searchText = [
      g.permission_key, g.resource_type, g.resource_id, g.role_name,
      actorName(g.user_id), warehouseName(g.warehouse_id), g.grant_reason
    ].join(' ').toLowerCase();
    return (filter.subject === 'ALL' || g.subject_type === filter.subject)
      && (filter.effect === 'ALL' || g.effect === filter.effect)
      && (filter.status === 'ALL' || status === filter.status)
      && (!filter.search || searchText.includes(filter.search.trim().toLowerCase()));
  });
  return `
    <div class="o_stack">
      ${card(`<i class="fa-solid fa-shield-halved"></i> ${tx('منح التفويض', 'Authorization grants')}`,
        `<p class="o_hint">${tx('تتحكم المنحة في الإجراء والمورد والسجل والمستودع ونطاق الملكية أو شروط السياق ومدة الصلاحية. المنع الصريح يتغلب على السماح.', 'Each grant can constrain action, resource, record, warehouse, ownership/context conditions and validity. Explicit deny always overrides allow.')}</p>
        <div class="o_filter_bar" style="margin:10px 0">
          <input id="authGrantSearch" class="o_filter_input" value="${esc(filter.search)}"
            placeholder="${tx('بحث في المستفيد أو الإجراء أو المورد…', 'Search subject, action or resource…')}">
          <select id="authGrantSubject" class="o_filter_select">
            <option value="ALL" ${filter.subject === 'ALL' ? 'selected' : ''}>${tx('كل المستفيدين', 'All subjects')}</option>
            <option value="USER" ${filter.subject === 'USER' ? 'selected' : ''}>${tx('المستخدمون', 'Users')}</option>
            <option value="ROLE" ${filter.subject === 'ROLE' ? 'selected' : ''}>${tx('الأدوار', 'Roles')}</option>
          </select>
          <select id="authGrantEffect" class="o_filter_select">
            <option value="ALL" ${filter.effect === 'ALL' ? 'selected' : ''}>${tx('كل الآثار', 'All effects')}</option>
            <option value="ALLOW" ${filter.effect === 'ALLOW' ? 'selected' : ''}>${tx('سماح', 'Allow')}</option>
            <option value="DENY" ${filter.effect === 'DENY' ? 'selected' : ''}>${tx('منع', 'Deny')}</option>
          </select>
          <select id="authGrantStatus" class="o_filter_select">
            <option value="ALL" ${filter.status === 'ALL' ? 'selected' : ''}>${tx('كل الحالات', 'All statuses')}</option>
            <option value="ACTIVE" ${filter.status === 'ACTIVE' ? 'selected' : ''}>${tx('فعالة', 'Active')}</option>
            <option value="SCHEDULED" ${filter.status === 'SCHEDULED' ? 'selected' : ''}>${tx('مجدولة', 'Scheduled')}</option>
            <option value="EXPIRED" ${filter.status === 'EXPIRED' ? 'selected' : ''}>${tx('منتهية', 'Expired')}</option>
            <option value="REVOKED" ${filter.status === 'REVOKED' ? 'selected' : ''}>${tx('ملغاة', 'Revoked')}</option>
          </select>
          <span class="o_hint">${fmtNum(grantRows.length)} / ${fmtNum(grants.length)}</span>
        </div>
        ${table(
          [
            { label: tx('المستفيد', 'Subject') },
            { label: tx('الإجراء', 'Action') },
            { label: tx('المورد / السجل', 'Resource / record') },
            { label: tx('المستودع', 'Warehouse') },
            { label: tx('الأثر', 'Effect') },
            { label: tx('النطاق', 'Scope') },
            { label: tx('الصلاحية حتى', 'Valid until') },
            { label: tx('الحالة', 'Status') },
            { label: '', width: '76px' }
          ],
          grantRows.map(g => ({
            cells: [
              g.subject_type === 'ROLE' ? roleLabel(g.role_name) : actorName(g.user_id),
              `<span class="o_cell_main">${esc(permissionLabel(g.permission_key))}</span><div class="o_cell_sub">${esc(g.permission_key)}</div>`,
              `${esc(g.resource_type || '—')}${g.resource_id ? `<div class="o_cell_sub">${esc(g.resource_id)}</div>` : ''}`,
              esc(warehouseName(g.warehouse_id)),
              badge(g.effect, g.effect === 'DENY' ? 'red' : 'green'),
              `${esc(g.scope_type)}${g.scope_type === 'CONTEXT' ? `<div class="o_cell_sub">${esc(JSON.stringify(g.conditions || {}))}</div>` : ''}`,
              g.valid_until ? fmtDateTime(g.valid_until) : '—',
              grantStatus(g) === 'REVOKED' ? badge(tx('ملغاة', 'Revoked'), 'red')
                : grantStatus(g) === 'EXPIRED' ? badge(tx('منتهية', 'Expired'), 'gray')
                : grantStatus(g) === 'SCHEDULED' ? badge(tx('مجدولة', 'Scheduled'), 'blue')
                : badge(tx('فعالة', 'Active'), 'green'),
              !canWrite || grantStatus(g) === 'REVOKED' || grantStatus(g) === 'EXPIRED' ? '' : `<button class="o_btn o_btn_ghost o_btn_sm" data-auth-revoke="${g.id}" title="${tx('إلغاء المنحة', 'Revoke grant')}" aria-label="${tx('إلغاء المنحة', 'Revoke grant')}"><i class="fa-solid fa-ban"></i></button>`
            ]
          })),
          { emptyTitle: tx('لا توجد منح تفويض', 'No authorization grants') }
        )}`,
        `<button class="o_btn o_btn_primary o_btn_sm" id="authGrantAdd" ${canWrite ? '' : 'disabled'}><i class="fa-solid fa-plus"></i> ${tx('منحة جديدة', 'New grant')}</button>`, 'flush-body')}
      ${card(`<i class="fa-solid fa-clipboard-list"></i> ${tx('سجل قرارات التفويض — آخر 30 يوماً', 'Authorization decisions — last 30 days')}`,
        table(
          [
            { label: tx('التاريخ', 'Date') },
            { label: tx('المستخدم', 'Actor') },
            { label: tx('الإجراء', 'Action') },
            { label: tx('المورد / السجل', 'Resource / record') },
            { label: tx('المستودع', 'Warehouse') },
            { label: tx('القرار', 'Decision') },
            { label: tx('السبب', 'Reason') }
          ],
          decisions.map(d => ({
            cells: [
              fmtDateTime(d.created_at),
              esc(actorName(d.actor_user_id)),
              `<span class="o_cell_main">${esc(d.action_key)}</span>${d.break_glass ? `<div class="o_cell_sub">${badge(tx('تجاوز طارئ', 'Break-glass'), 'purple')}</div>` : ''}`,
              `${esc(d.resource_type || '—')}${d.resource_id ? `<div class="o_cell_sub">${esc(d.resource_id)}</div>` : ''}`,
              esc(warehouseName(d.warehouse_id)),
              badge(d.decision, d.decision === 'DENY' ? 'red' : 'green'),
              esc(d.decision_reason || '—')
            ]
          })),
          { emptyTitle: tx('لا توجد قرارات مسجلة في الفترة المحددة', 'No decisions recorded in this period') }
        ), '', 'flush-body')}
    </div>`;
}

function renderUnits(banned) {
  const canWrite = !banned && navigator.onLine && !window.__session?.offline;
  const units = [...store.get('units')].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const items = [...store.get('items')].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const allConvs = store.get('item_unit_conversions');
  const convs = allConvs.filter(c => !F.item || c.item_id === F.item);
  const unconfiguredCount = items.filter(i => {
    const purchase = String(i.purchase_unit || '').trim().toUpperCase();
    const base = String(i.base_unit || 'PCS').trim().toUpperCase();
    if (!purchase || purchase === base) return false;
    return !allConvs.some(c => c.item_id === i.id && String(c.unit_code || '').trim().toUpperCase() === purchase);
  }).length;
  const conversionWarning = unconfiguredCount
    ? alertBox(tx(`${unconfiguredCount} صنفًا لديه وحدة شراء بلا معامل معتمد. لن تظهر تلك الوحدة في السندات ولن تُستخدم كمعامل 1 تلقائيًا.`,
      `${unconfiguredCount} item(s) have a purchase unit without an approved factor. That unit will not appear in vouchers and is never treated as factor 1 automatically.`), 'warning')
    : '';
  return `
    <div class="o_grid" style="grid-template-columns:1fr 1fr">
      ${card(`<i class="fa-solid fa-ruler"></i> ${tx('وحدات القياس', 'Units of measure')}`,
        table(
          [{ label: tx('الرمز', 'Code') }, { label: tx('الاسم', 'Name') }, { label: '', width: '80px' }],
          units.map(u => ({
            cells: [u.code, u.name, !canWrite ? '' : `<div class="o_actions_cell">
              <button class="o_btn o_btn_ghost o_btn_sm" data-unit="${u.id}"><i class="fa-solid fa-pen"></i></button>
              <button class="o_btn o_btn_ghost o_btn_sm" data-unit-del="${u.id}"><i class="fa-solid fa-trash"></i></button>
            </div>`]
          })),
          { emptyTitle: tx('لا توجد وحدات', 'No units') }
        ),
        `<button class="o_btn o_btn_primary o_btn_sm" onclick="OW.wms.unitModal()" ${canWrite ? '' : 'disabled'}>
          <i class="fa-solid fa-plus"></i> ${tx('وحدة', 'Unit')}</button>`, 'flush-body')}
      ${card(`<i class="fa-solid fa-arrows-left-right"></i> ${tx('تحويلات الأصناف', 'Item conversions')}`,
        `${conversionWarning}
        ${select({ name: 'convItem', label: '', options: items.map(i => ({ value: i.id, label: `${i.code} — ${itemNameOnly(i)}` })), value: F.item, placeholder: tx('كل الأصناف', 'All items') })}
        ${table(
          [{ label: tx('الصنف', 'Item') }, { label: tx('الوحدة الأساسية', 'Base unit') }, { label: tx('الوحدة', 'Unit') }, { label: tx('المعامل', 'Factor'), num: true }, { label: tx('المعنى', 'Meaning') }, { label: '', width: '80px' }],
          convs.map(c => {
            const item = store.byId('items', c.item_id);
            const base = item?.base_unit || 'PCS';
            return {
              cells: [esc(itemNameOnly(c.item_id)), esc(base), esc(c.unit_code), fmtNum(c.factor_to_base),
                esc(`1 ${c.unit_code} = ${fmtNum(c.factor_to_base)} ${base}`),
                !canWrite ? '' : `<div class="o_actions_cell">
                <button class="o_btn o_btn_ghost o_btn_sm" data-conv="${c.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="o_btn o_btn_ghost o_btn_sm" data-conv-del="${c.id}"><i class="fa-solid fa-trash"></i></button>
              </div>`]
            };
          }),
          { emptyTitle: tx('لا توجد تحويلات', 'No conversions') }
        )}`,
        `<button class="o_btn o_btn_primary o_btn_sm" onclick="OW.wms.convModal()" ${canWrite ? '' : 'disabled'}>
          <i class="fa-solid fa-plus"></i> ${tx('تحويل', 'Conversion')}</button>`, 'flush-body')}
    </div>`;
}

function renderCategories() {
  const live = navigator.onLine && !window.__session?.offline;
  const canCreate = can('action:item:create') && live;
  const canUpdate = can('action:item:update') && live;
  const canDelete = can('action:item:delete') && live;
  const cats = [...store.get('item_categories')].sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name)));
  const counts = new Map();
  for (const i of store.get('items')) counts.set(i.category_id, (counts.get(i.category_id) || 0) + 1);
  return card('', table(
    [{ label: tx('الرمز', 'Code') }, { label: tx('التصنيف', 'Category') }, { label: tx('الوصف', 'Description') },
     { label: tx('الأصناف', 'Items'), num: true }, { label: tx('نشط', 'Active') }, { label: '', width: '90px' }],
    cats.map(c => ({
      cells: [c.code || '—', `<span class="o_cell_main">${c.name || '—'}</span>`, c.description || '—',
        fmtNum(counts.get(c.id) || 0),
        c.is_active === false ? badge(tx('غير نشط', 'Inactive'), 'red') : badge(tx('نشط', 'Active'), 'green'),
        canUpdate || canDelete ? `<div class="o_actions_cell">
          ${canUpdate ? `<button class="o_btn o_btn_ghost o_btn_sm" data-cat="${c.id}"><i class="fa-solid fa-pen"></i></button>` : ''}
          ${canDelete ? `<button class="o_btn o_btn_ghost o_btn_sm" data-cat-del="${c.id}"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>` : '']
    })),
    { emptyTitle: tx('لا توجد تصنيفات', 'No categories') }
  ), `<button class="o_btn o_btn_primary o_btn_sm" onclick="OW.wms.categoryModal()" ${canCreate ? '' : 'disabled'}>
        <i class="fa-solid fa-plus"></i> ${tx('تصنيف', 'Category')}</button>`, 'flush-body');
}

/* ── master-data import wizard ───────────────────────────────────────────── */

function importFieldLabel(field) {
  return tx(field.label[0], field.label[1]);
}

function importNorm(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\s_\-./()[\]{}]+/g, '');
}

function importAutoMap(header, field) {
  const h = importNorm(header);
  if (!h) return false;
  const aliases = [...(field.aliases || []), field.key, importFieldLabel(field)];
  return aliases.some(a => importNorm(a) === h);
}

function importMappingFor(entity, headers) {
  const def = IMPORT_ENTITIES[entity] || IMPORT_ENTITIES.warehouses;
  const list = (headers || []).filter(Boolean);
  const used = new Set();
  const out = {};

  // Prefer an exact field key/label match before falling back to aliases. This
  // prevents a broad alias (for example item_number → code) from stealing the
  // header that belongs to a more specific field in files that contain both.
  const exact = field => list.find(h => !used.has(h) && (
    importNorm(h) === importNorm(field.key) ||
    importNorm(h) === importNorm(importFieldLabel(field))
  ));
  const alias = field => list.find(h => !used.has(h) && importAutoMap(h, field));

  for (const field of def.fields) {
    const header = exact(field);
    if (!header) continue;
    out[field.key] = header;
    used.add(header);
  }
  for (const field of def.fields) {
    if (out[field.key]) continue;
    const header = alias(field);
    out[field.key] = header || '';
    if (header) used.add(header);
  }

  // A file may use only Item Number as the SKU. Keep it as item_number and let
  // code reuse the same source column so the required code field stays usable.
  if (entity === 'items' && !out.code && out.item_number) out.code = out.item_number;
  return out;
}

function importParseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function importDelimiter(fileName, text) {
  if (/\.tsv$/i.test(fileName)) return '\t';
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length]
  ];
  return counts.sort((a, b) => b[1] - a[1])[0][1] ? counts[0][0] : ',';
}

function importUniqueHeaders(rawHeaders) {
  const counts = new Map();
  return rawHeaders.map((h, i) => {
    const base = String(h ?? '').trim() || `Column ${i + 1}`;
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    return n ? `${base} (${n + 1})` : base;
  });
}

async function importReadFile(file) {
  const text = (await file.text()).replace(/^\uFEFF/, '');
  let headers = [];
  let rows = [];
  if (/\.json$/i.test(file.name) || /json/i.test(file.type || '')) {
    const data = JSON.parse(text);
    if (!Array.isArray(data) || !data.length || typeof data[0] !== 'object' || Array.isArray(data[0])) {
      throw new Error(tx('ملف JSON يجب أن يحتوي على مصفوفة من الكائنات.', 'JSON must contain an array of objects.'));
    }
    const keys = new Set();
    for (const item of data) for (const key of Object.keys(item)) keys.add(key);
    headers = importUniqueHeaders([...keys]);
    rows = data.map(item => Object.fromEntries(headers.map(h => [h, String(item[h] ?? '')])));
  } else {
    const matrix = importParseDelimited(text, importDelimiter(file.name, text));
    const cleaned = matrix.filter(r => r.some(c => String(c ?? '').trim() !== ''));
    if (cleaned.length < 2) {
      throw new Error(tx('الملف يجب أن يحتوي على صف عناوين وصف بيانات واحد على الأقل.',
        'File must contain a header row and at least one data row.'));
    }
    headers = importUniqueHeaders(cleaned[0].map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`));
    rows = cleaned.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
  }
  rows = rows.filter(r => headers.some(h => String(r[h] ?? '').trim() !== ''));
  if (!headers.length) throw new Error(tx('لم يتم العثور على أعمدة في الملف.', 'No columns were found in the file.'));
  if (!rows.length) throw new Error(tx('لم يتم العثور على صفوف بيانات في الملف.', 'No data rows were found in the file.'));
  if (rows.length > IMPORT_MAX_ROWS) {
    throw new Error(tx(`الحد الأقصى ${IMPORT_MAX_ROWS} صف في المرة الواحدة.`, `The maximum is ${IMPORT_MAX_ROWS} rows per import.`));
  }
  return { headers, rows };
}

function importResolveWarehouse(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  return store.get('warehouses').find(w => String(w.id ?? '').toLowerCase() === s)
    || store.get('warehouses').find(w => String(w.code ?? '').trim().toLowerCase() === s);
}

function importResolveArea(value, warehouseId = '') {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  let rows = store.get('storage_areas');
  if (warehouseId) rows = rows.filter(a => !a.warehouse_id || a.warehouse_id === warehouseId);
  return rows.find(a => String(a.id ?? '').toLowerCase() === s)
    || rows.find(a => String(a.code ?? '').trim().toLowerCase() === s);
}

function importResolveShelf(value, warehouseId = '', storageAreaId = '') {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  let rows = store.get('shelves');
  if (storageAreaId) rows = rows.filter(sh => !sh.storage_area_id || sh.storage_area_id === storageAreaId);
  else if (warehouseId) rows = rows.filter(sh => !sh.warehouse_id || sh.warehouse_id === warehouseId);
  return rows.find(sh => String(sh.id ?? '').toLowerCase() === s)
    || rows.find(sh => String(sh.code ?? '').trim().toLowerCase() === s)
    || rows.find(sh => String(sh.full_path ?? '').trim().toLowerCase() === s);
}

function importResolveCategory(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  return store.get('item_categories').find(c => String(c.id ?? '').toLowerCase() === s)
    || store.get('item_categories').find(c => String(c.code ?? '').trim().toLowerCase() === s)
    || store.get('item_categories').find(c => String(c.name ?? '').trim().toLowerCase() === s);
}

function importBool(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const s = importNorm(value);
  if (!s) return null;
  if (IMPORT_TRUE.has(raw) || IMPORT_TRUE.has(s)) return true;
  if (IMPORT_FALSE.has(raw) || IMPORT_FALSE.has(s)) return false;
  return undefined;
}

function importFieldByKey(entity, key) {
  return IMPORT_ENTITIES[entity]?.fields.find(f => f.key === key);
}

function importValidateRow(entity, r) {
  const def = IMPORT_ENTITIES[entity];
  for (const field of def.fields) {
    if (!field.required) continue;
    if (!String(r[field.key] ?? '').trim()) {
      return `${importFieldLabel(field)} ${tx('مطلوب.', 'is required.')}`;
    }
  }
  r.code = String(r.code).trim();

  for (const key of ['safety_stock', 'weight', 'cost']) {
    if (r[key] === undefined || String(r[key]).trim() === '') continue;
    const n = Number(r[key]);
    if (!Number.isFinite(n) || n < 0) {
      return `${importFieldLabel(importFieldByKey(entity, key))} ${tx('يجب أن يكون رقمًا غير سالب.', 'must be a non-negative number.')}`;
    }
    r[key] = n;
  }

  for (const key of ['hazardous', 'is_active']) {
    if (r[key] === undefined) continue;
    const parsed = importBool(r[key]);
    if (parsed === undefined) {
      return `${importFieldLabel(importFieldByKey(entity, key))} ${tx('يجب أن يكون true أو false.', 'must be true or false.')}`;
    }
    if (parsed === null) delete r[key];
    else r[key] = parsed;
  }

  if (entity === 'items') {
    if (!String(r.name_ar ?? '').trim() && !String(r.name_en ?? '').trim()) {
      return tx('الاسم العربي أو الاسم الإنجليزي مطلوب.', 'Arabic or English item name is required.');
    }
    if (r.status) {
      const status = String(r.status).trim().toUpperCase();
      if (!['ACTIVE', 'INACTIVE'].includes(status)) {
        return tx('حالة الصنف يجب أن تكون ACTIVE أو INACTIVE.', 'Item status must be ACTIVE or INACTIVE.');
      }
      r.status = status;
    }
    if (r.category_id) {
      const category = importResolveCategory(r.category_id);
      if (!category) return tx('معرف الفئة غير موجود.', 'Category ID was not found.');
      r._category_id = category.id;
    }
    if (r.category) {
      const category = importResolveCategory(r.category);
      if (category) r._category_id = category.id;
    }
    if (r.default_warehouse_code) {
      const warehouse = importResolveWarehouse(r.default_warehouse_code);
      if (!warehouse) {
        return `${tx('المستودع الافتراضي غير موجود:', 'Default warehouse was not found:')} ${r.default_warehouse_code}`;
      }
      r._default_warehouse_id = warehouse.id;
    }
    if (r.default_storage_area_code) {
      const area = importResolveArea(r.default_storage_area_code, r._default_warehouse_id || '');
      if (!area) {
        return `${tx('منطقة التخزين الافتراضية غير موجودة:', 'Default storage area was not found:')} ${r.default_storage_area_code}`;
      }
      r._default_storage_area_id = area.id;
      r._default_warehouse_id = r._default_warehouse_id || area.warehouse_id || '';
    }
    if (r.default_shelf_code) {
      const shelf = importResolveShelf(r.default_shelf_code, r._default_warehouse_id || '', r._default_storage_area_id || '');
      if (!shelf) {
        return `${tx('الرف الافتراضي غير موجود:', 'Default shelf was not found:')} ${r.default_shelf_code}`;
      }
      r._default_shelf_id = shelf.id;
      r._default_warehouse_id = r._default_warehouse_id || shelf.warehouse_id || '';
      r._default_storage_area_id = r._default_storage_area_id || shelf.storage_area_id || '';
    }
  }

  if (entity === 'storage_areas') {
    const warehouse = importResolveWarehouse(r.warehouse_code);
    if (!warehouse) {
      return `${tx('المستودع غير موجود:', 'Warehouse was not found:')} ${r.warehouse_code}`;
    }
    r._warehouse_id = warehouse.id;
  }

  if (entity === 'shelves') {
    const warehouse = importResolveWarehouse(r.warehouse_code);
    if (!warehouse) {
      return `${tx('المستودع غير موجود:', 'Warehouse was not found:')} ${r.warehouse_code}`;
    }
    const area = importResolveArea(r.storage_area_code, warehouse.id);
    if (!area) {
      return `${tx('منطقة التخزين غير موجودة:', 'Storage area was not found:')} ${r.storage_area_code}`;
    }
    if (area.warehouse_id && area.warehouse_id !== warehouse.id) {
      return tx('منطقة التخزين لا تنتمي للمستودع المحدد.', 'The storage area does not belong to the selected warehouse.');
    }
    r._warehouse_id = warehouse.id;
    r._storage_area_id = area.id;
    r._zone_id = area.legacy_zone_id || null;
  }

  return '';
}

function importRowKey(entity, r) {
  const code = String(r.code ?? '').trim().toLowerCase();
  if (entity === 'storage_areas') return `${r._warehouse_id || r.warehouse_code || ''}|${code}`;
  if (entity === 'shelves') return `${r._storage_area_id || r.storage_area_code || ''}|${code}`;
  return code;
}

function importFindExisting(entity, r) {
  const def = IMPORT_ENTITIES[entity];
  const code = String(r.code ?? '').trim().toLowerCase();
  const rows = store.get(def.table);
  const sameCode = x => String(x.code ?? '').trim().toLowerCase() === code;
  if (entity === 'storage_areas') return rows.find(x => x.warehouse_id === r._warehouse_id && sameCode(x));
  if (entity === 'shelves') return rows.find(x => x.storage_area_id === r._storage_area_id && sameCode(x));
  return rows.find(sameCode);
}

function importShelfPath(r) {
  const warehouse = store.byId('warehouses', r._warehouse_id);
  const area = store.byId('storage_areas', r._storage_area_id);
  return [warehouse?.code, area?.code, String(r.code ?? '').trim()].filter(Boolean).join(' / ');
}

function importPayload(entity, r, partial = false) {
  const now = new Date().toISOString();
  const has = key => r[key] !== undefined && r[key] !== null && String(r[key]).trim() !== '';
  const p = {};
  if (!partial || has('code')) p.code = String(r.code ?? '').trim();

  if (entity === 'warehouses') {
    if (!partial || has('name')) p.name = String(r.name ?? '').trim();
  }

  if (entity === 'storage_areas') {
    if (!partial || has('warehouse_code')) p.warehouse_id = r._warehouse_id;
    if (!partial || has('name')) p.name = String(r.name ?? '').trim();
    if (has('is_active')) p.is_active = r.is_active;
    else if (!partial) p.is_active = true;
  }

  if (entity === 'shelves') {
    if (!partial || has('warehouse_code')) p.warehouse_id = r._warehouse_id;
    if (!partial || has('storage_area_code')) p.storage_area_id = r._storage_area_id;
    if (!partial || has('warehouse_code') || has('storage_area_code')) p.zone_id = r._zone_id || null;
    if (!partial || has('full_path')) p.full_path = String(r.full_path ?? '').trim() || importShelfPath(r);
    else if (has('warehouse_code') || has('storage_area_code') || has('code')) p.full_path = importShelfPath(r);
    if (!partial) p.section_id = null;
  }

  if (entity === 'items') {
    if (!partial || has('item_number')) p.item_number = String(r.item_number ?? '').trim() || null;
    if (!partial || has('name_ar')) p.name_ar = String(r.name_ar ?? '').trim() || null;
    if (!partial || has('name_en')) p.name_en = String(r.name_en ?? r.name_ar ?? '').trim() || null;
    if (!partial || has('category')) p.category = String(r.category ?? '').trim() || null;
    if (!partial || has('category_id') || has('category')) p.category_id = r._category_id || null;
    if (!partial || has('status')) p.status = r.status || 'ACTIVE';
    if (!partial || has('base_unit')) p.base_unit = String(r.base_unit ?? 'PCS').trim().toUpperCase() || 'PCS';
    if (!partial || has('purchase_unit')) p.purchase_unit = String(r.purchase_unit ?? '').trim().toUpperCase() || null;
    if (!partial || has('safety_stock')) p.safety_stock = r.safety_stock ?? 0;
    if (!partial || has('weight')) p.weight = r.weight ?? null;
    if (!partial || has('cost')) p.cost = r.cost ?? 0;
    if (!partial || has('supplier')) p.supplier = String(r.supplier ?? '').trim() || null;
    if (has('hazardous')) p.hazardous = !!r.hazardous;
    else if (!partial) p.hazardous = false;
    if (!partial || has('default_warehouse_code')) p.default_warehouse_id = r._default_warehouse_id || null;
    if (!partial || has('default_storage_area_code')) p.default_storage_area_id = r._default_storage_area_id || null;
    if (!partial || has('default_shelf_code')) p.default_shelf_id = r._default_shelf_id || null;
    if (!partial || has('description')) p.description = String(r.description ?? '').trim() || null;
  }

  if (!partial) p.created_at = now;
  else p.updated_at = now;
  return p;
}

function importResultClear() {
  F.import.result = null;
  reload();
}

function importClear() {
  F.import.fileName = '';
  F.import.headers = [];
  F.import.rows = [];
  F.import.mapping = {};
  F.import.result = null;
  reload();
}

function importTemplate() {
  const def = IMPORT_ENTITIES[F.import.entity] || IMPORT_ENTITIES.warehouses;
  downloadCSV(`OW-${F.import.entity}-import-template.csv`, def.fields.map(f => f.key), []);
  toast(tx('تم تنزيل قالب الاستيراد', 'Import template downloaded'), 'success');
}

function refreshImportMappingState(main) {
  if (!main) return;
  const def = IMPORT_ENTITIES[F.import.entity];
  const missing = def.fields.filter(f => f.required && !F.import.mapping[f.key]);
  main.querySelectorAll('[data-import-map]').forEach(sel => {
    const field = importFieldByKey(F.import.entity, sel.dataset.importMap);
    const row = sel.closest('.o_import_map_row');
    if (row) row.classList.toggle('missing', !!(field?.required && !sel.value));
  });
  const box = main.querySelector('#importMissing');
  if (box) {
    box.hidden = !missing.length;
    const text = main.querySelector('#importMissingText');
    if (text) text.textContent = missing.map(importFieldLabel).join(tx('، ', ', '));
  }
  const apply = main.querySelector('#importApply');
  if (apply) apply.disabled = !!missing.length || F.import.busy
    || (!canManageImportEntity(F.import.entity, 'create')
      && !(F.import.updateExisting && canManageImportEntity(F.import.entity, 'update')))
    || !navigator.onLine || !!window.__session?.offline;
  const mapped = def.fields.filter(f => F.import.mapping[f.key]).length;
  const count = main.querySelector('#importMappedCount');
  if (count) count.textContent = `${mapped}/${def.fields.length}`;
  const footer = main.querySelector('#importMappedFooter');
  if (footer) footer.textContent = `${mapped} ${tx('حقل مربوط', 'fields mapped')}`;
}

async function applyImport() {
  const x = F.import;
  if (x.busy) return;
  if (!x.rows.length) {
    toast(tx('اختر ملفًا صالحًا أولًا.', 'Choose a valid file first.'), 'warning');
    return;
  }
  const def = IMPORT_ENTITIES[x.entity];
  if (!def) return;
  if (!canManageImportEntity(x.entity, 'create')
      && !(x.updateExisting && canManageImportEntity(x.entity, 'update'))) {
    toast(tx('لا تملك صلاحية إنشاء أو تحديث هذا النوع من البيانات.', 'You do not have the required create/update permission for this data type.'), 'error');
    return;
  }
  if (!navigator.onLine || window.__session?.offline) {
    toast(tx('استيراد البيانات يتطلب اتصالًا مباشرًا بالخادم.', 'Data import requires a live server connection.'), 'warning');
    return;
  }

  const source = x.rows.map((row, idx) => {
    const r = { _row: idx + 2 };
    for (const field of def.fields) {
      const header = x.mapping[field.key];
      if (!header) continue;
      const raw = row[header];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      r[field.key] = String(raw).trim();
    }
    return r;
  });

  if (source.every(r => Object.keys(r).length <= 1)) {
    F.import.result = {
      ok: false, created: 0, updated: 0, skipped: 0,
      errors: [tx('لم يتم ربط أي عمود ببيانات. راجع خطوة ربط الأعمدة.', 'No columns are mapped to data. Review the mapping step.')],
      warnings: []
    };
    reload();
    return;
  }

  const errors = [];
  const prepared = [];
  const seen = new Map();
  for (const r of source) {
    let error = importValidateRow(x.entity, r);
    if (!error) {
      const key = importRowKey(x.entity, r);
      if (seen.has(key)) {
        error = `${tx('رمز مكرر داخل الملف. الصف السابق:', 'Duplicate code in the file. Previous row:')} ${seen.get(key)}`;
      } else {
        seen.set(key, r._row);
      }
    }
    if (error) errors.push(`${tx('الصف', 'Row')} ${r._row}: ${error}`);
    else prepared.push(r);
  }

  if (errors.length) {
    F.import.result = { ok: false, created: 0, updated: 0, skipped: 0, errors, warnings: [] };
    reload();
    return;
  }

  const deniedRow = prepared.find(row => {
    const existing = importFindExisting(x.entity, row);
    if (existing && !x.updateExisting) return false;
    return !canManageImportEntity(x.entity, existing ? 'update' : 'create', existing, row);
  });
  if (deniedRow) {
    F.import.result = {
      ok: false, created: 0, updated: 0, skipped: 0,
      errors: [`${tx('الصف', 'Row')} ${deniedRow._row}: ${tx('لا تملك صلاحية العملية المطلوبة أو أن السجل خارج نطاق مستودعاتك.', 'You lack the required operation permission or the record is outside your warehouse scope.')}`],
      warnings: []
    };
    reload();
    return;
  }

  F.import.busy = true;
  F.import.result = null;
  reload();

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failures = [];
  const warnings = [];

  for (const r of prepared) {
    try {
      const existing = importFindExisting(x.entity, r);
      if (existing && !x.updateExisting) { skipped++; continue; }
      if (existing) {
        await updateRow(def.table, existing.id, importPayload(x.entity, r, true));
        updated++;
      } else {
        await insertRow(def.table, importPayload(x.entity, r, false));
        created++;
      }
    } catch (e) {
      failures.push(`${tx('الصف', 'Row')} ${r._row}: ${friendlyError(e, tx('تعذر حفظ هذا الصف.', 'This row could not be saved.'))}`);
      break;
    }
  }

  F.import.busy = false;
  const ok = !failures.length;
  if (ok) {
    if (!created && !updated && skipped) {
      warnings.push(tx('كل الصفوف موجودة مسبقًا. فعّل خيار تحديث السجلات الموجودة لتحديثها.',
        'All rows already exist. Enable “Update existing records” to update them.'));
    }
    F.import.fileName = '';
    F.import.headers = [];
    F.import.rows = [];
    F.import.mapping = {};
    F.import.result = { ok: true, created, updated, skipped, errors: [], warnings };
    toast(tx(`تم الاستيراد: ${created} جديد، ${updated} محدّث، ${skipped} متخطى.`,
      `Imported: ${created} new, ${updated} updated, ${skipped} skipped.`), 'success');
  } else {
    F.import.result = { ok: false, created, updated, skipped, errors: failures, warnings };
    toast(tx('توقف الاستيراد قبل اكتمال كل الصفوف. راجع التفاصيل.',
      'Import stopped before all rows were processed. Review the details.'), 'error');
  }
  reload();
}

function renderImportResult(result) {
  const errors = result.errors || [];
  const warnings = result.warnings || [];
  return `<div class="o_import_result ${result.ok ? 'ok' : 'bad'}">
    <div class="o_import_result_icon"><i class="fa-solid ${result.ok ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i></div>
    <div class="o_import_result_body">
      <b>${result.ok ? tx('اكتمل الاستيراد', 'Import complete') : tx('لم يكتمل الاستيراد', 'Import did not complete')}</b>
      <p>
        ${tx('جديد', 'Created')} <b>${fmtNum(result.created || 0)}</b>
        <span>·</span> ${tx('محدّث', 'Updated')} <b>${fmtNum(result.updated || 0)}</b>
        <span>·</span> ${tx('متخطى', 'Skipped')} <b>${fmtNum(result.skipped || 0)}</b>
      </p>
      ${errors.length ? `<ul>${errors.slice(0, 30).map(err => `<li>${esc(err)}</li>`).join('')}
        ${errors.length > 30 ? `<li>${tx('و', 'and')} ${fmtNum(errors.length - 30)} ${tx('أخطاء أخرى', 'more errors')}</li>` : ''}</ul>` : ''}
      ${warnings.length ? `<div class="o_import_warnings">${warnings.map(w => `<span><i class="fa-solid fa-circle-info"></i> ${esc(w)}</span>`).join('')}</div>` : ''}
    </div>
    <button type="button" class="o_import_result_close" onclick="OW.wms.importResultClear()" aria-label="${tx('إغلاق', 'Close')}">
      <i class="fa-solid fa-xmark"></i>
    </button>
  </div>`;
}

function renderImport(banned) {
  const x = F.import;
  const def = IMPORT_ENTITIES[x.entity] || IMPORT_ENTITIES.warehouses;
  const fields = def.fields;
  const mappedCount = fields.filter(f => x.mapping[f.key]).length;
  const missing = fields.filter(f => f.required && !x.mapping[f.key]);
  const can = !banned;
  const entityPermission = canManageImportEntity(x.entity, 'create')
    || (x.updateExisting && canManageImportEntity(x.entity, 'update'));
  const canWrite = can && entityPermission && navigator.onLine && !window.__session?.offline;
  const previewHeaders = x.headers.slice(0, 8);
  const previewRows = x.rows.slice(0, 5);

  return `<div class="o_import">
    <div class="o_import_hero">
      <div class="o_import_hero_icon"><i class="fa-solid fa-file-import"></i></div>
      <div class="o_import_hero_text">
        <h2>${tx('استيراد البيانات الرئيسية', 'Master data import')}</h2>
        <p>${tx('ارفع ملف CSV أو TSV أو JSON، اربط أعمدته بحقول النظام، راجع المعاينة، ثم استورد المستودعات والمواقع والأصناف.',
          'Upload a CSV, TSV or JSON file, map its columns to system fields, review the preview, then import warehouses, locations and items.')}</p>
      </div>
      <div class="o_import_steps" aria-label="${tx('خطوات الاستيراد', 'Import steps')}">
        <span class="active">1 · ${tx('الملف', 'File')}</span>
        <span class="${x.rows.length ? 'active' : ''}">2 · ${tx('الربط', 'Mapping')}</span>
        <span class="${x.rows.length && !missing.length ? 'active' : ''}">3 · ${tx('الاستيراد', 'Import')}</span>
      </div>
    </div>

    ${banned ? alertBox(tx('ليست لديك صلاحية استيراد البيانات. العرض للقراءة فقط.',
      'You do not have permission to import data. Read-only view.'), 'warning') : ''}
    ${!banned && !entityPermission ? alertBox(tx('لا تملك صلاحية إنشاء أو تحديث نوع البيانات المحدد. ستظل المعاينة متاحة دون تنفيذ الاستيراد.',
      'You do not have the create/update permission for this data type. Preview remains available, but import is disabled.'), 'warning') : ''}
    ${!banned && entityPermission && !canWrite ? alertBox(tx('يمكن تجهيز الملف وربط الأعمدة دون اتصال، لكن حفظ البيانات يتطلب اتصالًا مباشرًا بالخادم.',
      'You can prepare the file and map its columns offline, but saving requires a live server connection.'), 'warning') : ''}

    <div class="o_import_entities">
      ${Object.entries(IMPORT_ENTITIES).map(([key, entity]) => `<button type="button"
        class="o_import_entity ${x.entity === key ? 'active' : ''}"
        data-import-entity="${key}" ${can ? '' : 'disabled'}
        title="${tx(entity.hint[0], entity.hint[1])}">
        <i class="fa-solid ${entity.icon}"></i>
        <b>${tx(entity.label[0], entity.label[1])}</b>
        <small>${fmtNum(store.get(entity.table).length)} ${tx('سجل', 'records')}</small>
      </button>`).join('')}
    </div>

    <div class="o_import_setup">
      <section class="o_import_panel">
        <div class="o_import_panel_head">
          <span>1</span>
          <div><b>${tx('اختر الملف', 'Choose a file')}</b><small>${tx('تتم المعالجة محليًا قبل الاستيراد.', 'The file is parsed locally before import.')}</small></div>
        </div>
        <label class="o_import_drop ${can ? '' : 'disabled'}" for="importFile">
          <i class="fa-solid fa-cloud-arrow-up"></i>
          <b>${tx('اسحب الملف هنا أو اضغط للاختيار', 'Drop a file here or click to browse')}</b>
          <small>${tx('CSV أو TSV أو JSON — حتى 5000 صف', 'CSV, TSV or JSON — up to 5,000 rows')}</small>
        </label>
        <input class="o_import_file_input" id="importFile" type="file"
          accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,application/json" ${can ? '' : 'disabled'}>
        <div class="o_import_actions">
          <button type="button" class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.importTemplate()" ${can ? '' : 'disabled'}>
            <i class="fa-solid fa-download"></i> ${tx('تنزيل قالب CSV', 'Download CSV template')}
          </button>
          ${x.fileName ? `<button type="button" class="o_btn o_btn_ghost o_btn_sm" onclick="OW.wms.importClear()" ${can ? '' : 'disabled'}>
            <i class="fa-solid fa-xmark"></i> ${tx('إزالة الملف', 'Clear file')}
          </button>` : ''}
        </div>
        ${x.fileName ? `<div class="o_import_meta">
          <i class="fa-regular fa-file-lines"></i>
          <b>${esc(x.fileName)}</b>
          <span>${fmtNum(x.rows.length)} ${tx('صف', 'rows')}</span>
          <span>${fmtNum(x.headers.length)} ${tx('عمود', 'columns')}</span>
        </div>` : ''}
      </section>

      <aside class="o_import_panel o_import_guide">
        <div class="o_import_panel_head">
          <span><i class="fa-solid fa-circle-info"></i></span>
          <div><b>${tx('ترتيب الاستيراد', 'Import order')}</b><small>${tx('ابنِ الهيكل من الأعلى إلى الأسفل.', 'Build the hierarchy from top to bottom.')}</small></div>
        </div>
        <ol class="o_import_order">
          <li><i class="fa-solid fa-warehouse"></i> ${tx('المستودعات', 'Warehouses')}</li>
          <li><i class="fa-solid fa-layer-group"></i> ${tx('مناطق التخزين', 'Storage areas')}</li>
          <li><i class="fa-solid fa-bars-staggered"></i> ${tx('الأرفف', 'Shelves')}</li>
          <li><i class="fa-solid fa-box"></i> ${tx('الأصناف', 'Items')}</li>
        </ol>
        <div class="o_import_tip">
          <i class="fa-solid fa-scale-balanced"></i>
          <span>${tx('الكميات الافتتاحية لا تُستورد من هنا. استخدم شاشة الأرصدة الافتتاحية بعد استيراد الأصناف.',
            'Opening quantities are not imported here. Use the opening-balance workspace after importing items.')}</span>
        </div>
        <button type="button" class="o_btn o_btn_ghost o_btn_sm o_import_oblink"
          onclick="OW.wms.openOpeningBalances && OW.wms.openOpeningBalances()">
          <i class="fa-solid fa-arrow-up-right-from-square"></i> ${tx('فتح الأرصدة الافتتاحية', 'Open opening balances')}
        </button>
      </aside>
    </div>

    ${x.result ? renderImportResult(x.result) : ''}

    ${x.rows.length ? `<div class="o_import_work">
      <section class="o_import_panel">
        <div class="o_import_panel_head">
          <span>2</span>
          <div><b>${tx('ربط الأعمدة', 'Map columns')}</b><small>${tx('اختر العمود المقابل لكل حقل. الحقول الاختيارية يمكن تجاهلها.', 'Choose the source column for each field. Optional fields can be skipped.')}</small></div>
          <span class="o_import_count" id="importMappedCount">${mappedCount}/${fields.length}</span>
        </div>
        <div class="o_import_map_list">
          ${fields.map(field => {
            const selected = x.mapping[field.key] || '';
            return `<label class="o_import_map_row ${field.required && !selected ? 'missing' : ''}">
              <span>
                <b>${importFieldLabel(field)}${field.required ? ' <em>*</em>' : ''}</b>
                <small><code>${esc(field.key)}</code></small>
              </span>
              <select data-import-map="${esc(field.key)}" ${can ? '' : 'disabled'}>
                <option value="">${tx('تجاهل هذا الحقل', 'Skip this field')}</option>
                ${x.headers.map(h => `<option value="${esc(h)}" ${h === selected ? 'selected' : ''}>${esc(h)}</option>`).join('')}
              </select>
            </label>`;
          }).join('')}
        </div>
        <div class="o_import_missing" id="importMissing" ${missing.length ? '' : 'hidden'}>
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>${tx('حقول مطلوبة غير مربوطة:', 'Required fields are not mapped:')} <b id="importMissingText">${missing.map(importFieldLabel).map(esc).join(tx('، ', ', '))}</b></span>
        </div>
      </section>

      <section class="o_import_panel">
        <div class="o_import_panel_head">
          <span>3</span>
          <div><b>${tx('المعاينة والاستيراد', 'Preview & import')}</b><small>${tx('معاينة أول 5 صفوف قبل الحفظ.', 'Preview the first five rows before saving.')}</small></div>
        </div>
        <div class="o_import_preview">
          <table>
            <thead><tr>${previewHeaders.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${previewRows.map(row => `<tr>${previewHeaders.map(h => `<td>${esc(row[h] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="o_import_options">
          <label class="o_checkbox">
            <input type="checkbox" id="importUpdateExisting" ${x.updateExisting ? 'checked' : ''} ${can ? '' : 'disabled'}>
            ${tx('تحديث السجلات الموجودة بنفس الرمز بدلًا من تخطيها', 'Update existing records with the same code instead of skipping them')}
          </label>
        </div>
        <div class="o_import_footer">
          <span class="o_muted">${fmtNum(x.rows.length)} ${tx('صف جاهز', 'rows ready')} · <span id="importMappedFooter">${mappedCount} ${tx('حقل مربوط', 'fields mapped')}</span></span>
          <button type="button" class="o_btn o_btn_primary" id="importApply" onclick="OW.wms.importApply()"
            ${canWrite && !missing.length && !x.busy ? '' : 'disabled'}>
            ${x.busy ? '<span class="o_spinner" style="width:14px;height:14px;border-width:2px"></span>' : '<i class="fa-solid fa-file-import"></i>'}
            ${x.busy ? tx('جارٍ الاستيراد…', 'Importing…') : tx('استيراد البيانات', 'Import data')}
          </button>
        </div>
      </section>
    </div>` : `<div class="o_import_empty">
      <i class="fa-regular fa-folder-open"></i>
      <b>${tx('لم يتم اختيار ملف بعد', 'No file selected yet')}</b>
      <span>${tx('اختر ملفًا لمعاينة الأعمدة وربطها قبل الاستيراد.', 'Choose a file to preview and map its columns before importing.')}</span>
    </div>`}
  </div>`;
}

function humanBytes(n) {
  const value = Number(n) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${fmtNum(value)} B`;
}

function lastLiveBackupMeta() {
  try {
    const v = JSON.parse(localStorage.getItem(LIVE_BACKUP_META) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch (_) { return null; }
}

function snapshotStats(snapshot) {
  const tables = snapshot?.tables && typeof snapshot.tables === 'object'
    ? Object.values(snapshot.tables) : [];
  const rows = tables.reduce((n, entry) => n + (Array.isArray(entry?.rows) ? entry.rows.length : 0), 0);
  const profile = snapshot?.exported_by?.profile || {};
  return {
    tables: tables.length,
    rows,
    exportedAt: snapshot?.exported_at || '',
    exportedBy: profile.name || profile.email || ''
  };
}

function renderData(banned) {
  const q = queueSnapshot();
  const bytes = (() => {
    try { return new Blob([localStorage.getItem('orshap_wms_data_v5') || '']).size; } catch (_) { return 0; }
  })();
  const meta = lastLiveBackupMeta();
  const summary = F.backup.summary;
  const isSuper = userRole() === 'SUPER_ADMIN';
  const busy = F.backup.busy;

  const liveBody = !isSuper
    ? alertBox(tx('النسخ الكاملة من الخادم والاستعادة متاحة لمدير النظام الأعلى (SUPER_ADMIN) فقط.',
      'Live server backup and restore are available to SUPER_ADMIN only.'), 'info')
    : `${alertBox(tx('نسخة الخادم الحية تشمل كل جداول WMS العامة: الأصناف، الأرصدة، السندات، التحويلات، الجرد، الوحدات، الصلاحيات والدردشة. لا تشمل حسابات Supabase Auth أو ملفات التخزين.',
      'The live server snapshot covers every public WMS table: items, stock, vouchers, transfers, stocktake, units, permissions and chat. It does not include Supabase Auth accounts or storage files.'), 'info')}
      <div class="o_line_tools" style="margin-top:12px;flex-wrap:wrap">
        <button class="o_btn o_btn_primary o_btn_sm" id="liveBackupBtn" onclick="OW.wms.downloadLiveSnapshot()" ${busy ? 'disabled' : ''}>
          <i class="fa-solid fa-cloud-arrow-down"></i> ${busy ? tx('جارٍ إنشاء اللقطة…', 'Building snapshot…') : tx('تنزيل نسخة الخادم الحية', 'Download live server snapshot')}</button>
        <label class="o_btn o_btn_secondary o_btn_sm" style="cursor:pointer">
          <i class="fa-regular fa-folder-open"></i> ${tx('اختيار ملف نسخة', 'Choose snapshot file')}
          <input type="file" id="restoreSnapshotFile" accept=".json,application/json" style="display:none">
        </label>
        ${summary ? `<button class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.clearRestoreSnapshot()" ${busy ? 'disabled' : ''}>
          <i class="fa-solid fa-xmark"></i> ${tx('إلغاء الملف', 'Clear file')}</button>` : ''}
        ${summary ? `<button class="o_btn o_btn_danger o_btn_sm" id="restoreSnapshotBtn" onclick="OW.wms.restoreLiveSnapshot()" ${busy ? 'disabled' : ''}>
          <i class="fa-solid fa-rotate-left"></i> ${tx('استعادة الخادم من الملف', 'Restore server from file')}</button>` : ''}
      </div>
      ${summary ? `<dl class="o_kv" style="margin-top:12px">
        <dt>${tx('الملف', 'File')}</dt><dd>${esc(F.backup.fileName)} — ${humanBytes(F.backup.fileSize)}</dd>
        <dt>${tx('وقت التصدير', 'Exported at')}</dt><dd>${summary.exportedAt ? fmtDateTime(summary.exportedAt) : '—'}</dd>
        <dt>${tx('الجداول', 'Tables')}</dt><dd>${fmtNum(summary.tables)}</dd>
        <dt>${tx('الصفوف', 'Rows')}</dt><dd>${fmtNum(summary.rows)}</dd>
        <dt>${tx('مُنشئ النسخة', 'Snapshot owner')}</dt><dd>${esc(summary.exportedBy || '—')}</dd>
      </dl>` : `<p class="o_hint" style="margin-top:12px">${tx('اختر ملف نسخة حية لمعاينة محتواه قبل الاستعادة. لا يتم رفع أي شيء قبل الضغط على زر الاستعادة والتأكيد.',
        'Choose a live snapshot file to preview it before restore. Nothing is uploaded until you press Restore and confirm.')}</p>`}
      ${meta ? `<p class="o_hint" style="margin-top:10px">${tx('آخر نسخة نُزّلت على هذا الجهاز:', 'Last snapshot downloaded on this device:')}
        <b>${meta.at ? fmtDateTime(meta.at) : '—'}</b> · ${fmtNum(meta.tables)} ${tx('جدول', 'tables')} · ${fmtNum(meta.rows)} ${tx('صف', 'rows')} · ${humanBytes(meta.bytes)}</p>` : ''}
      <div style="margin-top:12px">${alertBox(tx('الاستعادة تستبدل كل بيانات WMS العامة على الخادم بالنسخة المختارة. نزّل نسخة حديثة أولًا، ولا تغلق الصفحة أثناء التنفيذ.',
        'Restore replaces all public WMS data on the server with the selected snapshot. Download a current snapshot first and keep this page open while it runs.'), 'warning')}</div>`;

  return `
    <div class="o_grid" style="grid-template-columns:1fr 1fr">
      <div style="grid-column:1/-1">
        ${card(`<i class="fa-solid fa-cloud-arrow-down"></i> ${tx('نسخة الخادم الحية والاستعادة', 'Live server snapshot & restore')}`, liveBody)}
      </div>
      ${card(`<i class="fa-solid fa-database"></i> ${tx('لقطة البيانات المحلية', 'Local data snapshot')}`,
        `<dl class="o_kv">
          <dt>${tx('حجم التخزين', 'Storage size')}</dt><dd>${(bytes / 1024 / 1024).toFixed(2)} MB</dd>
          <dt>${tx('آخر تحديث', 'Last refresh')}</dt><dd>${store.lastSync ? fmtDateTime(store.lastSync) : '—'}</dd>
          <dt>${tx('عمليات معلّقة', 'Queued ops')}</dt><dd>${fmtNum(q.length)}</dd>
          <dt>${tx('سجل الحركة', 'Movement ledger')}</dt><dd>${fmtNum(store.get('inventory_ledger').length)}</dd>
          <dt>${tx('سجل التدقيق', 'Audit log')}</dt><dd>${fmtNum(store.get('audit_logs').length)}</dd>
        </dl>
        <div class="o_line_tools" style="margin-top:12px">
          <button class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.backupJson()">
            <i class="fa-solid fa-download"></i> ${tx('تنزيل نسخة الكاش المحلي', 'Download local cache JSON')}</button>
          <button class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.backupItemsCsv()">
            <i class="fa-solid fa-file-csv"></i> ${tx('تصدير الأصناف', 'Export items CSV')}</button>
          <button class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.settingsTab('import')">
            <i class="fa-solid fa-file-import"></i> ${tx('استيراد البيانات', 'Import data')}</button>
        </div>`)}
      ${card(`<i class="fa-solid fa-broom"></i> ${tx('أدوات محلية', 'Local tools')}`,
        `${alertBox(tx('مسح الكاش المحلي لا يؤثر على الخادم. أعد المزامنة بعد المسح.',
          'Clearing the local cache does not affect the server. Sync again afterwards.'), 'warning')}
        <div class="o_line_tools" style="margin-top:12px">
          <button class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.clearCache()" ${banned ? 'disabled' : ''}>
            <i class="fa-solid fa-eraser"></i> ${tx('مسح الكاش المحلي', 'Clear local cache')}</button>
          <button class="o_btn o_btn_secondary o_btn_sm" onclick="OW.wms.forgetOfflineLogin()">
            <i class="fa-solid fa-key"></i> ${tx('إلغاء الدخول دون اتصال', 'Forget offline login')}</button>
        </div>`)}
    </div>`;
}

/* ── mount ───────────────────────────────────────────────────────────────── */

function bind(_, main) {
  main.querySelectorAll('[data-flag]').forEach(cb => {
    cb.onchange = async () => {
      const key = cb.dataset.flag;
      const flag = FLAGS.find(f => f.key === key);
      cb.disabled = true;
      try {
        await upsertSetting(key, cb.checked ? 'true' : 'false', flag ? flag.descEn : '');
        toast(tx('تم حفظ الإعداد', 'Setting saved'), 'success');
      } catch (e) {
        cb.checked = !cb.checked;
        toast(String(e.message || e), 'error');
      } finally { cb.disabled = false; }
    };
  });

  main.querySelectorAll('[data-user]').forEach(b => b.onclick = () => userModal(b.dataset.user));
  main.querySelectorAll('[data-unit]').forEach(b => b.onclick = () => unitModal(b.dataset.unit));
  main.querySelectorAll('[data-unit-del]').forEach(b => b.onclick = () => removeUnit(b.dataset.unitDel));
  main.querySelectorAll('[data-conv]').forEach(b => b.onclick = () => convModal(b.dataset.conv));
  main.querySelectorAll('[data-conv-del]').forEach(b => b.onclick = () => removeConv(b.dataset.convDel));
  main.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => categoryModal(b.dataset.cat));
  main.querySelectorAll('[data-cat-del]').forEach(b => b.onclick = () => removeCategory(b.dataset.catDel));

  const convItem = main.querySelector('[name="convItem"]');
  if (convItem) convItem.onchange = () => { F.item = convItem.value; reload(); };

  const roleSel = main.querySelector('#permRole');
  if (roleSel) roleSel.onchange = () => { F.role = roleSel.value; reload(); };
  const permSearch = main.querySelector('#permSearch');
  if (permSearch) {
    let t;
    permSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { F.permSearch = permSearch.value; reload(); }, 300);
    });
  }
  const roleScopeMode = main.querySelector('#roleScopeMode');
  if (roleScopeMode) roleScopeMode.onchange = () => {
    const enabled = roleScopeMode.value === 'SELECTED' && canAdministerProfiles()
      && navigator.onLine && !window.__session?.offline;
    main.querySelectorAll('[data-role-warehouse]').forEach(c => { c.disabled = !enabled; });
  };
  const all = main.querySelector('#permAll');
  if (all) all.onclick = () => main.querySelectorAll('[data-perm]').forEach(c => { if (!c.disabled) c.checked = true; });
  const none = main.querySelector('#permNone');
  if (none) none.onclick = () => main.querySelectorAll('[data-perm]').forEach(c => { if (!c.disabled) c.checked = false; });
  const save = main.querySelector('#permSave');
  if (save) save.onclick = async () => {
    if (!canAdministerProfiles()) {
      toast(tx('إدارة صلاحيات الأدوار متاحة للمسؤول الأعلى فقط.', 'Only SUPER_ADMIN may administer role permissions.'), 'error');
      return;
    }
    if (!navigator.onLine || window.__session?.offline) {
      toast(tx('تعديل صلاحيات الأدوار يتطلب اتصالًا مباشرًا بالخادم.', 'Role permission changes require a live server connection.'), 'warning');
      return;
    }
    const keys = [...main.querySelectorAll('[data-perm]')].filter(c => c.checked).map(c => c.dataset.perm);
    const scopeMode = String(main.querySelector('#roleScopeMode')?.value || 'INHERIT').toUpperCase();
    const warehouseIds = [...main.querySelectorAll('[data-role-warehouse]:checked')].map(c => c.dataset.roleWarehouse);
    if (scopeMode === 'SELECTED' && warehouseIds.length === 0) {
      toast(tx('اختر مستودعاً واحداً على الأقل لهذا النطاق.', 'Select at least one warehouse for SELECTED scope.'), 'warning');
      return;
    }
    if (!await confirmDialog({
      title: tx('حفظ إعدادات الدور', 'Save role access configuration'),
      message: tx(
        `سيتم استبدال صلاحيات الدور "${roleLabel(F.role)}" (${keys.length}) وحفظ نطاق المستودعات (${scopeMode === 'SELECTED' ? warehouseIds.length : scopeMode}).`,
        `This replaces "${roleLabel(F.role)}" permissions (${keys.length}) and saves warehouse scope (${scopeMode === 'SELECTED' ? warehouseIds.length : scopeMode}).`
      ),
      confirmText: tx('حفظ', 'Save'), tone: 'primary'
    })) return;
    save.disabled = true;
    try {
      await replaceRolePermissions(F.role, keys, scopeMode, warehouseIds);
      toast(tx('تم تحديث صلاحيات الدور', 'Role permissions updated'), 'success');
      reload();
    } catch (e) { toast(String(e.message || e), 'error'); }
    finally { save.disabled = false; }
  };

  main.querySelectorAll('[data-import-entity]').forEach(button => {
    button.onclick = () => {
      const entity = button.dataset.importEntity;
      if (!IMPORT_ENTITIES[entity]) return;
      F.import.entity = entity;
      F.import.mapping = importMappingFor(entity, F.import.headers);
      F.import.result = null;
      reload();
    };
  });

  const restoreFile = main.querySelector('#restoreSnapshotFile');
  if (restoreFile) restoreFile.onchange = loadRestoreSnapshot;

  const importFile = main.querySelector('#importFile');
  if (importFile) {
    importFile.onchange = async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = await importReadFile(file);
        F.import.fileName = file.name;
        F.import.headers = parsed.headers;
        F.import.rows = parsed.rows;
        F.import.mapping = importMappingFor(F.import.entity, parsed.headers);
        F.import.result = null;
        reload();
      } catch (e) {
        event.target.value = '';
        toast(String(e?.message || e), 'error');
      }
    };
  }

  main.querySelectorAll('[data-import-map]').forEach(select => {
    select.onchange = () => {
      F.import.mapping[select.dataset.importMap] = select.value;
      refreshImportMappingState(main);
    };
  });

  const importUpdate = main.querySelector('#importUpdateExisting');
  if (importUpdate) importUpdate.onchange = () => { F.import.updateExisting = importUpdate.checked; };

  const authReload = main.querySelector('#authReload');
  if (authReload) authReload.onclick = () => { F.authorizationLoaded = false; F.authorizationError = ''; reload(); };
  const updateGrantFilter = () => {
    const search = main.querySelector('#authGrantSearch');
    const subject = main.querySelector('#authGrantSubject');
    const effect = main.querySelector('#authGrantEffect');
    const status = main.querySelector('#authGrantStatus');
    F.authorizationGrantFilter = {
      search: search?.value || '',
      subject: subject?.value || 'ALL',
      effect: effect?.value || 'ALL',
      status: status?.value || 'ALL'
    };
    reload();
  };
  const authGrantSearch = main.querySelector('#authGrantSearch');
  if (authGrantSearch) authGrantSearch.onchange = updateGrantFilter;
  ['authGrantSubject', 'authGrantEffect', 'authGrantStatus'].forEach(id => {
    const control = main.querySelector('#' + id);
    if (control) control.onchange = updateGrantFilter;
  });
  const authGrantAdd = main.querySelector('#authGrantAdd');
  if (authGrantAdd) authGrantAdd.onclick = authorizationGrantModal;
  main.querySelectorAll('[data-auth-revoke]').forEach(button => {
    button.onclick = () => revokeAuthorizationGrant(button.dataset.authRevoke);
  });

  if (F.tab === 'authorization' && canAdministerProfiles() && !F.authorizationLoaded && !F.authorizationLoading) {
    F.authorizationLoading = true;
    Promise.all([
      rpc('admin_list_authorization_grants', {
        p_subject_type: null, p_role_name: null, p_user_id: null, p_active_only: false, p_limit: 500
      }),
      rpc('admin_list_authorization_decisions', {
        p_since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        p_actor_user_id: null, p_limit: 250
      })
    ]).then(([grants, decisions]) => {
      F.authorizationGrants = Array.isArray(grants) ? grants : [];
      F.authorizationDecisions = Array.isArray(decisions) ? decisions : [];
      F.authorizationError = '';
    }).catch(error => {
      F.authorizationError = String(error?.message || error);
    }).finally(() => {
      F.authorizationLoading = false;
      F.authorizationLoaded = true;
      if (F.tab === 'authorization') reload();
    });
  }
}

/* ── user editing ────────────────────────────────────────────────────────── */

function authorizationGrantModal() {
  if (!canAdministerProfiles() || !navigator.onLine || window.__session?.offline) {
    toast(tx('إدارة التفويض تتطلب صلاحية المسؤول الأعلى واتصالاً مباشراً.', 'Grant administration requires SUPER_ADMIN and a live connection.'), 'warning');
    return;
  }
  const users = store.get('profiles').filter(p => p.status === 'ACTIVE');
  const permissions = permCatalog();
  const warehouses = store.get('warehouses');
  const body = `<form id="authorizationGrantForm" class="o_form_grid">
    <div class="o_field"><label>${tx('نوع المستفيد', 'Subject type')}</label>
      <select name="subject_type" id="authSubjectType"><option value="USER">${tx('مستخدم', 'User')}</option><option value="ROLE">${tx('دور', 'Role')}</option></select></div>
    <div class="o_field" id="authUserWrap"><label>${tx('المستخدم', 'User')}</label>
      <select name="user_id">${users.map(u => `<option value="${esc(u.id)}">${esc(u.name || u.email || u.id)} — ${esc(roleLabel(u.role))}</option>`).join('')}</select></div>
    <div class="o_field" id="authRoleWrap" style="display:none"><label>${tx('الدور', 'Role')}</label>
      <select name="role_name">${ROLES.filter(r => r !== 'SUPER_ADMIN').map(r => `<option value="${r}">${esc(roleLabel(r))}</option>`).join('')}</select></div>
    <div class="o_field full"><label>${tx('الصلاحية', 'Permission')}</label>
      <select name="permission_key" required>${permissions.map(p => `<option value="${esc(p.key)}">${esc(permissionLabel(p.key))} — ${esc(p.key)}</option>`).join('')}</select></div>
    <div class="o_field"><label>${tx('الأثر', 'Effect')}</label>
      <select name="effect"><option value="ALLOW">${tx('سماح', 'Allow')}</option><option value="DENY">${tx('منع', 'Deny')}</option></select></div>
    <div class="o_field"><label>${tx('نوع المورد', 'Resource type')}</label><input name="resource_type" placeholder="transaction / stocktake_session / stock_transfer / stock_transfer_order"></div>
    <div class="o_field"><label>${tx('معرّف السجل (اختياري)', 'Resource record ID (optional)')}</label><input name="resource_id" placeholder="UUID"></div>
    <div class="o_field"><label>${tx('المستودع', 'Warehouse')}</label>
      <select name="warehouse_id"><option value="">— ${tx('كل المستودعات ضمن نطاق المستخدم', 'All warehouses within user scope')} —</option>${warehouses.map(w => `<option value="${esc(w.id)}">${esc(w.code || '')} — ${esc(w.name || '')}</option>`).join('')}</select></div>
    <div class="o_field"><label>${tx('نطاق البيانات', 'Data scope')}</label>
      <select name="scope_type" id="authScopeType">
        <option value="WAREHOUSE" selected>WAREHOUSE</option><option value="OWN">OWN</option><option value="CONTEXT">CONTEXT</option><option value="ALL">ALL</option>
      </select></div>
    <div class="o_field full" id="authConditionsWrap"><label>${tx('شروط السياق JSON (إلزامية لنطاق CONTEXT)', 'Context conditions JSON (required for CONTEXT scope)')}</label>
      <textarea name="conditions" rows="3" placeholder='{"status":"PENDING_APPROVAL"}'></textarea>
      <small class="o_hint">${tx('تُطابق الشروط سياق العملية المرسل إلى محرك التفويض؛ استخدم أسماء حقول معروفة في سياق الإجراء.', 'Conditions are matched against the context passed to the authorization engine; use fields actually supplied by the action context.')}</small></div>
    <div class="o_field"><label>${tx('يبدأ التفويض في', 'Grant starts at')}</label><input type="datetime-local" name="valid_from"></div>
    <div class="o_field"><label>${tx('ينتهي التفويض في (إلزامي لمنح المستخدم)', 'Grant expires at (required for user grants)')}</label><input type="datetime-local" name="valid_until"></div>
    <div class="o_field full"><label>${tx('سبب منح التفويض', 'Grant reason')}</label><textarea name="reason" required rows="2"></textarea></div>
    <div class="o_field full"><div class="o_alert o_alert_info">${tx('المنع الصريح له الأولوية على السماح. نطاق الدور يظل مقيداً بتعيينات المستودعات الفعلية للمستخدم، ولا تمنح هذه المنحة تجاوزاً تلقائياً لفصل المهام أو الاعتماد الذاتي.', 'An explicit DENY takes precedence over ALLOW. Role scope remains constrained by the user’s actual warehouse assignments; this grant does not automatically bypass segregation of duties or self-approval controls.')}</div></div>
  </form>`;
  modal({
    title: `<i class="fa-solid fa-shield-halved"></i> ${tx('إنشاء منحة تفويض', 'Create authorization grant')}`,
    size: 'lg', body,
    footer: `<button class="o_btn o_btn_secondary" id="authGrantCancel">${tx('إلغاء', 'Cancel')}</button>
      <button class="o_btn o_btn_primary" id="authGrantSave">${tx('حفظ المنحة', 'Save grant')}</button>`,
    onMount: (el, close) => {
      const form = el.querySelector('#authorizationGrantForm');
      const subjectType = form.querySelector('#authSubjectType');
      const scopeSelect = form.querySelector('#authScopeType');
      const warehouseSelect = form.querySelector('[name="warehouse_id"]');
      const resourceTypeInput = form.querySelector('[name="resource_type"]');
      const validUntilInput = form.querySelector('[name="valid_until"]');
      const permissionSelect = form.querySelector('[name="permission_key"]');
      const resourceTypeForPermission = key => {
        if (key.startsWith('action:transaction:')) return 'transaction';
        if (key.startsWith('action:stocktake:')) return 'stocktake_session';
        if (key === 'action:stock_transfer:create') return 'stock_transfer_order';
        if (key.startsWith('action:stock_transfer:')) return 'stock_transfer';
        return '';
      };
      const syncSubject = () => {
        const isUserGrant = subjectType.value === 'USER';
        form.querySelector('#authUserWrap').style.display = isUserGrant ? '' : 'none';
        form.querySelector('#authRoleWrap').style.display = isUserGrant ? 'none' : '';
        const allOption = scopeSelect.querySelector('option[value="ALL"]');
        allOption.disabled = isUserGrant;
        if (isUserGrant && scopeSelect.value === 'ALL') scopeSelect.value = 'WAREHOUSE';
        if (!isUserGrant && scopeSelect.value === 'WAREHOUSE' && !warehouseSelect.value) scopeSelect.value = 'ALL';
        [...permissionSelect.options].forEach(option => {
          const supported = !!resourceTypeForPermission(option.value);
          option.hidden = isUserGrant && !supported;
          option.disabled = isUserGrant && !supported;
        });
        if (isUserGrant && !resourceTypeForPermission(permissionSelect.value)) {
          const firstSupported = [...permissionSelect.options].find(option => !!resourceTypeForPermission(option.value));
          if (firstSupported) permissionSelect.value = firstSupported.value;
        }
        resourceTypeInput.value = isUserGrant ? resourceTypeForPermission(permissionSelect.value) : resourceTypeInput.value;
        resourceTypeInput.readOnly = isUserGrant;
        resourceTypeInput.required = isUserGrant;
        resourceTypeInput.placeholder = isUserGrant
          ? 'transaction / stocktake_session / stock_transfer / stock_transfer_order'
          : 'Optional for global role grants';
        warehouseSelect.required = isUserGrant || scopeSelect.value === 'WAREHOUSE';
        validUntilInput.required = isUserGrant;
        form.querySelector('[name="conditions"]').required = scopeSelect.value === 'CONTEXT';
        form.querySelector('#authConditionsWrap').style.display = scopeSelect.value === 'CONTEXT' ? '' : 'none';
        warehouseSelect.disabled = !isUserGrant && scopeSelect.value === 'ALL';
      };
      subjectType.onchange = syncSubject;
      permissionSelect.onchange = syncSubject;
      scopeSelect.onchange = syncSubject;
      syncSubject();
      el.querySelector('#authGrantCancel').onclick = close;
      el.querySelector('#authGrantSave').onclick = async () => {
        const data = Object.fromEntries(new FormData(form).entries());
        if (!data.reason.trim()) {
          toast(tx('سبب المنح مطلوب.', 'A grant reason is required.'), 'warning');
          return;
        }
        let conditions = {};
        try {
          if (data.conditions.trim()) conditions = JSON.parse(data.conditions);
          if (!conditions || Array.isArray(conditions) || typeof conditions !== 'object') throw new Error('JSON must be an object');
        } catch (error) {
          toast(tx('شروط السياق يجب أن تكون كائن JSON صالحاً.', 'Context conditions must be a valid JSON object.'), 'error');
          return;
        }
        const resourceId = data.resource_id.trim() || null;
        const validFrom = data.valid_from ? new Date(data.valid_from) : new Date();
        const validUntil = data.valid_until ? new Date(data.valid_until) : null;
        if (Number.isNaN(validFrom.getTime()) || (validUntil && Number.isNaN(validUntil.getTime()))
            || (validUntil && validUntil <= validFrom)) {
          toast(tx('فترة صلاحية التفويض غير صحيحة؛ يجب أن يكون الانتهاء بعد تاريخ البداية.', 'Invalid grant validity window; expiry must be later than the start.'), 'error');
          return;
        }
        if (data.subject_type === 'USER'
            && (data.scope_type === 'ALL' || !data.warehouse_id || !data.resource_type.trim()
              || !validUntil || validUntil <= new Date())) {
          toast(tx('منحة المستخدم تتطلب نوع مورد ومستودعاً واحداً ونطاقاً محدوداً وتاريخ انتهاء مستقبلياً.', 'A user grant requires a resource type, one warehouse, a bounded scope and a future expiry.'), 'warning');
          return;
        }
        if (data.scope_type === 'WAREHOUSE' && !data.warehouse_id) {
          toast(tx('نطاق المستودع يتطلب اختيار مستودع.', 'WAREHOUSE scope requires a warehouse.'), 'warning');
          return;
        }
        if (data.scope_type === 'CONTEXT' && (!conditions || Object.keys(conditions).length === 0)) {
          toast(tx('نطاق السياق يتطلب شروط JSON غير فارغة.', 'CONTEXT scope requires non-empty JSON conditions.'), 'warning');
          return;
        }
        if (resourceId && !data.resource_type.trim()) {
          toast(tx('حدد نوع المورد قبل تحديد معرّف السجل.', 'Choose a resource type before specifying a record ID.'), 'warning');
          return;
        }
        if (resourceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId)) {
          toast(tx('معرّف السجل ليس UUID صالحاً.', 'Resource record ID is not a valid UUID.'), 'error');
          return;
        }
        const save = el.querySelector('#authGrantSave');
        save.disabled = true;
        try {
          await rpc('admin_create_authorization_grant_v2', {
            p_subject_type: data.subject_type,
            p_role_name: data.subject_type === 'ROLE' ? data.role_name : null,
            p_user_id: data.subject_type === 'USER' ? data.user_id : null,
            p_permission_key: data.permission_key,
            p_effect: data.effect,
            p_resource_type: data.resource_type.trim() || null,
            p_resource_id: resourceId,
            p_warehouse_id: data.warehouse_id || null,
            p_scope_type: data.scope_type,
            p_conditions: conditions,
            p_valid_from: validFrom.toISOString(),
            p_valid_until: validUntil ? validUntil.toISOString() : null,
            p_reason: data.reason.trim()
          });
          close();
          F.authorizationLoaded = false;
          toast(tx('تم إنشاء منحة التفويض وتسجيلها في سجل التدقيق.', 'Authorization grant created and audited.'), 'success');
          reload();
        } catch (error) {
          toast(String(error?.message || error), 'error');
        } finally { save.disabled = false; }
      };
    }
  });
}

async function revokeAuthorizationGrant(id) {
  if (!canAdministerProfiles() || !navigator.onLine || window.__session?.offline) return;
  const reason = await promptDialog({
    title: tx('إلغاء منحة التفويض', 'Revoke authorization grant'),
    label: tx('اكتب سبب إلغاء المنحة. سيُحفظ السبب في سجل التدقيق.', 'Enter the reason for revoking this grant. The reason is written to the audit log.'),
    placeholder: tx('سبب الإلغاء', 'Revocation reason'),
    confirmText: tx('إلغاء المنحة', 'Revoke grant')
  });
  if (reason === null) return;
  if (!reason.trim()) {
    toast(tx('سبب الإلغاء مطلوب.', 'A revocation reason is required.'), 'warning');
    return;
  }
  try {
    await rpc('admin_revoke_authorization_grant', { p_grant_id: id, p_reason: reason.trim() });
    F.authorizationLoaded = false;
    toast(tx('تم إلغاء المنحة وتسجيل القرار.', 'Grant revoked and audited.'), 'success');
    reload();
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

function userModal(id) {
  if (!canAdministerProfiles()) {
    toast(tx('إدارة ملفات المستخدمين متاحة للمسؤول الأعلى فقط.', 'Only SUPER_ADMIN may administer user profiles.'), 'error');
    return;
  }
  if (!navigator.onLine || window.__session?.offline) {
    toast(tx('إدارة ملفات المستخدمين تتطلب اتصالًا مباشرًا بالخادم.', 'Profile administration requires a live server connection.'), 'warning');
    return;
  }
  const u = store.byId('profiles', id);
  if (!u) return;
  const assigned = new Set(u.assigned_warehouse_ids || []);
  const body = `<form id="userForm" class="o_form_grid">
      ${input({ name: 'name', label: tx('الاسم', 'Name'), value: u.name || '' })}
      ${input({ name: 'email', label: tx('البريد', 'Email'), value: u.email || '', attrs: 'readonly' })}
      ${select({ name: 'role', label: tx('الدور', 'Role'), options: ROLES.map(r => ({ value: r, label: roleLabel(r) })), value: u.role })}
      ${select({ name: 'status', label: tx('الحالة', 'Status'), options: STATUSES.map(s => ({ value: s, label: statusLabel(s) })), value: u.status || 'ACTIVE' })}
      <div class="o_field full"><label>${tx('المستودعات المسموحة', 'Allowed warehouses')}</label>
        <div class="o_check_grid">
          ${store.get('warehouses').map(w => `<label class="o_checkbox"><input type="checkbox" name="wh" value="${w.id}" ${assigned.has(w.id) ? 'checked' : ''}> ${w.code} — ${w.name}</label>`).join('') || '<span class="o_muted">—</span>'}
        </div>
        <small class="o_hint">${tx('اترك الكل فارغًا للأدوار العليا. الأدوار العادية تحتاج مستودعًا واحدًا على الأقل.',
          'Leave empty for elevated roles. Regular roles need at least one warehouse.')}</small>
      </div>
      <div class="o_field full"><label class="o_checkbox">
        <input type="checkbox" name="can_approve_without_workflow" ${u.can_approve_without_workflow ? 'checked' : ''}>
        ${tx('يمكنه الاعتماد دون سير عمل', 'Can approve without workflow')}</label></div>
      <div class="o_field full">${alertBox(tx(
        'التفويضات الفردية لم تعد تُدار كقائمة صلاحيات عامة. استخدم تبويب «التفويض المتقدم» لمنح إجراء محدد على مورد ومستودع ونطاق بيانات معلوم، مع سبب المنح.',
        'Individual permissions are no longer maintained as an unrestricted key list. Use Advanced Authorization to grant a specific action on a resource, warehouse and data scope with an auditable reason.'
      ), 'info')}</div>
    </form>`;
  modal({
    title: `<i class="fa-solid fa-user-gear"></i> ${tx('تعديل مستخدم', 'Edit user')}`,
    size: 'md', body,
    footer: `<button class="o_btn o_btn_secondary" id="uCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="uSave">${tx('حفظ', 'Save')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#uCancel').onclick = close;
      el.querySelector('#uSave').onclick = async () => {
        if (!canAdministerProfiles() || !navigator.onLine || window.__session?.offline) {
          toast(tx('الصلاحية أو الاتصال غير متاح. أعد المحاولة بعد التحقق.', 'Permission or connection unavailable. Reconnect and retry.'), 'warning');
          return;
        }
        const form = el.querySelector('#userForm');
        const d = Object.fromEntries(new FormData(form).entries());
        const warehouseIds = [...form.querySelectorAll('[name="wh"]:checked')].map(c => c.value);
        try {
          await updateUser(id, {
            role: d.role,
            status: d.status,
            assigned_warehouse_ids: warehouseIds,
            can_approve_without_workflow: !!form.querySelector('[name="can_approve_without_workflow"]')?.checked,
          });
          close();
          toast(tx('تم تحديث المستخدم', 'User updated'), 'success');
          reload();
        } catch (e) { toast(String(e.message || e), 'error'); }
      };
    }
  });
}

function linkUserModal() {
  if (!canAdministerProfiles()) {
    toast(tx('ربط المستخدمين متاح للمسؤول الأعلى فقط.', 'Only SUPER_ADMIN may link user profiles.'), 'error');
    return;
  }
  if (!navigator.onLine || window.__session?.offline) {
    toast(tx('ربط المستخدمين يتطلب اتصالًا مباشرًا بالخادم.', 'Linking profiles requires a live server connection.'), 'warning');
    return;
  }
  const body = `<form id="linkForm" class="o_form_grid">
      ${input({ name: 'email', label: tx('البريد الإلكتروني', 'Email'), type: 'email', required: true })}
      ${input({ name: 'name', label: tx('الاسم', 'Name'), required: true })}
      ${select({ name: 'role', label: tx('الدور', 'Role'), options: ROLES.map(r => ({ value: r, label: roleLabel(r) })), value: 'CLERK' })}
      ${select({ name: 'status', label: tx('الحالة', 'Status'), options: STATUSES.map(s => ({ value: s, label: statusLabel(s) })), value: 'ACTIVE' })}
    </form>
    ${alertBox(tx('يجب أن يكون البريد مسجلًا في المصادقة أولًا. يُنشئ الربط ملفًا شخصيًا بدور ومستودعات.',
      'The email must already exist in authentication. Linking creates a profile with the chosen role.'), 'info')}`;
  modal({
    title: `<i class="fa-solid fa-user-plus"></i> ${tx('ربط مستخدم', 'Link user')}`,
    size: 'md', body,
    footer: `<button class="o_btn o_btn_secondary" id="luCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="luSave">${tx('ربط', 'Link')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#luCancel').onclick = close;
      el.querySelector('#luSave').onclick = async () => {
        if (!canAdministerProfiles() || !navigator.onLine || window.__session?.offline) {
          toast(tx('الصلاحية أو الاتصال غير متاح. أعد المحاولة بعد التحقق.', 'Permission or connection unavailable. Reconnect and retry.'), 'warning');
          return;
        }
        const d = Object.fromEntries(new FormData(el.querySelector('#linkForm')).entries());
        try {
          await adminLinkProfile({ email: d.email, name: d.name, role: d.role, status: d.status, warehouseIds: [] });
          close();
          toast(tx('تم ربط المستخدم', 'User linked'), 'success');
          reload();
        } catch (e) { toast(String(e.message || e), 'error'); }
      };
    }
  });
}

/* ── units / conversions / categories ────────────────────────────────────── */

function unitModal(id) {
  const u = id ? store.byId('units', id) : null;
  if (!canManageSystemSettings() || !navigator.onLine || window.__session?.offline) {
    toast(tx('إدارة الوحدات تتطلب صلاحية مدير النظام واتصالًا مباشرًا.', 'Unit management requires system-manager access and a live connection.'), 'warning');
    return;
  }
  modal({
    title: tx('وحدة قياس', 'Unit of measure'), size: 'sm',
    body: `<form id="unitForm" class="o_form_grid">
      ${input({ name: 'code', label: tx('الرمز', 'Code'), value: u?.code || '', required: true })}
      ${input({ name: 'name', label: tx('الاسم', 'Name'), value: u?.name || '', required: true })}
    </form>`,
    footer: `<button class="o_btn o_btn_secondary" id="unCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="unSave">${tx('حفظ', 'Save')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#unCancel').onclick = close;
      el.querySelector('#unSave').onclick = async () => {
        if (!canManageSystemSettings() || !navigator.onLine || window.__session?.offline) {
          toast(tx('الصلاحية أو الاتصال غير متاح. أعد المحاولة بعد التحقق.', 'Permission or connection unavailable. Reconnect and retry.'), 'warning');
          return;
        }
        const d = Object.fromEntries(new FormData(el.querySelector('#unitForm')).entries());
        d.code = String(d.code || '').trim().toUpperCase();
        d.name = String(d.name || '').trim();
        if (!d.code || !d.name) { toast(tx('الرمز والاسم مطلوبان.', 'Code and name are required.'), 'warning'); return; }
        try {
          if (u) await updateUnit(u.id, d); else await createUnit(d);
          close(); toast(tx('تم حفظ الوحدة', 'Unit saved'), 'success'); reload();
        } catch (e) { toast(friendlyError(e), 'error'); }
      };
    }
  });
}

async function removeUnit(id) {
  if (!canManageSystemSettings() || !navigator.onLine || window.__session?.offline) {
    toast(tx('حذف الوحدات يتطلب صلاحية مدير النظام واتصالًا مباشرًا.', 'Deleting units requires system-manager access and a live connection.'), 'warning');
    return;
  }
  if (!await confirmDialog({
    title: tx('حذف وحدة', 'Delete unit'),
    message: tx('قد تفشل العملية إذا كانت الوحدة مستخدمة.', 'This may fail if the unit is in use.'),
    confirmText: tx('حذف', 'Delete'), tone: 'danger'
  })) return;
  try { await deleteUnit(id); toast(tx('تم الحذف', 'Deleted'), 'success'); reload(); }
  catch (e) { toast(friendlyError(e), 'error'); }
}

function convModal(id) {
  const c = id ? store.byId('item_unit_conversions', id) : null;
  if (!canManageSystemSettings() || !navigator.onLine || window.__session?.offline) {
    toast(tx('إدارة معاملات الوحدات تتطلب صلاحية مدير النظام واتصالًا مباشرًا.', 'Unit-conversion management requires system-manager access and a live connection.'), 'warning');
    return;
  }
  const unitOptions = store.get('units')
    .map(u => String(u.code || '').trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .map(code => ({ value: code, label: code }));
  const itemOptions = store.get('items')
    .map(i => ({ value: i.id, label: `${i.code} — ${itemNameOnly(i)}` }));
  const baseHint = itemId => {
    const item = store.byId('items', itemId);
    return item
      ? tx(`الوحدة الأساسية لهذا الصنف: ${item.base_unit || 'PCS'}. المعامل يعني: 1 وحدة = X من ${item.base_unit || 'PCS'}.`,
        `This item’s base unit is ${item.base_unit || 'PCS'}. The factor means: 1 unit = X ${item.base_unit || 'PCS'}.`)
      : tx('اختر الصنف لعرض وحدته الأساسية.', 'Select the item to see its base unit.');
  };
  modal({
    title: tx('تحويل وحدة', 'Unit conversion'), size: 'sm',
    body: `<form id="convForm" class="o_form_grid">
      ${select({ name: 'item_id', label: tx('الصنف', 'Item'), options: itemOptions, value: c?.item_id || F.item || '', required: true })}
      ${select({ name: 'unit_code', label: tx('الوحدة', 'Unit'), options: unitOptions, value: c?.unit_code || '', required: true, placeholder: tx('اختر الوحدة', 'Select unit') })}
      ${input({ name: 'factor_to_base', label: tx('المعامل إلى الوحدة الأساسية', 'Factor to base unit'), type: 'number', value: c?.factor_to_base ?? '', required: true, attrs: 'min="0.000001" step="any"',
        hint: tx('مثال: إذا كانت الكرتونة 24 قطعة فالمعامل 24. لا تستخدم 1 إلا إذا كانت الوحدة مساوية فعلاً للأساس.',
          'Example: a box of 24 pieces has factor 24. Use 1 only when the unit is truly identical to the base.') })}
      <div class="o_field full" id="convBaseHint"><small class="o_hint">${esc(baseHint(c?.item_id || F.item || ''))}</small></div>
      ${alertBox(tx('تغيير المعامل يؤثر على الحركات المستقبلية فقط. السندات المعلقة التي استخدمت المعامل القديم ستُرفض عند الاعتماد وتحتاج إلى مراجعة.',
        'Changing a factor affects future movements only. Pending vouchers that used the old factor are rejected at approval and must be reviewed.'), 'info')}
    </form>`,
    footer: `<button class="o_btn o_btn_secondary" id="cvCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="cvSave">${tx('حفظ', 'Save')}</button>`,
    onMount: (el, close) => {
      const form = el.querySelector('#convForm');
      const itemSel = form.querySelector('[name="item_id"]');
      const hint = el.querySelector('#convBaseHint');
      itemSel.onchange = () => { hint.innerHTML = `<small class="o_hint">${esc(baseHint(itemSel.value))}</small>`; };
      el.querySelector('#cvCancel').onclick = close;
      el.querySelector('#cvSave').onclick = async () => {
        if (!canManageSystemSettings() || !navigator.onLine || window.__session?.offline) {
          toast(tx('الصلاحية أو الاتصال غير متاح. أعد المحاولة بعد التحقق.', 'Permission or connection unavailable. Reconnect and retry.'), 'warning');
          return;
        }
        const d = Object.fromEntries(new FormData(form).entries());
        const item = store.byId('items', d.item_id);
        const code = String(d.unit_code || '').trim().toUpperCase();
        d.unit_code = code;
        d.factor_to_base = Number(d.factor_to_base);
        if (!item) { toast(tx('اختر صنفاً صالحاً.', 'Select a valid item.'), 'warning'); return; }
        if (!code) { toast(tx('اختر الوحدة.', 'Select the unit.'), 'warning'); return; }
        if (code === String(item.base_unit || 'PCS').toUpperCase()) {
          toast(tx('لا يمكن إنشاء تحويل للوحدة الأساسية نفسها. معاملها 1 تلقائياً.', 'The base unit itself needs no conversion; its factor is always 1.'), 'warning');
          return;
        }
        if (!(d.factor_to_base > 0)) { toast(tx('المعامل يجب أن يكون أكبر من صفر', 'Factor must be greater than zero'), 'warning'); return; }
        const duplicate = store.get('item_unit_conversions').some(x =>
          x.id !== c?.id && x.item_id === d.item_id && String(x.unit_code || '').toUpperCase() === code);
        if (duplicate) { toast(tx('هذا الصنف لديه تحويل معتمد لهذه الوحدة بالفعل.', 'This item already has an approved conversion for that unit.'), 'warning'); return; }
        if (d.factor_to_base === 1) {
          const ok = await confirmDialog({
            title: tx('تأكيد معامل 1', 'Confirm factor 1'),
            message: tx(`هل 1 ${code} تساوي فعلاً 1 ${item.base_unit || 'PCS'}؟ معامل 1 يعني أن الوحدة مطابقة للأساس وليس مجرد اختصار.`,
              `Is 1 ${code} really equal to 1 ${item.base_unit || 'PCS'}? A factor of 1 means the unit is identical to the base, not just a label.`),
            confirmText: tx('نعم، متطابقة', 'Yes, identical')
          });
          if (!ok) return;
        }
        try {
          if (c) await updateUnitConversion(c.id, d); else await createUnitConversion(d);
          close(); toast(tx('تم حفظ التحويل', 'Conversion saved'), 'success'); reload();
        } catch (e) { toast(friendlyError(e), 'error'); }
      };
    }
  });
}

async function removeConv(id) {
  if (!canManageSystemSettings() || !navigator.onLine || window.__session?.offline) {
    toast(tx('حذف تحويل الوحدة يتطلب صلاحية مدير النظام واتصالًا مباشرًا.', 'Deleting a unit conversion requires system-manager access and a live connection.'), 'warning');
    return;
  }
  if (!await confirmDialog({ title: tx('حذف تحويل', 'Delete conversion'),
    message: tx('هل تريد حذف هذا التحويل؟', 'Delete this conversion?'),
    confirmText: tx('حذف', 'Delete'), tone: 'danger' })) return;
  try { await deleteUnitConversion(id); toast(tx('تم الحذف', 'Deleted'), 'success'); reload(); }
  catch (e) { toast(friendlyError(e), 'error'); }
}

function categoryModal(id) {
  const c = id ? store.byId('item_categories', id) : null;
  const permission = c ? 'action:item:update' : 'action:item:create';
  if (!can(permission)) {
    toast(tx('ليست لديك صلاحية إدارة هذا التصنيف.', 'You do not have permission to manage this category.'), 'error');
    return;
  }
  if (!navigator.onLine || window.__session?.offline) {
    toast(tx('تعديل التصنيفات يتطلب اتصالًا مباشرًا بالخادم.', 'Category changes require a live server connection.'), 'warning');
    return;
  }
  modal({
    title: tx('تصنيف صنف', 'Item category'), size: 'sm',
    body: `<form id="catForm" class="o_form_grid">
      ${input({ name: 'code', label: tx('الرمز', 'Code'), value: c?.code || '' })}
      ${input({ name: 'name', label: tx('الاسم', 'Name'), value: c?.name || '', required: true })}
      ${textarea({ name: 'description', label: tx('الوصف', 'Description'), value: c?.description || '', rows: 2 })}
      <div class="o_field full"><label class="o_checkbox">
        <input type="checkbox" name="is_active" ${c ? c.is_active !== false : true ? 'checked' : ''}>
        ${tx('نشط', 'Active')}</label></div>
    </form>`,
    footer: `<button class="o_btn o_btn_secondary" id="ctCancel">${tx('إلغاء', 'Cancel')}</button>
             <button class="o_btn o_btn_primary" id="ctSave">${tx('حفظ', 'Save')}</button>`,
    onMount: (el, close) => {
      el.querySelector('#ctCancel').onclick = close;
      el.querySelector('#ctSave').onclick = async () => {
        if (!can(permission) || !navigator.onLine || window.__session?.offline) {
          toast(tx('تغيرت الصلاحيات أو انقطع الاتصال. أعد المحاولة بعد التحقق.', 'Permissions changed or the connection was lost. Reconnect and retry.'), 'warning');
          return;
        }
        const form = el.querySelector('#catForm');
        const d = Object.fromEntries(new FormData(form).entries());
        d.is_active = !!form.querySelector('[name="is_active"]').checked;
        try {
          if (c) await updateCategory(c.id, d); else await createCategory(d);
          close(); toast(tx('تم حفظ التصنيف', 'Category saved'), 'success'); reload();
        } catch (e) { toast(String(e.message || e), 'error'); }
      };
    }
  });
}

async function removeCategory(id) {
  if (!can('action:item:delete')) {
    toast(tx('ليست لديك صلاحية حذف التصنيفات.', 'You do not have permission to delete categories.'), 'error');
    return;
  }
  if (!navigator.onLine || window.__session?.offline) {
    toast(tx('حذف التصنيفات يتطلب اتصالًا مباشرًا بالخادم.', 'Category deletion requires a live server connection.'), 'warning');
    return;
  }
  if (!await confirmDialog({ title: tx('حذف تصنيف', 'Delete category'),
    message: tx('قد تفشل العملية إذا كان التصنيف مستخدمًا.', 'This may fail if the category is in use.'),
    confirmText: tx('حذف', 'Delete'), tone: 'danger' })) return;
  try { await deleteCategory(id); toast(tx('تم الحذف', 'Deleted'), 'success'); reload(); }
  catch (e) { toast(String(e.message || e), 'error'); }
}

/* ── data tools ──────────────────────────────────────────────────────────── */

function backupJson() {
  const payload = { app: 'OW-WMS', version: 1, exported_at: new Date().toISOString(), data: store.data };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  a.download = `orshap-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 800);
  toast(tx('تم تنزيل النسخة الاحتياطية', 'Backup downloaded'), 'success');
}

async function downloadLiveSnapshot() {
  if (userRole() !== 'SUPER_ADMIN') {
    toast(tx('تنزيل نسخة الخادم متاح لمدير النظام الأعلى فقط.', 'Live server backup is available to SUPER_ADMIN only.'), 'error');
    return;
  }
  if (F.backup.busy) return;

  F.backup.busy = true;
  const button = document.getElementById('liveBackupBtn');
  if (button) {
    button.disabled = true;
    button.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${tx('جارٍ إنشاء اللقطة…', 'Building snapshot…')}`;
  }

  try {
    const snapshot = await rpc('export_wms_snapshot');
    if (!snapshot || snapshot.format !== 'orshap-wms-snapshot' || String(snapshot.version) !== '1'
      || !snapshot.tables || typeof snapshot.tables !== 'object') {
      throw new Error('SNAPSHOT_FORMAT_INVALID');
    }
    const stats = snapshotStats(snapshot);
    if (!stats.tables) throw new Error('SNAPSHOT_EMPTY');

    const text = JSON.stringify(snapshot);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    a.download = `orshap-live-${todayISO()}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    localStorage.setItem(LIVE_BACKUP_META, JSON.stringify({
      at: new Date().toISOString(),
      tables: stats.tables,
      rows: stats.rows,
      bytes: blob.size
    }));

    toast(tx(`تم تنزيل نسخة حية: ${fmtNum(stats.tables)} جدول و${fmtNum(stats.rows)} صف.`,
      `Live snapshot downloaded: ${fmtNum(stats.tables)} tables and ${fmtNum(stats.rows)} rows.`), 'success');
    reload();
  } catch (e) {
    console.error('[settings] live snapshot export failed', e);
    toast(friendlyError(e), 'error');
  } finally {
    F.backup.busy = false;
    if (button) {
      button.disabled = false;
      button.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> ${tx('تنزيل نسخة الخادم الحية', 'Download live server snapshot')}`;
    }
  }
}

async function loadRestoreSnapshot(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  F.backup.busy = true;
  try {
    const text = await file.text();
    let snapshot;
    try { snapshot = JSON.parse(text); }
    catch (_) { throw new Error('SNAPSHOT_FORMAT_INVALID'); }

    if (!snapshot || snapshot.format !== 'orshap-wms-snapshot' || String(snapshot.version) !== '1'
      || !snapshot.tables || typeof snapshot.tables !== 'object') {
      throw new Error('SNAPSHOT_FORMAT_INVALID');
    }
    const summary = snapshotStats(snapshot);
    if (!summary.tables) throw new Error('SNAPSHOT_EMPTY');

    F.backup = { busy: false, fileName: file.name, fileSize: file.size, snapshot, summary };
    toast(tx('تم فحص الملف. راجع الملخص قبل الاستعادة.',
      'Snapshot checked. Review the summary before restoring.'), 'success');
  } catch (e) {
    console.error('[settings] snapshot file invalid', e);
    F.backup = { busy: false, fileName: file.name, fileSize: file.size, snapshot: null, summary: null };
    toast(friendlyError(e), 'error');
  }
  reload();
}

function clearRestoreSnapshot() {
  F.backup = { busy: false, fileName: '', fileSize: 0, snapshot: null, summary: null };
  reload();
}

async function restoreLiveSnapshot() {
  if (userRole() !== 'SUPER_ADMIN') {
    toast(tx('استعادة الخادم متاحة لمدير النظام الأعلى فقط.', 'Server restore is available to SUPER_ADMIN only.'), 'error');
    return;
  }
  if (!F.backup.snapshot || !F.backup.summary || F.backup.busy) return;

  const stats = F.backup.summary;
  const proceed = await confirmDialog({
    title: tx('استعادة كاملة للخادم', 'Full server restore'),
    message: tx(`سيتم حذف كل بيانات WMS العامة الحالية واستبدالها بالنسخة المختارة (${fmtNum(stats.tables)} جدول و${fmtNum(stats.rows)} صف). لا يمكن التراجع عن هذه العملية.`,
      `All current public WMS data will be deleted and replaced by the selected snapshot (${fmtNum(stats.tables)} tables, ${fmtNum(stats.rows)} rows). This cannot be undone.`),
    confirmText: tx('متابعة', 'Continue'),
    tone: 'danger',
    dangerous: true
  });
  if (!proceed) return;

  const typed = await promptDialog({
    title: tx('تأكيد الاستعادة', 'Confirm restore'),
    label: tx('اكتب <b>RESTORE</b> لتأكيد الاستبدال الكامل.', 'Type <b>RESTORE</b> to confirm the full replacement.'),
    placeholder: 'RESTORE',
    confirmText: tx('استعادة الآن', 'Restore now')
  });
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'RESTORE') {
    toast(tx('لم يتم التأكيد. اكتب RESTORE بالضبط للمتابعة.',
      'Not confirmed. Type RESTORE exactly to continue.'), 'error');
    return;
  }

  F.backup.busy = true;
  const progress = modal({
    title: `<i class="fa-solid fa-rotate"></i> ${tx('جارٍ استعادة الخادم', 'Restoring server')}`,
    size: 'sm',
    closeOnBackdrop: false,
    body: `<div style="text-align:center;padding:10px 0 4px">
      <i class="fa-solid fa-circle-notch fa-spin" style="font-size:32px;color:#714B67"></i>
      <p style="margin-top:12px">${tx('يتم استبدال بيانات WMS العامة داخل معاملة واحدة. لا تغلق الصفحة.',
        'Public WMS data is being replaced in one transaction. Keep this page open.')}</p>
    </div>`
  });
  progress.el.querySelector('.o_modal_close').style.display = 'none';

  try {
    const result = await rpc('import_wms_snapshot', {
      p_snapshot: F.backup.snapshot,
      p_confirmation: 'RESTORE'
    });
    progress.close();
    F.backup = { busy: false, fileName: '', fileSize: 0, snapshot: null, summary: null };
    const applied = result?.rows != null ? fmtNum(result.rows) : fmtNum(stats.rows);
    toast(tx(`تمت استعادة ${applied} صف. ستُعاد الصفحة لتحديث كل البيانات.`,
      `${applied} rows restored. The page will reload to refresh all data.`), 'success');
    try { await pullAll(); } catch (_) {}
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    progress.close();
    F.backup.busy = false;
    console.error('[settings] live snapshot import failed', e);
    toast(friendlyError(e), 'error');
    reload();
  }
}

function backupItemsCsv() {
  downloadCSV(`items-${todayISO()}.csv`,
    [tx('الرمز', 'Code'), tx('الاسم', 'Name'), tx('الوحدة', 'Unit'), tx('حد الأمان', 'Safety'),
     tx('الحالة', 'Status'), tx('المخزون', 'On hand')],
    store.get('items').map(i => [i.code, itemNameOnly(i), i.base_unit,
      i.safety_stock, i.status,
      store.get('stock').filter(s => s.item_id === i.id).reduce((n, s) => n + Number(s.quantity || 0), 0)]));
  toast(tx('تم تصدير الأصناف', 'Items exported'), 'success');
}

async function clearCache() {
  if (!await confirmDialog({
    title: tx('مسح الكاش المحلي', 'Clear local cache'),
    message: tx('سيُحذف الكاش المحلي فقط. البيانات على الخادم لن تتأثر.',
      'Only the local cache is removed. Server data is untouched.'),
    confirmText: tx('مسح', 'Clear'), tone: 'danger'
  })) return;
  localStorage.removeItem('orshap_wms_data_v5');
  toast(tx('تم مسح الكاش — أعد التحميل للمزامنة', 'Cache cleared — reloading to sync'), 'info');
  setTimeout(() => location.reload(), 500);
}

function forgetOfflineLogin() {
  localStorage.removeItem('orshap_offline_auth_v1');
  toast(tx('تم إلغاء بيانات الدخول دون اتصال', 'Offline login data removed'), 'success');
}

/* ── globals ─────────────────────────────────────────────────────────────── */

OW.wms = OW.wms || {};
OW.wms.settingsTab = v => { F.tab = v; if (v === 'authorization') { F.authorizationLoaded = false; F.authorizationError = ''; } reload(); };
OW.wms.reloadSettings = async () => {
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  reload();
};
OW.wms.userModal = userModal;
OW.wms.authorizationGrantModal = authorizationGrantModal;
OW.wms.linkUser = linkUserModal;
OW.wms.unitModal = unitModal;
OW.wms.convModal = convModal;
OW.wms.categoryModal = categoryModal;
OW.wms.backupJson = backupJson;
OW.wms.backupItemsCsv = backupItemsCsv;
OW.wms.downloadLiveSnapshot = downloadLiveSnapshot;
OW.wms.restoreLiveSnapshot = restoreLiveSnapshot;
OW.wms.clearRestoreSnapshot = clearRestoreSnapshot;
OW.wms.clearCache = clearCache;
OW.wms.forgetOfflineLogin = forgetOfflineLogin;
OW.wms.importApply = applyImport;
OW.wms.importTemplate = importTemplate;
OW.wms.importClear = importClear;
OW.wms.importResultClear = importResultClear;

OW.registerPage('settings', {
  brand: { name: 'OW', icon: 'fa-solid fa-gear' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('المستخدمون', 'Users'), page: 'settings' },
    { label: tx('الصلاحيات', 'Permissions'), page: 'settings' },
    { label: tx('المزامنة', 'Synchronization'), page: 'sync' }
  ],
  render,
  mount: bind
});

export default OW.pages.settings;
