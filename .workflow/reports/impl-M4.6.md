# impl-M4.6 - F1 施工报告（写者，2026-11-18）

基线：`git log -1` = `af7a32c`；开工前 `git status --porcelain` 仅 `?? .workflow/cards/M4.6.md`。
本报告只记施工与实测退出码；AC 逐行判读归测试员/审计员。

## F1

### F1-a（G-1 + D1-D5）`scripts/check-ci-parity.mjs`

改动文件:行

- `scripts/check-ci-parity.mjs:1-184`（新建）。关键段：`:32` `parseArgs`（`--ci`/`--verify`，D5）、`:46` `readVerifySteps`（按 `&&` 切、去 `pnpm ` 前缀）、`:58` `checksJobLines`（只取 `checks` job 块）、`:66` `readCiSteps`（D3 正则 + `install` 白名单 + D4 多行 fail-closed）、`:101` `runCheck`（同序同集 + 缺/多/乱序三张清单）、`:124` `mutate` 与 `:145` `runSelftest`（/tmp 副本四个反例，D5）。
- `package.json:12` 新增 `check-ci-parity`；`:28` `verify` 里放在 `format:check` 之后（D2，`i === f+1`）。
- `.github/workflows/ci.yml:25` `checks` job 同位置加 `- run: pnpm check-ci-parity`；`:2` 注释"八步"改"十步"。
- `knip.json:36` root entry 追加 `scripts/**/*.mjs`（D1）。

反例命令与退出码（施工时实测）

- 基线（同时跑 selftest）：`node scripts/check-ci-parity.mjs` -> EXIT=0，打印 `verify[1..10]` 与 `ci.yml checks[1..10]`，四个 selftest case 全 PASS（`missing/extra/order/multiline` 各 rc=1）。
- 缺步（AC-2/MV-1，用 /tmp 副本，不动仓库）：
  `cp .github/workflows/ci.yml /tmp/ci-drop-knip.yml && sed -i '' '/- run: pnpm knip/d' /tmp/ci-drop-knip.yml && node scripts/check-ci-parity.mjs --ci /tmp/ci-drop-knip.yml --verify package.json`
  -> EXIT=1，stdout `缺失（verify 有、ci 没有）：knip`（同时打印 `多余：无`、`乱序：第 10 步 ...`）。
- 多步/乱序/多行 run：由 selftest 内建，逐个断言 `rc!=0` 且输出含
  `多余` / `乱序` / `多行`，实测四行 `case=... rc=1 ... PASS`。
- 挂载位置自检：`node -e '...indexOf("pnpm check-ci-parity")===indexOf("pnpm format:check")+1...'` -> `{ i: 1, f: 0, ok: true, j: 4, k: 3, selftestAfterLintSh: true }`。
- 只读性：两次基线跑后 `git status --porcelain` 只有本轮既有改动 + 两个新脚本，无额外文件。

### F1-b（G-2）ICO 第 5 份样本（41 字节）

改动文件:行

- `packages/desktop/src-tauri/src/lib.rs:538-565`（新增 `r7_ico_rejects_png_under_45_bytes`）。样本 = 签名 8 + 合法 IHDR 块 25 + IEND 序列 8 = 41 字节；`catch_unwind` 后断言 panic 文本含 `至少 45 字节`，即证明赢的是长度断言而不是 IHDR/IEND。断言本体（`:410-426`）未改，`payload.len() >= 45` 仍只出现 1 次，无"不可达"注释。

反例命令与退出码

- `cargo test --lib r7_ico_` 与 `cargo test --lib` 实测：`81 passed; 0 failed`，EXIT=0（基线 80 + 新样本 1）。
- `pnpm desktop:check` 中 `cargo clippy --all-targets -- -D warnings` 亦 EXIT=0。

### F1-c（G-3 + D8）signals 每用例独占夹具

改动文件:行

- `packages/desktop/src-tauri/src/signals.rs:41-108` 新增 `pub(super) struct Hub`（`stopped/watched/failed/announced` 四个 `AtomicBool` + `new/stopped/watch/watch_with`）；`:109` `pub(super) static GLOBAL: Hub = Hub::new()` 为生产单例；`:115` `mark_stopped` 只写 `GLOBAL`（异步信号安全，处理器仍是普通 fn）。
- `signals.rs:157-212` Windows 空桩改成同形状的 `Hub`/`GLOBAL`（无状态），`reset_for_test()` 两侧**均已删除**（`grep -n reset_for_test` 无命中）。
- `signals.rs:222/233/254/265` 四个用例各用 `let hub = platform::Hub::new();`；`:280` `ac14_waiting_returns_after_the_timeout` 不再需要 reset。

