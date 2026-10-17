---
name: auto-pwa-iter
description: 'Use when running the PWA iteration loop: iteration folder layout, the state machine and same-session goal, harness autonomy, local git records, the pre-fit gate and the fit-quality judgment.'
---

# 迭代执行与质量判断（按需加载）

跑迭代、判拟合质量时读；加态与 PDG 问题见 `auto-pwa-pdg` / `auto-pwa-jpc`。

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

