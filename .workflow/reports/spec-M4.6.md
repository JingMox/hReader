# spec-M4.6 — G0：AC 矩阵冻结 / 变异清单 / 歧义点名（测试员，只出规格）

> 依据：`.workflow/cards/M4.6.md`、`docs/03-collaboration-workflow.md` §11.45–§11.50、`.workflow/reports/test-M4.2-r4.md`。
> 基线：`git log -1` = `af7a32c`；`git status --porcelain` 仅 `?? .workflow/cards/M4.6.md`。
> 本文件**只读**仓库：未改任何 `src`/`test`/`package.json`/`ci.yml`/`knip.json`；未跑 `pnpm verify` / `cargo test`（会写 `coverage/`、`target/`）。
> 只跑过只读命令：`cat`/`grep`/`node -e`（内存里模拟断言，不落盘）/`bash -c "$(node -e …)"`（读 package.json 的 `lint:sh` 串，实测 0.054s）。

---

## 0 先说四条会改变施工的结论（协调者请先看）

| # | 结论 | 证据 |
| --- | --- | --- |
| B1 | **G-2 的"删断言"分支不该走**：`payload.len() >= 45` 是**可达**的，能单独赢。最小合法 PNG（签名 8 + IHDR 块 25 + IEND 块 12）恰好 45 字节，但判据只看 `payload.get(12..16)=="IHDR"` 与 `payload.ends_with(&PNG_IEND)`（8 字节序列，**不看 IEND 的 4 字节长度前缀**），所以 **41 字节**样本两侧都过、长度不过。已用 node 逐字节复算：`len=41, ihdr=true, iend=true, ge45=false`（详见 AC-10/AC-11 的构造） | `packages/desktop/src-tauri/src/lib.rs:410-426`（`PNG_SIGNATURE`/`PNG_IEND` 见 `:330-331`） |
| B2 | **`check-ci-parity.mjs` 会撞 knip**：knip 根 workspace 的 entry 只有 `skills/hreader/scripts/hr.mjs` 与 `scripts/**/*.ts`，`scripts/**/*.mjs` **不在其中** → 新文件被判 unused file → `verify` 第 8 步红。要么改 `knip.json`（协调者授权），要么写成 `scripts/check-ci-parity.ts`（但那会进 `tsconfig.json:13` 的 `scripts/**/*.ts`，被 `typecheck` 的 strictTypeChecked 管，且 node 22 直接跑 `.ts` 不可行 → 见 A-1） | `knip.json:35-37`、`tsconfig.json:13`、`eslint.config.mjs`（`**/*.mjs` 块带 `sharedRules`：`max-lines 300`、`complexity 10`、`max-lines-per-function 40`、`no-console: error`） |
| B3 | **新增的两个脚本都不在 `lint:sh` 的覆盖里**：`lint:sh` 的根是 `scripts/gui`（递归），而卡面把两个新脚本放在 `scripts/` 根 → 它们自己的语法永远不会被 `bash -n` 检查。要么扩 `lint:sh` 的根，要么放进 `scripts/gui/`，要么 selftest 自带 `bash -n "$0"`（见 A-6） | `package.json:18`、`ls scripts/gui` 只有 `m4.2/` 下 5 个 `.sh` |
| B4 | **G-3 的判据与"方案①"互斥**：卡面要"把 `reset_for_test()` 调用删掉 → 至少一条红"，但方案①（每用例独占句柄 / `OnceLock`+`Mutex` 的 `TestSignalHub`）会把 `reset_for_test()` 整个删掉，判据无从执行。需要等价的"结构与前置"判据（见 A-8、AC-18） | 卡面 §2 G-3；`packages/desktop/src-tauri/src/signals.rs:118-123`（Unix 版 `reset_for_test`）、`:153`（Windows 空桩） |

补充事实基线（AC 的期望值都从这里来）：

- `verify` 现为 **8 步**：`format:check, lint, lint:sh, typecheck, build, test:coverage, depcruise, knip`（`package.json:26`）。本卡加 2 步 → **10 步**。
- `ci.yml` `checks` job 现为 8 个 `pnpm` 步骤（`install` 除外），行号 `24-31`；`desktop` job 另有一条 `- run: bash packages/desktop/scripts/check.sh`（`ci.yml:52`，**不属于** `checks` 的对照集）。
- cargo 现有用例：`src/*.rs` 共 **80** 条（`lib.rs` 10 条含 `assert_valid_ico` 的 5 条样本用例），`tests/connect_recheck.rs` 3 条。M4.6 加 1 条 → lib **81**。
- `assert_valid_ico` 里 PNG 分支现有 3 条断言（IHDR/IEND/len）与 2 条样本：16 字节（只被 IHDR 拒）、49 字节（只被 IEND 拒）——`len` 那条至今无样本（M4.2-r4 §4 T4-①）。

