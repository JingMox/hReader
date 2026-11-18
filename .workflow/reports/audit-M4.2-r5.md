我无法执行 shell（本会话无 bash/git 工具，仅有 read/grep/find/ls/watchdog_diff），因此凡需运行的项一律标注**未执行**并给出交给协调者的命令；能静态钉死的全部给到文件:行。以下为完整交付物（应写入 `.workflow/reports/audit-M4.2-r5.md`，本会话无写工具，请协调者代录）。

---

# M4.2 R6 终审（G2⁗ CHANGES-NEEDED 后返工复核 + 仓库级事故）

## 一、逐项判定

> **能力边界（先声明）**：本会话**没有 shell/git**。凡"命令+退出码"项，标 `未执行`，附**协调者必跑命令**；其余结论均来自源码/索引/未跟踪清单的直接读取，逐条给文件:行。

### 1. P1-1 `ac20-gui-size.sh` 是否已删 —— **真修 ✓**

- 静态证据：`ls scripts/gui/m4.2/` = `lib.sh`/`w1-signal-exit.sh`/`w2-launch-window.sh`/`w2-parent-death.sh`/`w7-default-home.sh`（5 个）；`grep -rn ac20` 全仓**只命中 `.workflow/reports/**`**（历史报告），`docs/**` 零命中。
- `docs/05-feature-cards.md:400` 现文：「`scripts/gui/m4.2/`（… `w7-default-home.sh` 默认 home）」——`ac20` 已不在清单里。
- 未执行：`grep -rn ac20 docs/ ; echo EXIT=$?`（期望 `EXIT=1`）。

### 2. P1-2 `HREADER_GUI_REAL_HOME=1` opt-in —— **真修 ✓，四处口径一致**

- ①② `scripts/gui/m4.2/w7-default-home.sh:11-14`：`shell_store="$HOME/…"`（:11）→ 注释（:12）→ **守卫**（:13）`[ "${HREADER_GUI_REAL_HOME:-}" = "1" ] || { echo "W7 会删真实壳数据目录 ${shell_store}；…" >&2; exit 1; }` → **`rm -rf` 在 :14**。守卫严格在 `rm -rf` 之前；echo 打的是 `${shell_store}` 展开后的**真实绝对路径**；非 `1`（含 `true`/空/未设）一律 `exit 1`。`${}` 定界在 `set -u` 下正确（R5 自述的 `$shell_store；` 误报已避开）。
- ③ 两份文档措辞**逐字一致且与脚本相符**：`docs/02-architecture-and-roadmap.md:346` 与 `docs/05-feature-cards.md:400` 都是「`--home` 一律指向 `mktemp -d` 沙箱；**W7 是唯一例外**：它故意使用真实壳 app data 目录并在开头 `rm -rf` 它，脚本因此要求 `HREADER_GUI_REAL_HOME=1` 才继续——跑之前备份、并确认无在跑实例」。"一律沙箱 HOME"的反话已消失。附带核对：`w1-signal-exit.sh:11`、`w2-launch-window.sh:22`、`w2-parent-death.sh:14` 全部 `--home "$root/home"`，'一律' 这个全称判断现在为真。
- ④ `scripts/gui/m4.2/lib.sh:5-7` 头部纪律注释已同步（"W7 是唯一例外…要求 `HREADER_GUI_REAL_HOME=1` 才继续"）。
- 未执行：`env -u HREADER_GUI_REAL_HOME bash scripts/gui/m4.2/w7-default-home.sh; echo EXIT=$?`（期望打印真实路径、`EXIT=1`），以及 `ls -d "$HOME/Library/Application Support/com.hreader.desktop"` 仍在。

### 3. P1-3 `units-run-home.test.ts` 守卫 —— **断在运行时 `homedir()` 上 ✓；变异复现：未执行**

