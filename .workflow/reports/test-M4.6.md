# test-M4.6 — G3 独立验证 + 变异轮（测试员）

- 仓库：`/Users/liu/Documents/Project/hReader`；HEAD = `4bddf61`（`e6007e7`/`4bddf61` 只动 `docs/**`，`git diff af7a32c..HEAD --stat` 确认源码零变化，规格基线 `af7a32c` 仍等价）。
- 工作树：F1 五个已跟踪文件未提交 + 两个新脚本 `??`（`git status --short` 见 §7）。
- 环境：macOS 27.0.1 / 10 核 / node v24.15.0 / pnpm 11.1.3 / cargo 1.98.0。
- **隔离承诺**：仓库源码与配置零改动（`git status --porcelain` 前后逐字比对，见 AC-8 证据）。所有变异在 `/tmp/hreader-m46`（`rsync --exclude node_modules --exclude target`，`node_modules` 与 `packages/*/node_modules` 软链回仓库，`CARGO_TARGET_DIR=/tmp/m46-target` 独立 target）里做。未 `git add` / 未 `push`。
- 未与审计员争用被审文件：全部变异只落 `/tmp` 副本；`cargo` 用独立 target，不碰仓库 `packages/desktop/src-tauri/target`。

---

## 1 结论摘要（AC 31 行折叠成组）

