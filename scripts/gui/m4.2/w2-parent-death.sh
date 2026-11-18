#!/usr/bin/env bash
# W2 稳态：daemon 已经 ready 之后父进程被 kill -9 → 1s 内自己退出、端口释放、daemon.json 消失。
set -u
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

root=$(mktemp_root hr-w2-parent) || exit 1
echo "root=$root"
make_dirs "$root"
port=49311
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
"$root/parent.sh" > "$root/parent.log" 2>&1 < /dev/null &
parent=$!
for _ in $(seq 1 60); do
  [ -s "$root/serve.pid" ] && [ -f "$root/home/.hreader/daemon.json" ] && break
  sleep 0.2
done
daemon=$(cat "$root/serve.pid")
echo "parent=$parent daemon=$daemon daemon_ppid=$(ppid_of "$daemon") port_open=$(port_open $port)"
kill -9 "$parent"
for _ in $(seq 1 40); do [ "$(alive "$daemon")" = no ] && break; sleep 0.25; done
echo "AFTER kill -9 -> daemon_alive=$(alive "$daemon") port_open=$(port_open $port) daemon_json=$( [ -f "$root/home/.hreader/daemon.json" ] && echo present || echo none)"
if [ "$(alive "$daemon")" = yes ]; then kill -9 "$daemon"; echo "CLEANUP kill -9 $daemon"; fi