- `packages/cli/tests/units-run-home.test.ts:13-14` `const sandbox = realpathSync(mkdtempSync(…)); process.env["HOME"] = sandbox;`，`:51-53` 守卫 = `expect(homedir().startsWith(sandbox)).toBe(true)`（**调的是 `node:os` 的 `homedir()`，不是本文件变量**）。被测接缝在 `packages/cli/src/run.ts:189` `home: io.home ?? homedir()`（在位，已核）。
- 失败方向已安全：接线一断，`run.ts:189` 回落到被重定向的 `sandbox`，**不会**碰真实 `~/.hreader`（这是 R2 事故的反面）。`homedir()` 在 POSIX 上每次调用读 `$HOME`（uv_os_homedir，无缓存），所以运行期改 `process.env` 有效。
- **未执行**（本会话无 shell）——协调者必跑（备份 `run.ts` 到 `/tmp`，赛后还原）：
  ```
  md5 -q ~/.hreader/daemon.json 2>/dev/null   # 若存在，赛前赛后必须一致
  cp packages/cli/src/run.ts /tmp/run.ts.bak
  perl -0pi -e 's/home: io\.home \?\? homedir\(\),/home: homedir(),/' packages/cli/src/run.ts
  pnpm vitest run packages/cli/tests/units-run-home.test.ts ; echo EXIT=$?   # 期望 EXIT=1
  cp /tmp/run.ts.bak packages/cli/src/run.ts
  pnpm vitest run packages/cli/tests/units-run-home.test.ts ; echo EXIT=$?   # 期望 EXIT=0
  ```
- 静态判定：删接线后 `:55-74` 的第二条用例必红（daemon.json 落在 `sandbox` 而非注入的 `home`），`expect(appeared).toBe(true)` 失败 ⇒ 门有效。

### 4. P2 `lint:sh` 空集守卫 —— **修法正确，三连自证：未执行**

- `package.json:18`：`test -n "$(find scripts/gui -name '*.sh' -print -quit)" && find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n`。
- 静态判定：`scripts/gui` 被移走/改名 → `find` 失败 → `$()` 空 → `test -n` 假 → **`&&` 短路，EXIT=1**（不再被管道尾命令吃掉）；空目录同理。每文件一次调用仍保留（`-print0 … -n1`）。R4 的两条假绿（空集 + `find` 失败）双关。
- **未执行**：`pnpm lint:sh; echo EXIT=$?`（0）→ `mv scripts/gui /tmp/hreader-scripts-gui-bak && pnpm lint:sh; echo EXIT=$?`（1）→ `mv /tmp/hreader-scripts-gui-bak scripts/gui && pnpm lint:sh; echo EXIT=$?`（0）→ `git status --porcelain scripts/gui` 应**无输出**。

### 5. P2 `timerStillHoldsProcess` 缺 `hasRef` —— **已 throw ✓**

- `packages/cli/tests/serve-helpers.ts:95`：`if (typeof hasRef !== "function") throw new TypeError("timer 没有 hasRef()：无法证明 unref()");`，`:96` `return Reflect.apply(hasRef, timer, []) === true;`。R4 的"缺失即返回 false ⇒ 断言恒绿"已关闭。（本条纯静态即可定，无需增补。）
  残余（P3，不修）：`pollTimerOf` 返回 `undefined` 时现在会 **throw** 而非红在断言上——失败方向仍是"红"，可接受。

### 6. P2 `lib.rs` ICO 断言 vs 102 字节伪造 —— **PNG 路线已挡，DIB 路线仍可伪造（P2 未全修）；cargo 未执行**

- 新增断言：`packages/desktop/src-tauri/src/lib.rs:331` `PNG_IEND`；`:418-423` PNG 档 `assert!(payload.ends_with(&PNG_IEND))`；`:425-427` DIB 档 `assert_eq!(bit_count, 32)`。注释 `:373-375` 已从"贵过真图"改成"**要贵过空目录**……但仍不还原整张图"——**注释不再声称做不到的事 ✓**。
- **但 R4 的 102 字节伪造仍有一条活路（构造法，静态推导）**：6 + 4×16 = 70 字节目录 + 4×8 字节 payload = **102 字节**，四档各给 `28 00 00 00 00 00 00 00`（DIB 签名）、`size=8`、`bit_count=32`、offset 70/78/86/94。逐条过：`size>0` ✓、`offset>=previous_end` ✓、`end<=len` ✓、`starts_with(DIB_HEADER_SIGNATURE)` ✓、`bit_count==32` ✓。真正的 `BITMAPINFOHEADER` 是 40 字节，而测试**没查 payload 长度 ≥ 40 / `u32::from_le_bytes(payload[..4])==40`**。
- 最小修法（2 行，在 `:425` 的 else 分支里加上）：
  ```rust
  assert!(payload.len() >= 40, "第 {index} 档 DIB 短于 40 字节 BITMAPINFOHEADER");
  ```
