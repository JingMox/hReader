# WORKFLOW STATE

- 当前里程碑: M1
- 当前卡片: 无（等待用户批准开工）
- 写者并发: 最多 1 个（当前: none）
- 上下文阈值: 软 60% 主动压缩；硬 150K tokens 且任务已完成 → 交接重生；单会话 ≥ 3 张卡强制重生

## 会话登记（正式，续接用这些 runId）
| 角色 | runId | 启动时间 | 上下文占用 | 已完成卡数 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 编写员 (worker) | del_mwdra3mh_e3uv | 2026-11-12 | 待下次 acp_status | 0 | bootstrap 完成，待卡 |
| 审计员 (reviewer) | del_mwdra9nv_3dc9 | 2026-11-12 | 待下次 acp_status | 0 | bootstrap 完成，待卡 |
| 测试员 (worker/test-scope) | del_mwdrafbv_c2r3 | 2026-11-12 | 待下次 acp_status | 0 | bootstrap 完成，待卡；已授权只写 `test-<card>.md` |

### 冒烟验证会话（仅作能力自证记录，不再续接）
| 角色 | runId | 结论 |
| :--- | :--- | :--- |
| 编写员 | del_mwdq2qwb_i47p → R1 del_mwdqf3gk_nory | 按 finding 返工成功 |
| 审计员 | del_mwdq4adb_tpvc → R1 del_mwdr0wxj_ewle | R0 抓到 P0×2/P1×5；R1 复审 G4 FAIL（剩 1 P1 测试判别力） |
| 测试员 | del_mwdq4htw_efsy → R1 del_mwdql40k_oxd9 | 变异测试 10 个变异体全杀；R1 裁决 6 个过时用例，54/54 绿，line 100%/branch 96.43% |

## 门禁记录
| card | G1 impl | G2 audit | G3 test | G4 verdict | note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| M1.0 | - | - | - | - | todo |
| M1.1 | - | - | - | - | todo |
| M1.2 | - | - | - | - | todo |
| M1.3 | - | - | - | - | todo |
| M1.4 | - | - | - | - | todo |
| M1.5 | - | - | - | - | todo |
| M1.6 | - | - | - | - | todo |
| M1.7 | - | - | - | - | todo |
| M1.8 | - | - | - | - | todo |
| M1.9 | - | - | - | - | todo |

## 消息流水
| 时间 | 方向 | 摘要 | 闭环 |
| :--- | :--- | :--- | :--- |
| 2026-11-12 | 协调者 | 建立工作流文档与三角色会话协议 | - |
| 2026-11-12 | 协调者→三角色 | /tmp/hr-smoke 冒烟：实现→审计→测试→返工→复审 全链路打通；ACP 压缩实测 56× | 是 |
| 2026-11-12 | 三角色 | 正式会话 bootstrap 完成（已读 docs/03、04、05 与 state） | 是 |

## 待用户决策
- 是否批准开始 M1.0（Monorepo 骨架与最严 CI）。
