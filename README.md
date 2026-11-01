# auto-pwa

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 **AI 驱动分波分析（PWA）插件**：把
ctpwa 拟合包成 25 个 `auto_pwa_*` 工具，覆盖从起草 config 到迭代收敛的全过程。

模型不需要记住 J^PC 规则——规则在代码里算：

- **物理门禁**：PDG-2026 查询、J^P 可达性、两顶点 J^PC（复刻 ctpwa `Amp2BD::ComSL` 波枚举、正反粒子对
  与全同粒子的 C 规则）、运动学阈值、全同选择定则、float 策略；`auto_pwa_validate_add` / `auto_pwa_edit_config`
  在写文件之前就把错误挡住。
- **拟合**：`auto_pwa_run_fit` 提交 ctpwa 拟合（本地 CPU/GPU、SLURM 或自定义脚本），后台运行、完成即唤醒；
  自带 `scripts/aifit.py` 驱动，产出结构化 `results/fit.json` + `weight_best.root`。
- **评估**：`auto_pwa_evaluate` / `auto_pwa_diagnose` 把 `weight_best.root` 变成 pull 分布、分波份额，以及
  撞边界 / 简并 / Hessian 判据上的可行动假设。
- **迭代**：`auto_pwa_iter_start` / `auto_pwa_loop_next` / `auto_pwa_note` 维护每轮目录、迭代日记与本地 git 记录。

**架构**：`src/` 是不依赖 DSH 的纯物理核心（可独立单测）；`plugin/` 是薄 DSH 集成。
操作手册以 skill 形式随插件自动注册（`auto-pwa-analysis`、`auto-pwa-jpc`、`auto-pwa-pdg`、`auto-pwa-iter`）。

## 安装

要求：Node.js ≥ 20 + [pnpm](https://pnpm.io/)（DSH 用它管理 profile）；真实拟合另需一个装了 `ctpwa`
（及 torch / uproot）的 Python 环境。

### A. 一键安装（推荐）

```sh
npm install -g @deepseek-ai/dsh auto-pwa
auto-pwa              # 首次运行会自动 dsh plugin --profile web add auto-pwa 并打开 Web GUI
auto-pwa --upgrade    # 升级插件
auto-pwa -p headless "完成此文件夹分波"    # headless profile
```

手动等价形式：`pnpm dsh plugin --profile web add auto-pwa`。包 manifest 声明了 `dsh.bundle.patch`，
`dsh plugin add` 会把它接进 profile 的 bundles 层栈，之后 `pnpm dsh web` 直接生效。

### B. 本地 patch 挂载（开发 / 未发布）

```sh
git clone https://github.com/BHXiang/auto-pwa.git && cd auto-pwa
npm install && npm run build
pnpm dsh web --patch "$PWD/patch/auto-pwa.cordis.yml"
```

`--patch` 挂的是 `.ts` 源码，改完重启即生效；**发布物必须 `npm run build`**（harness 加载的是 `lib/`）。

### C. 装进已有 profile（常驻使用）

```sh
npm install && npm run build
dsh plugin --profile web add link:"$PWD"
```

安装或升级插件后要**完全重启 harness**，并在**新会话**里确认工具已加载（问"列出你可用的 `auto_pwa_*` 工具"，
应有 25 个）。运行中的旧会话不会自动获得新工具。

## 配置

开箱即用：拟合用插件自带的 `scripts/aifit.py`，Python 走 PATH。ctpwa 装在别处时：

```sh
export PWA_CTPWA_PYTHON=/path/to/ctpwa/env/bin/python
export PWA_LD_LIBRARY_PATH=/path/to/root/lib:/path/to/cuda/lib64   # 只在非激活环境时需要
```

## 开发

```sh
npm test           # vitest（纯物理核心 + 插件接线）
npm run typecheck
npm run build      # tsc -> lib/（harness 实际加载这里）
npm run check:build
```

Python 数值回归：`<ctpwa env>/bin/python tests/python/test_optimizer_and_pull.py`。

## License

MIT
