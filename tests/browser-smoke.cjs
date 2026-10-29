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
      const { store, offlineTransactionTypeAllowed, offlineWarehouseAllowed, saveStocktakeCount, queueSnapshot, loadLocal } =
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

      // A shared device must not hydrate another user's cached warehouse data.
      localStorage.setItem('orshap_wms_data_v5', JSON.stringify({
        __cached_user_id: '77777777-7777-4777-8777-777777777777',
        warehouses: [{ id: warehouseId, name: 'foreign cached warehouse' }],
        stock: [{ id: 'foreign-stock' }]
      }));
      store.data.warehouses = [{ id: warehouseId, name: 'stale in-memory warehouse' }];
      const foreignSnapshotRejected = loadLocal() === false
        && store.data.warehouses.length === 0 && store.data.stock.length === 0;

      return {
        issueAllowed, receiptDenied, assignedWarehouseAllowed, otherWarehouseDenied,
        multiWarehouseDenied, countQueued: !!saved.pending_sync && queued,
        convertedBaseQuantity: saved.counted_qty,
        queueOwnerMatches: queueRows.length === 1 && queueRows[0].user_id === userId,
        foreignSnapshotRejected
      };
    });
    const failedChecks = Object.entries(offlineChecks).filter(([key, value]) =>
      value !== true && !(key === 'convertedBaseQuantity' && value === 24)
    );
    if (failedChecks.length) throw new Error('Offline store checks failed: ' + JSON.stringify(offlineChecks));

    if (errors.length) throw new Error('Browser errors:\\n' + errors.join('\\n'));
    console.log('PASS: login desktop/mobile smoke; no browser errors; offline policy allows ISSUE only; single-warehouse scope enforced; multi-warehouse offline denied; stocktake count queued locally with BOX x12 = 24 PCS and bound to its creator; foreign-user cached snapshot rejected.');
  } catch (error) {
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/failure.png', fullPage: true }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
