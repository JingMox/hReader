# tests-R1 · 测试侧报告（R1 首用路径 / 24 条 TESTS_TO_UPDATE）

> 角色：测试编写员。**只改 `packages/*/tests/**`**，一行 `src/**`、一行 `docs/**` 未动，未 commit、未 push。
> 判据一律取台账（`.workflow/reports/sweep-R1.md` B-01…B-28）的**用户可见症状**，不照实现形态回写断言。

## 1 · 24 条 `TESTS_TO_UPDATE` 逐条结论

| # | file:line（原） | 原断言锁住的错误行为 | 结论 | 现在钉的是什么 |
| --- | --- | --- | --- | --- |
| 1 | 全仓 `Record<HrErrorCode, true>`（`packages/core/tests/hr-error.test.ts`） | 穷举表缺新码 → typecheck 红 | **已改** | 补 `needs_normalize` / `port_in_use` 两键，表恢复完备 |
| 2 | `packages/cli/tests/units-commands.test.ts:55` | B-01 静默空大纲 + 退出 0 | **已改** | 手写稿 `outline` → `HrError{code:"needs_normalize"}` + 文案含 `先跑 hr normalize … --write` |
| 3 | `units-commands.test.ts:96` | B-03 `read` 自己注入 id（盘上没有） | **已改** | 无 id 文档 `read` → `needs_normalize`；另有用例"`normalize` 后 read 出的 id 能 patch" |
| 4 | `packages/cli/tests/units-edges.test.ts:47` | B-03 靠临时注入才成功 | **已改** | 同上，先 `normalize` 再读 |
| 5 | `units-edges.test.ts:57` | B-01/B-03 前置判定缺失 | **已改** | 手写稿 → `needs_normalize`（normalize 后仍保留 `invalid_selector` 用例） |
| 6 | `units-edges.test.ts:68` | 同上 | **已改** | 手写稿 → `needs_normalize`；已 normalize 的文档保留 `node_not_found` |
| 7 | `packages/cli/tests/units-output.test.ts:148` | B-01 空大纲"什么都不说" | **已改** | `humanOutline(空)` === `（没有标题）\n`（现 `:169`） |
| 8 | `units-output.test.ts:156` | B-04 新 id 不外露 | **已改** | `patched a.html (42 bytes, +1 ids: hr-9)\n`；replace 且 id 真变 → `patched b.html (149 bytes, id 变更: hr-a392514c → hr-e5acd1ce)\n`（现 `:177`、`:183`） |
| 9 | `units-output.test.ts:161` | B-16 文本模式没 offset | **已改** | `hr-1:3: boom — …boom…\n`（现 `:188`） |
| 10 | `units-output.test.ts:170` | B-16 主题一致时不说原因 | **已改** | `unchanged a.html (42 bytes，主题已与文档里的 <style id="hr-theme"> 一致)\n`（现 `:199`） |
| 11 | `units-output.test.ts:177` | 命令表八条 | **已改** | `COMMAND_NAMES` 九条且含 `normalize`（现 `:206`） |
| 12 | `units-run-paths.test.ts:92` | B-16 同 #10 | **已改** | 第二次 `style` 的 `unchanged …，主题已与文档里的 …`（现 `:104`） |
| 13 | `units-undo.test.ts:75` | B-05 文案是内部词 | **已改** | `没有可撤销的历史快照`（现 `:84`） |
| 14 | `units-undo.test.ts:105` | B-05 schema 不一致 | **已改** | `{"ok":true,"data":{path,bytes,restoredFrom,sha256}}` 单行 |
| 15 | `units-undo.test.ts:142` | B-05 | **已改** | 子进程 stderr 新文案（现 `:153`） |
| 16 | `units-undo.test.ts:165` | B-05 顶层无 `ok`/`data` | **已改** | 外层键序 `["ok","data"]` + `data` 内四键按契约序 |
| 17 | `packages/cli/tests/units-args.test.ts:8` | 命令表变化 | **已改** | `缺少命令：normalize \| outline \| … \| serve`（文案落在 `args-helpers.ts:11`，`units-args` 复用它） |
| 18 | `units-args.test.ts:12` | 同上 | **已改** | 同上（共享夹具同步） |
| 19 | `cli-exit-codes.test.ts:114` | 同上（子进程版） | **已改** | `缺少命令：normalize \| outline \| read \| patch \| style`（现 `:119`） |
| 20 | `packages/core/tests/io/node-fs.test.ts:24` | B-26 缺 `chmod` | **已改** | IO 键集合含 `chmod`（现 `:26`） |
| 21 | `packages/core/tests/server/unit-arms.test.ts:215` | B-28 端口冲突与"已有 daemon"混为一谈 | **已改** | `EADDRINUSE` → `port_in_use`（现 `:215`/`:234`） |
| 22 | `packages/core/tests/server/unit-branches.test.ts:246` | B-28 同上 | **已改** | `startServer` 层 → `port_in_use`（现 `:246`/`:262`） |
| 23 | `packages/core/tests/server/wire-http.test.ts:191` | B-17 外壳打印 404 链接 | **已改** | 首页含 `/healthz`、不含 `/api/healthz` |
| 24 | `packages/core/tests/entry-points.test.ts:82` | 公开面精确集 | **已改** | 精确集 53 项，含 `hasArticle`（`:48`）、`normalizeFile`（`:58`） |

**判为真回归的：0 条。** 24 条全部是"旧断言锁旧错误行为"，没有一条的实现比原来更差；红过的地方都是断言没跟上新契约，改断言即成立。

## 2 · 新增用例清单（按 B-xx 归组）

`packages/cli/tests/normalize.test.ts`（6 例，全部绿）：

| 例 | 攻击的用户可见症状 |
| --- | --- |
| 不加 `--write` 只看不写 | B-01：`normalize` 若是"看一眼也落盘"，用户的原文就被悄悄改掉（断言盘上字节不变） |
| `--write` 后每个块都有 id，且**已有 id 一字不动** | B-02：重复 `normalize` 不许重发 id |
| 连跑第二次 `injected=0`、字节不变（幂等） | B-02：AC-1 的 md5 不变 |
| `--json` 信封 `{ok,data:{needsNormalize,html,injected}}` | B-05：`--json` 必须可被别的命令消费 |
| 无 `<article>` → `invalid_document`（退出 1，文件不动） | B-03：这不是"缺 id"，是"不是文档"，提示要能区分 |
| `--write` 人读回执 `normalized … (+N ids, M bytes)` / 第二次 `unchanged …` | B-01/B-16：用户要能看出"这次真改了吗" |

`packages/cli/tests/needs-normalize.test.ts`（4 例，全部绿）：**四个入口同一个码**——

| 例 | 症状 |
| --- | --- |
| `outline` 手写稿 → `needs_normalize` | B-01：不许静默空大纲 |
| `read` 手写稿 → `needs_normalize` | B-03：不许临时注入 |
| `patch` 手写稿 → `needs_normalize` | B-03：不许"找不到 id"式的误导错误 |
| 四入口的 `code` 与退出码两两一致（同一句话） | 用户不该为同一件事记四种码 |

`packages/cli/tests/serve-errors.test.ts`（3 例，全部绿）：

| 例 | 症状 |
| --- | --- |
| 端口被别的进程占 → `port_in_use`、退出 **2**、消息含端口与 `--port` | B-28：环境问题该让人换端口（2），不是"命令写错" |
| 同 home 已有 daemon → `daemon_already_running`、退出 **1**、消息含 `daemon.json` 与真端口 | B-28：状态冲突（1）与参数错（2）靠退出码区分 |
| 上次 `kill -9` 留下的 `daemon.json`（死 pid）被接管，serve 正常起 | B-27：残尸不许挡住重启 |

`packages/cli/tests/undo-envelope.test.ts`（4 例，全部绿）：

| 例 | 症状 |
| --- | --- |
| 无历史 → 人读 stderr `没有可撤销的历史快照`、`--json` `nothing_to_undo`、退出 1、文件不动 | B-05/B-24 |
| `patch` 后 `undo` → 盘上字节回到 patch 前（与写入前逐字节相同），`data` 给 `restoredFrom`/`sha256` | B-24：撤销要真退回去 |
| 同一快照只能撤一次，第二次 `nothing_to_undo` | B-24 |
| 人读回执 `undone <path> (<n> bytes, from <snapshot>)` | B-05：`--json` 之外也要有可读回执 |

既有测试的补强（同一批 24 条内）：`units-output.test.ts` 新增 `replacedIds` 键序用例（**仅 replace 且 id 真变**时才带该键；`insert_after` 不带）。

## 3 · journey 清单（`packages/cli/tests/journey/first-run.test.ts`，3 例全绿）

装置：只用公开契约。**不 import 任何 `src/**`**——`runCli` spawn `packages/cli/src/main.ts`；serve 用 `packages/cli/tests/serve-harness.ts`（`spawn` + `stdio:["ignore","pipe","pipe"]`，读**第一行 stdout** 拿 `{port,token}`，`finally` 里 `SIGTERM`→500ms 后 `SIGKILL`，**绝不在前台跑 serve**）。端口一律 `--port 0`（内核分配高位口），`--home` 用临时目录里的 `home/`，不碰本机真 daemon。

手写原料：封面 + 3 章 + 1 节，**一个 `data-hr-id` 都没有**。

| 例 | 逐步断言（用户拿到了什么） |
| --- | --- |
| ① 手写稿先补齐结构再读 | `normalize --write --json` → `injected > 0`；`outline --json` 摊平后能看到「第一章 发布节奏」「1.1 回滚路径」「第三章 下一季度」且 `wordCount > 0`；`read <doc> article` 的 HTML 里有三章正文与 `data-hr-id=`；`read <doc> <第二章 id>` 能定位到该章标题 |
| ② 改一章、换风格、出打印稿 | `patch --action replace --json` → `replacedIds[0].from` 等于原 id、`to` 变了；用**新 id** 再 `read` 能读到新标题；盘上文件含新标题；`style --visual atelier-editorial` → `changed:true` 且文件里真有 `<style`/`hr-` 类；`export --out print.html --json` → 盘上等于信封里的 `html`、`bytes` 等于其字节数，且 `<h1>` 里能读到第一/第三章标题、正文「下一季度只做三件事。」在场 |
| ③ 起站点在浏览器里读 | 照 serve（`--json`）**打印出来的 URL 真发一次 `GET`**：带 `Cookie: hr=<token>` → 200，首页里有 `doc.html`；`<url>s/doc.html` 带 cookie → 200 且 HTML 含「第一章 发布节奏」「下一季度只做三件事。」；**不带 cookie → 401**（否则同机任何网页能拿走正文） |

## 4 · `BUG-xx` 全表（发现即登记；按裁定 C 不进 `it.fails`）

> 裁定 C（协调者）：仓库 `known-defects.md` 的 `CAP=9` 已满且规则写明"新功能卡内禁止新增 `it.fails`"，故**本轮不新增 `it.fails`**，缺陷只在本表登记 + 交给业务编写员。修复后请按"期望的断言片段"把用例补成正向 `it`。

