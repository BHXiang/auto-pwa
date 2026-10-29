# auto-pwa

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 AI 驱动**分波分析（PWA）**插件：物理门禁的 config 编辑、ctpwa 拟合执行、数值化拟合评估、goal 驱动的迭代收敛。

分两层架构：

- **`src/` — 纯物理核心**（无 DSH 依赖）：PDG-2026 查询、J^P 可达性、两顶点 J^PC 规则（`jpc.ts`：逐点复刻 ctpwa `Amp2BD::ComSL` 波枚举、共轭对/全同粒子 C 规则）、共振态添加校验（10 条硬规则）、结构化 config.yml 编辑（含 Constraints/衰变步解析与 `validateConfig`）、float 策略建议、拟合结果解析、迭代日记（JSONL + HTML）、本地拟合运行器。
- **`plugin/` — 薄 DSH 集成**：二十七个 `auto_pwa_*` 工具包装核心，经 `--patch` 挂入任意 DSH profile。

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

### 方式 A：一键安装（推荐，npm 全局）

包自带 `auto-pwa` 启动器（双态 delegating launcher，模式同 dsh-tui）：

```sh
# 1. 全局安装 dsh CLI + 本插件
npm install -g @deepseek-ai/dsh auto-pwa

# 2. 首次运行自动执行 dsh plugin --profile web add auto-pwa 并启动 Web GUI；
#    之后每次运行 = dsh --profile web（委托 profile 内副本，版本随 --upgrade 前进）
auto-pwa

# 升级 / headless / 自定义 profile：
auto-pwa --upgrade
auto-pwa -p headless "完成此文件夹分波"     # 或 export DSH_PWA_PROFILE=headless
```

等价的手动形式（无需启动器）：`pnpm dsh plugin --profile web add auto-pwa`——包 manifest 声明 `dsh.bundle.patch`（`patch/auto-pwa.bundle.yml`），`dsh plugin add` 会自动把它 reconcile 进 profile 的 `dsh.profile.bundles` 层栈，之后 `pnpm dsh web` 直接生效，无需 `--patch`。

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
| `plugin/pwa-guard.ts` | 单调 deny 门禁：只拦直接写 `init_config.yml`（必须走 `auto_pwa_init_config`）。**config.yml 已放开**——正确性改由"跑前门禁 + `results/provenance.json` 记录"保证（见下） |
| `plugin/pwa-commands.ts` | `/pwa-status [<iterationsRoot>]` — 实时后台任务 + 迭代日记摘要 |
| `plugin/auto-pwa.ts` | Consumer：二十七个 `auto_pwa_*` 工具；run_fit/fit_status 走 `ctx.pwaFit`；大输出 spill 进 `ctx.spillStore`；`auto_pwa_note` 记录每轮 token 消耗 |

## 工具