---

## 1 命令库（可复制；每条都写死 cwd = 仓库根）

```bash
# C1 parity 基线
node scripts/check-ci-parity.mjs; echo "EXIT=$?"
# C2 verify 步骤切分（脚本必须与它同源）
node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts.verify.split("&&").map(s=>s.trim()).join("\n"))'
# C3 ci.yml checks job 里的 pnpm 步骤（顺序即行号顺序）
grep -n '^      - run: pnpm' .github/workflows/ci.yml
# C4 新增文件的 git 入账检查（§11.48）
git status --porcelain | grep '^??' || echo "NO_UNTRACKED"
# C5 cargo lib 全量
(cd packages/desktop/src-tauri && cargo test --lib); echo "EXIT=$?"
# C6 cargo 并行 10 连跑
(cd packages/desktop/src-tauri && for i in $(seq 10); do cargo test --lib 2>&1 | tail -3; echo "run=$i EXIT=${PIPESTATUS[0]}"; done)
# C7 cargo 并发施压（只跑 signals 模块，8 线程，30 轮）
(cd packages/desktop/src-tauri && for i in $(seq 30); do cargo test --lib signals:: -- --test-threads=8 >/tmp/sig.$i.log 2>&1 || echo "RED run=$i"; done; echo STRESS_DONE)
# C8 桌面门禁（不许在 HOME=$(mktemp -d) 下跑，见 test-M4.2-r4 §0）
bash packages/desktop/scripts/check.sh; echo "EXIT=$?"
# C9 lint:sh 原串执行
bash -c "$(node -e 'console.log(require("./package.json").scripts["lint:sh"])')"; echo "EXIT=$?"
# C10 selftest
bash scripts/lint-sh-selftest.sh; echo "EXIT=$?"
# C11 selftest 的阴性对照（若采纳 A-7 的 LINT_SH_CMD 覆盖入口）
LINT_SH_CMD='test -n "$(find scripts/gui -name "*.sh" -print -quit)" && find scripts/gui -name "*.sh" -exec bash -n {} +' bash scripts/lint-sh-selftest.sh; echo "EXIT=$?"
# C12 ICO 新样本定向
(cd packages/desktop/src-tauri && cargo test --lib r7_ico_ -- --nocapture); echo "EXIT=$?"
```

> C5–C7 会写 `target/`（编译产物），属"读仓库源码、写构建缓存"。**10 遍连跑由协调者收口时执行**（§3.6/§11.12：全量门禁只有一个执行者）。G0 只冻结命令与期望值。

---

## 2 AC 矩阵（31 行，逐行可判定）

记号：**P**=正向（必须绿）；**N**=反向（必须红，红在对的位置）。"弄红方式"一列是**该行自己的反例**，不是别的行。

### G-1 `verify` ↔ `ci.yml` 步骤对齐（`scripts/check-ci-parity.mjs`）

