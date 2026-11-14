/**
 * Service worker: owns the OMDb API key, performs all network calls, caches
 * results, and tracks the enabled/disabled state behind the toolbar icon.
 *
 * The content script never sees the API key and never makes a cross-origin
 * request itself.
 */

const OMDB_ENDPOINT = 'https://www.omdbapi.com/';

const CACHE_PREFIX = 'cache:';
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for a found title
const MISS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day for "no such title"

const DEFAULT_SETTINGS = {
  enabled: true,
  apiKey: '',
  modifier: 'Alt', // 'Alt' | 'Shift' | 'Control'
  includeSeries: true,
  hoverDelayMs: 250,
};

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

/* ------------------------------------------------------------------ */
/* cache                                                               */
/* ------------------------------------------------------------------ */

function cacheKey(title, year, includeSeries) {
  return `${CACHE_PREFIX}${includeSeries ? 'any' : 'movie'}|${title.toLowerCase()}|${year || ''}`;
}

async function cacheGet(key) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;
  const ttl = entry.payload && entry.payload.notFound ? MISS_TTL_MS : HIT_TTL_MS;
  if (Date.now() - entry.savedAt > ttl) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.payload;
}

async function cacheSet(key, payload) {
  await chrome.storage.local.set({ [key]: { savedAt: Date.now(), payload } });
}

/* ------------------------------------------------------------------ */
/* OMDb                                                                */
/* ------------------------------------------------------------------ */

async function omdb(params, apiKey) {
  const url = new URL(OMDB_ENDPOINT);
  url.searchParams.set('apikey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), { method: 'GET', cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'OMDb rejected the API key (401). Check it in the extension options.'
        : `OMDb returned HTTP ${response.status}.`
    );
  }
  return response.json();
}

/** Pick the search result that best matches what the user hovered. */
function pickBestMatch(results, title, year) {
  const wanted = title.toLowerCase();
  const scored = results.map((item) => {
    let score = 0;
    const name = (item.Title || '').toLowerCase();
    if (name === wanted) score += 100;
    else if (name.startsWith(wanted) || wanted.startsWith(name)) score += 50;
    if (year && item.Year && String(item.Year).startsWith(String(year))) score += 40;
    if (item.Type === 'movie') score += 5; // tie-break toward films
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].item;
}

/** Flatten an OMDb record into just what the tooltip needs. */
function shapeResult(data) {
  const ratings = {};
  for (const entry of data.Ratings || []) {
    if (entry.Source === 'Rotten Tomatoes') ratings.rottenTomatoes = entry.Value;
    if (entry.Source === 'Metacritic') ratings.metacritic = entry.Value;
  }
  return {
    title: data.Title,
    year: data.Year,
    type: data.Type, // 'movie' | 'series' | 'episode'
    rated: data.Rated && data.Rated !== 'N/A' ? data.Rated : null,
    runtime: data.Runtime && data.Runtime !== 'N/A' ? data.Runtime : null,
    imdbId: data.imdbID,
    imdbRating: data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null,
    imdbVotes: data.imdbVotes && data.imdbVotes !== 'N/A' ? data.imdbVotes : null,
    rottenTomatoes: ratings.rottenTomatoes || null,
    metacritic: ratings.metacritic || null,
  };
}

async function resolveTitle(title, year, settings) {
  const type = settings.includeSeries ? '' : 'movie';

  // 1. Exact-title lookup — one request, returns full ratings.
  let data = await omdb({ t: title, y: year, type, plot: 'short' }, settings.apiKey);

  // 2. Fall back to a search, then fetch the best hit by IMDb id.
  if (data.Response === 'False' && !/limit reached/i.test(data.Error || '')) {
    const search = await omdb({ s: title, y: year, type }, settings.apiKey);
    if (search.Response === 'True' && Array.isArray(search.Search) && search.Search.length) {
      const best = pickBestMatch(search.Search, title, year);
      data = await omdb({ i: best.imdbID, plot: 'short' }, settings.apiKey);
    }
  }

  if (data.Response === 'False') {
    if (/limit reached/i.test(data.Error || '')) {
      throw new Error('OMDb daily request limit reached (1000/day on the free tier).');
    }
    return { notFound: true, query: title };
  }
  return shapeResult(data);
}

/* ------------------------------------------------------------------ */
/* toolbar icon = on/off switch                                        */
/* ------------------------------------------------------------------ */

async function paintBadge() {
  const { enabled, apiKey } = await getSettings();
  if (!apiKey) {
    await chrome.action.setBadgeText({ text: 'KEY' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
    return;
  }
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
}

chrome.action.onClicked.addListener(async () => {
  const { enabled, apiKey } = await getSettings();
  // Nothing works without a key, so send a first-time user straight there.
  if (!apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.storage.sync.set({ enabled: !enabled });
  await paintBadge();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await paintBadge();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(paintBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && ('enabled' in changes || 'apiKey' in changes)) paintBadge();
});

/* ------------------------------------------------------------------ */
/* messages from the content script                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'getSettings') {
        // Content scripts run inside every page the user visits, so they get
        // the settings minus the key. Only this worker ever uses the key.
        const { apiKey, ...publicSettings } = await getSettings();
        sendResponse({ ok: true, settings: { ...publicSettings, hasKey: Boolean(apiKey) } });
        return;
      }

      if (message.type === 'lookup') {
        const settings = await getSettings();
        if (!settings.enabled) {
          sendResponse({ ok: false, error: 'Extension is disabled.' });
          return;
        }
        if (!settings.apiKey) {
          sendResponse({ ok: false, needsKey: true, error: 'No OMDb API key set.' });
          return;
        }

        const { title, year } = message;
        const key = cacheKey(title, year, settings.includeSeries);

        const cached = await cacheGet(key);
        if (cached) {
          sendResponse({ ok: true, result: cached, cached: true });
          return;
        }

        const result = await resolveTitle(title, year, settings);
        await cacheSet(key, result);
        sendResponse({ ok: true, result });
        return;
      }

      if (message.type === 'openOptions') {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'clearCache') {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
        await chrome.storage.local.remove(keys);
        sendResponse({ ok: true, removed: keys.length });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();

  return true; // keep the channel open for the async reply
});