反例命令与退出码（D8 等价判据：删掉独占入口 = 把 `Hub::new()` 换成 `&platform::GLOBAL`）

- 改动前：`cd packages/desktop/src-tauri && cargo test --lib` -> `81 passed; 0 failed`，EXIT=0。
- 临时把 4 处 `let hub = platform::Hub::new();` 换成 `let hub = &platform::GLOBAL;` 后
  `cargo test --lib signals:: -- --test-threads=1` -> EXIT=101，`3 passed; 2 failed`，红的是：
  `r1_watch_with_reports_each_signal_it_registers`（`assertion left == right failed, left: [], right: [2, 15]`）
  与 `r3_register_failure_rolls_back_and_is_not_retried`（`注册失败必须冒泡`）。
- 还原备份后再跑 `cargo test --lib` -> `81 passed; 0 failed`，EXIT=0。
- 断言强度未降：`assert_eq!(signals, vec![libc::SIGINT, libc::SIGTERM])` 原样保留（`signals.rs:276`）。
- `cargo test` 10 遍按 D9 留给协调者，本报告未跑。

### F1-d（G-4 + D6/D7）`scripts/lint-sh-selftest.sh`

改动文件:行

- `scripts/lint-sh-selftest.sh:1-55`（新建）。`:12-18` 读 `LINT_SH_CMD` 覆盖，否则从 `package.json` 读 `lint:sh` 并把 `find scripts ` 换成 `find {} `（D7）；`:20-26` `mktemp -d` + `trap` 清理；坏目录放**两个**脚本且好的在前（`a-ok.sh`、`b-broken.sh`），复现 §11.47 "`bash -n` 只解析第一个 operand"；`:32-44` 逐 case 打印 `case=... rc=... expect=... PASS/FAIL`；`:46-49` 三坏一好四个 case。
- `package.json:19` `lint:sh` 的根从 `scripts/gui` 扩成 `scripts`（D6）；`:20` 新增 `lint-sh-selftest`；`:28` 紧邻 `lint:sh` 之后挂入 `verify`。
- `.github/workflows/ci.yml:28` `checks` job 同位置加 `- run: pnpm lint-sh-selftest`。

反例命令与退出码

- 基线：`bash scripts/lint-sh-selftest.sh` -> EXIT=0，四行
  `case=bad-script rc=1 expect=!=0 PASS` / `case=empty-dir rc=1 ...` / `case=missing-dir rc=1 ...` / `case=clean-dir rc=0 expect=0 PASS`。
- 旧写法 `-exec ... +`（卡面要求的反例）：
  `LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash scripts/lint-sh-selftest.sh`
  -> EXIT=1，`case=bad-script rc=0 ... FAIL`（另 `empty-dir rc=0 FAIL`）。
- 旧写法 `-exec ... \;`（AC-25）：
  `LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} \;' bash scripts/lint-sh-selftest.sh`
  -> EXIT=1，`bad-script`/`empty-dir` 两个 FAIL。
- 删空集守卫（MV-14）：
  `LINT_SH_CMD='find {} -name "*.sh" -print0 | xargs -0 -n1 bash -n' bash scripts/lint-sh-selftest.sh`
  -> EXIT=1，`empty-dir rc=0 FAIL`、`missing-dir rc=0 FAIL`。
- 自身语法：`bash -n scripts/lint-sh-selftest.sh` -> EXIT=0（且 D6 后它已被 `pnpm lint:sh` 覆盖）。

## 全量门禁（§11.49：两条各贴退出码）

- `pnpm verify > /tmp/verify-m46.log 2>&1` -> **EXIT=0**；日志含 `Test Files 265 passed (265)`、`Tests 2971 passed (2971)`、`All files | 100 | 100 | 100 | 100`；新增三步输出可见（`[parity] OK ... 10 步`、selftest 四 case、`lint:sh 反例自证通过`）。
- `pnpm desktop:check > /tmp/desktop-check-m46.log 2>&1` -> **EXIT=0**；日志含 `81 passed; 0 failed`（lib）与 `3 passed; 0 failed`（`tests/connect_recheck.rs`）。

## git status 入账（§11.48）

本轮产出的新文件两个，都是 `??`，结卡前必须 `git add`：

