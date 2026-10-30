// ============================================================================
// OW — central store
// ----------------------------------------------------------------------------
// One in-memory snapshot (store.data), persisted to localStorage + optional
// SQLite/OPFS, hydrated from Supabase, with narrowly scoped offline work:
//   • tx outbox             → ISSUE vouchers only
//   • stocktake count queue → count entries only
//   • offline auth          → PBKDF2 verifier cached by core-auth.js
// ============================================================================
import { from, rpc, sb } from './core-supabase.js';
import { uuid, isUuid } from './core-utils.js';
import { isAr } from './core-i18n.js';
import { ensureOnlineSession } from './core-auth.js';

export { isUuid };

const LS_KEY = 'orshap_wms_data_v5';
const LS_LANG = 'orshap_lang';
// Legacy key is read only to quarantine pending master-data edits from older releases.
const LEGACY_MASTER_PREFIX = 'orshap_master_outbox_v1:';
const MASTER_QUARANTINE_PREFIX = 'orshap_master_outbox_quarantine_v1:';
const MASTER_REFRESH_REQUIRED_PREFIX = 'orshap_master_refresh_required_v1:';
const LEGACY_MASTER_REFRESH_TABLES = new Set(['warehouses', 'zones', 'storage_areas', 'sections', 'shelves', 'items', 'item_categories', 'units', 'item_unit_conversions', 'system_settings']);
const OUTBOX_PREFIX = 'orshap_tx_outbox_v1:';
const STOCKTAKE_COUNT_QUEUE_PREFIX = 'orshap_stocktake_count_queue_v1:';

// Normalize transport failures for the supported transaction and stocktake
// outboxes. Master-data mutations never enter an offline queue.
const NETWORK_ERROR_RE = /failed to fetch|fetch failed|networkerror|network request failed|load failed|network connection|connection (?:lost|failed|reset)|econn(?:refused|reset|aborted)|enotfound|socket hang up|timed? ?out|(?:^|\b)(?:no internet connection|internet connection lost|device is offline|browser is offline)(?:\b|$)/i;
const isNetworkFailure = error => NETWORK_ERROR_RE.test(String(error?.message ?? error ?? ''));
const hasLiveSession = () => !!window.__session?.id && !window.__session.offline;
const requireLiveConnection = (ar, en) => {
  if (!navigator.onLine || !hasLiveSession()) throw new Error(isAr() ? ar : en);
};
const signInOnlineMessage = () => isAr()
  ? 'سجّل الدخول عبر الإنترنت مرة واحدة لاستعادة جلسة الخادم ثم أعد المزامنة'
  : 'Sign in online once to restore the server session, then sync again';

// Only ISSUE vouchers may be entered offline. Stocktake counts use their own
// queue; receipts/supplies, transfers, returns, adjustments and other vouchers
// require a live connection. Offline scope remains one explicitly assigned warehouse.
const OFFLINE_TX_TYPES = new Set(['ISSUE']);

export const TABLES = [
  'warehouses', 'zones', 'storage_areas', 'warehouse_storage_areas',
  'legacy_section_classification',
  'sections', 'shelves', 'items', 'item_categories', 'units',
  'item_unit_conversions', 'stock', 'transactions', 'transaction_lines',
  'stocktake_sessions', 'stocktake_lines', 'stocktake_logs',
  'stock_transfers', 'stock_transfer_orders',
  'inventory_ledger', 'transaction_ledger', 'transaction_audit',
  'audit_logs', 'system_settings', 'profiles', 'permissions',
  'role_permissions', 'role_warehouse_scopes', 'archive_movements', 'archive_balances', 'sync_log'
];

export const ELEVATED_ROLES = ['SUPER_ADMIN'];

export const store = {
  data: Object.fromEntries(TABLES.map(t => [t, []])),
  loaded: false,
  offline: false,
  lastSync: null,
  noWarehouseAccess: false,
  scopeConfigLoaded: false,
  legacyMasterDataNeedsRefresh: false,
  loading: false,
  error: null,
  authorizationPermissions: [],
  authorizationPermissionsUserId: null,
  listeners: new Set(),
  get(table) { return this.data[table] || (this.data[table] = []); },
  byId(table, id) { return this.get(table).find(r => r.id === id) || null; },
  emit() {
    for (const fn of this.listeners) { try { fn(this); } catch (e) { console.warn(e); } }
    window.dispatchEvent(new CustomEvent('orshap-store-updated'));
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
};

export function rows(table) { return store.get(table); }
export function byId(table, id) { return store.byId(table, id); }
export function uid() { return uuid(); }

const currentUserId = () => window.__session?.id || 'anonymous';
const roleOf = () => String(window.__session?.role || '').toUpperCase();
const isElevated = () => ELEVATED_ROLES.includes(roleOf());

export function offlineTransactionTypeAllowed(type) {
  return !store.legacyMasterDataNeedsRefresh
    && OFFLINE_TX_TYPES.has(String(type || '').toUpperCase());
}

export function offlineWarehouseAllowed(warehouseId) {
  const session = window.__session;
  if (!warehouseId || !session?.id || store.legacyMasterDataNeedsRefresh) return false;
  // Resolve scope only from the active user's own profile. Never borrow another
  // cached profile's warehouse assignments just because it appears first.
  if (store.scopeConfigLoaded !== true) return false;
  const cachedProfile = store.get('profiles').find(p => p.id === session.id);
  const profile = session.profile?.id === session.id
    ? session.profile
    : (cachedProfile || {});
  const assigned = [...new Set((profile.assigned_warehouse_ids || []).filter(Boolean))];
  if (assigned.length !== 1 || assigned[0] !== warehouseId) return false;
  const roleScope = store.get('role_warehouse_scopes').find(row =>
    String(row.role_name || '').toUpperCase() === String(session.role || '').toUpperCase()
  ) || profile.role_warehouse_scope || null;
  const mode = String(roleScope?.scope_mode || 'INHERIT').toUpperCase();
  const roleIds = Array.isArray(roleScope?.warehouse_ids) ? roleScope.warehouse_ids : [];
  if (mode === 'SELECTED' && !roleIds.includes(warehouseId)) return false;
  // With an explicit user assignment, every non-SELECTED role mode preserves
  // that assignment as the effective scope (including MANAGER/INHERIT).
  return true;
}

/* ── local persistence ──────────────────────────────────────────────────── */

let persistTimer = null;
export function persist(immediate = false) {
  const write = () => {
    try {
      const payload = { ...store.data, __cached_user_id: currentUserId(), __scope_config_loaded: store.scopeConfigLoaded === true, __authorization_permissions: store.authorizationPermissions, __authorization_permissions_user_id: store.authorizationPermissionsUserId, __saved_at: new Date().toISOString() };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
      if (window.orshapSQLite?.saveState) {
        window.orshapSQLite.saveState(store.data).catch(() => {});
      }
    } catch (e) {
      console.warn('[store] local persist failed', e);
    }
  };
  if (immediate) { clearTimeout(persistTimer); write(); return; }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(write, 250);
}

export function loadLocal() {
  try {
    quarantineLegacyMasterQueue();
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      for (const t of TABLES) store.data[t] = [];
      store.authorizationPermissions = [];
      store.authorizationPermissionsUserId = null;
      store.scopeConfigLoaded = false;
      store.loaded = false;
      enrichAll();
      return false;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      for (const t of TABLES) store.data[t] = [];
      store.authorizationPermissions = [];
      store.authorizationPermissionsUserId = null;
      store.scopeConfigLoaded = false;
      store.loaded = false;
      enrichAll();
      return false;
    }

    // Never hydrate a cached snapshot unless it is bound to the currently
    // authenticated/offline-verified user. Queues are already user-keyed, but
    // the shared snapshot is not; accepting a missing owner or a different
    // owner can expose another account's warehouse and audit data on shared
    // devices. Keep the disk snapshot intact so its owner can sign back in.
    const activeUserId = window.__session?.id || null;
    if (!activeUserId || !parsed.__cached_user_id || parsed.__cached_user_id !== activeUserId) {
      for (const t of TABLES) store.data[t] = [];
      store.authorizationPermissions = [];
      store.authorizationPermissionsUserId = null;
      store.noWarehouseAccess = !!activeUserId
        && !ELEVATED_ROLES.includes(String(window.__session?.role || '').toUpperCase())
        && !(Array.isArray(window.__session?.profile?.assigned_warehouse_ids)
          && window.__session.profile.assigned_warehouse_ids.length);
      store.loaded = false;
      enrichAll();
      return false;
    }

    for (const t of TABLES) {
      if (Array.isArray(parsed[t])) store.data[t] = parsed[t];
    }
    store.scopeConfigLoaded = parsed.__scope_config_loaded === true;
    if (Array.isArray(parsed.__authorization_permissions)) {
      store.authorizationPermissions = parsed.__authorization_permissions.filter(x => typeof x === 'string');
      store.authorizationPermissionsUserId = parsed.__authorization_permissions_user_id === currentUserId()
        ? currentUserId() : null;
      if (store.authorizationPermissionsUserId === null) store.authorizationPermissions = [];
    } else {
      // One-time migration for snapshots written before effective grants were
      // cached. These legacy keys are only an offline UI hint; every sync/write
      // is re-authorized against authorization_grants by the database.
      const roleName = String(window.__session?.role || window.__session?.profile?.role || '').toUpperCase();
      const cachedRoleKeys = store.get('role_permissions')
        .filter(row => String(row.role_name || '').toUpperCase() === roleName)
        .map(row => row.permission_key);
      const cachedUserKeys = Array.isArray(window.__session?.profile?.custom_permissions)
        ? window.__session.profile.custom_permissions : [];
      store.authorizationPermissions = [...new Set([...cachedRoleKeys, ...cachedUserKeys]
        .filter(x => typeof x === 'string'))];
      store.authorizationPermissionsUserId = currentUserId();
    }
    enrichAll();
    store.loaded = true;
    if (!Array.isArray(parsed.__authorization_permissions)) persist(true);
    return true;
  } catch (e) {
    console.warn('[store] local load failed', e);
    return false;
  }
}