- 未执行：`cd packages/desktop/src-tauri && cargo test r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes ; echo EXIT=$?`（期望 `1 passed`）。风险量级不变：真 `icons/icon.ico` 是 4 档 PNG+IEND，Windows 侧无坏图标风险；这是"守门人仍可被更容易地骗过"。

### 7. 仓库级事故（`packages/desktop` 从未入 git，`db74ef2` 补登记）—— **实质已闭合 ✓**

- ① **入账状态成立**。三条独立静态证据：(a) `.git/index` 里能找到 `packages/desktop/src-tauri/icons/icon.ico`（grep 命中 `index:9589`）；(b) 本轮未跟踪清单里**没有任何 `packages/desktop/**` 条目**（`watchdog_diff` 的 untracked 列表，逐个文件粒度）；(c) `.git/logs/HEAD:71` 有 `02f2649 → db74ef2 … fix(repo): 补登记 packages/desktop（M4.1/M4.1.1 产出此前从未入 git）`，紧随 `29a3735 docs(03): §11.48`。
- 磁盘文件数（`find` 已按 `.gitignore` 隐去 `target/`、`gen/schemas/`、`node_modules`）= **36**：`README.md`、`accels.json`、`package.json`、`scripts/check.sh`、`src-tauri/{Cargo.lock,Cargo.toml,accels.json,build.rs,tauri.conf.json}`、`src-tauri/icons/{icon.icns,icon.ico,icon.png}`、`src-tauri/src/*.rs` **15 个**、`src-tauri/tests/connect_recheck.rs`、`src-tauri/tests/fixtures/daemon/*.json` **7 个**、`src-tauri/ui/index.html`。
  未执行对照：`git ls-files packages/desktop | wc -l ; echo EXIT=$?`（期望 `36`）。
- ② `.gitignore` 只忽略该忽略的 ✓：桌面相关仅 `packages/desktop/src-tauri/target/`、`packages/desktop/src-tauri/gen/schemas/`（`.gitignore:18-20`），**没有**包级/宽通配忽略；`packages/desktop` 下**没有任何** `.gitignore`（`find **/.gitignore` = 0）。`icons/*`、`Cargo.lock`、`fixtures/` 均未误伤。
- ③ §11.48 规矩**半可机械执行**（P2）：`docs/03-collaboration-workflow.md:847` 的 `git status --porcelain | grep '^??'` 机器可跑，但带"或只剩本轮明确要新建"的豁免——豁免靠人判，等于回到事故成因（"?? 被当噪声"）。且仓库里**没有任何脚本/CI 步骤**执行它（`package.json:11-31` 无相应 script，`.github/workflows/ci.yml` 无该 step）。最小修法：新增 `"gate:ledger": "test -z \"$(git status --porcelain | grep '^??' | grep -v -E '^\\.\\?\\. \\.workflow/')\""`，把 `.workflow/**` 显式列为例外，其余 `??` 一律非 0。
- ④ **没有别的整目录在 git 外**；未跟踪项全是**单文件**，且逐条判都是"本轮该新建"（M4.2 产出），无跨卡漏账：
  `packages/cli/src/parent-guard.ts`、`packages/cli/src/run-serve.ts`、`packages/cli/tests/{serve-helpers,units-parent-guard,units-run-home,units-serve-parent}.test.ts`、`packages/app/tests/accels-cross.test.ts`（AC-7 的 accels 交叉断言）、`rust-toolchain.toml`（AC-22 的固定工具链）、`scripts/gui/m4.2/*.sh`（5 个）、`.workflow/{cards,reports}/**`（按规矩保持未跟踪）。
  **但**：`rust-toolchain.toml:3 channel = "1.98.0"` 与 `packages/app/tests/accels-cross.test.ts` 是**判据级**文件——前者缺席时 CI 的 desktop job（`.github/workflows/ci.yml:38-44` 用 `dtolnay/rust-toolchain@stable`）就是"CI 换版本就红"，AC-22 明文要求 `rust-toolchain.toml` **提交**（`.workflow/reports/spec-M4.2.md:48`）；后者缺席则 M4.2 新增的一条测试在仓里静默消失。这两条必须在**结卡 commit 里显式 `git add`**（见 Findings P2-1）。

