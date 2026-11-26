#!/usr/bin/env bash
# The startup window: the parent is kill -9'd just after `hr serve` spawns, before it is ready.
# Expected: a 0.03s kill = never comes up; a 0.3s / 0.6s kill = the daemon notices ppid is
# already 1 and fails out at once, writing no daemon.json, holding no port. Three timelines
# each run once, emitting one machine-readable line. Usage: launch-window.sh [seconds...]

set -u
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

DELAYS=("$@")
[ ${#DELAYS[@]} -eq 0 ] && DELAYS=(0.03 0.3 0.6)

for delay in "${DELAYS[@]}"; do
  root=$(mktemp_root "hr-launch-$delay") || exit 1
  echo "root=$root delay=$delay"
  make_dirs "$root"
  port=49500
  make_cli_shim "$root/hr"
  cat > "$root/parent.sh" <<INNER
#!/bin/sh
cd "$root/ws" || exit 1
"$root/hr" serve doc.html --workspace "$root/ws" --home "$root/home" --json \
  --exit-with-parent --port $port > "$root/serve.out" 2> "$root/serve.err" < /dev/null &
echo \$! > "$root/serve.pid"
sleep 300
INNER
  chmod +x "$root/parent.sh"
  # Fully detach stdio: otherwise the caller's pipe waits for this background task before EOF.
  "$root/parent.sh" > "$root/parent.log" 2>&1 < /dev/null &
  parent=$!
  sleep "$delay"
  echo "=== kill point ${delay}s: parent=$parent ppid-of-parent=$parent"
  kill -9 "$parent"
  # Give the daemon at most 6s to reap itself
  for _ in $(seq 1 60); do
    [ -f "$root/serve.pid" ] && daemon=$(cat "$root/serve.pid") || daemon=""
    if [ -n "$daemon" ] && [ "$(alive "$daemon")" = no ]; then break; fi
    sleep 0.1
  done
  daemon=$(cat "$root/serve.pid" 2>/dev/null || echo none)
  json="$root/home/.hreader/daemon.json"
  echo "TIMELINE kill=${delay}s daemon=$daemon daemon_alive=$( [ "$daemon" = none ] && echo none || alive "$daemon") port_open=$(port_open $port) daemon_json=$( [ -f "$json" ] && echo present || echo none) listener=$( [ -n "$(lsof -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null | tail -n +2)" ] && echo yes || echo no)"
  echo "serve.err: $(head -2 "$root/serve.err" 2>/dev/null | tr '\n' ' ')"
  if [ "$daemon" != none ] && [ "$(alive "$daemon")" = yes ]; then kill -9 "$daemon"; echo "CLEANUP kill -9 $daemon"; fi
done
