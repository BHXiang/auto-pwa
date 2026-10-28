# PWA 轨迹与工具路由评估（routing-eval）

日期：2026-10-29  
目标：用可重复的 from-zero 场景判断 AI 是否沿着

```text
create_goal → Decide → run_fit（gate + transport）→ evaluate/diagnose → note
→ loop_next（可选收敛检查）
```

运行，而不是靠“工具少”来猜。

## 1. 当前变更

- `auto_pwa_run_fit` 是唯一主拟合入口；`preflight: true` 做宿主侧 GPU/SLURM 探测。
- `auto_pwa_iter_start` 标为“仅新 baseline”。
- `auto_pwa_iterate` / `auto_pwa_loop_decide` / `auto_pwa_loop_status` 标为“可选”。
- `auto_pwa_round` 标为已弃用（替代者 `run_fit`）。
- `state-digest` 在没有 loop 状态时提示主路径。
- 新增 `src/trajectory-eval.ts`：把一条工具调用序列按场景检查，输出违规码。
- 新增 `tests/trajectory-eval.test.ts`：canonical path、缺 goal、bash fit、缺 evaluate/note、loop_decide-only、缺 preflight。

## 2. 场景矩阵

每个场景跑 2–3 个随机种子；同一 prompt，只改变环境/初始状态。

| # | 场景 | 期望 | 违规信号 |
|---|---|---|---|
| 1 | 干净目录 + 本机 GPU | goal → config_view/init → run_fit → evaluate/note | 无 goal；bash fit |
| 2 | 只有 skeleton，无 data | 先问/查 data，再 init；不猜路径 | 猜路径；手写 config |
| 3 | 已有 iterations，无 goal | history/loop_status → create_goal → loop_next | 直接 iter-000；无 goal |
| 4 | GPU 在宿主，bash 沙箱看不到 | `run_fit(preflight:true)` → local GPU | 复制 aifit_cpu；bash nvidia-smi |
| 5 | 无 GPU，有 SLURM | preflight → fit.slurm → sbatch | 本地 CPU；不提交 |
| 6 | 无 GPU，无 scheduler | 报错后停止/问用户 | 自行 CPU 拟合 |
| 7 | 拷贝工作区带旧 `.loop-state`（`/hpcfs/...`） | 重定位/忽略旧状态 | 用旧绝对路径 |
| 8 | 用户要 float/trans/plot/baseline | 直接改 config → run_fit | 被 loop_decide 卡住；放弃需求 |
| 9 | 长拟合 | 等通知 → fit_status；等待时可做其他尝试 | 轮询 job_output；重复提交同一 iter |
| 10 | 用户要删不显著态 | try_candidates/compare 或 remove → fit | 不验证直接删 |

## 3. 每个场景记录什么

- 前 10 个工具调用；
- 第一次 `run_fit` 前是否有 `create_goal`；
- `run_fit` 次数 vs bash fit 次数；
- 是否用 `preflight`（仅在 transport 不确定时要求）；
- 每次 `run_fit` 后是否有 `evaluate` 和 `note`；
- 是否把 `loop_decide` 当唯一驱动；
- 最终是否收敛/有 `FINAL-REPORT.md`；
- token/耗时。

## 4. 使用 trajectory checker

`src/trajectory-eval.ts` 接受：

```ts
evaluateTrajectory(calls, {
  requireGoalBeforeFit: true,
  forbidBashFit: true,
  requireEvaluateAndNote: true,
  forbidLoopDecideOnly: true,
})
```

返回 `{ ok, violations: [{ code, message }] }`。  
真实会话可把 `tool/call` 事件映射成 `{ name, arguments }` 后传入。

## 5. 隔离运行（不碰线上 profile）

```bash
mkdir -p /tmp/dsh-eval/profiles/eval
cp -r ~/.dsh/profiles/headless /tmp/dsh-eval/profiles/eval
ln -sfn ~/.dsh/profiles/web/node_modules /tmp/dsh-eval/profiles/eval/node_modules
ln -sfn ~/.dsh/.credentials.yaml /tmp/dsh-eval/.credentials.yaml
python3 - <<'PY'
import json
p='/tmp/dsh-eval/profiles/eval/package.json'
d=json.load(open(p))
d.setdefault('dependencies',{})['auto-pwa']='link:/home/whitewash/pkgs/auto-pwa'
d.setdefault('dsh',{}).setdefault('profile',{})['bundles']=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','auto-pwa']
json.dump(d,open(p,'w'),indent=2,ensure_ascii=False)
PY

DSH_HOME=/tmp/dsh-eval dsh --profile eval "<scenario prompt>"
```

从会话日志解压后统计 `tool/call`，用 checker 判分。

## 6. 先看什么

优先看场景 1、4、5、8：

- 1 证明正常轨迹；
- 4 证明不会把 bash 沙箱当成宿主 GPU；
- 5 证明 SLURM transport；
- 8 证明 AI 不被 loop_decide 限制。

如果这四个场景都过，再考虑是否真正删除 `iterate`/`loop_decide`/`loop_status`，而不是先删工具。
