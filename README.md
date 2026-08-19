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

挂载进 DSH（插件文件必须是绝对路径）：

```sh
pnpm dsh web --patch /absolute/path/to/auto-pwa/patch/auto-pwa.cordis.yml
# headless:
pnpm dsh --profile headless --patch /absolute/path/to/auto-pwa/patch/auto-pwa.cordis.yml "完成此文件夹分波"
```

patch 挂载五个插件文件（服务三角色 + 硬门禁 + 斜杠命令）：

| 插件 | 角色 |
|---|---|
| `plugin/pwa-fit.ts` | 服务定义：`ctx.pwaFit` 拟合契约（请求/状态类型） |
| `plugin/pwa-fit-local.ts` | 本地 Provider：拟合注册为 DSH 后台任务（`ctpwa-N`，owner 围栏）；完成自动通知代理进入下一轮 |
| `plugin/pwa-guard.ts` | 单调 deny 门禁：直接 `write`/`edit`/bash 写 `config.yml` 一律拦截（必须走 `auto_pwa_edit_config`） |
| `plugin/pwa-commands.ts` | `/pwa-status [<iterationsRoot>]` — 实时后台任务 + 迭代日记摘要 |
| `plugin/auto-pwa.ts` | Consumer：十四个 `auto_pwa_*` 工具；run_fit/fit_status 走 `ctx.pwaFit`；大输出 spill 进 `ctx.spillStore`；`auto_pwa_note` 记录每轮 token 消耗 |

## 工具

| 工具 | 用途 |
|---|---|
| `auto_pwa_lookup` | 查询 PDG-2026 共振态表（名称/J^P/J^PC/质量区间/衰变末态，含不确定度与 C 宇称） |
| `auto_pwa_decay_check` | A → R + B 允许的中间态 J^P（角动量+宇称守恒），阈值以下候选 |
| `auto_pwa_jpc_check` | **两顶点 J^PC 检查**：衰变顶点 J^PC 集（ComSL 一致，含全同选择定则）∩ 产生顶点 J^P 与 C 守恒，逐中间态输出 + 按 J^PC 过滤的 PDG 候选 |
| `auto_pwa_config_view` | config.yml 只读 JSON 视图（粒子/链+衰变步/共振态/运动学/Constraints + validateConfig + PDG 交叉引用） |
| `auto_pwa_validate_add` | "添加共振态"只读门禁（PDG 依据、JPC、阈值、衰变顶点 J^P、C 守恒、全同选择定则、重复、free 结构） |
| `auto_pwa_edit_config` | 强约束 config.yml 编辑：校验 → 结构化修改 → 渲染 → 原子写（+ .bak） |
| `auto_pwa_iterate` | 一轮迭代：校验 → 新建迭代目录（Data 路径绝对化）→ 写 config → 提交拟合 |
| `auto_pwa_round` | **主路径**：评估上一轮（NLL/ΔNLL/最差 pull/收敛提示）+ 迭代，一次调用完成 |
| `auto_pwa_run_fit` / `auto_pwa_fit_status` | 提交/查询 ctpwa 拟合（DSH 后台任务 `ctpwa-N`，完成自动通知；无 GPU 快速失败） |
| `auto_pwa_evaluate` | weight_best.root → 数值诊断（chi2/ndf、pull 区域、分波份额）+ PNG |
| `auto_pwa_iter_start` | 创建 `iterations/iter-N/`（config 副本 + 脚本软链） |
| `auto_pwa_note` / `auto_pwa_history` | 追加/读取迭代日记（SUMMARY.jsonl + 渲染 HTML） |

## 迭代闭环

```
auto_pwa_round（评估 + 决策 + 提交）
   └─> 拟合后台运行（RTX 级 GPU 约 8 分钟；DSH 完成通知自动送达）
   └─> 下一轮 auto_pwa_round 评估结果，模型决定下一个提案
   └─> 收敛判据：max|pull| < 5 且 |ΔNLL| < 10
```

用同会话 goal 驱动自动多轮迭代（`create_goal` + 自动续回合；拟合完成通知会唤醒/注入下一轮评估）。

## 机器相关路径

环境变量（见 `src/config.ts`）：

| 环境变量 | 默认（开发机） |
|---|---|
| `PWA_CTPWA_PYTHON` | ctpwa conda 环境 python |
| `PWA_LD_LIBRARY_PATH` | 导入 ctpwa 所需的 ROOT/CUDA/torch 库路径 |
| `PWA_FIT_SCRIPT` / `PWA_PLOT_SCRIPT` | 求解器 fit.py/plot.py 来源 |
| `PWA_EVAL_OUT_DIR` | auto_pwa_evaluate 输出目录 |

## AI 优先拟合驱动（`scripts/aifit.py`）

`fit.py` 输出给人看的文本；**`aifit.py` 是面向 AI 的拟合驱动**——同一 ctpwa 引擎、零引擎改动，跑相同的 LBFGS 循环并写出结构化的 `results/fit.json`：

```sh
# 无 GPU 校验 config（DecayInfo，秒级，不构造 analysis()）：
python aifit.py --config config.yml --validate-only --json results/fit.json

# 完整拟合（默认 10 次运行 × 10000 迭代；短拟合用于多候选并行）：
python aifit.py --config config.yml --runs 1 --max-iter 500 --json results/fit.json
```

`fit.json` 包含：每轮 NLL/迭代数/正定性、best 参数**带误差与撞边界标记**、分波贡献（`getFitFractions`）/分支比（config 提供 `phsp_truth` 时）、**从 weight_best.root 读回的干涉矩阵**（引擎已把 `interference` TMatrixD + `legends` 波名写进 ROOT 文件，无需 `getSLAmpsTensor`——每事件全波表太大易爆内存）、warnings、结构化错误码（`config-error` / `no-gpu` / `fit-failed` / `usage-error`，非零退出码）。读取器有防御性：未初始化内存条目（`|M| > 1e6`）会被检测并报告为 `interference.available: false`，绝不把垃圾当物理喂给模型。

```sh
# 从已有权重文件提取干涉矩阵（不拟合、无 GPU）：
python aifit.py --interference results/weight_best.root --json results/interference.json
```

环境变量默认值：`PWA_AIFIT_RUNS`（10）、`PWA_AIFIT_MAX_ITER`（10000）。把 `PWA_FIT_SCRIPT` 指向 `aifit.py` 后，`auto_pwa_fit_status` 自动优先读 `fit.json`（参数/分波/干涉直接出现在工具输出里）；旧的 `optimization_summary.txt` 解析保留为回退。

## 开发

- 纯核心无环境依赖、单测覆盖（113 个测试）：`npm test`。
- 插件导入 `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-jobs`；测试解析 **vendored stubs**（`vendor/dsh/`），无需 DSH 检出。stub 恰好覆盖插件用到的 API 面；DSH API 变化时保持同步。
- `scripts/fetch_pdg.py` 从官方 PDG-2026 包重新生成 `data/pdg.json`（需在 ctpwa 环境 `pip install pdg`）。
- 拟合需要 CUDA GPU（ctpwa 无 CPU 后端）；运行器探测并快速失败给出明确诊断。

## 说明

- 本仓库只包含插件代码与数据。研究计划与开发文档（`PLAN-STEP1.md`、`PLAN-STEP2.md`、`dev-plan.html`、`docs/`）为本地研发文档，**不上传 GitHub**。
- 物理规则速查与迭代作业规则见 skill（`skills/auto-pwa-analysis/SKILL.md`，安装于 `~/.dsh/skills/`）。

## License

MIT — 见 [LICENSE](LICENSE)。
