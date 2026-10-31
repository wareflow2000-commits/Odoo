// ============================================================================
// OW — role based access control (UI gate only; RLS is authoritative)
// ============================================================================
import { currentUser } from './core-auth.js';
import { store, hasEffectiveCachedGrant, hasAnyEffectiveCachedGrant } from './core-store.js';

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

export function can(permissionKey, context = {}) {
  return canDatabasePermission(permissionKey, context);
}

// Mirrors the database's contextual policy evaluation for UI hints. Explicit
// DENY grants override ALLOW; the database remains authoritative for every RPC.
export function canDatabasePermission(permissionKey, context = {}) {
  if (!currentUser()) return false;
  if (role() === 'SUPER_ADMIN') return true;
  return hasEffectiveCachedGrant(permissionKey, context);
}

export function canAny(keys = []) {
  return keys.some(can);
}

/* Legacy OW permission aliases used by existing pages. */
export function orshapCanPermission(key) { return can(key); }

export function accessibleWarehouseIds() {
  const u = currentUser();
  if (!u) return [];
  if (role() === 'SUPER_ADMIN') return null;
  if (store.scopeConfigLoaded !== true) return [];
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
  return [];
}

export function canAccessWarehouse(warehouseId) {
  if (!warehouseId) return false;
  const allowed = accessibleWarehouseIds();
  if (allowed === null) return true;
  return allowed.includes(warehouseId);
}