| 编号 | 断言 | 命令 | 期望退出码/输出 | 弄红方式（该行的反例） |
| --- | --- | --- | --- | --- |
| AC-1 | P：基线绿，且打印两边步骤表 | C1 | `EXIT=0`；stdout 含 10 个步骤名，末行为 `knip` | 见 AC-2 |
| AC-2 | N：`ci.yml` 少一步必红并**指名** | `cp .github/workflows/ci.yml /tmp/ci.bak && sed -i '' '/- run: pnpm knip/d' .github/workflows/ci.yml && node scripts/check-ci-parity.mjs; echo "EXIT=$?"; cp /tmp/ci.bak .github/workflows/ci.yml`（Linux 去 `''`） | `EXIT≠0`（期望 1）；stdout 含 `缺失` 与 `knip` | 若删了 knip 仍 0 → 脚本是装饰（§11.49 重演） |
| AC-3 | N：`ci.yml` 多一步必红 | 在 `checks` job 末尾加 `      - run: pnpm lint` | `EXIT≠0`；stdout 含 `多余` 与 `lint` | 多一步仍 0 → CI 跑的比本地多也算不对齐 |
| AC-4 | N：乱序必红 | 对调 `ci.yml:25`（`lint`）与 `ci.yml:26`（`lint:sh`）两行 | `EXIT≠0`；stdout 含 `乱序` 与 `lint:sh`/`lint` | **最容易漏**：集合相等就放行的实现会绿 |
| AC-5 | N：`run: \|` 多行块必须 fail-closed | 把 `- run: pnpm knip` 换成 `- run: \|` + 缩进的 `pnpm knip` | `EXIT≠0`；stdout 明确说"不支持多行 run / 无法解析" | 静默跳过 = 可以把门禁藏进多行块里（MV-4） |
| AC-6 | P/N：parity 自身必须挂在 `verify` 里，且在 `format:check` 之后 | `node -e 'const s=require("./package.json").scripts.verify.split("&&").map(x=>x.trim());const i=s.indexOf("pnpm check-ci-parity"),f=s.indexOf("pnpm format:check");console.log({i,f,ok:i>f&&f>=0})'` | `{ ok: true }`（`i` 为 `f+1` 或更大） | 把这一步只写进 `ci.yml` 不写 `verify` → 本地永不查（反向：`ok:false`） |
| AC-7 | P：`ci.yml` 顶部注释与真实步数一致 | `grep -n '与 pnpm verify' .github/workflows/ci.yml` | 命中一行，且数字 = C2 的行数（10）；注释里的"八步"必须改掉 | 注释留着"八步"→ 下一个人按注释数步骤（§11.49 的仪式感同样会骗人） |
| AC-8 | P：脚本只读，不写仓库 | 跑 C1 两次，前后 `git status --porcelain` 逐字相同 | 无差异；两次均 `EXIT=0` | 若实现"临时改 ci.yml 再还原"→ mtime/内容差异会被 AC-8 抓住（§11.47 的"自改自还原"禁用） |
| AC-9 | P：`desktop` job 不参与对照 | 在 `ci.yml:52` 前后加一条 `- run: pnpm lint:sh`（`desktop` job 内，缩进 6 空格以外的层级） | 仍 `EXIT=0` | 若脚本 grep 全文件所有 `- run: pnpm` → 会误报"多余"，把无关 job 拖进对照集 |

### G-2 ICO `len >= 45` 的独立样本

| 编号 | 断言 | 命令 | 期望 | 弄红方式 |
| --- | --- | --- | --- | --- |
| AC-10 | P：新样本存在且绿，样例自带长度自述 | C12 | `1 passed; 0 failed`，字段名形如 `r7_ico_rejects_png_under_45_bytes` | 样本写错（例如总长 ≥45）会走成"别的断言先赢"，见 AC-11 |
| AC-11 | P：**唯一杀手**是长度断言，且 panic 文本钉死数字 | C12，并 `grep -n '至少 45 字节' packages/desktop/src-tauri/src/lib.rs` | 用例用 `#[should_panic(expected = "至少 45 字节")]`；样本内部 `assert_eq!(payload.len(), 41)`；文件名/注释说明"41 = 8 + IHDR 块 25 + IEND 序列 8" | 期望文本写成 `至少`（不带数字）→ 阈值被改也照样绿（弱化 1 步） |
| AC-12 | N：删断言后该用例必红，其余 81 全绿 | 注释掉 `payload.len() >= 45` 三条 assert → C5 | `1 failed; 80 passed`，且红的是新样本（`expect_err` 没拿到 panic） | 删除后仍 `81 passed` → 说明样本没赢在长度上（M4.2-r4 §4 T4-① 重演） |
| AC-13 | P：**不许走删断言分支** | `grep -c 'payload.len() >= 45' packages/desktop/src-tauri/src/lib.rs`；`grep -c '不可达' packages/desktop/src-tauri/src/lib.rs` | 前者 `1`，后者 `0` | 出现"最小 PNG 头尾已 ≥ 45，此断言不可达"注释 → G-2 走错分支，判失败（B1 已证可达） |

**AC-11 的样本构造（照抄即可，已逐字节复算过）**

```rust
// payload = 签名 8 + IHDR 块 25 + IEND 序列 8 = 41 字节 < 45：
// IHDR 侧（payload.get(12..16) == b"IHDR"）与 IEND 侧（ends_with(&PNG_IEND)）都过，
// 只有「至少 45 字节」能拒它。45 的来源：签名 8 + IHDR 块 25 + **完整 IEND 块** 12 = 45，
// 故这条断言的语义是"块结构完整"；本样本差在尾部只有 8 字节 IEND 序列（无 4 字节长度前缀）。
let mut payload = PNG_SIGNATURE.to_vec();
payload.extend_from_slice(&[0, 0, 0, 13]);                                  // IHDR 长度
payload.extend_from_slice(b"IHDR");
payload.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]);      // 16x16 / 8bpp / RGBA
payload.extend_from_slice(&[0, 0, 0, 0]);                                   // IHDR CRC 占位（判据不看 CRC）
payload.extend_from_slice(&PNG_IEND);                                       // 8 字节 IEND 序列
assert_eq!(payload.len(), 41, "样本必须 41 字节：一侧过 IHDR/IEND，一侧过不了 45");
let bytes = fake_ico(&[(16, 16, 41, 22)], &payload);
```

