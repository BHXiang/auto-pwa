# auto-pwa

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 AI 驱动**分波分析（PWA）**插件：物理门禁的 config 编辑、ctpwa 拟合执行、数值化拟合评估、goal 驱动的迭代收敛。

分两层架构：

- **`src/` — 纯物理核心**（无 DSH 依赖）：PDG-2026 查询、J^P 可达性、两顶点 J^PC 规则（`jpc.ts`：逐点复刻 ctpwa `Amp2BD::ComSL` 波枚举、共轭对/全同粒子 C 规则）、共振态添加校验（10 条硬规则）、结构化 config.yml 编辑（含 Constraints/衰变步解析与 `validateConfig`）、float 策略建议、拟合结果解析、迭代日记（JSONL + HTML）、本地拟合运行器。
- **`plugin/` — 薄 DSH 集成**：十四个 `auto_pwa_*` 工具包装核心，经 `--patch` 挂入任意 DSH profile。

## 快速开始

```sh
# 1. 安装依赖（yaml 运行时 + 开发工具）
npm install

# 2.（可选）链接 DeepSeek Harness 检出，做真实 API 开发
DSH_ROOT=/path/to/deepseek-harness npm run dev:setup

# 3. 测试 / 类型检查 / 构建
npm test
npm run typecheck
npm run build
```

### 方式 A：npm bundle 安装（推荐，profile 持久声明）

包 manifest 声明 `dsh.bundle.patch`（`patch/auto-pwa.bundle.yml`），可发布到 npm（公开或私有 registry）后像任何 DSH 插件一样安装：

```sh
# 1. 安装依赖 + 声明 bundle（转发 pnpm；然后手动在 profile package.json 的
#    dsh.profile.bundles 列表加一行 "auto-pwa"）
pnpm dsh plugin --profile web add auto-pwa

# 2. 之后每次启动都生效，无需 --patch：
pnpm dsh web
```

skill（`auto-pwa-analysis`）由插件启动时**自动注册**（`ctx.skills.register`），无需手动复制到 `~/.dsh/skills`。

### 方式 B：本地 patch 挂载（开发/未发布时）

```sh
pnpm dsh web --patch /absolute/path/to/auto-pwa/patch/auto-pwa.cordis.yml
# headless:
pnpm dsh --profile headless --patch /absolute/path/to/auto-pwa/patch/auto-pwa.cordis.yml "完成此文件夹分波"
```

两种方式挂载相同的四个插件文件（服务 Provider + 硬门禁 + 斜杠命令；`plugin/pwa-fit.ts` 是服务定义库，由 pwa-fit-local 导入并注册 `ctx.pwaFit`，**不作为插件挂载**——挂载它会被 loader 当类插件实例化，导致 `service "pwaFit" has been registered` 重复注册）：

| 插件 | 角色 |
|---|---|
| `plugin/pwa-fit-local.ts` | 本地 Provider：拟合注册为 DSH 后台任务（`ctpwa-N`，owner 围栏）；完成自动通知代理进入下一轮 |
| `plugin/pwa-guard.ts` | 单调 deny 门禁：直接 `write`/`edit`/bash 写 `config.yml` 一律拦截（必须走 `auto_pwa_edit_config`） |
| `plugin/pwa-commands.ts` | `/pwa-status [<iterationsRoot>]` — 实时后台任务 + 迭代日记摘要 |
| `plugin/auto-pwa.ts` | Consumer：二十一个 `auto_pwa_*` 工具；run_fit/fit_status 走 `ctx.pwaFit`；大输出 spill 进 `ctx.spillStore`；`auto_pwa_note` 记录每轮 token 消耗 |

## 工具

