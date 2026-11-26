#!/usr/bin/env bash
# 不给 `--home`（双击 .app 的主路径）时，壳只用应用私有目录，绝不碰用户的 ~/.hreader。
set -u
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"
require_app

root=$(mktemp_root hr-default-home) || exit 1
echo "root=$root"
make_dirs "$root"
make_cli_shim "$root/hr"
shell_store="$HOME/Library/Application Support/com.hreader.desktop"
# 本脚本故意用真实壳 app data：它会被下面整个删掉，跑之前备份、确认没有在跑实例。
[ "${HREADER_GUI_REAL_HOME:-}" = "1" ] || { echo "本脚本会删真实壳数据目录 ${shell_store}；确认后以 HREADER_GUI_REAL_HOME=1 重跑" >&2; exit 1; }
rm -rf "$shell_store"
snapshot() { if [ -d "$HOME/.hreader" ]; then ls -la "$HOME/.hreader" | md5; else echo absent; fi; }
before=$(snapshot)
echo "user_store_before=$before"
"$APP_BIN" --workspace "$root/ws" --open "$root/ws/doc.html" --cli-path "$root/hr" \
  > "$root/app.out" 2> "$root/app.err" < /dev/null &
app=$!
json="$shell_store/.hreader/daemon.json"
for _ in $(seq 1 80); do [ -f "$json" ] && break; sleep 0.25; done
if [ ! -f "$json" ]; then echo "shell_store=MISSING($json)"; head -3 "$root/app.err"; kill -9 "$app"; exit 1; fi
daemon=$(field_of "$json" pid)
echo "app=$app daemon=$daemon shell_store=$json workspace=$(field_of "$json" workspace)"
echo "user_store_untouched=$([ "$before" = "$(snapshot)" ] && echo yes || echo NO)"
kill -TERM "$app"
for _ in $(seq 1 40); do [ "$(alive "$daemon")" = no ] && break; sleep 0.25; done
echo "AFTER SIGTERM -> daemon_alive=$(alive "$daemon") shell_daemon_json=$( [ -f "$json" ] && echo present || echo none)"
if [ "$(alive "$daemon")" = yes ]; then kill -9 "$daemon"; echo "CLEANUP kill -9 $daemon"; fi