### 8. 门禁面 —— **两侧关系已写清楚，但都未执行；`lint:sh` 不在 CI（P2）**

- `verify` 与 `desktop:check` 的关系（上一轮"全绿"漏点的根因）本轮已在**四处**写入判据：`docs/02:346`（"`pnpm verify` 八步 + `pnpm desktop:check` 双绿"）、`docs/05:401`（"桌面侧独立 `pnpm desktop:check`…不塞进 `verify` 以免无 Rust 环境者被卡"）、`.workflow/cards/M4.2.md:151`（"结卡前还要：`pnpm verify` ×2、`pnpm desktop:check`"）、`docs/03:849`（"`pnpm verify`、`desktop:check` 都在工作树里跑…"）。`packages/desktop/scripts/check.sh:22-25` = `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test`，`set -euo pipefail`，**无豁免、无 `|| true`**。R5 的 `lib.rs:410` rustfmt 超长正是 `cargo fmt --check` 能抓的，脚本确实在跑它。
- **未执行**：`pnpm verify ; echo EXIT=$?`、`pnpm desktop:check ; echo EXIT=$?`（两者都需协调者实跑；我只核了脚本内容，不背书 impl-R5 的 `2971 例 / EXIT=0`）。
- P2（新增，非本轮 diff 引入，但与本轮结论相关的漏点）：`.github/workflows/ci.yml:22-29` 的 `checks` job 跑 `format:check/lint/typecheck/test:coverage/depcruise/knip`，**不含 `lint:sh`**，也不含 `pnpm build`（`verify` 里有）。即 R4/R5 两轮修的 shell 门禁**只在开发机上存在**，clone 后 CI 不守。

---

## 二、Findings

**无 P0。**

- **P1 · 全部已修**：P1-1（`ac20` 消失）、P1-2（opt-in + 真实路径回显 + 两份文档同改 + `lib.sh` 头部同步）、P1-3（守卫断在运行时 `homedir()` + `HOME` 重定向，失败方向不再写真实 `~/.hreader`）。

- **P2-1（结卡 commit 完整性，`§11.48` 同类）** `rust-toolchain.toml`、`packages/app/tests/accels-cross.test.ts` 仍在 `??` 里。证据：`watchdog_diff` untracked 清单 + `rust-toolchain.toml:3` + `.workflow/reports/spec-M4.2.md:48`（AC-22 要求"`rust-toolchain.toml` 提交"）。修法：结卡提交**逐条显式** `git add` 上列 6 类路径（cli 两个新 src + 四个新测试 + app 测试 + `rust-toolchain.toml` + `scripts/gui/m4.2/*`），提交后 `git status --porcelain | grep '^??' | grep -v .workflow` 必须为空。

- **P2-2（守门人仍可被更容易骗过）** `packages/desktop/src-tauri/src/lib.rs:425-427` DIB 分支不查 payload 长度/`biSize`，102 字节伪造改走 DIB 仍全过。修法：`assert!(payload.len() >= 40, …)`（2 行）。

- **P2-3（门禁只在本地）** `.github/workflows/ci.yml:22-29` 的 `checks` job 缺 `pnpm lint:sh`（verify 八步只跑了六步；`build` 也缺）。修法：加一行 `- run: pnpm lint:sh`。

- **P2-4（测试卫生，失败方向安全）** `packages/cli/tests/units-run-home.test.ts:14` 把 `process.env["HOME"]` 永久改到 `sandbox`，`:32` 的 `afterAll` 又 `rmSync(sandbox)`，**不还原**——同仓范式（`packages/cli/tests/units-serve.test.ts:108/117`、`:145/175`、`:237/250`、`units-serve-parent.test.ts:56/80`）都是 save/restore。`vitest.config.ts:31` `maxWorkers: 2` ⇒ 同 worker 内后续文件的 `homedir()` 会指向一个**已删除**的目录（`packages/core/tests/style/deps.test.ts:18` 断言 `deps.home === homedir()`，两侧同源所以不红，但这是靠巧合）。修法：模块顶层存 `const previousHome = process.env["HOME"];`，`afterAll` 里先还原再 `rmSync`。