| 组 | AC | 判定 | 证据（命令 → 实测） |
| --- | --- | --- | --- |
| G-1 基线/表 | AC-1 | **PASS** | `node scripts/check-ci-parity.mjs` → `EXIT=0`，打印 `verify[1..10]` + `ci.yml checks[1..10]`，末行 `knip` |
| G-1 缺步 | AC-2 | **PASS** | `/tmp` 副本删 `- run: pnpm knip` → `EXIT=1`，`缺失（verify 有、ci 没有）：knip` |
| G-1 多步 | AC-3 | **PASS（诊断标签有偏差，见 §6-R4）** | 副本 `checks` job 内插重复 `- run: pnpm lint` → `EXIT=1`；但报的是 `乱序：第 11 步 verify=<无> ci=lint`，**不是** `多余：lint`（`多余` 一栏只列"ci 有 verify 没有"的步骤） |
| G-1 乱序 | AC-4 | **PASS** | 对调 `lint`/`lint:sh` → `EXIT=1`，`乱序：第 3 步 verify=lint:sh ci=lint` |
| G-1 多行 fail-closed | AC-5 | **PASS** | `- run: pnpm knip` → `- run: \|` → `EXIT=1`，`不支持多行 run（fail-closed）：- run: \|` |
| G-1 挂载点 | AC-6 | **PASS** | `node -e` 单行 → `{i:1,f:0,j:4,k:3,steps:10,ok:true,selftestAfterLintSh:true}`（D2 取 `i===f+1`） |
| G-1 注释步数 | AC-7 | **PASS** | `grep -n '与 pnpm verify' .github/workflows/ci.yml` → `2:# 与 pnpm verify 的十步一一对应`，C2 行数 10 |
| G-1 只读性 | AC-8 | **PASS** | parity 连跑两次，前后 `git status --porcelain` 逐字相同（`STATUS_UNCHANGED`）；脚本只 `readFileSync` + `mkdtemp` 到 `os.tmpdir()`，`finally rmSync` |
| G-1 job 边界 | AC-9 | **PASS** | `desktop` job 内插 `- run: pnpm lint:sh` → 仍 `EXIT=0`（`checksJobLines` 以 `^ {2}\S.*:$` 截断） |
| G-2 新样本 | AC-10 | **PASS** | `cargo test --lib r7_ico_` → `4 passed`，含 `r7_ico_rejects_png_under_45_bytes ... ok` |
| G-2 唯一杀手 | AC-11 | **PASS（形态与 spec 不同，见 §6-R5）** | 未用 `#[should_panic]`，改 `catch_unwind` + `message.contains("至少 45 字节")`（`lib.rs:559-563`），样本内 `assert_eq!(payload.len(), 41)`（`lib.rs:548`）；panic 文本在 `lib.rs:424` 钉死数字。等价且更严（断言的是"赢在长度"而非"panic 了"） |
| G-2 删断言必红 | AC-12 | **PASS** | `/tmp` 副本把 `payload.len() >= 45` 改恒真（`>= 0`）→ `1 failed; 80 passed`，红 = `r7_ico_rejects_png_under_45_bytes`（`lib.rs:559`，`expect_err` 没拿到 panic） |
| G-2 不走删分支 | AC-13 | **PASS** | `grep -c 'payload.len() >= 45'` → `1`；`grep -c '不可达'` → `0` |
| G-3 串行 | AC-14 | **PASS** | `cargo test --lib -- --test-threads=1` → `81 passed; 0 failed` |
| G-3 全量连跑 | AC-15 | **PASS（低功效，见 §6-R1）** | 本机补跑 5 遍全绿（协调者 10 遍）；但旧代码全量 40 连跑也全绿 → 该判据对旧竞态几乎无鉴别力 |
| G-3 并发施压 | AC-16 | **PASS（强）** | 新代码 `cargo test --lib signals:: -- --test-threads=8` × 30 轮 → **0 红**；同命令打旧代码（HEAD 版 `signals.rs`）→ **29/30 红** |
| G-3 桌面门禁 | AC-17 | **PASS** | `pnpm desktop:check` ×2 → 均 `EXIT=0`，各含 lib `81 passed` + 集成 `3 passed` |
| G-3 守卫仍被使用 | AC-18 | **PASS** | 4 处 `platform::Hub::new()` 改 `&platform::GLOBAL` → `3 passed; 2 failed`：`r1_watch_with_reports_each_signal_it_registers`（`left: [] / right: [2, 15]`）+ `r3_register_failure_rolls_back_and_is_not_retried`（`注册失败必须冒泡`）；**串行也红**，见 §6-R1 |
| G-3 断言强度 | AC-19 | **PASS（计数字面下降 1，实为换行合并，见 §6-R2）** | `assert_eq!(signals, vec![libc::SIGINT, libc::SIGTERM])` 原样在 `signals.rs:276`；`grep -cE 'assert|expect'` 11→10，差异仅因 `hub.watch_with(&accepting).expect(...).installed()` 由 2 行并成 1 行，语义条数不变 |
| G-4 selftest 基线 | AC-20 | **PASS** | `bash scripts/lint-sh-selftest.sh` → `EXIT=0`，四行 `case=... rc=1 ... PASS`（逐 case 打印 **实测 rc**） |
| G-4 三反例 | AC-21/22/23 | **PASS** | 同上：`bad-script rc=1`（`bash -n` 语法错）/ `empty-dir rc=1`（`test -n` 拦截）/ `missing-dir rc=1`（`find` 目录不存在） |
| G-4 换回旧写法必红 | AC-24 | **PASS** | `LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +'` → `EXIT=1`，`case=bad-script rc=0 FAIL`（并连带 `empty-dir rc=0 FAIL`） |
| G-4 `\;` 形态 | AC-25 | **PASS** | `LINT_SH_CMD='... -exec bash -n {} \;'` → `EXIT=1`，`bad-script`/`empty-dir` 双 FAIL |
| G-4 挂载点 | AC-26 | **PASS** | `verify` 里 `lint-sh-selftest` 紧跟 `lint:sh`（`j===k+1`）；`ci.yml` 同行序；parity 基线 `EXIT=0` |
| G-4 隔离性 | AC-27 | **PASS** | `bash …selftest.sh & bash …selftest.sh & wait` → 8 行 PASS（2×4），`git status` 无新增/无改动（夹具全在 `mktemp -d` + `trap`） |
| G-4 自身语法 | AC-28 | **PASS** | `bash -n scripts/lint-sh-selftest.sh` → `EXIT=0`；D6 后它已被 `pnpm lint:sh`（根 `scripts`）覆盖 |
| 全量收口 | AC-29 | **PASS** | `pnpm verify` → `EXIT=0`；`Test Files 265 passed (265)`、`Tests 2971 passed (2971)`、`All files 100/100/100/100` |
| 入账 | AC-30 | **PASS（待 `git add`）** | `git status --porcelain`：`?? scripts/check-ci-parity.mjs`、`?? scripts/lint-sh-selftest.sh`（+ 两份报告），无其它未跟踪 |
| 新脚本过三门 | AC-31 | **PASS** | `verify` 内 `format:check`/`lint`/`knip` 均 `EXIT=0`；`knip` 不报 `check-ci-parity` unused（D1/C4 的 `view` 另见 §6-R3） |

