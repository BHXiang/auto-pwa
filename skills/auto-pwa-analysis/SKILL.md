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

0. `auto_pwa_suggest`：**先发现再验证**——把上轮评估的 pull>3σ 质量区与每个中间态的允许 J^PC 相交，直接列出质量对齐的 PDG 候选（含阈值余量）。决策输入，省去"猜名字再查"的往返。
1. `auto_pwa_config_view`：读 config 的只读 JSON 视图（Particles/链/衰变步/Constraints/校验结果/PDG 交叉引用）。config.yml 是唯一源头，禁止用视图直接改文件。
2. `auto_pwa_jpc_check`：查目标中间态**两顶点 J^PC**——衰变顶点（R→d1+d2 允许的 J^PC 全集）∩ 产生顶点（A→R+B 的 J^P + C 守恒要求）。**只写交集里的 J^PC**；被 C 拦截的波会明确标出。**执行门与它同源**（共享 `analyzeIntermediateJPC`），看到的就是会被强制执行的。
3. `auto_pwa_decay_check`：确认目标 J^P 物理可达（角动量+宇称守恒，maxL 截断）。**不可达的 J^P 程序会拒绝**（jp-not-allowed）。
4. `auto_pwa_lookup`：确认候选在 PDG 表里，查它的 J^P、C、质量、宽度。
5. `auto_pwa_validate_add`：程序验证 PDG 依据 / JPC 一致 / 运动学阈值 / 重复 / 参数结构 / float 结构 / **衰变顶点 J^P（规则 10）** / **C 守恒（规则 11）** / **全同选择定则（规则 12）**。**errors 非空时禁止继续**；warnings 是风险提示，模型判断。
6. `auto_pwa_edit_config`：程序改 YAML + **写前总闸**（对最终 config 全文跑结构校验 validateConfig + 交叉引用，errors 非空拒绝写）+ 原子写（自动备份 .bak）。
7. `auto_pwa_run_fit` + `auto_pwa_fit_status`：提交拟合、轮询结果。

## 2.1 两顶点 J^PC 检查（jpc_check / 规则 10–12）

每个中间态 R 有两类量子数约束，**都必须满足**：

| 顶点 | 规则 | 例子 |
|---|---|---|
| 衰变顶点 R→d1+d2 | S 由子自旋耦合（S∈[|J₁−J₂|, J₁+J₂]），J = L⊗S，P = P₁·P₂·(−1)^L；**C 只对共轭对/全同组定义** | K⁺K⁻（S=0）：J^PC = {0⁺⁺,1⁻⁻,2⁺⁺,3⁻⁻,4⁺⁺}；Kη：{0⁺,1⁻,2⁺,3⁻,4⁺}（C 未定义） |
| 产生顶点 A→R+B | 角动量三角 + P_A = P_R·P_B·(−1)^L'；**若 A、R、B 均有 C：C_A = C_R·C_B** | J/ψ(1⁻⁻)→η(0⁻⁺)+R：C(R)=−1 必需 |

**C 的定义范围（保守原则，勿伪造）**：
- 正反粒子对（K⁺K⁻、K⁰K̄⁰、π⁺π⁻…）：C = (−1)^{L+S}（自旋 0 介子对即 (−1)^L）；
- 全同粒子（`Constraints.identical` 组内，如 π⁰π⁰、KsKs）：(−1)^{L+S} = +1（玻色子）/ −1（费米子）——**这就是选择定则本身**；
- 其余（K⁺η、π⁺π⁰、K⁺K⁺…）：C 未定义，只查 J^P。

**教学案例（为什么会被拦）**：
- **案例 1（C 守恒）**：J/ψ→η R_KK、R_KK→K⁺K⁻。C(R_KK) 必须 = C(J/ψ)·C(η) = −1。K⁺K⁻ 的 2⁺⁺ 波 C=+1 → **f2(1270) 提案被 `c-violation` 拒绝**（产生顶点可达、PDG 有、阈值过也没用）。
- **案例 2（衰变顶点宇称）**：R_Keta→K⁺η 的 1⁺ 波不存在（P=(−1)^L 迫使 J=L 时 P=−1）→ **K1(1410) 按 1⁺ 提案被 `decay-vertex-forbidden` 拒绝**。
- **案例 3（全同选择定则）**：π⁰π⁰ 只允许 L 偶（0⁺⁺,2⁺⁺,4⁺⁺）；ΛΛ（费米子）要求 (−1)^{L+S}=−1。两个全同粒子**必须声明进 `Constraints.identical`**，否则引擎不对称化（validate 会 warning）。

**sl 白名单记号**：config 的 `sl` 条目是 **(2S+1, L)**（如 `[1, 1]` = S=0, L=1），与工具输出的波表一致；S 物理值 = (2S+1−1)/2。

## 3. 物理硬规则（程序强制，模型需理解）

