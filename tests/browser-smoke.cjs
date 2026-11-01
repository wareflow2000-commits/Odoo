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

    // Render every settings tab in Chromium to catch permission-gate regressions
    // and runtime reference errors without issuing any Supabase mutations.
    const settingsTabChecks = await page.evaluate(async () => {
      await import('/page-settings.js');
      const settingsPage = window.OW?.pages?.settings;
      if (typeof settingsPage?.render !== 'function') return {};
      const result = {};
      for (const tab of ['general', 'users', 'roles', 'authorization', 'units', 'categories', 'import', 'data']) {
        window.OW.wms.settingsTab(tab);
        result[tab] = typeof settingsPage.render() === 'string';
      }
      window.OW.wms.settingsTab('general');
      const generalHtml = settingsPage.render();
      result.general = typeof generalHtml === 'string'
        && !generalHtml.includes('data-flag="REQUIRE_APPROVAL"')
        && (generalHtml.includes('تفويض') || /delegation/i.test(generalHtml));
      return result;
    });
    if (Object.keys(settingsTabChecks).length !== 8 || Object.values(settingsTabChecks).some(value => value !== true)) {
      throw new Error('Settings tab render checks failed: ' + JSON.stringify(settingsTabChecks));
    }

    // Render the institutional role scope controls with isolated in-memory data.
    // This verifies that the UI reads the saved role scope and offers all three
    // supported modes without performing any database writes.
    const roleScopeUiChecks = await page.evaluate(async () => {
      const { store } = await import('/core-store.js');
      const original = {
        session: window.__session,
        permissions: store.data.permissions,
        rolePermissions: store.data.role_permissions,
        roleScopes: store.data.role_warehouse_scopes,
        warehouses: store.data.warehouses
      };
      const warehouseId = '12121212-1212-4212-8212-121212121212';
      try {
        window.__session = {
          id: 'role-scope-ui-superadmin',
          role: 'SUPER_ADMIN',
          profile: { id: 'role-scope-ui-superadmin', role: 'SUPER_ADMIN' }
        };
        store.data.permissions = [{ key: 'page:inventory:access', description: 'Inventory page' }];
        store.data.role_permissions = [{ role_name: 'CLERK', permission_key: 'page:inventory:access' }];
        store.data.role_warehouse_scopes = [{
          role_name: 'CLERK', scope_mode: 'SELECTED', warehouse_ids: [warehouseId]
        }];
        store.data.warehouses = [{ id: warehouseId, code: 'TEST-01', name: 'Scope UI test warehouse' }];
        window.OW.wms.settingsTab('roles');
        const html = window.OW.pages.settings.render();
        const selectedScope = html.includes('id="roleScopeMode"')
          && html.includes('value="SELECTED" selected')
          && html.includes('data-role-warehouse="' + warehouseId + '" checked')
          && html.includes('roleScopeWarehouses');
        store.data.role_warehouse_scopes = [{ role_name: 'CLERK', scope_mode: 'ALL', warehouse_ids: [] }];
        const allHtml = window.OW.pages.settings.render();
        const allScope = allHtml.includes('value="ALL" selected');
        store.data.role_warehouse_scopes = [{ role_name: 'CLERK', scope_mode: 'INHERIT', warehouse_ids: [] }];
        const inheritHtml = window.OW.pages.settings.render();
        const inheritScope = inheritHtml.includes('value="INHERIT" selected');
        return { selectedScope, allScope, inheritScope };
      } finally {
        window.__session = original.session;
        store.data.permissions = original.permissions;
        store.data.role_permissions = original.rolePermissions;
        store.data.role_warehouse_scopes = original.roleScopes;
        store.data.warehouses = original.warehouses;
        window.OW.wms.settingsTab('general');
      }
    });
    if (!roleScopeUiChecks.selectedScope || !roleScopeUiChecks.allScope || !roleScopeUiChecks.inheritScope) {
      throw new Error('Institutional role warehouse-scope UI checks failed: ' + JSON.stringify(roleScopeUiChecks));
    }

    // Reconcile the item movement summary using isolated ledger fixtures.
    // Internal transfer movements must not be counted as consumption or supplier receipts.
    const transferReportChecks = await page.evaluate(async () => {
      const { store } = await import('/core-store.js');
      await import('/page-reports.js');
      const original = {
        items: store.data.items,
        warehouses: store.data.warehouses,
        ledger: store.data.inventory_ledger
      };
      const itemId = '77777777-7777-4777-8777-777777777777';
      const sourceWarehouse = '88888888-8888-4888-8888-888888888888';
      const destinationWarehouse = '99999999-9999-4999-8999-999999999999';
      const sourceShelf = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const destinationShelf = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const { todayISO } = await import('/core-utils.js');
      const at = (hour, minute = 0) => new Date(`${todayISO()}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString();
      try {
        store.data.items = [{ id: itemId, code: 'SKU-REPORT-TRANSFER', name_en: 'Transfer test item', base_unit: 'PCS' }];
        store.data.warehouses = [
          { id: sourceWarehouse, name: 'Report source' },
          { id: destinationWarehouse, name: 'Report destination' }
        ];
        store.data.inventory_ledger = [
          { id: '1', item_id: itemId, warehouse_id: sourceWarehouse, shelf_id: sourceShelf, batch_no: 'B1',
            source_type: 'OPENING_BALANCE', source_ref: 'OPEN-REPORT', occurred_at: at(8), created_at: at(8),
            delta: 100, running_balance: 100 },
          { id: '2', item_id: itemId, warehouse_id: sourceWarehouse, shelf_id: sourceShelf, batch_no: 'B1',
            source_type: 'GRN', source_ref: 'GRN-REPORT', occurred_at: at(9), created_at: at(9),
            delta: 20, running_balance: 120 },
          { id: '3', item_id: itemId, warehouse_id: sourceWarehouse, shelf_id: sourceShelf, batch_no: 'B1',
            source_type: 'ISSUE', source_ref: 'ISSUE-REPORT', occurred_at: at(10), created_at: at(10),
            delta: -5, running_balance: 115 },
          { id: '4', item_id: itemId, warehouse_id: sourceWarehouse, shelf_id: sourceShelf, batch_no: 'B1',
            source_type: 'ADJUSTMENT_OUT', source_ref: 'TRF-REPORT-L001',
            metadata: { transfer_id: 'transfer-report-1' }, occurred_at: at(11), created_at: at(11),
            delta: -30, running_balance: 85 },
          { id: '5', item_id: itemId, warehouse_id: sourceWarehouse, shelf_id: sourceShelf, batch_no: 'B1',
            source_type: 'TRANSFER_RETURN', source_ref: 'TRF-REPORT-L001',
            metadata: { transfer_id: 'transfer-report-1' }, occurred_at: at(12), created_at: at(12),
            delta: 4, running_balance: 89 },
          { id: '6', item_id: itemId, warehouse_id: destinationWarehouse, shelf_id: destinationShelf, batch_no: 'B1',
            source_type: 'TRANSFER_IN', source_ref: 'TRF-REPORT-L001',
            metadata: { transfer_id: 'transfer-report-1' }, occurred_at: at(13), created_at: at(13),
            delta: 10, running_balance: 10 }
        ];
        const report = window.OW.wms.reports.reportData('tx-summary');
        const source = report.rows.find(row => row[0] === 'SKU-REPORT-TRANSFER' && row[3] === 'Report source');
        const destination = report.rows.find(row => row[0] === 'SKU-REPORT-TRANSFER' && row[3] === 'Report destination');
        const sourceValues = source || [];
        const destinationValues = destination || [];
        return {
          headers: report.headers.length,
          source: sourceValues.slice(4),
          destination: destinationValues.slice(4),
          sourceCorrect: sourceValues.length === 11
            && sourceValues[4] === 100 && sourceValues[5] === 20
            && sourceValues[6] === 0 && sourceValues[7] === 4
            && sourceValues[8] === 5 && sourceValues[9] === 30
            && sourceValues[10] === 89,
          destinationCorrect: destinationValues.length === 11
            && destinationValues[4] === 0 && destinationValues[5] === 0
            && destinationValues[6] === 10 && destinationValues[7] === 0
            && destinationValues[8] === 0 && destinationValues[9] === 0
            && destinationValues[10] === 10
        };
      } finally {
        store.data.items = original.items;
        store.data.warehouses = original.warehouses;
        store.data.inventory_ledger = original.ledger;
      }
    });
    if (!transferReportChecks.sourceCorrect || !transferReportChecks.destinationCorrect
      || transferReportChecks.headers !== 11) {
      throw new Error('Transfer movement report classification failed: ' + JSON.stringify(transferReportChecks));
    }

    // Validate report period boundaries and opening balance reconstruction from the ledger.
    // The prior-month opening is the carry-forward; start-of-period and final millisecond
    // are included, while the first instant of the next day is excluded.
    const periodReportChecks = await page.evaluate(async () => {
      const { store } = await import('/core-store.js');
      const { todayISO } = await import('/core-utils.js');
      const original = {
        items: store.data.items,
        warehouses: store.data.warehouses,
        ledger: store.data.inventory_ledger
      };
      const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const warehouseId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const shelfId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      try {
        const [year, month, day] = todayISO().split('-').map(Number);
        const at = (date) => date.toISOString();
        const priorMonthEnd = new Date(year, month - 1, 0, 23, 59, 59, 999);
        const periodStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
        const periodEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
        const nextDayStart = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
        store.data.items = [{ id: itemId, code: 'SKU-REPORT-PERIOD', name_en: 'Period test item', base_unit: 'PCS' }];
        store.data.warehouses = [{ id: warehouseId, name: 'Period report warehouse' }];
        store.data.inventory_ledger = [
          { id: 'period-1', item_id: itemId, warehouse_id: warehouseId, shelf_id: shelfId, batch_no: 'P1',
            source_type: 'OPENING_BALANCE', source_ref: 'OPEN-PERIOD', occurred_at: at(priorMonthEnd), created_at: at(priorMonthEnd),
            delta: 100, running_balance: 100 },
          { id: 'period-2', item_id: itemId, warehouse_id: warehouseId, shelf_id: shelfId, batch_no: 'P1',
            source_type: 'GRN', source_ref: 'GRN-START-BOUNDARY', occurred_at: at(periodStart), created_at: at(periodStart),
            delta: 20, running_balance: 120 },
          { id: 'period-3', item_id: itemId, warehouse_id: warehouseId, shelf_id: shelfId, batch_no: 'P1',
            source_type: 'ISSUE', source_ref: 'ISSUE-END-BOUNDARY', occurred_at: at(periodEnd), created_at: at(periodEnd),
            delta: -5, running_balance: 115 },
          { id: 'period-4', item_id: itemId, warehouse_id: warehouseId, shelf_id: shelfId, batch_no: 'P1',
            source_type: 'GRN', source_ref: 'GRN-NEXT-DAY', occurred_at: at(nextDayStart), created_at: at(nextDayStart),
            delta: 50, running_balance: 165 }
        ];
        const report = window.OW.wms.reports.reportData('tx-summary');
        const row = report.rows.find(value => value[0] === 'SKU-REPORT-PERIOD'
          && value[3] === 'Period report warehouse');
        return {
          found: Boolean(row),
          values: row ? row.slice(4) : [],
          correct: Boolean(row) && row[4] === 100 && row[5] === 20
            && row[6] === 0 && row[7] === 0 && row[8] === 5
            && row[9] === 0 && row[10] === 115
        };
      } finally {
        store.data.items = original.items;
        store.data.warehouses = original.warehouses;
        store.data.inventory_ledger = original.ledger;
      }
    });
    if (!periodReportChecks.correct) {
      throw new Error('Report period/opening-balance reconciliation failed: ' + JSON.stringify(periodReportChecks));
    }

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
      const originalAuthorizationPermissions = store.authorizationPermissions;
      const originalAuthorizationGrantRows = store.authorizationGrantRows;
      const originalAuthorizationGrantRowsUserId = store.authorizationGrantRowsUserId;
      const originalLegacyMasterDataNeedsRefresh = store.legacyMasterDataNeedsRefresh;
      // This fixture contains no legacy master-data outbox. Keep the refresh
      // barrier disabled only for this isolated stocktake-count test.
      store.legacyMasterDataNeedsRefresh = false;
      store.authorizationGrantRows = [{
        id: 'offline-count-grant', subject_type: 'USER', permission_key: 'action:stocktake:count',
        effect: 'ALLOW', resource_type: 'stocktake_session', resource_id: sessionId,
        warehouse_id: warehouseId, scope_type: 'WAREHOUSE', conditions: { offline: true },
        valid_from: new Date(Date.now() - 60000).toISOString(), valid_until: null
      }];
      store.authorizationGrantRowsUserId = window.__session.id;
      store.authorizationPermissions = ['action:stocktake:count'];
      const offlineCountFixtureState = {
        sessionId: window.__session?.id,
        profileId: window.__session?.profile?.id,
        assigned: window.__session?.profile?.assigned_warehouse_ids,
        warehouseId, scopeConfigLoaded: store.scopeConfigLoaded,
        legacyMasterDataNeedsRefresh: store.legacyMasterDataNeedsRefresh,
        offline: window.__session?.offline
      };
      if (offlineCountFixtureState.sessionId !== userId
          || offlineCountFixtureState.profileId !== userId
          || JSON.stringify(offlineCountFixtureState.assigned) !== JSON.stringify([warehouseId])
          || offlineCountFixtureState.scopeConfigLoaded !== true
          || offlineCountFixtureState.legacyMasterDataNeedsRefresh !== false
          || offlineCountFixtureState.offline !== true) {
        throw new Error('Invalid offline stocktake fixture: ' + JSON.stringify(offlineCountFixtureState));
      }
      const saved = await saveStocktakeCount(lineId, 2, 'BOX');
      const firstSaveScope = offlineWarehouseAllowed(warehouseId);
      if (!firstSaveScope) {
        throw new Error('Offline warehouse scope changed after first count: ' + JSON.stringify({
          scopeConfigLoaded: store.scopeConfigLoaded,
          legacyMasterDataNeedsRefresh: store.legacyMasterDataNeedsRefresh,
          assigned: window.__session?.profile?.assigned_warehouse_ids,
          sessionId: window.__session?.id,
          profileId: window.__session?.profile?.id
        }));
      }
      // Session creation and count execution are separate grants. Neither
      // MANAGER nor ADMIN bypasses the count grant, but a delegated counter
      // with an explicit grant may count a session created by another user.
      const originalCreator = store.data.stocktake_sessions[0].created_by;
      const originalRole = window.__session.role;
      const originalCountLine = { ...store.data.stocktake_lines[0] };
      const countCacheSnapshot = localStorage.getItem('orshap_wms_data_v5');
      const countQueueKey = Object.keys(localStorage).find(key => key.startsWith('orshap_stocktake_count_queue_v1:'));
      const countQueueSnapshot = countQueueKey ? localStorage.getItem(countQueueKey) : null;
      store.data.stocktake_sessions[0].created_by = '88888888-8888-4888-8888-888888888888';
      store.authorizationPermissions = [];
      store.authorizationGrantRows = [];
      store.authorizationGrantRowsUserId = window.__session.id;
      window.__session.role = 'ADMIN';
      const adminCannotCountWithoutGrant = await expectBlocked(() => saveStocktakeCount(lineId, 3, 'BOX'));
      window.__session.role = 'MANAGER';
      const managerCannotCountWithoutGrant = await expectBlocked(() => saveStocktakeCount(lineId, 3, 'BOX'));
      window.__session.role = 'WAREHOUSE_MANAGER';
      const warehouseManagerCannotCountWithoutGrant = await expectBlocked(() => saveStocktakeCount(lineId, 3, 'BOX'));
      store.authorizationPermissions = ['action:stocktake:count'];
      store.authorizationGrantRows = [{
        id: 'delegated-count-grant', subject_type: 'USER', permission_key: 'action:stocktake:count',
        effect: 'ALLOW', resource_type: 'stocktake_session', resource_id: sessionId,
        warehouse_id: warehouseId, scope_type: 'WAREHOUSE', conditions: { offline: true },
        valid_from: new Date(Date.now() - 60000).toISOString(), valid_until: null
      }];
      const delegatedScopeBeforeSave = offlineWarehouseAllowed(warehouseId);
      if (!delegatedScopeBeforeSave) {
        throw new Error('Offline warehouse scope changed before delegated count: ' + JSON.stringify({
          scopeConfigLoaded: store.scopeConfigLoaded,
          legacyMasterDataNeedsRefresh: store.legacyMasterDataNeedsRefresh,
          assigned: window.__session?.profile?.assigned_warehouse_ids,
          sessionId: window.__session?.id,
          profileId: window.__session?.profile?.id,
          role: window.__session?.role
        }));
      }
      const delegatedCounterAllowed = await saveStocktakeCount(lineId, 4, 'BOX');
      store.data.stocktake_sessions[0].created_by = originalCreator;
      Object.assign(store.data.stocktake_lines[0], originalCountLine);
      window.__session.role = originalRole;
      store.authorizationPermissions = originalAuthorizationPermissions;
      store.authorizationGrantRows = originalAuthorizationGrantRows;
      store.authorizationGrantRowsUserId = originalAuthorizationGrantRowsUserId;
      store.legacyMasterDataNeedsRefresh = originalLegacyMasterDataNeedsRefresh;
      if (countCacheSnapshot !== null) localStorage.setItem('orshap_wms_data_v5', countCacheSnapshot);
      if (countQueueKey && countQueueSnapshot !== null) localStorage.setItem(countQueueKey, countQueueSnapshot);
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
        && !offlineWarehouseAllowed(warehouseId) && !offlineTransactionTypeAllowed('ISSUE');
      window.__session = originalSession;
      queueSnapshot();

      return {
        issueAllowed, receiptDenied, assignedWarehouseAllowed, otherWarehouseDenied,
        multiWarehouseDenied, blockedMasterWrites: blockedMasterWrites.every(Boolean),
        legacyMasterQuarantined, legacyQueueBlocksFurtherOfflineWork, noOptimisticMasterWrite,
        countQueued: !!saved.pending_sync && queued,
        adminCannotCountWithoutGrant,
        managerCannotCountWithoutGrant,
        warehouseManagerCannotCountWithoutGrant,
        delegatedCounterAllowed: !!delegatedCounterAllowed.pending_sync,
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


    // Auto-approval UI pre-check must defer to the server's explicit grant engine.
    const autoApprovalChecks = await page.evaluate(async () => {
      const { shouldAutoApprove, store } = await import('/core-store.js');
      const { canApproveTransactions } = await import('/core-rbac.js');
      const originalSession = window.__session;
      const originalGrantRows = store.authorizationGrantRows;
      const originalGrantRowsUserId = store.authorizationGrantRowsUserId;
      const userId = '99999999-9999-4999-8999-999999999999';
      const warehouseId = '88888888-8888-4888-8888-888888888888';
      const issue = 'action:transaction:issue:create';
      const auto = 'action:transaction:auto_approve';
      const evaluate = async ({ role, profile = {}, grants = [] }) => {
        store.authorizationGrantRows = grants.map((permission_key, index) => ({
          id: 'auto-approval-grant-' + index,
          subject_type: 'USER',
          permission_key,
          effect: 'ALLOW',
          resource_type: 'transaction',
          resource_id: null,
          warehouse_id: warehouseId,
          scope_type: 'WAREHOUSE',
          conditions: {},
          valid_from: new Date(Date.now() - 60000).toISOString(),
          valid_until: null
        }));
        store.authorizationGrantRowsUserId = userId;
        window.__session = { id: userId, role, profile: { id: userId, ...profile } };
        return await shouldAutoApprove('ISSUE', warehouseId, '77777777-7777-4777-8777-777777777777');
      };
      const checks = {
        warehouseManagerNeedsExplicitAutoGrant: await evaluate({
          role: 'WAREHOUSE_MANAGER',
          profile: { can_approve_without_workflow: true },
          grants: [issue]
        }) === false,
        warehouseManagerExplicitDelegation: await evaluate({
          role: 'WAREHOUSE_MANAGER',
          profile: { can_approve_without_workflow: true },
          grants: [issue, auto]
        }) === true,
        managerExplicitDelegation: await evaluate({
          role: 'MANAGER',
          profile: { can_approve_without_workflow: true },
          grants: [issue, auto]
        }) === true,
        selfApprovalFlagRequired: await evaluate({
          role: 'CLERK',
          profile: { can_approve_without_workflow: false },
          grants: [issue, auto]
        }) === false,
        createPermissionRequired: await evaluate({
          role: 'CLERK',
          profile: { can_approve_without_workflow: true },
          grants: [auto]
        }) === false,
        clerkCannotUseGlobalDirectMode: await evaluate({
          role: 'CLERK',
          profile: { can_approve_without_workflow: false },
          grants: [issue]
        }) === false,
        managerCannotUseGlobalDirectMode: await evaluate({
          role: 'MANAGER',
          profile: { can_approve_without_workflow: false },
          grants: [issue]
        }) === false,
        adminCannotUseGlobalDirectMode: await evaluate({
          role: 'ADMIN',
          profile: { can_approve_without_workflow: false }
        }) === false,
        superAdminStillRequiresSeparateSelfApprovalFlag: await evaluate({
          role: 'SUPER_ADMIN',
          profile: { can_approve_without_workflow: false }
        }) === false,
        superAdminWithSelfApprovalFlag: await evaluate({
          role: 'SUPER_ADMIN',
          profile: { can_approve_without_workflow: true }
        }) === true
      };
      store.authorizationGrantRows = [{
        id: 'auto-approval-deny', subject_type: 'USER', permission_key: auto,
        effect: 'DENY', resource_type: 'transaction', resource_id: null,
        warehouse_id: warehouseId, scope_type: 'WAREHOUSE', conditions: {},
        valid_from: new Date(Date.now() - 60000).toISOString(), valid_until: null
      }, {
        id: 'auto-approval-create', subject_type: 'USER', permission_key: issue,
        effect: 'ALLOW', resource_type: 'transaction', resource_id: null,
        warehouse_id: warehouseId, scope_type: 'WAREHOUSE', conditions: {},
        valid_from: new Date(Date.now() - 60000).toISOString(), valid_until: null
      }];
      store.authorizationGrantRowsUserId = userId;
      window.__session = { id: userId, role: 'CLERK', profile: { id: userId, can_approve_without_workflow: true } };
      checks.explicitDenyOverridesAutoApproval = await shouldAutoApprove('ISSUE', warehouseId, '77777777-7777-4777-8777-777777777777') === false;

      const ownVoucher = {
        id: '77777777-7777-4777-8777-777777777777',
        created_by: userId, warehouse_id: warehouseId,
        status: 'PENDING_APPROVAL', transaction_type: 'ISSUE'
      };
      const makeGrant = (permission_key, effect = 'ALLOW') => ({
        id: 'approval-visibility-' + permission_key + '-' + effect,
        subject_type: 'USER', permission_key, effect,
        resource_type: 'transaction', resource_id: null,
        warehouse_id: warehouseId, scope_type: 'WAREHOUSE', conditions: {},
        valid_from: new Date(Date.now() - 60000).toISOString(), valid_until: null
      });
      store.authorizationGrantRows = [makeGrant(issue), makeGrant(auto)];
      window.__session = {
        id: userId, role: 'CLERK',
        profile: { id: userId, can_approve_without_workflow: false }
      };
      checks.ownVoucherHiddenWithoutSelfApprovalFlag = canApproveTransactions(ownVoucher) === false;
      window.__session.profile.can_approve_without_workflow = true;
      checks.ownVoucherVisibleWithExplicitSelfApproval = canApproveTransactions(ownVoucher) === true;
      store.authorizationGrantRows = [makeGrant(issue)];
      checks.ownVoucherHiddenWithoutAutoApprovalGrant = canApproveTransactions(ownVoucher) === false;
      store.authorizationGrantRows = [makeGrant(issue), makeGrant(auto, 'DENY')];
      checks.ownVoucherDeniedByScopedDeny = canApproveTransactions(ownVoucher) === false;
      store.authorizationGrantRows = [makeGrant('action:transaction:approve')];
      const otherVoucher = { ...ownVoucher, created_by: '66666666-6666-4666-8666-666666666666' };
      checks.independentApproverKeepsNormalApprovalGrant = canApproveTransactions(otherVoucher) === true;

      store.authorizationGrantRows = originalGrantRows;
      store.authorizationGrantRowsUserId = originalGrantRowsUserId;
      window.__session = originalSession;
      return checks;
    });
    const autoApprovalFailures = Object.entries(autoApprovalChecks).filter(([, value]) => value !== true);
    if (autoApprovalFailures.length) throw new Error('Auto-approval policy checks failed: ' + JSON.stringify(autoApprovalChecks));

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
      store.authorizationGrantRows = [{
        id: 'sync-count-grant', subject_type: 'USER', permission_key: 'action:stocktake:count',
        effect: 'ALLOW', resource_type: 'stocktake_session', resource_id: sessionId,
        warehouse_id: warehouseId, scope_type: 'WAREHOUSE', conditions: { offline: true },
        valid_from: new Date(Date.now() - 60000).toISOString(), valid_until: null
      }];
      store.scopeConfigLoaded = true;
      store.legacyMasterDataNeedsRefresh = false;
      store.data.role_warehouse_scopes = [];
      store.authorizationGrantRowsUserId = userId;
      store.authorizationPermissions = ['action:stocktake:count'];
      store.authorizationPermissionsUserId = userId;
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
          if (name === 'current_user_authorization_grants') {
            return { data: store.authorizationGrantRows, error: null };
          }
          if (name === 'save_offline_stocktake_count_v2') {
            countRpcCalls++;
            rpcArgs.push(args);
            const line = store.data.stocktake_lines.find(x => x.id === args.p_line_id);
            if (line) {
              line.counted_qty = Number(args.p_entered_quantity) * Number(args.p_expected_factor);
              line.entered_quantity = Number(args.p_entered_quantity);
              line.entered_unit = args.p_entered_unit;
              line.conversion_factor = Number(args.p_expected_factor);
            }
            return { data: { counted_qty: line?.counted_qty, idempotent: false }, error: null };
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
      const operationIdBeforeSync = reenteredQueue[0]?.operation_id;

      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.__session.offline = false;
      const firstSync = await syncAll();
      const queueAfterSync = JSON.parse(localStorage.getItem('orshap_stocktake_count_queue_v1:' + userId) || '[]');
      const firstSyncOnce = firstSync.stocktakeCounts === 1
        && countRpcCalls === 1
        && rpcArgs[0]?.p_expected_factor === 10
        && rpcArgs[0]?.p_operation_id === operationIdBeforeSync
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
      const { store, applyAccessFilter, loadLocal } = await import('/core-store.js');
      const {
        accessibleWarehouseIds, canAccessWarehouse, canManageSystemSettings,
        canAdministerProfiles, canDatabasePermission, can, canAccessPage,
        canCreateTransactionType, canViewSystemQty, canApproveTransactions
      } = await import('/core-rbac.js');
      const originalSession = window.__session;
      const originalAuthorizationPermissions = store.authorizationPermissions;
      const originalAuthorizationGrantRows = store.authorizationGrantRows;
      const originalAuthorizationGrantRowsUserId = store.authorizationGrantRowsUserId;
      store.authorizationPermissions = [];
      store.authorizationGrantRows = [];
      const roleContract = {};
      for (const role of ['SUPER_ADMIN', 'MANAGER', 'ADMIN', 'WAREHOUSE_MANAGER', 'CLERK']) {
        window.__session = { id: 'role-contract-test', role, profile: { role } };
        store.authorizationGrantRowsUserId = 'role-contract-test';
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
          'action:transaction:approve', 'action:settings:manage',
          'action:transaction:opening_balance:create', 'action:chat:manage',
          'table:inventory_ledger:view', 'table:transaction_ledger:view', 'table:audit_logs:view'
        ] }
      };
      store.authorizationGrantRowsUserId = 'role-contract-custom';
      const legacyCustomPermissionsNotAuthoritative =
        !canDatabasePermission('action:transaction:issue:create')
        && !canAccessPage('inventory');
      const explicitKeys = [
        'action:stocktake:start', 'action:transaction:issue:create',
        'page:inventory:access', 'action:stocktake:view_system_qty',
        'action:transaction:approve', 'action:settings:manage',
        'action:transaction:opening_balance:create', 'action:chat:manage',
        'table:inventory_ledger:view', 'table:transaction_ledger:view', 'table:audit_logs:view'
      ];
      store.authorizationGrantRows = explicitKeys.map((permission_key, index) => ({
        id: 'role-contract-grant-' + index, subject_type: 'ROLE', permission_key,
        effect: 'ALLOW', resource_type: null, resource_id: null, warehouse_id: null,
        scope_type: 'ALL', conditions: {}, valid_from: new Date(Date.now() - 60000).toISOString(),
        valid_until: null
      }));
      store.authorizationGrantRowsUserId = 'role-contract-custom';
      store.authorizationPermissions = explicitKeys;
      const warehouseManagerExplicitGrant = canDatabasePermission('action:stocktake:start')
        && can('action:transaction:issue:create') && canAccessPage('inventory')
        && canCreateTransactionType('ISSUE') && canViewSystemQty() && canApproveTransactions()
        && canManageSystemSettings()
        && canDatabasePermission('action:chat:manage')
        && canDatabasePermission('table:inventory_ledger:view')
        && canDatabasePermission('table:transaction_ledger:view')
        && canDatabasePermission('table:audit_logs:view')
        && legacyCustomPermissionsNotAuthoritative;
      window.__session = {
        id: 'role-contract-wildcard',
        role: 'WAREHOUSE_MANAGER',
        profile: { role: 'WAREHOUSE_MANAGER', custom_permissions: ['*'] }
      };
      store.authorizationPermissions = ['*'];
      store.authorizationGrantRows = [];
      store.authorizationGrantRowsUserId = 'role-contract-wildcard';
      const wildcardDoesNotBypassDatabase = !can('action:transaction:issue:create')
        && !canAccessPage('inventory');
      store.authorizationPermissions = originalAuthorizationPermissions;
      store.authorizationGrantRows = originalAuthorizationGrantRows;
      store.authorizationGrantRowsUserId = originalAuthorizationGrantRowsUserId;
      window.__session = originalSession;
      const nonSuperAdminRoles = Object.keys(roleContract).filter(name => name !== 'SUPER_ADMIN');
      const permissionRoleContract = roleContract.SUPER_ADMIN.profiles
        && roleContract.SUPER_ADMIN.systemSettings
        && Object.values(roleContract.SUPER_ADMIN).every(Boolean)
        && nonSuperAdminRoles.every(name => Object.values(roleContract[name]).every(value => value === false))
        && warehouseManagerExplicitGrant && wildcardDoesNotBypassDatabase;
      const cacheKey = 'orshap_wms_data_v5';
      const originalSnapshot = localStorage.getItem(cacheKey);
      const originalCachedPermissions = store.authorizationPermissions;
      const originalCachedGrantRows = store.authorizationGrantRows;
      const originalCachedGrantRowsUserId = store.authorizationGrantRowsUserId;
      const originalRoleRows = store.data.role_permissions;
      const originalScopeLoaded = store.scopeConfigLoaded;
      const originalLoaded = store.loaded;
      window.__session = {
        id: 'cache-migration-user', role: 'CLERK',
        profile: { id: 'cache-migration-user', role: 'CLERK', custom_permissions: ['action:stocktake:count'] }
      };
      localStorage.setItem(cacheKey, JSON.stringify({
        __cached_user_id: 'cache-migration-user',
        __scope_config_loaded: true,
        role_permissions: [{ role_name: 'CLERK', permission_key: 'action:transaction:issue:create' }]
      }));
      const cacheLoaded = loadLocal();
      const migratedSnapshot = JSON.parse(localStorage.getItem(cacheKey) || '{}');
      const legacyCacheFailsClosed = cacheLoaded
        && store.authorizationGrantRows.length === 0
        && store.authorizationPermissions.length === 0
        && Array.isArray(migratedSnapshot.__authorization_grants)
        && migratedSnapshot.__authorization_grants.length === 0;
      if (originalSnapshot === null) localStorage.removeItem(cacheKey);
      else localStorage.setItem(cacheKey, originalSnapshot);
      store.authorizationPermissions = originalCachedPermissions;
      store.authorizationGrantRows = originalCachedGrantRows;
      store.authorizationGrantRowsUserId = originalCachedGrantRowsUserId;
      store.data.role_permissions = originalRoleRows;
      store.scopeConfigLoaded = originalScopeLoaded;
      store.loaded = originalLoaded;
      window.__session = originalSession;

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

      window.__session.role = 'ADMIN';
      window.__session.profile.role = 'ADMIN';
      window.__session.profile.assigned_warehouse_ids = [];
      store.data.role_warehouse_scopes = [{ role_name: 'ADMIN', scope_mode: 'INHERIT', warehouse_ids: [] }];
      reset();
      applyAccessFilter();
      const adminInheritFailsClosed = store.data.warehouses.length === 0
        && accessibleWarehouseIds().length === 0 && !canAccessWarehouse(w1);

      store.scopeConfigLoaded = false;
      window.__session.role = 'MANAGER';
      window.__session.profile.role = 'MANAGER';
      reset();
      applyAccessFilter();
      const missingScopeFailsClosed = store.data.warehouses.length === 0
        && accessibleWarehouseIds().length === 0 && !canAccessWarehouse(w1);

      store.scopeConfigLoaded = true;
      window.__session.role = 'SUPER_ADMIN';
      window.__session.profile.role = 'SUPER_ADMIN';
      window.__session.profile.assigned_warehouse_ids = [w1];
      store.data.role_warehouse_scopes = [{ role_name: 'SUPER_ADMIN', scope_mode: 'SELECTED', warehouse_ids: [w1] }];
      reset();
      applyAccessFilter();
      const superAdminGlobalBreakGlass = store.data.warehouses.length === 3
        && accessibleWarehouseIds() === null && canAccessWarehouse(w3);

      return { permissionRoleContract, legacyCacheFailsClosed, selectedRole, assignmentIntersection, inheritFailsClosed, explicitAll,
        userAssignmentNarrowsAll, adminInheritFailsClosed, missingScopeFailsClosed, superAdminGlobalBreakGlass };
    });
    const scopeFailures = Object.entries(warehouseScopeChecks).filter(([, value]) => value !== true);
    if (scopeFailures.length) throw new Error('Warehouse scope checks failed: ' + JSON.stringify(warehouseScopeChecks));

    if (errors.length) throw new Error('Browser errors:\\n' + errors.join('\\n'));
    console.log("PASS: login desktop/mobile smoke; no browser errors; creator auto-approval matches database grants, per-user flag and global setting; offline policy allows ISSUE and stocktake counts only; only database manager roles can count another user session offline; master-data writes are rejected and legacy master queue is quarantined; single-warehouse scope enforced; multi-warehouse offline denied; stocktake count queued locally with BOX x12 = 24 PCS and bound to its creator; refresh/fetch-failure cache preservation; conversion conflict; corrected-factor sync exactly once; foreign-user cached snapshot rejected; role SELECTED/ALL/INHERIT scopes and user-assignment intersections enforced in UI.");
  } catch (error) {
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/failure.png', fullPage: true }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
