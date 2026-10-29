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
  const key = `${role()}|${(currentUser()?.profile?.custom_permissions || []).join(',')}|${store.get('role_permissions').length}`;
  if (permCache.key === key) return permCache.keys;
  const set = new Set([...rolePermissions(), ...customPermissions()]);
  permCache = { key, keys: set };
  return set;
}

export function can(permissionKey) {
  if (!currentUser()) return false;
  if (isAdmin()) return true;
  const set = permissionSet();
  return set.has(permissionKey) || set.has('*');
}

export function canAny(keys = []) {
  return keys.some(can);
}

/* Legacy OW permission aliases used by existing pages. */
export function orshapCanPermission(key) { return can(key); }

export function accessibleWarehouseIds() {
  const u = currentUser();
  if (!u) return [];
  if (isElevated()) return null; // null = all warehouses
  const assigned = u.profile?.assigned_warehouse_ids;
  return Array.isArray(assigned) ? assigned : [];
}

export function canAccessWarehouse(warehouseId) {
  const allowed = accessibleWarehouseIds();
  if (allowed === null) return true;
  return allowed.includes(warehouseId);
}

export function canManageSettings() {
  // Viewing the settings page is not equivalent to permission to mutate
  // users, roles, or system configuration.
  return isAdmin() || can('action:settings:manage');
}

export function canViewSystemQty() {
  return isElevated() || can('action:stocktake:view_system_qty');
}

export function canApproveTransactions() {
  return isElevated() || can('action:transaction:approve');
}

export function canCreateTransactionType(type) {
  const t = String(type || '').toUpperCase();
  if (isElevated()) return true;
  if (['GRN', 'RECEIPT'].includes(t)) return can('action:transaction:grn:create');
  if (t === 'ISSUE') return can('action:transaction:issue:create');
  if (t.startsWith('ADJUSTMENT')) return can('action:transaction:adjustment:create');
  if (t.startsWith('RETURN')) return can('action:transaction:return:create');
  return can('action:transaction:create');
}

export function canManageStocktake() {
  return isElevated() || canAny([
    'action:stocktake:start', 'action:stocktake:count',
    'action:stocktake:submit', 'action:stocktake:approve'
  ]);
}

export function canTransfer() {
  return isElevated() || canAny(['action:stock_transfer:create', 'action:stock_transfer:view']);
}

export function canAccessPage(page) {
  if (!currentUser()) return false;
  if (isElevated()) return true;
  const set = permissionSet();
  // Fail closed when no page permissions are configured. An empty set can
  // mean permissions have not loaded or were denied; it must not grant access.
  return set.has(`page:${page}:access`) || set.has('page:*:access') || set.has('*');
}
