# PWA 迭代流程简化与作业唤醒（设计 Note）

日期：2026-10-29  
状态：讨论稿，待定实现顺序

## 1. 目标

把当前“多条迭代入口 + 强制 loop 状态机”收敛成：

```text
create_goal
  → AI 决策
  → 写 config
  → auto_pwa_run_fit（强制 config gate → 提交作业）
  → 等作业完成通知
  → auto_pwa_evaluate + auto_pwa_diagnose
  → auto_pwa_note
  → 判断 goal / loop_next（只评估，不控制）
```

核心原则：

- **goal 负责持久化**：没有 goal，AI 容易跑一轮就结束。
- **gate 负责入口正确性**：格式、物理约束、ctpwa 可解析、非零振幅。
- **evaluate/record 负责证据与可复现**：chi2/ndf、pull、Hessian、份额、ΔNLL/AIC、provenance。
- **loop 只负责“到哪了/是否收敛”**，不再限制 AI 只能加/删共振态。

## 2. 正确性分层

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| config gate | YAML/键/形状、交叉引用、C、J^PC、阈值、identical、PDG、ctpwa deep、0 振幅 | 模型是否物理完整、拟合是否好 |
| fit | 收敛、Hessian、参数/误差、撞边界 | 模型选择是否正确 |
| evaluate/diagnose | 逐分布 chi2/ndf、max\|pull\|、份额、干涉、退化解、矩 | 自动决定物理方向 |
| note/provenance | config md5、data、脚本、git、每轮结论 | 替代科学判断 |
| goal | 轮数/时间/停止判据、自动续轮 | 代替 gate/evaluate |

**gate 通过 ≠ 物理正确**。gate 是必要条件；evaluate/record 仍是必需。

## 3. 作业唤醒由什么承载

不是新工具，而是：

```text
auto_pwa_run_fit
  → plugin/pwa-fit-local.ts (PwaFitLocalService)
  → ctx.jobs.start({ kind: 'ctpwa', owner: 当前 Agent, run: ... })
  → DSH jobs 在完成时向 owner 注入
     "background job ctpwa-N finished"
  → 唤醒当前会话
```

- **本地 GPU**：`LocalFitRunner` 在 `ctx.jobs` 的 run 中启动 python；job settle 时唤醒。
- **SLURM**：`SbatchFitRunner` 提交并轮询 `sbatch/squeue/sacct`；整个 batch 作为一个 DSH job，完成时一次唤醒。
- `auto_pwa_fit_status` 只是**完成后的查询/摘要**，不负责等待或唤醒；不要轮询它。
- 本地有 GPU 时走 `LocalFitRunner`（`solve1` 就是这种）；只有宿主有 SLURM 客户端时才走 `SbatchFitRunner`（`~/pwa/Jpsi2etap3pi/1` 那台机器）。本地 job 与 owner 会话绑定，会话结束/被销毁时可能被取消；SLURM 作业在集群侧继续，但 DSH 侧唤醒仍依赖宿主进程活着并在轮询。
- 没有 goal 时，job 完成仍可能唤醒一次，但不会形成连续的“多轮目标”；所以 goal 仍要显式创建。

## 4. 三套环境 / GPU 与沙箱的区分（重要修正）

不能把三套环境混在一起：

1. **`solve1`（本机真实数据，已移走）**
   - 本地 AI 实际调用了多次 `auto_pwa_run_fit`（会话 `2dc...` 中 81 次），走的是 DSH 宿主进程的本地 GPU。
   - `solve1` 没有本地 `.slurm-jobs.json`；它证明的是“本机有 GPU 时，`run_fit` 的 local 路径可用”。
   - 为防止干扰 DIYMC，这个目录已被用户移走，当前不能再用它做证据。

2. **`mctest`（本机 blind 测试）**
   - `bash` 工具运行在沙箱里：`nvidia-smi` 报
     `GPU access blocked by the operating system`，
     `torch.cuda.is_available() == False`，`which sbatch` 为空。
   - **`auto_pwa_run_fit` 不是通过 bash 沙箱执行**；它由 plugin 服务进程执行，`detectGpuAvailability()` 在宿主进程环境里跑 python。宿主有 GPU 时会走 local GPU，不会因为 bash 看不到 GPU 就失败。
   - blind AI **没有调用过一次 `run_fit`**。它用 bash 探测到 GPU 被 block、没有 `sbatch`，读了 `fit-transport.js` 后直接复制 `aifit_cpu.py` 用 CPU 跑。它把“沙箱里看不到”误判成“宿主不能用 GPU”，从而绕过了正确路径。
   - `scripts/auto-pwa-env.sh` 的注释也明确写了：GPU 访问在 bwrap 沙箱里不可用，拟合必须从 native（非 sandbox）的 DSH 宿主进程运行。

3. **`~/pwa/Jpsi2etap3pi/1`（另一台机器）**
   - 那台机器只通过 SLURM 使用 GPU。
   - `.slurm-jobs.json`（`sbatchId: 506602`）、`job_a100.sh`、`job_v100.sh`、`fit.slurm` 都属于那台机器，**不能当作本机有/没有 GPU 或 SLURM 的证据**。

