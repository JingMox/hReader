# M4.2 G4 收尾轮测试报告（R5/R6 返工后终验）

- 角色：测试员（只读主树；所有变异只在副本内）
- 被测主树：`/Users/liu/Documents/Project/hReader`
- 副本：`/tmp/m42g4`（`rsync -a --exclude node_modules --exclude src-tauri/target`，各 workspace 的 `node_modules` 软链回主树）
- 预算：30 分钟有效工作；本报告边跑边写（分批落盘）

## 0 铁律执行证据

| 项 | 证据 |
| --- | --- |
| 沙箱 HOME | 每次破坏性命令前 `export HOME=$(mktemp -d)` + `export TMPDIR=$(mktemp -d)`；实测值例 `HOME=/var/folders/r6/674grzj92kl__csw1x0k5ftw0000gn/T/tmp.MnIQagxjBW`、`TMPDIR=.../tmp.iDZgcuIg1r` |
| 副本路径 | `/tmp/m42g4`（12M）；`ln -sfn <main>/$d/node_modules $d/node_modules`（`.` 与 `packages/*` 全覆盖） |
| 主树写入 | **零**：`*.test.ts` / `tests/` 未改；本报告是唯一由我落盘的文件；无 `git add`/`commit`/`push` |
| 真实目录保护（§3） | `~/Library/Application Support/com.hreader.desktop` → `mv` 到 `~/.m42g4-store-backup`，测完 `RESTORE_OK` 原样还原（`ls` 内容、mtime 08:07 前的 07:38 全保留） |
| pnpm 陷阱（本轮新发现） | 副本里 `pnpm <script>` 会触发 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`（软链 node_modules 使 deps-status 判定需重装）→ **副本内所有门禁改为从 `package.json` 取原始命令串用 `bash -c` 执行**，测试用 `./node_modules/.bin/vitest` 直呼。首次那批 5 个 `EXIT=1` 是 pnpm 自身失败，已作废重跑 |
| 主树漂移（测试期间并行改稿） | 见 §7。`packages/desktop/src-tauri/src/lib.rs` 在我跑到 T4-① 时已被并行 writer 重构成 `assert_valid_ico()`（76 → 79 例），因此 T4-① **在最新源码上重跑了一遍**（§4）；`.github/workflows/ci.yml` 新增 `pnpm lint:sh`/`pnpm build` 两步、`scripts/gui/m4.2/lib.sh` 只改了注释。共 3 个文件漂移，均非我所改 |
| cargo 陷阱 | `desktop:check` **不能在 `HOME=$(mktemp -d)` 下跑**：rustup 认为无工具链，会 `syncing channel updates for 1.98.0` + 重下组件 + 刷新 crates.io index（首跑因此被杀重来）。§1.2 用真 `HOME`；它不写仓库源码。副本内 `cargo test` 用 `CARGO_TARGET_DIR=<主树>/.../target` 复用依赖（target 5.7G，不复制） |

## 1 T1 两道门禁（各自独立退出码）

### 1.1 `pnpm verify`

命令：`pnpm verify > /tmp/verify.log 2>&1`（主树）

| 项 | 实测 | 期望 |
| --- | --- | --- |
| `format:check` | `All matched files use Prettier code style!` | 通过 |
| `lint` | 无输出（`--max-warnings=0 --report-unused-disable-directives`） | 通过 |
| `lint:sh` | 通过 | 通过 |
| `typecheck` | 通过 | 通过 |
| `build` | 通过 | 通过 |
| `test:coverage` Test Files | **265 passed (265)** | 265 |
| `test:coverage` Tests | **2971 passed (2971)** | 2971 |
| coverage 四维 | `All files  100 / 100 / 100 / 100` | 四维 100% |
| `depcruise` | `no dependency violations found (577 modules, 2390 dependencies cruised)` | 通过 |
| `knip` | 无输出 | 通过 |
| **总退出码** | **EXIT=0** | 0 |

日志锚点：`/tmp/verify.log:1517`（Test Files）`:1518`（Tests）`:1526`（覆盖率表）`:1786`（`EXIT=0`）。

### 1.2 `pnpm desktop:check`

命令：`bash packages/desktop/scripts/check.sh > /tmp/deskcheck.log 2>&1`（主树，**在 verify 之外单独跑**）

| 段 | 实测 |
| --- | --- |
| 层分界 grep（`use tauri|tauri::|#[tauri::command]` 白名单） | 无 `leaked` 输出 |
| `cargo fmt --check` | 无 diff（`Diff in` 0 处） |
| `cargo clippy --all-targets -- -D warnings` | 无 warning / error，`Finished` 两次（`deskcheck.log:228`、`:335`） |
| `cargo test`（第一跑，lib 76 例版） | `76 passed; 0 failed`（lib，`:416`）+ `0 passed`（main）+ `3 passed` + `0 passed` |
| **总退出码** | **EXIT=0**（`deskcheck.log:439`） |

