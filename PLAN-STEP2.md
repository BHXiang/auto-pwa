# dsh-pwa 能力映射与后续路线（深度评估版）

> 状态: 评估依据（2026-08 六个 subagent 深读 DSH 全部能力域 + 插件三轮实战）
> 本文回答："系统性学习 DSH 提供了什么" —— 能力矩阵在此，按图索骥

---

## 〇、已实战验证的能力（不再赘述）

工具开发/schema/渲染、后台任务、skill、goal、sandbox、commands 注册、
subagent/workflow 基础、服务三角色/ctx.jobs/扩展点、pwa_round 一步化闭环。
12 个 pwa_* 工具 + 57 单测 + 三轮真实物理迭代。

---

## 一、方向 1：ctpwa 特性进插件 + 改造 ctpwa 方便 AI

### 1.1 pwa-fit 三角色服务（值得）
```
pwa-fit  Definition   ctx.pwaFit 请求/结果类型
pwa-fit-local  Provider   spawn ctpwa + ctx.jobs（自定义 JobKind 'ctpwa'）+ onJobDone
pwa-tools  Consumer     工具面不变
```
复用 ctx.jobs 白拿：统一 job 工具、会话围栏、owner 清理、**完成通知**。

### 1.2 扩展点（按需）
| 扩展点 | PWA 用途 |
|---|---|
| ctx.tools.guard | config 写文件门禁（单调 deny，兜底硬规则） |
| tools/pre-execute | 拟合前 config 可加载性校验 |
| tools/post-execute/finalizeContent | 结果结构化渲染 |
| tools/execute | 超时/重试（后置） |
| tools/result（emit） | 只读审计 |

### 1.3 ctpwa 侧改造契约（6 项，你作为作者）
1. config 校验 API（不跑 GPU）——消除解析器兼容风险
2. fit 完成 JSON 诊断（NLL/参数±误差/撞边界/正定性/分波贡献/干涉摘要）
3. 结构化错误码
4. Python API 契约文档化（dtype 等）
5. 短拟合模式（多候选并行的时间基础）
6. 干涉矩阵导出结构化数据

---

## 二、方向 2：评估决策优化 + subagent

- 多候选并行评估：workflow `parallel`（每候选 validate+短拟合+evaluate，schema 回收）
- 深度干涉归因：subagent_fork（继承上下文，分析 54×54 interference 矩阵）
- 对话式分析：continuable subagent + send_message
- 注意：显式 report、fork token 成本、子代理不继承工具

---

## 三、能力域 × PWA 优化方向全表（新增：深刻研究）

### 3.1 长程会话管理（schedule/compaction/spill/token-meter/persistence）
| 方向 | 场景 | 优先级 |
|---|---|---|
| **spill 大输出** | pwa_evaluate 的 JSON/日志动辄几十 KB，进上下文前走 spill 文件，模型按需读 | 高 |
| **compaction 保物理结论** | 10+ 轮长会话：每轮工具输出膨胀会触发压缩；压缩摘要必须显式保留 chi2/参数/共振表，否则丢物理结论——把关键数值写进摘要或 spill 文件，靠 pwa_note 的 SUMMARY.jsonl 兜底；**主动策略：每轮开始前 compactNow 压掉上一轮的工具过程输出**（压力/超窗自动触发之外的手动时机） | 高 |
| **token-meter 成本跟踪** | 每轮前后 measure 差值（回放式快照，usage 锚点）→ dev-plan 的时间/成本预算真正落地（每轮 token 消耗写进 note） | 高 |
| **状态落盘（已实现）** | persistence 双后端（JSONL/SQLite）+ 崩溃恢复视角：pwa_note/IterationLog 的 SUMMARY.jsonl 已是"每轮状态落盘"，下轮读增量、崩溃可续——保持即可，无需新做 | 高 |
| **schedule 会话内定时** | 拟合完成事件 → 定时触发下一轮评估（session-local，仅原会话 live 时有效） | 中 |
| **跨会话定时** | "每晚自动跑一轮"：schedule 做不到（session-local），需宿主 cron 启动 headless 会话 | 低 |

### 3.2 交互 / 检索 / 人工监督（session-query/commands/feedback/approval/attachment）
| 方向 | 场景 | 优先级 |
|---|---|---|
| **/pwa-status slash 命令** | 用户 GUI 里随时看进度（当前轮/NLL/拟合状态），不占模型消息、结果即时渲染——比发消息问 AI 高效得多；配 /pwa-round 手动触发一轮、/pwa-approve 快捷审批 | 高 |
| **跨会话决策链检索** | searchSessions 全文搜"共振态取舍/chi2"定位旧会话 → readSession 回放校验的完整原始日志（推理+工具参数+结果），远胜 SUMMARY.jsonl 摘要；限制：同持久化存储根 | 高 |
| **approval 人工门禁** | 改 config/新拟合/大 GPU 任务前 ctx.approval.request（带 reason）——**与 guard 互补**：guard 拦硬规则（无人参与），approval 做人工授权（有审计、fail-closed、会话策略） | 中 |
| **feedback 闭环** | 用户差评/纠偏文本 → searchEvents 定位 → 注入下一轮 goal 决策上下文 | 中 |
| **attachment 图片** | pull 图/谱图以内容寻址引用持久化，GUI 展示、模型按需读 | 低 |
| **user-questions 阻塞提问** | 关键岔路（"这个候选组合 A/B/C 选哪个"）用 ask() 阻塞问用户（选项/多选/plan-review 意图），live 会话根可问——比 approval 更丰富的决策征询 | 低-中 |