| ID | 症状（用户可见） | 期望 vs 实得 | 最小复现 | 修好后该写的断言（建议位置） |
| --- | --- | --- | --- | --- |
| **BUG-01**（台账 B-06） | `serve` 打印的地址粘进浏览器 → `401 {"code":"unauthorized"}`，用户手里没有任何可用的打开方式 | 期望：打印的 URL 直接能读（或打印带 token 的 URL / 首次访问落 cookie）；实得：`GET http://127.0.0.1:<port>/` → 401，`?token=` 也 401，只有 `Cookie: hr=<token>` 才 200 | `hr serve d.html --port 0 --json`，取 `data.port` 后 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$PORT/` → `401` | `packages/cli/tests/journey/first-run.test.ts:186` 一带加：`const plain = await fetch(serve.url); expect(plain.status).toBe(200)`（或断言打印的 URL 自带凭据） |
| **BUG-02**（台账 B-02 残留） | `export` 是唯一一个**悄悄替用户补 id** 的入口：手写稿直接 `export` 成功，用户以为"这文档本来就能导"，回头 `patch` 却因缺 id 失败 | 期望：与 outline/read/patch 同码 `needs_normalize`（退出 1、提示 `hr normalize … --write`）；实得：退出 0 + 完整打印稿 | `printf '<article><h1>章</h1></article>' > h.html; hr export h.html --out p.html --json` → `ok:true` | `packages/cli/tests/needs-normalize.test.ts` 末尾加一段：`export` 也 `toMatchObject({code:"needs_normalize"})`（与另外三入口同一张表驱动） |
| **BUG-03**（台账 B-07） | 默认阅读外壳（`GET /`）只有 166 字节壳：`<h1>hReader</h1>` + 一个链接，**没有正文**；用户点进去还得再点一次 | 期望：打印的首页/阅读页能直接看到正文（或至少 `/` 重定向到 `/s/<doc>`）；实得：`/` 是固定壳，正文只在 `/s/<doc>` | `hr serve d.html --json` 后 `curl -H "Cookie: hr=$TOK" http://127.0.0.1:$PORT/` → 只有壳 | journey ③ 里加：`expect(homeHtml).toContain("第一章 发布节奏")`（当前外壳里没有） |
| **BUG-04** | `hr export --ids hr-a,hr-c` 不存在：`未知参数：--ids`（退出 2 + 整页用法），用户想只导一章只能手工剪 HTML | 期望：只导选中的节点及其子树；未知 id → `node_not_found`（退出 2）；实得：参数不认 | `hr export d.html --ids hr-h1 --json` → `未知参数：--ids`，退出 2 | `packages/cli/tests/export-ids.test.ts`（新增）：`--ids hr-h1,hr-h2` 的 `data.html` 含第一章与 1.1 节、**不含**第二章 |
| **BUG-05** | `hr export --llms-full` 不存在：想喂给模型只能自己剥标签，章/节层级随之丢失 | 期望：整本纯正文、标题可见层级（`# 第一章 …`）、无标签无 id；实得：参数不认 | `hr export d.html --llms-full --out book.txt --json` → `未知参数：--llms-full`，退出 2 | 同上文件：`text` 匹配 `/#+\s*第一章/u`、不含 `<h1` 与 `data-hr-id` |

> BUG-04 / BUG-05 在本轮之前写过 3 条 `it.fails`（`export-ids-llms-full.test.ts`），按裁定 C 已整文件删除（既有 `it.fails` 只剩 `units-run.test.ts:137/158` 两条带 `// KD-09`、`// KD-10` 的老用例，`known-defects-registry` 绿）。
> BUG-02 的 `it.fails` 也已从 `needs-normalize.test.ts` 删除，正面用例仍在（四入口表里没有 export 那一行）。

## T2 · F3+F4 之后的 14 条红 + 覆盖率补齐 + journey 黑盒化

> 本节记录上一轮 `pnpm verify` 里被 F3+F4（`needs_normalize` 四入口、serve 打印带 token、首页带正文、export 不再补 id）打红的 14 条断言、以及 perFile 四维 100% 的补齐。**只改 `packages/*/tests/**`**；`src/**`、`docs/**` 一行未动；无 `it.fails`。

### T2-1 · 14 条红逐条

判据：以 F3+F4 之后的**真实契约**为准；每条都问过“这是新契约还是实现退步”。

| # | file:line | 旧断言（锁旧行为） | 判定 | 现在钉的是什么 |
| --- | --- | --- | --- | --- |
| 1 | `packages/cli/tests/units-serve.test.ts:67` | `serving .+ on http://127.0.0.1:\d+/ \(pid \d+\)\n` | **新契约**（BUG-01 修好） | 打印的 URL 必须自带凭据：`…/\?token=[\w-]+ (pid \d+)`——裸地址粘进浏览器就是 401 |
| 2 | `packages/cli/tests/units-run.test.ts:72` | `patch a.html hr-c --action append` 走通 | **新契约**（嵌套 `<p>` 不可重解析） | append 目标改 `hr-a`（容器），并在用例里写明“往 `<p>` 里 append `<p>` 会写出不可重解析的嵌套” |
| 3 | `packages/cli/tests/units-run.test.ts:189` | `--json` 失败时 stdout 信封 **+ stderr 也有一份** | **新契约**（P2-3：`--json` 只走一条通道） | `expect(err).toEqual([])`；报文只在 `message` 里 |
| 4 | `packages/cli/tests/cli-io.test.ts:52` | 同上（子进程版：`stderr` 含“读取时路径不存在”） | **新契约**（P2-3） | `fieldOf(envelope,"message")` 含该文案 + `stderr === ""` |
| 5 | `packages/cli/tests/pdf-cli.test.ts:42` | `chrome_missing` 时 `stderr` 含 `HREADER_CHROME=` | **新契约**（P2-3） | 同一句落 `message`，`stderr` 空 |
| 6 | `packages/cli/tests/png-cli.test.ts:50` | `--json` 越界说明在 `stderr` | **新契约**（P2-3） | 落 `message`，`stderr` 空 |
| 7 | `packages/cli/tests/units-output.test.ts:99` | `dataPatch` 恰好 5 键（无 `replacedIds`） | **新契约**（replace 真改 id 时必须回报） | 5 键表保持，另加 `REPLACED` 夹具断言 6 键：`replacedIds` **仅在 replace 且 id 真变时**存在 |
| 8 | `packages/cli/tests/units-output.test.ts` 人读 patched 行 | `patched a.html (42 bytes, +1 ids)` | **新契约**（新 id 要外露，B-04） | `patched a.html (42 bytes, +1 ids: hr-9)`；另加 replace 行 `id 变更: hr-a392514c → hr-e5acd1ce` |
| 9 | `packages/cli/tests/units-commands.test.ts:57` | 手写稿 `outline` 成功且输出空 | **新契约**（B-01/B-03：先 normalize） | `needs_normalize` + `先跑 hr normalize … --write`，**退出码 2** |
| 10 | `packages/cli/tests/units-commands.test.ts:102` | `read` 自己临时补 id 后成功 | **新契约**（B-03） | 无 id 文档 `read` → `needs_normalize`（同一码）；normalize 后才有 `node_not_found`/`invalid_selector` 用例 |
| 11 | `packages/cli/tests/units-edges.test.ts:22` | 夹具正文段落 `<p>` 无 id（靠入口临时注入） | **新契约** | 夹具补 `data-hr-id="hr-c"`：已 normalize 的文档才走“正常读”路径 |
| 12 | `packages/cli/tests/needs-normalize.test.ts:51` | 四入口（含 `export`）都拒 | **新契约收窄**（F4 定案：export 放行、但不再补 id） | 表里只剩 `outline`/`read`/`patch` 三入口同码同文案；`export` 由「不再注入 id」的用例单独钉 |
| 13 | `packages/cli/tests/units-undo.test.ts:117` | `dataUndo` 顶层就是 4 键（无信封） | **新契约**（所有 `--json` 统一 `{ok,data}`） | `keysOf(envelope)=== ["ok","data"]`，内层 4 键按契约序，且**以换行结尾** |
| 14 | `packages/cli/tests/journey/first-run.test.ts:196` | `startServe(..., {json:true})` 拿 URL（审计 P1-2） | **测试缺口，不是实现退步**（见 T2-3） | 不带 `--json` 起 serve，解析人读行的 URL，**原样 fetch** |

**判为真回归的：0 条。** 14 条全部是“断言没跟上新契约”或“测试绕开了主路径”，没有一条是 F3+F4 让用户可见行为变差。

### T2-2 · 覆盖率补齐清单（perFile 四维 100%）

根因：新 src 只被“spawn 子进程”覆盖，v8 只统计测试进程内执行。**全部补进程内直调用例**，没有再 spawn 一层。

| file:line（原未覆盖） | 新用例（文件 · 用例名） |
| --- | --- |
| `packages/core/src/ops/normalizeFile.ts:40-74`（函数 0%） | `packages/core/tests/io/normalize-file.test.ts` · should return needsNormalize false and no injected ids on an already-normalized document / should inject ids into the draft, report the count and keep bytes identical / should not touch the disk unless write is true |
| `packages/core/src/html/article.ts:18-19` | `packages/core/tests/html/article.test.ts` · should be false for a page without <article> / should be true for a document with an empty article / should not be fooled by a nested article |
| `packages/core/src/io/atomic.ts:120-121`（只读拒写） | `packages/core/tests/io/atomic.test.ts` · should fail with io_failure when the target file is read-only（防御分支：`--write` 撞上只读文件时不能静默半写） |
| `packages/core/src/ops/patchNode/apply.ts:80-84` | `packages/core/tests/io/patch-actions.test.ts` · should refuse to patch a document that has no ids at all (needs_normalize) |
| `packages/core/src/ops/patchNode/apply.ts:142,164`（纯防御） | `packages/core/tests/io/patch-apply-fragment-guard.test.ts` · should report no replacedIds instead of a pair with undefined ids（mock `parseFragment` 返回文本根） |
| `packages/core/src/server/daemon-guard.ts:28-33` | `packages/core/tests/server/g36-daemon.test.ts` · should delete a stale record when the port belongs to someone else / should keep the record when the port still answers with our pid |
| `packages/core/src/server/listen.ts:23-24,74-88` | `packages/core/tests/server/unit-listen-probes.test.ts` · should answer other when the health body is not JSON at all / should be true when a v6-only listener holds the port |
| `packages/core/src/server/server.ts:199-202` | 同上文件 · should start on v4 and print the IPv6 advisory row（真绑 `::` 的 v6-only 监听器，不 mock `node:http`） |
| `packages/core/src/server/static`（首页正文） | `packages/core/tests/server/g3r-static.test.ts` · should render the document body on the home page（F4 的用户症状：打开首页看不到正文） |
| `packages/renderer-html/src/print-html.ts:172,176` | `packages/renderer-html/tests/print-html-attributes.test.ts` · 新增：secnum 外壳的二次 export 幂等 |
| `packages/cli/src/document-normalize.ts:13-14,35` | `packages/cli/tests/units-document-normalize.test.ts`（新文件 3 例）· should pass a real document and name the file when <article> is missing / should reject a document that only lacks ids and hand over the command that fixes it / should rewrite core's generic message with the file and the paste-ready command |
| `packages/cli/src/commands/read.ts:44`（纯防御） | `packages/cli/tests/units-read-retry-non-error.test.ts` · should keep the foreign error's text and leave its class name out of the message（mock `readNode` 第二跳抛 `TypeError`） |
| `packages/cli/src/commands/style.ts:46-48` | `packages/cli/tests/units-commands.test.ts` · should let an unknown id through to applyStyle instead of guessing / should refuse a tone id on --visual |
| `packages/cli/src/commands/patch.ts:30` | `packages/cli/tests/units-commands-patch.test.ts` · should leave the workspace check to core for a path outside the workspace |
| `packages/cli/src/commands/read.ts:21-22`（`idsOf` 有用例） | `packages/cli/tests/units-commands.test.ts` · should return the node html and the ids it reports |
| `packages/cli/src/output.ts:167,222,225-227,231` | `packages/cli/tests/units-commands-normalize.test.ts` · normalize 三例（`--write` 人读两臂 + `--write --json` 的 `needsNormalize:false`）+ `units-output.test.ts` · should wrap the undo line in the ok envelope；outline 诊断行走 `warn` 的用例 |
| `packages/cli/src/run.ts:246` | `packages/cli/tests/units-run.test.ts` · `run(["normalize","a.html"])` 归入成功路径表 |
| `packages/cli/src/run-serve.ts:33-34` | `packages/cli/tests/units-serve-diagnostics.test.ts` · serveCommandOf 诊断出口：`rows.every(row => row.endsWith("\n"))` + 含“清理陈旧 daemon.json” |
| `packages/cli/src/args.ts:26-43` | `packages/cli/tests/units-args-normalize.test.ts` · normalize 三种用法错误 + 成功解析（`parse(["normalize","a.html","--write"])`） |