/* ── enrichment / relations ─────────────────────────────────────────────── */

function index(list, key = 'id') {
  const m = new Map();
  for (const r of list) m.set(r[key], r);
  return m;
}

export function enrichAll() {
  const shelves = index(store.get('shelves'));
  const warehouses = index(store.get('warehouses'));
  const zones = index(store.get('zones'));
  const sections = index(store.get('sections'));
  const items = index(store.get('items'));
  const profiles = index(store.get('profiles'));

  store.data.stock = store.get('stock').map(s => {
    const sh = shelves.get(s.shelf_id) || {};
    return {
      ...s,
      warehouse_id: sh.warehouse_id || s.warehouse_id || null,
      zone_id: sh.zone_id || s.zone_id || null,
      section_id: sh.section_id || s.section_id || null,
      storage_area_id: s.storage_area_id || sh.storage_area_id || null,
      _shelf: sh
    };
  });

  const linesByTx = new Map();
  for (const l of store.get('transaction_lines')) {
    if (!linesByTx.has(l.transaction_id)) linesByTx.set(l.transaction_id, []);
    linesByTx.get(l.transaction_id).push({ ...l, _item: items.get(l.item_id), _shelf: shelves.get(l.shelf_id) });
  }
  store.data.transactions = store.get('transactions').map(t => {
    const lines = linesByTx.get(t.id) || [];
    return {
      ...t,
      note: t.note ?? t.notes ?? '',
      total_qty: lines.reduce((n, l) => n + Number(l.quantity || 0), 0),
      line_count: lines.length,
      transaction_lines: lines,
      _warehouse: warehouses.get(t.warehouse_id),
      _creator: profiles.get(t.created_by)
    };
  });

  store.data.stock_transfers = store.get('stock_transfers').map(t => ({
    ...t,
    _item: items.get(t.item_id),
    _source: warehouses.get(t.source_warehouse_id),
    _destination: warehouses.get(t.destination_warehouse_id),
    _source_shelf: shelves.get(t.source_shelf_id),
    _dest_shelf: shelves.get(t.destination_shelf_id)
  }));

  store.data.stocktake_lines = store.get('stocktake_lines').map(l => ({
    ...l,
    _item: items.get(l.item_id),
    _shelf: shelves.get(l.shelf_id),
    variance: l.variance ?? (l.counted_qty == null ? null : Number(l.counted_qty) - Number(l.system_qty || 0))
  }));

  store.data.stocktake_sessions = store.get('stocktake_sessions').map(s => ({
    ...s,
    _warehouse: warehouses.get(s.warehouse_id),
    _creator: profiles.get(s.created_by),
    _lines: store.get('stocktake_lines').filter(l => l.session_id === s.id)
  }));

  store.data.stock_transfer_orders = store.get('stock_transfer_orders').map(o => ({
    ...o,
    _source: warehouses.get(o.source_warehouse_id),
    _destination: warehouses.get(o.destination_warehouse_id),
    _transfers: store.get('stock_transfers').filter(t => t.transfer_order_id === o.id)
  }));

  // convenience for facilities legacy sections
  store.data.sections = store.get('sections').map(s => ({
    ...s,
    _zone: zones.get(s.zone_id),
    _warehouse: warehouses.get(s.warehouse_id)
  }));
}

/* ── remote pull ────────────────────────────────────────────────────────── */

const REQUIRED = new Set(['warehouses', 'items', 'stock', 'transactions', 'transaction_lines', 'shelves', 'role_warehouse_scopes']);

export async function pullAll({ silent = false } = {}) {
  if (store.loading) return store.data;
  quarantineLegacyMasterQueue();
  // Offline sessions (and real offline) must never hit the network: with only the
  // anon key the RLS-protected tables return empty arrays, which would wipe the
  // local cache. Read the cached snapshot instead.
  const offlineSession = !!window.__session?.offline;
  if (!navigator.onLine || offlineSession) {
    store.offline = true;
    loadLocal();
    // Reapply only the two supported offline work queues over the cached snapshot.
    applyOutboxOverlay();
    applyStocktakeCountOverlay();
    applyAccessFilter();
    store.loaded = true;
    return store.data;
  }
  store.loading = true;
  store.error = null;
  try {
    const results = await Promise.all(TABLES.map(async t => {
      try {
        let res;
        if (t === 'stocktake_lines') {
          res = await rpc('list_stocktake_lines_secure');
          if (res) {
            // Secure RPC omits settlement columns; try a direct read for those
            // (permitted only for stocktake/table permissions).
            let settle = [];
            try {
              const r2 = await (await from('stocktake_lines')).select('*');
              if (!r2.error) settle = r2.data || [];
            } catch (_) {}
            if (settle.length) {
              const m = new Map(settle.map(x => [x.id, x]));
              res = res.map(x => ({ ...x, ...(m.get(x.id) || {}) }));
            }
            return [t, res || []];
          }
        }
        res = await (await from(t)).select('*');
        if (res.error) throw res.error;
        return [t, res.data || []];
      } catch (e) {
        if (REQUIRED.has(t)) throw new Error(`${t}: ${e.message || e}`);
        console.warn(`[store] optional table ${t} unavailable:`, e.message || e);
        // Preserve the previous in-memory value on a transient read/permission
        // failure. An unavailable table is not evidence that it is empty.
        return [t, null];
      }
    }));
    for (const [t, list] of results) {
      if (list !== null) store.data[t] = list;
    }
    // UI gates consume the same effective grant catalogue as the database.
    // This RPC returns only the signed-in user's candidate permission keys;
    // every actual read/write remains subject to contextual DB authorization.
    try {
      const permissionKeys = await rpc('current_user_authorization_permissions');
      store.authorizationPermissions = Array.isArray(permissionKeys)
        ? permissionKeys.filter(x => typeof x === 'string') : [];
      store.authorizationPermissionsUserId = currentUserId();
    } catch (permissionError) {
      if (store.authorizationPermissionsUserId !== currentUserId()) {
        store.authorizationPermissions = [];
        store.authorizationPermissionsUserId = null;
      }
      console.warn('[store] effective authorization permissions unavailable; preserving only this user\'s cached grant keys:', permissionError?.message || permissionError);
    }
    store.scopeConfigLoaded = results.some(([t, list]) => t === 'role_warehouse_scopes' && list !== null);
    if (store.legacyMasterDataNeedsRefresh
        && results.every(([t, list]) => !LEGACY_MASTER_REFRESH_TABLES.has(t) || list !== null)) {
      localStorage.removeItem(MASTER_REFRESH_REQUIRED_PREFIX + currentUserId());
      store.legacyMasterDataNeedsRefresh = false;
    }

    // Optional tables that failed to read retain their prior cache; only a
    // successful query returning zero rows is allowed to replace data with [].
    enrichAll();
    applyOutboxOverlay();
    applyStocktakeCountOverlay();
    applyAccessFilter();
    store.offline = false;
    store.loaded = true;
    store.lastSync = new Date().toISOString();
    persist(true);
    store.emit();
    return store.data;
  } catch (e) {
    store.error = e;
    console.error('[store] pull failed', e);
    if (!store.loaded) loadLocal();
    // A failed remote pull must not hide durable local work, even when the
    // store was already marked loaded before the request failed.
    applyOutboxOverlay();
    applyStocktakeCountOverlay();
    applyAccessFilter();
    store.offline = !navigator.onLine;
    store.loaded = true;
    throw e;
  } finally {
    store.loading = false;
  }
}

