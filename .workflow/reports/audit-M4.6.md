I have no write/edit tool in this session, so I'm returning the complete report for the configured path `.workflow/reports/audit-M4.6.md` (runtime persists it).

---
# audit-M4.6 — M4.6 G2 审计（审计员）

基线：工作树未提交（F1 全在工作树）。静态判定为主；需实跑项列 §6。
审查目标：`scripts/check-ci-parity.mjs`、`scripts/lint-sh-selftest.sh`、`package.json`、`.github/workflows/ci.yml`、`knip.json`、`lib.rs`(41B 样本)、`signals.rs`(独占夹具)。

## 1 Correct（已核实成立）
- **G-2 ICO 41B 样本**：`lib.rs:539-565`。样本长度核实：签名8+IHDR块25+IEND序列8=41（`assert_eq!(payload.len(),41)` 在 `:549-553`）。走查 `assert_valid_ico` `lib.rs:372-455`：`dir_end=22`，`offset=22/size=41/end=63==bytes.len()`，`get(12..16)=="IHDR"` 通过（`:412-417`），`ends_with(&PNG_IEND)` 通过（`:418-421`），仅 `payload.len()>=45`（`:422-426`）失败。panic 文本 `"第 0 档 PNG 至少 45 字节，实际 41"` 含 `至少 45 字节`，且该串**全仓唯一**（仅 `lib.rs:424`，其余命中全在 `.workflow/*` 报告）⇒ 不串台，\"是它赢\"成立。未走删断言分支（`grep -c 不可达`=0）。
- **G-3 独占夹具**：`signals.rs:41-108` `Hub` 是普通结构体（4 个 `AtomicBool`），`Hub::new()` 为 `const fn` 每次返回独立值，**无 `OnceLock`**；`GLOBAL`（`:109`）仅生产路径 `watch()/stopped()/watch_with()` 用。四个用例各 `let hub = platform::Hub::new()`（`:225/236/258/266`）。唯一触 `GLOBAL` 的是 `r3_installed` 的 `watch()`（`:257`）——只它一家写 `GLOBAL.watched`，故无并发争用；`mark_stopped`（`:115-116`）只写 `GLOBAL.stopped`，测试不发真信号。**真独占**。删独占入口=把 `Hub::new()` 换 `&GLOBAL`：`r3_installed` 先置 `GLOBAL.watched=true` 后，`r1`（`:265`）的 `watch_with(registrar)` 走 `:88` 提前 `Ok` 使 registrar 不被调用→`signals=[]` 红；`r3_register_failure`（`:233`）首个 `watch_with` 走 `:88` 返回 `Ok`→`panic!("注册失败必须冒泡")` 红。**红 2 条**成立（与写者实测 `3 passed;2 failed` 一致）。
- **D1** `knip.json:36` root entry 已加 `scripts/**/*.mjs`；脚本为 `.mjs`。
- **D2** `verify`：`format:check`(idx0)→`check-ci-parity`(idx1)，`i===f+1`；`ci.yml` 同序（`ci.yml:24-33` 十步，`install` 白名单跳过）。
- **D4** `run: |` → `readCiSteps:73` fail-closed；`run: >` 亦因 `SINGLE_RUN` 不匹配而 abort。
- **D6** `package.json:18` `lint:sh` 根=`scripts`，`find scripts -name '*.sh'` 递归覆盖 `scripts/*.sh`（含 selftest 自身）与 `scripts/gui/*.sh`；`-n1 xargs` 逐文件 `bash -n`，避免 `-exec +` 只解析首 operand 的原事故。
- **D7** `LINT_SH_CMD` 污染**不可**恒真：环境覆盖后模板无 `find scripts `→`find {} ` 替换不生效，四 case 跑同一命令同一 cwd、rc 相同；而 3 坏要 `!=0`、1 好要 `0`，同一 rc 必有一 case FAIL→selftest 红（fail-closed）。`check_case` 用 `bash -c ... || rc=$?`（在 `||` 列表内），`set -e` 不吞 rc。
- **D8/D10** `reset_for_test` 已双向删除（全仓仅 `.workflow` 命中）；无 `vitest.config` 改动。
- **ci.yml:2** 注释已改\"十步\"，与真实 10 步一致（AC-7）。

