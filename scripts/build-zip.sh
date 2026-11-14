#!/usr/bin/env bash
# Builds the loadable extension zip into dist/.
# Only the files Chrome needs go in — no tests, no README, no package.json.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/movie-rating-check.zip
zip -rqX dist/movie-rating-check.zip manifest.json src icons
echo "built dist/movie-rating-check.zip ($(wc -c < dist/movie-rating-check.zip) bytes)"