**合计：31/31 PASS**，其中 3 条附口径偏差（AC-3 诊断标签、AC-11 断言形态、AC-19 计数字面），均不影响判据成立；1 条（AC-15）判据成立但鉴别力弱。

---

## 2 变异矩阵（16 条 → 实测 KILLED/SURVIVED）

命令模板（全部在 `/tmp/hreader-m46` 副本里，仓库零改动）：
`node scripts/check-ci-parity.mjs --ci /tmp/mvN.yml --verify package.json`；
cargo 变异 = 改副本 `src/*.rs` 后 `CARGO_TARGET_DIR=/tmp/m46-target cargo test --lib`。

| # | 变异 | 结果 | 实测 |
| --- | --- | --- | --- |
| MV-1 | ci 删 `- run: pnpm knip` | **KILLED** | `EXIT=1`；`缺失：knip` |
| MV-2 | checks 内重复 `- run: pnpm lint` | **KILLED** | `EXIT=1`；诊断写 `乱序：第 11 步 verify=<无> ci=lint`（非 `多余`，见 §6-R4） |
| MV-3 | 对调 `lint`/`lint:sh` | **KILLED** | `EXIT=1`；`乱序：第 3 步` |
| MV-4 | `- run: \|` 多行块 | **KILLED** | `EXIT=1`；`不支持多行 run（fail-closed）` |
| MV-5 | `verify` 删 `pnpm check-ci-parity` | **SURVIVED（自动门禁）** | `pnpm verify` 不再执行 parity → 本地永远绿；仅 AC-6 手跑 `{i:-1,f:0,ok:false}` 能抓；若有人手跑 parity，会报 `多余：check-ci-parity` + `乱序`（`EXIT=1`）。自指盲区，见 §6-R6 |
| MV-6 | parity 移到 `verify` 末尾 | **KILLED（若只动 verify）/ SURVIVED（两边同移）** | 只移 verify → parity 自身 `EXIT=1`（`乱序`）；verify+ci 一起移到末位 → parity `EXIT=0`，但 AC-6 手跑 `ok:false`（D2 取 `i===f+1`）。即：**自动门禁只抓不一致，抓不到"一致地挪到末尾"** |
| MV-7 | parity 断言变异 | **分形态：2 KILLED / 1 SURVIVED** | 见下三行 |
| MV-7a | `abort()` 里 `process.exit(1)`→`exit(0)` | **SURVIVED** | 基线 `EXIT=0`；内建 selftest 照常打印四行 `rc=0 … FAIL`，但**整脚本仍退出 0** → `verify` 绿。判据与被告共用同一退出路径（§6-R7） |
| MV-7b | `if (!args.targeted) process.exit(0)`（只毒默认路径） | **SURVIVED** | 基线 `EXIT=0`；把缺 knip / 乱序的 ci.yml 放到默认位置后仍 `EXIT=0`（两针都吞） |
| MV-7c | `const ordered = true \|\| …`（比较结果恒真） | **KILLED** | `EXIT=1`；`case=extra/order rc=0 FAIL` → `[parity] FAIL：selftest 反例没变红`。**写者"断言恒真无自动门禁"的判断只对一半**：改比较结果会被内建 selftest 抓，只有改**退出码管道**才漏 |
| MV-7d | 多行 run 的 `abort` 改 `continue`（静默跳过） | **KILLED** | `EXIT=1`；`case=multiline rc=1 … FAIL`（keyword `多行` 没出现） |
| MV-8 | 删/弱化 `payload.len() >= 45`（改恒真） | **KILLED** | `80 passed; 1 failed` @ `r7_ico_rejects_png_under_45_bytes` |
| MV-9 | 阈值改 `>= 46` | **SURVIVED（无害）** | `81 passed`（更严）。反向 `>= 41` → `1 failed; 80 passed`（被 AC-12 抓） |
| MV-10 | 删 `ends_with(&PNG_IEND)` | **KILLED** | `1 failed` @ `r8b_ico_rejects_png_without_iend_tail`（`lib.rs:526`） |
| MV-11 | 删 `payload.get(12..16)=="IHDR"` | **KILLED** | `1 failed` @ `r7_ico_rejects_png_marker_without_ihdr`（`lib.rs:416`） |
| MV-12 | `lint:sh` 换回 `find … -exec bash -n {} +` | **KILLED** | selftest `EXIT=1`，`bad-script rc=0 FAIL` |
| MV-13 | 换回 `-exec bash -n {} \;` | **KILLED** | `EXIT=1`，`bad-script`/`empty-dir` 双 FAIL |
| MV-14 | 删空集守卫（`test -n`） | **KILLED** | `EXIT=1`，`empty-dir rc=0 FAIL` + `missing-dir rc=0 FAIL` |
| MV-15 | selftest 里 `exit 1`→`exit 0`（自短路） | **SURVIVED** | 默认 `EXIT=0`；**即便喂已知坏的 `-exec +` 命令，仍打印 `…FAIL` 而 `EXIT=0`**（`lint-sh-selftest.sh:78`）。写者判断**正确** |
| MV-16 | 退回全局 `reset_for_test()`（用 HEAD 版 `signals.rs` 打靶） | **KILLED（C7 形态）** | `cargo test --lib signals:: -- --test-threads=8` × 30 轮 → **29/30 红**（`r1`/`r3` 轮换）；但**全量** `cargo test --lib` 40 连跑 0 红（见 §6-R1） |

