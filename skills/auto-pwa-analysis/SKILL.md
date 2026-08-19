---
name: auto-pwa-analysis
description: 'Use when performing partial wave analysis (分波分析) with the auto_pwa_* tools: adding resonances, writing config.yml, running ctpwa fits, judging fit quality and iterating. Covers JPC reachability, PDG-backed candidates only, float/free parameter policy, iteration folder conventions, and fit program execution rules.'
---

# PWA 分波分析作业规则

本 skill 是与 `auto_pwa_*` 工具配套的物理知识。工具负责强制（强约束），本文件负责解释**为什么**并指导**如何决策**。所有写入 config.yml 的操作都必须走 `auto_pwa_edit_config`（内部先 `auto_pwa_validate_add`），绝不用文本编辑器直接改 config.yml。

## 1. 分波基本框架

当前分析通道（示例）：
- **Jpsi2KKeta**：J/ψ(1⁻, 3.0969) → η + R_KK（R_KK → K⁺K⁻）以及 J/ψ → K + R_Keta（R_Keta → K η）。
- **pipieta**：J/ψ → η + R（R → π⁺π⁻）。

每个 intermediate（如 R_KK）有若干 [J,P] 组，每组列出共振态名。**组顺序决定振幅索引**（`Constraints.trans` 引用如 `R_Keta_0` 按此索引）——所以新组只能追加到末尾，不能插队。

## 2. 加共振态的标准流程（强约束链）

1. `auto_pwa_decay_check`：确认目标 J^P 物理可达（角动量+宇称守恒，maxL 截断）。**不可达的 J^P 程序会拒绝**（jp-not-allowed）。
2. `auto_pwa_lookup`：确认候选在 PDG 表里，查它的 J^P、质量、宽度。
3. `auto_pwa_validate_add`：程序验证 PDG 依据 / JPC 一致 / 运动学阈值 / 重复 / 参数结构 / float 结构。**errors 非空时禁止继续**；warnings 是风险提示，模型判断。
4. `auto_pwa_edit_config`：程序改 YAML + 原子写（自动备份 .bak）。
5. `auto_pwa_run_fit` + `auto_pwa_fit_status`：提交拟合、轮询结果。

## 3. 物理硬规则（程序强制，模型需理解）

- **PDG 依据**：BWR/BW/Flatte 共振态必须能在 PDG 表命中（名字匹配 id/别名）。**PDG 上没有的新粒子一律拒绝**——分波分析不能发明粒子。唯一例外：`model: ONE`（相空间项），其振幅 = 势垒因子，mass 参数不参与振幅，命名惯例 `NR*`（如 NR1_KK）。
- **JPC 一致性**：提案 (J,P) 必须与 PDG 条目一致。ρ(770) 是 1⁻，写成 0⁺ 会被拒。
- **运动学阈值**：m_R ≤ m_A − m_B（on-shell）。R_KK 链阈值 ≈ 2.549 GeV，R_Keta 链 ≈ 2.603 GeV。接近阈值 → off-shell 风险 → 建议 float 质量。
- **参数结构**：BWR/BW 恰好 [质量, 宽度] GeV；ONE 恰好 1 个参数；Flatte 需要 channels 字段。参数长度错 ctpwa 直接崩溃。
- **J^P 可达性**：J/ψ(1⁻) → 0⁻ + R 时，可达 J^P 为 0⁻, 1±, 2±, 3±, 4±, 5⁺（maxL=4）。**0⁺ 不可达**（需要 L=0 但角动量要求 L=1）。

## 4. float（共振态参数是否自由）决策策略

- **窄共振、PDG 测定良好的态**（宽度 ≲ 50 MeV，如 φ(1020)）：**固定**，float 会与耦合参数退化。
- **新加入的共振态**：第一轮建议 float 质量（free:[0]），区间以 PDG 质量为中心 ± max(0.5Γ, 30 MeV)。
- **宽态**（Γ > 0.2 GeV）或**接近运动学阈值**：质量+宽度都 float（free:[0,1]），宽度区间 ±50%Γ。
- **拟合后参数撞边界**（float 值贴住 free_range 端点）：下一轮要么放宽区间，要么考虑这个态没被数据支持，删除。
- **ONE 相空间项**：参数固定（不参与振幅，float 无意义）。
- `auto_pwa_validate_add` 会返回 `floatSuggestion` 建议，模型可采纳或调整，但结构必须合法。