（备选 24 字节样本 = `签名 8 + [0,0,0,4] + "IHDR" + PNG_IEND`，也实测 `ihdr=true/iend=true/ge45=false`，但 IHDR 块不合法；**推荐 41**，它同时满足卡面"IHDR 合法"的措辞。）

### G-3 `cargo test` 并行竞态

| 编号 | 断言 | 命令 | 期望 | 弄红方式 |
| --- | --- | --- | --- | --- |
| AC-14 | P：串行基线绿 | `(cd packages/desktop/src-tauri && cargo test --lib -- --test-threads=1)` | `81 passed; 0 failed`，`EXIT=0` | 修法若引入死锁，串行会挂住 → 首个发现的形态 |
| AC-15 | P：默认并行 10 连跑全绿 | C6 | 10 次全 `EXIT=0`，每次 `81 passed` | 任一轮 `1 failed`（历史症状：`r1_watch_with_reports_each_signal_it_registers` 的 `assert_eq!(signals, vec![SIGINT, SIGTERM])`）|
| AC-16 | P：8 线程并发施压 30 轮全绿 | C7 | 无 `RED` 行 | 这是**概率证据**，见 §5-1；不得单独当"竞态已消失" |
| AC-17 | P：`desktop:check` 两遍独立绿 | C8 ×2 | 两次 `EXIT=0`，各含 `81 passed`（lib）+ `3 passed`（集成） | 单项都不许用"verify 绿"代表（§11.49 延伸） |
| AC-18 | P/N：守卫仍被使用（依赖 A-8 裁定后的形态） | 若方案②：删掉该模块的 `platform::reset_for_test()` 调用 → C5；若方案①：删掉 `TestSignalHub::reset()`/`&mut self` 的独占入口 → C5 | 至少 1 条红（`1 failed; 80 passed`） | 删除 reset 仍全绿 → 说明修复方式其实是"删掉了断言/删掉了用例" |
| AC-19 | P：断言强度不许降 | `grep -F 'assert_eq!(signals, vec![libc::SIGINT, libc::SIGTERM])' packages/desktop/src-tauri/src/signals.rs`；`grep -c 'assert' tests 数'` 对比改动前 | 该行原样存在；`signals.rs` 的 `assert`/`expect` 条数**不减** | 把断言改成 `signals.len() <= 2` 或 `assert!(!signals.is_empty())` → 竞态"修"成了断言变松，必须判红 |

### G-4 `lint:sh` 守卫的负样本固化为 `scripts/lint-sh-selftest.sh`