| 工具 | 用途 | 层 |
|---|---|---|
| `auto_pwa_lookup` | 查询 PDG-2026 共振态表（名称/J^P/J^PC/质量区间/衰变末态，含不确定度与 C 宇称 + **单实验测量历史**：最近 8 条，含 stat/syst 误差、DOI、入平均标记） | 决策·参考 |
| `auto_pwa_decay_check` | A → R + B 允许的中间态 J^P（角动量+宇称守恒），阈值以下候选 | 决策·参考 |
| `auto_pwa_jpc_check` | **两顶点 J^PC 检查**：衰变顶点 J^PC 集（ComSL 一致，含全同选择定则）∩ 产生顶点 J^P 与 C 守恒，逐中间态输出 + 按 J^PC 过滤的 PDG 候选（与写入门禁**同源**） | 决策·参考 |
| `auto_pwa_config_view` | config.yml 只读 JSON 视图（粒子/链+衰变步/共振态/运动学/Constraints + validateConfig + PDG 交叉引用） | 决策·参考 |
| `auto_pwa_validate_config` | **跑前门禁预览（秒级、无 GPU）**：喂文件或 YAML 文本 → 结构/交叉引用/两顶点 J^PC+C/阈值/PDG/预算逐项回报；`deep` 再跑 ctpwa `--validate-only`（解 include、模型名、参数结构，并打印权威自由参数清单/顺序/振幅数） | 执行·门禁 |
| `auto_pwa_suggest` | **候选发现**：pull>3σ 质量区 × 允许 J^PC → 按质量对齐度排序的 PDG 候选（含阈值余量） | 决策·发现 |
| `auto_pwa_diagnose` | **拟合诊断**：fit.json 事实 → 可行动假设（**波强度之和/总强度退化解**、**参数精确贴边**、撞边界/份额不显著/强干涉/**参数高相关简并**/Hessian） | 决策·诊断 |
| `auto_pwa_evaluate` | 数值诊断（chi2/ndf、pull 区域、**分 bin 泊松偏差 + top 偏差 bin**、分波份额、**勒让德矩 M_L/M_0**）+ PNG | 决策·诊断 |
| `auto_pwa_root_view` | **ROOT 直方图直读**（AI 的眼睛）：list 列全部直方图 / read 取任意直方图逐 bin 数据——每个共振态的波谱 `h_<chain>-<int>-<res>`（大小与形状）、角分布 `cosbeta_*`、data/fit/bkg 对比 | 决策·视力 |
| `auto_pwa_wave_view` | **任意分波组合分布**（干涉视力）：writeResult(waves) 画选中波组合的拟合分布（与全波同归一化直接对比）；`eventWeights` 时才用逐事件 TTree（大文件，慎用）并输出选中波对干涉分布 | 决策·视力 |
| `auto_pwa_compare` | 基座 vs 候选 trial 的 ΔNLL 显著性裁决 + **AIC/BIC 复杂度惩罚**（ΔAIC=2Δk+2ΔNLL，ΔBIC 需数据事件数），推荐晋级者 | 决策·裁决 |
| `auto_pwa_validate_add` | "添加共振态"只读门禁（PDG 依据、JPC、阈值、衰变顶点 J^P、C 守恒、全同选择定则、重复、free 结构） | 执行·门禁 |
| `auto_pwa_trans_suggest` | **trans 关系计算**：任意链的 `steps` + 每个态的 `I/I3/C` → 同位旋 CG 比值、C 逐顶点检查、可直接粘贴的 `Constraints.trans` 条目（通用，不绑定反应道） | 执行·工具 |
| `auto_pwa_init_config` | **从 0 创建 config**（结构化提案 → 渲染 → 与 edit 同源的门禁 → 原子写 `init_config.yml` + reviewSummary 交人工复核；`preview` 只构建不写） | 执行·起草 |
| `auto_pwa_edit_config` | config.yml 编辑**快车道**（也可直接编辑任意 yml，跑前门禁兜底）：校验 → 结构化修改 → **写前总闸（全文 validateConfig + 交叉引用）** → 原子写（+ .bak）；支持 `options` 逃生舱（Interp/Custom/GS 等特殊公式原样透传 ctpwa） | 执行 |
| `auto_pwa_iter_start` | 创建 `iterations/iter-N/`（config 副本 + 脚本软链；Data 路径绝对化告警） | 执行 |
| `auto_pwa_run_fit` / `auto_pwa_fit_status` | 提交/查询 ctpwa 拟合（DSH 后台任务 `ctpwa-N`，完成自动通知；**提交前强制跑前门禁，errors 非空拒绝提交**；支持 `config`/`scriptArgs` 变体实验，并写 `results/provenance.json`） | 执行 |
| `auto_pwa_try_candidates` | **并行候选短拟合**：基座上试 2–5 个候选（`_trials/` 目录，`--runs 1 --max-iter 500`），每个 trial 都过跑前门禁 | 执行·探索 |
| `auto_pwa_git_log` | **本地 git 记录（无远端）**：`<分析目录>/.pwa-git` 里每轮 config 改动 + 结果 NLL 各一条提交；log/show/search(pickaxe)/status——"谁改了哪一条""这个态哪轮进来的""结果能否由 HEAD 复现" | 执行·审计 |
| `auto_pwa_note` / `auto_pwa_history` | 追加/读取迭代日记（SUMMARY.jsonl + 渲染 HTML；含每轮 token 成本） | 执行·审计 |
| `auto_pwa_loop_next` | **可选循环评估**：评估→收敛判定（pull/ΔNLL/预算）→ FINAL-REPORT.md；`forceConverge` 手动收尾；主路径仍是 `run_fit` | 执行·可选 |