**在最新源码上重跑一遍**（`/tmp/deskcheck2.log`，lib.rs 已被并行重构造成 79 例的 `assert_valid_ico` 版）：`cargo fmt --check` 无 diff、clippy `-D warnings` 干净、`cargo test` = `79 passed; 0 failed`（`:90`）+ `0` + `3` + `0`，**EXIT=0**（`deskcheck2.log:113`）。两道门禁两次都各自为 0。

> 注：前一次被杀掉的运行留下了不完整指纹，导致本次 cargo 从零重编依赖（22s dev / 16s test），非源码问题。

## 2 T2 `lint:sh` 反向

命令（副本 `/tmp/m42g4`，`HOME`/`TMPDIR` 均为 `mktemp -d`，`CI=true`）：

```
CMD=$(node -e 'console.log(require("./package.json").scripts["lint:sh"])')
# = test -n "$(find scripts/gui -name '*.sh' -print -quit)" && find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n
bash -c "$CMD"
```

| # | 操作 | 期望 | 实测 EXIT | 关键输出 |
| --- | --- | --- | --- | --- |
| T2-0 | 基线 | 0 | **0** | — |
| T2-a | `mv scripts/gui /tmp/sg-m42g4`（目录缺失） | ≠0 | **1** | `find: scripts/gui: No such file or directory` |
| T2-b | 还原 | 0 | **0** | — |
| T2-c | 新增 `scripts/gui/_m42_bad.sh`：`if then fi` | ≠0 | **1** | `_m42_bad.sh: line 2: syntax error near unexpected token 'then'` |
| T2-d | 删坏文件 | 0 | **0** | — |
| T2-e | **空集守卫绕过尝试**：`scripts/gui` 换成只含 `readme.md` 的空目录（0 个 `*.sh`） | ≠0 | **1** | 静默（`test -n` 为假 → `&&` 短路），**不可绕过** |
| T2-f | 还原 | 0 | **0** | — |

结论：**PASS**。三种反向（目录缺失 / 语法错 / 目录在但无匹配）全部非 0；空集守卫在"`xargs` 拿到空输入会 exit 0"这一最容易假绿的情形下仍非 0。

## 3 T3 W7 opt-in 真机语义

前置：真实目录先备份 —— `mv "$HOME/Library/Application Support/com.hreader.desktop" "$HOME/.m42g4-store-backup"` → `BACKUP_OK`；`ls` 确认原位已不存在。

### 3.1 未 opt-in 必须**在删之前**退出

```
env -u HREADER_GUI_REAL_HOME bash scripts/gui/m4.2/w7-default-home.sh
```

```
root=/var/folders/.../hr-w7-default.ZtgIMQ
W7 会删真实壳数据目录 /Users/liu/Library/Application Support/com.hreader.desktop；确认后以 HREADER_GUI_REAL_HOME=1 重跑
EXIT=1
```

- 退出码 **1**，消息完整打出（含将被删的真实路径）。
- 顺序证据：`root=`（mktemp 已发生）之后立刻退出，**`rm -rf "$shell_store"` 未执行**——因为备份的原位仍 `No such file or directory`（若 `rm -rf` 跑到，只会静默；关键是它没跑到才使得"原位不存在"这一现象本身可解释；真正的顺序证据是源码 `w7-default-home.sh` 里守卫行在 `rm -rf` 行之前，见下一行）。
- 源码顺序（`scripts/gui/m4.2/w7-default-home.sh`）：`[ "${HREADER_GUI_REAL_HOME:-}" = "1" ] || { echo ...; exit 1; }` 在 `rm -rf "$shell_store"` **之前**。
- 还原：`mv "$BK" "$STORE"` → `RESTORE_OK`；`ls -la "$STORE"` 显示 `07:38 .hreader`（原 mtime 保留）。

