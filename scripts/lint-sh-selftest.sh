#!/usr/bin/env bash
# `lint:sh` 的反例自证（§11.47 / M4.6 G-4）：坏脚本、空目录、缺目录三种样本都必须让 lint 非 0，
# 干净目录必须为 0。只读仓库：夹具全在 `mktemp -d` 里，`trap` 清理。
#
# 每个 case 断言**自己专属**的输出（而不是只看 rc）：坏脚本必须点名 `b-broken.sh`（证明第二个
# operand 真被解析，不是 `-exec ... +` 只吃首参），空目录必须报 `没有可检查`，缺目录必须报
# `不存在`，干净目录必须**无输出**；同时断言其它 case 的期望串不出现，避免"任何一次失败都满足"
# 的重言断言（P2-2）。为此 `lint:sh` 对空集/缺目录给出显式报错，而不是静默非 0。
#
# 反例自证（旧写法必须让本脚本红）：
#   LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash scripts/lint-sh-selftest.sh
#   LINT_SH_CMD=true bash scripts/lint-sh-selftest.sh
# 默认命令（来自 package.json 的 `lint:sh`）必须绿。`{}` 是夹具目录占位符。
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -n "${LINT_SH_CMD:-}" ]; then
  template=$LINT_SH_CMD
else
  template=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts["lint:sh"])' "$root/package.json")
  # 默认命令的 find 根是 `root=scripts`；换成占位符后，同一命令就能对夹具目录打靶。
  template=${template//root=scripts/root=__FIXTURE_DIR__}
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bad" "$work/empty" "$work/clean"
# 坏目录里放**两个**脚本且好的在前：`-exec bash -n {} +` 会把多个路径塞给一次 `bash -n`，
# 而 bash 只解析第一个 operand（§11.47 的原事故），于是第二个坏脚本必须被漏掉。
printf '#!/usr/bin/env bash\necho ok\n' >"$work/bad/a-ok.sh"
printf 'if then fi\n' >"$work/bad/b-broken.sh"
printf '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n' >"$work/clean/ok.sh"

failures=0

check_case() {
  local name=$1
  local dir=$2
  local expect=$3
  local expect_text=$4
  shift 4
  local cmd=${template//__FIXTURE_DIR__/$dir}
  cmd=${cmd//find \{\} /find $dir }
  local rc=0
  local output
  output=$(bash -c "$cmd" 2>&1) || rc=$?
  local verdict=PASS
  if [ "$expect" = "0" ] && [ "$rc" -ne 0 ]; then verdict=FAIL; fi
  if [ "$expect" = "!=0" ] && [ "$rc" -eq 0 ]; then verdict=FAIL; fi
  if [ -z "$expect_text" ]; then
    # 干净目录的期望是"无输出"。
    if [ -n "$output" ]; then verdict=FAIL; fi
  else
    case "$output" in
      *"$expect_text"*) : ;;
      *) verdict=FAIL ;;
    esac
  fi
  local other
  for other in "$@"; do
    case "$output" in
      *"$other"*) verdict=FAIL ;;
    esac
  done
  if [ "$verdict" = "FAIL" ]; then failures=$((failures + 1)); fi
  printf 'case=%s rc=%s expect=%s 期望串=%s %s\n' "$name" "$rc" "$expect" "${expect_text:-（无输出）}" "$verdict"
}

check_case bad-script "$work/bad" "!=0" "b-broken.sh" "没有可检查" "不存在"
check_case empty-dir "$work/empty" "!=0" "没有可检查" "b-broken.sh" "不存在"
check_case missing-dir "$work/missing" "!=0" "不存在" "b-broken.sh" "没有可检查"
check_case clean-dir "$work/clean" "0" ""

# 自短路自检（R3-b / MV-15）：以已知坏的 lint:sh 命令再 spawn 自己一次，断言那次必须非 0。
# 若本脚本被人改成"恒 0"（判定后的 `exit 1`→`exit 0`），这次子调用会返回 0 ⇒ 红。
# `LINT_SH_SELFTEST_INNER=1` 断开递归；内层的实测/报错全部丢弃，只看退出码。
if [ "${LINT_SH_SELFTEST_INNER:-}" != "1" ]; then
  if LINT_SH_SELFTEST_INNER=1 LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash "$0" >/dev/null 2>&1; then
    echo "selftest 自检失败：已知坏的 lint:sh 命令没有让本脚本变红（自身退出路径被短路？）" >&2
    exit 1
  fi
fi

if [ "$failures" -ne 0 ]; then
  echo "lint:sh 反例自证失败：$failures 个 case 不符合预期（见上）" >&2
  exit 1
fi
echo "lint:sh 反例自证通过：坏脚本/空集/缺目录均非 0 且报错可辨，干净目录为 0"