因此：

> **不要用 bash 里的 `nvidia-smi`/`which sbatch` 判断 fit transport。**  
> 要判断，调用 `auto_pwa_run_fit` 的 preflight/诊断，或由插件提供一个宿主侧 probe 工具。`solve1` 已证明本机 GPU 路径可用；`mctest` 的问题是 AI 没走它。

## 5. 当前流程的问题

1. `auto-pwa-analysis` §0 主路径是 `iter_start → run_fit`，loop 只在按需 skill 里，AI 不会自然切到 loop。
2. `iter_start`/`run_fit` 不初始化 loop 状态；不做 loop 也能完整跑完。
3. `loop_decide` 只支持 add/remove；真实工作流需要 float/trans/plot/baseline/trials，AI 只能绕过。
4. `iter_start` 可接受任意 baseline；loop 状态随之变旧。
5. 作业 transport 的宿主/沙箱区别没有被诊断清楚；AI 被 bash 假象带偏，用 CPU 绕过。
6. 没有 goal 时，AI 缺少持续多轮的驱动力。
7. 从 HPC 拷贝的 `.loop-state.json` 是绝对路径（`/hpcfs/...`），不可移植。

## 6. 建议的最小实现顺序

1. **P0：`run_fit` transport 诊断**
   - 区分 `GPU blocked only in bash sandbox` / `host has GPU` / `SLURM available` / `no scheduler`。
   - 给出宿主侧 preflight；本地 GPU 直接 local，SLURM 机器生成 `fit.slurm`。
   - 禁止 AI 用 bash/CPU 绕过。
2. **P0：goal 进入主路径**
   - `auto-pwa-analysis` §0 明确 `create_goal`；loop_next 只做评估。
3. **P1：loop 自动登记**
   - `iter_start`/`run_fit` 自动维护 loop 状态；`_trials` 作为探索分支。
   - `loop_decide` 支持 `configPath`/任意 config 变更，或降级为可选。
4. **P1：evaluate/note 强制**
   - 每轮拟合后要求 evaluate + note（或一个组合工具），否则 goal 不算完成。
5. **P2：loop-state 可移植**
   - 存相对路径；加载时按当前 `iterationsRoot` 重定位。

## 7. 待确认

- 是否保留 `loop_decide`？建议降为可选，不作为主路径。
- 是否把 `iterate`/`round` 合并进 `run_fit`？建议只保留一个“提交一轮”的入口。
- SLURM 长期作业在 DSH 重启后的状态恢复：是否只依赖 `.slurm-jobs.json` + `squeue` 查询？
- 是否需要宿主侧 `auto_pwa_gpu_probe` 工具（不经过 bash 沙箱）？

## 8. 文章里的四步循环如何改

原文的四步（Fig. loop）：

1. **Evaluate**：`loop_next` 评估当前拟合；
2. **Decide / explore**：`suggest`/`diagnose`/`try_candidates`/`compare`；
3. **Gate & fit**：`validate_add` → `edit_config` → `iter_start` → `run_fit`；
4. **Resume**：作业完成通知唤醒 agent。

简化后建议改成“一个 goal + 三个动作”：

```text
（外部）create_goal：持久化、轮数/时间/收敛判据

每轮：
  1. Decide
     AI 根据上一轮 evaluate 决定任意变更（加/删/float/trans/plot/baseline）
  2. Gate & Fit
     auto_pwa_run_fit：强制 config gate（格式/物理/deep ctpwa）
                     → 宿主侧 preflight（local GPU / SLURM）
                     → 提交后台作业
  3. Evaluate & Record
     evaluate + diagnose → note → loop_next（只判收敛/写报告）
```

对应关系：

| 原文四步 | 新流程 |
|---|---|
| 1 Evaluate | 移到拟合之后：`evaluate` + `diagnose`；`loop_next` 只做终止判断 |
| 2 Decide / explore | 保留为第 1 步；`suggest`/`try_candidates`/`compare` 仍是工具，不是必走的状态 |
| 3 Gate & fit | 合并为第 2 步：**`run_fit` 自己就是 gate + submit**；`iter_start` 只用于新 baseline，不再是每轮必需 |
| 4 Resume | 不再是一个循环阶段：`ctx.jobs` 的完成通知自动唤醒；`fit_status` 只查询 |

如果文章想保留四个 box，可以写成：

1. **Decide**（goal + 上一轮证据）
2. **Gate**（`run_fit` 的 config gate）
3. **Fit / submit**（local GPU 或 SLURM，后台任务）
4. **Evaluate + record + goal check**（`evaluate`/`diagnose`/`note`/`loop_next`）

但“Resume”应从图中删除或画成一条**自动回边**（job completion → next round），因为它不是一个 agent 主动执行的阶段。

一句话版本：

> 原来的“Evaluate → Decide → Gate & fit → Resume”四步，简化为  
> **“Decide → Gate & Fit → Evaluate & Record”，由 goal 贯穿，job completion 作为自动回边；`loop_next` 只判收敛，不再是控制器。**