- `?? scripts/check-ci-parity.mjs`
- `?? scripts/lint-sh-selftest.sh`

修改的已跟踪文件：`.github/workflows/ci.yml`、`knip.json`、`package.json`、`packages/desktop/src-tauri/src/lib.rs`、`packages/desktop/src-tauri/src/signals.rs`。本报告自身 `?? .workflow/reports/impl-M4.6.md`。

## 裁定执行情况（异议/不可行）

D1-D4、D6-D10 均可照办，已落地。唯一需要协调者知道的口径缺口是 **D5 的"恒真断言"反例**：`--ci/--verify` 只能换输入文件，无法构造"脚本自身断言恒真"的输入，因此 selftest 的第四个 case 用**多行 `run: |` fail-closed**代替（这也是 A-4/MV-4 的反例）。MV-7（把 `process.exit` 改恒真）仍无自动门禁，只能靠结卡手跑 MV-1..MV-4（见报告上文命令）。若协调者要求更强的"门禁的门禁"，需要另立一张卡（例如对脚本做变异测试），不在本卡范围。

## R2

审计 P1-1 + P2 三条。改动只在工作树，未 `push`、未 `git add`。

### P1-1 `continue-on-error` / 作业级 `if:` 旁路（照做）

改动文件:行

- `scripts/check-ci-parity.mjs:66-96` 新增 `FORBIDDEN_STEP_KEYS = [continue-on-error, if, shell, working-directory, env]`、`JOB_LEVEL_IF = /^ {4}if\s*:/`、`STEP_KEY`、`STEP_BODY_INDENT = 7`；`checksJobBody:71-79` 取代 `checksJobLines`，返回内容与原 `firstLine`（1 基行号）。
- `scripts/check-ci-parity.mjs:84-96` `assertStepUnmodified`：命中 `- run:` 后扫描其后续更深缩进行（`indent >= 7`，遇同缩进 `- ` 或回退即停）；键名命中禁用集即 `abort`，消息含"步骤级修饰键会旁路门禁（§11.52），拒绝继续"+ 键名 + 行号 + 所属 run 行号。
- `scripts/check-ci-parity.mjs:97-121` `readCiSteps`：`checks` job 内 `^ {4}if:` 即 `abort`（"作业级 if: 会让整个 job 跳过（§11.52）"）；`needs:`/`timeout-minutes:`/`runs-on:` 等不匹配，放行。
- 复杂度超限（eslint complexity 11>10）后把步骤块扫描拆成 `assertStepUnmodified`，`readCiSteps` 回到阈值内。

复现（可复制）：

```
cd /Users/liu/Documents/Project/hReader
cp .github/workflows/ci.yml /tmp/x.yml
perl -0pi -e 's/      - run: pnpm knip\n/      - run: pnpm knip\n        continue-on-error: true\n/' /tmp/x.yml
node scripts/check-ci-parity.mjs --ci /tmp/x.yml --verify package.json; echo EXIT
# -> 步骤级修饰键会旁路门禁（§11.52），拒绝继续：ci.yml:34 `continue-on-error: true`
#      键 continue-on-error: 作用于 ci.yml:33 的 `- run: pnpm knip`   EXIT=1

cp .github/workflows/ci.yml /tmp/y.yml
perl -0pi -e 's/\n  checks:\n/\n  checks:\n    if: false\n/' /tmp/y.yml
node scripts/check-ci-parity.mjs --ci /tmp/y.yml --verify package.json; echo EXIT
# -> 作业级 if: 会让整个 job 跳过（§11.52），拒绝继续：ci.yml:11 `if: false`   EXIT=1

node scripts/check-ci-parity.mjs --ci .github/workflows/ci.yml --verify package.json; echo EXIT  # -> 0
```

### P2-1 `多余` 分支零覆盖（照做）

- `scripts/check-ci-parity.mjs:165-192` `mutate` 的 `extra` 分支改成插入 verify 里**没有**的 `      - run: pnpm nope`，只触发"多余"不掺乱序；同名 case 期望串改为 `多余（ci 有、verify 没有）：nope`。

### P2-2 selftest 断言恒真（照做，并顺带补齐 lint:sh 的可辨消息）

`check-ci-parity` 侧（`scripts/check-ci-parity.mjs:194-236`）：

