# M4.2 G3 变异/反例轮（测试员 `55e9d516`，2026-11-18）

## 1. 变异表（12 条；全部在 `/tmp/m42-mut` 副本，主树零写入）

| M# | 改法 | 变红的断言 | 判定 |
|---|---|---|---|
| M1 | `supervisor.rs` `impl Drop for Daemon` 顶部 `return;` | R 层 **无红**；S 层壳退出后 spawned daemon 仍 ALIVE（native 已死） | KILLED-S（R 盲区） |
| M2 | `child_registry.rs` `adopt_external` 把 pid 推入 `own` | `ac5_adopted_external_is_never_killable` | KILLED-R |
| M3 | `daemon_file.rs` port 硬编码 8123 | `ac1_port_zero_and_empty_token_are_errors`、`ac1_missing_field_field_keys_and_values_not_leaked` | KILLED-R |
| M4 | `url_build.rs` `bootstrap_url` 丢 token | `ac2_hash_in_doc_id_cannot_swallow_the_token`、`ac2_round_trip_for_every_doc_id_and_token` | KILLED-R |
| M5 | `open_arg.rs` `action_of` 恒 `NoAction` | 8 条 `ac6_*` | KILLED-R |
| M6 | `smoke.rs` `Err` 分支 `1`→`0` | R 层无红；S 层 native exit=1 vs mutated exit=0 | KILLED-S（R 盲区） |
| M7 | `window.rs` `register(...)?` → `let _ = register(...)` | **无红** | **SURVIVED（洞）** |
| M8 | `spawn_decision.rs` `decide` 恒 `Spawn{stale:false}` | 4 条 `ac4_*` | KILLED-R |
| M9 | `redact.rs` 只替 `t={token}` 形态 | `ac3_all_six_shapes_are_redacted` | KILLED-R |
| M10 | `spawn_decision.rs` `present` 去掉 pid/健康校验 | `ac4_port_open_pid_alive_but_health_fails_is_conflicted`、`ac4_port_open_with_dead_pid_is_conflicted` | KILLED-R |
| M11 | 把 `packages/desktop` 整包塞进 `.prettierignore`/`knip.json` | **无红（自动化盲区）** | **SURVIVED（洞）** |
| M12 | `options.rs` `--home` 丢 value | `ac1_flags_override_each_field`、`ac1_open_value_is_not_read_as_a_directory`、`ac1_relative_directories_resolve_against_cwd` | KILLED-R |

10 KILLED / 2 SURVIVED（M7、M11），未用「等价变异」放行。

**M11 的人工闭环（协调者已做）**：`git diff 02f2649 -- .gitignore .prettierignore` 实际只加三行——`packages/desktop/src-tauri/target/`、`packages/desktop/src-tauri/gen/schemas/`（带理由注释）、`.prettierignore` 只多 `tests/fixtures/daemon/bad-json.json`（带理由注释「故意的坏 JSON」）。`knip.json`/`.dependency-cruiser.cjs` 无改动。→ 忽略范围窄且有理由，AC-23 人工项 PASS。

## 2. 六条独立复验（自造证据）

- **AC-17 token 不泄漏**：正控先证明扫描器有效（故意 `?t=<40 字符>` 命中）；真跑 `--smoke` stdout 唯一 ≥16 命中是静态字面量 `bootstrap-cookie`（误报），stderr 0 命中，nav 为 `t=***`；`--hold` 真 daemon（token 实测 **32 字符**，spec 写的 48 是错的）argv/`ps` 无 token；`daemon.json` 权限 `-rw-------`。→ 可信。
- **AC-14**：`--hold 5` → `kill -TERM` → spawned daemon dead、端口关闭。
- **AC-15/13b**：真 `hr serve` external pid，复用后 `shasum` 完全一致，退出后 external 仍活、`/healthz` 200。
- **AC-13a**：`{"port":1,"pid":999999}` → 重拉为活 pid、stderr 空。
- **AC-16 第三态**：`nc -l` 不可用（一次连接即退）→ 改持久 listener + `daemon.json{port:…,pid:999999}` → `--smoke` EXIT=1 且 listener **未被杀、仍 LISTENING**。（首轮 `nc` 判 FAIL 是 harness 假象，已自纠。）
- **AC-9 隔离**：比对真 `~/.hreader` 的 listing + dir mtime 前后不变。
- **AC-2**：独立探针 48 字符 token 对 `# ? % 空格 ../ a/b` 全 PASS；S 层 `--open "a#b.html"` → `/s/a%23b.html?t=***`。

## 3. 「没抓住的坏写法」（变异清单外的破坏面）

| # | 坏写法 | 实际结果 | 协调者裁定 |
|---|---|---|---|
| 1 | docId 含 `..`（`--open ../secret.html`） | `encode_path` 不转义 `..` → URL 出现字面 `/s/../x` | **P3 纵深**：daemon 侧 `packages/core/src/io/paths.ts:76` 已有 `isInside(workspaceAbs, lexical)` 拦截，`:79` 再查 `realpath` 落在 workspace 内 → **不可越界**。测试员「可越出沙箱」的结论不成立（已纠正）。仍建议 URL 层拒绝 `..` 段。 |
| 2 | `accels.json` 两个别名注册**同一加速键** | `accels_from_json` 只 parse+排序，**不去重不报错**；叠加 M7 吞错 → 运行时静默少注册 | **P2（真缺陷）**：`accels_from_json` 应拒绝重复 accelerator，`register` 错误不得吞 |
| 3 | 壳被 SIGKILL/OOM/panic 中断 | `Daemon::drop` 是唯一收拾点 → spawned daemon 变孤儿 | **P2**：daemon 侧需 parent-death 看门狗（`process.ppid` 变化即退出） |
| 4 | `probe.port_open` 与 `connect` 之间端口被抢（TOCTOU） | `decide()` 一次判定 `Reuse` 就连 → 窗口内 squatter 可收到带 `?t=` 的请求 | **P2**：导航前再做一次「pid 活 + 健康载荷是 hreader」校验 |
| 5 | `--open` 指向 workspace 外 symlink | 未造出越界反例 | **P3**：`resolveTarget` 的 `realpath` 检查已覆盖（`:79`），补一条测试固定即可 |

已确认被抓住：`--open <目录>`、`daemon.json` 半截（按 Absent 自愈重拉）、`HOME` 与 `--home` 不一致。

## 4. AC-7 差异证据

- `accels.json` 实况只有 `{"showWindow":"CmdOrCtrl+Shift+H"}`；`shortcut.rs` 注释声称「JS 侧冲突检查读同一份文件」——**实测不成立**：`grep -rn accels packages/app/src packages/desktop/src`（除 `src-tauri`）**0 命中**。
- `keys.ts:23-24` 的 `modified()` = `metaKey||ctrlKey||altKey`（**不含 Shift**）；`keys.ts:49` 先 `if (modified(...) || isEditableTarget(...)) return undefined`；保留键集 `{Escape, Shift+D, w, /, j, k, h, c}`。
- `shortcut.rs::parse_accel` 全局键必须含强修饰键（`CommandOrCtrl|Ctrl|Alt`），裸 `Shift` → `MissingModifier`；`Escape` → `ReservedKey`。
- 结论：结构上不撞，但**没有任何跨文件断言把 `accels.json` 键集与 `keys.ts` 保留键集做交集固定** → AC-7 的 partial 根因。

## 5. 主树

`git status --porcelain` = 18 项（17 + 本报告目录里协调者新增的 `gui-ac20-m4.2.md`），`git diff --cached` = 0。测试员零写入。