**计数（按 spec 16 行）**：KILLED **11**（MV-1,2,3,4,8,10,11,12,13,14,16）；SURVIVED **5**（MV-5,6,7,9,15）。其中 **MV-9 是无害存活**（更严阈值），**MV-5/6/7/15 是"门禁自指"盲区**（判定与被判对象共用一个退出码管道）。若按"含形态子项"计：MV-7 三个形态 2 杀 1 存，MV-9 两形态 1 杀 1 存。

### 2.1 若想让 MV-7 / MV-15 可测，最小改法（已做原型验证）

**MV-15（lint:sh selftest 自短路）——2 行，+0.00s**：在 `scripts/lint-sh-selftest.sh` 的最终 `if [ "$failures" -ne 0 ]` 之前插入自调用：

```bash
if [ "${LINT_SH_SELFTEST_INNER:-}" != "1" ]; then
  if LINT_SH_SELFTEST_INNER=1 LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash "$0" >/dev/null 2>&1; then
    echo "selftest 自检失败：已知坏的 lint:sh 命令没有让本脚本变红" >&2
    exit 1
  fi
fi
```

实测（`/tmp` 副本）：正常 `EXIT=0` 总耗时 0.095s；套上 MV-15 变异后 `EXIT=1`（外层退出码不受内层变异影响）。

**MV-7（parity 退出码管道被毒）——独立进程自检，+0.12s**：新建 `scripts/check-ci-parity-selfcheck.mjs`（约 35 行），把 checker 拷进 `mkdtemp` 暂存树的 `scripts/`，写一份变异 `ci.yml` 到该树 `.github/workflows/`，**无参数**跑暂存版 checker，断言 `rc!=0`。判定不依赖 checker 自身 `runSelftest()`。

实测（`/tmp` 副本，`node /tmp/parity-selfcheck.mjs <checker> ci.yml package.json`）：正常 checker → 4 case `rc=1 PASS`，`EXIT=0`，0.12s；MV-7a → `EXIT=1`（4 FAIL）；MV-7b → `EXIT=1`（4 FAIL）。

**残余、不可自动化的那一层**：自检脚本自己的 `exit 0`（"selftest 的 selftest 的 selftest"）。代价指数增长、收益趋零，建议停在上面这两层，并把"结卡手跑 MV-12/13/14 + MV-1..MV-4"写进流程（现 spec §5-3 已是此口径）。

---

## 3 多角度验证（按任务四条 + 额外）