- **P2-5（注释仍不准确，R4 遗留，本轮未改）** `scripts/gui/m4.2/lib.sh:25-26`「`mktemp_root` 走的是 `$(...)` 子 shell，里面的 `exit` 传不出去」——`exit 1` 在 `$()` 里**会**把状态码传给赋值语句（`root=$(mktemp_root …)` 的 `$?`=1，调用点 `|| exit 1` 本来就生效）。传不出的是副作用，不是状态码。修法：改注释为"状态码会传出（调用点已 `|| exit 1`）；这里再挡一次是不依赖调用点"。

- **P2-6（账目/文档）** 本轮"仓库级事故"在**报告里没有落点**：`.workflow/reports/impl-M4.2.md` 只有 `## R1`–`## R5`（无 `## R6` 段，派单所指的 `## R6` 不存在），`.workflow/state.md` 角色表也无 R4/R5/R6 行；事故只记在 `docs/03:835-849`。修法：impl 报告补 R6 段（`git ls-files` 前后计数、`db74ef2` hash、`.gitignore` 判定），或由协调者在 state.md 记一行。

- **P3（报备）** `serve-helpers.ts:93` `pollTimerOf` 返回 `undefined` 时 `timerStillHoldsProcess` 会 throw，错误信息说"无法证明 `unref()`"——方向正确但会掩盖"根本没找到定时器"。可让 `pollTimerOf` 自己 throw。

---

## 三、判决

**PASS —— 本卡可结。**

- 三项 P1 **真修**（静态逐条可证：`ac20` 全仓无痕 / W7 守卫在 `rm -rf` 之前且回显真实路径、四份文档口径一致 / 守卫断在运行时 `homedir()` 且失败方向不再触真实 `~/.hreader`）。
- `packages/desktop` 补登记**实质闭合**：`icon.ico` 在 index 里、untracked 无 `packages/desktop/**`、磁盘 36 文件与 `db74ef2` 提交相符；仓库里**没有第二个整目录**在 git 外。
- 五项 P2 均**不阻塞结卡**（P2-2/P2-3/P2-4/P2-5 各 1–2 行；P2-1 只是 `git add`；P2-6 是补记录）。

**结卡前的两个前置（我做不了，交协调者）：**
1. `pnpm verify ; echo EXIT=$?` 与 `pnpm desktop:check ; echo EXIT=$?` 都要 `EXIT=0`（门禁面只有脚本内容被我复核，数字未复算）。
2. P1-3 的变异复现（§一.3 的四行命令）与 `lint:sh` 三连（§一.4），期望 `EXIT=1 / 0`，并确认真实 `~/.hreader` md5 未变。
3. 提交时按 P2-1 逐条 `git add`（尤其 `rust-toolchain.toml`）。

---

### 摘要（≤300 字）
**PASS，本卡可结。** 三项 P1 真修：`ac20` 全仓归零（`docs/05:400` 只剩 5 个脚本名、`docs/` 零命中）；`w7-default-home.sh:13` 守卫在 `:14` 的 `rm -rf` 之前、回显真实绝对路径、`docs/02:346`+`docs/05:400` 逐字同改且与脚本一致、`lib.sh:5-7` 已同步；`units-run-home.test.ts:14/51-53` 把 `HOME` 指到沙箱并断言运行时 `homedir()`，失败落点不再碰真实 `~/.hreader`。`desktop` 补登记闭合：`icon.ico` 在 index、untracked 无 `packages/desktop/**`、磁盘 36 文件、`db74ef2` 在 `HEAD` 日志；无第二个整目录脱管。P2 五项不阻塞：ICO 的 DIB 分支仍未查 payload≥40（102 字节伪造改走 DIB 仍能过）；CI `checks` job 缺 `lint:sh`；`units-run-home` 不还原 `HOME` 却删沙箱；`lib.sh:26` "exit 传不出"注释仍不准；impl 报告无 R6 段。**本会话无 shell**：`verify`/`desktop:check`/变异复现/`lint:sh` 三连均未执行，命令已列，须协调者跑。