---
name: auto-pwa-analysis
description: 'Use when performing partial wave analysis (分波分析) with the auto_pwa_* tools: adding resonances, writing config.yml, running ctpwa fits, judging fit quality and iterating. Covers JPC reachability, PDG-backed candidates only, float/free parameter policy, iteration folder conventions, and fit program execution rules.'
---

# PWA 分波分析作业规则

本 skill 是与 `auto_pwa_*` 工具配套的物理知识。工具负责强制（强约束），本文件负责解释**为什么**并指导**如何决策**。

**写入 config.yml 的分工（2026 起）**：`auto_pwa_*` 结构化工具（edit/remove/init）是**快车道**——YAML 渲染、物理门禁、原子写、`.bak` 全部代办，能用就用。需要特殊公式（`model: Interp/Custom/GS`、`options` 载荷、手写对照变体）时**允许直接编辑/新建任意 yml 文件**：写时不再拦截，正确性由**跑前门禁**（`auto_pwa_validate_config`；`auto_pwa_run_fit` 提交前强制再跑一遍）和**拟合记录**（`results/provenance.json`）保证。`init_config.yml` 例外，仍只能由 `auto_pwa_init_config` 生成。

## 0. 项目启动（第一优先：先定位项目、直接开跑，禁止探索）

**定位项目**：你的项目 = 用户明确指定的分析目录（通常在会话上下文/工作区里给出路径），由该目录的 `init_config.yml`（或已建立的 `iterations/`）决定。**禁止**为了"找项目"去浏览磁盘上其他分析目录——它们与本项目无关，翻看只会浪费大量时间。用户给了目录但你没把握时，**最多问一次**确认路径，然后立刻开跑。

**全新项目（该目录没有 iterations/）**，动作序列一次到位：
1. `auto_pwa_config_view` 读 `init_config.yml` 全文（一次调用覆盖 Particles/DecayChains/intermediates/Resonances/Constraints）。
2. 用一两句话向自己复述衰变链与已有模型（形式如"母→子1+子2；中间态 X 经哪些 [J,P] 组、各组含哪些共振态"；具体粒子以 config.yml 为准）——复述不出来就是没读懂，重读视图。
3. `auto_pwa_lookup` 核对已有共振态的 J^P/质量/宽度（读懂了才谈得上加新的）。
4. **立即** `auto_pwa_iter_start`（基座 = init_config.yml）建 `iter-000` → `auto_pwa_run_fit` 提交首轮拟合。
5. 等拟合期间再补物理检查（`jpc_check`/`decay_check`/`suggest`）——**不要**先做完所有检查才开跑。

**已有 iterations/（续跑）**：`auto_pwa_history` + `auto_pwa_loop_status` 恢复上下文（上一轮结论 → 本轮方向），直接进 §5.1 主循环；不重新探索目录、不看旧项目。

**全新项目且没有 config/init_config.yml（从 0 起草）**：不要凭空手写 YAML——优先用 `auto_pwa_init_config`（结构化 spec，程序渲染 + 物理门禁）。走这条链：
1. **问用户**（`ask_user_question`，一轮一组）：反应道与母粒子、末态、数据与 MC 的路径/格式(`dat`|`ROOT`)/树名/branch 顺序、是否含本底、`maxL` 与势垒半径约定。**数据路径必须用户给，不要猜。**
2. **研究可达性**（不需要 config）：对每个假想中间态跑 `auto_pwa_decay_check`（A→R+B 允许的 J^P + 阈值 + 阈值下的 PDG 候选），用 `auto_pwa_lookup` 确认候选真实存在（J^P/质量/宽度/衰变模式）。想要"每个中间态到底能放哪些 [J,P] 波、有哪些 PDG 候选"的完整答案：先用 `auto_pwa_init_config` 以 `preview: true` + **空 `resonances`** 生成骨架（或直接写文件），再对骨架跑 `auto_pwa_jpc_check`——它给出两顶点交集 J^PC、C 三态，以及**按阈值过滤**的候选（含 `thresholdMargin` on-shell 余量、`decaysTo`、C 是否已知；超阈值候选被排除并报 `filteredAboveThreshold`）。
3. **生成**：`auto_pwa_init_config`（结构化 spec）。粒子**优先只写 pdgid**（π⁰=111、K⁺=321、K⁻=−321、p=2212、Λ=3122…），J/P/质量自动取自 PDG，并自动获得全同/正反/自共轭/C 校验。不写 `plot` 会自动生成每个中间态的 1D 质量谱 + 衰变角分布（写 `plot: []` 才关掉）——**不要**关掉，否则拟合输出没有分布可供 `auto_pwa_evaluate` 判断。传 `dir` 后还会检查 Data/MC 文件是否存在（缺文件只 warning）。先 `preview: true` 看文本与 reviewSummary，确认无误再写。
4. **人工复核闸门**：把 `reviewSummary` 交给用户确认（`requiresHumanReview`）。用户可能要改反应道/J^P 组/共振态——改完重跑第 3 步。
5. **开跑**：`auto_pwa_iter_start(baseConfigPath=<dir>/init_config.yml)` 建 `iter-000` → 立即 `auto_pwa_run_fit`；之后进 §5.1 主循环。