## 迭代闭环

```
auto_pwa_loop_next（评估 + 收敛判定）
   └─> 未收敛 → auto_pwa_suggest / auto_pwa_diagnose（决策输入）
   └─> auto_pwa_try_candidates + auto_pwa_compare（并行探索，最优晋级）
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

## PDGID 驱动的粒子身份与对称性（`Particles.<name>.pdgid`）

config 的 `Particles` 以**分析名为键**，而同一末态的多份同种粒子必须取不同名字（`pi01`/`pi02`/`pi03` 都是 π⁰）。这曾让对称性判定退化成"名字启发式"：门禁只在两个 daughter **同名**时才提示未声明 `Constraints.identical`，于是 `pi01/pi02`、`KS1/KS2` 这类**静默漏判**——引擎不做 Bose/Fermi 对称化，波表里还会放进 π⁰π⁰ 的奇 L 波。

现在给粒子写上 **PDGID**（有符号 Monte-Carlo 编号，即社区说的 PDGID）即可由**数据**判决：

```yaml
Particles:
  pi01: {J: 0, P: -1, mass: 0.1350, pdgid: 111}
  pi02: {J: 0, P: -1, mass: 0.1350, pdgid: 111}
  Kp:   {J: 0, P: -1, mass: 0.4937, pdgid: 321}
  Km:   {J: 0, P: -1, mass: 0.4937, pdgid: -321}
Constraints:
  identical:
    - [pi01, pi02]     # 校验会提示这一条缺失（identical-missing）
```

- **全同**：同 PDGID ⇒ 同种粒子（Bose/Fermi 选择定则）。引擎仍只认 `Constraints.identical`（按名分组），所以校验会报 `identical-missing` 提示补声明；`auto_pwa_jpc_check` 用 `identicalDerived`（物理事实）标出"同 PDGID 但未声明"。
- **正反粒子对**：`pdgid` 变号（或 `antiparticle`）⇒ C=(−1)^{L+S}；`CONJUGATE_PAIRS` 名字表降级为**无 pdgid 时的回退**。
- **自共轭 / C 本征态**：`selfConjugate`（PDG `cc_type == 'S'`）+ 确定的 PDG C 值。**不允许只看 C 值**——PDG 表给带电态留了假 C（`rho(770)+ → '-'`），所以 `selfConjugate` 是门，`c` 只取值。
- **C 三态标签**（`auto_pwa_jpc_check`）：`c-enforced`（末态母子均为 C 本征态 → C(R) 被钉死，C 违例的波进 `cBlocked`）/ `c-not-applicable`（某端无 C，明确不施加）/ `c-unknown`（缺运动学）。C 不是引擎输入，这条门禁是唯一拦 C 违例的地方。
- **校验警告**（`validateConfig(cfg, db)`，全部是 warning，不 brick config）：`pdgid-unknown`、`pdgid-j-mismatch`、`pdgid-p-mismatch`、`pdgid-c-not-eigenstate`、`identical-missing`、`identical-pdgid-mismatch`。**无 `pdgid` 的旧 config 行为完全不变**。
- **数据来源**：`data/pdg.json` 的 `particles` 表（mcid → name/ccType/selfConjugate/charge/J/P/C/G/I/conjugate），由 `scripts/fetch_pdg.py` 从官方 pdg sqlite 生成（599 个介子/重子/轻子/γ 条目）；`pdgid` 是插件扩展，ctpwa 的 `parseParticles` 只读 J/P/mass/tex/polarization，会忽略这个键，**引擎无感知**。

## 从 0 起草 config（`auto_pwa_init_config`）

全新分析不再需要手写 `config.yml`。流程是 **对话采集 → 物理研究 → 结构化提案 → 门禁渲染 → 人工复核 → 开跑**：

```text
用户对话（ask_user_question）
  └─ 反应道/母粒子/末态；数据与 MC（路径/格式/树名/branch 顺序）；是否含本底；maxL 约定
