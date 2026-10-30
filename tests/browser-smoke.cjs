const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  try {
    const response = await page.goto('http://127.0.0.1:4173/index.html', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    if (!response || !response.ok()) throw new Error('index.html did not load successfully');
    await page.locator('#loginPage').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#loginEmail').waitFor({ state: 'visible' });
    await page.locator('#loginPassword').waitFor({ state: 'visible' });
    await page.screenshot({ path: 'test-results/login-desktop.png', fullPage: true });

    // Ensure the app shell is present and the unauthenticated page remains usable.
    if (!(await page.locator('#appShell').count())) throw new Error('Application shell missing');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/login-mobile.png', fullPage: true });
    const horizontalOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    if (horizontalOverflow) throw new Error('Login page has horizontal overflow at 390px width');

    // Exercise the real store module in Chromium with isolated in-memory fixtures.
    // No Supabase writes are performed: the browser is deliberately put offline.
    const offlineChecks = await page.evaluate(async () => {
      const { store, offlineTransactionTypeAllowed, offlineWarehouseAllowed, saveStocktakeCount, queueSnapshot, loadLocal, insertRow, updateRow, deleteRow, upsertSetting } =
        await import('/core-store.js');
      const userId = '11111111-1111-4111-8111-111111111111';
      const warehouseId = '22222222-2222-4222-8222-222222222222';
      const sessionId = '33333333-3333-4333-8333-333333333333';
      const lineId = '44444444-4444-4444-8444-444444444444';
      const itemId = '55555555-5555-4555-8555-555555555555';
      window.__session = {
        id: userId, role: 'CLERK', offline: true,
        profile: { id: userId, assigned_warehouse_ids: [warehouseId], accessible_warehouse_ids: [warehouseId] }
      };
      store.scopeConfigLoaded = true;
      store.data.role_warehouse_scopes = [];
      store.data.profiles = [];
      store.data.items = [{ id: itemId, base_unit: 'PCS' }];
      store.data.item_unit_conversions = [{ item_id: itemId, unit_code: 'BOX', factor_to_base: 12 }];
      store.data.stocktake_sessions = [{
        id: sessionId, warehouse_id: warehouseId, created_by: userId,
        status: 'IN_PROGRESS', review_status: 'DRAFT'
      }];
      store.data.stocktake_lines = [{
        id: lineId, session_id: sessionId, item_id: itemId,
        system_qty: 20, base_unit: 'PCS', counted_qty: null
      }];
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      const expectBlocked = async action => {
        try { await action(); return false; } catch (_) { return true; }
      };
      const blockedMasterWrites = await Promise.all([
        expectBlocked(() => insertRow('items', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'OFFLINE-INSERT' })),
        expectBlocked(() => updateRow('items', itemId, { name_en: 'OFFLINE-UPDATE' })),
        expectBlocked(() => deleteRow('items', itemId)),
        expectBlocked(() => upsertSetting('REQUIRE_APPROVAL', false))
      ]);
      const noOptimisticMasterWrite = store.data.items.length === 1
        && store.data.items[0].id === itemId;
      const issueAllowed = offlineTransactionTypeAllowed('ISSUE');
      const receiptDenied = !offlineTransactionTypeAllowed('RECEIPT');
      const assignedWarehouseAllowed = offlineWarehouseAllowed(warehouseId);
      const otherWarehouseDenied = !offlineWarehouseAllowed('66666666-6666-4666-8666-666666666666');
      window.__session.profile.assigned_warehouse_ids = [warehouseId, '66666666-6666-4666-8666-666666666666'];
      const multiWarehouseDenied = !offlineWarehouseAllowed(warehouseId);
      window.__session.profile.assigned_warehouse_ids = [warehouseId];
      const saved = await saveStocktakeCount(lineId, 2, 'BOX');
      const queued = queueSnapshot().some(row =>
        row.source === 'stocktake' && row.status === 'PENDING'
      );
      const queueKey = Object.keys(localStorage).find(key =>
        key.startsWith('orshap_stocktake_count_queue_v1:')
      );
      const queueRows = queueKey ? JSON.parse(localStorage.getItem(queueKey)) : [];
      const originalSession = window.__session;
      const legacyUserId = '77777777-7777-4777-8777-777777777777';
      window.__session = {
        id: legacyUserId, role: 'CLERK', offline: true,
        profile: { id: legacyUserId, assigned_warehouse_ids: [warehouseId] }
      };
      localStorage.setItem('orshap_master_outbox_v1:' + legacyUserId, JSON.stringify([{
        operation_id: 'legacy-master-fixture', kind: 'insert', table: 'items',
        id: '99999999-9999-4999-8999-999999999999',
        row: { id: '99999999-9999-4999-8999-999999999999', code: 'LEGACY-OFFLINE' },
        status: 'PENDING'
      }]));
      const legacyQueueRows = queueSnapshot().filter(row => row.source === 'blocked_master');
      const legacyMasterQuarantined = !localStorage.getItem('orshap_master_outbox_v1:' + legacyUserId)
        && legacyQueueRows.length === 1 && legacyQueueRows[0].status === 'CONFLICT'
        && JSON.parse(localStorage.getItem('orshap_master_outbox_quarantine_v1:' + legacyUserId) || '[]').length === 1;
      const legacyQueueBlocksFurtherOfflineWork = store.legacyMasterDataNeedsRefresh
        && !offlineWarehouseAllowed(warehouseId);
      window.__session = originalSession;
      queueSnapshot();

      return {
        issueAllowed, receiptDenied, assignedWarehouseAllowed, otherWarehouseDenied,
        multiWarehouseDenied, blockedMasterWrites: blockedMasterWrites.every(Boolean),
        legacyMasterQuarantined, legacyQueueBlocksFurtherOfflineWork, noOptimisticMasterWrite,
        countQueued: !!saved.pending_sync && queued,
        convertedBaseQuantity: saved.counted_qty,
        queueOwnerMatches: queueRows.length === 1 && queueRows[0].user_id === userId
      };
    });
    const failedChecks = Object.entries(offlineChecks).filter(([key, value]) =>
      value !== true && !(key === 'convertedBaseQuantity' && value === 24)
    );
    if (failedChecks.length) throw new Error('Offline store checks failed: ' + JSON.stringify(offlineChecks));

    // Reload Chromium, restore the same verified offline identity, and prove
    // that both the user's local snapshot and pending count survive a refresh.
    await page.reload({ waitUntil: 'networkidle' });
    const refreshChecks = await page.evaluate(async () => {
      const { store, loadLocal, queueSnapshot } = await import('/core-store.js');
      const userId = '11111111-1111-4111-8111-111111111111';
      window.__session = {
        id: userId, role: 'CLERK', offline: true,
        profile: {
          id: userId,
          assigned_warehouse_ids: ['22222222-2222-4222-8222-222222222222'],
          accessible_warehouse_ids: ['22222222-2222-4222-8222-222222222222']
        }
      };
      const snapshotLoaded = loadLocal();
      const line = store.data.stocktake_lines.find(x =>
        x.id === '44444444-4444-4444-8444-444444444444'
      );
      const pending = queueSnapshot().some(row =>
        row.source === 'stocktake' && row.status === 'PENDING'
      );
      const refreshChecks = {
        snapshotLoaded,
        countedQuantityRestored: line?.counted_qty === 24,
        enteredUnitRestored: line?.entered_unit === 'BOX',
        pendingCountRestored: pending
      };
      // A required remote pull failure must preserve the already-loaded local
      // snapshot and its pending count overlay. This uses a mocked transport:
      // no Supabase write or production inventory mutation is possible.
      const { pullAll } = await import('/core-store.js');
      const cachedWarehouse = { id: '22222222-2222-4222-8222-222222222222', name: 'cached warehouse sentinel' };
      store.data.warehouses = [cachedWarehouse];
      store.loaded = true;
      window.__session.offline = false;
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.orshapSupabaseReady = Promise.resolve({
        from(table) {
          return {
            select() {
              if (table === 'warehouses') {
                return Promise.resolve({ data: null, error: { message: 'network request failed' } });
              }
              return Promise.resolve({ data: store.data[table] || [], error: null });
            }
          };
        },
        async rpc(name) {
          if (name === 'list_stocktake_lines_secure') {
            return { data: store.data.stocktake_lines, error: null };
          }
          return { data: null, error: null };
        }
      });
      let pullFailedAsExpected = false;
      let pullErrorMessage = '';
      const originalConsoleError = console.error;
      console.error = (...args) => {
        if (String(args[0] || '').includes('[store] pull failed')) return;
        originalConsoleError.apply(console, args);
      };
      try { await pullAll({ silent: true }); }
      catch (error) {
        pullErrorMessage = String(error?.message || error);
        pullFailedAsExpected = /warehouses: network request failed/i.test(pullErrorMessage);
      }
      finally { console.error = originalConsoleError; }
      const lineAfterFailedPull = store.data.stocktake_lines.find(x =>
        x.id === '44444444-4444-4444-8444-444444444444'
      );
      const pendingAfterFailedPull = queueSnapshot().some(row =>
        row.source === 'stocktake' && row.status === 'PENDING'
      );
      refreshChecks.remotePullFailurePreservedCache =
        pullFailedAsExpected
        && store.data.warehouses.length === 1
        && store.data.warehouses[0].id === cachedWarehouse.id
        && store.data.warehouses[0].name === cachedWarehouse.name
        && lineAfterFailedPull?.counted_qty === 24
        && pendingAfterFailedPull;
      refreshChecks.pullFailureDiagnostics = {
        loading: store.loading, loaded: store.loaded, error: pullErrorMessage,
        warehouseCount: store.data.warehouses.length,
        warehouseId: store.data.warehouses[0]?.id,
        warehouseName: store.data.warehouses[0]?.name,
        countedQuantity: lineAfterFailedPull?.counted_qty,
        pendingCount: pendingAfterFailedPull
      };

      // Now test account isolation after preserving and validating the real snapshot.
      localStorage.setItem('orshap_wms_data_v5', JSON.stringify({
        __cached_user_id: '77777777-7777-4777-8777-777777777777',
        warehouses: [{ id: 'foreign-warehouse', name: 'foreign cached warehouse' }],
        stock: [{ id: 'foreign-stock' }]
      }));
      store.data.warehouses = [{ id: 'foreign-warehouse', name: 'stale in-memory warehouse' }];
      refreshChecks.foreignSnapshotRejected = loadLocal() === false
        && store.data.warehouses.length === 0 && store.data.stock.length === 0;
      return refreshChecks;
    });
    const refreshFailures = Object.entries(refreshChecks).filter(([key, value]) => key !== 'pullFailureDiagnostics' && value !== true);
    if (refreshFailures.length) throw new Error('Refresh/account-isolation checks failed: ' + JSON.stringify(refreshChecks));


    // End-to-end stocktake outbox test with a mocked Supabase client only.
    const syncChecks = await page.evaluate(async () => {
      const { store, saveStocktakeCount, syncAll, queueSnapshot } = await import('/core-store.js');
      const userId = '11111111-1111-4111-8111-111111111111';
      const warehouseId = '22222222-2222-4222-8222-222222222222';
      const sessionId = '33333333-3333-4333-8333-333333333333';
      const lineId = '44444444-4444-4444-8444-444444444444';
      const itemId = '55555555-5555-4555-8555-555555555555';
      window.__session = {
        id: userId, role: 'CLERK', offline: true,
        profile: { id: userId, assigned_warehouse_ids: [warehouseId], accessible_warehouse_ids: [warehouseId] }
      };
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('orshap_stocktake_count_queue_v1:')) localStorage.removeItem(key);
      }
      store.loading = false;
      store.loaded = true;
      store.data.warehouses = [{ id: warehouseId, name: 'Authorized test warehouse' }];
      store.data.items = [{ id: itemId, base_unit: 'PCS' }];
      store.data.item_unit_conversions = [{ item_id: itemId, unit_code: 'BOX', factor_to_base: 12 }];
      store.data.stocktake_sessions = [{
        id: sessionId, warehouse_id: warehouseId, created_by: userId,
        status: 'IN_PROGRESS', review_status: 'DRAFT'
      }];
      store.data.stocktake_lines = [{
        id: lineId, session_id: sessionId, item_id: itemId,
        system_qty: 20, base_unit: 'PCS', counted_qty: null
      }];
      await saveStocktakeCount(lineId, 2, 'BOX');

      let currentFactor = 10;
      let countRpcCalls = 0;
      const rpcArgs = [];
      window.orshapSupabaseReady = Promise.resolve({
        from(table) {
          return {
            select() {
              const result = table === 'item_unit_conversions'
                ? { data: [{ item_id: itemId, unit_code: 'BOX', factor_to_base: currentFactor }], error: null }
                : { data: store.data[table] || [], error: null };
              return {
                in: async () => result,
                then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
              };
            }
          };
        },
        async rpc(name, args) {
          if (name === 'list_stocktake_lines_secure') return { data: store.data.stocktake_lines, error: null };
          if (name === 'save_stocktake_count_v3') {
            countRpcCalls++;
            rpcArgs.push(args);
            const line = store.data.stocktake_lines.find(x => x.id === args.p_line_id);
            if (line) {
              line.counted_qty = Number(args.p_entered_quantity) * Number(args.p_expected_factor);
              line.entered_quantity = Number(args.p_entered_quantity);
              line.entered_unit = args.p_entered_unit;
              line.conversion_factor = Number(args.p_expected_factor);
            }
            return { data: { counted_qty: line?.counted_qty }, error: null };
          }
          return { data: null, error: null };
        }
      });

      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.__session.offline = false;
      const conflictResult = await syncAll();
      const queueAfterConflict = JSON.parse(localStorage.getItem('orshap_stocktake_count_queue_v1:' + userId) || '[]');
      const callsAfterConflict = countRpcCalls;
      const factorConflict = conflictResult.conflicts === 1
        && queueAfterConflict.length === 1
        && queueAfterConflict[0].status === 'CONFLICT'
        && callsAfterConflict === 0;

      currentFactor = 10;
      store.data.item_unit_conversions = [{ item_id: itemId, unit_code: 'BOX', factor_to_base: 10 }];
      window.__session.offline = true;
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      await saveStocktakeCount(lineId, 2, 'BOX');
      const reenteredQueue = JSON.parse(localStorage.getItem('orshap_stocktake_count_queue_v1:' + userId) || '[]');
      const reenteredWithCorrectFactor = reenteredQueue.length === 1
        && reenteredQueue[0].status === 'PENDING'
        && reenteredQueue[0].conversion_factor === 10
        && reenteredQueue[0].base_quantity === 20;

      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.__session.offline = false;
      const firstSync = await syncAll();
      const queueAfterSync = JSON.parse(localStorage.getItem('orshap_stocktake_count_queue_v1:' + userId) || '[]');
      const firstSyncOnce = firstSync.stocktakeCounts === 1
        && countRpcCalls === 1
        && rpcArgs[0]?.p_expected_factor === 10
        && queueAfterSync.length === 0
        && store.data.stocktake_lines.find(x => x.id === lineId)?.counted_qty === 20;
      const secondSync = await syncAll();
      const secondSyncIdempotent = secondSync.stocktakeCounts === 0 && countRpcCalls === 1
        && queueSnapshot().every(x => x.source !== 'stocktake');

      return { factorConflict, reenteredWithCorrectFactor, firstSyncOnce, secondSyncIdempotent,
        conflictResult: { conflicts: conflictResult.conflicts, pending: conflictResult.pending, stocktakeCounts: conflictResult.stocktakeCounts },
        queueAfterConflict: queueAfterConflict.map(row => ({ status: row.status, attempts: row.attempts, last_error: row.last_error, factor: row.conversion_factor })),
        callsAfterConflict,
        countRpcCalls, firstSyncCount: firstSync.stocktakeCounts, secondSyncCount: secondSync.stocktakeCounts };
    });
    const syncFailures = Object.entries(syncChecks).filter(([key, value]) =>
      !['conflictResult', 'queueAfterConflict', 'callsAfterConflict', 'countRpcCalls', 'firstSyncCount', 'secondSyncCount'].includes(key) && value !== true
    );
    if (syncFailures.length) throw new Error('Stocktake sync checks failed: ' + JSON.stringify(syncChecks));

    const warehouseScopeChecks = await page.evaluate(async () => {
      const { store, applyAccessFilter } = await import('/core-store.js');
      const {
        accessibleWarehouseIds, canAccessWarehouse, canManageSystemSettings,
        canAdministerProfiles, canDatabasePermission, can, canAccessPage,
        canCreateTransactionType, canViewSystemQty, canApproveTransactions
      } = await import('/core-rbac.js');
      const originalSession = window.__session;
      const originalRolePermissions = store.data.role_permissions;
      store.data.role_permissions = [];
      const roleContract = {};
      for (const role of ['SUPER_ADMIN', 'MANAGER', 'ADMIN', 'WAREHOUSE_MANAGER', 'CLERK']) {
        window.__session = { id: 'role-contract-test', role, profile: { role } };
        roleContract[role] = {
          profiles: canAdministerProfiles(),
          systemSettings: canManageSystemSettings(),
          stocktakeStart: canDatabasePermission('action:stocktake:start'),
          issuePermission: can('action:transaction:issue:create'),
          inventoryPage: canAccessPage('inventory'),
          issueCreate: canCreateTransactionType('ISSUE'),
          customerReturn: canCreateTransactionType('RETURN_FROM_CUSTOMER'),
          supplierReturn: canCreateTransactionType('RETURN_TO_SUPPLIER'),
          openingBalance: canCreateTransactionType('OPENING_BALANCE'),
          systemQty: canViewSystemQty(),
          approve: canApproveTransactions(),
          itemCreate: canDatabasePermission('action:item:create'),
          itemUpdate: canDatabasePermission('action:item:update'),
          itemDelete: canDatabasePermission('action:item:delete')
        };
      }
      window.__session = {
        id: 'role-contract-custom',
        role: 'WAREHOUSE_MANAGER',
        profile: { role: 'WAREHOUSE_MANAGER', custom_permissions: [
          'action:stocktake:start', 'action:transaction:issue:create',
          'page:inventory:access', 'action:stocktake:view_system_qty',
          'action:transaction:approve'
        ] }
      };
      const warehouseManagerExplicitGrant = canDatabasePermission('action:stocktake:start')
        && can('action:transaction:issue:create') && canAccessPage('inventory')
        && canCreateTransactionType('ISSUE') && canViewSystemQty() && canApproveTransactions();
      window.__session = {
        id: 'role-contract-wildcard',
        role: 'WAREHOUSE_MANAGER',
        profile: { role: 'WAREHOUSE_MANAGER', custom_permissions: ['*'] }
      };
      const wildcardDoesNotBypassDatabase = !can('action:transaction:issue:create')
        && !canAccessPage('inventory');
      store.data.role_permissions = originalRolePermissions;
      window.__session = originalSession;
      const permissionRoleContract = roleContract.SUPER_ADMIN.profiles
        && roleContract.SUPER_ADMIN.systemSettings
        && !roleContract.MANAGER.profiles && roleContract.MANAGER.systemSettings
        && !roleContract.ADMIN.profiles && !roleContract.ADMIN.systemSettings
        && !roleContract.WAREHOUSE_MANAGER.profiles && !roleContract.WAREHOUSE_MANAGER.systemSettings
        && !roleContract.CLERK.profiles && !roleContract.CLERK.systemSettings
        && roleContract.SUPER_ADMIN.stocktakeStart && roleContract.MANAGER.stocktakeStart
        && roleContract.ADMIN.stocktakeStart && !roleContract.WAREHOUSE_MANAGER.stocktakeStart
        && !roleContract.CLERK.stocktakeStart
        && roleContract.SUPER_ADMIN.issuePermission && roleContract.MANAGER.issuePermission
        && roleContract.ADMIN.issuePermission && !roleContract.WAREHOUSE_MANAGER.issuePermission
        && !roleContract.CLERK.issuePermission
        && roleContract.SUPER_ADMIN.inventoryPage && roleContract.MANAGER.inventoryPage
        && roleContract.ADMIN.inventoryPage && !roleContract.WAREHOUSE_MANAGER.inventoryPage
        && !roleContract.CLERK.inventoryPage
        && roleContract.SUPER_ADMIN.issueCreate && roleContract.MANAGER.issueCreate
        && roleContract.ADMIN.issueCreate && !roleContract.WAREHOUSE_MANAGER.issueCreate
        && !roleContract.CLERK.issueCreate
        && roleContract.SUPER_ADMIN.customerReturn && roleContract.MANAGER.customerReturn
        && roleContract.ADMIN.customerReturn && !roleContract.WAREHOUSE_MANAGER.customerReturn
        && !roleContract.CLERK.customerReturn
        && roleContract.SUPER_ADMIN.supplierReturn && roleContract.MANAGER.supplierReturn
        && roleContract.ADMIN.supplierReturn && !roleContract.WAREHOUSE_MANAGER.supplierReturn
        && !roleContract.CLERK.supplierReturn
        && roleContract.SUPER_ADMIN.openingBalance && roleContract.MANAGER.openingBalance
        && !roleContract.ADMIN.openingBalance && !roleContract.WAREHOUSE_MANAGER.openingBalance
        && !roleContract.CLERK.openingBalance
        && roleContract.SUPER_ADMIN.systemQty && roleContract.MANAGER.systemQty
        && roleContract.ADMIN.systemQty && !roleContract.WAREHOUSE_MANAGER.systemQty
        && !roleContract.CLERK.systemQty
        && roleContract.SUPER_ADMIN.approve && roleContract.MANAGER.approve
        && roleContract.ADMIN.approve && !roleContract.WAREHOUSE_MANAGER.approve
        && !roleContract.CLERK.approve
        && roleContract.SUPER_ADMIN.itemCreate && roleContract.MANAGER.itemCreate
        && roleContract.ADMIN.itemCreate && !roleContract.WAREHOUSE_MANAGER.itemCreate
        && !roleContract.CLERK.itemCreate
        && roleContract.SUPER_ADMIN.itemUpdate && roleContract.MANAGER.itemUpdate
        && roleContract.ADMIN.itemUpdate && !roleContract.WAREHOUSE_MANAGER.itemUpdate
        && !roleContract.CLERK.itemUpdate
        && roleContract.SUPER_ADMIN.itemDelete && roleContract.MANAGER.itemDelete
        && roleContract.ADMIN.itemDelete && !roleContract.WAREHOUSE_MANAGER.itemDelete
        && !roleContract.CLERK.itemDelete
        && warehouseManagerExplicitGrant && wildcardDoesNotBypassDatabase;
      const w1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      const w2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
      const w3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
      const reset = () => {
        store.data.warehouses = [w1, w2, w3].map((id, i) => ({ id, name: 'Scope warehouse ' + (i + 1) }));
        store.data.zones = [];
        store.data.storage_areas = [];
        store.data.warehouse_storage_areas = [];
        store.data.sections = [];
        store.data.shelves = [];
        store.data.stock = [];
        store.data.transactions = [];
        store.data.transaction_lines = [];
        store.data.stocktake_sessions = [];
        store.data.stocktake_lines = [];
        store.data.stocktake_logs = [];
        store.data.stock_transfers = [];
        store.data.stock_transfer_orders = [];
        store.data.inventory_ledger = [];
        store.data.transaction_ledger = [];
        store.data.transaction_audit = [];
        store.data.archive_movements = [];
        store.data.archive_balances = [];
        store.data.audit_logs = [];
        store.data.sync_log = [];
      };
      store.scopeConfigLoaded = true;
      store.data.role_warehouse_scopes = [{ role_name: 'CLERK', scope_mode: 'SELECTED', warehouse_ids: [w1, w2] }];
      window.__session = { id: 'scope-test-user', role: 'CLERK', offline: false, profile: { id: 'scope-test-user', assigned_warehouse_ids: [] } };
      reset();
      applyAccessFilter();
      const selectedRole = store.data.warehouses.map(x => x.id).sort().join(',') === [w1, w2].sort().join(',')
        && accessibleWarehouseIds().length === 2 && canAccessWarehouse(w2) && !canAccessWarehouse(w3);

      window.__session.profile.assigned_warehouse_ids = [w1, w3];
      reset();
      applyAccessFilter();
      const assignmentIntersection = store.data.warehouses.length === 1
        && store.data.warehouses[0].id === w1
        && accessibleWarehouseIds().length === 1 && canAccessWarehouse(w1) && !canAccessWarehouse(w3);

      window.__session.role = 'MANAGER';
      window.__session.profile.role = 'MANAGER';
      window.__session.profile.assigned_warehouse_ids = [];
      store.data.role_warehouse_scopes = [{ role_name: 'MANAGER', scope_mode: 'INHERIT', warehouse_ids: [] }];
      reset();
      applyAccessFilter();
      const inheritFailsClosed = store.data.warehouses.length === 0 && accessibleWarehouseIds().length === 0;

      store.data.role_warehouse_scopes = [{ role_name: 'MANAGER', scope_mode: 'ALL', warehouse_ids: [] }];
      reset();
      applyAccessFilter();
      const explicitAll = store.data.warehouses.length === 3 && accessibleWarehouseIds() === null && canAccessWarehouse(w3);

      window.__session.profile.assigned_warehouse_ids = [w2];
      reset();
      applyAccessFilter();
      const userAssignmentNarrowsAll = store.data.warehouses.length === 1
        && store.data.warehouses[0].id === w2 && accessibleWarehouseIds().length === 1;

      window.__session.role = 'SUPER_ADMIN';
      window.__session.profile.role = 'SUPER_ADMIN';
      window.__session.profile.assigned_warehouse_ids = [];
      store.data.role_warehouse_scopes = [{ role_name: 'SUPER_ADMIN', scope_mode: 'INHERIT', warehouse_ids: [] }];
      reset();
      applyAccessFilter();
      const legacyAdminInherit = store.data.warehouses.length === 3 && accessibleWarehouseIds() === null;

      store.scopeConfigLoaded = false;
      reset();
      applyAccessFilter();
      const missingScopeFailsClosed = store.data.warehouses.length === 0
        && accessibleWarehouseIds().length === 0 && !canAccessWarehouse(w1);

      store.scopeConfigLoaded = true;
      return { permissionRoleContract, selectedRole, assignmentIntersection, inheritFailsClosed, explicitAll,
        userAssignmentNarrowsAll, legacyAdminInherit, missingScopeFailsClosed };
    });
    const scopeFailures = Object.entries(warehouseScopeChecks).filter(([, value]) => value !== true);
    if (scopeFailures.length) throw new Error('Warehouse scope checks failed: ' + JSON.stringify(warehouseScopeChecks));

    if (errors.length) throw new Error('Browser errors:\\n' + errors.join('\\n'));
    console.log('PASS: login desktop/mobile smoke; no browser errors; offline policy allows ISSUE and stocktake counts only; master-data writes are rejected and legacy master queue is quarantined; single-warehouse scope enforced; multi-warehouse offline denied; stocktake count queued locally with BOX x12 = 24 PCS and bound to its creator; refresh/fetch-failure cache preservation; conversion conflict; corrected-factor sync exactly once; foreign-user cached snapshot rejected; role SELECTED/ALL/INHERIT scopes and user-assignment intersections enforced in UI.');
  } catch (error) {
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/failure.png', fullPage: true }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