| # | 实验 | 结果 | 解读 |
| --- | --- | --- | --- |
| E1 | `verify` 删 parity 步、只留 `ci.yml` 那步（§11.49 单向缺失方向） | 本地 `pnpm verify` 完全感知不到（parity 不执行）；`ci.yml` 会在 CI 里红；AC-6 手跑 `ok:false` | **门禁无法自证"自己在门禁里"**（哥德尔式）。缓解只能是：① AC-6 那行 `node -e` 进 review checklist；② `ci.yml` 里 parity 排第 2，CI 日志的步骤表本身就是证据；③ 若要自动化，只能让**另一个**已在 `ci.yml` 的第 1 步（`format:check`）去做这行断言，代价是把职责塞进无关脚本 → 不建议 |
| E2 | `checks` job 加重复 `- run: pnpm lint` | `EXIT=1`，但清单里 `多余：无`，真正指出位置的是 `乱序：第 11 步 verify=<无> ci=lint` | 抓得住，只是**标签不贴切**：`多余` 只覆盖"ci 有 verify 没有"，重复步骤落进"乱序"。建议把 `firstDiff` 的措辞改成"第 N 步 起不一致（ci 多出/换位）"，或让 `extra` 用 `Counter` 计重。属可读性，不是洞 |
| E3 | 删 `knip.json` 的 `scripts/**/*.mjs` | `./node_modules/.bin/knip` → **`EXIT=0`（仍绿）** | **D1 不是必要条件**：knip 会把 `package.json` 里 `"check-ci-parity": "node scripts/check-ci-parity.mjs"` 解析成入口。反证：再把该 script 删掉 → knip 报 `Unused files (1) scripts/check-ci-parity.mjs` + `Unlisted binaries (1) check-ci-parity .github/workflows/ci.yml`。见 §6-R3 |
| E4a | `lint:sh` 根 = `scripts`，造 `scripts/evil.sh` 语法错 | `EXIT=1`，`scripts/evil.sh: line 1: syntax error near unexpected token` | 新根生效，`scripts/` 根下的 `.sh` 真被 `bash -n` 覆盖（旧根 `scripts/gui` 覆盖不到） |
| E4b | 放到 `scripts/gui/deep/evil2.sh` | `EXIT=1`，两条错都报（`evil.sh` + `evil2.sh`） | 递归 `find` 对嵌套目录有效；D6 扩根无遗漏 |
| E5 | `--ci`/`--verify` 换到副本路径 | 正常；`--ci` 缺值 → `未知参数/缺少路径` 分支 | 参数化只用于自测，默认路径由脚本自身位置推导，不会误指 |
| E6 | parity 并发安全（构造性） | 每次 `mkdtempSync(join(tmpdir(),"ci-parity-"))` + `finally rmSync`；两次并发调用互不共享路径 | 未见共享状态；未做并发实测（`verify` 只有一个执行者） |

---

## 4 墙钟（本机实测，`/usr/bin/time -p`）

| 命令 | 墙钟 | 备注 |
| --- | --- | --- |
| `pnpm verify`（10 步） | **102.04s**，`EXIT=0` | 265 文件 / 2971 例 / 四维 100% |
| `pnpm desktop:check` #1 | **7.07s**，`EXIT=0` | 暖 `target`；lib `81 passed` + 集成 `3 passed` |
| `pnpm desktop:check` #2 | **6.94s**，`EXIT=0` | 两遍独立绿（AC-17） |
| `pnpm check-ci-parity` | **0.33s** | 含内建 4 case selftest 的两次进程启动 |
| `pnpm lint-sh-selftest` | **0.21s** | 4 case |
| `pnpm lint:sh` | **0.17s** | 根扩到 `scripts` 后仍 <0.2s |
| 新增两步合计 | **0.54s** | 占 `verify` **0.53%**，远低于 10% 阈值 → **无不可接受拖慢** |

拆分估算：新增两步把 `verify` 从 ≈101.5s 抬到 102.04s；`test:coverage`（vitest 265 文件）与 `build` 占绝对主体。结论：**parity + selftest 的墙钟代价可忽略，不构成反对理由**。

---

## 5 未执行清单（含原因）