### 3.3 运行时灵活性（code-runtime/terminal/extensions/LSP）
| 方向 | 场景 | 优先级 |
|---|---|---|
| **run_code 灵活分析** | 模型写 TS 组合 pwa_* 与纯计算做一次性分析（画图/统计/批处理），免为每个需求造固定工具。**边界**：无状态（每轮隔离）、仅无损 JSON、无长驻进程、二进制大对象不合适——高频/强校验/有副作用/长驻的仍是工具职责 | 高 |
| **持久终端保 ctpwa 会话** | terminal 起 python 预加载 ctpwa analysis 实例，多次 send 查询同一实例（参数扫描、干涉查询），免每次重复初始化（秒级 vs 分钟级）；单 send 串行、长输出 read 分页 | 高 |
| **cordis_define 迭代 API** | 你（ctpwa 作者）或模型运行时定义临时插件试新接口，不重启 DSH，稳定后固化回插件包；沙箱受限、需审批、Package 不可变需版本管理 | 中 |
| **LSP 导航拟合源码** | C++/CUDA 拟合代码语义导航（找共振参数/振幅定义）——对开发者有用，对 AI 迭代价值低 | 低 |

### 3.4 编排 / 保险丝 / 前端（ralph/plan/scope/permission-presets/web）
| 方向 | 场景 | 优先级 |
|---|---|---|
| **ralph 保险丝** | goal 迭代"连续 3 轮 NLL 无改善或共振态漂移"时，用户确认后切换 ralph（每轮全新子代理+有界结构化报告 status/summary/evidence/next，打破上下文黏滞）；注意完成/阻塞靠 worker 自报无独立验证、失败轮不重试——设 maxRounds。文档在 tool-catalog + packages/workflow/tool-ralph（subsystems/ 下无） | 中 |
| **plan mode 重大变更** | 换共振态组合策略/大重构前，模型呈交完整 markdown 计划经人工审批（软性指引，需配 guard/approval 才有强制力） | 中 |
| **web 进度面板** | client 插件订阅 WebSocket 下行 session/event（goal/changed、tool/result）→ GUI 渲染当前轮/NLL 曲线/pull 图；需自建 bundle + HMR | 中 |
| **permission-presets 多通道** | 每个分析通道（Jpsi2KKeta/KsKs/pipieta）一套权限组合一键切换（如 KsKs 允许写、其他只读） | 低-中 |
| **scope 多通道隔离** | 多通道 agent 可见性与生命周期隔离，防串扰（一通道的迭代不影响另一通道）；机制：同一注册 ctx 同时表达每 agent 的可见性与共享生命周期所有权 | 低-中 |

### 3.5 已掌握能力的灵活运用（深化）
| 能力 | 深化用法 |
|---|---|
| **skill 按通道拆分** | pwa-analysis（通用流程/物理规则）+ pwa-ksks/pwa-jpsi2kketa（各通道共振态清单、阈值、历史坑）——模型按需加载，省 token 且知识更准；用户级 ~/.dsh/skills 共享 |
| **goal 生命周期** | pause（用户想人工检查时暂停回合）/ resume / blocked（GPU 不可用等数据问题上报）；objective 动态编辑（跨回合更新"当前最佳方案"） |
| **编排分层** | 常规迭代=goal 回合；多候选=workflow 扇出；失控=ralph 保险丝；重大变更=plan mode；一次性分析=run_code |
| **收敛双保险** | pwa_round 的 convergenceHint（程序判据）+ 模型判断（物理判据），两者都过才 complete |
| **commands 全家** | /pwa-status /pwa-round /pwa-eval /pwa-approve——GUI 旁路操作面 |

---

## 四、系统学习结论（更新版）

| 能力域 | 状态 | 优先级 |
|---|---|---|
| 工具/skill/goal/commands/sandbox | ✅ 实战 | — |
| subagent/workflow/服务三角色/ctx.jobs/扩展点 | 📖 已深读 | 方向 1/2 直接用 |
| schedule/compaction/spill/token-meter | 📖 已深读 | 长程会话必需（3.1） |
| session-query/approval/feedback/attachment | 📖 已深读 | 交互监督必需（3.2） |
| run_code/terminal/cordis_define | 📖 已深读 | 运行时灵活（3.3） |
| ralph/plan/scope/presets/web | 📖 已深读 | 编排前端（3.4） |
| MCP | ⏳ 未读 | 仅当 ctpwa 想暴露标准 MCP server；DSH 原生工具已够 |
| llm 适配器/typert/storage 细节 | ⏳ 未读 | 低优先 |

**结论：DSH 能力面已全部摸清（除 MCP 按需），无需再系统性学习。**

---

## 五、建议实施顺序（更新）

**第一梯队（机制补全，插件侧独立可做）**
1. pwa-fit 服务化 + ctx.jobs（完成通知 → 自动续轮基础）
2. guard config 写文件门禁 + approval 人工门禁（强约束机制化）
3. /pwa-status slash 命令（用户即时进度旁路）
4. spill 大输出 + token-meter 每轮成本记录

**第二梯队（依赖 ctpwa 契约，你动手）**
5. ctpwa 契约 1+2（config 校验 API + JSON 诊断）→ 插件适配
6. workflow 多候选并行（依赖短拟合模式）
7. 持久终端 ctpwa 会话（依赖契约 4 API 文档）

**第三梯队（体验/兜底）**
8. 干涉矩阵归因（subagent_fork，依赖契约 6）
9. ralph 保险丝 + plan mode 重大变更
10. web 进度面板 + skill 按通道拆分