- **PDG 依据**：BWR/BW/Flatte 共振态必须能在 PDG 表命中（名字匹配 id/别名）。**PDG 上没有的新粒子一律拒绝**——分波分析不能发明粒子。唯一例外：`model: ONE`（相空间项），其振幅 = 势垒因子，mass 参数不参与振幅，命名惯例 `NR*`（如 NR1_KK）。
- **出处（reference）例外**：若参数来自**最新实验结果**（而非 PDG 平均）或该态尚未被 PDG 收录，提案必须带 `reference`（DOI 或论文名）——此时 PDG 平均一致性检查（质量/J^P/未收录）降为警告并记录出处，但**物理门禁（阈值/衰变顶点 J^P/C 守恒）绝不豁免**。reference 会写入 config.yml 并随迭代继承。用 `auto_pwa_lookup` 看单实验测量历史（stat/syst 分离 + DOI），确认引用的实验值真实存在。
- **JPC 一致性**：提案 (J,P) 必须与 PDG 条目一致。ρ(770) 是 1⁻，写成 0⁺ 会被拒。
- **运动学阈值**：m_R ≤ m_A − m_B（on-shell）。R_KK 链阈值 ≈ 2.549 GeV，R_Keta 链 ≈ 2.603 GeV。接近阈值 → off-shell 风险 → 建议 float 质量。
- **参数结构**：BWR/BW 恰好 [质量, 宽度] GeV；ONE 恰好 1 个参数；Flatte 需要 channels 字段。参数长度错 ctpwa 直接崩溃。
- **J^P 可达性**：J/ψ(1⁻) → 0⁻ + R 时，可达 J^P 为 0⁻, 1±, 2±, 3±, 4±, 5⁺（maxL=4）。**0⁺ 不可达**（需要 L=0 但角动量要求 L=1）。
- **衰变顶点门禁（规则 10）**：提案 J^P 必须在 R→d1+d2 的 pairJPC 集合里（见 §2.1），否则振幅恒为零（ctpwa 零-SL 诊断同源）。
- **C 守恒（规则 11）**：产生顶点 A→R+B 若母子均自共轭（如 J/ψ、η），C(R)=C(A)·C(B) 强制；K⁺η 这类无 C 系统只查 J^P。
- **maxL 来源**：优先 config `Constraints.maxL`；未设置时工具默认 4（与 skill 一致；ctpwa 引擎默认不限，注意 config 显式设置后工具与引擎同步）。

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
- **AI 优先驱动 `scripts/aifit.py`**（`PWA_FIT_SCRIPT` 指向它）：同一引擎、零改动，但输出 `results/fit.json`——每 run NLL/正定性、**best 参数±误差与撞边界标记**、分波贡献（config 有 `phsp_truth` 时）、结构化错误码（config-error/no-gpu/fit-failed）。`auto_pwa_fit_status` 自动优先读 fit.json；`--validate-only` 可无 GPU 快速校验 config（DecayInfo）。短拟合：`PWA_AIFIT_RUNS=1 PWA_AIFIT_MAX_ITER=500`（多候选并行的基础）。
- fit.py 默认 10 个随机初值各跑到收敛（最高 10000 次 LBFGS 迭代），输出到 `results/`：`nll_history.txt`（每次运行一段）、`parameters.txt`、`optimization_summary.txt`（最佳 NLL/正定性/分支比）、`weight_best.root`。
- 拟合是**长任务**（10–30 分钟级）：`auto_pwa_run_fit` 返回 jobId 后后台运行，用 `auto_pwa_fit_status` 轮询；不要阻塞等待。

## 5.1 迭代主循环：状态机 + 同会话 goal

**主路径（推荐）用循环状态机工具**（持久化在 `iterations/.loop-state.json`，重启可续）：
- `auto_pwa_loop_next`：评估当前迭代（NLL/ΔNLL/max|pull|/Hessian）→ 按判据（`stopMaxPull`、`stopDeltaNll`、显著阈值、`maxRounds` 预算）判定收敛 → **收敛则写 `FINAL-REPORT.md` 并 phase=done**；未收敛则进入 propose 阶段。首次调用传 `baseIterDir` 启动。
- `auto_pwa_loop_decide`：把 AI 决策落盘——`iterate`（验证+建轮+写 config+提交拟合）、`rollback`（当前轮标记失败、基线回退到上一轮）、`converge`（强制收敛出报告）。
- 每轮循环：`loop_next`（评估/判收敛）→ 决策（`suggest`/`diagnose`/`compare` 辅助）→ `loop_decide iterate` → 等拟合完成通知 → 回到 `loop_next`。

**并行探索（提速关键）**：`auto_pwa_try_candidates` 在基座上并行提交 2–5 个候选的**短拟合**（默认 `--runs 1 --max-iter 500`，目录在 `iterations/_trials/`，不进 iter-N 序列）；全部完成后 `auto_pwa_compare` 按 ΔNLL 显著性（默认阈值 3，2 自由度）裁决，**最优者晋级**为正式迭代。探索与晋级分离，一轮时间试探多个方向。

**结论传递首选"同一个会话里连续上下文"，不是"写摘要给下一个会话"。** 跨会话传递（A 写 conclusion → B 读）会丢失推理细节（为什么选这个态、排除了什么），压缩即损失。

