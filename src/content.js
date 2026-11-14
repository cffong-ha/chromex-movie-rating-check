/**
 * Content script: watches for "modifier key held + hovering text", works out
 * what title is under the cursor, asks the service worker for ratings, and
 * draws a tooltip inside a shadow root so the host page's CSS can't touch it.
 */

(() => {
  if (window.__movieRatingCheckLoaded) return;
  window.__movieRatingCheckLoaded = true;

  const MAX_TEXT_NODE_LENGTH = 100; // longer than this and we need a selection

  let settings = {
    enabled: true,
    modifier: 'Alt',
    includeSeries: true,
    hoverDelayMs: 250,
  };

  let hoverTimer = null;
  let lastQuery = null; // the title string currently shown / in flight
  let requestToken = 0;
  let pointer = { x: 0, y: 0 };

  // Provided by src/title.js, which the manifest loads before this file.
  const cleanTitle = (raw) => globalThis.MRC_TITLE.cleanTitle(raw);

  /* ---------------------------------------------------------------- */
  /* settings                                                          */
  /* ---------------------------------------------------------------- */

  chrome.runtime.sendMessage({ type: 'getSettings' }, (response) => {
    if (response && response.ok) settings = response.settings;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === 'apiKey') continue; // the key stays in the service worker
      settings[key] = newValue;
    }
    if (!settings.enabled) hideTooltip();
  });

  /* ---------------------------------------------------------------- */
  /* title extraction                                                  */
  /* ---------------------------------------------------------------- */

  /** The text node directly under the cursor, if the browser can tell us. */
  function textNodeAt(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position) return position.offsetNode;
    }
    return range ? range.startContainer : null;
  }

  function currentSelectionText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const text = selection.toString().trim();
    return text ? text : null;
  }

  /**
   * Decide what the user is pointing at. Priority:
   *   1. a non-empty text selection (works inside long prose)
   *   2. the text node under the cursor, if it is short enough to be a title
   *   3. alt / aria-label / title attributes (streaming-service box art)
   */
  function candidateAt(x, y) {
    const selected = currentSelectionText();
    if (selected) return cleanTitle(selected);

    const node = textNodeAt(x, y);
    if (node && node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent.trim();
      if (content.length && content.length <= MAX_TEXT_NODE_LENGTH) {
        const cleaned = cleanTitle(content);
        if (cleaned) return cleaned;
      }
    }

    const element = document.elementFromPoint(x, y);
    if (!element) return null;

    const labelled = element.closest('img[alt], [aria-label], [title], [data-title]');
    if (labelled) {
      const label =
        labelled.getAttribute('alt') ||
        labelled.getAttribute('aria-label') ||
        labelled.getAttribute('title') ||
        labelled.getAttribute('data-title');
      const cleaned = cleanTitle(label);
      if (cleaned) return cleaned;
    }

    // A short, leaf-ish element (a card caption, a link) is a decent guess.
    const text = (element.textContent || '').trim();
    if (text && text.length <= MAX_TEXT_NODE_LENGTH && element.children.length <= 1) {
      return cleanTitle(text);
    }

    return null;
  }

  /* ---------------------------------------------------------------- */
  /* tooltip                                                           */
  /* ---------------------------------------------------------------- */

  const TOOLTIP_CSS = `
    :host { all: initial; }
    .card {
      pointer-events: auto;
      box-sizing: border-box;
      min-width: 210px;
      max-width: 320px;
      padding: 10px 12px;
      border-radius: 10px;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #ffffff;
      color: #111827;
      border: 1px solid rgba(0, 0, 0, 0.1);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
    }
    .title { font-weight: 600; font-size: 13.5px; margin: 0 0 2px; }
    .meta { font-size: 11.5px; color: #6b7280; margin: 0 0 8px; }
    .scores { display: flex; flex-direction: column; gap: 5px; }
    .score { display: flex; align-items: baseline; gap: 7px; }
    .tag {
      flex: 0 0 auto;
      min-width: 34px;
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-align: center;
      text-transform: uppercase;
      color: #111827;
    }
    .tag.imdb { background: #f5c518; }
    .tag.rt   { background: #fa320a; color: #ffffff; }
    .tag.mc   { background: #ffcc33; }
    .value { font-weight: 600; }
    .votes { font-size: 11px; color: #6b7280; font-weight: 400; }
    .muted { color: #6b7280; font-weight: 400; }
    .footer { margin: 8px 0 0; font-size: 11.5px; }
    .footer a { color: #2563eb; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    .state { color: #6b7280; }
    .error { color: #b91c1c; }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #1f2328;
        color: #e6edf3;
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      }
      .meta, .votes, .muted, .state { color: #9aa4b2; }
      .footer a { color: #6cb6ff; }
      .error { color: #ff7b72; }
    }
  `;

  let host = null;
  let shadow = null;
  let card = null;

  function ensureTooltip() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-movie-rating-check', '');
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'top: 0',
      'left: 0',
      'z-index: 2147483647',
      'pointer-events: none',
      'display: none',
    ].join(';');

    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOOLTIP_CSS;
    card = document.createElement('div');
    card.className = 'card';
    shadow.append(style, card);

    // Let the pointer rest on the card itself (to click the IMDb link).
    card.addEventListener('mouseleave', hideTooltip);

    document.documentElement.appendChild(host);
  }

  function positionTooltip(x, y) {
    const offset = 14;
    const rect = card.getBoundingClientRect();
    let left = x + offset;
    let top = y + offset;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - offset;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - offset;
    host.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }

  function showTooltip(html, x, y) {
    ensureTooltip();
    card.innerHTML = html;
    host.style.display = 'block';
    positionTooltip(x, y);
  }

  function hideTooltip() {
    if (host) host.style.display = 'none';
    lastQuery = null;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function renderLoading(title) {
    return `<p class="title">${escapeHtml(title)}</p><p class="state">Looking up ratings…</p>`;
  }

  function renderResult(result) {
    const typeLabel =
      result.type === 'series' ? 'TV series' : result.type === 'episode' ? 'Episode' : 'Movie';
    const meta = [result.year, typeLabel, result.rated, result.runtime].filter(Boolean);

    const rows = [];
    rows.push(
      scoreRow(
        'imdb',
        'IMDb',
        result.imdbRating ? `${result.imdbRating}/10` : null,
        result.imdbVotes ? `${result.imdbVotes} votes` : null
      )
    );
    rows.push(scoreRow('rt', 'RT', result.rottenTomatoes, null));
    if (result.metacritic) rows.push(scoreRow('mc', 'MC', result.metacritic, null));

    const link = result.imdbId
      ? `<p class="footer"><a href="https://www.imdb.com/title/${encodeURIComponent(
          result.imdbId
        )}/" target="_blank" rel="noreferrer noopener">Open on IMDb →</a></p>`
      : '';

    return [
      `<p class="title">${escapeHtml(result.title)}</p>`,
      `<p class="meta">${escapeHtml(meta.join(' · '))}</p>`,
      `<div class="scores">${rows.join('')}</div>`,
      link,
    ].join('');
  }

  function scoreRow(className, label, value, extra) {
    const body = value
      ? `<span class="value">${escapeHtml(value)}</span>${
          extra ? ` <span class="votes">${escapeHtml(extra)}</span>` : ''
        }`
      : '<span class="muted">not rated</span>';
    return `<div class="score"><span class="tag ${className}">${label}</span>${body}</div>`;
  }

  function renderNotFound(title) {
    return `<p class="title">${escapeHtml(title)}</p><p class="state">No match on IMDb.</p>`;
  }

  function renderError(message, needsKey) {
    const action = needsKey
      ? '<p class="footer"><a href="#" data-open-options>Open extension options →</a></p>'
      : '';
    return `<p class="error">${escapeHtml(message)}</p>${action}`;
  }

  /* ---------------------------------------------------------------- */
  /* lookup flow                                                       */
  /* ---------------------------------------------------------------- */

  function modifierHeld(event) {
    if (settings.modifier === 'Shift') return event.shiftKey;
    if (settings.modifier === 'Control') return event.ctrlKey;
    return event.altKey;
  }

  function runLookup(candidate, x, y) {
    const token = ++requestToken;
    lastQuery = candidate.title;
    showTooltip(renderLoading(candidate.title), x, y);

    chrome.runtime.sendMessage(
      { type: 'lookup', title: candidate.title, year: candidate.year },
      (response) => {
        if (token !== requestToken) return; // a newer hover won
        if (chrome.runtime.lastError) {
          showTooltip(renderError('Extension was reloaded — refresh the page.'), x, y);
          return;
        }
        if (!response) {
          showTooltip(renderError('No response from the extension.'), x, y);
          return;
        }
        if (!response.ok) {
          if (response.error === 'Extension is disabled.') {
            hideTooltip();
            return;
          }
          showTooltip(renderError(response.error, response.needsKey), x, y);
          wireOptionsLink();
          return;
        }
        if (response.result.notFound) {
          showTooltip(renderNotFound(candidate.title), x, y);
          return;
        }
        showTooltip(renderResult(response.result), x, y);
      }
    );
  }

  function wireOptionsLink() {
    const link = card && card.querySelector('[data-open-options]');
    if (!link) return;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: 'openOptions' });
    });
  }

  function scheduleLookup(x, y) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const candidate = candidateAt(x, y);
      if (!candidate) {
        hideTooltip();
        return;
      }
      if (candidate.title === lastQuery) {
        positionTooltip(x, y);
        return;
      }
      runLookup(candidate, x, y);
    }, Math.max(80, Number(settings.hoverDelayMs) || 250));
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  function insideTooltip(target) {
    return host && (target === host || host.contains(target));
  }

  document.addEventListener(
    'mousemove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!settings.enabled) return;
      if (insideTooltip(event.target)) return;

      if (!modifierHeld(event)) {
        clearTimeout(hoverTimer);
        if (lastQuery) hideTooltip();
        return;
      }
      scheduleLookup(event.clientX, event.clientY);
    },
    { passive: true, capture: true }
  );

  // Pressing the modifier while the mouse is already still should also fire.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!settings.enabled) return;
      if (event.key !== settings.modifier) return;
      scheduleLookup(pointer.x, pointer.y);
    },
    { passive: true, capture: true }
  );

  document.addEventListener(
    'keyup',
    (event) => {
      if (event.key === settings.modifier || event.key === 'Escape') {
        clearTimeout(hoverTimer);
        hideTooltip();
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    'scroll',
    () => {
      clearTimeout(hoverTimer);
      hideTooltip();
    },
    { passive: true, capture: true }
  );

  window.addEventListener('blur', hideTooltip);
})();