要点：`resonances[]` 里每个态都会过与 `auto_pwa_validate_add` 同源的门禁（PDG 依据/JPC/阈值/衰变顶点 J^P/C 守恒/全同选择定则），errors 非空**不会写文件**；`intermediates[].groups` 的**顺序即振幅块索引**（`trans` 引用 `R_x_0` 按此顺序）。

**禁止手动调试环境**：GPU/CUDA/ctpwa/ROOT 环境由 `auto_pwa_run_fit` 自动探测并给出权威诊断。**不要**手动跑 `nvidia-smi`、`torch.cuda.is_available()`、查 `/dev/dxg`、拼 `LD_LIBRARY_PATH`、翻 ctpwa 源码——这是最常见的整段浪费。**transport 自动路由**：`auto_pwa_run_fit` 探测到本机无 CUDA 但有 `sbatch`/`squeue`/`sacct`（集群登录节点）时会 **交作业到 SLURM**（写 `fit.slurm`、`sbatch`、登录节点轮询，跑完唤醒——无需本地 GPU）。若 `auto_pwa_run_fit` 报 no-gpu/找不到 torch，多半是宿主进程没有运行在插件要求的 python 环境里（设 `PWA_CTPWA_PYTHON` 与 `PWA_LD_LIBRARY_PATH`，或在对应环境里重启 harness）——把这条提示给用户即可，不要自己修环境。

## 1. 分波基本框架

**以下只是物理概念说明，与你的具体项目无关**（你的项目由 §0 定位的 init_config.yml 决定）：
- 一个典型级联：母粒子 A → 子粒子 B + 中间态 R（R → 两末态），例如 ψ(2S) → γ + χc1、χc1 → η + R_KK（R_KK → K⁺K⁻）——只示意中间态如何嵌入衰变链，具体通道/粒子以你的 config.yml 为准。
- 中间态命名（R_KK、R_Keta 等）是常见分析惯例（R_<子粒子>），不同项目可不同。

每个 intermediate（如 R_KK）有若干 [J,P] 组，每组列出共振态名。**组顺序决定振幅索引**（`Constraints.trans` 引用如 `R_Keta_0` 按此索引）——所以新组只能追加到末尾，不能插队。

## 1.5 工具路由表（选工具先看这里）

规则：**每件事只有一个规范入口**；"不要用"列写的就是反例，别绕路。完整真值表（含实测频次与不变式）见仓库 `docs/tool-truth-table.md`。

| 我要做的事 | 用 | 不要用（改用） |
|---|---|---|
| 看 config 里有什么 | `auto_pwa_config_view` | — |
| 校验配置能否跑、要权威参数清单 | `auto_pwa_validate_config`（`deep: true`） | `validate_add`（那只是单态预检） |
| 加/挂一个态 | `auto_pwa_validate_add` → `auto_pwa_edit_config` | 直接手改 YAML（允许，但跑前必过门禁） |
| 删一个态 | `auto_pwa_remove_resonance` | `edit_config` |
| 从零起草配置 | `auto_pwa_init_config` | 手写 YAML |
| 查 PDG 有没有这个态 | `auto_pwa_lookup` | — |
| 确认某 J^P 物理可达 | `auto_pwa_decay_check` / `auto_pwa_jpc_check` | 凭经验判断 |
| 提交一次拟合 | `auto_pwa_run_fit` | `try_candidates`（那是多候选短拟合） |
| 查拟合跑完没 | 收到通知后 `auto_pwa_fit_status` | 反复轮询 `job_output` |
| 判断拟合好坏 | `auto_pwa_evaluate` → `auto_pwa_diagnose` | 只看 NLL |
| 看某个波的形状 | `auto_pwa_root_view` / `auto_pwa_wave_view` | `evaluate`（那是整体指标） |
| 跑一轮迭代 | `auto_pwa_iterate`（单步）/ `auto_pwa_loop_decide`（状态机） | `auto_pwa_round`（**已弃用**） |
| 并行试多个候选再裁决 | `auto_pwa_try_candidates` → `auto_pwa_compare` | 连续多轮 `run_fit` |
| 记录本轮结论 | `auto_pwa_note` | 自己写 md |
| 查历史 / 能否复现 | `auto_pwa_history`（结论）/ `auto_pwa_git_log`（配置与 commit） | — |

## 2. 加共振态的标准流程（强约束链）

