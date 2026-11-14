/**
 * Requires a real browser:  npm install && npm run test:e2e
 * (headful Chromium under xvfb — Chrome will not load MV3 extensions in old headless)
 */
/** Full path: real extension, real content script, real worker fetch, mocked OMDb. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const PROFILE = path.join(TMP, 'profile2');
fs.rmSync(PROFILE, { recursive: true, force: true });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Test</title>
<style>body{font:16px system-ui;padding:48px}h1{margin:0 0 24px}</style></head>
<body><h1 id="t">The Godfather</h1></body></html>`;

const OMDB_BODY = {
  Title: 'The Godfather', Year: '1972', Rated: 'R', Runtime: '175 min', Type: 'movie',
  imdbRating: '9.2', imdbVotes: '2,087,000', imdbID: 'tt0068646', Response: 'True',
  Ratings: [
    { Source: 'Internet Movie Database', Value: '9.2/10' },
    { Source: 'Rotten Tomatoes', Value: '97%' },
    { Source: 'Metacritic', Value: '100/100' },
  ],
};

(async () => {
  let failures = 0;
  const check = (label, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
    if (!pass) failures++;
  };

  /**
   * Poll for the tooltip instead of sleeping a fixed time: CI runners are
   * slower than a laptop, and a real network round trip sits in the middle.
   * Returns the tooltip text, or null if it never appeared.
   */
  const readTooltip = async (page) =>
    page.evaluate(() => {
      const host = document.querySelector('[data-movie-rating-check]');
      if (!host || host.style.display === 'none') return null;
      const card = host.shadowRoot.querySelector('.card');
      const text = card.innerText.replace(/\n+/g, ' | ');
      // The loading state is not a result; keep waiting for the real one.
      return /Looking up ratings/.test(text) ? null : text;
    });

  const waitForTooltip = async (page, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await readTooltip(page);
      if (text) return text;
      if (Date.now() > deadline) return null;
      await page.waitForTimeout(100);
    }
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((resolve) => server.listen(8731, resolve));

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-sandbox'],
  });

  let omdbRequests = 0;
  await context.route('https://www.omdbapi.com/**', (route) => {
    omdbRequests++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OMDB_BODY) });
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2];

  // Store a fake key the way the options page would.
  await worker.evaluate(() => chrome.storage.sync.set({ apiKey: 'testkey', enabled: true, hoverDelayMs: 120 }));
  await worker.evaluate(() => new Promise((r) => setTimeout(r, 200)));

  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check('badge clears once a key is set', badge === '', JSON.stringify(badge));

  const page = await context.newPage();
  await page.goto('http://localhost:8731/');
  await page.waitForTimeout(600);

  // The content script runs in an isolated world, so the page's own world cannot
  // see its flag; the tooltip host it appends to the DOM is the observable proof.
  const hasHostAfterHover = async () =>
    page.evaluate(() => Boolean(document.querySelector('[data-movie-rating-check]')));
  check('no tooltip host before any hover', (await hasHostAfterHover()) === false);

  const box = await page.locator('#t').boundingBox();
  await page.evaluate(
    ([x, y]) =>
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, altKey: true, bubbles: true })),
    [box.x + 40, box.y + box.height / 2]
  );
  const text = await waitForTooltip(page);
  check('content script injected on an http page', await hasHostAfterHover());
  check('tooltip appeared from a real worker fetch', Boolean(text), text);
  check('IMDb rating from OMDb shown', /9\.2\/10/.test(text || ''), text);
  check('Rotten Tomatoes score shown', /97%/.test(text || ''), text);
  check('Metacritic score shown', /100\/100/.test(text || ''), text);
  check('worker actually called OMDb', omdbRequests >= 1, `${omdbRequests} request(s)`);

  await page.screenshot({ path: path.join(TMP, 'e2e-tooltip.png') });

  // Second hover on the same title must be served from cache.
  const before = omdbRequests;
  await page.reload();
  await page.waitForTimeout(600);
  await page.evaluate(
    ([x, y]) =>
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, altKey: true, bubbles: true })),
    [box.x + 40, box.y + box.height / 2]
  );
  const cachedText = await waitForTooltip(page);
  check('cached lookup still renders the tooltip', Boolean(cachedText), cachedText);
  check('second lookup served from cache (no new OMDb call)', omdbRequests === before, `${omdbRequests - before} extra request(s)`);

  // Disabling via the toolbar icon must stop the tooltip.
  await worker.evaluate(() => chrome.storage.sync.set({ enabled: false }));
  await page.reload();
  await page.waitForTimeout(600);
  await page.evaluate(
    ([x, y]) =>
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, altKey: true, bubbles: true })),
    [box.x + 40, box.y + box.height / 2]
  );
  await page.waitForTimeout(900);
  const whenDisabled = await page.evaluate(() => {
    const host = document.querySelector('[data-movie-rating-check]');
    return !host || host.style.display === 'none';
  });
  check('no tooltip while disabled', whenDisabled);

  await context.close();
  server.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
