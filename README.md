# Movie Rating Check

A Chrome extension that shows IMDb, Rotten Tomatoes and Metacritic scores for a
movie or TV title you hover over — on any page.

Hold **Alt** (Option on macOS) and point at a title. A small tooltip appears with
the scores and a link to the IMDb page.

```
┌──────────────────────────────────┐
│ Dune                             │
│ 2021 · Movie · PG-13 · 155 min   │
│  IMDB  8.0/10  848,123 votes     │
│  RT    83%                       │
│  MC    74/100                    │
│ Open on IMDb →                   │
└──────────────────────────────────┘
```

## Install

The extension is not on the Chrome Web Store — load it unpacked.

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder.
4. The options page opens on first install. Paste an OMDb API key (next section)
   and click **Test**.

## You need a free OMDb API key

Rotten Tomatoes has no public API. The practical way to get an RT score
alongside IMDb is the [OMDb API](https://www.omdbapi.com/apikey.aspx), which
returns IMDb, Rotten Tomatoes and Metacritic in a single response.

- Request a free key at <https://www.omdbapi.com/apikey.aspx> (choose the FREE
  tier, then click the activation link in the confirmation email).
- The free tier allows **1000 requests per day**.
- Paste the key into the extension's options page. It is stored in
  `chrome.storage.sync` and is only ever sent to `omdbapi.com`.

No key is bundled with this repository, so each user spends their own quota.

## Using it

| Action | Result |
| --- | --- |
| **Alt + hover** a short piece of text | Looks it up and shows the tooltip |
| **Select** text, then Alt + hover it | Looks up exactly what you selected — use this inside paragraphs |
| **Alt + hover** box art | Falls back to the image's `alt` / `aria-label` text |
| Release Alt, press Escape, or scroll | Hides the tooltip |
| Click the toolbar icon | Toggles the extension on and off (badge shows `OFF`) |

The badge shows `KEY` until you set an API key; clicking the icon then opens the
options page instead of toggling.

### Options

- **Trigger key** — Alt, Shift or Control.
- **Hover delay** — 120 / 250 / 450 / 800 ms before a lookup fires.
- **Enabled** — same switch as the toolbar icon.
- **Include TV series** — off restricts lookups to films.
- **Clear cached ratings** — empties the local cache.

## How it works

```
content script  ──(title, year)──>  service worker  ──> omdbapi.com
   │                                     │
   │ detects what is under the cursor    │ holds the API key
   │ draws the tooltip in a shadow root  │ caches results locally
   <────────────(ratings)────────────────┘
```

- **`src/title.js`** — pure parsing. Turns raw page text into `{ title, year }`,
  or `null` when it does not look like a title. Strips `Watch `, `| Netflix`,
  `S1:E4`, `Season 4`, `4K`, and pulls out `(2021)` so it can be passed to OMDb
  as a year filter. Rejects prose, prices and bare numbers.
- **`src/content.js`** — tracks the modifier key, finds the text node under the
  cursor via `caretRangeFromPoint`, debounces, and renders the tooltip inside a
  **shadow root** so the host page's CSS cannot touch it. Honours
  `prefers-color-scheme`.
- **`src/background.js`** — the only place the API key lives and the only place
  that calls the network. Tries an exact-title lookup first, falls back to a
  search and then fetches the best match by IMDb id.
- **Caching** — `chrome.storage.local`, 7 days for a hit and 1 day for a miss,
  so repeat hovers do not spend quota.

Permissions are deliberately narrow: `storage`, plus host access to
`https://www.omdbapi.com/*` only.

## Known limitations

- **Ambiguous titles.** One result is shown, with the year displayed so you can
  see when it picked the wrong remake. Hovering `Dune (1984)` works because the
  year is parsed out; a bare `Dune` gets OMDb's default match.
- **Prose.** A title sitting inside a paragraph is not detectable on its own —
  the extension does not guess word boundaries. Select the title and the lookup
  runs on the selection.
- **Quota.** 1000 lookups a day on the OMDb free tier, softened by the cache.
- **Rotten Tomatoes coverage.** OMDb carries an RT score for most theatrical
  films but not for everything; the tooltip shows `not rated` where it is absent.
- **Canvas-rendered and cross-origin-iframe text** cannot be read.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test` — unit tests for the title parser (`node --test`, no dependencies).
- `npm run test:e2e` — Playwright suites: the hover/tooltip path against a fake
  runtime, the unpacked extension loading in Chromium, and a full round trip
  through the service worker with OMDb mocked. Chrome will not load MV3
  extensions in old headless mode, so the last two run headful under `xvfb-run`.

```bash
npm run zip
```

Builds `movie-rating-check.zip` for distribution.

## Layout

```
manifest.json          MV3 manifest
src/title.js           title parsing (shared with the tests)
src/content.js         hover detection + tooltip
src/background.js      service worker: OMDb calls, cache, on/off state
src/options.{html,css,js}
icons/                 16 / 32 / 48 / 128 px
test/title.test.js     unit tests
test/e2e/              Playwright suites
```
