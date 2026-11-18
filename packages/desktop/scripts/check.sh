#!/usr/bin/env bash
# 桌面壳的静态门禁：层分界 + 格式 + lint（含 tests/ 目标）+ 单测。零豁免：clippy 带 -D warnings。
set -euo pipefail
cd "$(dirname "$0")/.."

# 层分界（AC-8 下界）：`use tauri` 只许出现在建窗口的白名单文件里，
# 纯逻辑模块一碰 tauri 就只能进 GUI 进程才能测，`cargo test` 会退化成"编译过就算过"。
allowed="src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/window.rs"
leaked=$(grep -rl -E 'use tauri|tauri::|#\[tauri::command\]' src-tauri/src --include='*.rs' | grep -v -x -E "$(echo "$allowed" | tr ' ' '|')" || true)
if [ -n "$leaked" ]; then
  echo "层分界被打破：这些文件不该碰 tauri —— $leaked" >&2
  exit 1
fi

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