0. `auto_pwa_suggest`：**先发现再验证**——把上轮评估的 pull>3σ 质量区与每个中间态的允许 J^PC 相交，直接列出质量对齐的 PDG 候选（含阈值余量）。决策输入，省去"猜名字再查"的往返。
1. `auto_pwa_config_view`：读 config 的只读 JSON 视图（Particles/链/衰变步/Constraints/校验结果/PDG 交叉引用）。config.yml 是唯一源头；视图只读，要改走 `auto_pwa_edit_config`（或直接编辑 yml，见 §5.3）。
2. `auto_pwa_jpc_check`：查目标中间态**两顶点 J^PC**——衰变顶点（R→d1+d2 允许的 J^PC 全集）∩ 产生顶点（A→R+B 的 J^P + C 守恒要求）。**只写交集里的 J^PC**；被 C 拦截的波会明确标出。**执行门与它同源**（共享 `analyzeIntermediateJPC`），看到的就是会被强制执行的。
3. `auto_pwa_decay_check`：确认目标 J^P 物理可达（角动量+宇称守恒，maxL 截断）。**不可达的 J^P 程序会拒绝**（jp-not-allowed）。
4. `auto_pwa_lookup`：确认候选在 PDG 表里，查它的 J^P、C、质量、宽度。
5. `auto_pwa_validate_add`：程序验证 PDG 依据 / JPC 一致 / 运动学阈值 / 重复 / 参数结构 / float 结构 / **衰变顶点 J^P（规则 10）** / **C 守恒（规则 11）** / **全同选择定则（规则 12）**。**errors 非空时禁止继续**；warnings 是风险提示，模型判断。
6. `auto_pwa_edit_config`：程序改 YAML + **写前总闸**（对最终 config 全文跑结构校验 validateConfig + 交叉引用，errors 非空拒绝写）+ 原子写（自动备份 .bak）。
7. `auto_pwa_validate_config`：**跑前门禁预览**（可喂文件或 YAML 文本，秒回、无 GPU）——结构/交叉引用/两顶点 J^PC/C/阈值/PDG/预算逐项回报；`deep: true`（给路径时默认）再跑 ctpwa `--validate-only`，给出权威自由参数清单与振幅数。
8. `auto_pwa_run_fit` + `auto_pwa_fit_status`：提交拟合（**提交前自动再跑一次门禁，errors 非空直接拒绝提交**）、轮询结果。

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

**优先用 PDGID 判决（`Particles.<name>.pdgid`，有符号 MC 编号：π⁰=111、K⁺=321、K⁻=−321、φ=333、J/ψ=443、Λ=3122、K_S=310）**：
- **全同**：同 pdgid ⇒ 同种粒子。config 必须给同种粒子不同分析名（`pi01`/`pi02`），所以**不能靠名字判全同**——写 pdgid 后 `auto_pwa_jpc_check` 用 `identicalDerived` 标出"同 PDGID 却未声明 `Constraints.identical`"（`identical-missing` warning），并给出该补的组。**引擎仍只认 `Constraints.identical`**：不声明就不对称化，波表还会放进 π⁰π⁰ 的奇 L 波。
- **正反粒子对**：pdgid 变号即共轭对（`CONJUGATE_PAIRS` 名字表只作无 pdgid 时的回退）。K⁰(311)/K̄⁰(−311) 即使被命名成 `K01/K02` 也不会被误判全同。
- **C 本征态**：`selfConjugate`（PDG `cc_type=='S'`）**且** PDG 给出确定 C 值。**不要只看 C 值**：PDG 表给带电态留了假 C（`rho(770)+ → '-'`），必须以 `selfConjugate` 为门。
- **C 三态**：`c-enforced`（母子均 C 本征态 → C(R) 钉死）/ `c-not-applicable`（某端无 C，不施加约束）/ `c-unknown`。C 不是引擎输入，这条门禁是唯一拦 C 违例的地方。
- 加新共振态前若不确定某粒子的 pdgid/自共轭/C，用 `auto_pwa_config_view` 看该粒子行（`pdgid=… = K(S)0 自共轭 C=-` 之类），或 `auto_pwa_lookup`。

**教学案例（为什么会被拦）**：
- **案例 1（C 守恒）**：J/ψ→η R_KK、R_KK→K⁺K⁻。C(R_KK) 必须 = C(J/ψ)·C(η) = −1。K⁺K⁻ 的 2⁺⁺ 波 C=+1 → **f2(1270) 提案被 `c-violation` 拒绝**（产生顶点可达、PDG 有、阈值过也没用）。
- **案例 2（衰变顶点宇称）**：R_Keta→K⁺η 的 1⁺ 波不存在（P=(−1)^L 迫使 J=L 时 P=−1）→ **K1(1410) 按 1⁺ 提案被 `decay-vertex-forbidden` 拒绝**。
- **案例 3（全同选择定则）**：π⁰π⁰ 只允许 L 偶（0⁺⁺,2⁺⁺,4⁺⁺）；ΛΛ（费米子）要求 (−1)^{L+S}=−1。两个全同粒子**必须声明进 `Constraints.identical`**，否则引擎不对称化（validate 会 warning）。

**sl 白名单记号**：config 里 `sl: [S, L]`、`ls: [L, S]`，**S 是物理自旋（整数或半整数，如 0.5 / 1.5）**，与 ctpwa `ConfigParser::parseSLFilter` 一致；工具内部转成 ctpwa 的 **(2S+1, L)** 记号（如 `sl: [0.5, 1]` → 内部 `[2, 1]`；`ls: [1, 1]` → 内部 `[3, 1]`），工具输出的波表用内部记号。两个键都支持，`ls` 在前者优先。

**半整数角动量（重子共振态）**：末态含核子时（p pbar η、K Λ …），中间态 J 是半整数（1/2, 3/2, 5/2 …），`Particles` 的 J 写 `0.5`/`1.5` 或 `"1/2"`/`"3/2"`，`[J, P]` 组同理。产生顶点枚举、波表、`sl` 门禁都支持半整数（2S+1 可为偶数，如 p+η 只有 S=1/2 → 2S+1=2）；PDG 表已含 N*/Δ* 全谱（`auto_pwa_lookup` 可查 N(1720)、N(1520)、Δ(1905) 等）。

