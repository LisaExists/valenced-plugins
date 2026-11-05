#!/usr/bin/env bash
# Publish the static frontend under /website so the Pages root remains the repository index.
set -euo pipefail

# shellcheck source=.github/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SITE_ROOT="${SITE_ROOT:-site}"
if [ ! -d "$SITE_ROOT" ]; then
    echo "::error::site directory not found: $SITE_ROOT"
    exit 1
fi

WEBSITE_ROOT="$POOL_CHECKOUT/website"
mkdir -p "$WEBSITE_ROOT/assets"

cp "$SITE_ROOT/index.html" "$WEBSITE_ROOT/index.html"
cp "$SITE_ROOT/styles.css" "$WEBSITE_ROOT/styles.css"
cp "$SITE_ROOT/app.js" "$WEBSITE_ROOT/app.js"
cp -R "$SITE_ROOT/assets/." "$WEBSITE_ROOT/assets/"

# Older versions published the frontend at the Pages root. Remove those files so
# / continues to resolve to the generated index.json expected by Valenced.
rm -f "$POOL_CHECKOUT/index.html" "$POOL_CHECKOUT/styles.css" "$POOL_CHECKOUT/app.js"

# Preserve GitHub Pages static-file handling for the pool and generated index.
touch "$POOL_CHECKOUT/.nojekyll"

git -C "$POOL_CHECKOUT" add -A
commit_pool "GitHub Pages frontend already up to date." "Publish GitHub Pages frontend under /website"