| 编号 | 断言 | 命令 | 期望 | 弄红方式 |
| --- | --- | --- | --- | --- |
| AC-20 | P：selftest 基线绿且逐 case 打印实测 rc | C10 | `EXIT=0`；三行形如 `case=bad-script rc=1 expect=≠0 PASS` / `case=empty-dir rc=1 …` / `case=missing-dir rc=1 …` | 只打印 `PASS` 不打 rc → 无法判断它是"断言过"还是"没跑"（§11.42） |
| AC-21 | P：case① 语法错脚本 | 见 AC-20 输出 | 该 case `rc≠0`（`bash -n` 报 `syntax error near unexpected token`） | 夹具里的"坏脚本"其实是合法 bash → case 恒红，反被当噪声 |
| AC-22 | P：case② 空目录（0 个 `*.sh`） | 同上 | `rc≠0`（空集守卫 `test -n` 拦住，`xargs` 空输入会 exit 0） | 不造这一 case → MV-13（删 `test -n`）无人抓 |
| AC-23 | P：case③ 目录不存在 | 同上 | `rc≠0`（`find` 遍历错误） | 夹具把目录先 `mkdir` 了 → 该 case 退化成 case② |
| AC-24 | **N（核心判据）**：把 `lint:sh` 换回旧写法，selftest 必红 | C11（`LINT_SH_CMD` 覆盖，若未采纳 A-7 则临时改 `package.json` + 还原） | `EXIT≠0`；并指名 `case=bad-script` 漏网 | 换回 `-exec … +` 后 selftest 仍绿 → 这就是 M4.2 R3/R4 的假绿复现，G-4 未达成 |
| AC-25 | N：`-exec … \;` 形态（§11.47 第二种假绿）也必须被 selftest 抓住 | `LINT_SH_CMD='… -exec bash -n {} \;' bash scripts/lint-sh-selftest.sh; echo "EXIT=$?"` | `EXIT≠0` | 只测 `+` 形态 → `\;` 形态（"报错但 exit 0"）漏网 |
| AC-26 | P：挂进 `verify`（`lint:sh` 之后）与 `ci.yml`（同位置），且被 G-1 的 parity 覆盖 | C2 / C3 + C1 | C2 里 `pnpm lint-sh-selftest` 紧邻 `pnpm lint:sh` 之后；`ci.yml` 同行序；`EXIT=0` | 只挂一处 → 本卡自己违反 G-1（卡面原文） |
| AC-27 | P：隔离性（§11.50） | 并发跑两份：`bash scripts/lint-sh-selftest.sh & bash scripts/lint-sh-selftest.sh & wait` + `git status --porcelain` | 两进程都 `EXIT=0`；仓库无新增文件/无 mtime 变更 | 夹具造在仓库内（如 `scripts/gui/_bad.sh`）→ 并发互踩 + 污染工作树 |
| AC-28 | P：selftest 自身语法可检 | `bash -n scripts/lint-sh-selftest.sh; echo "EXIT=$?"` | `EXIT=0` | 见 B3：`lint:sh` 不覆盖 `scripts/` 根，这一行是它唯一的语法门（或按 A-6 裁定扩容） |

### 全量收口（协调者）

| 编号 | 断言 | 命令 | 期望 | 弄红方式 |
| --- | --- | --- | --- | --- |
| AC-29 | P：`pnpm verify` 一次绿（10 步） | `pnpm verify > /tmp/verify.log 2>&1; echo "EXIT=$?"` | `EXIT=0`；含 `Test Files 265 passed`、`Tests 2971+ passed`、`All files 100/100/100/100` | 任一新增步骤没挂进 `verify` → 步数仍是 8（C2 行数） |
| AC-30 | P：新文件已入账（§11.48） | C4 | 输出 `NO_UNTRACKED`（除本轮明确新建且即将 `git add` 的文件） | 两个新脚本留 `??` → 门禁全绿但产出不在仓库里 |
| AC-31 | P：新脚本过 format/lint/knip | `pnpm format:check && pnpm lint && pnpm knip` 各自取码 | 三者 `EXIT=0`；`knip` 不报 `check-ci-parity` unused | 见 B2：`.mjs` 不改 `knip.json` 时 knip 必红 |

---

## 3 变异清单（16 条；每条回答"不写这个变异会不会漏"）