**`pnpm test:coverage` 结果**：

```
$ pnpm test:coverage            # EXIT=0
     Test Files  281 passed (281)
          Tests  3042 passed (3042)
 All files | 100 | 100 | 100 | 100 |      # perFile 四维 100%，无 ERROR 行

$ pnpm verify                   # EXIT=0（lint + typecheck + test + coverage + depcruise + knip）
✔ no dependency violations found (602 modules, 2522 dependencies cruised)
```

纯防御分支（`atomic.ts` 只读拒写、`apply.ts` 片段根非元素、`read.ts` 非 HrError）都各自写了**最小直调用例 + 一句注释说明它防的是什么**，不断言实现细节。

### T2-3 · journey 改为真黑盒（`packages/cli/tests/journey/first-run.test.ts:179-209`）

| | 改前 | 改后 |
| --- | --- | --- |
| 起 serve | `startServe("doc.html", { json: true })`，从 JSON 信封拿 `{port, token}` | `startServe("doc.html", { json: false, home, cwd })`，**只解析人读首行** `serving … on <url> (pid N)` |
| URL 来源 | 测试自己拼 `http://127.0.0.1:${port}/` + 自造 `?token=` | **就用程序印出来的那一串**（`serve.url` 来自 `serve-harness.ts` 的 `addressOf()` 正则 `/on (http:\/\/\S+)/`） |
| 请求方式 | 带造出来的 token | `fetch(serve.url, { redirect: "manual" })`，**零 cookie、零自造 header** |
| 断言 | `200` + 含正文（用的是自造 URL，绕开了 BUG-01） | `302` + `location: /` + `set-cookie: hr=…; HttpOnly; SameSite=Strict` → 用它给的 cookie 拿 `200` 且 HTML 含正文段落“下一季度只做三件事。”；再断言**裸 `/` 是 401** |

这条现在是“照程序打印的东西去做”，不是“照实现内部拼”。审计 P1-2 关闭。

### T2-4 · `BUG-xx`（新增；按裁定 C 不进 `it.fails`，也不改断言）

| ID | 症状（用户可见） | 最小复现 | 期望 vs 实得 | 修好后该写的断言片段 |
| --- | --- | --- | --- | --- |
| **BUG-06** | `hr serve d.html` 打印的是**工作目录**，不是被服务的文档：用户看不出服务的是哪一篇（多文档目录下完全没法确认） | `cd /tmp/f4 && hr serve d.html --port 0` → `serving /private/tmp/f4 on http://127.0.0.1:8911/?token=… (pid 1234)` | 期望：`serving /tmp/f4/d.html on …`（或至少行内含 `d.html`）；实得：只印目录 | `packages/cli/tests/units-serve.test.ts:67` 的 serve 行正则改为：`/^serving .+\/d\.html on http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+ \(pid \d+\)\n$/u`（现在只能锁 `serving .+ on`，因为实得里那个 `.+` 是目录） |
| **BUG-07** | 往嵌套结构里 `patch --action append` 后，写回的文件**不可重解析**（`<p>` 里套 `<p>`）；用户拿到的是浏览器会“自动纠正”成另一个树的文件 | `hr patch a.html hr-c --action append --html '<p>x</p>'`（`hr-c` 是 `<p>`）→ 退出 0，盘上出现 `<p><p>x</p></p>` | 期望：拒绝（`invalid_input`，说明目标不能装块级子节点）；实得：写出非法嵌套 | `packages/core/tests/io/patch-actions.test.ts` 追加：`expect(() => patch({targetId:"hr-c", action:"append", html:"<p>x</p>"})).toThrow(/装不下块级子节点|invalid_input/u)`；并把 `units-run.test.ts` 里我临时改成 `hr-a` 的那条换回 `hr-c` 断拒绝 |

> BUG-06 是用户实测发现的（本轮 T2 任务 4 指定登记）；BUG-07 是 #2 那条红在改成 `hr-a` 时暴露的——**没有放宽断言去掩盖**：`units-run` 的成功路径用容器目标（合法用法），非法用法登记在此。

### T2-5 · 测试文件的拆分（lint 门禁 `max-lines` / `max-lines-per-function`）

补用例把几个测试文件顶过了 300 行、筒里的 describe 过了 40 行，为过门禁按**主题**拆出五个文件（不是为拆而拆，每份都能单独跑）：

| 新文件 | 从哪拆出 | 拆的理由 |
| --- | --- | --- |
| `packages/cli/tests/units-args-normalize.test.ts` | `units-args.test.ts` | `normalize` 的 argv 子表能单独锁 |
| `packages/cli/tests/units-commands-normalize.test.ts` | `units-commands.test.ts` | `normalize`/`undo` 的人读回执 + outline 诊断行 |
| `packages/cli/tests/units-commands-patch.test.ts` | 同上 | `patch` 的人读行（新 id / id 变更）与失败面 |
| `packages/cli/tests/units-run-chrome.test.ts` | `units-run.test.ts` | pdf/png 的 Chrome 接线（自建 tmp 目录，不共享 fixtures） |
| `packages/cli/tests/units-serve-diagnostics.test.ts` | `units-serve.test.ts` | `serveCommandOf` 的诊断行必须补换行（唯一关心 stderr 形状的用例） |

### T2-6 · 剩余 TODO（下一轮/业务侧）

1. **BUG-06 / BUG-07 修好后**按上表把断言补成正向 `it`（两处都是一行正则/一行 `toThrow`）。
2. `packages/core/src/ops/patchNode/apply.ts:142,164` 与 `packages/cli/src/commands/read.ts:44`、`packages/core/src/io/atomic.ts:120-121` 三条**纯防御分支**现由 mock/只读文件覆盖；若业务侧认为这些分支该删，用例随之删（不留为覆盖率而活的测试）。
3. `packages/core/tests/server/g39-gaps.test.ts` 一带的 `harness` 广播在**满载并行**下偶发超时（本轮见过 1 次，单跑/重跑皆绿），与本卡无关，建议单列。

## 5 · 本次裁定记录 + 门禁现状


**裁定 C（协调者，2026-11-18）**：`it.fails` 在本仓被 `known-defects.md` 的 `CAP=9` + `known-defects-registry.test.ts` 堵死（每条 `it.fails` 必须带 `// KD-nn` 且表里同号，表已满且规则禁止新卡新增）。故本轮：

1. 新发现的缺陷**不写 `it.fails`**，只写进本报告 §4 的 `BUG-xx` 表；
2. 已写的 4 条 `it.fails`（BUG-02 ×1、BUG-04 ×2、BUG-05 ×1）**删除**，被删文件 `packages/cli/tests/export-ids-llms-full.test.ts`；
3. **不动** `.workflow/known-defects.md`，**不动** `packages/core/tests/known-defects-registry.test.ts`（`git diff` 对本文件为空）。

**`pnpm verify` 真实结果（本轮最后一次）**：

```
$ pnpm verify            # EXIT=1
format:check      ✅
check-ci-parity   ✅ (10 步同序同集 + 六反例自证)
lint (eslint)     ✅
lint:sh           ✅
lint-sh-selftest  ✅
typecheck (tsc)   ✅
build             ✅
test:coverage     ❌  270 文件 / 2997 例**全绿**；红了 **perFile 四维 100%** 覆盖率阈值
depcruise / knip  未执行（verify 短路）
```

红的是覆盖率，不是用例。`test:coverage` 报的未覆盖面（**实现侧新代码，不属"改断言"能解决**，需业务编写员补可测分支或我在下一轮补对应用例）：

| 文件 | 未覆盖行 | 缺什么行为 |
| --- | --- | --- |
| `packages/cli/src/output.ts` | 167, 222, 225-227 | `humanDiagnostic`、`dataNormalize`、`humanNormalizeWritten` 两臂（CLI 走子进程，进程内没被调到） |
| `packages/cli/src/run.ts` | 248 | `runRemaining` 的 `normalize` 臂（同上：只有 style 臂走过） |
| `packages/core/src/html/article.ts` | 18-19 | `hasArticle` 的 `false` 返回（进程内无调用） |
| `packages/core/src/io/atomic.ts` | 120-121 | 只读文件拒写（`io_failure`）分支 |
| `packages/core/src/ops/normalizeFile.ts` | 40-48, 52-74 | `normalizeFile` 整体（函数覆盖 0%）——CLI 侧全靠子进程跑，进程内零调用 |
| `packages/core/src/ops/patchNode/apply.ts` | 80-84 | 全文无 id 时的 `needs_normalize` 分支 |
| `packages/core/src/server/daemon-guard.ts` | 28-33 | "端口上是别人"→ 删记录 + 诊断 |
| `packages/core/src/server/listen.ts` | 23-24, 74-84 | `/healthz` 非 JSON、以及 `ipv6Occupied` 两臂 |
| `packages/core/src/server/server.ts` | 199-202 | `::` 被占的诊断行 |
| `packages/renderer-html/src/print-html.ts` | 172, 176 | `isSecnumSpan` 与 `withoutLeadingSecnum` 的 slice 臂（二次 export 幂等） |

**根因（一句话）**：本卡新增的 src 大多只由"spawn 子进程"的用例覆盖，而 `vitest.config.ts` 的 v8 覆盖率**只统计测试进程内执行**；缺的是**进程内直调**（如 `run(["normalize", …], io)` / 直接调 `normalizeFile`、`hasArticle`、`ensureNoDaemon`、`ipv6Occupied`）的那一层。下一轮建议按上表逐文件补 `units-*.test.ts`（每处 1-2 例即可达 100%）。

## 6 · 交付自检

- 新增测试文件 5 个 + 新目录 `tests/journey/`：`normalize.test.ts`(6)、`needs-normalize.test.ts`(4)、`serve-errors.test.ts`(3)、`undo-envelope.test.ts`(4)、`journey/first-run.test.ts`(3)，外加装置 `serve-harness.ts`；共 **20 例**。
- 改动既有测试 13 个文件（`units-commands`/`units-edges`/`units-output`/`units-run-paths`/`units-undo`/`units-args` 侧夹具 `args-helpers`/`cli-exit-codes`/`harness`/`entry-points`/`hr-error`/`node-fs`/`unit-arms`/`unit-branches`/`wire-http`）。
- `git status`：**无 staged 文件**；`src/**` 与 `docs/**` 的改动全部来自业务编写员，本报告作者一行未动。

