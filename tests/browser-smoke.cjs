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

    if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
    console.log('PASS: app entrypoint loads; login controls render; mobile login has no horizontal overflow; no browser JS/console errors.');
  } catch (error) {
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/failure.png', fullPage: true }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