## 5. 迭代文件夹与拟合执行规则

- 迭代目录：`<分析目录>/iterations/iter-N/`，每轮完整自包含：`config.yml`、`fit.py`（链接到 solve2）、`results/`、`note.md`（本轮决策记录）。
- **config.yml 必须放运行目录**：`ctpwa.analysis()` 从**当前工作目录**读 config.yml（fit.py 不接收 config 参数）。Data 段用绝对路径。
- 拟合程序：`<ctpwa env>/bin/python fit.py`，需要 LD_LIBRARY_PATH 含 ROOT lib + CUDA lib64 + torch/lib（插件已注入）。**ctpwa 仅支持 GPU**（CPU 后端未实现），无 GPU 立即失败——先 `auto_pwa_run_fit` 会探测并给出明确诊断。
- fit.py 默认 10 个随机初值各跑到收敛（最高 10000 次 LBFGS 迭代），输出到 `results/`：`nll_history.txt`（每次运行一段）、`parameters.txt`、`optimization_summary.txt`（最佳 NLL/正定性/分支比）、`weight_best.root`。
- 拟合是**长任务**（10–30 分钟级）：`auto_pwa_run_fit` 返回 jobId 后后台运行，用 `auto_pwa_fit_status` 轮询；不要阻塞等待。

## 5.1 迭代主循环：同会话 goal（推荐）而非跨会话传递

**结论传递首选"同一个会话里连续上下文"，不是"写摘要给下一个会话"。** 跨会话传递（A 写 conclusion → B 读）会丢失推理细节（为什么选这个态、排除了什么），压缩即损失。

- 会话开始时用 `create_goal` 建立目标：objective 写明收敛判据（所有分布 max|pull| < 5 且 ΔNLL < 10）、时间预算（如"总时间预算 3 小时，每轮在 note 中记录耗时"）、轮数上限（`max_goal_rounds`，建议 15）。
- 之后 DSH 自动续回合：**每轮结束自动开始下一轮，上下文连续**——模型记得自己上轮的全部推理，不需要重新读文件重建理解。
- 每轮动作序列（goal 回合内）：
  1. `auto_pwa_fit_status` 取上轮拟合结果（NLL/正定性/日志）
  2. `auto_pwa_evaluate` 分析上轮 weight_best.root（数值诊断）
  3. 基于连续上下文 + 诊断，判断：哪里差、缺什么、ΔNLL 是否显著
  4. `auto_pwa_lookup` / `auto_pwa_decay_check` 验证候选与 J^P 可达性
  5. `auto_pwa_validate_add`（必须 0 errors）
  6. `auto_pwa_iter_start` 建新轮目录（基座 = 上轮 config.yml）
  7. `auto_pwa_edit_config` 写入新 config
  8. `auto_pwa_run_fit` 后台提交 → 回合结束（等自动续回合）
  9. `auto_pwa_note` 写审计记录（轻量：结论 + 下一步计划）
- 收敛或轮数耗尽 → `update_goal complete`，写最终 note。
- `auto_pwa_note` / `auto_pwa_history` 的角色：**审计日志 + 崩溃/中断恢复**（新会话里用 `auto_pwa_history` 恢复上下文）+ 用户阅读（HTML 日记）。决策主通道始终是连续会话上下文。

## 6. 拟合质量判断（第二步，迭代决策）

- **ΔNLL 显著性**：新增共振态后 NLL 改进 ΔNLL < 10（≈ √(2ΔNLL) < 4.5σ）→ 该共振态不显著，考虑删除或换方案。
- **Hessian 正定性**：`optimization_summary.txt` 里 best run 正定才有参数误差可信；不正定 → 参数不可靠。
- **撞边界**：float 参数贴 range 端点 = 数据不支持该自由度的信号。
- 组内成员过多（>6）→ 过拟合风险，优先替换而非追加（validate 会给 crowded-group warning）。
- 迭代记录写进 `note.md` 和 `SUMMARY.md`，供下一轮参考。

## 7. 注意

- 每次只做一个决策并跑一轮拟合，用 ΔNLL 判断，不要一次性堆多个新共振态（无法归因）。
- 所有工具输出都是规范 JSON；模型负责科学判断，工具负责确定性执行。