export function applyAccessFilter() {
  const user = window.__session;
  if (!user?.id) return;
  const roleName = String(user.role || user.profile?.role || '').toUpperCase();

  // SUPER_ADMIN is the sole global break-glass identity. Offline work still
  // has its separate exactly-one-explicit-warehouse restriction.
  if (roleName === 'SUPER_ADMIN') {
    store.noWarehouseAccess = false;
    return;
  }

  if (store.scopeConfigLoaded !== true) {
    store.noWarehouseAccess = true;
    for (const t of [
      'warehouses', 'zones', 'storage_areas', 'warehouse_storage_areas',
      'sections', 'shelves', 'stock', 'transactions', 'transaction_lines',
      'stocktake_sessions', 'stocktake_lines', 'stocktake_logs',
      'stock_transfers', 'stock_transfer_orders', 'inventory_ledger',
      'transaction_ledger', 'transaction_audit', 'audit_logs',
      'archive_movements', 'archive_balances', 'sync_log'
    ]) store.data[t] = [];
    enrichAll();
    return;
  }

  const assigned = Array.isArray(user.profile?.assigned_warehouse_ids)
    ? [...new Set(user.profile.assigned_warehouse_ids.filter(Boolean))] : [];
  const roleScope = store.get('role_warehouse_scopes').find(row =>
    String(row.role_name || '').toUpperCase() === roleName
  ) || user.profile?.role_warehouse_scope || null;
  const mode = String(roleScope?.scope_mode || 'INHERIT').toUpperCase();
  const roleIds = Array.isArray(roleScope?.warehouse_ids) ? roleScope.warehouse_ids : [];

  // Match current_user_can_access_warehouse(): user assignment is a restriction,
  // and SELECTED role scope intersects with that assignment.
  let allowedIds = null;
  if (assigned.length) {
    allowedIds = new Set(assigned);
    if (mode === 'SELECTED') {
      const selected = new Set(roleIds);
      allowedIds = new Set([...allowedIds].filter(id => selected.has(id)));
    }
  } else if (mode === 'SELECTED') {
    allowedIds = new Set(roleIds);
  } else if (mode === 'ALL') {
    allowedIds = null;
  } else {
    allowedIds = new Set();
  }

  store.noWarehouseAccess = allowedIds !== null && allowedIds.size === 0;
  if (allowedIds === null) return;

  const allow = allowedIds;
  store.data.warehouses = store.get('warehouses').filter(w => allow.has(w.id));
  store.data.zones = store.get('zones').filter(z => allow.has(z.warehouse_id));
  store.data.storage_areas = store.get('storage_areas').filter(a => allow.has(a.warehouse_id));
  store.data.warehouse_storage_areas = store.get('warehouse_storage_areas').filter(a => allow.has(a.warehouse_id));
  store.data.sections = store.get('sections').filter(x => allow.has(x.warehouse_id));
  store.data.shelves = store.get('shelves').filter(x => allow.has(x.warehouse_id));
  const shelfIds = new Set(store.data.shelves.map(x => x.id));
  store.data.stock = store.get('stock').filter(x => shelfIds.has(x.shelf_id));
  const txIds = new Set(store.get('transactions').filter(x => allow.has(x.warehouse_id)).map(x => x.id));
  store.data.transactions = store.get('transactions').filter(x => txIds.has(x.id));
  store.data.transaction_lines = store.get('transaction_lines').filter(x => txIds.has(x.transaction_id));
  const sessionIds = new Set(store.get('stocktake_sessions').filter(x => allow.has(x.warehouse_id)).map(x => x.id));
  store.data.stocktake_sessions = store.get('stocktake_sessions').filter(x => sessionIds.has(x.id));
  store.data.stocktake_lines = store.get('stocktake_lines').filter(x => sessionIds.has(x.session_id));
  store.data.stocktake_logs = store.get('stocktake_logs').filter(x => sessionIds.has(x.session_id));
  store.data.stock_transfers = store.get('stock_transfers').filter(x => allow.has(x.source_warehouse_id) || allow.has(x.destination_warehouse_id));
  store.data.stock_transfer_orders = store.get('stock_transfer_orders').filter(x => allow.has(x.source_warehouse_id) || allow.has(x.destination_warehouse_id));
  for (const t of ['inventory_ledger', 'transaction_ledger', 'transaction_audit', 'archive_movements', 'archive_balances', 'audit_logs', 'sync_log']) {
    store.data[t] = store.get(t).filter(x => !!x.warehouse_id && allow.has(x.warehouse_id));
  }
  enrichAll();
}

/* ── legacy master-queue quarantine (never replay) ─────────────────────── */

function readLegacyMasterQuarantine() {
  try {
    const value = JSON.parse(localStorage.getItem(MASTER_QUARANTINE_PREFIX + currentUserId()) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}

function quarantineLegacyMasterQueue() {
  const userId = window.__session?.id;
  if (!userId) return [];
  const legacyKey = LEGACY_MASTER_PREFIX + userId;
  const refreshKey = MASTER_REFRESH_REQUIRED_PREFIX + userId;
  let raw;
  try { raw = localStorage.getItem(legacyKey); } catch (_) {
    store.legacyMasterDataNeedsRefresh = true;
    return readLegacyMasterQuarantine();
  }
  if (!raw) {
    try { store.legacyMasterDataNeedsRefresh = localStorage.getItem(refreshKey) === '1'; }
    catch (_) { store.legacyMasterDataNeedsRefresh = true; }
    return readLegacyMasterQuarantine();
  }

  let legacy;
  try { legacy = JSON.parse(raw); } catch (_) { legacy = null; }
  const entries = Array.isArray(legacy) ? legacy : [{
    operation_id: 'legacy-malformed-master-queue', table: 'legacy master queue',
    kind: 'unreadable', raw_payload: raw
  }];
  const quarantined = readLegacyMasterQuarantine();
  const pendingEntries = entries.filter(entry => entry?.status !== 'SYNCED');
  if (pendingEntries.length) store.legacyMasterDataNeedsRefresh = true;
  let refreshBarrierPersisted = pendingEntries.length === 0;
  try {
    if (pendingEntries.length) localStorage.setItem(refreshKey, '1');
    const refreshMarkerStored = localStorage.getItem(refreshKey) === '1';
    if (pendingEntries.length && !refreshMarkerStored) {
      throw new Error('Unable to persist legacy master refresh barrier');
    }
    refreshBarrierPersisted = pendingEntries.length === 0 || refreshMarkerStored;
    store.legacyMasterDataNeedsRefresh = pendingEntries.length > 0 || refreshMarkerStored;
  } catch (e) {
    refreshBarrierPersisted = false;
    store.legacyMasterDataNeedsRefresh = true;
    console.warn('[store] legacy master refresh barrier failed:', e);
  }
  const seen = new Set(quarantined.map(row => row?.operation_id).filter(Boolean));
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.status === 'SYNCED') continue;
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {
      operation_id: `legacy-master-${i}`, raw_payload: String(entry)
    };
    const operationId = row.operation_id || `legacy-master-${i}-${row.table || 'unknown'}-${row.id || ''}`;
    if (seen.has(operationId)) continue;
    quarantined.push({
      ...row, operation_id: operationId, status: 'CONFLICT',
      last_error: 'BLOCKED_BY_OFFLINE_POLICY: Master-data changes require a live connection. Review this legacy entry and re-enter the change online; it will not be synchronized.',
      policy_blocked_at: new Date().toISOString()
    });
    seen.add(operationId);
  }
  try {
    if (pendingEntries.length && !refreshBarrierPersisted) {
      throw new Error('Legacy master refresh barrier could not be persisted; legacy queue retained.');
    }
    localStorage.setItem(MASTER_QUARANTINE_PREFIX + userId, JSON.stringify(quarantined));
    localStorage.removeItem(legacyKey);
  } catch (e) {
    store.legacyMasterDataNeedsRefresh = true;
    console.warn('[store] legacy master queue quarantine failed:', e);
  }
  return quarantined;
}

export async function retryQueueErrors() {
  let n = 0;
  for (const prefix of [OUTBOX_PREFIX, STOCKTAKE_COUNT_QUEUE_PREFIX]) {
    const key = prefix + currentUserId();
    try {
      const q = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(q)) continue;
      for (const op of q) if (op.status === 'ERROR') { op.status = 'PENDING'; op.last_error = null; n++; }
      localStorage.setItem(key, JSON.stringify(q));
    } catch (e) { console.warn(e); }
  }
  return n;
}

/* ── generic row mutations: live connection required ────────────────────── */

export async function insertRow(table, row) {
  requireLiveConnection(
    'هذه العملية تتطلب اتصالًا مباشرًا بالخادم. لا يُسمح باستيراد أو تعديل البيانات الرئيسية دون اتصال.',
    'This operation requires a live server connection. Master-data changes cannot be queued offline.'
  );
  const { data, error } = await (await from(table)).insert(row).select().single();
  if (error) throw error;
  await pullAll({ silent: true }).catch(() => {});
  return data;
}

export async function updateRow(table, id, patch) {
  requireLiveConnection(
    'هذه العملية تتطلب اتصالًا مباشرًا بالخادم. لا يُسمح باستيراد أو تعديل البيانات الرئيسية دون اتصال.',
    'This operation requires a live server connection. Master-data changes cannot be queued offline.'
  );
  const { data, error } = await (await from(table)).update(patch).eq('id', id).select().single();
  if (error) throw error;
  await pullAll({ silent: true }).catch(() => {});
  return data;
}

export async function deleteRow(table, id) {
  requireLiveConnection(
    'هذه العملية تتطلب اتصالًا مباشرًا بالخادم. لا يُسمح باستيراد أو تعديل البيانات الرئيسية دون اتصال.',
    'This operation requires a live server connection. Master-data changes cannot be queued offline.'
  );
  const { error } = await (await from(table)).delete().eq('id', id);
  if (error) throw error;
  await pullAll({ silent: true }).catch(() => {});
  return true;
}