| # | 靶 | 变异 | 观察命令 | 期望 | 不写这条会漏什么 |
| --- | --- | --- | --- | --- | --- |
| MV-1 | G-1 | `ci.yml` 删 `- run: pnpm knip` | C1 | `EXIT≠0`，指名 `knip` | 漏：parity 只证"集合相等"，缺项是 §11.49 的原病；AC-2 是唯一杀手 |
| MV-2 | G-1 | `ci.yml` 末尾**重复**一条 `- run: pnpm lint` | C1 | `EXIT≠0`，`多余: lint` | 漏：用 Set 比较的实现会绿（多一步 = CI 比本地多跑，§11.49 对称病） |
| MV-3 | G-1 | 对调 `ci.yml:25/26`（`lint` ↔ `lint:sh`） | C1 | `EXIT≠0`，`乱序` | 漏：**集合语义**的 parity 是本卡最容易被写成"看起来对"的形态——`&&` 串联的 fail-fast 语义正是靠顺序 |
| MV-4 | G-1 | 把 `- run: pnpm knip` 改成 `- run: \|` 块内写 `pnpm knip` | C1 | `EXIT≠0`（fail-closed） | 漏：多行块里的 pnpm 不被"行级 grep"看见 → 门禁可被藏起来；**若脚本选择"忽略无法解析的 run"，这条变异全绿** |
| MV-5 | G-1 | `verify` 里删掉 `pnpm check-ci-parity`（只留 `ci.yml` 那步） | AC-6 的 node 单行 | `ok:false` → 判红 | 漏：本地永不查，"本地绿"再次被当 CI 绿（§11.49 重演） |
| MV-6 | G-1 | 把 `verify` 里的 parity 挪到末尾（`knip` 之后） | AC-6 的 node 单行 | 仍 `ok:true`（只要求 `i>f`） | **已知存活**：卡面只要求"在 format:check 之后"，挪末尾不算违规。若协调者要"紧跟 format:check"，改成 `i===f+1`，则此变异须红（A-2） |
| MV-7 | G-1 | `check-ci-parity.mjs` 断言改恒真（`process.exit(0)` / 把比较改成 `if (false)` / 把 diff 清单只 `console.warn` 不 exit） | C1 基线仍 0；**只有**重新手跑 MV-1~MV-4 才暴露 | 无自动门禁能抓（除非做自检，A-5） | **会漏**：这条是"门禁的门禁"。日常 `verify` 只跑基线（必绿），恒真变异全绿。缓解：把 MV-1~MV-4 做成可复现的反例清单（本表 + AC-2..AC-5 命令），结卡时手跑一次并贴码；或采纳 A-5（`--ci <path>` 参数 + selftest） |
| MV-8 | G-2 | 删 `payload.len() >= 45` 三条 assert | C5 | `1 failed; 80 passed`（新样本红） | 漏：这条正是 M4.2-r4 §4 T4-① 的幸存者；AC-12 是它唯一的杀手 |
| MV-9 | G-2 | 把 `>= 45` 改成 `>= 46` | C5 | 仍 `81 passed`（更严，无害） | **无害存活**：无需修；记录以免被当洞。反之改成 `>= 41`/`>= 40` → 样本不再 panic → `1 failed`（自动被 AC-12 抓） |
| MV-10 | G-2 | 删 `ends_with(&PNG_IEND)` | C5 | `1 failed`（红在 `r8b_ico_rejects_png_without_iend_tail`） | 漏：历史变异（M4.2-r4 T4-①）必须继续红，证明新样本没把旧守卫挤掉 |
| MV-11 | G-2 | 删 `payload.get(12..16) == b"IHDR"` | C5 | `1 failed`（红在 `r7_ico_rejects_png_marker_without_ihdr`） | 漏：同上，PNG 分支三道断言的三角覆盖 |
| MV-12 | G-4 | `lint:sh` 改回 `find … -exec bash -n {} +` | C10 或 C11 | `EXIT≠0`，指名 `bad-script` 漏网 | 漏：G-4 的唯一实质判据（卡面 §2 G-4 原文） |
| MV-13 | G-4 | `lint:sh` 改回 `find … -exec bash -n {} \;` | C11 | `EXIT≠0` | 漏：`\;` 是"报错但 exit 0"的假绿，比 `+` 更阴（§11.47）；只测 `+` 会漏掉它 |
| MV-14 | G-4 | 删 `lint:sh` 的空集守卫（`test -n "$(find …)"`） | C10 | `EXIT≠0`（`empty-dir` case 红） | 漏：空集时 `xargs` 拿空输入 exit 0，门禁变装饰；AC-22 是唯一杀手 |
| MV-15 | G-4 | selftest 里把失败的 `exit 1` 改成 `exit 0`（自短路） | C10 | 仍 `EXIT=0` | **会漏**：selftest 没有自己的守卫。缓解：AC-20 要求逐 case 打印实测 rc（人工/Audit 一眼可见），且 MV-12~MV-14 由**协调者结卡时手跑**一次。真正的自动化需要"selftest 的 selftest"（不划算，见 §5-3） |
| MV-16 | G-3 | 竞态施压：把修复退回到全局 `reset_for_test()`（删掉互斥/独占句柄） | C7（30 轮 × 8 线程） | **至少一轮红**（记录轮次与失败用例名） | 漏：10 次连跑全绿**不能**证竞态消失（§5-1）；这条变异给出"判据对症状敏感"的正向证据。若 30 轮全绿，只能写"未复现"，不能写"已消除" |

---

## 4 歧义清单（10 条，需要协调者裁定后才能开工）

