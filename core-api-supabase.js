// ============================================================================
// OW — data access layer
// Reads come from the central store (fast, cached, RBAC-filtered).
// Writes go through core-store, which owns offline queues.
// ============================================================================
import { sb, from, rpc } from './core-supabase.js';
import {
  store, pullAll, persist, insertRow, updateRow, deleteRow,
  createTransactionBundle, approveTransaction as storeApprove, rejectTransaction as storeReject,
  createStocktakeSession as storeCreateStocktake, saveStocktakeCount as storeSaveCount,
  submitStocktake as storeSubmitStocktake, reviewStocktake as storeReview,
  settleStocktake as storeSettle, closeStocktake as storeClose,
  dispatchTransfer as storeDispatch, receiveTransfer as storeReceive,
  rejectTransferReceipt as storeRejectReceipt,
  reviewTransferReturn as storeReviewReturn, confirmTransferReturn as storeConfirmReturn,
  createStockReturnRequest as storeCreateReturn,
  upsertSetting, setting, rows, byId, itemLabel, warehouseName, shelfPath
} from './core-store.js';

/* ── inventory ──────────────────────────────────────────────────────────── */

export async function listItems({ search = '', status = 'ACTIVE' } = {}) {
  let list = store.get('items');
  if (status) list = list.filter(i => (i.status || 'ACTIVE') === status);
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(i => [i.code, i.item_number, i.name_ar, i.name_en, i.category]
      .some(v => String(v || '').toLowerCase().includes(s)));
  }
  return list;
}

export async function listStockWithItems() {
  const stockByItem = new Map();
  for (const s of store.get('stock')) {
    if (!stockByItem.has(s.item_id)) stockByItem.set(s.item_id, []);
    stockByItem.get(s.item_id).push(s);
  }
  return store.get('items').map(it => {
    const sr = stockByItem.get(it.id) || [];
    return { ...it, stock_rows: sr, total_qty: sr.reduce((n, r) => n + Number(r.quantity || 0), 0) };
  });
}

export const createItem = (payload) => insertRow('items', payload);
export const updateItem = (id, payload) => updateRow('items', id, payload);
export const deleteItem = (id) => deleteRow('items', id);