1. **未跑 `cargo` 的 10 遍连跑于仓库 target**：任务要求不在被审目录制造额外写。改用 `/tmp/m46-target` 独立 target 跑了 5 遍全量 + 30 轮 C7 + 旧代码 40 轮全量/30 轮 C7，样本量已超要求；协调者对仓库 target 的 10 遍结论未被本报告覆盖（但同机同代码）。
2. **未做 `git add` / 未提交**：按任务，入账由协调者收口（§11.48）。
3. **未在 CI（GitHub Actions）上验证**：仓库内无运行记录；本报告止步于 `ci.yml` 静态解析 + 本地跑同一脚本（spec §5-2 已声明）。
4. **未做 `--ci`/`--verify` 的路径越权测试（如 `--ci /etc/passwd`）**：超出卡面；脚本会 `JSON.parse`/解析失败而 abort，非静默。
5. **未验证 Windows 侧 `Hub` 空桩的编译**：本机只有 Unix target；`cargo check --target x86_64-pc-windows-msvc` 需额外链路，且 `check.sh` 在 CI 三 OS 矩阵里覆盖（`ci.yml:44-52`）。
6. **未做 selftest 的并发隔离 mtime 级验证**：只做了 `git status` 内容级比对（并发两进程 + 无新增文件），未做 `stat` mtime 快照。
7. **未量化"旧竞态在 CI 机器上的 p"**：只在本机测得旧代码"全量绿 40/40、`signals::` 过滤红 29/30"，不能外推。

---

## 6 新风险（按严重度）

- **R1（高，证据级）：AC-15 的"全量 10 连跑"几乎无鉴别力，真正的杀手是"过滤后 8 线程 30 轮"。**
  实测旧代码（HEAD 版 `signals.rs`）：全量 `cargo test --lib` **40 连跑 0 红**；`cargo test --lib signals:: -- --test-threads=8` **29/30 红**；`cargo test --lib signals::`（默认并行）10/10 红。
  推论：① 历史"1 红 / 其余绿"很可能来自**全量套件**下信号用例被大量其它测试错开调度，隔离后反而几乎必红；② 任何"10 遍全绿"的门禁都**不能**作为竞态已修的判据，C7 才是；③ 建议把 C7（`signals::` + 8 线程 × 30）写进 `desktop:check` 或卡面必跑项，否则下次退化无人发现。
- **R2（低）：AC-18 的反向验证给出的是"确定性"失败，不是"竞态复现"。**
  把 `Hub::new()` 换成 `&platform::GLOBAL` 后，**`--test-threads=1` 也红**（`r3` 先跑把 `GLOBAL.failed` 置真 → `r1` 的 registrar 永不被调用 → `left: []`）。所以该反向验证证明的是"共享全局状态导致错值"，**不能**当作"竞态窗口被消除"的证据；"竞态消失"仍只能按 spec §5-1 记为"未复现"。
- **R3（中）：D1（`knip.json` 加 `scripts/**/*.mjs`）无必要，且轻微削弱 knip。**
  实测：去掉该 entry，`knip` 仍 `EXIT=0`（因 `package.json` 的 script 引用被解析为入口）；把 entry 保留后，`scripts/` 下**任何**未被引用的 `.mjs` 都会被当成 entry 而永不报 unused（已用 `scripts/zzz-unreferenced.mjs` 实测：无 entry 时被报 unused，有 entry 时静默）。B2 的前提（"knip 只收 `scripts/**/*.ts`"）在本机 knip 5.81 下不成立。建议：**撤回这一行**，或收窄为 `"scripts/check-ci-parity.mjs"`；无论哪种都需重跑 `verify`。这是本卡唯一"改了但不需要改"的地方。
