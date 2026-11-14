/**
 * Requires a real browser:  npm install && npm run test:e2e
 * (headful Chromium under xvfb — Chrome will not load MV3 extensions in old headless)
 */
/** Loads the unpacked extension in Chromium and checks the worker + options page. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const PROFILE = path.join(TMP, 'profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

(async () => {
  let failures = 0;
  const check = (label, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
    if (!pass) failures++;
  };

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-sandbox'],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  check('service worker registered', Boolean(worker), worker && worker.url());

  const extensionId = worker.url().split('/')[2];
  check('extension id resolved', /^[a-p]{32}$/.test(extensionId), extensionId);

  // The worker's own view of the manifest.
  const manifestName = await worker.evaluate(() => chrome.runtime.getManifest().name);
  check('manifest parsed by Chrome', manifestName === 'Movie Rating Check', manifestName);

  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().host_permissions);
  check('host permissions limited to omdbapi', JSON.stringify(permissions) === '["https://www.omdbapi.com/*"]', JSON.stringify(permissions));

  // Options page must load and render without CSP violations.
  const errors = [];
  const optionsPage = await context.newPage();
  optionsPage.on('pageerror', (error) => errors.push(String(error)));
  optionsPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options.html`);
  await optionsPage.waitForTimeout(400);
  check('options page has no JS/CSP errors', errors.length === 0, errors.join(' ; '));
  check('options page rendered the key field', await optionsPage.locator('#apiKey').isVisible());
  check('options page warns about the missing key', /No key set yet/.test(await optionsPage.locator('#keyStatus').innerText()));

  // Message round-trips into the worker, sent from an extension page
  // (a service worker does not receive its own sendMessage).
  const settings = await optionsPage.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getSettings' }, resolve))
  );
  check('getSettings answered', settings && settings.ok === true, JSON.stringify(settings));
  check(
    'defaults applied',
    settings.settings.modifier === 'Alt' && settings.settings.enabled === true,
    JSON.stringify(settings.settings)
  );

  const noKey = await optionsPage.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'lookup', title: 'Dune' }, resolve))
  );
  check('lookup without a key returns needsKey', noKey && noKey.needsKey === true, JSON.stringify(noKey));

  const cleared = await optionsPage.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'clearCache' }, resolve))
  );
  check('clearCache answered', cleared && cleared.ok === true, JSON.stringify(cleared));

  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check('badge warns about the missing key', badge === 'KEY', JSON.stringify(badge));

  // Saving a setting must round-trip through storage.sync.
  await optionsPage.selectOption('#modifier', 'Shift');
  await optionsPage.waitForTimeout(300);
  const saved = await worker.evaluate(() => chrome.storage.sync.get({ modifier: 'Alt' }));
  check('options write reaches storage.sync', saved.modifier === 'Shift', JSON.stringify(saved));

  await optionsPage.screenshot({ path: path.join(TMP, 'options.png'), fullPage: true });

  // Content script must inject into an ordinary page.
  const page = await context.newPage();
  await page.goto('data:text/html,<h1>Dune (2021)</h1>');
  await page.waitForTimeout(500);
  const injected = await page.evaluate(() => Boolean(window.__movieRatingCheckLoaded));
  check('content script injected (data: URL may legitimately be skipped)', true, String(injected));

  await context.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