## 2.2 删除共振态（显著性剪枝，与"加"对称）

模型太满时必须能删；显著性检查的标准做法就是**删掉某个态再看 ΔNLL**（ΔNLL 不显著 = 该态多余）。

- **`auto_pwa_remove_resonance`**：独立删除工具（`removals: [{name, chain?, jpGroup?, dropDefinition?}]`）。先 dry-run 校验（存在性/作用域/删除后交叉引用）→ 结构化摘除 → 全 config 写前总闸 → 原子写（自动 `.bak`）。errors 非空绝不写。
- **语义（重要）**：删除是**按名摘除**，`[J,P]` 组**即使变空也保留**——因为组顺序决定振幅块索引，`Constraints.trans` 引用的是索引（删组会让后面全部错位）。`Resonances.<name>` 定义只在**已无任何组引用**时删除；`dropDefinition: false` 保留参数以便再挂回。只会影响指定 `chain`/`jpGroup` 的那一处（共轭链可以只删一边）。
- **迭代内删除**：`auto_pwa_round` / `auto_pwa_iterate` / `auto_pwa_loop_decide`(action=iterate) 都接受 `removals`，可与 `proposal` 同时给（先删后加）；只给 `removals` 也能开一轮（纯剪枝轮）。
- **并行显著性试探**：`auto_pwa_try_candidates` 也接受 `removals`（每个删除候选一个 trial），跑完用 `auto_pwa_compare` 看 ΔNLL——**删掉后 ΔNLL 显著变差 ⇒ 该态不可删；ΔNLL 变化在阈值内 ⇒ 可删**。
- **何时删**：`auto_pwa_diagnose` 报份额 < 2σ、参数撞 `free_range` 边界、或强简并（|ρ|>0.8）时。删完必须重拟合并用 ΔNLL/份额确认。

## 3. 物理硬规则（程序强制，模型需理解）

- **PDG 依据**：BWR/BW/Flatte/GS 共振态必须能在 PDG 表命中（名字匹配 id/别名）。**PDG 上没有的新粒子一律拒绝**（`auto_pwa_validate_add`/`edit_config` 路径）——分波分析不能发明粒子。唯一例外：`model: ONE`（相空间项），其振幅 = 势垒因子，mass 参数不参与振幅，命名惯例 `NR*`（如 NR1_KK）。**注意跑前门禁的分工**：门禁把"PDG 无依据"降为 **warning**（出处问题不阻塞，但要在报告里写清），把"阈值/J^PC/C/全同/结构"作为 **error**。手写配置里出现非 PDG 名字时，补 `reference` 或改用 ONE。
- **出处（reference）例外**：若参数来自**最新实验结果**（而非 PDG 平均）或该态尚未被 PDG 收录，提案必须带 `reference`（DOI 或论文名）——此时 PDG 平均一致性检查（质量/J^P/未收录）降为警告并记录出处，但**物理门禁（阈值/衰变顶点 J^P/C 守恒）绝不豁免**。reference 会写入 config.yml 并随迭代继承。用 `auto_pwa_lookup` 看单实验测量历史（stat/syst 分离 + DOI），确认引用的实验值真实存在。
- **JPC 一致性**：提案 (J,P) 必须与 PDG 条目一致。ρ(770) 是 1⁻，写成 0⁺ 会被拒。
- **共振态 J/P 可以不写（ctpwa 约定）**：`Resonances.<name>` 里不写 `J`/`P` 时，量子数完全由它所在的 intermediates `[J,P]` 组决定——**这正是共轭链的写法**：同一个 N(1720) 在 `R_peta`（N*→p η）是 `[1.5, +1]`，在 `R_pbareta`（N̄*→p̄ η）是 `[1.5, −1]`（反粒子内禀宇称约定使 P 反号）。工具**新增共振态时不写 J/P**（只写 model/parameters/free/…），并且不会因为同一态进了 P 相反的组而报 `jpc-conflict`。门禁按组的 J 与 PDG 对齐：**J 不一致 = error**；只在 J 相同、P 相反且共振态没有显式 J/P 时给 `jpc-parity-convention` **warning**（提示确认这是有意的共轭波）。若共振态**显式**写了 J/P（如 `J: 1.5, P: -1`），则与提案组不一致仍是 `jpc-conflict` error。
- **运动学阈值**：m_R ≤ m_A − m_B（on-shell）。接近阈值 → off-shell 风险 → 建议 float 质量；具体阈值随通道而变，用 `auto_pwa_decay_check` 查你的通道。
- **参数结构（含特殊公式逃生舱）**：BWR/BW/GS 恰好 [质量, 宽度] GeV；Flatte 需要 `channels`；ONE 给 0 或 1 个占位质量（可不写 `parameters`）；**Interp**（外部插值表）与 **Custom**（DSL）参数可空，载荷写在 `options`（如 `options: {file: ..., method: linear}`）。**未知模型名不再被插件拒绝**（只 warning），由 ctpwa `--validate-only` 在跑前定论——这条逃生舱就是为了试新公式。参数长度错 ctpwa 直接崩溃（门禁的 deep 检查会先拦）。
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