物理研究（不需要 config）
  ├─ auto_pwa_decay_check：A→R+B 允许的 J^P + 阈值 + 阈值下 PDG 候选
  └─ auto_pwa_lookup：确认候选在 PDG 上（J^P/质量/宽度/衰变模式）
auto_pwa_init_config  →  <dir>/init_config.yml（errors=0 才写；preview 只构建）
人工复核闸门（reviewSummary → 用户确认）
auto_pwa_iter_start(baseConfigPath=<dir>/init_config.yml) → iter-000 → 开跑
```

- **输入是结构化 spec，不是 YAML**：`particles`（**只写 `pdgid` 即可**，J/P/质量自动取自 PDG 表）/ `chains`（steps + intermediates 的 [J,P] 组）/ `resonances`（每个都过 `auto_pwa_validate_add` 同源门禁）/ `constraints` / `data` / `plot`。
- **Plot 自动生成**：spec 不写 `plot` 时，按每个中间态的衰变步自动生成 **1D 质量谱 `M([d1,d2])`**（范围 = `[m(d1)+m(d2), m(母)−m(旁观者)]`）+ **1D 衰变角 `CosAngle([d1],[d1,d2])`**。两者都是 1D，因为 `auto_pwa_evaluate` 从质量谱算 pull/chi2（收敛判据）、从角分布算勒让德矩（缺哪个 J 的信号）。写 `plot: []` 可显式关掉。
- **Data 文件级校验**：传入分析目录后逐样本检查文件是否存在（相对路径按分析目录解析），缺文件 → `data-file-missing`；样本格式不对 → `data-sample-malformed`。
- **创建 = 编辑**：共振态经 `applyResonanceAddition` 插入，渲染经同一个 `dumpConfig`，因此创建与后续编辑产出的 YAML 逐字段一致（有单测对比）。
- **写前总闸**：`validateConfig(cfg, db)` + `crossReferenceErrors` + 逐共振态物理门禁；errors 非空**拒绝写**。写入是原子写（临时文件 + rename），覆盖时自动 `.bak`。
- **人工复核**：返回 `reviewSummary`（反应道、每个中间态的 [J,P] 组与共振态、粒子身份、数据样本、约束、缺项提示）+ `requiresHumanReview: true`。**`init_config.yml` 仍由 `pwa-guard` 独占保护**（只能由 `auto_pwa_init_config` 生成）；它复制出的 `config.yml`/变体 yml 可由 AI 直接编辑，但跑前必过门禁。
- **迭代衔接**：`auto_pwa_iter_start` 会把 `init_config.yml` 复制成 `iter-000/config.yml` 并把 Data 路径绝对化（现在对 flow/block、加引号/不加引号的写法都生效）。

研究阶段的两个工具配合：`auto_pwa_decay_check`（A→R+B 允许的 J^P + 阈值）定粗方向；`auto_pwa_jpc_check` 逐中间态给出**两顶点交集 J^PC** + C 三态 + **按阈值过滤的 PDG 候选**（每个候选带 `thresholdMargin` on-shell 余量、`decaysTo` 是否 PDG 列出该衰变、C 是否已知；超阈值的候选被排除并报 `filteredAboveThreshold`）。先 `init_config`（`resonances: []`，`preview: true`）拿骨架，再 `jpc_check` 定候选，最后带 `resonances` 定稿——不需要手写 YAML。

`Data` 路径绝对化已改为 YAML 感知（`parseDocument` 改标量后重排），块状写法（AI 生成的默认形式）不再漏改；`unresolved` 才告警，已绝对化的配置不会误报。

## 环境配置（可选，开箱即用）

所有机器相关路径都通过环境变量覆盖；**默认值可移植**——拟合驱动默认用插件自带的 `scripts/aifit.py`，python 走 PATH：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PWA_CTPWA_PYTHON` | `python`（PATH 解析） | ctpwa 环境 python；非激活环境请显式指定绝对路径 |
| `PWA_LD_LIBRARY_PATH` | 空（不注入，继承环境） | 导入 ctpwa 所需的 ROOT/CUDA/torch 库路径（仅非激活环境需要） |
| `PWA_FIT_SCRIPT` | 插件自带 `scripts/aifit.py` | 拟合驱动来源（AI 适配：写 `results/fit.json` + `weight_best.root`） |
| `PWA_PLOT_SCRIPT` | 空（不软链 plot.py） | 你的求解器 plot.py（需要出图时设置） |
| `PWA_EVAL_OUT_DIR` | 空（用 `<cwd>/_auto-pwa-eval`） | `auto_pwa_evaluate` 输出目录 |
| `PWA_GIT` | 空（开，独立仓库） | `off` 关闭本地 git 记录（`.pwa-git`）；默认每个分析目录建独立仓库，只提交文本、绝不 push |
| `PWA_GIT_ROOT` | 空（就近判定） | 强制仓库根（须已存在）。一个分析目录下有很多 `run_*` 变体目录时，用它把这些目录统一进一个历史 |
| `PWA_GATE_REQUIRE_DEEP` | 空（关） | 设 `1` 时把"ctpwa `--validate-only` 跑不起来"从 warning 升级为硬 error（严格流水线用；默认不因环境问题挡住提交） |
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
# 日常直接用 auto_pwa_validate_config（deep: true 走的就是这条），会打印
# 权威自由参数清单/顺序/振幅数——按名字对齐续算初值时不需要 GPU。
python aifit.py --config config.yml --validate-only --json /tmp/validate.json

