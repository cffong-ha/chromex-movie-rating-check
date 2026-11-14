/**
 * Fails if dist/movie-rating-check.zip has drifted from the sources.
 *
 * A committed binary can silently go stale, so CI compares the hash of every
 * file inside the zip against the file in the working tree, and checks that
 * the zip holds exactly the expected set.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const zipPath = join(root, 'dist', 'movie-rating-check.zip');

if (!existsSync(zipPath)) {
  console.error('dist/movie-rating-check.zip is missing. Run: npm run build');
  process.exit(1);
}

/** Every file Chrome loads, taken from the working tree. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

const expected = ['manifest.json', ...walk(join(root, 'src')), ...walk(join(root, 'icons'))].sort();

const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.endsWith('/'))
  .sort();

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

let failures = 0;
const fail = (message) => {
  console.error(`  ✗ ${message}`);
  failures++;
};

for (const missing of expected.filter((f) => !listing.includes(f))) {
  fail(`missing from the zip: ${missing}`);
}
for (const extra of listing.filter((f) => !expected.includes(f))) {
  fail(`unexpected file in the zip: ${extra}`);
}

for (const file of expected.filter((f) => listing.includes(f))) {
  const inZip = execFileSync('unzip', ['-p', zipPath, file], { maxBuffer: 32 * 1024 * 1024 });
  const onDisk = readFileSync(join(root, file));
  if (sha(inZip) !== sha(onDisk)) fail(`stale in the zip: ${file}`);
}

if (failures) {
  console.error(`\ndist/movie-rating-check.zip is out of date (${failures} problem(s)).`);
  console.error('Rebuild it and commit the result:  npm run build');
  process.exit(1);
}

console.log(`dist/movie-rating-check.zip matches the sources (${expected.length} files).`);