## 2 Finding

### P1-1 门禁可被静默旁路：`checks` 步骤的 `continue-on-error` / `if:` / `working-directory` / 作业级 `if: false` 被完全忽略
- 位置：`scripts/check-ci-parity.mjs:66-99`（`readCiSteps`），`checksJobLines:58-64`。
- 证据（静态，可复现）：`readCiSteps` 只消费 `trim()` 以 `- run:` 开头的行；紧随其后的同阶键（8 空格缩进）走 `continue`。因此：
  ```yaml
        - run: pnpm knip
          continue-on-error: true        # 或在步骤上加 if: ${{ false }}
  ```
  或作业级 `    if: false`（`checksJobLines` 只切 `- run:` 行，`if:` 行被跳过），parity 仍判\"同序同集\"→ EXIT=0，但该门禁在 CI 里永不失败/整 job 跳过。这正是本卡主题\"门禁不在 CI 里\"的静默形态，且**当前 `checks` job 无任何 `if:`**，加不进证据限制。
- 最小修法：`readCiSteps` 命中一条 `- run:` 后，收集其后缩进更深的行；若出现 `continue-on-error:`、`if:`、`working-directory:`、`shell:`、`env:` 任一 → `abort(["checks 步骤带可改写执行语义的键：…（§11.49）"])`；并在 `checksJobLines` 块内检测顶格 `    if:` 同样 abort。修后当前 `ci.yml` 仍绿。

### P2-1 selftest 的\"多步\"case 与逐 case 关键词恒真，\"多余\"检出分支零覆盖
- 位置：`scripts/check-ci-parity.mjs:117-119`（abort 三标签恒打印）、`:128-131`（extra 变异插的是重复的 `pnpm lint`）、`:167-171`（`output.includes(keyword)`）。
- 证据：abort 消息**任何**失败都同时打印 `缺失…`/`多余…`/`乱序…` 三行 ⇒ missing/extra/order 三 case 的 keyword 恒真，唯一有效信号是 `rc!=0`。且 extra 变异插的是 `pnpm lint`（verify 已有）⇒ `extra=[]`、实为长度/乱序触发，`多余……：无`。故 `extra` 检出（`ciSteps.filter(!verify.includes)`，`:115`）在任何 selftest 里都未被触发；AC-3 同样用重复 `pnpm lint`，`多余:lint` 之名不成立。若 extra 检出被改坏，无 case 会红。
- 最小修法：extra 变异改为插入**不在 verify 的脚本**（如 `- run: pnpm definitely-not-in-verify`）并断言输出含 `多余……：definitely-not-in-verify`；或让 abort 只打印命中的类别行。

### P2-2 D5 第四个反例被替换为\"多行 run\"，D5 原文要求\"恒真断言\"
- 位置：`.workflow/reports/impl-M4.6.md` 结语；`runSelftest:145-160`。写者已**披露**口径缺口（未谎称落地），故按 P2 记：D5 语义未完全覆盖，\"门禁的门禁\"仍靠结卡手跑 MV-1..MV-4。
- 修法：接受现状或另立卡对 `check-ci-parity.mjs` 做变异；不改本卡范围。

### P2-3 能力边界未在脚本头注释写明
- 位置：`scripts/check-ci-parity.mjs:1-8`。头注释只说\"同序同集\"，未写\"仅比对 `- run:` 行、`desktop` 整块不参与、不保证步骤真会失败（见 P1-1）\"，读者会以为更严。修法：补 2 行边界说明。