### 3.2 opt-in + 沙箱 HOME

```
SB=$(mktemp -d); HOME=$SB; HREADER_GUI_REAL_HOME=1 bash scripts/gui/m4.2/w7-default-home.sh
```

| 观察点 | 实测 |
| --- | --- |
| 退出码 | **EXIT=0** |
| 删的是谁 | `shell_store=/var/folders/.../tmp.i58TpmBsda/Library/Application Support/com.hreader.desktop/.hreader/daemon.json` → **沙箱内**同名目录 |
| daemon.json 落点 | 沙箱 store 内（`workspace=.../hr-w7-default.eVGcrz/ws`） |
| W7 主断言 | `user_store_before=absent` → `user_store_untouched=yes`；沙箱 `$HOME/.hreader` 跑完仍 **不存在**（脚本从未创建、也未被删） |
| SIGTERM 后 | `daemon_alive=no`、`shell_daemon_json=none`（连 json 一起清了） |
| 真实 `~/.hreader` | 内容仍为空目录（`total 0`，仅 `.`/`..`，mtime 08:10 未变） |
| 真实 `~/Library/.../com.hreader.desktop` | 未被动：`.hreader` 仍为 07:38 空目录 |

结论：**PASS**。守卫在删除动作之前，且 opt-in 后删的是 `$HOME` 下的同名目录（沙箱），真实 `~/.hreader` 未出现在脚本的任何路径里。

> 断言强度的小瑕疵（非阻塞）：`user_store_untouched=yes` 在"删之前 `absent`、删之后也 `absent`"时是**平凡成立**的——它证明"没被创建/删改"，但不区分"脚本压根没碰"与"碰了但恰好又恢复"。真实侧我另外用 mtime + 目录内容独立核对过。

## 4 T4 反变异（每条都要红在正确位置）

| # | 变异（副本内） | 命令 | 实测 | 是否红在正确位置 |
| --- | --- | --- | --- | --- |
| T4-① | `packages/desktop/src-tauri/src/lib.rs` 删掉 PNG IEND 断言（替换为 `let _ = PNG_IEND;`）—— **在两版源码上各测一次**：旧版（76 例，断言在 `#[test]` 内）、最新版（79 例，断言在 `assert_valid_ico()` 内） | `cargo test --lib -- --test-threads=1` | 旧版：**76 passed / EXIT=0**；最新版：**79 passed / EXIT=0** | **否 —— 两版都幸存**（见下） |
| T4-② | `packages/cli/tests/units-run-home.test.ts` 删掉模块顶层 `process.env["HOME"] = sandbox;` | `vitest run packages/cli/tests/units-run-home.test.ts` | **EXIT=1**；`× should have redirected HOME to a temp dir, so a broken wiring cannot touch the real one`；`Tests 1 failed | 1 passed (2)` | **是**——恰好红在那条守卫用例上；且沙箱 `$HOME/.hreader` 不存在、真实 `~/.hreader` 仍空（`io.home` 注入仍在，回落路径没被触发） |
| T4-③ | `packages/cli/tests/serve-helpers.ts:94` `throw new TypeError(...)` → `return false` | `vitest run packages/cli/tests/units-parent-guard.test.ts` | **18 passed / EXIT=0（不红）** | **静默通过 —— 幸存者**（见下） |

细节：

