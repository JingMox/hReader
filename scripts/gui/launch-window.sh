#!/usr/bin/env bash
# 启动窗口期：父进程在 `hr serve` 刚 spawn、还没 ready 时被 kill -9。
# 期望：0.03s 杀 = 根本起不来；0.3s / 0.6s 杀 = daemon 发现自己 ppid 已是 1，立刻失败退出，
# 不写 daemon.json、不占端口。三条时间线各跑一遍，输出机器可读的一行。
# 用法：launch-window.sh [杀点秒数...]（默认 0.03 0.3 0.6）

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
  # 全断开 stdio：否则调用方的管道要等这个后台任务退出才 EOF。
  "$root/parent.sh" > "$root/parent.log" 2>&1 < /dev/null &
  parent=$!
  sleep "$delay"
  echo "=== kill point ${delay}s: parent=$parent ppid-of-parent=$parent"
  kill -9 "$parent"
  # 给 daemon 最多 6s 自己收尸
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
