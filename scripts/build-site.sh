#!/usr/bin/env bash
# Regenerates the GitHub Pages sample library: adds block ids to site/examples/*.html,
# applies the atelier-editorial theme, and checks banned words. Usage: build-site.sh [--shots]
#   --shots  also re-captures site/img/compare.png with Chrome (requires pnpm -C packages/cli build).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cli="$root/packages/cli/dist/cli.mjs"
examples="$root/site/examples"

if [ ! -f "$cli" ]; then
  echo "build-site: $cli not found; run pnpm -C packages/cli build first" >&2
  exit 1
fi

for doc in "$examples"/*.html; do
  name="$(basename "$doc")"
  (cd "$examples" && node "$cli" normalize "$name" --write --json >/dev/null)
  (cd "$examples" && node "$cli" style "$name" --visual atelier-editorial --json >/dev/null)
  (cd "$examples" && node "$cli" style "$name" --lint)
  echo "build-site: $name updated"
done

if [ "${1:-}" = "--shots" ]; then
  chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ ! -x "$chrome" ]; then
    echo "build-site: Google Chrome not found; skipping screenshots" >&2
    exit 1
  fi
  "$chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size=1800,1320 \
    --screenshot="$root/site/img/compare.png" "file://$root/site/compare/index.html" >/dev/null 2>&1
  echo "build-site: site/img/compare.png updated"
fi