- `SELFTEST_CASES` 每 case 带专属 `expect`，断言 `rc!=0 && output.includes(expect)`，且**任何其它 case 的 expect 不得出现**（`leaked` 必须为空），输出行同时打印 `expect-string` 与 `leaked`。
- 新增两个反例 `continue-on-error`、`job-if`，让 P1-1 的新判据进 `verify` 自证（否则它只有手跑证据）。
- 实测六行全 PASS、`leaked=[]`。

`lint-sh-selftest` 侧（`scripts/lint-sh-selftest.sh:42-73`）：

- 不再只看 rc：`check_case` 捕获 `output=$(bash -c "$cmd" 2>&1)`，断言 case 专属串：坏脚本 → `b-broken.sh`（证明第二个 operand 真被解析）；空目录 → `没有可检查`；缺目录 → `不存在`；干净目录 → **无输出**。每个 case 另传其它 case 的期望串作禁用集。
- **改做法说明**：task 给的 `没有可检查`/`不存在` 两个串在仓库里原本不存在（`lint:sh` 用 `test -n "$(find ...)"` 静默失败）。为使这两个断言有真实对象，`package.json:19` 的 `lint:sh` 加了显式守卫消息（缺目录/空集），根从字面 `scripts` 改为 `root=scripts`（D6 覆盖不变，仍递归 `scripts`）。这是 P2-2 期望串的必要前提，非额外门禁。
- selftest 的夹具占位从 `find {} ` 扩展为同时替换 `root=__FIXTURE_DIR__` 与 `find {} `，旧的 `LINT_SH_CMD='find {} ... -exec ... +'` 反例语义不变。

### 验收（命令 / 退出码 / 命中行）

1. `/tmp/x.yml`（步骤级 `continue-on-error: true`）→ `EXIT=1`，`步骤级修饰键会旁路门禁（§11.52），拒绝继续：ci.yml:34 ... 键 continue-on-error:`（构造命令见上）。
2. `/tmp/y.yml`（`checks:` 后 `if: false`）→ `EXIT=1`，`作业级 if: 会让整个 job 跳过（§11.52），拒绝继续：ci.yml:11`。
3. 正常树 `node scripts/check-ci-parity.mjs --ci .github/workflows/ci.yml --verify package.json` → `EXIT=0`（未改仓库 `ci.yml`）。
4. `bash scripts/lint-sh-selftest.sh` → `EXIT=0`，四行 `case=bad-script rc=1 ... 期望串=b-broken.sh PASS` / `empty-dir ... 没有可检查 PASS` / `missing-dir ... 不存在 PASS` / `clean-dir rc=0 ... （无输出） PASS`。
5. `LINT_SH_CMD=true bash scripts/lint-sh-selftest.sh` → `EXIT=1`（3 case FAIL）；`LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' ...` → `EXIT=1`（3 case FAIL，`bad-script rc=0`）。
6. `pnpm verify > /tmp/verify-r2.log 2>&1` → `EXIT=0`；日志含 `[parity] OK：...（10 步）`、六行 `[parity][selftest] ... PASS`、四行 lint-sh case、`Test Files 265 passed (265)`、`Tests 2971 passed (2971)`、`All files | 100 | 100 | 100 | 100`。
7. `pnpm exec eslint scripts/check-ci-parity.mjs --max-warnings=0` → 0；`bash -n scripts/lint-sh-selftest.sh` → 0；`pnpm lint:sh` → 0。
8. `cargo test` 10 遍按 D9 留给协调者，本轮未跑。

### git status（§11.48）

未 `git add`：`M package.json`（R1 已改 + R2 改 lint:sh）、`M .github/workflows/ci.yml`（R1）、`M knip.json`、`M lib.rs`、`M signals.rs`、`?? scripts/check-ci-parity.mjs`、`?? scripts/lint-sh-selftest.sh`、`?? .workflow/reports/*`。`git diff --cached` 为空。

---

## R3

终测挖出的三件小事（MV-7 退出码管道、MV-15 自短路、D1 knip 白名单）。不动 `verify`/`ci.yml` 的十步口径。

### R3-a parity selftest 与被告退出码不同源（MV-7）

- `scripts/check-ci-parity.mjs` 的 6 个 case 自证本来就是 **spawn 自身子进程**（`node <self> --ci <tmp>.yml --verify <tmp>package.json`），缺的是"父子共用 `process.exit(1)`"：父进程的失败回执也走 `abort()`，于是把 `abort` 里的 `exit(1)` 改成 `exit(0)` 会让整条命令绿。
- 改法（最小）：
  - 新增 `EXPECTED_FAIL_RC = 1`（期望值只写在父进程），`SELFTEST_CASES` 断言 `run.status === EXPECTED_FAIL_RC`（原为 `!== 0`），并继续断言专属期望串出现、其它 case 串不出现。
  - 父进程的 selftest 失败回执改为 `emit(FAIL 行)` + `process.exitCode = EXPECTED_FAIL_RC`（**不是** `process.exit(1)`），与子进程 `abort()` 的退出路径分离。
