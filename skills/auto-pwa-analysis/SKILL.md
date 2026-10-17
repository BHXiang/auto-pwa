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

## 2.2 删除共振态（显著性剪枝，与"加"对称）


模型太满时必须能删；显著性检查的标准做法就是**删掉某个态再看 ΔNLL**（ΔNLL 不显著 = 该态多余）。

- **`auto_pwa_remove_resonance`**：独立删除工具（`removals: [{name, chain?, jpGroup?, dropDefinition?}]`）。先 dry-run 校验（存在性/作用域/删除后交叉引用）→ 结构化摘除 → 全 config 写前总闸 → 原子写（自动 `.bak`）。errors 非空绝不写。
- **语义（重要）**：删除是**按名摘除**，`[J,P]` 组**即使变空也保留**——因为组顺序决定振幅块索引，`Constraints.trans` 引用的是索引（删组会让后面全部错位）。`Resonances.<name>` 定义只在**已无任何组引用**时删除；`dropDefinition: false` 保留参数以便再挂回。只会影响指定 `chain`/`jpGroup` 的那一处（共轭链可以只删一边）。
- **迭代内删除**：`auto_pwa_round` / `auto_pwa_iterate` / `auto_pwa_loop_decide`(action=iterate) 都接受 `removals`，可与 `proposal` 同时给（先删后加）；只给 `removals` 也能开一轮（纯剪枝轮）。
- **并行显著性试探**：`auto_pwa_try_candidates` 也接受 `removals`（每个删除候选一个 trial），跑完用 `auto_pwa_compare` 看 ΔNLL——**删掉后 ΔNLL 显著变差 ⇒ 该态不可删；ΔNLL 变化在阈值内 ⇒ 可删**。
- **何时删**：`auto_pwa_diagnose` 报份额 < 2σ、参数撞 `free_range` 边界、或强简并（|ρ|>0.8）时。删完必须重拟合并用 ΔNLL/份额确认。

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

## 7. 注意


- 每次只做一个决策并跑一轮拟合，用 ΔNLL 判断，不要一次性堆多个新共振态（无法归因）。
- **不要翻其他项目/旧迭代文件夹**来"学习"或"找依据"——init_config.yml 与 `auto_pwa_config_view` 就是全部依据（§0）。
- 目标目录不确定时**只问一次**，然后按答案开跑；不要再做一轮文件夹考古才回来确认。
- 拟合环境问题（GPU 等）按 `auto_pwa_run_fit` 的诊断处理或问用户，不要自己手动探测（§0）。
- 所有工具输出都是规范 JSON；模型负责科学判断，工具负责确定性执行。

## 延伸阅读（按需加载，别一次全读）

- `skill auto-pwa-iter` —— 迭代主循环/状态机、harness 自主、本地 git、跑前门禁、拟合质量判断（**跑迭代时读**）
- `skill auto-pwa-pdg` —— PDG 依据/本地登记/`reference`/线形惯例/名称与 pdgid（**加态前读**）
- `skill auto-pwa-jpc` —— 两顶点 J^PC、衰变顶点门禁、C 守恒、阈值、maxL（**起草新链/加态前读**）
- `debug-auto-pwa` —— 插件本地安装与调试（开发者用）

## 全部工具索引（27）

`auto_pwa_lookup` · `auto_pwa_decay_check` · `auto_pwa_jpc_check` · `auto_pwa_init_config` · `auto_pwa_config_view` · `auto_pwa_validate_config` · `auto_pwa_suggest` · `auto_pwa_validate_add` · `auto_pwa_edit_config` · `auto_pwa_remove_resonance` · `auto_pwa_round` · `auto_pwa_iter_start` · `auto_pwa_note` · `auto_pwa_git_log` · `auto_pwa_history` · `auto_pwa_iterate` · `auto_pwa_evaluate` · `auto_pwa_diagnose` · `auto_pwa_root_view` · `auto_pwa_wave_view` · `auto_pwa_run_fit` · `auto_pwa_fit_status` · `auto_pwa_try_candidates` · `auto_pwa_compare` · `auto_pwa_loop_next` · `auto_pwa_loop_status` · `auto_pwa_loop_decide`

