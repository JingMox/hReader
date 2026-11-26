#!/usr/bin/env bash
# GUI 真机证据脚本共用的小工具：定位仓根、造一次性 home/workspace、判进程与端口存活。
# 只在脚本内部使用；不打印 token（读 daemon.json 时只取 pid/port 两个字段）。
#
# 纪律：`--home` 一律指向 `mktemp -d` 沙箱；default-home.sh 是唯一例外，它故意用真实壳 app data 目录
# 并在开头 `rm -rf` 它，所以要求 `HREADER_GUI_REAL_HOME=1` 才继续——跑之前备份、并确认无在跑实例。
# 这个顺序反过一次真事故：变异体落回 `homedir()`，覆盖并删掉了真实的 `~/.hreader/daemon.json`。

set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
APP_BIN="$REPO_ROOT/packages/desktop/src-tauri/target/release/bundle/macos/hReader.app/Contents/MacOS/hreader-desktop"
CLI_MAIN="$REPO_ROOT/packages/cli/src/main.ts"

alive() { kill -0 "$1" 2>/dev/null && echo yes || echo no; }
port_open() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1 && echo yes || echo no; }
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

# 证据目录用 `mktemp -d`：固定 `/tmp/hr-*` 会让并发跑的两个脚本互相清目录。
# 失败要立刻停：空串会让调用方的 `"$root/home"` 变成 `/home`，root 运行就在沙箱外真建目录。
mktemp_root() { mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX" || { echo "mktemp 失败：$1" >&2; exit 1; }; }

# 一次性的 workspace（含 doc.html）+ 空 home：每次跑完由调用方自己留着看，脚本不清理。
make_dirs() {
  local root=$1
  # `mktemp_root` 在 `$(...)` 里 `exit 1` 的状态码会传出（调用点已 `|| exit 1`）；这里再挡一次，是为了不依赖每个调用点都写 `|| exit 1`。
  [ -n "$root" ] || { echo "make_dirs: root 为空（mktemp 失败？）" >&2; exit 1; }
  mkdir -p "$root/home" "$root/ws" || exit 1
  printf '<!doctype html><html><body><article data-hr-id="hr-a"><p>x</p></article></body></html>' \
    > "$root/ws/doc.html"
}

# 仓内的 `hr`：直接跑 node + TS 源（不经构建，也不依赖全局安装）。
make_cli_shim() {
  local target=$1
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$(command -v node)" "$CLI_MAIN" > "$target"
  chmod +x "$target"
}

field_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }

require_app() {
  if [ ! -x "$APP_BIN" ]; then
    echo "缺少打包产物：$APP_BIN（先 pnpm --dir packages/desktop build）"
    exit 1
  fi
}
