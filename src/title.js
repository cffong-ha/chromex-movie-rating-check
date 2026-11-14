/**
 * Pure title-parsing helpers, shared by the content script and the unit tests.
 *
 * Loaded as the first content script, so it just hangs an object off the
 * isolated world's global. Under Node (tests) it exports via module.exports.
 */

(function (root) {
  const MIN_LENGTH = 2;
  const MAX_LENGTH = 90;
  const MAX_WORDS = 10;

  const NOISE_PATTERNS = [
    /^(watch|play|stream|rent|buy|now playing)\s+/i,
    /\b(official\s+)?trailer\b.*$/i,
    /\bs\d+\s*[:e]\s*e?\d+.*$/i, // S1:E4, S2E10
    /\bseason\s+\d+.*$/i,
    /\bepisode\s+\d+.*$/i,
    /\b(hd|4k|uhd|1080p|720p|dubbed|subtitled)\b/gi,
  ];

  /** Pull a 4-digit year out of the string and strip it from the title. */
  function extractYear(text) {
    const parenthesised = text.match(/\((19|20)\d{2}\)/);
    if (parenthesised) {
      return {
        year: parenthesised[0].slice(1, -1),
        text: text.replace(parenthesised[0], ' '),
      };
    }
    const trailing = text.match(/[\s,\-–—]((19|20)\d{2})\s*$/);
    if (trailing) {
      return { year: trailing[1], text: text.slice(0, trailing.index) };
    }
    return { year: null, text };
  }

  /**
   * Turn raw page text into { title, year }, or null when it doesn't look
   * like a title at all (a paragraph, a price, a bare number).
   */
  function cleanTitle(raw) {
    if (raw === null || raw === undefined) return null;

    let text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text) return null;

    // Drop trailing site chrome: "The Matrix | Netflix", "Dune • Prime Video".
    text = text.replace(/\s*[|·•]\s*[^|·•]{1,40}$/, '');

    for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, ' ');

    const withYear = extractYear(text);
    text = withYear.text;

    text = text
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}(]+/u, '')
      .replace(/[\s.,;:\-–—|]+$/u, '')
      .trim();

    if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return null;
    if (!/\p{L}/u.test(text)) return null; // needs at least one letter
    if (text.split(' ').length > MAX_WORDS) return null; // a sentence, not a title
    if (/[.!?]\s+\p{Lu}/u.test(text)) return null; // more than one sentence

    return { title: text, year: withYear.year };
  }

  const api = { cleanTitle, extractYear, MIN_LENGTH, MAX_LENGTH, MAX_WORDS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MRC_TITLE = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