- **R4（低）：parity 的"多余"诊断标签不贴切**（重复步骤落进"乱序"）。见 §3-E2。
- **R5（低）：G-2 新样本的断言形态与 spec 不同**（`catch_unwind` + 文本断言，而非 `#[should_panic(expected=…)]`）。功能更强（钉住"赢在长度断言"），但 **AC-11 的字面判据无法原样套用**；若后续有人按 spec 回改成 `#[should_panic(expected="至少 45 字节")]`，会丢掉"不是 IHDR/IEND 兜住"这层信息。建议把 spec AC-11 的措辞改成"panic 文本必须含数字 45"而不是钉死宏形态。
- **R6（中）：`MV-5`（verify 删 parity）在自动门禁里不可见**——自指盲区，只能靠 review 时手跑 AC-6。若这张卡之后有人"整理 verify 顺序"，可能把 parity 拿掉而无人红。缓解见 §3-E1。
- **R7（中）：两个 selftest 的判据都挂在"被告自己的退出码"上**（MV-7a/b、MV-15 全绿）。已给最小改法与原型（§2.1，+0.12s / +0.00s）；**不采纳也可以**，但必须在卡面写明"结卡手跑 MV-1..MV-4、MV-12..MV-14"，否则下次重构会把这两层防线一起改哑。
- **R8（低，构造性）：`checksJobLines` 用 `^ {2}\S.*:$` 认 job 边界。** 若未来 `checks` job 里出现 2 空格缩进的映射键（例如把 steps 提平成 `  services:` 之外的写法），会被误判为 job 结束。当前 `ci.yml` 无此形态；属"YAML 文本解析"的固有脆性，值得在脚本头注释里点明（现已注释了"只认整行 `- run: pnpm <script>`"，但没写边界规则）。
- **R9（低）：`pnpm verify` 现在会跑 6 个子进程级自测**（parity 的 4 case + lint 的 4 case）。并发两个 `verify` 时 parity 用 `mkdtemp` 互不冲突，但 `lint:sh`/`knip` 会共享 `node_modules/.cache`；`verify` 本就规定单执行者（§11.12），仅记录。

---

## 7 复现方式