| 工具 | 用途 | 层 |
|---|---|---|
| `auto_pwa_lookup` | 查询 PDG-2026 共振态表（名称/J^P/J^PC/质量区间/衰变末态，含不确定度与 C 宇称 + **单实验测量历史**：最近 8 条，含 stat/syst 误差、DOI、入平均标记） | 决策·参考 |
| `auto_pwa_decay_check` | A → R + B 允许的中间态 J^P（角动量+宇称守恒），阈值以下候选 | 决策·参考 |
| `auto_pwa_jpc_check` | **两顶点 J^PC 检查**：衰变顶点 J^PC 集（ComSL 一致，含全同选择定则）∩ 产生顶点 J^P 与 C 守恒，逐中间态输出 + 按 J^PC 过滤的 PDG 候选（与写入门禁**同源**） | 决策·参考 |
| `auto_pwa_config_view` | config.yml 只读 JSON 视图（粒子/链+衰变步/共振态/运动学/Constraints + validateConfig + PDG 交叉引用） | 决策·参考 |
| `auto_pwa_suggest` | **候选发现**：pull>3σ 质量区 × 允许 J^PC → 按质量对齐度排序的 PDG 候选（含阈值余量） | 决策·发现 |
| `auto_pwa_diagnose` | **拟合诊断**：fit.json 事实 → 可行动假设（撞边界/份额不显著/强干涉/**参数高相关简并**/Hessian） | 决策·诊断 |
| `auto_pwa_evaluate` | 数值诊断（chi2/ndf、pull 区域、分波份额、**勒让德矩 M_L/M_0**）+ PNG | 决策·诊断 |
| `auto_pwa_root_view` | **ROOT 直方图直读**（AI 的眼睛）：list 列全部直方图 / read 取任意直方图逐 bin 数据——每个共振态的波谱 `h_<chain>-<int>-<res>`（大小与形状）、角分布 `cosbeta_*`、data/fit/bkg 对比 | 决策·视力 |
| `auto_pwa_wave_view` | **任意分波组合分布**（干涉视力）：writeResult(waves) 画选中波组合的拟合分布（与全波同归一化直接对比）；`eventWeights` 时才用逐事件 TTree（大文件，慎用）并输出选中波对干涉分布 | 决策·视力 |
| `auto_pwa_compare` | 基座 vs 候选 trial 的 ΔNLL 显著性裁决 + **AIC/BIC 复杂度惩罚**（ΔAIC=2Δk+2ΔNLL，ΔBIC 需数据事件数），推荐晋级者 | 决策·裁决 |
| `auto_pwa_validate_add` | "添加共振态"只读门禁（PDG 依据、JPC、阈值、衰变顶点 J^P、C 守恒、全同选择定则、重复、free 结构） | 执行·门禁 |
| `auto_pwa_edit_config` | 强约束 config.yml 编辑：校验 → 结构化修改 → **写前总闸（全文 validateConfig + 交叉引用）** → 原子写（+ .bak） | 执行 |
| `auto_pwa_round` | 一轮迭代：评估上一轮（NLL/ΔNLL/最差 pull/收敛提示）+ 迭代，一次调用完成 | 执行 |
| `auto_pwa_iter_start` | 创建 `iterations/iter-N/`（config 副本 + 脚本软链；Data 路径绝对化告警） | 执行 |
| `auto_pwa_run_fit` / `auto_pwa_fit_status` | 提交/查询 ctpwa 拟合（DSH 后台任务 `ctpwa-N`，完成自动通知；无 GPU 快速失败） | 执行 |
| `auto_pwa_try_candidates` | **并行候选短拟合**：基座上试 2–5 个候选（`_trials/` 目录，`--runs 1 --max-iter 500`），门禁与正式迭代一致 | 执行·探索 |
| `auto_pwa_note` / `auto_pwa_history` | 追加/读取迭代日记（SUMMARY.jsonl + 渲染 HTML；含每轮 token 成本） | 执行·审计 |
| `auto_pwa_loop_next` / `auto_pwa_loop_status` / `auto_pwa_loop_decide` | **循环状态机**：评估→收敛判定（pull/ΔNLL/预算）→ FINAL-REPORT.md；决策落盘（iterate/rollback/converge）；状态持久化 `.loop-state.json` 重启可续 | 执行·自动化 |

## 迭代闭环

```
auto_pwa_loop_next（评估 + 收敛判定）
   └─> 未收敛 → auto_pwa_suggest / auto_pwa_diagnose（决策输入）
   └─> auto_pwa_try_candidates + auto_pwa_compare（并行探索，最优晋级）
   └─> auto_pwa_loop_decide iterate（验证 + 建轮 + 写 config + 提交拟合）
   └─> 拟合后台运行（RTX 级 GPU 约 8 分钟；DSH 完成通知自动送达）
   └─> 收敛 → FINAL-REPORT.md + phase done
```

用同会话 goal 驱动自动多轮迭代（`create_goal` + 自动续回合；拟合完成通知会唤醒/注入下一轮评估）。

## 出处（reference）机制：参数不跟 PDG 平均

