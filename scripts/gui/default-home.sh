#!/usr/bin/env bash
# Without `--home` (the double-clicked .app's main path), the shell uses only its app-private dir and never touches the user's ~/.hreader.
set -u
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"
require_app

root=$(mktemp_root hr-default-home) || exit 1
echo "root=$root"
make_dirs "$root"
make_cli_shim "$root/hr"
shell_store="$HOME/Library/Application Support/com.hreader.desktop"
# This script deliberately uses the real shell app-data dir: it is deleted wholesale below — back up first and confirm no instance is running.
[ "${HREADER_GUI_REAL_HOME:-}" = "1" ] || { echo "this script deletes the real shell data dir ${shell_store}; confirm by rerunning with HREADER_GUI_REAL_HOME=1" >&2; exit 1; }
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