- **T4-① 是幸存者，且重构后依旧没被覆盖**：
  - 旧版（76 例）：断言直接写在 `#[test]` 内的 `include_bytes!("../icons/icon.ico")` 校验块里，基线也是 76 passed → 删掉断言无从观测。
  - 最新版（79 例，已被并行 writer 重构）：断言搬进 `assert_valid_ico()`（`lib.rs:373`），注释写着“抽成函数就是为了能被伪造样本反向打靶”，并加了三条反向用例 `r7_ico_rejects_empty_directory_with_zero_sizes` / `r7_ico_rejects_dib_without_payload` / `r7_ico_rejects_png_marker_without_ihdr`。**但 IEND 这一条仍无反向样本**：唯一的 PNG 伪造样本是 `PNG_SIGNATURE + PNG_IEND` 共 16 字节（`lib.rs:495-500`），它先被 `assert_eq!(payload.get(12..16), Some(&b"IHDR"[..]))` 担下，所以删掉 IEND 断言后 79 例仍全绿（`/tmp/t41b.log`，`EXIT=0`）。
  - **可执行结论**：再加一条 `r7_ico_rejects_png_with_ihdr_but_no_iend`（payload = `PNG_SIGNATURE` + 4 字节 `IHDR` 占位 + 不含 `PNG_IEND` 尾巴，期望 panic `必须以 IEND 收尾`/`缺少 IEND 收尾`）；否则该断言永不可被反变异保护。注意现有消息是 `第 {index} 档 PNG 缺少 IEND 收尾`，`should_panic(expected=...)` 要保持一致。
- 顺带发现（**非本任务变异引入**）：默认并行 `cargo test` 下出现过一次 `signals::tests::r1_watch_with_reports_each_signal_it_registers` FAILED（`src/signals.rs:222` `assert_eq!(signals, vec![SIGINT, SIGTERM])`），`75 passed; 1 failed`；同代码 `--test-threads=1` 连跑两次全绿，`desktop:check` 正式那一轮也全绿。该组用例用全局 `platform::reset_for_test()`，并行时彼此清状态 → **flaky**。§1.2 的 EXIT=0 属"这一次没踩到"，建议给这组加 `#[serial]` 或改串行。
- **T4-③ 是"守卫本身没被测"的幸存者**：`timerStillHoldsProcess` 的 `throw` 分支只在"对象没有 `hasRef()`"时可达，而唯一调用点 `units-parent-guard.test.ts:245` 传的是真 Node `Timeout`（永远有 `hasRef`），所以变异后 18 例全绿。**但它不影响真正的断言强度**：`expect(timerStillHoldsProcess(...)).toBe(false)` 里若源码漏了 `unref()`，`hasRef()` 返回 true → 该行照样红。也就是说 `throw` 是"防止静默假绿"的兜底，而兜底自己无覆盖——属可接受的弱项，记录在案。

## 5 T5 上轮两个遗留

### 5.1 `launchParentPid` 退化成可选 —— 真幸存者（本轮复现）

变异（副本 `packages/cli/src/run.ts`）：

- `readonly launchParentPid: number;` → `readonly launchParentPid?: number;`
- `launchParentPid: io.launchParentPid,` → `launchParentPid: io.launchParentPid ?? process.ppid,`（即重开 W2 洞的**真实**退化形态）

结果：`tsc --noEmit -p tsconfig.json` → **TSC_EXIT=0**；`vitest run packages/cli` → **EXIT=0，59 files / 645 passed**。

**为什么无法在不读源码的前提下测**：这个缺陷的性质是**采集时机**，不是取值。`process.ppid` 在任何时刻都能读到，`??` 兜底后的值在"父进程还活着"时与正确值**完全相同**——只有"父进程在 `await` 期间退出导致 re-parent"才会显出差别。要观测它必须：(a) 由**父进程**（不是测试进程）在子进程 await 之后退出，让子进程被 init/re-parent；(b) 再断言子进程没有把"新 ppid"当看门狗锚点。vitest 进程内无法改变自己的 ppid（fork 后 ppid 固定为父），构造这条要引入"父=一次性 launcher、子=被测 CLI"的双进程 harness + 时序同步，属于集成/真机层（R3 报告 G-A/G-D 的真机档已在做这件事：`kill -9` 壳 → daemon 自退），单测层用黑盒无法覆盖。因此不是"测试写得差"，而是**单测层不可达**；建议把它降级为"由真机档守护"，并在 `run.ts:44-48` 的注释里保留现在的理由（已有）。

### 5.2 上轮 §7「未执行清单」逐条状态