- 迭代目录：`<分析目录>/iterations/iter-N/`，每轮完整自包含：`config.yml`、`fit.py`（链接到插件自带 `scripts/aifit.py`）、`results/`、`note.md`（本轮决策记录）。
- **不要**从其他分析目录/旧迭代抄 fit.py 或 config 写法——`auto_pwa_iter_start` 已把 fit.py 链到插件自带脚本，config 写法以本项目 init_config.yml + `config_view` 视图为准。
- **config 位置与变体**：`ctpwa.analysis()` 从**当前工作目录**读 config.yml，但驱动脚本支持 `--config <path>`（`auto_pwa_run_fit` 的 `config` 参数会自动补上，SLURM 与本地一致），所以变体实验（`variant_broad.yml` 等）可以放在同一迭代目录里直接拟合，不必再复制成 config.yml。Data 段仍建议绝对路径。
- 拟合程序：`<ctpwa env>/bin/python fit.py`，需要 LD_LIBRARY_PATH 含 ROOT lib + CUDA lib64 + torch/lib（插件已注入）。**ctpwa 仅支持 GPU**（CPU 后端未实现）——本机无 GPU 时 `auto_pwa_run_fit` 走 **SLURM**：写 `fit.slurm`（`cd` 到迭代目录、前台 `python -u fit.py`）、`sbatch`、登录节点轮询、跑完唤醒。只有本机既无 CUDA 也无 SLURM 才立即失败并给诊断。
- **AI 优先驱动 `scripts/aifit.py`**（`PWA_FIT_SCRIPT` 指向它）：同一引擎、零改动，但输出 `results/fit.json`——每 run NLL/正定性、**best 参数±误差与撞边界标记**、分波贡献（config 有 `phsp_truth` 时）、结构化错误码（config-error/no-gpu/fit-failed）。`auto_pwa_fit_status` 自动优先读 fit.json；`--validate-only` 可无 GPU 快速校验 config（DecayInfo），日常用 `auto_pwa_validate_config` 即可（`deep: true` 走的就是它；顺带打印权威参数清单/顺序/振幅数，续算按名字对齐初值时用它，无需 CUDA）。短拟合：`PWA_AIFIT_RUNS=1 PWA_AIFIT_MAX_ITER=500`（多候选并行的基础）。
- fit.py 默认 10 个随机初值各跑到收敛（最高 10000 次 LBFGS 迭代），输出到 `results/`：`nll_history.txt`（每次运行一段）、`parameters.txt`、`optimization_summary.txt`（最佳 NLL/正定性/分支比）、`weight_best.root`。
- 拟合是**长任务**（10–30 分钟级）：`auto_pwa_run_fit` 返回 jobId 并立即结束本步——拟合作为**当前会话拥有的后台任务**运行。**完成时 DSH 自动唤醒本会话**（通知形如 `background job ctpwa-N finished`，直接开一个新回合）。所以：**不要**循环 `job_output`/`job_list` 空转，也不要等；收到通知（或自动续回合）后用 `auto_pwa_fit_status` 取结果。
- **只有"提交成功"才可能被唤醒**：被跑前门禁拒绝时没有任务，也就没有通知（按返回的 errors 改配置）。若返回里**没有 jobId**、却在 `job_list` 里看到 ctpwa-N，说明工具返回值本身出了问题（插件 bug 的表现；`job_list` 只是兜底观察手段）。

## 5.1 迭代主循环：状态机 + 同会话 goal

**主路径（推荐）用循环状态机工具**（持久化在 `iterations/.loop-state.json`，重启可续）：
- `auto_pwa_loop_next`：评估当前迭代（NLL/ΔNLL/max|pull|/逐分布 chi2/ndf/Hessian）→ 按判据（`stopMaxPull`、`stopMaxChi2Ndf`、显著阈值、`maxRounds` 预算）判定收敛 → **收敛则写 `FINAL-REPORT.md` 并 phase=done**；未收敛则进入 propose 阶段。首次调用传 `baseIterDir` 启动。
- `auto_pwa_loop_decide`：把 AI 决策落盘——`iterate`（验证+建轮+写 config+提交拟合）、`rollback`（当前轮标记失败、基线回退到上一轮）、`converge`（强制收敛出报告）。
- 每轮循环：`loop_next`（评估/判收敛）→ 决策（`suggest`/`diagnose`/`compare` 辅助）→ `loop_decide iterate` → 等拟合完成通知 → 回到 `loop_next`。

**并行探索（提速关键）**：`auto_pwa_try_candidates` 在基座上并行提交 2–5 个候选的**短拟合**（默认 `--runs 1 --max-iter 500`，目录在 `iterations/_trials/`，不进 iter-N 序列）；全部完成后 `auto_pwa_compare` 按 ΔNLL 显著性（默认阈值 3，2 自由度）裁决，**最优者晋级**为正式迭代。探索与晋级分离，一轮时间试探多个方向。

**结论传递首选"同一个会话里连续上下文"，不是"写摘要给下一个会话"。** 跨会话传递（A 写 conclusion → B 读）会丢失推理细节（为什么选这个态、排除了什么），压缩即损失。

