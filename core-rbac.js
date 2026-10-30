// ============================================================================
// OW — role based access control (UI gate only; RLS is authoritative)
// ============================================================================
import { currentUser } from './core-auth.js';
import { store, ELEVATED_ROLES } from './core-store.js';

export function role() { return String(currentUser()?.role || '').toUpperCase(); }
export const isAdmin = () => ['SUPER_ADMIN', 'ADMIN'].includes(role());
export const isElevated = () => ELEVATED_ROLES.includes(role());

export function customPermissions() {
  const list = currentUser()?.profile?.custom_permissions;
  return Array.isArray(list) ? list : [];
}

export function rolePermissions() {
  const r = role();
  return store.get('role_permissions')
    .filter(p => String(p.role_name || '').toUpperCase() === r)
    .map(p => p.permission_key);
}

let permCache = { key: '', keys: new Set() };
function permissionSet() {
  // Cache by the actual permission keys, not row count: replacing a role's
  // permissions with a different set of the same size must invalidate cache.
  const roleKeys = rolePermissions().map(String).sort();
  const customKeys = customPermissions().map(String).sort();
  const key = `${role()}|r:${roleKeys.join(',')}|c:${customKeys.join(',')}`;
  if (permCache.key === key) return permCache.keys;
  const set = new Set([...roleKeys, ...customKeys]);
  permCache = { key, keys: set };
  return set;
}

export function can(permissionKey) {
  return canDatabasePermission(permissionKey);
}

// Mirrors public.current_user_has_permission(): SUPER_ADMIN, MANAGER and ADMIN
// are database-level permission bypass roles; WAREHOUSE_MANAGER is not.
export function canDatabasePermission(permissionKey) {
  if (!currentUser()) return false;
  if (['SUPER_ADMIN', 'MANAGER', 'ADMIN'].includes(role())) return true;
  return permissionSet().has(permissionKey);
}

export function canAny(keys = []) {
  return keys.some(can);
}

/* Legacy OW permission aliases used by existing pages. */
export function orshapCanPermission(key) { return can(key); }

export function accessibleWarehouseIds() {
  const u = currentUser();
  if (!u || store.scopeConfigLoaded !== true) return [];
  const assigned = Array.isArray(u.profile?.assigned_warehouse_ids)
    ? [...new Set(u.profile.assigned_warehouse_ids.filter(Boolean))] : [];
  const roleScope = store.get('role_warehouse_scopes').find(row =>
    String(row.role_name || '').toUpperCase() === role()
  ) || u.profile?.role_warehouse_scope || null;
  const mode = String(roleScope?.scope_mode || 'INHERIT').toUpperCase();
  const roleIds = Array.isArray(roleScope?.warehouse_ids) ? roleScope.warehouse_ids : [];
  if (assigned.length) {
    return mode === 'SELECTED' ? assigned.filter(id => roleIds.includes(id)) : assigned;
  }
  if (mode === 'SELECTED') return roleIds;
  if (mode === 'ALL') return null;
  return ['SUPER_ADMIN', 'ADMIN'].includes(role()) ? null : [];
}

export function canAccessWarehouse(warehouseId) {
  if (!warehouseId) return false;
  const allowed = accessibleWarehouseIds();
  if (allowed === null) return true;
  return allowed.includes(warehouseId);
}

export function canManageSettings() {
  // Page access is separate from the narrower database-backed admin actions.
  return isAdmin() || can('action:settings:manage');
}

// Match the current database contract: system_settings and units mutations
// are guarded by current_user_is_manager() (SUPER_ADMIN / MANAGER only).
export function canManageSystemSettings() {
  return ['SUPER_ADMIN', 'MANAGER'].includes(role());
}

// Profile and role-permission RPCs currently require SUPER_ADMIN explicitly.
export function canAdministerProfiles() {
  return role() === 'SUPER_ADMIN';
}

export function canViewSystemQty() {
  return canDatabasePermission('action:stocktake:view_system_qty');
}

export function canApproveTransactions() {
  return canDatabasePermission('action:transaction:approve');
}

export function canCreateTransactionType(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'OPENING_BALANCE') {
    return ['SUPER_ADMIN', 'MANAGER'].includes(role())
      && canDatabasePermission('action:transaction:adjustment:create');
  }
  if (t === 'GRN' || t === 'RETURN_FROM_USAGE' || t === 'RETURN_FROM_CUSTOMER') {
    return canDatabasePermission('action:transaction:grn:create');
  }
  if (t === 'ISSUE' || t === 'RETURN_TO_SUPPLIER') {
    return canDatabasePermission('action:transaction:issue:create');
  }
  if (t === 'ADJUSTMENT_IN' || t === 'ADJUSTMENT_OUT') {
    return canDatabasePermission('action:transaction:adjustment:create');
  }
  return false;
}

export function canManageStocktake() {
  return [
    'action:stocktake:start', 'action:stocktake:count',
    'action:stocktake:submit', 'action:stocktake:approve'
  ].some(canDatabasePermission);
}

export function canTransfer() {
  return ['action:stock_transfer:create', 'action:stock_transfer:view']
    .some(canDatabasePermission);
}

export function canAccessPage(page) {
  if (!currentUser() || !page) return false;
  // Match the exact permission evaluated by RLS; no UI-only wildcard or
  // WAREHOUSE_MANAGER bypass may grant a page the database will deny.
  return canDatabasePermission(`page:${page}:access`);
}