## 3 逐裁定核对（D1–D10）
| 裁定 | 结论 |
|---|---|
| D1 | ✅ 落地 |
| D2 | ✅ 落地（两处同序，idx1 紧随 idx0） |
| D3 | ⚠ 正则/白名单/无法解析→非0 均落地；但旁路见 P1-1 |
| D4 | ✅ 落地（`|` fail-closed，`>` 亦被拒） |
| D5 | ⚠ 3/4 case 有效；第4改多行、\"多步\"未真触发（P2-1/P2-2） |
| D6 | ✅ 根=`scripts`，`scripts/*.sh` 真被检 |
| D7 | ✅ 落地且抗污染 |
| D8 | ✅ 独占夹具+删 `reset_for_test`；等价判据静态成立（实跑见 §6） |
| D9 | 移交协调者（本审计不跑） |
| D10 | ✅ 未动 vitest include |

## 4 合并判决
- **OK with notes**：G-2/G-3/G-4 判据真能红且独占、G-4 抗环境、D1/D2/D4/D6/D7/D8/D10 落地；但 G-1 存在 **1×P1 静默旁路**（continue-on-error/if 未被识别），门禁\"同序同集\"在不改对账文件的情况下可被单行 YAML 解除武装。建议修 P1-1 后再结卡；P2 可随卡记。

## 5 待协调者实跑清单（本审计无 shell，未跑）
1. `node scripts/check-ci-parity.mjs; echo EXIT` → 期望 0（基线+4 selftest PASS）。
2. **P1-1 证据**：`cp .github/workflows/ci.yml /tmp/x.yml; perl -0pi -e 's/- run: pnpm knip\n/- run: pnpm knip\n        continue-on-error: true\n/' /tmp/x.yml; node scripts/check-ci-parity.mjs --ci /tmp/x.yml --verify package.json; echo EXIT` → 预期 **0**（即旁路坐实）。
3. 作业级旁路：在 `/tmp/y.yml` 的 `  checks:` 后加 `    if: false` → 预期 **0**。
4. **P2-1 证据**：`/tmp` 副本在 checks 末尾加 `      - run: pnpm nope` → 预期 rc≠0 且明列 `多余……：nope`。
5. `bash scripts/lint-sh-selftest.sh; echo EXIT` → 0；`LINT_SH_CMD='find {} -name "*.sh" -exec bash -n {} +' bash scripts/lint-sh-selftest.sh` → ≠0；`LINT_SH_CMD=true bash scripts/lint-sh-selftest.sh` → ≠0（抗污染）。
6. `cd packages/desktop/src-tauri && cargo test --lib r7_ico_` 与 `cargo test --lib` → 81 passed；删 `>=45` 断言 → `1 failed;80 passed`（MV-8）。
7. D8：把 4 处 `platform::Hub::new()` 换 `&platform::GLOBAL` 跑 `cargo test --lib -- --test-threads=1` → `3 passed;2 failed`。
8. `pnpm verify` / `pnpm desktop:check` 各贴 EXIT；`cargo test --lib` 10 遍（D9）。
---

摘要（≤400字）：P1=1，P2=3，判决 **OK with notes**。
- P1-1（脚本 `check-ci-parity.mjs:66-99`）：`readCiSteps` 只看 `- run:` 行，忽略 `continue-on-error`/`if:` 及作业级 `if: false`，可在不改对账文件下单行 YAML 让 `checks` 门禁永不失败/整 job 跳过，parity 仍 EXIT=0 —— 静默旁路。修法：命中 `- run:` 后检测后续更深缩进键，遇 `continue-on-error`/`if`/`working-directory`/`shell`/`env` 即 abort。
- P2：selftest 逐 case 关键词恒真（abort 三标签恒打印）+ \"多步\"用重复 `pnpm lint` 致 `多余` 分支零覆盖；D5 第4反例被换成多行 run（已披露）；脚本头未写能力边界。
- 已核实成立：41B 样本确由 `44/45` 长度断言单独赢（`至少 45 字节` 全仓唯一串）；`signals.rs` 独占夹具无 `OnceLock`、每用例独立 `Hub`，删独占入口红 2 条成立；D1/D2/D4/D6/D7/D8/D10 落地。

报告路径：`.workflow/reports/audit-M4.6.md`（无写工具，内容已随本回复返回，请落盘）。