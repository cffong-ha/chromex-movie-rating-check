/**
 * Requires a real browser:  npm install && npm run test:e2e
 * (headful Chromium under xvfb — Chrome will not load MV3 extensions in old headless)
 */
/**
 * Drives the real content script in Chromium against a fake `chrome` runtime,
 * so the hover -> detect -> tooltip path is exercised without an OMDb key.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = path.join(REPO, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const titleJs = fs.readFileSync(path.join(REPO, 'src/title.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(REPO, 'src/content.js'), 'utf8');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 16px system-ui; padding: 40px; }
  .card { display:inline-block; width: 180px; margin: 0 16px 16px 0; }
  .card img { width: 180px; height: 100px; background: #345; display:block; }
  .caption { padding: 6px 0; font-weight: 600; }
  p.prose { max-width: 520px; }
</style></head><body>
  <h1 id="h1">Dune (2021)</h1>
  <div class="card"><img id="art" alt="Watch The Matrix | Netflix" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="><div class="caption" id="cap">Everything Everywhere All at Once</div></div>
  <p class="prose" id="prose">A long paragraph of ordinary prose that mentions Parasite somewhere in the middle and should not trigger a lookup by itself.</p>
</body></html>`;

const FAKE_CHROME = `
window.__lookups = [];
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      if (message.type === 'getSettings') {
        callback({ ok: true, settings: { enabled: true, hasKey: true, modifier: 'Alt', includeSeries: true, hoverDelayMs: 120 } });
        return;
      }
      if (message.type === 'lookup') {
        window.__lookups.push(message);
        const canned = {
          'Dune': { title: 'Dune', year: '2021', type: 'movie', rated: 'PG-13', runtime: '155 min', imdbId: 'tt1160419', imdbRating: '8.0', imdbVotes: '848,123', rottenTomatoes: '83%', metacritic: '74/100' },
          'The Matrix': { title: 'The Matrix', year: '1999', type: 'movie', rated: 'R', runtime: '136 min', imdbId: 'tt0133093', imdbRating: '8.7', imdbVotes: '2,059,000', rottenTomatoes: '83%', metacritic: '73/100' },
          'Everything Everywhere All at Once': { title: 'Everything Everywhere All at Once', year: '2022', type: 'movie', rated: 'R', runtime: '139 min', imdbId: 'tt6710474', imdbRating: '7.8', imdbVotes: '500,000', rottenTomatoes: '93%', metacritic: '81/100' },
        }[message.title];
        setTimeout(() => callback(canned ? { ok: true, result: canned } : { ok: true, result: { notFound: true, query: message.title } }), 5);
        return;
      }
      callback({ ok: true });
    },
  },
  storage: { onChanged: { addListener() {} } },
};
`;

function tooltipState() {
  const host = document.querySelector('[data-movie-rating-check]');
  if (!host || host.style.display === 'none') return { visible: false };
  const card = host.shadowRoot.querySelector('.card');
  return { visible: true, text: card.innerText.replace(/\n+/g, ' | ') };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(PAGE);
  await page.addScriptTag({ content: FAKE_CHROME });
  await page.addScriptTag({ content: titleJs });
  await page.addScriptTag({ content: contentJs });
  await page.waitForTimeout(100);

  let failures = 0;
  const check = (label, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
    if (!pass) failures++;
  };

  async function hover(selector, { alt = true } = {}) {
    const box = await page.locator(selector).boundingBox();
    const x = box.x + Math.min(40, box.width / 2);
    const y = box.y + box.height / 2;
    await page.evaluate(
      ([x, y, alt]) => {
        document.dispatchEvent(
          new MouseEvent('mousemove', { clientX: x, clientY: y, altKey: alt, bubbles: true })
        );
      },
      [x, y, alt]
    );
    await page.waitForTimeout(260);
    return page.evaluate(tooltipState);
  }

  // 1. heading with a parenthesised year
  let state = await hover('#h1');
  check('Alt+hover heading shows tooltip', state.visible, state.text);
  check('heading resolved to Dune/2021', /Dune/.test(state.text || '') && /2021/.test(state.text || ''), state.text);
  check('tooltip shows IMDb score', /8\.0\/10/.test(state.text || ''), state.text);
  check('tooltip shows RT score', /83%/.test(state.text || ''), state.text);
  check('tooltip shows Metacritic score', /74\/100/.test(state.text || ''), state.text);

  let lookups = await page.evaluate(() => window.__lookups);
  check('year passed to the lookup', lookups[0] && lookups[0].year === '2021', JSON.stringify(lookups[0]));

  // 2. a card caption
  state = await hover('#cap');
  check('caption resolves', /Everything Everywhere/.test(state.text || ''), state.text);
  check('caption shows RT 93%', /93%/.test(state.text || ''), state.text);

  // 3. box art alt text, with noise to strip
  state = await hover('#art');
  check('img alt resolves to The Matrix', /The Matrix/.test(state.text || ''), state.text);
  check('matrix IMDb score shown', /8\.7\/10/.test(state.text || ''), state.text);

  // 4. prose must NOT trigger
  state = await hover('#prose');
  check('long prose does not trigger a tooltip', !state.visible, JSON.stringify(state));

  // 5. selection inside prose SHOULD work
  await page.evaluate(() => {
    const node = document.getElementById('prose').firstChild;
    const index = node.textContent.indexOf('Parasite');
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 'Parasite'.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  state = await hover('#prose');
  check('selected text in prose triggers a lookup', state.visible && /Parasite/.test(state.text || ''), state.text);
  check('unknown title reports no match', /No match on IMDb/.test(state.text || ''), state.text);

  await page.evaluate(() => window.getSelection().removeAllRanges());

  // 6. hover without the modifier must do nothing
  await page.evaluate(() => {
    const host = document.querySelector('[data-movie-rating-check]');
    if (host) host.style.display = 'none';
  });
  state = await hover('#h1', { alt: false });
  check('hover without Alt does nothing', !state.visible, JSON.stringify(state));

  // 7. screenshot of the real tooltip for a visual check
  await hover('#h1');
  await page.screenshot({ path: path.join(TMP, 'tooltip-light.png') });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => (document.body.style.background = '#0d1117'));
  await page.evaluate(() => (document.body.style.color = '#e6edf3'));
  await page.evaluate(() => {
    const host = document.querySelector('[data-movie-rating-check]');
    if (host) host.style.display = 'none';
  });
  await hover('#cap');
  await page.screenshot({ path: path.join(TMP, 'tooltip-dark.png') });

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