## T3 · 按审计 `audit-tests-R1-T2`（P1×2 + P2×6）修测试

只改 `packages/*/tests/**`；`src/**` / `docs/**` 一行未动。逐条如下（「退步会红吗」= 把对应实现改坏后，本断言是否真的变红）。

### P1-1 · `serve --json` 的 `url` 字段无人断言（harness 自己拼）
- **改了什么**：`packages/cli/tests/serve-harness.ts` 的 `addressOf` json 分支从自拼 `http://127.0.0.1:<port>/` 改为 `String(fieldOf(data,"url"))`（注释里的旧键集 `{port,token,pid,workspace}` 一并更到 `{url,…}`）；`packages/cli/tests/serve-errors.test.ts` 三条用例在 `startServe` 之后各加一行 `expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u)`。连带修：`packages/cli/tests/needs-normalize.test.ts:91` 的 `askSibling` 原来用字符串拼 `${serve.url}s/draft.html`，url 带 `?token=` 后拼歪（真跑变成 302 后整页 HTML），改 `new URL("s/draft.html", serve.url)`。
- **退步会红吗**：会。`serveUrlOf` 若退化成裸地址（丢 `?token=`），`data.url` 直接不含 token → 三条断言全红；harness 不再能靠自拼掩盖。

### P1-2 · 打印稿「序号不叠」自比自
- **改了什么**：`packages/renderer-html/tests/print-html-attributes.test.ts:110` 在 `countOf(twice) === countOf(product)` 之前加 `expect(countOf(product)).toBeGreaterThan(0);`。
- **退步会红吗**：会。`print-html.ts` 若整体不再生成 `class="secnum"`，两边都是 0、相等，原来全绿；现在前置 `>0` 先红。第二条 `not.toMatch` 也因序号必存在而不再是恒真。

### P2-1 · `hasArticle` 自比自
- **改了什么**：`packages/core/tests/html/article.test.ts:14` 的 `toBe(articleOf("<article></article>"))` 改为 `be(true)`，并显式补一条带 `data-hr-id` 的 `be(true)`（把「id 不影响判据」写出来）。
- **退步会红吗**：会。`hasArticle` 若恒真，第二条「不是文档」用例仍红；且第一条不再有「拿自己构造的真值比」的空转。

### P2-2 · id 字母表比契约松
- **改了什么**：`packages/cli/tests/units-commands.test.ts:138` 的 `hr-[0-9a-f]+` → `hr-[0-9a-f]{8}`；`packages/cli/tests/units-commands-patch.test.ts:72` 的 `hr-c → [\w-]+` → `hr-c → hr-[0-9a-f]{8}`（与 `inject.ts:125` 的 `hr-${stableHex8(...)}` 对齐）。
- **退步会红吗**：会。派生若变成非 8 位 hex（截断/加后缀/退回 `hr-c`），两条人读行断言直接不匹配。

### P2-3 · 重试用例锁死内部跳法 + 箭头模板
- **改了什么**：`packages/cli/tests/units-read-retry-non-error.test.ts` 删 `toContain("按 node id → TypeError: …")` 与 `expect(calls).toEqual([...])`，改为 `toContain("core 抛了个非 HrError")` + `toContain("hr-x")`（保留 `not.toContain("HrError: ")`）。
- **退步会红吗**：会，且只锁用户可见物。外来异常文本被吞 → 第一条红；内部 `HrError:` 类名泄露 → `not.toContain` 红；完全没按 node id 去读 → `calls` 不含 `hr-x` 红。跳序调整则不再误报。

### P2-4 · 注释与 fixture 不符
- **改了什么**：`packages/cli/tests/units-commands-normalize.test.ts:112` 的「跳级标题（h1 → h3）」改为「把 `hr-meta` 手改坏：大纲仍能出，但要带一条解析诊断」。
- **退步会红吗**：不适用（纯注释）。防止后来人按错误归因改 fixture。

### P2-5 · 诊断正则过松
- **改了什么**：同文件 `:132` 的 `/^[a-z_]+: .+\n$/u` → `/^(warning|error): .*hr-meta/u`（实测报文形如 `warning: hr-meta 不是合法 JSON…`，含 `hr-meta` 字样，无需降级写法）；注释标明这是为了钉「针对坏 meta」。
- **退步会红吗**：会。诊断若变成与 `hr-meta` 无关的任意行（比如只报 `outline_truncated`），原正则仍绿，新正则红。

### P2-6 · 守死代码 / 顺带覆盖的两条标注
- **改了什么**：`packages/core/tests/io/patch-apply-fragment-guard.test.ts` 补 `expect(outcome.html).toContain("换")`（除内部字段外也读产物）；`packages/cli/tests/units-run.test.ts` 在「没有 stack 的 Error」用例补 `expect(out.join("")).toBe("")`（patch 走 io 失败时 stdout 必须空），文件头加注「`--html-stdin` 的 stdin 拒绝用例只是防御分支/顺带覆盖 `runPatch`，别记作症状覆盖」。
- **退步会红吗**：产物断言会（片段替换结果不落进 html 即红）；`out` 断言会（失败路径往 stdout 漏东西即红）。但这两条本身仍定位为**防御分支/顺带**，不计入症状覆盖。

### 本段验证（单文件跑，未跑全库覆盖率——业务侧正在同树改 `src/**`）
- `npx vitest run packages/core/tests/html/article.test.ts packages/core/tests/io/patch-apply-fragment-guard.test.ts packages/renderer-html/tests/print-html-attributes.test.ts` → `Test Files 3 passed (3) / Tests 15 passed (15)`
- `npx vitest run packages/cli/tests/units-commands-normalize.test.ts packages/cli/tests/units-read-retry-non-error.test.ts packages/cli/tests/units-run.test.ts` → `Test Files 3 passed (3) / Tests 25 passed (25)`
- `npx vitest run packages/cli/tests/serve-errors.test.ts` → `Test Files 1 passed (1) / Tests 3 passed (3)`
- `npx vitest run packages/cli/tests/needs-normalize.test.ts` → `Test Files 1 passed (1) / Tests 4 passed (4)`（P1-1 连带的 URL 拼法修复后）
- `npx vitest run packages/cli/tests/units-commands.test.ts packages/cli/tests/units-commands-patch.test.ts` → **2 例红**，均与本次改动无关：`patch` 内容模型校验（业务侧正在同树新增 `packages/core/src/ops/patchNode/content.ts`，未跟踪）把「往 `<p>` 里 append 块级节点」判成 `invalid_input`。涉及用例 `units-commands.test.ts:111`（append changed true）与 `units-commands-patch.test.ts:29`（append 新 id 行），我改的 `:138` / `:72` 两行正则本身随同组用例绿/未触及该失败断言。待业务侧 F5 落定后由协调者复跑。

### T3 剩余 TODO（F6 落地后要补的用例；本轮只列清单，不写）
1. **`serve` 行文案改动**（业务侧正在改 `serve` 的输出/`dataServe`）：若人读行或 `data.url` 的文案再变，`serve-harness.ts` 的人读正则 `/on (http:\/\/\S+)/u` 与 `serve-errors.test.ts` 的 `/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u` 要同步复核（新增字段就补字段断言）。
2. **`patch` 内容模型校验（`content.ts` / `assertFragmentFits`）**：新增每条规则一个用例——`<p>` 拒块级子节点、容器接受块级、phrasing 子节点进 `<p>` 允许、错误码/文案含容器与片段标签；以及 `units-commands.test.ts:111`/`units-commands-patch.test.ts:29` 的 append fixture 改成合法容器后的正向行。
3. **校验失败时的失败面**：文件字节不变、`--json` 信封 `invalid_input` + 下一步提示、退出码与 `exit-codes.ts` 一致。
4. **新校验的边界**：`replace`/`append`/`prepend` 三种 action 各一条越界用例，避免只测一种。
5. **F6 若动 `output.ts` 人读行**：`units-output.test.ts:183` 的 `patched … (149 bytes, id 变更: …)` 金样与 `units-commands.test.ts:138`/`units-commands-patch.test.ts:72` 的 `hr-[0-9a-f]{8}` 要一起复核。

## T4 · F6（内容模型冲突）测试侧收口

范围：只改 `packages/*/tests/**` 与本节；未 commit、未 push；未用 `it.fails`；所有文件操作在 `mkdtemp` 沙箱（`withTempDir`）内。

### T4-1 · 14 条红：新契约 or 退步
结论：**13 条是新契约**（F6 让「往只装行内内容的容器里 append 块级片段」变成 `content_model_conflict` + `EXIT_USAGE`，旧 fixture 里的 append 目标选错），按新契约把 fixture 的 append 目标换成装得下的容器（`article`/`section`），断言语义一条没改；**1 条非测试侧问题**（见 T4-4 卡点 A，`packages/pi-extension/pi-hreader.ts:393` 的 `ERROR_TEXTS` 缺新码，src 归 F8）。
`packages/core/tests/hr-error.test.ts` 的错误码矩阵已补 `content_model_conflict: true`（保持原有排序），该文件绿。
全库现状：`npx vitest run` → `Tests 1 failed | 3059 passed (3060)`，唯一红是上面那条 src 缺码。

### T4-2 · 新用例（全部从用户症状出发，断言落在磁盘字节）
`packages/cli/tests/content-model-conflict.test.ts`（9 例，全绿）：

| 用例 | 为什么它能红 |
| --- | --- |
| `should reject appending a paragraph into a paragraph without touching a single byte` | 断言 `code===2` + `"code":"content_model_conflict"` + **sha256 前后相等** + 全文逐字节相等 + `.hreader/history` 不存在。只断「抛了错」的实现（抛完还写了盘、或先写快照再校验）在这里红；把边界放宽（临时清空 `INLINE_ONLY_CONTAINERS`）时 rc 变 0 → 前两条断言直接红，所以这条是**性质**断言不是实现复读 |
| `should reject a block child inside <p>/<pre>/<h1> and keep the bytes`（数据驱动 3 例） | 一个 case 一行：块级被拒 + 码 + sha 不变 + 报文里出现容器标签名（用户得知道换哪个容器）。任一容器被漏判 → 该行独立红 |
| `should accept an inline child inside <p>/<pre>/<h1> and write it out`（数据驱动 3 例） | 反面：行内片段必须 `rc=0`、stdout 精确匹配 `patched doc.html (N bytes, +0)`、sha 变化、盘上真有 `<b>行内</b>`。判严成「一律拒」或误发 id 都会红 |
| `should allow replacing a paragraph with a div when the parent is an article` | 钉「replace 只看**直接父容器**」：`<article><p hr>` → `<div>` 允许、`"changed":true`、盘上出现 `<div>`。谁把 replace 判严成「祖先链全查」或「必须同 tag」→ 红 |
| `should reject an inline target before the container question even comes up` | 钉现状：`<p><b data-hr-id>` 上 replace → `invalid_input`，**不是** `content_model_conflict`，且 sha 不变 |
| `should echo the path the user typed instead of an absolute one` | `toContain("sub/b.html")` + `not.toContain("/private/")` + `not.toContain(dir)`：回执退回绝对路径即红 |

