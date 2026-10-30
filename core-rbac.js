// ============================================================================
// OW — role based access control (UI gate only; RLS is authoritative)
// ============================================================================
import { currentUser } from './core-auth.js';
import { store } from './core-store.js';

export function role() { return String(currentUser()?.role || '').toUpperCase(); }
export const isAdmin = () => role() === 'SUPER_ADMIN';
export const isElevated = () => role() === 'SUPER_ADMIN';

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
  // Authorization grants are the single effective source for UI permission
  // hints. Legacy role_permissions/custom_permissions remain management inputs
  // and are synchronized server-side into authorization_grants.
  const grantKeys = (store.authorizationPermissions || []).map(String).sort();
  const key = `g:${grantKeys.join(',')}`;
  if (permCache.key === key) return permCache.keys;
  const set = new Set(grantKeys);
  permCache = { key, keys: set };
  return set;
}

export function can(permissionKey) {
  return canDatabasePermission(permissionKey);
}

// Only SUPER_ADMIN has the audited break-glass bypass. Every other role,
 // including MANAGER and ADMIN, must hold an explicit role/user grant.
export function canDatabasePermission(permissionKey) {
  if (!currentUser()) return false;
  if (role() === 'SUPER_ADMIN') return true;
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
  return role() === 'SUPER_ADMIN' ? null : [];
}

export function canAccessWarehouse(warehouseId) {
  if (!warehouseId) return false;
  const allowed = accessibleWarehouseIds();
  if (allowed === null) return true;
  return allowed.includes(warehouseId);
}

export function canManageSettings() {
  return role() === 'SUPER_ADMIN' || can('action:settings:manage');
}

// System settings and unit administration require an explicit grant for
// every non-SUPER_ADMIN role; SUPER_ADMIN remains the audited break-glass path.
export function canManageSystemSettings() {
  return canDatabasePermission('action:settings:manage');
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
    return canDatabasePermission('action:transaction:adjustment:create');
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
    'action:stocktake:submit', 'action:stocktake:approve', 'action:stocktake:manage'
  ].some(canDatabasePermission);
}

export function canTransfer() {
  return [
    'action:stock_transfer:create', 'action:stock_transfer:view',
    'action:stock_transfer:receive', 'action:stock_transfer:reject_receipt',
    'action:stock_transfer:return:create', 'action:stock_transfer:return:review',
    'action:stock_transfer:return:receive'
  ].some(canDatabasePermission);
}

export const canCreateTransfer = () => canDatabasePermission('action:stock_transfer:create');
export const canReceiveTransfer = () => canDatabasePermission('action:stock_transfer:receive');
export const canRejectTransferReceipt = () => canDatabasePermission('action:stock_transfer:reject_receipt');
export const canCreateTransferReturn = () => canDatabasePermission('action:stock_transfer:return:create');
export const canReviewTransferReturn = () => canDatabasePermission('action:stock_transfer:return:review');
export const canConfirmTransferReturn = () => canDatabasePermission('action:stock_transfer:return:receive');

export function canAccessPage(page) {
  if (!currentUser() || !page) return false;
  // Match the exact permission evaluated by RLS; no UI-only wildcard or
  // WAREHOUSE_MANAGER bypass may grant a page the database will deny.
  return canDatabasePermission(`page:${page}:access`);
}