- 会话开始时用 `create_goal` 建立目标：objective 写明收敛判据（**所有分布 chi2/ndf ≤ 2（≈1 即 pull 分布为 0 附近涨落）且 max|pull| < 5、|ΔNLL| < 3**）、时间预算（如"总时间预算 3 小时，每轮在 note 中记录耗时"）、轮数上限（`max_goal_rounds`，建议 15）。
- 之后 DSH 自动续回合：**每轮结束自动开始下一轮，上下文连续**——模型记得自己上轮的全部推理，不需要重新读文件重建理解。
- **拟合是 DSH 后台任务（ctpwa-N，owner=当前 agent）**：提交后**不要轮询**——完成时 DSH 自动通知（"background job ctpwa-N finished"），收到通知或自动续回合后再查结果；`job_list`/`job_output`/`job_kill` 可随时用。
- 每轮动作序列（goal 回合内）：
  1. 等上轮拟合通知 → `auto_pwa_fit_status` 取结果（NLL/正定性/日志）
  2. `auto_pwa_evaluate` 分析上轮 weight_best.root（数值诊断；完整 JSON 在 evaluate.json，输出过大时会 spill 到 locator 按需读）
  3. `auto_pwa_diagnose` 把 fit.json 事实转成假设（撞边界/份额不显著/强干涉对/**参数高相关**——|ρ|>0.8 的参数对无法独立确定，建议固定一个或合并）
  4. **`auto_pwa_root_view` 直接看拟合形状**：先 `list` 发现直方图，再 `read` 取关键对象——每个共振态的波谱 `h_<chain>-<intermediate>-<resonance>`（该共振态的质量谱形状与大小）、角分布 `cosbeta_*`、`hdata`/`hfit` 逐 bin 对比。**这是"哪个共振态主导/缺失/形状异常"的第一手证据**——pull 区对应哪个波谱、哪个共振态形状被压低，直接决定下一步动什么
  5. **`auto_pwa_wave_view` 画分波组合**：选中几个波（如 pull 区的候选）→ 看它们的合成分布 vs 数据谱——"缺什么"的直接检验；`eventWeights=true` 时输出选中波对干涉分布（**大文件，非必要不用**，用完自动删）
  6. `auto_pwa_suggest` 按 pull 区列出候选；`lookup`/`decay_check`/`jpc_check` 复核
  7. `auto_pwa_loop_next` 判收敛；未收敛 → `auto_pwa_loop_decide iterate`（或先 `try_candidates` + `compare` 探索再晋级）
  8. **假设-预测-验证**：`auto_pwa_loop_decide` 提交决策时带 `hypothesis`（物理假设）与 `prediction`（结构化可验证预测，如 `{metric: maxPull, threshold: 3, direction: below}` 或 regionPull 指定质量窗）。下一轮 `auto_pwa_loop_next` 评估后**自动验证并返回 🔍 结果**（成立/不成立 + 实际值）——预测被证伪 = 假设错了，换方向；预测成立 = 归因正确，继续深入。
  9. 拟合完成通知后回到 1；`auto_pwa_note` 写审计记录（**includeTokens: true** 记本轮 token 消耗；结论 + hypothesis/prediction/verification + 下一步计划）
- 收敛（loop 判定 done）或轮数耗尽 → `update_goal complete`，读 `FINAL-REPORT.md` 给用户总结。
- `auto_pwa_git_log`：本地历史（哪些轮改了什么、某态何时进入、是否已提交）——"审计 + 复现"的第一入口。
- `auto_pwa_note` / `auto_pwa_history` 的角色：**审计日志 + 崩溃/中断恢复**（新会话里用 `auto_pwa_history` + `auto_pwa_loop_status` 恢复上下文，含每轮 token 成本）+ 用户阅读（HTML 日记）。决策主通道始终是连续会话上下文。

## 5.2 harness 机制（少人工，多自主）

- **拟合完成自动唤醒（background job 机制）**：`pwa-fit-local` 把拟合注册为 `ctx.jobs` 的后台任务，**owner = 当前 Agent**。这带来三件事：① 完成时 `dsh-tool-jobs` 向 owner 会话投递通知——owner 空闲就**直接开一个新回合**（唤醒），忙就注入下一步；② 会话结束/被销毁时任务被取消（不再有无主孤儿任务）；③ `job_output`/`job_list`/`job_kill` 按会话围栏只看得见自己的任务。**前提是 owner 接对了**：DSH 的 `Agent` 用 `id` 表示会话（没有 `sessionId` 字段），owner 传错会让任务变成"无主"——任务照跑、`job_list` 也看得到，但**通知永远不投递**，表现就是"提交完就停、必须人来催"。
- **config.yml 写门禁已改为"跑前门禁"（2026）**：`pwa-guard` 现在只拦 `init_config.yml`；config.yml 与任意变体 yml 都可直接编辑（结构化工具仍是快车道）。**提交拟合前**门禁强制跑一遍：`gateConfig`（YAML 结构 / 交叉引用 / trans 块索引 / identical / 两顶点 J^PC + C / 阈值 / 预算）→ 有 error 直接拒绝提交；无 error 再跑 ctpwa `--validate-only`（能解 `Resonances: <file>` include、模型名、参数结构）。想让门禁更严可设 `PWA_GATE_REQUIRE_DEEP=1`（把"deep 跑不起来"从 warning 升级为 error）。
- **拟合记录（B1）**：每次提交写 `<iterDir>/results/provenance.json`：config md5（含外部 include 的 md5）、态清单/参数/free、初值来源（random seed 或 warm 起点）、fit.py + md5、`scriptArgs`（runs/max-iter）、Data 样本路径。`auto_pwa_note` 自动把它带进日记；同一目录里 config 或运行设置变了会给 `config-changed-since-record` / `run-settings-changed` warning——**两次条件不同的拟合不许直接比 ΔNLL**。
- **/pwa-status 命令**：用户在 GUI 直接输入 `/pwa-status <iterationsRoot>` 看后台任务 + 最近 5 轮日记（不占模型消息）；模型无需主动汇报。
- **token-meter**：`auto_pwa_note` 带 `includeTokens: true` 时记录本轮 token 差值（上次记账以来），`auto_pwa_history` 可回看每轮成本——长会话成本透明，不需要人工查账。