| # | 歧义 | 证据 | 建议裁定 |
| --- | --- | --- | --- |
| A-1 | `check-ci-parity.mjs` 放哪、什么后缀？卡面写 `scripts/check-ci-parity.mjs`，但 root 的 knip entry 只收 `scripts/**/*.ts`（B2），`.mjs` 判 unused → `verify` 第 8 步红；改成 `.ts` 又要进 `tsconfig.json` 的 strictTypeChecked + node 22 不能直接跑 | `knip.json:35-37`、`tsconfig.json:13`、`knip` 在 `package.json:26` 末步 | 选 **①`.mjs` + `knip.json` root entry 加 `scripts/**/*.mjs`**（一行，2 处同时改）。白名单须显式包含 `knip.json` |
| A-2 | `verify` 里 parity 的位置：卡面"放在 `format:check` 之后"是"紧随其后"还是"其后任意位置"？决定 MV-6 是否算变异 | 卡面 §2 G-1 | 建议"紧随其后"（`i === f+1`），理由：越早红越省墙钟；若取宽松语义，MV-6 显式记为无害存活 |
| A-3 | `ci.yml` 的步骤识别口径：只认"整行恰好 `- run: pnpm <name>`"，还是容忍 `pnpm -C packages/app build` 这类带参数形态？`checks` job 目前全是简写，但 `desktop` job 有 `bash …check.sh` | `ci.yml:24-31`、`:52` | 建议：`checks` job 只接受 `- run: pnpm <script>`（正则 `^\s*- run: pnpm [^\s]+$`），其余形态 → 非 0 并指名"无法解析"；`desktop` job 整块不参与（AC-9） |
| A-4 | `run: \|`（多行）是否允许？卡面没说。允许 → MV-4 全绿（门禁可藏）；禁止 → 需 fail-closed 实现 | `ci.yml` 现无多行 `run` | 建议**禁止 + fail-closed**（非 0 + "不支持多行 run"），并在脚本头注释写明理由（§11.47-2：判据必须是退出码，不许静默跳过） |
| A-5 | 要不要给 parity 也配 selftest（对称 G-4）？没有 → MV-7（断言恒真）日常不可抓 | 本报告 §3 MV-7 | 建议：脚本支持 `--ci <path>` 与 `--verify <path>`（默认指向仓库文件），selftest 用 `/tmp` 里的副本跑 AC-2..AC-5 四个反例。代价：+1 步、≈0.2s。若不采纳，MV-7 记为"结卡手跑"的已知弱项 |
| A-6 | `scripts/lint-sh-selftest.sh` 的语法谁来检？`lint:sh` 的根是 `scripts/gui`（`package.json:18`），新脚本在 `scripts/` 根 → 永不被 `bash -n` | `package.json:18`、`ls scripts/gui` | 三选一：① selftest 首行自检 `bash -n "$0"`（0 成本，但自证）；② 把 `lint:sh` 根扩成 `scripts`（会连带检 `scripts/` 下所有 `.sh`，语义变宽）；③ 把 selftest 放进 `scripts/gui/`（违背卡面路径）。建议 ①+②其中一个，**别选 ③** |
| A-7 | selftest 怎样被"换回旧写法 → 红"驱动？卡面写"改 `package.json` 的 `lint:sh` 再还原"——这是**改仓库**的动作，不能进日常门禁，也不并发安全 | 卡面 §2 G-4 判据 | 建议 selftest 支持 `LINT_SH_CMD` 环境变量覆盖（默认从 `package.json` 读），于是 AC-24/AC-25 变成一条**只读**命令（C11），可在 CI 里跑 |
| A-8 | G-3 判据与方案①互斥（B4）：`reset_for_test()` 在方案①下会被删 | 卡面 §2 G-3；`signals.rs:118-123` | 裁定等价判据：方案② → 原判据照用；方案① → 改为"删掉独占句柄/reset 入口后 `cargo test --lib` 至少 1 条红"（AC-18 已按此写） |
| A-9 | `cargo test` 10 遍的墙钟与执行者：暖 target 下单跑约 10s 量级 → 10 遍 ≈ 1–3 分钟（G0 未实测，见 §5-5）；且 `cargo` 与 `desktop:check`/并行 writer 共用 `target/`（§11.50） | `ci.yml:52`、`packages/desktop/scripts/check.sh:18` | 裁定：由协调者收口跑（禁止与 `verify` 并发），允许 `--test-threads=8` 施压；并把 C7 的 30 轮作为可选项 |
| A-10 | 新脚本要不要覆盖率？vitest `include` 只有 `packages/*/src/**` + `packages/*/pi-hreader.ts`，`scripts/*` 不进覆盖率 → 四维 perFile 100% 不受影响 | `vitest.config.ts`（`coverage.include`） | 裁定：**不要求**（否则要改 vitest include，属范围扩张） |

---

## 5 不可测项（测试层能证明到哪，不能证明什么）