export async function upsertSetting(key, value, description = '') {
  requireLiveConnection(
    'تعديل إعدادات النظام يتطلب اتصالًا مباشرًا بالخادم.',
    'System settings require a live server connection.'
  );
  const row = { key, value: String(value), description, updated_at: new Date().toISOString() };
  const { error } = await (await from('system_settings')).upsert(row, { onConflict: 'key' });
  if (error) throw error;
  const list = store.get('system_settings');
  const i = list.findIndex(x => x.key === key);
  if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
  persist(true);
  return row;
}

export function setting(key, fallback = null) {
  const row = store.get('system_settings').find(r => r.key === key);
  if (!row) return fallback;
  const v = row.value;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}

/* ── transaction outbox ─────────────────────────────────────────────────── */

const OUTBOX_KIND = 'transaction_bundle';
const PROVISIONAL_REFERENCE_RE = /^LOCAL-/i;
const REFERENCE_TIMEOUT_MS = 8000;

export function localTransactionReference() {
  return `LOCAL-${uid()}`;
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), REFERENCE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function officialTransactionReference() {
  const reference = await withTimeout(rpc('next_transaction_reference'), 'Transaction reference request');
  const value = typeof reference === 'string' ? reference.trim() : '';
  if (!value || PROVISIONAL_REFERENCE_RE.test(value)) {
    throw new Error('Database did not return an official transaction reference');
  }
  return value;
}

/**
 * Requests the next official voucher number. A local, collision-safe reference
 * is returned only for a genuine transport failure or while no live session is
 * available; validation and permission errors are surfaced unchanged.
 */
export async function requestTransactionReference() {
  if (!navigator.onLine) return { reference: localTransactionReference(), provisional: true };
  if (window.__session?.offline) {
    const live = await ensureOnlineSession();
    if (!live) return { reference: localTransactionReference(), provisional: true };
  }
  try {
    return { reference: await officialTransactionReference(), provisional: false };
  } catch (e) {
    if (isNetworkFailure(e)) return { reference: localTransactionReference(), provisional: true };
    throw e;
  }
}