export async function listCategories() {
  return [...store.get('item_categories')].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
export const createCategory = (payload) => insertRow('item_categories', payload);
export const updateCategory = (id, payload) => updateRow('item_categories', id, payload);
export const deleteCategory = (id) => deleteRow('item_categories', id);

/* ── transactions ───────────────────────────────────────────────────────── */

export async function listTransactions({ status, type, search = '', from: fromDate, to: toDate, warehouseId, limit = 500 } = {}) {
  let list = store.get('transactions');
  if (status) list = list.filter(t => t.status === status);
  if (type) list = list.filter(t => t.transaction_type === type);
  if (warehouseId) list = list.filter(t => t.warehouse_id === warehouseId);
  if (fromDate) list = list.filter(t => (t.created_at || '').slice(0, 10) >= fromDate);
  if (toDate) list = list.filter(t => (t.created_at || '').slice(0, 10) <= toDate);
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(t => [t.reference_no, t.supplier, t.receiver_name, t.external_reference, t.notes]
      .some(v => String(v || '').toLowerCase().includes(s)));
  }
  return [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

export async function getTransaction(id) {
  return byId('transactions', id);
}

export async function createTransaction({ transaction, lines }) {
  return storeCreateTransactionPayload({ transaction, lines });
}

async function storeCreateTransactionPayload({ transaction, lines }) {
  return createTransactionBundle({
    type: transaction.transaction_type,
    warehouse_id: transaction.warehouse_id,
    zone_id: transaction.zone_id,
    section_id: transaction.section_id,
    storage_area_id: transaction.storage_area_id,
    supplier: transaction.supplier,
    receiver_name: transaction.receiver_name,
    usage_party: transaction.usage_party,
    adjustment_reason: transaction.adjustment_reason,
    external_reference: transaction.external_reference,
    notes: transaction.notes,
    reference_no: transaction.reference_no,
    lines
  });
}

export const approveTransaction = (id) => storeApprove(id);
export const rejectTransaction = (id, reason) => storeReject(id, reason);

export const createStockReturnRequest = (payload) => storeCreateReturn(payload);

/* ── stocktake ──────────────────────────────────────────────────────────── */

export async function listStocktakeSessions() {
  return [...store.get('stocktake_sessions')].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getStocktakeSession(id) {
  return byId('stocktake_sessions', id);
}

export const createStocktakeSession = (p) => storeCreateStocktake(p);
export const saveStocktakeCount = (lineId, qty) => storeSaveCount(lineId, qty);
export const submitStocktakeForReview = (id) => storeSubmitStocktake(id);
export const reviewStocktakeSession = (id, approve, comment) => storeReview(id, approve, comment);
export const settleStocktakeLines = (id, lineIds, direction, comments) => storeSettle(id, lineIds, direction, comments);
export const closeStocktakeSession = (id) => storeClose(id);

/* ── facilities ─────────────────────────────────────────────────────────── */

export async function listWarehouses() {
  return [...store.get('warehouses')].sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

export async function listHierarchy() {
  return {
    warehouses: rows('warehouses'),
    storage_areas: rows('storage_areas'),
    zones: rows('zones'),
    sections: rows('sections'),
    shelves: rows('shelves')
  };
}

export const createWarehouse = ({ code, name }) =>
  insertRow('warehouses', { code: String(code).trim(), name: String(name).trim(), created_at: new Date().toISOString() });
export const updateWarehouse = (id, { code, name }) =>
  updateRow('warehouses', id, { code: String(code).trim(), name: String(name).trim(), updated_at: new Date().toISOString() });
export const deleteWarehouse = (id) => deleteRow('warehouses', id);

// Storage areas are first-class master data; never mirror them into legacy zones.
export async function createStorageArea({ warehouse_id, code, name }) {
  const payload = { warehouse_id, code: String(code || '').trim(), name: String(name || '').trim(), is_active: true };
  if (!payload.warehouse_id || !payload.code || !payload.name) throw new Error('Warehouse, storage-area code and name are required.');
  const c = await sb();
  const { data, error } = await c.from('storage_areas').insert(payload).select().single();
  if (error) throw error;
  await pullAll({ silent: true }).catch(() => {});
  const cached = store.get('storage_areas');
  const existingIndex = cached.findIndex(row => row.id === data.id);
  if (existingIndex >= 0) cached[existingIndex] = data;
  else cached.push(data);
  persist(true);
  store.emit();
  return data;
}

export async function updateStorageArea(id, { code, name }) {
  const payload = { code: String(code || '').trim(), name: String(name || '').trim(), updated_at: new Date().toISOString() };
  if (!id || !payload.code || !payload.name) throw new Error('Storage-area id, code and name are required.');
  const c = await sb();
  const { data, error } = await c.from('storage_areas').update(payload).eq('id', id).select().single();
  if (error) throw error;
  await pullAll({ silent: true }).catch(() => {});
  const cached = store.get('storage_areas');
  const existingIndex = cached.findIndex(row => row.id === data.id);
  if (existingIndex >= 0) cached[existingIndex] = data;
  else cached.push(data);
  persist(true);
  store.emit();
  return data;
}

export async function deleteStorageArea(id) {
  if (!id) throw new Error('Storage-area id is required.');
  const c = await sb();
  const { error } = await c.from('storage_areas').delete().eq('id', id);
  if (error) throw error;
  await pullAll({ silent: true }).catch(() => {});
  store.data.storage_areas = store.get('storage_areas').filter(row => row.id !== id);
  persist(true);
  store.emit();
}

export const createSection = export const createSection = (p) => insertRow('sections', {
  warehouse_id: p.warehouse_id, zone_id: p.zone_id,
  code: String(p.code).trim(), name: String(p.name).trim(), created_at: new Date().toISOString()
});
export const updateSection = (id, p) => updateRow('sections', id, {
  zone_id: p.zone_id, code: String(p.code).trim(), name: String(p.name).trim(), updated_at: new Date().toISOString()
});
export const deleteSection = (id) => deleteRow('sections', id);

export const createShelf = (p) => insertRow('shelves', {
  warehouse_id: p.warehouse_id,
  storage_area_id: p.storage_area_id,
  code: String(p.code).trim(),
  full_path: p.full_path || null,
  created_at: new Date().toISOString()
});
export const updateShelf = (id, p) => updateRow('shelves', id, {
  storage_area_id: p.storage_area_id,
  code: String(p.code).trim(),
  full_path: p.full_path || null,
});
export const deleteShelf = (id) => deleteRow('shelves', id);

/* ── transfers ──────────────────────────────────────────────────────────── */

export async function listTransfers() {
  return [...store.get('stock_transfers')].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
export async function listTransferOrders() {
  return [...store.get('stock_transfer_orders')].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export const dispatchTransferOrder = ({ orderId, referenceNo, sourceWarehouseId, destinationWarehouseId, lines, notes }) =>
  storeDispatch({ orderId, referenceNo, sourceWarehouseId, destinationWarehouseId, lines, notes });

export const receiveTransferQuantity = (id, qty, shelfId, returnRemaining, reason) =>
  storeReceive({ transferId: id, qty, shelfId, returnRemaining, reason });

export const rejectTransferReceipt = (id, reason) => storeRejectReceipt(id, reason);
export const reviewStockTransferReturn = (id, decision, note) => storeReviewReturn(id, decision, note);
export const confirmStockTransferReturn = (id) => storeConfirmReturn(id);

/* ── reports ────────────────────────────────────────────────────────────── */

export async function listInventoryLedger({ from: fromDate, to: toDate, warehouseId, limit = 2000 } = {}) {
  let list = store.get('inventory_ledger');
  if (fromDate) list = list.filter(r => (r.occurred_at || '').slice(0, 10) >= fromDate);
  if (toDate) list = list.filter(r => (r.occurred_at || '').slice(0, 10) <= toDate);
  if (warehouseId) list = list.filter(r => r.warehouse_id === warehouseId);
  return [...list].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, limit);
}

export async function listTransactionLedger({ from: fromDate, to: toDate, warehouseId, limit = 2000 } = {}) {
  let list = store.get('transaction_ledger');
  if (fromDate) list = list.filter(r => (r.created_at || '').slice(0, 10) >= fromDate);
  if (toDate) list = list.filter(r => (r.created_at || '').slice(0, 10) <= toDate);
  if (warehouseId) list = list.filter(r => r.warehouse_id === warehouseId);
  return [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

export async function listAuditLogs({ limit = 500 } = {}) {
  return [...store.get('audit_logs')]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

/* ── settings / users / units / permissions ─────────────────────────────── */

export async function listUsers() {
  return [...store.get('profiles')].sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
}

export async function updateUser(userId, payload) {
  const res = await rpc('admin_update_profile', {
    p_target_user_id: userId,
    p_role: payload.role ?? null,
    p_status: payload.status ?? null,
    p_custom_permissions: payload.custom_permissions ?? null,
    p_can_approve_without_workflow: payload.can_approve_without_workflow ?? null,
    p_assigned_warehouse_ids: payload.assigned_warehouse_ids ?? null
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function listUnits() {
  return [...store.get('units')].sort((a, b) => String(a.code).localeCompare(String(b.code)));
}
export const createUnit = (p) => insertRow('units', { code: p.code, name: p.name, created_at: new Date().toISOString() });
export const updateUnit = (id, p) => updateRow('units', id, { code: p.code, name: p.name });
export const deleteUnit = (id) => deleteRow('units', id);

export async function listUnitConversions() { return rows('item_unit_conversions'); }
export const createUnitConversion = (p) => insertRow('item_unit_conversions', {
  item_id: p.item_id, unit_code: p.unit_code, factor_to_base: Number(p.factor_to_base)
});
export const updateUnitConversion = (id, p) => updateRow('item_unit_conversions', id, {
  unit_code: p.unit_code, factor_to_base: Number(p.factor_to_base)
});
export const deleteUnitConversion = (id) => deleteRow('item_unit_conversions', id);

export async function listSystemSettings() { return rows('system_settings'); }
export const upsertSystemSettings = (rowsList) => {
  const list = Array.isArray(rowsList) ? rowsList : [rowsList];
  return Promise.all(list.map(r => upsertSetting(r.key, r.value, r.description)));
};
export const getSetting = setting;

export async function listPermissions() {
  return [...store.get('permissions')].sort((a, b) => String(a.key).localeCompare(String(b.key)));
}
export async function listRolePermissions() { return rows('role_permissions'); }

export async function replaceRolePermissions(roleName, keys, scopeMode = 'INHERIT', warehouseIds = []) {
  // Save permissions and warehouse scope atomically through the institutional
  // access-config RPC. Avoid the legacy permission-only mutation path.
  const res = await rpc('admin_save_role_access_config', {
    p_role_name: roleName,
    p_permission_keys: keys,
    p_scope_mode: scopeMode,
    p_warehouse_ids: Array.isArray(warehouseIds) ? warehouseIds : []
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

export async function adminLinkProfile({ email, name, role, status, warehouseIds }) {
  const res = await rpc('admin_link_profile', {
    p_email: email, p_name: name, p_role: role, p_status: status,
    p_warehouse_ids: warehouseIds || []
  });
  await pullAll({ silent: true }).catch(() => {});
  return res;
}

/* ── dashboard aggregate ────────────────────────────────────────────────── */

export async function dashboardStats() {
  const stockByItem = new Map();
  for (const s of store.get('stock')) {
    stockByItem.set(s.item_id, (stockByItem.get(s.item_id) || 0) + Number(s.quantity || 0));
  }
  let totalQty = 0, lowStock = 0, outOfStock = 0;
  for (const it of store.get('items')) {
    const q = stockByItem.get(it.id) || 0;
    totalQty += q;
    if (q <= 0) outOfStock++;
    if (q <= Number(it.safety_stock || 0)) lowStock++;
  }
  const pending = store.get('transactions').filter(t => ['PENDING_APPROVAL', 'PENDING', 'PENDING_SYNC', 'PENDING_REVIEW'].includes(t.status));
  const transfersTransit = store.get('stock_transfers').filter(t => ['IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RETURN_IN_TRANSIT'].includes(t.status));
  return {
    items: store.get('items').length,
    warehouses: store.get('warehouses').length,
    shelves: store.get('shelves').length,
    totalQty,
    lowStock,
    outOfStock,
    pending: pending.length,
    pendingTransactions: pending,
    transfersInTransit: transfersTransit.length,
    sessionsOpen: store.get('stocktake_sessions').filter(s => ['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW', 'SUBMITTED'].includes(s.status)).length,
    transactionsToday: store.get('transactions').filter(t => (t.created_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length
  };
}

export async function latestInventoryLedger(limit = 10) {
  return [...store.get('inventory_ledger')]
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    .slice(0, limit);
}

export { store, pullAll, rows, byId, itemLabel, warehouseName, shelfPath };