1. **G-3"竞态消失"不可证，只能证"未复现 + 结构已隔离"。**
   原 flaky 的观测史是 1 次红 / 其余绿（`test-M4.2-r4 §4`），单次触发概率 p 未知。即使 p=0.05，10 遍全绿的概率是 0.95¹⁰ ≈ 60%，30 遍 ≈ 21% ——**全绿不排除竞态仍在**。测试层能给的最强证据是：① 删掉隔离机制后必须红（AC-18，结构性）；② 8 线程 30 轮全绿（概率性，C7）。要更强需要在树里加"显式交错"用例（两线程 + barrier 逼出 `WATCHED` 与 `reset` 的交错），那需要改 `signals.rs` 的测试形态（方案① 顺带能做，方案② 做不了）——**属范围决定，需 A-8 裁定**，G0 不擅自要求。
2. **G-1 只能证明"文本与本地执行正确"，不能证明"GitHub Actions 上真跑了这一步"。** 仓库内没有 CI 运行记录可查；测试层止步于 `ci.yml` 的静态解析 + 本地跑同一脚本。真正的"CI 绿"必须由 push 后的 Actions 日志承担（§11.49-2 的延伸：贴 `ci.yml` grep 行号，不是贴"应该会跑"）。
3. **G-4 的 selftest 自身无自动守卫**（MV-15：把 `exit 1` 改 `exit 0`）。测试层能做的：AC-20 强制逐 case 打印实测 rc（读数可被判读），加"结卡手跑一次 MV-12/13/14"。要自动化就得做 selftest 的 selftest，即对"一个已知坏的 lint:sh 命令"断言 selftest 必红——这正是 A-7 的 `LINT_SH_CMD` 覆盖能顺手给出的一半（坏命令必须让 selftest 红），另一半（selftest 自己短路）仍不可测。
4. **`scripts/*.sh` 的语法无门禁**（B3/A-6）：若裁定不扩 `lint:sh` 根，则"新 shell 脚本写错语法"这件事在 `verify` 里没有任何一步会红——只能在 review 层看。
5. **墙钟未实测**：G0 不许跑 `cargo test`（写 `target/`）、不许跑 `pnpm verify`。§1 A-9 的 1–3 分钟是估计值；`lint:sh` 实测 **0.054s**（5 个脚本），selftest 三个 case 预计 <0.3s，parity 脚本 <0.1s → 新增两步对 `verify` 的墙钟影响可忽略（`test:coverage` 是分钟级，`format:check`/`knip` 是十秒级）。
6. **非目标不覆盖**：`launchParentPid` 采集时机、`serve-helpers` 的 `hasRef` 兜底（卡面 §3 已裁定接受），本卡 AC 不含它们，勿在审计时算漏。

---

## 6 施工白名单（写者只许动这些；其余一律不改）

| 文件 | 动作 | 授权状态 |
| --- | --- | --- |
| `package.json` | `verify` 加两步（`lint:sh` 后插 `lint-sh-selftest`，`format:check` 后插 `check-ci-parity`）；`scripts` 新增两条脚本名 | 卡面明示 |
| `.github/workflows/ci.yml` | `checks` job 同序加两行；顶部注释"八步"→"十步" | 卡面明示 |
| `scripts/check-ci-parity.mjs` | 新建 | 卡面明示（后缀见 A-1） |
| `scripts/lint-sh-selftest.sh` | 新建 | 卡面明示（位置见 A-6） |
| `packages/desktop/src-tauri/src/lib.rs` | `tests` 模块加 1 条样本用例；断言本体**不动** | 卡面明示（不许走删断言分支，见 B1/AC-13） |
| `packages/desktop/src-tauri/src/signals.rs` | 竞态修法（方案①或②） | 卡面明示（判据见 A-8） |
| `knip.json` | root entry 加 `scripts/**/*.mjs`（仅当 A-1 选 ①） | **需裁定** |
| `docs/03`/其它 `docs/**` | 不动 | 协调者所有 |

---

## 7 本报告的自证（我做了什么 / 没做什么）

- 做：只读 `cat`/`grep`/`ls`/`node -e`（内存计算 41 字节与 24 字节样本的 IHDR/IEND/长度三判据，确认 `len>=45` **可达**）；`bash -c "$(node -e …)"` 跑了一次现行 `lint:sh`（`EXIT=0`，0.054s，5 个脚本）。
- 没做：**没有**跑 `pnpm verify`（§3.6：全量门禁只有一个执行者）、**没有**跑 `cargo test`（写 `target/`）、**没有**改任何文件（除本报告）、**没有** `git add`/`commit`。
- 下一步（给协调者）：先裁 A-1/A-6/A-7/A-8 四条（其余可后置），再按 §6 派写者；写者交付后，测试员按 AC-1..AC-31 逐行贴码，并把 MV-1..MV-16 的实测退出码列进终测报告。