- 会话开始时用 `create_goal` 建立目标：objective 写明收敛判据（所有分布 max|pull| < 5 且 ΔNLL < 10）、时间预算（如"总时间预算 3 小时，每轮在 note 中记录耗时"）、轮数上限（`max_goal_rounds`，建议 15）。
- 之后 DSH 自动续回合：**每轮结束自动开始下一轮，上下文连续**——模型记得自己上轮的全部推理，不需要重新读文件重建理解。
- **拟合是 DSH 后台任务（ctpwa-N，owner=当前 agent）**：提交后**不要轮询**——完成时 DSH 自动通知（"background job ctpwa-N finished"），收到通知或自动续回合后再查结果；`job_list`/`job_output`/`job_kill` 可随时用。
- 每轮动作序列（goal 回合内）：
  1. 等上轮拟合通知 → `auto_pwa_fit_status` 取结果（NLL/正定性/日志）
  2. `auto_pwa_evaluate` 分析上轮 weight_best.root（数值诊断；完整 JSON 在 evaluate.json，输出过大时会 spill 到 locator 按需读）
  3. `auto_pwa_diagnose` 把 fit.json 事实转成假设（撞边界/份额不显著/强干涉对/**参数高相关**——|ρ|>0.8 的参数对无法独立确定，建议固定一个或合并）
  4. **`auto_pwa_root_view` 直接看拟合形状**：先 `list` 发现直方图，再 `read` 取关键对象——每个共振态的波谱 `h_<chain>-<intermediate>-<resonance>`（该共振态的质量谱形状与大小）、角分布 `cosbeta_*`、`hdata`/`hfit` 逐 bin 对比。**这是"哪个共振态主导/缺失/形状异常"的第一手证据**——pull 区对应哪个波谱、哪个共振态形状被压低，直接决定下一步动什么
  5. `auto_pwa_suggest` 按 pull 区列出候选；`lookup`/`decay_check`/`jpc_check` 复核
  6. `auto_pwa_loop_next` 判收敛；未收敛 → `auto_pwa_loop_decide iterate`（或先 `try_candidates` + `compare` 探索再晋级）
  7. 拟合完成通知后回到 1；`auto_pwa_note` 写审计记录（**includeTokens: true** 记本轮 token 消耗；结论 + 下一步计划）
- 收敛（loop 判定 done）或轮数耗尽 → `update_goal complete`，读 `FINAL-REPORT.md` 给用户总结。
- `auto_pwa_note` / `auto_pwa_history` 的角色：**审计日志 + 崩溃/中断恢复**（新会话里用 `auto_pwa_history` + `auto_pwa_loop_status` 恢复上下文，含每轮 token 成本）+ 用户阅读（HTML 日记）。决策主通道始终是连续会话上下文。

## 5.2 harness 机制（少人工，多自主）

- **config.yml 写门禁（pwa-guard）**：`write`/`edit` 直接写 config.yml、bash 对 config.yml 的重定向/tee/sed -i 一律被拦（错误信息指向 auto_pwa_edit_config）。模型只走 `auto_pwa_edit_config`，无需人工监督。
- **/pwa-status 命令**：用户在 GUI 直接输入 `/pwa-status <iterationsRoot>` 看后台任务 + 最近 5 轮日记（不占模型消息）；模型无需主动汇报。
- **token-meter**：`auto_pwa_note` 带 `includeTokens: true` 时记录本轮 token 差值（上次记账以来），`auto_pwa_history` 可回看每轮成本——长会话成本透明，不需要人工查账。

## 6. 拟合质量判断（第二步，迭代决策）

- **ΔNLL 显著性**：新共振态约 2 个自由参数——|ΔNLL| ≥ 3（≈ 2σ）才算显著改进；|ΔNLL| < 3 不显著，考虑删除或换方案；ΔNLL < 10 的旧判据仅作为"不再值得继续"的停止参考（`loop` 的 `significanceThreshold`/`stopDeltaNll` 可调）。
- **Hessian 正定性**：`fit.json` 里 best run 正定才有参数误差可信；不正定 → 参数不可靠（loop 会提示）。
- **撞边界**：float 参数贴 range 端点 = 数据不支持该自由度的信号（`auto_pwa_diagnose` 直接给建议）。
- **份额不显著**：`fitFractions` 中 fraction < 2σ（fraction/error < 2）的分波对拟合无贡献，删除后 ΔNLL 预计 < 3。
- **强干涉对**：`interference.topInterference` 中 |值| > 20% 的波对通常需要独立耦合参数。
- 组内成员过多（>6）→ 过拟合风险，优先替换而非追加（validate 会给 crowded-group warning）。
- 迭代记录写进 `note.md` 和 `SUMMARY.jsonl`，供下一轮参考。

## 7. 注意

- 每次只做一个决策并跑一轮拟合，用 ΔNLL 判断，不要一次性堆多个新共振态（无法归因）。
- 所有工具输出都是规范 JSON；模型负责科学判断，工具负责确定性执行。