export function canManageSettings() {
  return can('action:settings:manage');
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

const SELF_APPROVAL_CREATE_PERMISSION = Object.freeze({
  GRN: 'action:transaction:grn:create',
  RETURN_FROM_USAGE: 'action:transaction:grn:create',
  RETURN_FROM_CUSTOMER: 'action:transaction:grn:create',
  ISSUE: 'action:transaction:issue:create',
  RETURN_TO_SUPPLIER: 'action:transaction:issue:create',
  ADJUSTMENT_IN: 'action:transaction:adjustment:create',
  ADJUSTMENT_OUT: 'action:transaction:adjustment:create',
  OPENING_BALANCE: 'action:transaction:opening_balance:create'
});

export function canApproveTransactions(transaction = null) {
  if (!transaction) return hasAnyEffectiveCachedGrant('action:transaction:approve');

  const user = currentUser();
  const context = {
    resource_type: 'transaction', resource_id: transaction.id,
    warehouse_id: transaction.warehouse_id, owner_id: transaction.created_by,
    status: transaction.status, transaction_type: transaction.transaction_type,
    offline: false
  };

  // The database allows self-approval only through its explicit exception:
  // user flag + auto-approval grant + matching create grant. Mirror that rule
  // for button visibility; approve_transaction remains the authoritative gate.
  if (transaction.created_by && transaction.created_by === user?.id) {
    const profile = user.profile?.id === user.id
      ? user.profile
      : store.get('profiles').find(row => row.id === user.id) || null;
    if (profile?.can_approve_without_workflow !== true) return false;

    const createPermission = SELF_APPROVAL_CREATE_PERMISSION[
      String(transaction.transaction_type || '').toUpperCase()
    ];
    if (!createPermission) return false;

    return hasEffectiveCachedGrant('action:transaction:auto_approve', context)
      && hasEffectiveCachedGrant(createPermission, context);
  }

  return canDatabasePermission('action:transaction:approve', context);
}

export function canCreateTransactionType(type, warehouseId = null) {
  const t = String(type || '').toUpperCase();
  let key = null;
  if (t === 'OPENING_BALANCE') key = 'action:transaction:opening_balance:create';
  else if (t === 'GRN' || t === 'RETURN_FROM_USAGE' || t === 'RETURN_FROM_CUSTOMER') key = 'action:transaction:grn:create';
  else if (t === 'ISSUE' || t === 'RETURN_TO_SUPPLIER') key = 'action:transaction:issue:create';
  else if (t === 'ADJUSTMENT_IN' || t === 'ADJUSTMENT_OUT') key = 'action:transaction:adjustment:create';
  if (!key) return false;
  if (!warehouseId) return hasAnyEffectiveCachedGrant(key);
  return canDatabasePermission(key, {
    resource_type: 'transaction', warehouse_id: warehouseId,
    owner_id: currentUser()?.id, transaction_type: t, offline: false
  });
}

const stocktakeContext = session => session ? ({
  resource_type: 'stocktake_session', resource_id: session.id,
  warehouse_id: session.warehouse_id, owner_id: session.created_by,
  status: session.status, review_status: session.review_status
}) : null;

export function canManageStocktake(session = null) {
  const keys = [
    'action:stocktake:start', 'action:stocktake:count',
    'action:stocktake:submit', 'action:stocktake:approve',
    'action:stocktake:manage', 'action:stocktake:settle', 'action:stocktake:close'
  ];
  const context = stocktakeContext(session);
  return keys.some(key => context
    ? canDatabasePermission(key, context)
    : hasAnyEffectiveCachedGrant(key));
}

export function canTransfer() {
  return [
    'action:stock_transfer:create', 'action:stock_transfer:view',
    'action:stock_transfer:receive', 'action:stock_transfer:reject_receipt',
    'action:stock_transfer:return:create', 'action:stock_transfer:return:review',
    'action:stock_transfer:return:receive'
  ].some(hasAnyEffectiveCachedGrant);
}

const transferContext = (transfer, warehouseId, operation = null) => transfer ? ({
  resource_type: 'stock_transfer',
  resource_id: transfer.id,
  warehouse_id: warehouseId,
  status: transfer.status,
  source_warehouse_id: transfer.source_warehouse_id,
  destination_warehouse_id: transfer.destination_warehouse_id,
  ...(operation ? { operation } : {}),
  ...(transfer.return_review_status ? { return_review_status: transfer.return_review_status } : {})
}) : null;

export const canCreateTransfer = (sourceWarehouseId = null, destinationWarehouseId = null, orderId = null) =>
  sourceWarehouseId && destinationWarehouseId
    ? canDatabasePermission('action:stock_transfer:create', {
        resource_type: 'stock_transfer_order', resource_id: orderId,
        warehouse_id: sourceWarehouseId, owner_id: currentUser()?.id,
        source_warehouse_id: sourceWarehouseId, destination_warehouse_id: destinationWarehouseId
      }) && canDatabasePermission('action:stock_transfer:create', {
        resource_type: 'stock_transfer_order', resource_id: orderId,
        warehouse_id: destinationWarehouseId, owner_id: currentUser()?.id,
        source_warehouse_id: sourceWarehouseId, destination_warehouse_id: destinationWarehouseId
      })
    : hasAnyEffectiveCachedGrant('action:stock_transfer:create');

export const canReceiveTransfer = transfer => transfer
  ? canDatabasePermission('action:stock_transfer:receive', transferContext(transfer, transfer.destination_warehouse_id))
  : hasAnyEffectiveCachedGrant('action:stock_transfer:receive');
export const canRejectTransferReceipt = transfer => transfer
  ? canDatabasePermission('action:stock_transfer:reject_receipt', transferContext(transfer, transfer.destination_warehouse_id))
  : hasAnyEffectiveCachedGrant('action:stock_transfer:reject_receipt');
export const canCreateTransferReturn = transfer => transfer
  ? canDatabasePermission('action:stock_transfer:return:create', transferContext(transfer, transfer.destination_warehouse_id))
  : hasAnyEffectiveCachedGrant('action:stock_transfer:return:create');
export const canReviewTransferReturn = transfer => transfer
  ? canDatabasePermission('action:stock_transfer:return:review', transferContext(transfer, transfer.source_warehouse_id))
  : hasAnyEffectiveCachedGrant('action:stock_transfer:return:review');
export const canConfirmTransferReturn = transfer => transfer
  ? canDatabasePermission('action:stock_transfer:return:receive', transferContext(transfer, transfer.source_warehouse_id))
  : hasAnyEffectiveCachedGrant('action:stock_transfer:return:receive');

export function canAccessPage(page) {
  if (!currentUser() || !page) return false;
  // Match the exact permission evaluated by RLS; no UI-only wildcard or
  // WAREHOUSE_MANAGER bypass may grant a page the database will deny.
  return canDatabasePermission(`page:${page}:access`);
}