`packages/core/tests/io/patch-content-model.test.ts`（6 例，全绿）：同判定在进程内直跑 `applyPatch`——行内目标 `invalid_input`；`<p>`/`<pre>`/`<h1>` 三容器各自被拒且**报文体裁正确**（段落/预排版块/标题）；行内片段进 `<p>` 通过；`<article><p>` 里 `p`→`div` 通过。CLI 那层只管症状，这里保证判定逻辑本身被真跑过。

`packages/cli/tests/serve-path-and-token.test.ts`（2 例，全绿）：
- `should name the document in the human line and serve its body behind that URL`：人读行精确匹配 `^serving d\.html on http://127\.0\.0\.1:\d+/\?token=[\w-]+ \(pid \d+\)\n$`（**含文档路径**），再照用户做法 `fetch` 该 URL：302 + `set-cookie: hr=…`，带 cookie 取 `/` → 200 且**含正文**。站点在进程内起（`run()` + `stop` 句柄），不挂套件。
- `should put the token in --json.data.url and keep the path relative`：`data.url` 精确匹配带 `?token=`、端口与 `data.port` 一致、URL 里不含 workspace 绝对路径。

### T4-3 · 顺带补的覆盖率缺口
`packages/cli/tests/units-commands.test.ts` 新增 `should fall back to its own path when no display path is supplied`：`styleCommand` 不带 `displayPath` 时退路用自己的路径——补 `displayedPathOf` 的兜底行（`style.ts` 分支 96.55% → 覆盖到此）。

### T4-4 · 卡点（需协调者裁）
- **卡点 A**：`packages/pi-extension/pi-hreader.ts:393` 的 `ERROR_TEXTS` 缺 `content_model_conflict`，`protocol-pins.test.ts:159` 因此红。该文件是 src，不在测试写手权限内（协调者已派 F8）。
- **卡点 B**：`content.ts` 141-145 / 149-155（`select` 与 `FORBIDDEN_CHILDREN`）尚未覆盖，F7 已落地，本轮已按 F7 最终行为补（见 T4-5）。

### T4-5 · F7 落地后的补测（`select` / `FORBIDDEN_CHILDREN` / `<tr>` 片段）

落在 `packages/core/tests/io/patch-content-model.test.ts`（该文件 25 例全绿）：

| 用例 | 判据 / 怎么红 |
| --- | --- |
| `should reject a div inside a select` | 直调 `assertFragmentFits(select, div)` → `content_model_conflict` + 报文含 `<option>` / `<optgroup>`。`select` 的白名单被放宽成"任意子节点"时这里红 |
| `should accept a option/optgroup inside a select`（数据驱动 2 行） | 反面：`option`/`optgroup` 必须放行，判严成"select 里什么都不许塞"时红 |
| `should reject <li/table/dd/dt/a/button/form/option> … because parsing would change the tree`（数据驱动 **9 行 = `FORBIDDEN_CHILDREN` 除 `label` 外每个键一条**，`table` 两个 `tr`/`td` 各一条） | 每行直调 `assertFragmentFits(容器, 片段)`，判据只取 **`code === "content_model_conflict"` + 报文含"会改结构" + 两个标签名**，不断报文全文。表里删键/加错键 → 对应行红 |
| `should still accept a paragraph inside a list …` | 审计裁定的边界：`<ul><p>` 不重排、不登记、不拒。把"内容模型不合规"一律升级成拒绝时红 |

**为什么必须直调**：这些容器标签都不是 `BLOCK_TAGS`（`packages/core/src/html/constants.ts`），经 `applyPatch` 永远走不到那几条判定——直调 `assertFragmentFits` 才能让那张表本身有测试守着（文件里已写明这条理由）。

**`<tr>` 片段那条**：落地的拒绝点不在片段解析层而在内容模型层，落点在 `packages/cli/tests/content-model-conflict.test.ts`，见 T5-4 的 `TESTS_TO_UPDATE` #1。

## T5 · F9/F10 新行为补测 + T4-5 遗留收口

范围：只改 `packages/cli/tests/**`；`src/**`、`docs/**` 未碰；未 commit、未 push；未用 `it.fails`；文件操作全在 `mkdtemp` 沙箱。

### T5-1 · F9 可选结束标签（`packages/cli/tests/optional-end-tags.test.ts`，新建，10 例全绿）

这组要证明的性质：HTML5 允许省略结束标签的写法不会让 patch 变红，且写盘之后**再解析一次是同一棵树**（结束标签被补齐、字节不再变动）。

| 用例 | 实现退步时它怎么红 |
| --- | --- |
| `should accept <li/p/tr/td/th/dt/option> with its end tag omitted and keep the tree stable`（数据驱动 7 行） | 每行走三步：`normalize --write` 取 id → `patch … append` 拿 `rc=0` → 盘上必须出现**补全结束标签后的规范形态**（`onDisk` 正则）→ 二次 `normalize --write` 只报 `unchanged doc.html` 且 sha256 不变。若实现退回"解析前拿原始源码查东西平衡"（把 `<li>b` 判成非法片段）→ 第 2 步 rc≠0 直接红；若写得进去但留半开标签 → `onDisk` 正则红；若二次解析改树 → `unchanged`/sha 断言红 |
| `should treat a <ul> rewrite without end tags as the very same tree` | `replace` 成 `<ul><li>a<li>b</li></li></ul>` 与盘上原树等价 → 回执必须是 `unchanged doc.html` 且 sha256 **完全没变**。谁把"等价树"改成"换一批 id"（内容寻址退步成随机/序号 id）→ sha 变化即红 |
| `should still refuse two real roots` | 反面边界：`<p>a</p><p>b</p>` 仍 `rc=1` + `invalid_fragment` + 报文含"根"，且 sha 不变。谁为了放宽省略结束标签而放宽根数校验 → 红 |
| `should name the next step when a <td> fragment would lose its structure` | `<td>b` 写进 `<div>`：`rc=2` + `content_model_conflict` + 报文点出 `<tbody>`（下一步）+ sha 不变。只断"码 + 下一步里的容器名"，不断报文全文 |

已实测的行为（任务书第 2 条与实测有出入，按实测写）：`append '<tr><td>b</td></tr>'` 到 `<table>` 时，落地实现是 **`rc=2` + `content_model_conflict`**（`FORBIDDEN_CHILDREN.table` 命中，报文"HTML 解析器会改结构…请改 append 到一个能真正容纳 `<tr>` 的容器"），**不是**任务书里写的 `rc=1` + `invalid_fragment` + "必须在 `<table>` 表格上下文里解析"。`<tr>` 片段的"表格上下文"逻辑已在 `packages/core/src/ops/patchNode/fragment.ts` 的 `CONTEXT_ANCESTORS` 里落地（片段先套祖先链解析），所以 `<tr>` 片段本身合法，问题只剩"往 `<table>` 直接塞行会多出一层 `<tbody>`"。详见 T5-4 的 `TESTS_TO_UPDATE`。

### T5-2 · F10 可寻址结构（`packages/cli/tests/addressable-structure.test.ts`，新建，8 例全绿）

这组要证明的性质：`div` 与表格内部（`tbody`/`tr`/`td`）在 `normalize` 之后**可寻址、可作 patch 目标**，并且整表 `replace` 不会给没被改动的老行换 id —— 用户手里那批 id 改动之后仍然有效。

| 用例 | 实现退步时它怎么红 |
| --- | --- |
| `should give the div an id on normalize and accept it as a patch target` | `normalize --write` 后从盘上取 `div` 的 id（`idOfTag`），用它 `append <p>new</p>` → `rc=0` 且盘上出现带 id 的新 `<p>`。`div` 退回不可寻址 → 取不到 id（`idOfTag` 直接抛） |
| `should give tbody/tr/td ids and append a row into the tbody` | 三层 id 都在（只补到 `tr` 时 `td` 那行红）；往 `tbody` 追加 `<tr><td>b</td></tr>` → `rc=0`、盘上 `<tr data-hr-id…>` 恰好 2 个、`<td …>b</td>` 也在。表格内部补 id 的注入器退步 → 行数/id 正则红 |
| `should read a cell back by its id` | `hr read doc.html <td id> --json` 的 `data.html` **精确等于** `<td data-hr-id="<同一 id>">a</td>`：`read` 必须停在单元格，退化成返回整行或父表 → 全文比对红 |
| `should keep the old tr and td ids while new rows get fresh ones`（**两步走，最关键**） | 先 `normalize` 从盘上读出 `table`/`tr`/`td` 三个 id 存成变量，再整表 `replace` 成两行 → `rc=0`；随后 `expect(after).toContain(\`data-hr-id="${rowId}"\`)` / `…"${cellId}"` —— **用变量比、不硬编码**。谁把注入器改成"整棵新子树一律重发 id"，老 id 从盘上消失 → 这两行红；新行没拿 id → 2 个 `<tr …>` 的计数红 |
| `should tell the user a <p> is a paragraph and name a container that holds one` | `p` 上 append `<p>` → `rc=2` + `content_model_conflict` + 报文含"段落"与 `article/section/div` + sha256 不变。报文退化成只说"冲突"不说下一步 → 红 |
| `should refuse a nested <li> as a parser-tree change and keep the bytes` | `li` 上 append `<li>` → `rc=2` + 码 + 报文含"会改结构" + sha256 不变 |
| `should accept a div inside a td because a cell holds flow content` | 反面对照：`td` 上 append `<div>块</div>` → `rc=0`，盘上 `<div data-hr-id=…>块</div>`。把单元格判严成"只装行内" → 红 |
| `should report unchanged on a document that already carries every id` | 带齐 id 再 `normalize --write` → `rc=0`、stdout 含 `unchanged doc.html` 与 `已带齐 data-hr-id`、sha256 与之前相等。幂等退步（重发 id）→ sha 变即红 |

### T5-3 · 两条死分支（防御分支，非症状覆盖）

| 文件 | 钉的是什么 |
| --- | --- |
| `packages/core/tests/io/patch-locate-parent.test.ts`（2 例全绿，新建） | `packages/core/src/ops/patchNode/locate.ts:39-40` `parentElementOf` 的退化返回：子节点不在树里 → `undefined`；子节点直接挂在 `document` 下 → 也是 `undefined`（只有 `element` 父节点才算）。文件头已注"防御分支"。谁把 `undefined` 改成抛错、或把 `document` 当父容器 → 红 |
| `packages/cli/tests/units-serve-diagnostics.test.ts`（4 例全绿，新建） | `packages/cli/src/run-serve.ts:36` 的 `appDirGiven` 为真但没有值时的 `--app-dir` 回显分支（`parseArgs` 装配顺序变动才走得到）＋ `serveCommandOf` 转发 core 诊断行时补换行。文件头已注"防御分支，不是症状覆盖" |

### T5-4 · `TESTS_TO_UPDATE`（旧断言与新契约冲突；按纪律**不断言去凑绿**，逐条记账）

1. **`packages/cli/tests/content-model-conflict.test.ts` · `should refuse a bare table-row fragment and keep the bytes`**
   - 旧断言：`code === 1` + `"code":"invalid_fragment"` + 报文含"上下文里解析"（对应任务书第 2 条）。
   - 实测：`code === 2` + `"code":"content_model_conflict"` + 报文"…HTML 解析器会改结构…请改 append 到一个能真正容纳 `<tr>` 的容器"。
   - 判定：**实现侧是对的，旧断言是 F9 之前的残留**。`CONTEXT_ANCESTORS`（`packages/core/src/ops/patchNode/fragment.ts`）让 `<tr>` 片段先套 `<table><tbody>` 祖先链解析 —— 片段本身合法；真正的问题是"直接塞进 `<table>` 会多补一层 `<tbody>`"，那属于内容模型。故按新契约就地更新为 `code===2` + `content_model_conflict` + 报文含 `<tr>`（`sha` 不变断言保持原样），用例名同时改为 `…写错位置`。**这一条与任务书第 2 条报文不一致，请协调者复核**（详见下方 T5-5 的待裁项）。