# 完整拟合（默认 10 次运行 × 10000 迭代；短拟合用于多候选并行）：
python aifit.py --config config.yml --runs 1 --max-iter 500 --json results/fit.json
```

**变体实验**：`auto_pwa_run_fit` 的 `config` 参数会补成 `--config <path>`（本地与 SLURM 一致），配合 `scriptArgs` 即可在同一迭代目录里跑 `variant_xxx.yml`、切阈值区、换模型等对照，无需复制成 config.yml。

**优化器内核与 `ctpwa/example/fit.py` 同源。** `aifit.py` 不再自带旧内联优化器
（"torch LBFGS + 就地 clamp + 投影梯度清零"，会在边界静默伪收敛、耦合无界增长
到 1e14、被 `free_range` 钉住的参数仍报伪误差）；它复用
[`scripts/pwa_optimizer.py`](scripts/pwa_optimizer.py) —— 自 `example/fit.py`
vendored 的优化器内核（MIT），默认走 **reparam** 重参数化软墙路径（耦合极坐标
`amp = amp_max·sigmoid(u)`、共振态 `theta = lo+(hi-lo)·sigmoid(u)`），随后对
最优起点做 **damped-Newton polish**，并在**非活跃子空间**上判正定/求参数误差
（被边界钉住的参数如实报 `null`）。`--optimizer projected|lbfgs` 可切到对照路径；
`--no-polish`、`--amp-max`、`--amp-lambda`、`--vmax`、`--lr`/`--tol-grad`/
`--tol-change`/`--history-size` 与 `FIT_*` 环境变量同名同默认值。
另外 `--config` 现在会把路径**显式**交给 `ctpwa.analysis(path)`（旧代码依赖
`cwd/config.yml`，传 `--config other.yml` 会静默读错文件）。

`fit.json` 包含：每轮 NLL/迭代数/正定性/**优化器停机状态**、best 参数**带误差与撞边界标记**、**参数相关性矩阵**（Hessian 反演，含 Re/Im 耦合与共振态参数名，|ρ|>0.8 由 diagnose 自动标记简并）、分波贡献（`getFitFractions`）/分支比（config 提供 `phsp_truth` 时）、**从 weight_best.root 读回的干涉矩阵**（引擎已把 `interference` TMatrixD + `legends` 波名写进 ROOT 文件，无需 `getSLAmpsTensor`——每事件全波表太大易爆内存）、warnings、结构化错误码（`config-error` / `no-gpu` / `fit-failed` / `usage-error`，非零退出码）。读取器有防御性：未初始化内存条目（`|M| > 1e6`）会被检测并报告为 `interference.available: false`，绝不把垃圾当物理喂给模型。

```sh
# 从已有权重文件提取干涉矩阵（不拟合、无 GPU）：
python aifit.py --interference results/weight_best.root --json results/interference.json
```

环境变量默认值：`PWA_AIFIT_RUNS`（10）、`PWA_AIFIT_MAX_ITER`（10000），以及
`example/fit.py` 同名的 `FIT_*`。`auto_pwa_fit_status` 自动优先读 `fit.json`
（参数/分波/干涉直接出现在工具输出里）；旧的 `optimization_summary.txt` 解析保留为回退。

### pull 分布的定义（`auto_pwa_evaluate`）

`auto_pwa_evaluate` 的残差按**物理模型**算：ctpwa 把信号模型 `hfit` 与本底模板
`hbkg` 分开写，因此

```
residual = data - (fit + bkg)          # 无 hbkg 时退化为 data - fit
pull     = residual / sqrt(fit + bkg)  # Pearson；chi2 = Σ residual²/(fit+bkg)
```

与 `ctpwa/example/plot.py` 一致（此前误用 `data-fit` + `1/sqrt(data)`）。每个分布的
`evaluate.json` 记录 `has_background` 与 `residual` 字段，工具输出顶部也会标注本
次评估用的是哪一种残差。

## 开发

- 纯核心无环境依赖、单测覆盖（160+ 测试）：`npm test`。
- Python 数值回归（pull 残差定义 / reparam 往返 / vendored 优化器 + polish /
  `build_best_json`）：`<ctpwa env>/bin/python tests/python/test_optimizer_and_pull.py`
  （只需 numpy+torch，无 GPU/无 ctpwa 也可跑）。
- 插件导入 `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-jobs`；测试解析 **vendored stubs**（`vendor/dsh/`），无需 DSH 检出。stub 恰好覆盖插件用到的 API 面；DSH API 变化时保持同步。
- `scripts/fetch_pdg.py` 从官方 PDG-2026 包重新生成 `data/pdg.json`（需在 ctpwa 环境 `pip install pdg`）。
- 拟合需要 CUDA GPU（ctpwa 无 CPU 后端）；运行器探测并快速失败给出明确诊断。

## 设计文档

- [工具真值表](docs/tool-truth-table.md) — 24 个工具：层/实测频次/何时用/何时不要用→改用什么 + 7 条不变式（路由评估的 ground truth）。
- [工具表面与记忆系统：现状、业界做法与待办](docs/tool-and-memory-plan.md) — 实测数据、拆分/合并方案、记忆系统分类、**评测协议 v2**（MemoryAgentBench 四大能力 + 确定性聚合的实证）与反模式（T1/T3/T4 已执行，T2/T5 与记忆系统仍待做）。
- [IO 与用法](docs/io-and-usage.md) — 完整输入输出、工具清单、跑前门禁与本地 git 记录约定。
- [能力评估与计划](docs/capability-eval-and-plan.md) — 能力边界与演进路线。

## License

MIT — 见 [LICENSE](LICENSE)。
