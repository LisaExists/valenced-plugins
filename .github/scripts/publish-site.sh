#!/usr/bin/env bash
# Publish the static frontend beside index.json and the artifact pool.
set -euo pipefail

# shellcheck source=.github/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SITE_ROOT="${SITE_ROOT:-site}"
if [ ! -d "$SITE_ROOT" ]; then
    echo "::error::site directory not found: $SITE_ROOT"
    exit 1
fi

# Copy only frontend files. Keep index.json and pool/ generated from the actual releases.
cp "$SITE_ROOT/index.html" "$POOL_CHECKOUT/index.html"
cp "$SITE_ROOT/styles.css" "$POOL_CHECKOUT/styles.css"
cp "$SITE_ROOT/app.js" "$POOL_CHECKOUT/app.js"
mkdir -p "$POOL_CHECKOUT/assets"
cp -R "$SITE_ROOT/assets/." "$POOL_CHECKOUT/assets/"
touch "$POOL_CHECKOUT/.nojekyll"

git -C "$POOL_CHECKOUT" add index.html styles.css app.js assets .nojekyll
commit_pool "GitHub Pages frontend already up to date." "Publish GitHub Pages frontend"