2. **`packages/core/tests/io/patch-content-model.test.ts` · `should allow replacing a paragraph with a div when the article can hold it`**
   - 旧断言：`outcome.html` 含 `<div>块</div>`。
   - 实测：F10 之后写盘会给新块补 id → `<div data-hr-id="hr-xxxxxxxx">块</div>`，`toContain("<div>块</div>")` 永远为假。
   - 判定：**回归不是实现问题，是断言写死了"没有 id"**。改为 `toMatch(/<div data-hr-id="hr-[0-9a-f]{8}">块<\/div>/u)`，语义（父容器装得下块级就允许）不变。
3. **`packages/cli/tests/content-model-conflict.test.ts` 的 `NESTED_DOC` 夹具**：原夹具里 `<tbody>/<tr>/<td>` 没有 `data-hr-id`，F10 之后这类文档会先报 `needs_normalize`，导致三条用例测到的是"未规范化"而不是内容模型。夹具已补齐 ids（业务行为没变，仅夹具跟上可寻址集合）。

### T5-5 · 门禁现状 / 自检

```
npx vitest run packages/cli/tests/optional-end-tags.test.ts packages/cli/tests/addressable-structure.test.ts \
  packages/cli/tests/content-model-conflict.test.ts packages/core/tests/io/patch-content-model.test.ts \
  packages/core/tests/io/patch-locate-parent.test.ts packages/cli/tests/units-serve-diagnostics.test.ts
 ✓ packages/cli/tests/optional-end-tags.test.ts (10 tests)
 ✓ packages/cli/tests/addressable-structure.test.ts (8 tests)
 ✓ packages/cli/tests/content-model-conflict.test.ts (11 tests)
 ✓ packages/core/tests/io/patch-content-model.test.ts (25 tests)
 ✓ packages/core/tests/io/patch-locate-parent.test.ts (2 tests)
 ✓ packages/cli/tests/units-serve-diagnostics.test.ts (4 tests)
 Test Files  6 passed (6)
      Tests  60 passed (60)
npx eslint <上述 6 个文件 + packages/cli/tests/cli-support.ts> → 0 error（max-lines-per-function 40 已满足，长函数抽成命名助手）
```

自检：未 commit、未 push、无 staged 文件；本段新增/修改的 12 份测试文件里 `it.fails(` 出现 **0** 次（仓库里另有 12 处 `it.fails(` 属他岗 KD 登记，未碰）；未改 `src/**`、`docs/**`；未跑全库覆盖率（业务侧仍有改动在路上）；断言全部落在磁盘字节 / 真实进程输出 / 再解析的树上，未硬编码任何 `hr-` id，未断报文全文，未用 `url` 自拼。

**待协调者裁**：任务书第 2 条（`<tr>` 片段 rc=1 + "必须在 `<table>` 表格上下文里解析"）与落地实现（rc=2 + `content_model_conflict`）不一致。测试按**实测**写并在 T5-4 #1 记账；若期望的是任务书那套语义，要改的是 `packages/core/src/ops/patchNode/content.ts` 的 `FORBIDDEN_CHILDREN.table`（src 不在本岗权限内）。

## T6 · F11 之后的 9 条红收口 + F11 新行覆盖

`packages/core/src/ops/patchNode/fragmentTokens.ts`（新）与 `fragment.ts` 重构把 `parseFragment` 改成"先解析后校验 + token 级自证"。
本段只动 `packages/*/tests/**`；`src/**`、`docs/**` 未碰；未 commit / 未 push；无 `it.fails`。

### T6-1 · 9 条红逐条

| # | 文件 · 用例 | 旧断言（红） | 实测 | 判定 / 处理 |
| --- | --- | --- | --- | --- |
| 1 | `packages/core/tests/io/fragment-gate.test.ts` + `fragment-gate-io.test.ts`（3 条，经 `io/fragments.ts` 的 `REJECTED_FRAGMENTS`） | 期望 marker `"上下文里解析"` | `grep -rn "上下文里解析" packages/*/src` → **0 命中**（这条报文从来没有存在过） | 裁定照办：裸 `<tr><td>b</td></tr>`、`<td>b</td>` 从 `REJECTED_FRAGMENTS` 移入 `ACCEPTED_FRAGMENTS`（`io/fragments.ts:79-81`），并在 `fragment-gate-io.test.ts` 补"接受后真的落在 `<tbody>`/`<tr>` 里"的落盘断言（见 T6-2 #7）。**没有**去 src 里造报文 |
| 2 | `packages/core/tests/io/patch-apply-fragment-guard.test.ts`（`replacedIds` 期望 `[]` 实得一对） | `expect(outcome.replacedIds).toEqual([])` | 真片段走 `replace` 本来就该报 `[{from:"p1", to:<新 id>}]`（F2 口径，`apply.ts:197-206`） | 双管：① 该文件改成 **mock `parseFragmentWithDiagnostics` 返回文本根**，把"根不是元素 → 没有 id 可报 → `[]`"这条**防御分支**真正走一遍（原本它被真实片段顺带覆盖，不是它要测的东西）；② 真实行为在 `patch-actions.test.ts:255-266` 用变量断言：`replacedIds.to === outcome.newIds[0]`，不硬编码任何 `hr-` id |
| 3 | `packages/core/tests/io/patch-actions.test.ts` · `should reject a non-string html through the parser` | `invalid_html` | `no_code`（裸 `TypeError`） | **断言未改，用例保持红**。属业务侧缺陷，见 T6-4 待裁 #1 |
| 4 | `packages/core/tests/html-inject.test.ts`（2 条 `div` 词表） | 普通 `div` 不拿 id（`injected === 2`）/ `h5`·`h6`·`div` 跳过 | F10 起 `div` 无条件进 `ADDRESSABLE_TAGS`：实测 3 / 6 | 词表断言更新为实测值，并各补一条正向断言（`div` 两个都拿到 id；`span` 仍无 `data-hr-id`），用例名同步改掉"按组件属性分等级"的旧口径 |
| 5 | `packages/cli/tests/cli-io.test.ts` · 40k 深嵌套 | 直接 `outline` 一个 40k 层 `<div>` 文档 | `needs_normalize`（F10 之后 `div` 可寻址，全篇无 id = 没 normalize 过） | **不是性能退化**：`normalize --write`（40001 个 id）+ `outline` 两段合计 **511ms**（`--reporter=verbose` 实测，30s 超时下无接近上限的迹象）。改成"先落盘 + `normalize --write`（断言 `+40001 ids`）再 `outline`"，两段都是活压力点，超时上限保持 30s 未调 |
| 6 | `packages/core/tests/io/fragments.ts` 的两条旧 `REJECTED` 项（`<div>`、`<b><i>x</b></i>`，marker `"结构不完整"`） | 期望 `invalid_fragment` + `"结构不完整"` | 同 #1：`grep -rn "结构不完整" packages/*/src` → **0 命中**；实测两者解析后都是单根元素、`changed=true` | "先解析后校验"是 F11 的既定口径（可选结束标签由 HTML5 容错解析自动闭合），这两条属同批残留 → 移入 `ACCEPTED_FRAGMENTS`（`div` / `b`），记账进 T6-5 `TESTS_TO_UPDATE` |
| 7 | `packages/cli/tests/optional-end-tags.test.ts:92`（T5 留下的 `typecheck` 红） | — | 已随 T5 收口，`pnpm typecheck` 现干净 | 无额外改动 |

### T6-2 · 新增用例（F11 新行必须被真跑到）

**`packages/core/tests/fragment-tokens.test.ts`（新建，16 例全绿）** — 四条判定各自的正反两面，每条都写明"实现退步时它怎么红"：

| 判定 | 正例 | 反例（红法） |
| --- | --- | --- |
| `scanTokens` | `<tr><td>b</td></tr>` → `startTags: ["tr","td"]`、`closedAncestor: undefined`；祖先链前缀不计入 token；`<textarea>` 内容按字面文本不计数；注释/doctype 不计 | 若哪天把祖先链前缀也算进去 → "祖先链前缀不计入" 红；`<textarea>` 若按标签算 → "raw-text" 红（会把 `<b>` 误判成被丢弃） |
| `assertNoAncestorClosed` | `"<tr><td>b</td></tr>"` 在 `["table","tbody"]` 下不抛 | `"<tr><td>b</td></tr></table><p>evil</p>"` → `invalid_input`，报文含 `闭合了外层的 <table>`、`<table><tbody>`、`</table>`；单层祖先时不出现 `连带包装祖先` |
| `assertTokensSurvived` | 表格行片段三元素全存活不抛；解析器**补出来**的 `<tbody>` 不算丢失 | `"<div>x</div>"` 解析 `"<select><div>x</div></select>"` → `invalid_input`，报文含 `1 个元素在解析时被丢弃`、`<div>`；祖先标签不在树上时计数不为 `NaN`（`?? 0` 分支） |
| `assertNothingEscaped` | `<table><tbody><tr><td>b</td></tr></tbody></table>` 在 `tbody` 上下文下不抛；空链是 no-op；链元素取自**另一棵树**时不崩（`pathToNode ?? []` 右支） | `<tbody>` 里的 `<p>evil</p>`（被 foster-parent 到 `<table>` 之前）→ `invalid_input`，报文含 `移到了包装容器之外`、`<p>` |

四类"被丢弃"构造（`packages/core/tests/io/fragment-gate.test.ts` 新增 `describe("parseFragment · 解析器会吞掉/挪走的构造")`，`it.each` 4 例）：

| 片段 | 码 | 报文 marker | 谁在拦 |
| --- | --- | --- | --- |
| `<select><div>x</div></select>` | `invalid_input` | `被丢弃（<div>）` | `assertTokensSurvived` |
| `<td><tr>x</tr></td>` | `invalid_input` | `移到了包装容器之外（<tr>/文本）` | `assertNothingEscaped` |
| `<table><p>x</p></table>` | `invalid_fragment` | `恰好有一个根元素（实际 2 个根级内容节点）` | foster-parent 让根列表多出一个（根数校验先拦） |
| `<tr><td>b</td></tr></table><p>evil</p>` | `invalid_input` | `闭合了外层的 <table>` | `assertNoAncestorClosed`（解析前就拒） |