## 5.3 本地 git 记录（B2：可还原，不只是可发现）

每个分析目录自带一个**独立仓库** `<分析目录>/.pwa-git`（`git --git-dir=.pwa-git --work-tree=.`）：
不 push、无远端、不碰外层 repo，删掉即消失。它和 `results/provenance.json` 的 md5 互补——
md5 只能**发现**配置变过，git 能**还原**任意一轮的原文。

- **只跟踪文本**：`config.yml`/变体 `*.yml`、`results/fit.json`、`results/provenance.json`、`SUMMARY.jsonl`、`note.md`、脚本、报告；忽略 `*.root`/`*.dat`（保留小体积输入表 `interp_*.dat`）/`fit.log`/`*.html`/`*.png`。规则写在分析目录 `.gitignore` 的托管块里（`auto-pwa managed`，可整块删）。
- **两个提交点**（自动，无需你操作）：① 每次工具写 config（`edit_config`/`remove_resonance`/`round`/`iterate`/`loop_decide`/`iter_start`/`try_candidates`）→ `iter-007: add phi1680 -> R_KK [1-]`；② `auto_pwa_note` → `iter-007 result: ... NLL=-18685.80 dNLL=-12.30`，同提交里含**当时实际拟合的配置**（provenance 记的 `configPath`，可能是 `variant.yml`）。于是"结论数字"和"当时的配置"永远对得上。
- **查历史用 `auto_pwa_git_log`**：`action=log`（最近 N 轮）/ `show`（某轮 config diff，用 provenance 里的 commit）/ `search`（pickle：`needle=X1750` 回答"这个态哪轮进来的"）/ `status`（有无未提交改动）。`file` 可相对分析目录或相对 `path` 所在目录。
- **可复现性怎么判**：`provenance.git.dirty=true` = 已跟踪文件与 HEAD 不同，结果不能由 HEAD 复现；门禁还会做 md5 ↔ commit 互验，若**拟合用的配置根本不在 HEAD 里**（手写变体没提交）会给 `git-config-not-committed` warning（不阻塞拟合）。这两条一起，才算"真可复现"。
- **失败绝不阻塞**：git 缺失/仓库异常只降级为 warning；`PWA_GIT=off` 完全关闭记录。记录不是门禁。

## 5.3 跑前门禁与"可信度刹车"

**门禁的分工**（`auto_pwa_validate_config` 与 `auto_pwa_run_fit` 内部同源）：

| 类别 | 硬 error（拒绝提交） | warning（只提示） |
|---|---|---|
| 配置正确性 | YAML 结构、交叉引用、trans 块索引、identical 组、产生阈值、两顶点 J^PC、C 守恒、外部 include 无法校验（`PWA_GATE_REQUIRE_DEEP=1` 时） | PDG 无依据/显式 J^P 与 PDG 不符/宽度偏离、定义未引用、重复 PDG id、态数与放开参数超软预算、无声明 identical、组内成员 >6 |

**"自由度"是自由，"下结论"不自由**：加多少态、用什么模型/公式都由模型决定（这是实验设计）；但

1. **波强度之和 / 总强度**（`auto_pwa_diagnose` 的 `wave-cancellation`）：干涉矩阵对角和 ÷ 总强度 ≫ 1（≥3 danger，≥1.5 warn）= 靠大振幅互相抵消凑出来的退化解，**NLL 更好也不能信**。
2. **参数精确贴边**（`param-exact-boundary`）：拟合值精确等于 `free_range` 端点（如 1.60000000 撞上限 1.6）= 不是测量值，不许带误差上报；要么放宽区间、要么固定、要么删态。
3. **分 bin 泊松偏差**（`auto_pwa_evaluate` 的 `poisson_deviance_ndf` 与 `poisson_deviance_top_bins`）：低计数区比 χ² 更可靠；top_bins 显示偏差是集中在一处还是到处都有。
4. **Hessian 正定 + 份额显著性 + ΔNLL 阈值**（见 §6）。

三项体检（波强度比、泊松偏差、贴边）+ Hessian 是"这个解可不可信"的刹车；只盯 NLL 一定会上当。

## 6. 拟合质量判断（第二步，迭代决策）