export function outbox() {
  try {
    const a = JSON.parse(localStorage.getItem(OUTBOX_PREFIX + currentUserId()) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}

function outboxWrite(a) {
  localStorage.setItem(OUTBOX_PREFIX + currentUserId(), JSON.stringify(a));
  window.dispatchEvent(new CustomEvent('orshap-outbox-changed', { detail: { count: a.filter(x => x.status !== 'SYNCED').length } }));
}

function outboxEnqueue(payload) {
  const list = outbox();
  if (!list.some(x => x.operation_id === payload.operation_id)) {
    list.push({ ...payload, status: 'PENDING', attempts: 0, created_at: new Date().toISOString(), last_error: null });
  }
  outboxWrite(list);
}

function queuedTransactionEligible(tx) {
  return !!tx
    && offlineTransactionTypeAllowed(tx.transaction_type)
    && offlineWarehouseAllowed(tx.warehouse_id)
    && tx.created_by === window.__session?.id;
}

function applyOutboxOverlay() {
  const list = outbox().filter(x => x.status !== 'SYNCED');
  for (const op of list) {
    if (op.kind !== OUTBOX_KIND) continue;
    const tx = op.payload?.transaction;
    const lines = op.payload?.lines;
    if (!queuedTransactionEligible(tx) || !Array.isArray(lines)) continue;
    if (!store.get('transactions').some(x => x.id === tx.id)) {
      store.get('transactions').push({
        ...tx,
        status: 'PENDING_SYNC',
        _outbox: true,
        total_qty: lines.reduce((n, l) => n + Number(l.quantity || 0), 0)
      });
    }
    for (const l of lines) {
      if (!store.get('transaction_lines').some(x => x.id === l.id)) {
        store.get('transaction_lines').push({ ...l, transaction_id: tx.id, _outbox: true });
      }
    }
  }
  enrichAll();
}

function applyStocktakeCountOverlay() {
  const userId = currentUserId();
  if (!userId) return;
  const sessions = new Map(store.get('stocktake_sessions').map(s => [s.id, s]));
  const lines = new Map(store.get('stocktake_lines').map(l => [l.id, l]));
  let changed = false;
  for (const row of stocktakeCountQueue()) {
    if (row.user_id !== userId || row.status === 'SYNCED') continue;
    const line = lines.get(row.line_id);
    const session = line && sessions.get(line.session_id);
    // Only overlay a local count onto the matching locally cached line/session.
    // Never create rows from queue data or cross a session/warehouse boundary.
    if (!line || !session || session.id !== row.session_id
        || session.warehouse_id !== row.warehouse_id) continue;
    line.counted_qty = Number(row.base_quantity);
    line.entered_quantity = Number(row.entered_quantity);
    line.entered_unit = row.entered_unit || row.base_unit || line.base_unit;
    line.conversion_factor = Number(row.conversion_factor || 1);
    line.base_unit = row.base_unit || line.base_unit;
    line.variance = line.counted_qty - Number(line.system_qty || 0);
    line._count_pending_sync = true;
    line._count_sync_status = row.status || 'PENDING';
    line._count_sync_error = row.last_error || null;
    changed = true;
  }
  if (changed) enrichAll();
}

function repairOutboxIds(op) {
  const tx = op?.payload?.transaction;
  const lines = op?.payload?.lines;
  if (!tx || !Array.isArray(lines) || !lines.length) {
    throw new Error('Offline transaction payload is incomplete');
  }
  const previousId = tx.id;
  if (!isUuid(tx.id)) tx.id = uid();
  for (const line of lines) {
    if (!isUuid(line.id)) line.id = uid();
    if (!line.entered_unit) {
      // Old queued payloads were created before unit snapshots. They are base
      // quantities by construction, so never reinterpret them with a factor.
      const item = store.byId('items', line.item_id);
      line.base_unit = line.base_unit || item?.base_unit || 'PCS';
      line.entered_unit = line.base_unit;
      line.entered_quantity = Number(line.quantity);
      line.conversion_factor = 1;
    }
    const baseUnit = normalizeUnitCode(line.base_unit || store.byId('items', line.item_id)?.base_unit || 'PCS');
    const enteredUnit = normalizeUnitCode(line.entered_unit || baseUnit);
    let factor = Number(line.conversion_factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      factor = enteredUnit === baseUnit ? 1 : itemUnitFactor(line.item_id, enteredUnit);
    }
    line.base_unit = baseUnit;
    line.entered_unit = enteredUnit;
    line.conversion_factor = factor;
    line.entered_quantity = Number(line.entered_quantity);
    line.quantity = Number(line.quantity);
  }
  op.operation_id = tx.id;
  if (!String(tx.reference_no || '').trim()) tx.reference_no = localTransactionReference();
  if (String(tx.transaction_type || '').toUpperCase() === 'ISSUE'
    && !String(tx.usage_party || '').trim()) {
    throw new Error('Offline issues require a usage party');
  }
  if (!isUuid(tx.warehouse_id) || !isUuid(tx.created_by)
    || lines.some(line => !isUuid(line.item_id) || !isUuid(line.shelf_id)
      || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0
      || !line.entered_unit
      || !Number.isFinite(line.entered_quantity) || line.entered_quantity <= 0
      || !Number.isFinite(line.conversion_factor) || line.conversion_factor <= 0
      || !line.base_unit
      || Math.abs(line.quantity - (line.entered_quantity * line.conversion_factor)) > 1e-9)) {
    throw new Error('Offline transaction contains an invalid warehouse, user, item, shelf, quantity or unit');
  }
  if (previousId !== tx.id) {
    store.data.transactions = store.get('transactions').filter(x => !(x._outbox && x.id === previousId));
    store.data.transaction_lines = store.get('transaction_lines').filter(x => !(x._outbox && x.transaction_id === previousId));
  }
}

export async function flushOutbox() {
  if (!navigator.onLine || !window.__session?.id) return 0;
  if (!(await ensureOnlineSession())) return 0;
  const list = outbox();
  let changed = false, done = 0;
  for (const op of list) {
    if (['SYNCED', 'CONFLICT', 'ERROR'].includes(op.status)) continue;
    if (op.kind !== OUTBOX_KIND) continue;
    try {
      const tx = op.payload?.transaction;
      if (!tx || !offlineTransactionTypeAllowed(tx.transaction_type)) {
        throw new Error('Offline sync only supports ISSUE transactions; stocktake counts use a separate queue. All other transactions require a live connection.');
      }
      if (!offlineWarehouseAllowed(tx.warehouse_id) || tx.created_by !== window.__session.id) {
        throw new Error('Offline transaction requires exactly one explicitly assigned warehouse and must remain within the current effective scope.');
      }
      repairOutboxIds(op);
      if (PROVISIONAL_REFERENCE_RE.test(String(tx.reference_no || ''))) {
        tx.reference_no = await officialTransactionReference();
        op.payload.transaction = tx;
        changed = true;
        outboxWrite(list);
      }
      await rpc('create_offline_issue_bundle', {
        p_transaction_id: tx.id,
        p_transaction: tx,
        p_lines: op.payload.lines
      });
      op.status = 'SYNCED';
      op.last_error = null;
      op.synced_at = new Date().toISOString();
      changed = true;
      done++;
    } catch (e) {
      const message = String(e?.message || e);
      op.attempts = (op.attempts || 0) + 1;
      op.last_error = message;
      op.status = isNetworkFailure(e) ? 'PENDING'
        : (/idempotency conflict|does not match|UNIT_FACTOR_CHANGED|UNIT_NOT_CONFIGURED|BASE_UNIT_|UNIT_QUANTITY_MISMATCH|INVALID_CONVERSION_FACTOR/i.test(message) ? 'CONFLICT' : 'ERROR');
      changed = true;
      if (op.status === 'PENDING') break;
    }
  }
  if (changed) outboxWrite(list.filter(x => x.status !== 'SYNCED'));
  if (done) await pullAll({ silent: true }).catch(() => {});
  return done;
}

export function queueSnapshot() {
  const out = [];
  for (const x of quarantineLegacyMasterQueue()) {
    out.push({
      id: x.operation_id, source: 'blocked_master', table: x.table || 'legacy master data',
      operation: x.kind || 'unknown', status: 'CONFLICT', attempts: x.attempts || 0,
      error: x.last_error || 'Blocked by offline policy; re-enter the change while online.',
      time: x.created_at || x.policy_blocked_at || '', record: x.id || ''
    });
  }
  for (const x of outbox()) {
    if (x.status === 'SYNCED') continue;
    out.push({
      id: x.operation_id, source: 'transaction', table: 'transactions + lines',
      operation: x.kind || 'transaction_bundle', status: x.status || 'PENDING',
      attempts: x.attempts || 0, error: x.last_error || '', time: x.created_at || '',
      record: x.payload?.transaction?.reference_no || x.payload?.transaction?.id || ''
    });
  }
  for (const x of stocktakeCountQueue()) {
    if (x.status === 'SYNCED') continue;
    out.push({
      id: x.operation_id, source: 'stocktake', table: 'stocktake_lines',
      operation: 'stocktake_count', status: x.status || 'PENDING',
      attempts: x.attempts || 0, error: x.last_error || '', time: x.updated_at || x.created_at || '',
      record: x.line_id || x.session_id || ''
    });
  }
  return out;
}

let syncInFlight = null;

export async function syncAll() {
  if (!navigator.onLine) throw new Error(isAr() ? 'لا يوجد اتصال بالإنترنت' : 'No internet connection');
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    // A local (offline) session may still have a persisted Supabase auth token.
    // Promote it before touching the queue so a reconnect can resume without
    // forcing the user to type the password again.
    const liveSession = await ensureOnlineSession();
    if (!liveSession?.id) throw new Error(signInOnlineMessage());

    quarantineLegacyMasterQueue();
    if (store.legacyMasterDataNeedsRefresh) {
      await pullAll({ silent: true });
      if (store.legacyMasterDataNeedsRefresh) {
        throw new Error('Legacy master-data changes were quarantined. A complete online refresh is required before offline ISSUE or stocktake queues can sync.');
      }
    }
    const transactions = await flushOutbox();
    const stocktakeCounts = await flushStocktakeCountQueue();

    let refreshError = null;
    try {
      await pullAll({ silent: true });
    } catch (e) {
      refreshError = e;
      console.warn('[store] sync refresh failed', e);
    }

    const q = queueSnapshot();
    const pending = q.filter(x => x.status === 'PENDING' || !x.status).length;
    const errors = q.filter(x => x.status === 'ERROR').length;
    const conflicts = q.filter(x => x.status === 'CONFLICT').length;

    // Nothing was written and the server could not be read: report the real
    // failure instead of pretending the app is synchronised.
    if (!transactions && !stocktakeCounts && !q.length && refreshError) throw refreshError;

    return {
      transactions, stocktakeCounts, remaining: q.length, pending, errors, conflicts,
      refreshError: refreshError ? String(refreshError?.message || refreshError) : null
    };
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

/* ── transactions ───────────────────────────────────────────────────────── */

// Stock movements created here are ordinary vouchers only. Opening balances and
// returns are deliberately excluded: they have dedicated atomic RPCs below.
const VOUCHER_TYPES = new Set(['GRN', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT']);
const RETURN_TYPES = new Set(['RETURN_FROM_USAGE', 'RETURN_FROM_CUSTOMER', 'RETURN_TO_SUPPLIER']);

export const AUTO_APPROVE_CREATE_PERMISSION = Object.freeze({
  GRN: 'action:transaction:grn:create',
  RETURN_FROM_USAGE: 'action:transaction:grn:create',
  RETURN_FROM_CUSTOMER: 'action:transaction:grn:create',
  ISSUE: 'action:transaction:issue:create',
  RETURN_TO_SUPPLIER: 'action:transaction:issue:create',
  ADJUSTMENT_IN: 'action:transaction:adjustment:create',
  ADJUSTMENT_OUT: 'action:transaction:adjustment:create',
  OPENING_BALANCE: 'action:transaction:adjustment:create'
});

// Mirrors approve_transaction + guard_transaction_status_change.
// Self-approval is never inferred from role or the global workflow setting.
// The server evaluates both grants (including scoped denies); this client
// pre-check is only an optimization and fails closed on any RPC failure.
export async function shouldAutoApprove(transactionType) {
  const session = window.__session;
  if (!session?.id) return false;

  const profile = session.profile?.id === session.id
    ? session.profile
    : store.get('profiles').find(row => row.id === session.id) || null;
  if (!profile || profile.can_approve_without_workflow !== true) return false;

  const createPermission = AUTO_APPROVE_CREATE_PERMISSION[String(transactionType || '').toUpperCase()];
  if (!createPermission) return false;

  try {
    const [hasAutoApprove, hasCreate] = await Promise.all([
      rpc('current_user_has_permission', { p_permission: 'action:transaction:auto_approve' }),
      rpc('current_user_has_permission', { p_permission: createPermission })
    ]);
    return hasAutoApprove === true && hasCreate === true;
  } catch (error) {
    console.warn('[store] auto-approval authorization check failed', error);
    return false;
  }
}

export async function createTransactionBundle({
  type, warehouse_id, zone_id, section_id, storage_area_id = null,
  supplier = null, receiver_name = null, usage_party = null,
  adjustment_reason = null, external_reference = null, notes = null,
  reference_no = null, lines = []
}) {
  const normalizedType = String(type || '').toUpperCase();
  if (!VOUCHER_TYPES.has(normalizedType)) {
    throw new Error(isAr()
      ? 'نوع السند غير مدعوم في هذا النموذج. استخدم مسار المرتجعات أو الأرصدة الافتتاحية المخصص.'
      : 'Unsupported voucher type in this form. Use the dedicated returns or opening-balance workspace.');
  }
  if (!window.__session?.id) {
    throw new Error(isAr() ? 'سجّل الدخول أولًا.' : 'Sign in before creating a voucher.');
  }
  if (!lines.length) throw new Error(isAr() ? 'أضف سطرًا واحدًا على الأقل' : 'Add at least one line');
  if (normalizedType === 'ISSUE' && !String(usage_party || '').trim()) {
    throw new Error(isAr() ? 'جهة الاستخدام مطلوبة لأسناد الصرف.' : 'Usage party is required for issues.');
  }

  const prepared = lines.map(l => {
    const shelf = store.byId('shelves', l.shelf_id);
    const item = store.byId('items', l.item_id);
    const baseUnit = normalizeUnitCode(l.base_unit || item?.base_unit || 'PCS');
    const enteredUnit = normalizeUnitCode(l.entered_unit || l.unit || baseUnit);
    const enteredQty = Number(l.entered_quantity ?? l.quantity);
    let factor = Number(l.conversion_factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      factor = enteredUnit === baseUnit ? 1 : itemUnitFactor(l.item_id, enteredUnit);
    }
    const baseQty = Number(l.quantity);
    return {
      id: l.id || uid(),
      item_id: l.item_id,
      shelf_id: l.shelf_id,
      storage_area_id: l.storage_area_id || shelf?.storage_area_id || null,
      quantity: baseQty,
      entered_quantity: enteredQty,
      entered_unit: enteredUnit,
      conversion_factor: factor,
      base_unit: baseUnit,
      batch_no: l.batch_no || null,
      expiry_date: l.expiry_date || null,
      notes: l.notes || null
    };
  });

  const invalid = !isUuid(warehouse_id)
    || !isUuid(window.__session.id)
    || prepared.some(l => !isUuid(l.item_id) || !isUuid(l.shelf_id)
      || !Number.isFinite(l.quantity) || l.quantity <= 0
      || !l.entered_unit
      || !Number.isFinite(l.entered_quantity) || l.entered_quantity <= 0
      || !Number.isFinite(l.conversion_factor) || l.conversion_factor <= 0
      || !l.base_unit
      || Math.abs(l.quantity - (l.entered_quantity * l.conversion_factor)) > 1e-9);
  if (invalid) {
    throw new Error(isAr()
      ? 'يوجد معرّف أو كمية أو وحدة غير صالحة في السند. أعد اختيار الصنف والوحدة ثم حاول مجددًا.'
      : 'The voucher contains an invalid ID, quantity or unit. Re-select the item and unit, then try again.');
  }

  // A locally verified session can be promoted with the persisted Supabase
  // token. When that is impossible the request stays local and queued.
  let online = navigator.onLine;
  if (online && window.__session.offline) online = !!(await ensureOnlineSession());

  let reference = String(reference_no || '').trim();
  if (!reference) {
    const requested = await requestTransactionReference();
    reference = requested.reference;
  }
  const provisionalReference = PROVISIONAL_REFERENCE_RE.test(reference);

  const tx = {
    id: uid(), reference_no: reference, transaction_type: normalizedType,
    status: 'PENDING_APPROVAL', warehouse_id, zone_id: zone_id || null,
    section_id: section_id || null,
    storage_area_id: storage_area_id || prepared[0].storage_area_id || null,
    supplier: supplier || null, receiver_name: receiver_name || null,
    usage_party: String(usage_party || '').trim() || null,
    adjustment_reason: adjustment_reason || null,
    external_reference: external_reference || null, notes: notes || null,
    created_by: window.__session.id, created_at: new Date().toISOString()
  };

  const assertOfflineEligible = () => {
    if (!offlineTransactionTypeAllowed(normalizedType)) {
      throw new Error(isAr()
        ? 'دون اتصال: يُسمح بالصرف وعدّ الجرد فقط. التوريد والتحويل والاستلام والإرجاع والتسويات وبقية المعاملات تتطلب اتصالاً مباشراً.'
        : 'Offline mode supports issues and stocktake counts only. Receipts, transfers, receiving, returns, adjustments, and all other transactions require a live connection.');
    }
    if (!offlineWarehouseAllowed(warehouse_id)) {
      throw new Error(isAr()
        ? 'دون اتصال: يلزم مستودع واحد معيّن صراحةً لحسابك.'
        : 'Offline mode requires exactly one explicitly assigned warehouse.');
    }
  };

  const queueLocally = () => {
    assertOfflineEligible();
    outboxEnqueue({ operation_id: tx.id, kind: OUTBOX_KIND, payload: { transaction: tx, lines: prepared } });
    applyOutboxOverlay();
    persist(true);
    store.emit();
    if (navigator.onLine) void flushOutbox().catch(e => console.warn('[store] queued voucher sync deferred', e));
    return { transaction: tx, queued: true, offline: !navigator.onLine };
  };

  if (!online || provisionalReference) return queueLocally();

  try {
    await rpc('create_transaction_with_lines_v2', {
      p_transaction_id: tx.id, p_transaction: tx, p_lines: prepared
    });
  } catch (e) {
    // The RPC is idempotent on the exact transaction id and payload. Replaying
    // the official-reference payload from the outbox is therefore safe.
    if (isNetworkFailure(e)) return queueLocally();
    throw e;
  }

  let approved = false;
  if (await shouldAutoApprove(normalizedType)) {
    try { await rpc('approve_transaction', { p_transaction_id: tx.id }); approved = true; }
    catch (e) { console.warn('[store] auto-approval failed', e); }
  }
  await pullAll({ silent: true }).catch(() => {});
  return { transaction: tx, approved, queued: false, offline: false };
}

export async function approveTransaction(id) {
  requireLiveConnection('اعتماد السند يتطلب اتصالاً مباشراً بقاعدة البيانات.', 'Voucher approval requires a live database connection.');
  try {
    await rpc('approve_transaction', { p_transaction_id: id });
  } catch (e) {
    if (isNetworkFailure(e)) throw new Error(isAr()
      ? 'تعذر الوصول إلى الخادم. تحقق من الاتصال ثم أعد المحاولة.'
      : 'Could not reach the server. Check the connection and try again.');
    throw e;
  }
  await pullAll({ silent: true }).catch(() => {});
}

export async function rejectTransaction(id, reason) {
  requireLiveConnection('رفض السند يتطلب اتصالاً مباشراً بقاعدة البيانات.', 'Voucher rejection requires a live database connection.');
  const note = String(reason || '').trim();
  if (!note) throw new Error(isAr() ? 'سبب الرفض مطلوب.' : 'A rejection reason is required.');
  try {
    // The database RPC enforces permission, pending state, warehouse access and
    // writes the audit log. Never update the transactions table directly here.
    await rpc('reject_transaction', { p_transaction_id: id, p_reason: note });
  } catch (e) {
    if (isNetworkFailure(e)) throw new Error(isAr()
      ? 'تعذر الوصول إلى الخادم. تحقق من الاتصال ثم أعد المحاولة.'
      : 'Could not reach the server. Check the connection and try again.');
    throw e;
  }
  await pullAll({ silent: true }).catch(() => {});
}

export async function createStockReturnRequest({
  returnId, returnType, referenceNo, itemId,
  quantity, batchNo, expiryDate, shelfId, supplier, externalReference, notes
}) {
  requireLiveConnection('إنشاء المرتجعات يتطلب اتصالاً مباشراً بقاعدة البيانات. أعد الاتصال ثم حاول مجددًا.',
    'Returns require a live database connection. Reconnect and try again.');
  const type = String(returnType || '').toUpperCase();
  if (!RETURN_TYPES.has(type)) {
    throw new Error(isAr() ? 'نوع المرتجع غير مدعوم.' : 'Unsupported return type.');
  }
  const qty = Number(quantity);
  const invalid = !isUuid(itemId) || !isUuid(shelfId)
    || !Number.isFinite(qty) || qty <= 0;
  if (invalid) {
    throw new Error(isAr()
      ? 'تحقق من الصنف والرف والكمية قبل إنشاء المرتجع.'
      : 'Check the item, shelf and quantity before creating the return.');
  }
  if (type === 'RETURN_TO_SUPPLIER' && !String(supplier || '').trim()) {
    throw new Error(isAr() ? 'اسم المورد مطلوب للمرتجع إلى المورد.' : 'Supplier is required for a supplier return.');
  }
  if (type !== 'RETURN_TO_SUPPLIER' && !String(externalReference || '').trim()) {
    throw new Error(isAr() ? 'مرجع مستند المرتجع مطلوب.' : 'The return document reference is required.');
  }
  let reference = String(referenceNo || '').trim();
  if (!reference || PROVISIONAL_REFERENCE_RE.test(reference)) reference = await officialTransactionReference();
  try {
    const res = await rpc('create_stock_return_request', {
      p_return_id: returnId || uid(),
      p_return_type: type,
      p_reference_no: reference,
      p_item_id: itemId,
      p_quantity: qty,
      p_batch_no: batchNo || null,
      p_expiry_date: expiryDate || null,
      p_shelf_id: shelfId,
      p_supplier: supplier || null,
      p_external_reference: externalReference || null,
      p_notes: notes || null
    });
    await pullAll({ silent: true }).catch(() => {});
    return res;
  } catch (e) {
    if (isNetworkFailure(e)) throw new Error(isAr()
      ? 'تعذر الوصول إلى الخادم. لم يتم تأكيد إنشاء المرتجع؛ تحقق من الاتصال وسجل المرتجعات قبل إعادة المحاولة.'
      : 'Could not reach the server. The return was not confirmed; check the connection and the voucher list before retrying.');
    throw e;
  }
}

/* ── transfers ──────────────────────────────────────────────────────────── */

export async function dispatchTransfer({ orderId, referenceNo, sourceWarehouseId, destinationWarehouseId, lines, notes }) {
  requireLiveConnection('إنشاء التحويل يتطلب اتصالاً مباشراً.', 'Transfer dispatch requires a live connection.');
  const res = await rpc('dispatch_stock_transfer_order_v3', {
    p_order_id: orderId || uid(),
    p_reference_no: referenceNo || ('TRF-' + Date.now()),
    p_source_warehouse_id: sourceWarehouseId,
    p_destination_warehouse_id: destinationWarehouseId,
    p_lines: lines,
    p_notes: notes || null
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function receiveTransfer({ transferId, qty, shelfId, returnRemaining = false, reason = null, operationId = null }) {
  requireLiveConnection('استلام التحويل يتطلب اتصالاً مباشراً.', 'Transfer receiving requires a live connection.');
  const res = await rpc('receive_stock_transfer_quantity_at_shelf_v2', {
    p_transfer_id: transferId,
    p_received_quantity: Number(qty),
    p_destination_shelf_id: shelfId || null,
    p_return_remaining: !!returnRemaining,
    p_reason: reason || null,
    p_operation_id: operationId || uid()
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function rejectTransferReceipt(id, reason) {
  requireLiveConnection('رفض الاستلام يتطلب اتصالاً مباشراً.', 'Receipt rejection requires a live connection.');
  const res = await rpc('reject_stock_transfer_receipt', { p_transfer_id: id, p_reason: reason });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function reviewTransferReturn(id, decision, note) {
  requireLiveConnection('مراجعة طلب الإرجاع تتطلب اتصالاً مباشراً.', 'Return review requires a live connection.');
  const res = await rpc('review_stock_transfer_return_request', {
    p_transfer_id: id, p_decision: decision, p_note: note || null
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function confirmTransferReturn(id) {
  requireLiveConnection('تأكيد الإرجاع يتطلب اتصالاً مباشراً.', 'Return confirmation requires a live connection.');
  const res = await rpc('confirm_stock_transfer_return_v2', { p_transfer_id: id });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

/* ── stocktake ──────────────────────────────────────────────────────────── */

export async function createStocktakeSession({ warehouseId, storageAreaId, type = 'CYCLE', mode = 'VISIBLE', notes }) {
  requireLiveConnection('إنشاء جلسة الجرد يتطلب اتصالاً مباشراً؛ عدّ الكميات فقط يمكن حفظه محلياً.', 'Creating a stocktake session requires a live connection; only count entries can be saved offline.');
  const res = await rpc('create_stocktake_session_with_lines', {
    p_warehouse_id: warehouseId,
    p_storage_area_id: storageAreaId || null,
    p_stocktake_type: type,
    p_count_mode: mode,
    p_notes: notes || null
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

function stocktakeCountQueue() {
  try {
    const rows = JSON.parse(localStorage.getItem(STOCKTAKE_COUNT_QUEUE_PREFIX + currentUserId()) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}

function stocktakeCountQueueWrite(rows) {
  localStorage.setItem(STOCKTAKE_COUNT_QUEUE_PREFIX + currentUserId(), JSON.stringify(rows));
  window.dispatchEvent(new CustomEvent('orshap-outbox-changed', {
    detail: { count: rows.filter(x => !['SYNCED', 'ERROR', 'CONFLICT'].includes(x.status)).length }
  }));
}

function queueStocktakeCountLocal(lineId, qty, unitCode, baseUnit, factor, baseQty) {
  const session = window.__session;
  const line = byId('stocktake_lines', lineId);
  const stocktake = line && byId('stocktake_sessions', line.session_id);
  if (!session?.id || !line || !stocktake || stocktake.status !== 'IN_PROGRESS'
      || !['DRAFT', 'REJECTED'].includes(String(stocktake.review_status || 'DRAFT').toUpperCase())) {
    throw new Error(isAr()
      ? 'لا يمكن حفظ العد دون اتصال: جلسة الجرد غير موجودة محلياً أو لم تعد قابلة للعد.'
      : 'Cannot queue this count offline: the session is unavailable locally or is no longer editable.');
  }
  if (!offlineWarehouseAllowed(stocktake.warehouse_id)) {
    throw new Error(isAr()
      ? 'العد دون اتصال مسموح فقط لمستخدم معيّن لمستودع واحد، وضمن ذلك المستودع.'
      : 'Offline counting requires exactly one explicitly assigned warehouse and that session must belong to it.');
  }
  const countGrants = new Set(store.authorizationPermissions || []);
  const roleName = String(session.role || session.profile?.role || '').toUpperCase();
  if (roleName !== 'SUPER_ADMIN'
      && !countGrants.has('action:stocktake:count')
      && !countGrants.has('action:stocktake:manage')) {
    throw new Error(isAr()
      ? 'لا تملك تفويض عدّ الجرد لهذه الجلسة.'
      : 'You do not have an explicit stocktake-count grant for this session.');
  }
  const now = new Date().toISOString();
  const rows = stocktakeCountQueue();
  const existing = rows.find(x => x.user_id === session.id && x.session_id === stocktake.id && x.line_id === lineId);
  const payload = {
    operation_id: existing?.operation_id || (window.crypto?.randomUUID ? window.crypto.randomUUID() : `stkcount-${session.id}-${stocktake.id}-${lineId}`),
    user_id: session.id, session_id: stocktake.id, line_id: lineId, item_id: line.item_id,
    warehouse_id: stocktake.warehouse_id, quantity: Number(qty), entered_quantity: Number(qty),
    entered_unit: unitCode, base_unit: baseUnit, conversion_factor: Number(factor),
    base_quantity: Number(baseQty), status: 'PENDING', attempts: existing?.attempts || 0,
    created_at: existing?.created_at || now, updated_at: now, last_error: null
  };
  if (existing) Object.assign(existing, payload);
  else rows.push(payload);
  stocktakeCountQueueWrite(rows);
  line.counted_qty = Number(baseQty);
  line.entered_quantity = Number(qty);
  line.entered_unit = unitCode;
  line.conversion_factor = Number(factor);
  line.base_unit = baseUnit;
  line.variance = Number(baseQty) - Number(line.system_qty || 0);
  line._count_pending_sync = true;
  persist(true);
  store.emit();
  return { counted_qty: Number(baseQty), entered_quantity: Number(qty), entered_unit: unitCode,
    conversion_factor: Number(factor), base_unit: baseUnit, pending_sync: true };
}

async function flushStocktakeCountQueue() {
  if (!navigator.onLine || !window.__session?.id || !(await ensureOnlineSession())) return 0;
  await pullAll({ silent: true });
  const rows = stocktakeCountQueue();
  // Read current factors directly from Supabase; pullAll can preserve stale data
  // when an optional table request fails, so it is not sufficient for this check.
  const alternateRows = rows.filter(row => row.user_id === window.__session.id
    && !['SYNCED', 'ERROR', 'CONFLICT'].includes(row.status)
    && row.entered_unit
    && normalizeUnitCode(row.entered_unit) !== normalizeUnitCode(row.base_unit));
  let freshConversions = null;
  if (alternateRows.length) {
    const itemIds = [...new Set(alternateRows.map(row => row.item_id).filter(Boolean))];
    const client = await sb();
    const result = await client.from('item_unit_conversions')
      .select('item_id,unit_code,factor_to_base')
      .in('item_id', itemIds);
    if (result.error || !Array.isArray(result.data)) {
      throw new Error('Could not verify current unit conversion factors; counts remain pending.');
    }
    freshConversions = result.data;
  }
  let done = 0, changed = false;
  for (const row of rows) {
    if (row.user_id !== window.__session.id || ['SYNCED', 'ERROR', 'CONFLICT'].includes(row.status)) continue;
    try {
      if (!offlineWarehouseAllowed(row.warehouse_id)) {
        throw new Error('Offline stocktake count belongs to a warehouse outside the current single-warehouse offline scope.');
      }
      if (row.entered_unit && normalizeUnitCode(row.entered_unit) !== normalizeUnitCode(row.base_unit)) {
        const currentUnit = freshConversions?.find(c => c.item_id === row.item_id
          && normalizeUnitCode(c.unit_code) === normalizeUnitCode(row.entered_unit));
        const currentFactor = Number(currentUnit?.factor_to_base);
        const savedFactor = Number(row.conversion_factor);
        if (!currentUnit || !Number.isFinite(currentFactor) || currentFactor <= 0 || !Number.isFinite(savedFactor) || Math.abs(currentFactor - savedFactor) > 1e-9) {
          throw new Error('Unit conversion factor changed; review and re-enter this offline count.');
        }
      } 
      const expectedFactor = Number(row.conversion_factor || 1);
      await rpc('save_offline_stocktake_count_v2', {
        p_line_id: row.line_id,
        p_entered_quantity: row.entered_quantity,
        p_entered_unit: row.entered_unit || row.base_unit,
        p_expected_factor: expectedFactor,
        p_operation_id: row.operation_id
      });
      row.status = 'SYNCED'; row.synced_at = new Date().toISOString(); row.last_error = null;
      changed = true; done++;
    } catch (e) {
      row.attempts = (row.attempts || 0) + 1;
      row.last_error = String(e?.message || e);
      row.status = isNetworkFailure(e) ? 'PENDING'
        : (/unit|factor|quantity|count|session|permission|scope|not found|editable|review|status/i.test(row.last_error) ? 'CONFLICT' : 'ERROR');
      changed = true;
      if (row.status === 'PENDING') break;
    }
  }
  if (changed) stocktakeCountQueueWrite(rows.filter(x => x.status !== 'SYNCED'));
  if (done) await pullAll({ silent: true }).catch(() => {});
  return done;
}

export async function saveStocktakeCount(lineId, qty, enteredUnit = null) {
  const line = byId('stocktake_lines', lineId);
  const baseUnit = normalizeUnitCode(line?.base_unit || store.byId('items', line?.item_id)?.base_unit || 'PCS');
  const unitCode = normalizeUnitCode(enteredUnit || baseUnit);
  let baseQty = Number(qty);
  let factor = 1;
  let res;

  if (!Number.isFinite(Number(qty)) || Number(qty) < 0) throw new Error(isAr() ? 'أدخل كمية صحيحة غير سالبة.' : 'Enter a valid non-negative quantity.');
  if (!line) throw new Error(isAr() ? 'سطر الجرد غير موجود.' : 'Stocktake line not found.');
  if (enteredUnit && unitCode !== baseUnit) {
    const units = unitOptions(line?.item_id);
    const unit = units.find(u => u.value === unitCode);
    if (!unit) {
      throw new Error(isAr()
        ? 'الوحدة المختارة غير مهيأة لهذا الصنف. اعتمد معامل التحويل من الإعدادات أولاً.'
        : 'The selected unit is not configured for this item. Approve its conversion factor in Settings first.');
    }
    factor = Number(unit.factor);
    baseQty = Number(qty) * factor;
  }
  // Offline mode queues only counts for an already-created editable server session.
  // Session creation, submission, review and settlement remain online-only.
  if (!navigator.onLine || window.__session?.offline) {
    return queueStocktakeCountLocal(lineId, Number(qty), unitCode, baseUnit, factor, baseQty);
  }
  try {
    res = await rpc('save_stocktake_count_v3', {
      p_line_id: lineId,
      p_entered_quantity: Number(qty),
      p_entered_unit: unitCode,
      p_expected_factor: factor
    });
    baseQty = Number(res?.counted_qty ?? baseQty);
  } catch (e) {
    if (isNetworkFailure(e)) return queueStocktakeCountLocal(lineId, Number(qty), unitCode, baseUnit, factor, baseQty);
    throw e;
  }

  if (line) {
    line.counted_qty = baseQty;
    line.entered_quantity = Number(qty);
    line.entered_unit = unitCode;
    line.conversion_factor = factor;
    line.base_unit = baseUnit;
    line.variance = baseQty - Number(line.system_qty || 0);
    persist();
    store.emit();
  }
  return { ...(res || {}), counted_qty: baseQty, entered_quantity: Number(qty), entered_unit: unitCode, conversion_factor: factor, base_unit: baseUnit };
}

export async function submitStocktake(sessionId) {
  requireLiveConnection('إرسال الجرد للمراجعة يتطلب اتصالاً مباشراً.', 'Submitting a stocktake for review requires a live connection.');
  const res = await rpc('submit_stocktake_for_review', { p_session_id: sessionId });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function reviewStocktake(sessionId, approve, comment) {
  requireLiveConnection('مراجعة الجرد واعتماده يتطلبان اتصالاً مباشراً.', 'Stocktake review and approval require a live connection.');
  const res = await rpc('review_stocktake_session', {
    p_session_id: sessionId, p_approve: !!approve, p_comment: comment || null
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function settleStocktake(sessionId, lineIds, direction, comments = {}) {
  requireLiveConnection('تسوية فروقات الجرد تتطلب اتصالاً مباشراً.', 'Stocktake variance settlement requires a live connection.');
  const res = await rpc('process_stocktake_settlement_with_direction', {
    p_session_id: sessionId, p_line_ids: lineIds,
    p_direction: direction, p_line_comments: comments || {}
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function closeStocktake(sessionId) {
  requireLiveConnection('إغلاق الجرد يتطلب اتصالاً مباشراً.', 'Closing a stocktake requires a live connection.');
  const res = await rpc('close_stocktake_session_direct', { p_session_id: sessionId });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

/* ── lookups / formatting ───────────────────────────────────────────────── */

export function named(row) {
  if (!row) return '—';
  return isAr()
    ? (row.name_ar || row.name_en || row.name || row.code || '—')
    : (row.name_en || row.name_ar || row.name || row.code || '—');
}

export function itemLabel(itemOrId) {
  const it = typeof itemOrId === 'string' ? byId('items', itemOrId) : itemOrId;
  if (!it) return '—';
  return named(it) + (it.code ? ` (${it.code})` : '');
}

export function itemNameOnly(itemOrId) {
  const it = typeof itemOrId === 'string' ? byId('items', itemOrId) : itemOrId;
  return it ? named(it) : '—';
}

export function warehouseName(id) { return byId('warehouses', id)?.name || '—'; }
export function zoneName(id) { return byId('zones', id)?.name || '—'; }
export function areaName(id) { return byId('storage_areas', id)?.name || '—'; }
export function sectionName(id) { return byId('sections', id)?.name || '—'; }
export function shelfName(id) { const s = byId('shelves', id); return s ? s.code : '—'; }
export function shelfPath(id) {
  const s = byId('shelves', id);
  if (!s) return '—';
  return s.full_path || [warehouseName(s.warehouse_id), zoneName(s.zone_id),
    s.section_id ? sectionName(s.section_id) : '', s.code].filter(Boolean).join(' / ');
}
export function profileName(id) {
  const p = byId('profiles', id);
  return p?.name || p?.email || '—';
}

export function warehouseOptions() {
  return store.get('warehouses').map(w => ({ value: w.id, label: `${w.code} — ${w.name}` }));
}
export function areaOptions(warehouseId) {
  return store.get('storage_areas')
    .filter(a => !warehouseId || a.warehouse_id === warehouseId)
    .map(a => ({ value: a.id, label: `${a.code} — ${a.name}` }));
}
export function zoneOptions(warehouseId) {
  return store.get('zones').filter(z => !warehouseId || z.warehouse_id === warehouseId)
    .map(z => ({ value: z.id, label: `${z.code} — ${z.name}` }));
}
export function sectionOptions(warehouseId, zoneId) {
  return store.get('sections')
    .filter(s => (!warehouseId || s.warehouse_id === warehouseId) && (!zoneId || s.zone_id === zoneId))
    .map(s => ({ value: s.id, label: `${s.code} — ${s.name}` }));
}
/**
 * Shelves that currently hold stock for an item (or in general). Used for
 * "smart" dropdowns: if the item lives in exactly one shelf, it can be auto-selected;
 * otherwise only the item's shelves are offered (scoped by warehouse when provided).
 */
export function shelvesForItem(itemId, { warehouseId, onlyWithStock = true } = {}) {
  if (!itemId) return [];
  const ids = new Set();
  for (const s of store.get('stock')) {
    if (s.item_id !== itemId) continue;
    const qty = Number(s.quantity || 0);
    if (onlyWithStock && qty <= 0) continue;
    const sh = byId('shelves', s.shelf_id);
    if (!sh) continue;
    if (warehouseId && sh.warehouse_id !== warehouseId) continue;
    ids.add(s.shelf_id);
  }
  return store.get('shelves')
    .filter(sh => ids.has(sh.id))
    .filter(sh => (!warehouseId || sh.warehouse_id === warehouseId))
    .sort((a, b) => String(shelfPath(a.id)).localeCompare(String(shelfPath(b.id))))
    .map(sh => ({ value: sh.id, label: shelfPath(sh.id), shelf: sh }));
}

export function shelfOptions({ warehouseId, zoneId, sectionId, storageAreaId, itemId, onlyWithStockForItem = true } = {}) {
  if (itemId) {
    const list = shelvesForItem(itemId, { warehouseId, onlyWithStock: onlyWithStockForItem });
    if (list.length) return list.map(({ value, label }) => ({ value, label }));
  }
  return store.get('shelves')
    .filter(s => (!warehouseId || s.warehouse_id === warehouseId)
      && (!zoneId || s.zone_id === zoneId)
      && (!sectionId || s.section_id === sectionId)
      && (!storageAreaId || s.storage_area_id === storageAreaId))
    .map(s => ({ value: s.id, label: shelfPath(s.id) }));
}
export function itemOptions({ activeOnly = true } = {}) {
  return store.get('items')
    .filter(i => !activeOnly || i.status === 'ACTIVE')
    .map(i => ({ value: i.id, label: itemLabel(i) }));
}
function normalizeUnitCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function itemUnitFactor(itemId, unitCode) {
  const it = byId('items', itemId);
  if (!it) return null;
  const base = normalizeUnitCode(it.base_unit || 'PCS');
  const requested = normalizeUnitCode(unitCode || base);
  if (!requested || requested === base) return 1;
  const conversion = store.get('item_unit_conversions')
    .find(c => c.item_id === itemId && normalizeUnitCode(c.unit_code) === requested);
  if (!conversion) return null;
  const factor = Number(conversion.factor_to_base);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/**
 * Unit options are deliberately strict: the base unit plus rows from
 * item_unit_conversions only. items.purchase_unit and items.conversion_factor
 * are legacy identity/columns and never provide a fallback factor.
 */
export function unitOptions(itemId) {
  const it = byId('items', itemId);
  if (!it) return [];
  const base = normalizeUnitCode(it.base_unit || 'PCS');
  const out = [{ value: base, label: `${base} (1)`, factor: 1, isBase: true }];
  for (const c of store.get('item_unit_conversions')) {
    if (c.item_id !== itemId) continue;
    const code = normalizeUnitCode(c.unit_code);
    if (!code || code === base || out.some(u => u.value === code)) continue;
    const factor = Number(c.factor_to_base);
    if (!Number.isFinite(factor) || factor <= 0) continue;
    out.push({ value: code, label: `${code} (${factor})`, factor, isBase: false });
  }
  return out;
}

/**
 * Returns a reason code when an item's base unit must not be edited.
 * Movement history wins over conversion rows so the UI can explain the lock.
 * The database trigger remains the authoritative guard.
 */
export function itemBaseUnitLockReason(itemId) {
  const it = byId('items', itemId);
  if (!it) return '';
  if (store.get('stock').some(s => s.item_id === itemId)) return 'STOCK';
  if (store.get('inventory_ledger').some(l => l.item_id === itemId)) return 'LEDGER';
  if (store.get('stock_transfers').some(t => t.item_id === itemId)) return 'TRANSFER';
  if (store.get('stocktake_lines').some(l => l.item_id === itemId && l.is_settled === true)) return 'STOCKTAKE';
  if (store.get('item_unit_conversions').some(c => c.item_id === itemId)) return 'CONVERSIONS';
  return '';
}

export function stockQty(itemId, shelfId = null) {
  return store.get('stock')
    .filter(s => s.item_id === itemId && (!shelfId || s.shelf_id === shelfId))
    .reduce((n, s) => n + Number(s.quantity || 0), 0);
}
export function stockByItem() {
  const m = new Map();
  for (const s of store.get('stock')) {
    m.set(s.item_id, (m.get(s.item_id) || 0) + Number(s.quantity || 0));
  }
  return m;
}
export function stockAtShelf() {
  const m = new Map();
  for (const s of store.get('stock')) {
    const k = `${s.item_id}|${s.shelf_id}`;
    m.set(k, (m.get(k) || 0) + Number(s.quantity || 0));
  }
  return m;
}

export function warehousesAllowed() {
  return store.get('warehouses');
}