**`warnings` / `replacedIds`（新返回面）**
- `packages/core/tests/io/patch-actions.test.ts` · `describe("warnings · 片段解析诊断上浮")`（3 例）：`<p title="a" title="b">` → `warnings` 里出现 `duplicate_attribute`（且不被拒：`changed===true`、内容落盘）；干净片段 `warnings` 为空；`delete`（不解析片段）为空。退步时：把 `warnings` 丢掉 → 第一条红。
- `packages/core/tests/io/patch-actions.test.ts` · `should report one replacedIds pair whose `to` is the id actually written`：`replace` 后 `replacedIds` 恰好一对，`from==="p1"`、`to===outcome.newIds[0]`（**变量比，不硬编码 `hr-`**），且落盘字节里那个 `data-hr-id` 与 `to` 同值。退步时：`to` 写成旧 id 或漏报 → 红。
- `packages/cli/tests/units-output-warnings.test.ts`（新建，2 例；原计划放在 `units-output.test.ts`，但那个文件已 299 行、再加会顶 `max-lines`，故独立成文件）：`--json` 回执在 `warnings` 非空时多一个键（键序 `path,bytes,newIds,changed,historyPath,warnings`）并把诊断原样带出；空列表时**不出现**该键（`keysOf` + 文本双重断言）。退步时：无条件带 `warnings` → 第二条红；`dataPatch` 漏传 `warnings` → 第一条红。
- `packages/core/tests/io/patch-outcome-fields.test.ts`（新建，5 例）：outcome 两个附加返回面的固定点——`warnings` 上浮 `duplicate_attribute` 且不阻断落盘 / 干净片段为空 / `delete` 缺省为空；`replacedIds` 只在 `replace` 上报一对（`to` 与 `newIds[0]` 同值）、`append` 报 `[]`。新增它是为了给 `packages/cli/tests/units-output.test.ts` 腾 `max-lines` 空间，同时把 `PatchOutcome` 的这两个字段各自钉在 core 侧。

**落盘位置（`packages/core/tests/io/fragment-gate-io.test.ts` 新增 2 例）**
- `should land an accepted bare <tr> inside <tbody> and a bare <td> inside <tr>`：盘上字节再解析后，新元素的祖先链必须是 `html>body>article>table>tbody`（`<td>` 那条再深一层 `<tr>`），且容器子节点数为 2。退步时：若"接受"只是解析层面成立而写出被 foster-parent 挪走 → 链断言红。
- `should keep exactly the two table-structure fragment entries accepted`：`ACCEPTED` 含、`REJECTED` 不含这两条。退步时：谁把它们挪回 `REJECTED` → 红。

**内容模型 ② / ③ 两侧（`packages/core/tests/io/patch-content-model.test.ts` 新增 2 个 describe，8 例）**
- ② `<table>` 的报文带 `foster-parent` 解释；非表格结构容器（`<select>`/`<div>`）走另一支（`要加内容请 append`，不含 `foster-parent`）。
- ③ `"<section>"` 里放 `<tr>` → `content_model_conflict`，报文含 `表格结构元素 <tr>` 与 `<table>/<tbody>/<tr>`；`tbody/thead/tfoot` 收 `<tr>`、`tr` 收 `<td>/<th>` 不抛。

### T6-3 · 覆盖率门禁现状

`npx vitest run --coverage`（全库）后逐文件读 `coverage/coverage-final.json`：

- **`packages/core/src/ops/patchNode/content.ts`：已补到四维 100%**（原缺口 `188/0`、`196/0`、`189`、`197-201`，由 T6-2 的 ②/③ 用例覆盖）。
- **`packages/core/src/ops/patchNode/fragmentTokens.ts`：四维 100%**（原 `163/0`、`197/0`、`262/0` → 现由 `should not talk about inner ancestors…`、`should count a fragment element whose wrapper ancestor is missing…`、`should do nothing when there is no context chain…` 覆盖）；最后一处 `br:262` 是 `pathToNode(root, context) ?? []` 的右支，用 `should treat a context that is not in the tree as wrapping nothing`（链元素取自**另一棵树**，`pathToNode` 找不到）打掉。
- **`packages/core/src/ops/patchNode/fragment.ts`：仍有 6 处分支 + 9 行语句（共 15 个位置）打不到，是 F11 自己的代码，但不是测试能打到的**：
  `br:61/0`（`directChildTag` 里"非 element/document 节点 → `[]`"）、`br:82/0`（`ancestorChainOf` 的 `break`）、`br:90/0`（`contextOf` 的 `ancestors.length===0` 抛错）、`br:95/0`（链长与祖先数不等）、`br:110/0`+`br:111/0`（`throughShells` 的 `shellChildren(node) ?? []` 右支）、`stmt:91-92`、`stmt:96-100`、`stmt:112-113`。
  论证为什么打不到：`contextOf` 只在 `ancestors.length > 0` 时被调用（`fragment.ts:236`），空链抛错不可达；`ancestorChainOf` 与 `throughShells` 的输入是 `inContext()` 自己拼的固定前缀（`fragment.ts:52-58`），前缀里的祖先解析器一定产出 → `break`（82）、`return undefined`（112-113）、链长不等（95-100）都不可达；`shellChildren` 只对 `document/html/head/body` 返回列表，栈里也只放这几种 → `?? []` 右支不可达。**要么删死分支（src 改动，不在本岗权限），要么门禁对这 15 个位置留红** —— 见 T6-4 待裁 #2。
- 与本岗无关但仍红（`src` 在别的岗手里改，未验证是否同一轮）：`packages/core/src/html/inject.ts`（分支 98.48%）、`packages/core/src/html/seed.ts`（行 93.54%）、`packages/core/src/html/text.ts`（行 97.29%）、`packages/core/src/io/patchFile.ts`（分支 77.77%）、`packages/renderer-html/src/print-html.ts`（分支 98.88%）。

### T6-4 · 待裁

**#1 `html: 42` 不给错误码（业务侧缺陷，断言未改，用例保持红）**

```
$ npx tsx /tmp/repro42.ts        # applyPatch(DOC, { targetId: "p1", action: "append", html: 42 as never })
code = undefined
name = TypeError
message = this.html.charCodeAt is not a function
TypeError: this.html.charCodeAt is not a function
    at Preprocessor.advance (node_modules/.pnpm/parse5@8.1.1/node_modules/parse5/dist/tokenizer/preprocessor.js:157:28)
    at Tokenizer._consume (…/parse5/dist/tokenizer/index.js:402:34)
    at Tokenizer._runParsingLoop (…/parse5/dist/tokenizer/index.js:232:29)
    at Tokenizer.write (…/parse5/dist/tokenizer/index.js:352:14)
    at scanTokens (packages/core/src/ops/patchNode/fragmentTokens.ts:146:38)
    at parseFragmentWithDiagnostics (packages/core/src/ops/patchNode/fragment.ts:227:18)
    at spliceFor (packages/core/src/ops/patchNode/apply.ts:238:40)
```

判定：**F11 引入的行为退化**。M1.1 的契约是"非字符串 html → `invalid_html`"（由 `parseHtml` 的交界校验给出），F11 把 `scanTokens(html, ancestors)` 插在 `parseHtml` **之前**（`fragment.ts:227`），于是非字符串先撞进 parse5 的 tokenizer，抛的是没有 `code` 的 `TypeError`：CLI 侧会退化成"未分类错误"而非 `invalid_html`。修法在 src（`fragment.ts:227` 前加 `typeof html === "string"` 校验，或让 `scanTokens` 抛 `HrError("invalid_html")`），不在本岗权限内，**未改成 `no_code` 凑绿**。
用例保持红：`packages/core/tests/io/patch-actions.test.ts` · `请求校验 · 非字符串 html > should reject a non-string html through the parser`。

**#2 `packages/core/src/ops/patchNode/fragment.ts` 的 15 个不可达位置挡住 perFile 四维 100%**

证据与不可达论证见 T6-3。可选处置：(a) 授权 src 侧删/收这 6 处死分支（`directChildTag` 的三元、`ancestorChainOf` 的 `break`、`contextOf` 的空链抛错与链长不等、`throughShells` 的 `?? []` 与 `return undefined`）；(b) 接受该文件在地毯式门禁上留红；(c) 用 `/* v8 ignore */` 标注（也属 src 改动）。测试侧无法解决。

### T6-5 · `TESTS_TO_UPDATE`（旧断言与 F11 契约冲突，逐条记账）

1. `packages/core/tests/io/fragments.ts`：裸 `<tr><td>b</td></tr>`、`<td>b</td>` 由 `REJECTED` → `ACCEPTED`（任务裁定 #1）。旧期望 marker `"上下文里解析"` 在 `packages/*/src` 里 0 命中。
2. 同上文件：`<div>`、`<b><i>x</b></i>` 由 `REJECTED` → `ACCEPTED`（旧 marker `"结构不完整"` 在 `packages/*/src` 里 0 命中；"先解析后校验"是 F11 既定口径）。**这一条超出任务书明列的 #1 范围**（任务书只点了 `<tr>`/`<td>`），因同属"期望的报文早已不存在"这一批而一并处理，请复核。
3. `packages/core/tests/io/patch-apply-fragment-guard.test.ts`：用例意图（"根不是元素时不报 `replacedIds`"）保留，改为 mock 片段根为文本节点；真实 `replace` 报对的行为另立用例（`patch-actions.test.ts:255-266`，用 `newIds[0]` 变量比）。
4. `packages/core/tests/html-inject.test.ts`：`div` 词表两例（2→3、2→6，并补 `h5/h6/div` 有 id、`span` 无 id）。
5. `packages/cli/tests/cli-io.test.ts`：40k 深嵌套改成"先 `normalize --write`（断言 `+40001 ids`）再 `outline`"，超时上限未动。

### T6-6 · 验证 / 自检

```
$ npx vitest run packages/core/tests/fragment-tokens.test.ts packages/core/tests/io/fragment-gate.test.ts \
    packages/core/tests/io/fragment-gate-io.test.ts packages/core/tests/io/patch-apply-fragment-guard.test.ts \
    packages/core/tests/io/patch-content-model.test.ts packages/core/tests/io/patch-actions.test.ts \
    packages/core/tests/io/patch-outcome-fields.test.ts packages/cli/tests/html-inject.test.ts \
    packages/cli/tests/cli-io.test.ts packages/cli/tests/units-output.test.ts \
    packages/cli/tests/units-output-warnings.test.ts
 Test Files  1 failed | 9 passed (10)
      Tests  1 failed | 186 passed (187)
   → 唯一失败 = T6-4 #1（业务侧缺陷，故意留红）

$ npx vitest run            # 全库（本段改动后）
 Test Files  1 failed | 289 passed (290)
      Tests  1 failed | 3142 passed (3143)

$ pnpm typecheck            # tsc --noEmit，干净（T5 的 optional-end-tags:92 红已不复现）

$ npx eslint packages/core/tests packages/cli/tests --max-warnings=0
（无输出）                # 含 max-lines / max-lines-per-function：units-output → 拆出 units-output-warnings，
                          # fragment-tokens 的 assertNothingEscaped describe 拆成“有包装器 / 没有包装器”两个

$ npx prettier --check packages/core/tests packages/cli/tests .workflow/reports/tests-R1.md
All matched files use Prettier code style!   # 顺带把 T5 的 addressable-structure / cli-io / optional-end-tags 三份格式化

$ npx vitest run --coverage  # 逐文件四维 100% 门禁：F11 三文件里 content.ts / fragmentTokens.ts 已绿，
                             # fragment.ts 残留 15 个不可达位置（T6-4 #2）；另 5 个非 F11 文件仍红（见 T6-3）
 Test Files  1 failed | 289 passed (290)
      Tests  1 failed | 3142 passed (3143)
```