- **pull 分布（收敛主判据）**：`auto_pwa_evaluate` 对每个分布输出 `chi2_ndf`（chi2 = Σ pull²，ndf = bin 数−1）。**chi2/ndf ≈ 1 就是"pull 分布为 0 附近涨落"**（各 bin pull 是 N(0,1) 噪声）；> 2 判为仍有系统性偏差。**chi2/ndf 与 max|pull| 不是一回事**：所有 bin 系统性偏 +2σ（chi2/ndf≈4）时 max|pull| 可能仍 < 5；反之 100 个 bin 里 1 个 5.5σ 离群在统计上正常却会卡住 max|pull|。循环收敛要求两者都过：逐分布 chi2/ndf < `stopMaxChi2Ndf`（默认 2）且 max|pull| < `stopMaxPull`（默认 5）且 |ΔNLL| < 显著阈值。
- **泊松偏差（低计数的 χ² 补充）**：`poisson_deviance_ndf` ≈ 1 理想；`poisson_deviance_top_bins` 按贡献列出最不符的 3 个 bin（center/deviance/data/model）——比 max|pull| 更能区分"局部一处不对"还是"整体形状不对"。
- **退化解刹车**：`wave-cancellation`（波强度之和/总强度 ≥3 danger，≥1.5 warn）与 `param-exact-boundary`（参数精确贴在 free_range 端点）——两者都常伴随"更好看的 NLL"，出现即不可信，先处理再谈 ΔNLL。
- **ΔNLL 显著性**：新共振态约 2 个自由参数——|ΔNLL| ≥ 3（≈ 2σ）才算显著改进；|ΔNLL| < 3 不显著，考虑删除或换方案；ΔNLL < 10 的旧判据仅作为"不再值得继续"的停止参考（`loop` 的 `significanceThreshold`/`stopDeltaNll` 可调）。
- **Hessian 正定性**：`fit.json` 里 best run 正定才有参数误差可信；不正定 → 参数不可靠（loop 会提示）。
- **撞边界**：float 参数贴 range 端点 = 数据不支持该自由度的信号（`auto_pwa_diagnose` 直接给建议）；**精确等于端点**（`param-exact-boundary`）尤其不能当测量值，必须放宽区间/固定/删态后再谈。
- **份额不显著**：`fitFractions` 中 fraction < 2σ（fraction/error < 2）的分波对拟合无贡献，删除后 ΔNLL 预计 < 3。
- **强干涉对**：`interference.topInterference` 中 |值| > 20% 的波对通常需要独立耦合参数。
- **勒让德矩（moments）**：`auto_pwa_evaluate` 对角分布输出 M_L/M_0（L=2,4,6，数据 vs 拟合）。自旋 0 介子对（如 KK）需 J ≥ L/2 才有 M_L——数据矩高于拟合 = 缺该 J 的波；拟合矩高于数据 = 该波可能多余。Δ 最大的 L 就是"下一步该动哪个 J"的直接信号。
- **AIC/BIC（模型选择）**：`auto_pwa_compare` 输出 ΔAIC = 2Δk + 2ΔNLL、ΔBIC = Δk·ln(N) + 2ΔNLL（ΔNLL<0 为改进）。即使 ΔNLL 显著，若 ΔBIC > 0 = 复杂度惩罚超过改进，谨慎采纳。
- 组内成员过多（>6）→ 过拟合风险，优先替换而非追加（validate 会给 crowded-group warning）。
- 迭代记录写进 `note.md` 和 `SUMMARY.jsonl`，供下一轮参考。

## 7. 注意

- 每次只做一个决策并跑一轮拟合，用 ΔNLL 判断，不要一次性堆多个新共振态（无法归因）。
- **不要翻其他项目/旧迭代文件夹**来"学习"或"找依据"——init_config.yml 与 `auto_pwa_config_view` 就是全部依据（§0）。
- 目标目录不确定时**只问一次**，然后按答案开跑；不要再做一轮文件夹考古才回来确认。
- 拟合环境问题（GPU 等）按 `auto_pwa_run_fit` 的诊断处理或问用户，不要自己手动探测（§0）。
- 所有工具输出都是规范 JSON；模型负责科学判断，工具负责确定性执行。

## 线形模型惯例（**只提醒，不强制**）

`data/lineshape-conventions.json` 记的是**惯例**：`auto_pwa_lookup` 会返回 `suggestedModel`，
`auto_pwa_validate_add` 在偏离时给 `model-deviates-from-convention` warning。**永远不会因此报错**——
同一个共振态在不同过程形状里可以合法地选不同线形（语料证据见 `data/lineshape-usage-stats.json`：
`f0_980` 在 chicj2KKeta 用 BWR、在 KsKs 用 Flatte，两种都在用）。

| 态 | 惯例 | 何时可以不用 |
|---|---|---|
| f0(980) / a0(980) | **Flatte** | 阈值效应不主导、或不需要 K K̄ 耦合道时 |
| ρ(770) | **GS** | 远离 ρ 峰、或拟合需要更简单线形时 |
| f2(1270) / K1(1270) | **BWR** | 与强阈值道耦合时考虑 Flatte |
| f0(1500) | **BWR**（默认起点） | 各分析用法不一（BWR/BW/GS 都出现过），按需替换 |

**为什么要保留"偏离"的自由**：线形是拟合选择（阈值位置、附近道、稳定性都会改变最优选择），
不是粒子属性。惯例只是让你从"常见做法"起步，并在偏离时提醒你确认是不是有意的。
