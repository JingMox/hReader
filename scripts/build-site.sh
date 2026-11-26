#!/usr/bin/env bash
# 重新生成 GitHub Pages 示例库：给 site/examples/*.html 补块 id、套 atelier-editorial 主题、检查禁用词。
# 用法：bash scripts/build-site.sh [--shots]
#   --shots  额外用本机 Google Chrome 重新截取 site/img/compare.png（需先 pnpm -C packages/cli build）。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cli="$root/packages/cli/dist/cli.mjs"
examples="$root/site/examples"

if [ ! -f "$cli" ]; then
  echo "build-site: 找不到 $cli，先运行 pnpm -C packages/cli build" >&2
  exit 1
fi

for doc in "$examples"/*.html; do
  name="$(basename "$doc")"
  (cd "$examples" && node "$cli" normalize "$name" --write --json >/dev/null)
  (cd "$examples" && node "$cli" style "$name" --visual atelier-editorial --json >/dev/null)
  (cd "$examples" && node "$cli" style "$name" --lint)
  echo "build-site: $name 已更新"
done

if [ "${1:-}" = "--shots" ]; then
  chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ ! -x "$chrome" ]; then
    echo "build-site: 没找到 Google Chrome，跳过截图" >&2
    exit 1
  fi
  "$chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size=1800,1320 \
    --screenshot="$root/site/img/compare.png" "file://$root/site/compare/index.html" >/dev/null 2>&1
  echo "build-site: site/img/compare.png 已更新"
fi