自检：未 commit、未 push、无 staged 文件；本段新增/修改的 12 份测试文件里 `it.fails(` 出现 **0** 次（仓库里另有 12 处 `it.fails(` 属他岗 KD 登记，未碰）；未改 `src/**`、`docs/**`；新增/修改全部在 `packages/*/tests/**`（`fragment-gate-io` 的落盘断言、`fragment-gate` 的四类构造、`fragment-tokens` 新文件、`patch-actions` 的 warnings + replacedIds、`patch-content-model` 的 ②/③、`patch-apply-fragment-guard` 的 mock 改为内部调用点、`units-output-warnings` 新文件、`patch-outcome-fields` 新文件、`fragments.ts` 词表）。断言全部落在再解析的树 / 盘上字节 / 真实进程输出上，未硬编码任何 `hr-` id，未断报文全文。

## T7 · 清 `patch-outcome-fields.test.ts` 的 3 条 no-unnecessary-condition

改动：`packages/core/tests/io/patch-outcome-fields.test.ts` 三处删掉 `?? []` 兜底，改成对 `warnings` 的直接断言。

| 行（改前） | 改前 | 改后 |
| --- | --- | --- |
| 24 | `(outcome.warnings ?? []).map(...)` | `outcome.warnings.map(...)` |
| 33 | `patch(...).warnings ?? []` | `patch(...).warnings` + `toStrictEqual([])` |
| 40 | `patch(...).warnings ?? []` | `patch(...).warnings` + `toStrictEqual([])` |

为什么原写法是错的：`applyPatch` 的返回类型 `PatchOutcome`（`packages/core/src/ops/patchNode/constants.ts:28`）把 `warnings` 声明成**必选**的 `readonly Diagnostic[]`，`apply.ts` 的 5 条返回路径（含 `delete` 的 269 行）也都显式给了 `warnings`。在必选字段上写 `?? []` 是**假的健壮性**——它既让 `@typescript-eslint/no-unnecessary-condition` 报错，又语义上撒谎：如果 `warnings` 真少了，`?? []` 会把缺陷静默吞成"没有诊断"，测试反而变绿。测试要守的就是"字段必须存在"，所以正确姿势是直接读字段再断言值（`toStrictEqual([])` 顺带钉死类型是数组而非 `undefined`）。没有用 `eslint-disable`、没有用 `as unknown` 收窄、没有改断言语义。

验证：
```
$ npx eslint packages/core/tests/io/patch-outcome-fields.test.ts --max-warnings=0
（无输出，exit 0）
$ npx vitest run packages/core/tests/io/patch-outcome-fields.test.ts
 ✓ packages/core/tests/io/patch-outcome-fields.test.ts (5 tests) 6ms
 Test Files  1 passed (1) / Tests  5 passed (5)
$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json --pretty false
（无输出，干净）
```

自检：未 commit、未 push；只改 `packages/core/tests/io/patch-outcome-fields.test.ts` 与这份报告；未碰 `src/**`。

## T8 · print-html.ts:132 右臂 `sectionId ?? ""` 的占位语义

改动：`packages/renderer-html/tests/print-html-attributes.test.ts` 新增 describe「未 normalize 的树：无 data-hr-id 的既有 id 先占位（§13.1）」，两条用例 + 一个直接装配输入的 `unnormalizedInputOf`
（不能再走 `inputOf`——它的 `injectNodeIds` 会给每个元素补上 `data-hr-id`，右臂永远走不到）。

意图（`packages/renderer-html/src/print-html.ts:131-134`）：
- `sectionId` 为 `undefined` 是真实输入：元素只有 `id`、没有 `data-hr-id`（未 normalize 的树）。这类元素的 `id` **也要先占位**，否则随后生成的 `sec-…` 会撞上它。
- 用例 1：`<p id="sec-1">` 无 `data-hr-id`，标题拿到 `data-hr-id="x"` 且已编号 → 小节锚必须是让位后的 `sec-1-2`，目录链接指向 `sec-1-2`，全树只有一个 `sec-1`（占位者本人）。
- 用例 2（同构对照）：把 `data-hr-id="x"` 挪到 `<p id="sec-1">` 上（它的 id 在 `numbering.numberById` 里）→ 右臂不被走，锚直接是 `sec-1`，产物里没有 `sec-1-2`；并断言与用例 1 的产物**不同**。
- outline 条目 id 取 `x` 是有意的：这样兜底值 `""` 与任何别的字面量可区分，变异才可被观测。

变异自检（`/tmp` 备份 + `cmp -s` 还原，还原后绿）：

```
$ sed -i '' 's/numberById.has(sectionId ?? "")/numberById.has(sectionId ?? "x")/' packages/renderer-html/src/print-html.ts
132:  if (id !== undefined && !numbering.numberById.has(sectionId ?? "x")) {
 × 未 normalize 的树：无 data-hr-id 的既有 id 先占位（§13.1） > id="sec-1" 无 data-hr-id 时占位生效，生成锚让位到 sec-1-2
   → AssertionError: expected 'sec-1' to be 'sec-1-2' // Object.is equality
 Tests  1 failed | 13 passed (14)
$ cp /tmp/print-html.ts.bak packages/renderer-html/src/print-html.ts && cmp -s /tmp/print-html.ts.bak packages/renderer-html/src/print-html.ts && echo RESTORED_CMP_OK
RESTORED_CMP_OK
```

覆盖率与门禁：

```
$ npx vitest run packages/renderer-html/tests
 Test Files  7 passed (7) / Tests  113 passed (113)
$ npx vitest run --coverage packages/renderer-html/tests
  print-html.ts    |     100 |      100 |     100 |      100 |
$ pnpm verify
  Test Files  290 passed (290) / Tests  3145 passed (3145)     # 全仓覆盖率门禁无 ERROR，print-html.ts 四维 100%
  ✔ no dependency violations found (616 modules, 2592 dependencies cruised)
  knip → Unused exports (1) SHELL_TAGS  packages/core/src/ops/patchNode/fragmentTokens.ts:10:14
         Unused exported types (2) ChildSlot packages/core/src/html/slots.ts:5:18 · FragmentResult packages/core/src/ops/patchNode/fragment.ts:227:18
         Duplicate exports (1) ADDRESSABLE_TAGS|PATCHABLE_TAGS  packages/core/src/html/constants.ts
  EXIT=1（唯一红在 knip，全部是其他工作流在飞的 `src/**` 导出，不在本任务可改范围）
$ pnpm typecheck   # 干净（EXIT=0）
$ npx eslint packages/renderer-html/tests --max-warnings=0   # 干净（EXIT=0）
```

自检：未 commit、未 push、无 staged 文件；只改 `packages/renderer-html/tests/print-html-attributes.test.ts` 与这份报告；未改 `src/**`；新增用例里 `it.fails(` 出现 0 次。

## T9 · F15 报文跟进 + 三集合护栏 + 覆盖率复核

### T9-1 三条断言跟着 F15 分叉（`packages/core/tests/io/fragments.ts`）

F15 把"根是注释/纯文本"从"根数不对"里拆出来单列报文（`packages/core/src/ops/patchNode/fragmentTokens.ts:41-43`：`片段的根不是元素（是注释或纯文本），请给一个元素`；多根仍是 `片段必须恰好有一个根元素（实际 N 个根级内容节点）`）。三条 user 命名的用例按各自证的点改断言；多根那条**保持不变**。

逐条改前/改后对照（`code` 全部仍是 `invalid_fragment`，变的是 `marker`）：

| 用例（fragment） | 它证的点 | 改前 marker | 改后 marker | 判据变化 |
|---|---|---|---|---|
| `纯文本` (:46) | 根是文本 → 拒绝 | `恰好有一个根元素` | `根不是元素` | 收紧：原来靠多根报文"蹭"到，现在锁死"根不是元素"这条分支 |
| `<!-- 只有注释 -->` (:63) | 根是注释 → 拒绝 | `恰好有一个根元素` | `根不是元素` | 收紧：同上 |
| `<!-- only a comment -->` (:66) | 根是注释 → 拒绝 | `根元素`（宽，两种报文都含） | `根不是元素` | 收紧：从宽匹配改成只认"根不是元素"分支 |
| `<p>a</p><p>b</p>` (:45，多根) | 多个根级内容节点 → 拒绝 | `恰好有一个根元素` | `恰好有一个根元素`（**未动**） | 保持：多根判据不被顺带抹掉 |

（`:64` `""` / `:65` 纯空白仍断言 `根元素`，命中的是 `片段为空或只有空白：必须恰好有一个根元素`，与 F15 无冲突，未动。）

### T9-2 三集合关系护栏（新增 `packages/core/tests/html-constants.test.ts`）

纯数据断言（无 IO），三条对应"模型节点必有 id + 只减项"：

1. `[...BLOCK_TAGS].filter(t => !ADDRESSABLE_TAGS.has(t))` 为空 → `BLOCK_TAGS ⊆ ADDRESSABLE_TAGS`；
2. `[...PATCHABLE_TAGS].filter(t => !ADDRESSABLE_TAGS.has(t))` 为空 → `PATCHABLE_TAGS ⊆ ADDRESSABLE_TAGS`（只减项）；
3. `PATCHABLE_TAGS.size <= ADDRESSABLE_TAGS.size`。

变异自检（临时给 `PATCHABLE_TAGS` 加不在寻址面的 `"hr"`，`/tmp` 备份 + `cp` 还原）：

```
# 改前基线：git diff --stat -- packages/core/src 与还原后逐字相同（见下）
$ perl -0pi -e 's/new Set\(ADDRESSABLE_TAGS\);/new Set([...ADDRESSABLE_TAGS, "hr"]);/' packages/core/src/html/constants.ts
 × should keep every PATCHABLE_TAGS entry inside ADDRESSABLE_TAGS (only 减项)   → missing: ["hr"]
 × should not let PATCHABLE_TAGS grow beyond ADDRESSABLE_TAGS                → expected 35 to be <= 34
 Tests  2 failed | 1 passed (3)
$ cp /tmp/constants.ts.bak packages/core/src/html/constants.ts   # 还原
 ✓ html-constants.test.ts (3 tests)   # 绿
```

还原后 `git diff --stat -- packages/core/src` 与"变异前基线"逐字一致（四项均为其它工作流在飞的 F12/F15 改动，非本任务引入），`constants.ts` 的 `PATCHABLE_TAGS` 已回到 `new Set(ADDRESSABLE_TAGS)`。

### T9-3 复核审计 DYNAMIC 两条

- 覆盖率四维（`pnpm test:coverage`，perFile 100% 门禁通过）：`lines 100 / statements 100 / functions 100 / branches 100`，`coverage-summary.json` 内 `lowFiles 0`（`fragment.ts` 的 `v8 ignore` + 按文件名 `coverage.exclude` 未制造假红/假绿）。
- `packages/core/tests/io/patch-actions.test.ts` 的 `should reject a non-string html through the parser`：**已转绿**（F12 的 `typeof html !== "string"` 守卫生效，`codeOf({ ... html: 42 }) === "invalid_html"`）。

### 门禁

```
$ pnpm verify
  Test Files  291 passed (291) / Tests  3148 passed (3148)
  ✔ no dependency violations found (617 modules, 2594 dependencies cruised)
  knip 干净
  VERIFY_EXIT=0
$ pnpm desktop:check
  cargo test 全 ok（含 connect_recheck 3 例）
  DESKTOP_CHECK_EXIT=0
```

自检：未 commit、未 push、无 staged 文件；只改 `packages/core/tests/io/fragments.ts` + 新增 `packages/core/tests/html-constants.test.ts` + 本报告；未改 `src/**`（T9-2 的 src 变异已还原，diff 与基线一致）。
