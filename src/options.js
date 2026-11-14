/** Options page: reads and writes the settings the worker and content script use. */

const DEFAULTS = {
  enabled: true,
  apiKey: '',
  modifier: 'Alt',
  includeSeries: true,
  hoverDelayMs: 250,
};

const fields = {
  apiKey: document.getElementById('apiKey'),
  modifier: document.getElementById('modifier'),
  hoverDelayMs: document.getElementById('hoverDelayMs'),
  enabled: document.getElementById('enabled'),
  includeSeries: document.getElementById('includeSeries'),
};

const saveStatus = document.getElementById('saveStatus');
const keyStatus = document.getElementById('keyStatus');
const cacheStatus = document.getElementById('cacheStatus');

function setStatus(element, message, kind) {
  element.textContent = message;
  element.className = `status${kind ? ` ${kind}` : ''}`;
}

let saveTimer = null;
function flash(message) {
  setStatus(saveStatus, message, 'ok');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setStatus(saveStatus, ''), 1800);
}

/* ------------------------------------------------------------------ */
/* load                                                               */
/* ------------------------------------------------------------------ */

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  fields.apiKey.value = settings.apiKey || '';
  fields.modifier.value = settings.modifier;
  fields.hoverDelayMs.value = String(settings.hoverDelayMs);
  fields.enabled.checked = Boolean(settings.enabled);
  fields.includeSeries.checked = Boolean(settings.includeSeries);

  if (!settings.apiKey) {
    setStatus(keyStatus, 'No key set yet — the extension cannot look anything up.', 'bad');
  }
}

/* ------------------------------------------------------------------ */
/* save                                                               */
/* ------------------------------------------------------------------ */

async function save(partial) {
  await chrome.storage.sync.set(partial);
  flash('Saved.');
}

fields.apiKey.addEventListener('change', () => {
  const value = fields.apiKey.value.trim();
  save({ apiKey: value });
  setStatus(
    keyStatus,
    value ? 'Key saved. Use Test to confirm it works.' : 'Key cleared.',
    value ? '' : 'bad'
  );
});

fields.modifier.addEventListener('change', () => save({ modifier: fields.modifier.value }));
fields.hoverDelayMs.addEventListener('change', () =>
  save({ hoverDelayMs: Number(fields.hoverDelayMs.value) })
);
fields.enabled.addEventListener('change', () => save({ enabled: fields.enabled.checked }));
fields.includeSeries.addEventListener('change', () =>
  save({ includeSeries: fields.includeSeries.checked })
);

/* ------------------------------------------------------------------ */
/* show / hide the key                                                */
/* ------------------------------------------------------------------ */

const toggleKey = document.getElementById('toggleKey');
toggleKey.addEventListener('click', () => {
  const hidden = fields.apiKey.type === 'password';
  fields.apiKey.type = hidden ? 'text' : 'password';
  toggleKey.textContent = hidden ? 'Hide' : 'Show';
});

/* ------------------------------------------------------------------ */
/* test the key                                                       */
/* ------------------------------------------------------------------ */

document.getElementById('testKey').addEventListener('click', async () => {
  const key = fields.apiKey.value.trim();
  if (!key) {
    setStatus(keyStatus, 'Enter a key first.', 'bad');
    return;
  }
  setStatus(keyStatus, 'Testing…');
  try {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', key);
    url.searchParams.set('t', 'The Matrix');
    url.searchParams.set('y', '1999');

    const response = await fetch(url.toString(), { cache: 'no-store' });
    if (!response.ok) {
      setStatus(keyStatus, `OMDb returned HTTP ${response.status}.`, 'bad');
      return;
    }
    const data = await response.json();
    if (data.Response === 'True') {
      const rt = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
      setStatus(
        keyStatus,
        `Working — The Matrix (1999): IMDb ${data.imdbRating}${rt ? `, RT ${rt.Value}` : ''}.`,
        'ok'
      );
    } else {
      setStatus(keyStatus, data.Error || 'OMDb rejected the request.', 'bad');
    }
  } catch (error) {
    setStatus(keyStatus, `Request failed: ${error.message}`, 'bad');
  }
});

/* ------------------------------------------------------------------ */
/* clear cache                                                        */
/* ------------------------------------------------------------------ */

document.getElementById('clearCache').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearCache' }, (response) => {
    if (response && response.ok) {
      setStatus(cacheStatus, `Cleared ${response.removed} cached title(s).`, 'ok');
    } else {
      setStatus(cacheStatus, 'Could not clear the cache.', 'bad');
    }
  });
});

load();