真实分波分析中，某些共振态参数来自**最新实验结果**而非 PDG 平均值（或该态尚未被 PDG 收录）。提案带 `reference` 字段（DOI 或论文名）即声明出处：

- **质量/J^P 与 PDG 平均的偏离**：从硬错误降为警告（`mass-mismatch`/`jpc-mismatch` 豁免；`not-on-pdg` 对未收录态放行）——记录 `jpc-deviates-with-reference` / `not-on-pdg-with-reference` 警告
- **物理门禁绝不豁免**：运动学阈值、衰变顶点 J^P、C 守恒照常强制
- **DOI 交叉核对**：reference 命中 `pdg.json` 里该态的单实验测量时，输出 `reference-measurement-check` 警告（测量值 vs 提案值偏差）；未命中给 `reference-not-found`
- **随 config 继承**：reference 写入 `config.yml` 的 `Resonances.<name>.reference`，随迭代复制，`auto_pwa_config_view` 可见
- **数据来源**：`data/pdg.json` 的 `measurements[]` 由 `scripts/fetch_pdg.py` 从官方 pdg 包提取（单实验值 + stat/syst 误差 + DOI/Inspire 引用，最近 6 条/态，137/200 态已覆盖）；重跑 `npm run fetch:pdg` 可刷新

## 环境配置（可选，开箱即用）

所有机器相关路径都通过环境变量覆盖；**默认值可移植**——拟合驱动默认用插件自带的 `scripts/aifit.py`，python 走 PATH：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PWA_CTPWA_PYTHON` | `python`（PATH 解析） | ctpwa 环境 python；非激活环境请显式指定绝对路径 |
| `PWA_LD_LIBRARY_PATH` | 空（不注入，继承环境） | 导入 ctpwa 所需的 ROOT/CUDA/torch 库路径（仅非激活环境需要） |
| `PWA_FIT_SCRIPT` | 插件自带 `scripts/aifit.py` | 拟合驱动来源（AI 适配：写 `results/fit.json` + `weight_best.root`） |
| `PWA_PLOT_SCRIPT` | 空（不软链 plot.py） | 你的求解器 plot.py（需要出图时设置） |
| `PWA_EVAL_OUT_DIR` | 空（用 `<cwd>/_auto-pwa-eval`） | `auto_pwa_evaluate` 输出目录 |
| `PWA_FIT_TRANSPORT` | `auto` | `auto`/`local`/`slurm`：拟合在哪跑。auto = 本机 torch 看得到 CUDA → 本地；无 CUDA 但有 slurm 客户端 → 交作业（"无 GPU 但能 SLURM"规则）。 |
| `PWA_SLURM_TEMPLATE` | `a100` | `a100`/`v100`：集群模板，决定 partition/qos/account/gres 默认 |
| `PWA_SLURM_PARTITION` / `PWA_SLURM_QOS` / `PWA_SLURM_ACCOUNT` / `PWA_SLURM_GRES` | 模板默认 | 逐集群覆盖（如 `--partition=gpupwa --qos=pwadedicate --gres=gpu:a100:2`） |
| `PWA_SLURM_NTASKS` / `PWA_SLURM_MEM_PER_CPU` / `PWA_SLURM_TIME` | `1` / `50000` / 无 | sbatch 资源覆盖 |
| `PWA_SLURM_BATCH` | `auto` | `auto`/`one`/`script`/`off`：候选试探批处理。auto = 按基座拟合实测 `fit.json.timeSec` 判（<120s → script 多合一脚本；否则 → one 每候选一作业，全部完成才唤醒） |

## 集群（SLURM）传输：无本地 GPU 也能跑

大多数用户没有本地 GPU，但集群登录节点有 SLURM。插件按 `PWA_FIT_TRANSPORT` 自动路由：

- **本机有 CUDA**（作者开发机）→ 本地 `python fit.py`（现状不变）。
- **无 CUDA 但有 `sbatch`/`squeue`/`sacct`**（登录节点）→ 写 `fit.slurm` 并 `sbatch` 交作业；登录节点轮询直到作业离开队列，**DSH 后台任务的 `done` 在作业真正结束前不 resolve——所以跑完会唤醒 AI**（`background job ctpwa-N finished` 通知注入/打开下一轮）。`cancel` → `scancel`。
- 两者都不可用 → 立即失败并给诊断。

要点：

- **唤醒 = 一个 DSH 后台任务（`ctpwa-N`）包住一个/一批 SLURM 作业**；批量（`auto_pwa_try_candidates`，SLURM transport）会把这些候选合成**一个** DSH 任务（`one` = 每候选一个 SLURM 作业并行，`script` = 一个脚本顺序跑），全部结束才 settle，**一次唤醒**，不会刷屏。
- **本机 transport 不变**：作者开发机/测试仍走 `ctx.pwaFit.submit` 每候选一个 DSH 任务（`PWA_FIT_TRANSPORT` 未显式设 `slurm` 时不批处理）。
- **共享文件系统是前提**：compute 节点要能读 `iterDir`（`config.yml`/`fit.py`）并写 `results/`；典型 NFS/Lustre 的 home/scratch 满足。
- 脚本里 `#SBATCH` 用**前台** `python -u fit.py`（A100/V100 一致），并 `cd` 到迭代目录（aifit.py 从 cwd 读 config.yml）。
- **每次提交/结束都写 `<iterations>/.slurm-jobs.json`**（状态记录：状态/批标记/子任务/submit 目录）。这是"AI 快速重建项目状态"的渠道之一：`/pwa-status <iterationsRoot>` 实时列出后台任务 + 迭代日记 + 集群作业，`auto_pwa_history` 读迭代日记（SUMMARY.jsonl），两者合起来即项目状态全景。
- **DSH 后台任务在内存里**：登录节点重启/GUI 关闭会丢失唤醒锚点（SLURM 作业仍会在集群跑完、但 DSH 不知道要唤醒）。小时级作业建议在登录节点上保持 harness 会话存活；跨重启的自动重挂 `done` 在确认重启后可作为后续增强。