```bash
# 0) 环境
cd /Users/liu/Documents/Project/hReader          # HEAD=4bddf61（源码等价 af7a32c）
git status --short                               # 期望：5 M + 2 ??（脚本）+ 报告

# 1) 副本（所有变异都在这里做，仓库零改动）
rm -rf /tmp/hreader-m46 /tmp/m46-target
rsync -a --exclude node_modules --exclude 'packages/desktop/src-tauri/target' ./ /tmp/hreader-m46/
ln -s "$PWD/node_modules" /tmp/hreader-m46/node_modules
for d in packages/*/; do [ -d "$d/node_modules" ] && ln -s "$PWD/$d/node_modules" "/tmp/hreader-m46/$d/node_modules"; done
cd /tmp/hreader-m46

# 2) G-1 变异（用 --ci/--verify 打靶，脚本本身只读）
cp .github/workflows/ci.yml /tmp/ci.base.yml
grep -v -- '- run: pnpm knip' /tmp/ci.base.yml > /tmp/mv1.yml
node scripts/check-ci-parity.mjs --ci /tmp/mv1.yml --verify package.json; echo "MV1 EXIT=$?"   # 期望 1 + 缺失 knip
awk '/^  desktop:/{print "      - run: pnpm lint"} {print}' /tmp/ci.base.yml > /tmp/mv2.yml
node scripts/check-ci-parity.mjs --ci /tmp/mv2.yml --verify package.json; echo "MV2 EXIT=$?"   # 期望 1（报乱序）
python3 - <<'PY'
L=open('/tmp/ci.base.yml').read().split('\n')
a=next(i for i,l in enumerate(L) if l.strip()=='- run: pnpm lint')
b=next(i for i,l in enumerate(L) if l.strip()=='- run: pnpm lint:sh')
L[a],L[b]=L[b],L[a]; open('/tmp/mv3.yml','w').write('\n'.join(L))
PY
node scripts/check-ci-parity.mjs --ci /tmp/mv3.yml --verify package.json; echo "MV3 EXIT=$?"   # 期望 1 + 乱序
sed 's|      - run: pnpm knip|      - run: \|\n        pnpm knip|' /tmp/ci.base.yml > /tmp/mv4.yml
node scripts/check-ci-parity.mjs --ci /tmp/mv4.yml --verify package.json; echo "MV4 EXIT=$?"   # 期望 1 + 多行 fail-closed

# 3) MV-7 三形态（改副本脚本）
sed 's/  process.exit(1);/  process.exit(0);/' scripts/check-ci-parity.mjs > /tmp/p7a.mjs   # 需整文件替换后再跑
#   MV-7c: 把 `const ordered =` 后接 `true ||`            -> EXIT=1（被内建 selftest 抓）
#   MV-7d: 多行 abort 改 `continue;`                        -> EXIT=1
#   MV-7a/b: 改退出管道                                     -> EXIT=0（存活）
node /tmp/parity-selfcheck.mjs <checker> .github/workflows/ci.yml package.json  # 原型：能抓 7a/7b

# 4) MV-12/13/14/15（selftest）
LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash scripts/lint-sh-selftest.sh; echo "MV12 EXIT=$?"  # 1
LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} \;' bash scripts/lint-sh-selftest.sh; echo "MV13 EXIT=$?" # 1
LINT_SH_CMD='find {} -name "*.sh" -print0 | xargs -0 -n1 bash -n' bash scripts/lint-sh-selftest.sh; echo "MV14 EXIT=$?" # 1
sed 's/^  exit 1$/  exit 0/' scripts/lint-sh-selftest.sh > /tmp/st.sh && cp /tmp/st.sh scripts/lint-sh-selftest.sh
LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash scripts/lint-sh-selftest.sh; echo "MV15 EXIT=$?" # 期望 1，实测 0（存活）

# 5) G-2 + G-3 变异（副本，独立 target）
cd /tmp/hreader-m46/packages/desktop/src-tauri
export CARGO_TARGET_DIR=/tmp/m46-target
cargo test --lib                                            # 81 passed
python3 -c "p='src/lib.rs';s=open(p).read();open(p,'w').write(s.replace('payload.len() >= 45','payload.len() >= 0'))"
cargo test --lib                                            # 80 passed; 1 failed（MV-8）
git -C /tmp/hreader-m46 checkout -- packages/desktop/src-tauri/src/lib.rs
git -C /Users/liu/Documents/Project/hReader show HEAD:packages/desktop/src-tauri/src/signals.rs > src/signals.rs
for i in $(seq 30); do cargo test --lib signals:: -- --test-threads=8 2>&1 | grep -q FAILED && echo "RED run=$i"; done  # 旧代码 ≈29/30 红
cp /Users/liu/Documents/Project/hReader/packages/desktop/src-tauri/src/signals.rs src/signals.rs
for i in $(seq 30); do cargo test --lib signals:: -- --test-threads=8 2>&1 | grep -q FAILED && echo "RED run=$i"; done  # 新代码 0 红

# 6) AC-18（删独占入口）
python3 -c "p='src/signals.rs';s=open(p).read();open(p,'w').write(s.replace('let hub = platform::Hub::new();','let hub = &platform::GLOBAL;'))"
cargo test --lib signals:: -- --test-threads=1    # 3 passed; 2 failed（r1 left:[]/right:[2,15]、r3 注册失败必须冒泡）

# 7) 墙钟（仓库内，单执行者）
cd /Users/liu/Documents/Project/hReader
/usr/bin/time -p pnpm verify          # 102.04s  EXIT=0
/usr/bin/time -p pnpm desktop:check   # ~7s     EXIT=0（跑两遍）
```

证据日志（本机）：`/tmp/verify-m46-test.log`、`/tmp/desktop-check-m46-test.log`、`/tmp/desktop-check-m46-test2.log`、`/tmp/mv7c.log`、`/tmp/mv7d.log`、`/tmp/mv15-2.log`。

---

## 8 本报告的自证（做了什么 / 没做什么）

- 做：`pnpm verify` ×1（102.04s）、`pnpm desktop:check` ×2、`pnpm check-ci-parity`/`lint-sh-selftest`/`lint:sh` 各计时、`cargo test --lib` 多形态（副本独立 target：全量 5 遍、C7 新/旧各 30 轮、旧代码全量 10 轮、串行、4 次变异）、`git show HEAD:` 取旧文件打靶、`node`/`bash` 只读断言若干、`/tmp` 副本 16 条变异 + 2 个最小改法原型。
- 没做：**没有**改仓库任何 `src`/`test`/`package.json`/`ci.yml`/`knip.json`（`git status --porcelain` 前后逐字相同）；**没有** `git add`/`commit`/`push`；**没有**在仓库 `target/` 里写；**没有**碰审计员正在读的文件（只 `cat`/`grep`）。
- 交付物：仅本文件。