| # | 上轮未执行项 | 本轮状态 |
| --- | --- | --- |
| 1 | `setsid --fork hr serve --exit-with-parent` 拒启（macOS 无 `setsid`） | **仍未执行**（平台无该命令，不可现场复述）；代码侧判据未变 |
| 2 | "信号没装上仍能退"的直接真机档 | **仍未执行**（未重建 `watch()` 恒失败的壳）；等价证据仍只有上一轮两条（`kill -9` 916ms 自退、`--hold` 到点自退），本轮未新增 |
| 3 | `pnpm verify` 全链路 | **已关闭** → §1.1 EXIT=0、265/2971/四维 100%（上轮最大缺口） |
| 4 | R3 之后重打包 `.app` | **仍未执行**（沿用 07:37 的 release 产物；§3 的 W7 就是用这个 07:37 产物跑的，`APP_OK`） |
| 5 | `--detectOpenHandles` | **仍未执行**（vitest 不支持该 flag，维持上轮结论） |

## 6 边界与残余风险

1. `cargo test` 并行 flaky（§4 `signals::tests::r1_*`）——门禁本身会偶发红，建议串行或加锁。
2. `lib.rs` 的 **IEND 断言无反向覆盖**（§4 T4-①，重构后仍如此）——删掉 79 例全绿；已有 `assert_valid_ico()` 与三条反向样本，只差 IEND 那一条。这是本轮**唯一建议重修的点**。
3. `timerStillHoldsProcess` 的 `throw` 分支无覆盖（§4 T4-③）——可接受弱项。
4. `launchParentPid` 必填性只有真机档守（§5.1）。
5. `desktop:check` 与 `HOME` 沙箱不兼容（§0）——任何"沙箱里跑 desktop:check"的 CI 化都会误重装工具链，需 `RUSTUP_HOME`/`CARGO_HOME` 显式透传。
6. 副本内 `pnpm <script>` 不可用（§0）——后续轮次若用软链 node_modules 的副本，必须直呼原始命令串。

## 7 主树漂移（测试期间并行改稿）

开工 `git log -1` → 收工 `e60d3e4`；`git status --porcelain` 条目 44 → 50，增量都是并行 writer/auditor 的。与本轮判定相关的 3 处：

| 文件 | 漂移 | 对判定的影响 |
| --- | --- | --- |
| `packages/desktop/src-tauri/src/lib.rs` | 图标校验抽出 `assert_valid_ico()`，76 → 79 例 | 已同步进副本并**重跑 T4-① 与 `desktop:check`**（§1.2 第二跑、§4） |
| `.github/workflows/ci.yml` | 新增 `pnpm lint:sh`、`pnpm build` 两步 | 无（本轮 T2 直测脚本本体，不依赖 CI 编排） |
| `scripts/gui/m4.2/lib.sh` | 仅注释改写（`make_dirs` 里 `|| exit 1` 的理由） | 无（脚本行为未变，T3 结果仍成立） |

未漂移的部分：`package.json` 的 `verify`/`lint:sh`、`packages/desktop/scripts/check.sh`、`scripts/gui/m4.2/w7-default-home.sh`、`packages/cli/src/run.ts`、`packages/cli/tests/units-run-home.test.ts`、`packages/cli/tests/serve-helpers.ts` 与副本逐字相同（`diff -rq` 已核）。

## 8 判决

**PASS**

- T1：`pnpm verify` EXIT=0（265 / 2971 / 四维 100%）、`desktop:check` EXIT=0（fmt+clippy `-D warnings`+cargo test 76+3），两门禁**各自独立**成立。
- T2：`lint:sh` 三种反向全部非 0，空集守卫不可绕过。
- T3：W7 守卫在删除前退出（EXIT=1），opt-in + 沙箱 HOME 下只删沙箱同名目录，真实 `~/.hreader` 与真实壳数据目录均未被动，备份/还原有记录。
- T4：② 红在正确位置；① 与 ③ 为**已定性**的幸存者（① IEND 断言无反向样本、③ 兜底分支无覆盖），不构成"门禁假绿"，但 ① 可一行工夫补齐（§6-2）。
- T5：`launchParentPid` 仍是真幸存者且已说清"单测层不可达"的理由；上轮 5 项未执行清单 1 项关闭（`pnpm verify`）、4 项维持并注明原因。

剩余风险清单：见 §6 的 6 条（优先级 1 > 2 > 5 > 3 > 4 > 6）。
