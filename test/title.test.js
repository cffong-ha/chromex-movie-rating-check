/**
 * Unit tests for the title parser.  Run with:  node --test
 */

const test = require('node:test');
const assert = require('node:assert');

const { cleanTitle, extractYear } = require('../src/title.js');

test('keeps a plain title untouched', () => {
  assert.deepStrictEqual(cleanTitle('The Matrix'), { title: 'The Matrix', year: null });
});

test('pulls a parenthesised year out of the title', () => {
  assert.deepStrictEqual(cleanTitle('Dune (2021)'), { title: 'Dune', year: '2021' });
});

test('pulls a trailing year out of the title', () => {
  assert.deepStrictEqual(cleanTitle('Dune, 1984'), { title: 'Dune', year: '1984' });
});

test('strips call-to-action prefixes', () => {
  assert.deepStrictEqual(cleanTitle('Watch Inception'), { title: 'Inception', year: null });
});

test('strips trailing site names', () => {
  assert.deepStrictEqual(cleanTitle('The Matrix | Netflix'), { title: 'The Matrix', year: null });
  assert.deepStrictEqual(cleanTitle('Dune • Prime Video'), { title: 'Dune', year: null });
});

test('strips season and episode markers', () => {
  assert.deepStrictEqual(cleanTitle('Breaking Bad S1:E4 Cancer Man'), {
    title: 'Breaking Bad',
    year: null,
  });
  assert.deepStrictEqual(cleanTitle('Stranger Things Season 4'), {
    title: 'Stranger Things',
    year: null,
  });
});

test('strips quality tags', () => {
  assert.deepStrictEqual(cleanTitle('Oppenheimer 4K'), { title: 'Oppenheimer', year: null });
});

test('keeps punctuation that belongs to the title', () => {
  assert.deepStrictEqual(cleanTitle('Spider-Man: Across the Spider-Verse'), {
    title: 'Spider-Man: Across the Spider-Verse',
    year: null,
  });
});

test('keeps non-ASCII titles', () => {
  assert.deepStrictEqual(cleanTitle('Amélie'), { title: 'Amélie', year: null });
});

test('keeps titles that start with a number', () => {
  assert.deepStrictEqual(cleanTitle('12 Angry Men'), { title: '12 Angry Men', year: null });
});

test('normalises surrounding whitespace', () => {
  assert.deepStrictEqual(cleanTitle('\n  Parasite \t '), { title: 'Parasite', year: null });
});

test('rejects things that are not titles', () => {
  for (const input of [
    '',
    '   ',
    null,
    undefined,
    '$14.99',
    '2024',
    '42',
    'Hello. World Is Nice',
    'This is a long paragraph of prose that goes on and on and should not be a title at all.',
    'a'.repeat(120),
  ]) {
    assert.strictEqual(cleanTitle(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test('extractYear leaves year-free text alone', () => {
  assert.deepStrictEqual(extractYear('Heat'), { year: null, text: 'Heat' });
});

test('extractYear ignores numbers that are not plausible years', () => {
  assert.strictEqual(extractYear('Catch 22').year, null);
});
