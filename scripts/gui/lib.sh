#!/usr/bin/env bash
# Shared helpers for the GUI evidence scripts: repo-root lookup, one-shot home/workspace,
# process/port liveness. Internal use only; never prints the token (only pid/port of daemon.json).
#
# Discipline: `--home` always points at a `mktemp -d` sandbox; default-home.sh is the sole
# exception — it uses the real shell app-data dir and `rm -rf`s it up front, hence the
# `HREADER_GUI_REAL_HOME=1` gate (a mutant once ate the real `~/.hreader/daemon.json`).

set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
APP_BIN="$REPO_ROOT/packages/desktop/src-tauri/target/release/bundle/macos/hReader.app/Contents/MacOS/hreader-desktop"
CLI_MAIN="$REPO_ROOT/packages/cli/src/main.ts"

alive() { kill -0 "$1" 2>/dev/null && echo yes || echo no; }
port_open() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1 && echo yes || echo no; }
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

# Evidence dirs use `mktemp -d`: a fixed `/tmp/hr-*` would let concurrent scripts wipe each
# other's dirs. A failure must stop at once: an empty string turns `"$root/home"` into `/home`.
mktemp_root() { mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX" || { echo "mktemp failed: $1" >&2; exit 1; }; }

# One-shot workspace (with doc.html) + empty home: left for the caller to inspect after each run; the script does not clean up.
make_dirs() {
  local root=$1
  # Guard here too so correctness doesn't depend on every call site writing `|| exit 1`.
  [ -n "$root" ] || { echo "make_dirs: root is empty (mktemp failed?)" >&2; exit 1; }
  mkdir -p "$root/home" "$root/ws" || exit 1
  printf '<!doctype html><html><body><article data-hr-id="hr-a"><p>x</p></article></body></html>' \
    > "$root/ws/doc.html"
}

# The in-repo `hr`: runs node + TS sources directly (no build, no global install).
make_cli_shim() {
  local target=$1
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$(command -v node)" "$CLI_MAIN" > "$target"
  chmod +x "$target"
}

field_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }

require_app() {
  if [ ! -x "$APP_BIN" ]; then
    echo "missing packaged artifact: $APP_BIN (run pnpm --dir packages/desktop build first)"
    exit 1
  fi
}