## AI 优先拟合驱动（`scripts/aifit.py`，默认拟合程序）

**`aifit.py` 是面向 AI 的拟合驱动**——同一 ctpwa 引擎、零引擎改动，跑相同的 LBFGS 循环并写出结构化的 `results/fit.json`；它是 `PWA_FIT_SCRIPT` 的默认值，新装插件无需任何配置即可迭代（也兼容手写 fit.py，设置 `PWA_FIT_SCRIPT` 或工具参数即可切换）：

```sh
# 无 GPU 校验 config（DecayInfo，秒级，不构造 analysis()）：
python aifit.py --config config.yml --validate-only --json results/fit.json

# 完整拟合（默认 10 次运行 × 10000 迭代；短拟合用于多候选并行）：
python aifit.py --config config.yml --runs 1 --max-iter 500 --json results/fit.json
```

`fit.json` 包含：每轮 NLL/迭代数/正定性、best 参数**带误差与撞边界标记**、**参数相关性矩阵**（Hessian 反演，含 Re/Im 耦合与共振态参数名，|ρ|>0.8 由 diagnose 自动标记简并）、分波贡献（`getFitFractions`）/分支比（config 提供 `phsp_truth` 时）、**从 weight_best.root 读回的干涉矩阵**（引擎已把 `interference` TMatrixD + `legends` 波名写进 ROOT 文件，无需 `getSLAmpsTensor`——每事件全波表太大易爆内存）、warnings、结构化错误码（`config-error` / `no-gpu` / `fit-failed` / `usage-error`，非零退出码）。读取器有防御性：未初始化内存条目（`|M| > 1e6`）会被检测并报告为 `interference.available: false`，绝不把垃圾当物理喂给模型。

```sh
# 从已有权重文件提取干涉矩阵（不拟合、无 GPU）：
python aifit.py --interference results/weight_best.root --json results/interference.json
```

环境变量默认值：`PWA_AIFIT_RUNS`（10）、`PWA_AIFIT_MAX_ITER`（10000）。`auto_pwa_fit_status` 自动优先读 `fit.json`（参数/分波/干涉直接出现在工具输出里）；旧的 `optimization_summary.txt` 解析保留为回退。

## 开发

- 纯核心无环境依赖、单测覆盖（160+ 测试）：`npm test`。
- 插件导入 `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-jobs`；测试解析 **vendored stubs**（`vendor/dsh/`），无需 DSH 检出。stub 恰好覆盖插件用到的 API 面；DSH API 变化时保持同步。
- `scripts/fetch_pdg.py` 从官方 PDG-2026 包重新生成 `data/pdg.json`（需在 ctpwa 环境 `pip install pdg`）。
- 拟合需要 CUDA GPU（ctpwa 无 CPU 后端）；运行器探测并快速失败给出明确诊断。

## License

MIT — 见 [LICENSE](LICENSE)。