- 覆盖仍为 6 个 case：缺步、多余、乱序、多行 `run`、步骤级 `continue-on-error`、作业级 `if:`。无新增 `verify`/`ci.yml` 步骤（`check-ci-parity` 脚本对账后自行跑 6 个 case）。

**自打靶证据（R3-a 核心验收）**：把 `scripts/check-ci-parity.mjs:36`（`abort()` 内）的 `process.exit(1)` 改成 `process.exit(0)`，备份后改、还原后 `cmp` 一致：

| 状态 | 命令 | 退出码 | 命中行 |
| --- | --- | --- | --- |
| 基线 | `node scripts/check-ci-parity.mjs` | **0** | 6 行 `[parity][selftest] case=… rc=1 expect-rc=1 … PASS` + `[parity] OK：selftest 六个反例全部变红` |
| 变异 `:36 exit(1)→exit(0)` | `node scripts/check-ci-parity.mjs` | **1** | `[parity][selftest] case=job-if rc=0 expect-rc=1 … FAIL` + `[parity] FAIL：selftest 反例没变红：missing, extra, order, multiline, continue-on-error, job-if` |
| 还原 | `cmp` + 重跑 | `cmp` OK / **0** | — |

（未变异前该形态是 `EXIT=0` 存活；见终测 §2 MV-7a。）

### R3-b lint selftest 抓自身短路（MV-15）

`scripts/lint-sh-selftest.sh` 在最终判定前加**自调用**：`LINT_SH_SELFTEST_INNER=1 LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash "$0" >/dev/null 2>&1`，断言该子调用**非 0**（已知坏命令必须让本脚本红）；若脚本被人改成恒 0，子调用返回 0 ⇒ 外层报 `selftest 自检失败：…` 并 `exit 1`。`LINT_SH_SELFTEST_INNER=1` 断递归；子调用约 +0.1s。

| 状态 | 命令 | 退出码 | 命中行 |
| --- | --- | --- | --- |
| 基线 | `bash scripts/lint-sh-selftest.sh` | **0** | 4 行 `case=… PASS` + `lint:sh 反例自证通过：…` |
| 变异 `lint-sh-selftest.sh:88 exit 1→exit 0` | 同上 | **1** | `selftest 自检失败：已知坏的 lint:sh 命令没有让本脚本变红（自身退出路径被短路？）` |
| 还原 | `cmp` + 重跑 | `cmp` OK / **0** | — |

### R3-c 撤销 D1 的 knip 白名单（终测 E3 复核）

- `knip.json` 的 `"."` entry 删掉 `"scripts/**/*.mjs"`，保留 `"scripts/**/*.ts"`（该文件因此与 HEAD 逐字一致，`git status` 里不再是 `M`）。原因：`package.json` 的 script 命令已被 knip 解析为入口；保留该 glob 会把 `scripts/` 下任何未来野 `.mjs` 白名单化，削弱 knip。
- `npx knip` → **EXIT=0**（无 `Unused files`/`Unlisted binaries`）。
- **裁定口径：D1 的脚本后缀裁定保留（`.mjs`），knip 白名单撤销（不需要）。**

### 验收（命令 / 退出码 / 命中行）

1. `node scripts/check-ci-parity.mjs` → **0**；6 行 `[parity][selftest] … PASS`。
2. R3-a 自打靶（上表）→ 变异 **1**、还原 **0**、`cmp` 一致。
3. `bash scripts/lint-sh-selftest.sh` → **0**；`exit 1→exit 0` 变异 → **1**；还原 `cmp` 一致。
4. `npx knip` → **0**。
5. `pnpm verify` → **EXIT=0**：`Test Files 265 passed (265)`、`Tests 2971 passed (2971)`、`All files | 100 | 100 | 100 | 100`、`verify[10]` / `ci.yml checks[10]`（步骤数仍 **10**，未增删）。
6. `pnpm desktop:check` → **EXIT=0**：lib `81 passed` + 集成 `3 passed`。

未 `git add` / 未 `push`。
