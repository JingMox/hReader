#!/usr/bin/env bash
# After SIGTERM, the shell and the daemon it spawned must both exit, leaving no daemon.json.
set -u
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"
require_app

root=$(mktemp_root hr-signal-term) || exit 1
echo "root=$root"
make_dirs "$root"
make_cli_shim "$root/hr"
"$APP_BIN" --home "$root/home" --workspace "$root/ws" --open "$root/ws/doc.html" \
  --cli-path "$root/hr" > "$root/app.out" 2> "$root/app.err" < /dev/null &
app=$!
for _ in $(seq 1 80); do [ -f "$root/home/.hreader/daemon.json" ] && break; sleep 0.25; done
json="$root/home/.hreader/daemon.json"
if [ ! -f "$json" ]; then
  echo "app_alive=$(alive "$app") daemon_json=MISSING"; head -3 "$root/app.err"; exit 1
fi
daemon=$(field_of "$json" pid)
echo "app=$app daemon=$daemon"
kill -TERM "$app"
for _ in $(seq 1 40); do [ "$(alive "$daemon")" = no ] && break; sleep 0.25; done
echo "AFTER SIGTERM -> app_alive=$(alive "$app") daemon_alive=$(alive "$daemon") daemon_json=$( [ -f "$json" ] && echo present || echo none)"
if [ "$(alive "$daemon")" = yes ]; then kill -9 "$daemon"; echo "CLEANUP kill -9 $daemon"; fi
