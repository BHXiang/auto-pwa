# 尝试矩阵：`auto_pwa_matrix`

**advisory**：记录和自检，不拦截 fit、不拦截 complete。门禁是后续 loop/guard 的事。

文件写在**分析目录**（含 `config.yml` 或 `iterations/` 的目录）：

- `attempt-matrix.json`：机器可读；
- `ATTEMPT-MATRIX.md`：人读的表格 + check 缺项。

## 动作

| action | 作用 |
|---|---|
| `init` | 读当前 config（`config.yml` 或最新 `iterations/iter-N/config.yml`），用 `firstLevelTopologies` 建 7 个拓扑；present 的设 included，其余 pending；保留已有 rows 的 pruning |
| `add` | 加一行候选/尝试：intermediate、jp、candidate、model、nll/k/aic/bic/deltaNll/deltaBic、status、reason |
| `prune` | 加一行删除检查：component、deltaNll/deltaBic、status(kept/removed)、reason |
| `topology` | 设某个拓扑 included/excluded/pending + reason |
| `status` | 汇总计数 |
| `check` | 返回 missing（advisory） |

参数：

```json
{
  "analysisDir": "/abs/path/to/analysis",
  "action": "add",
  "row": {
    "topology": "2+2:etap+pip|pim+pi0",
    "chain": "decay1",
    "intermediate": "R_etap_pi0",
    "jp": "0+",
    "candidate": "a0_1450",
    "model": "BWR",
    "fitDir": "iterations/iter-003",
    "nll": -10192.5, "k": 18, "aic": -20421.0, "bic": -20187.4,
    "deltaNll": -2660.4,
    "status": "kept",
    "reason": "NLL 大降"
  }
}
```

`topology` 的 id 由 `kind:side1|side2` 组成，例如 `2+2:etap+pip|pim+pi0`、`1+3:etap|pip+pim+pi0`。

## status 语义

行：

- `kept`：进入最终/当前模型；
- `rejected`：试过、否决（需要 nll 或 deltaNll + reason）；
- `skipped`：没试（必须写 reason，如阈值/C 禁戒/预算）；
- `pending`：还没填，check 会报。

删除：

- `kept`：显著，保留；
- `removed`：不显著，删除；
- `pending`：还没检查，check 会报。

## check 的覆盖规则

`check` 只报告，不拦截：

1. 7 个拓扑都有 included/excluded；excluded 有 reason；
2. 每个 included 拓扑的**每个中间态的每个 [J,P] 组**至少一行（kept/rejected/skipped）；
3. 每个最终 `Resonances` 成分有一行 prune（kept/removed）；
4. 没有 pending 行/删除；skipped 有 reason；kept/rejected 有 nll 或 deltaNll；prune 有 deltaNll/deltaBic 或 reason。

不满足就返回 `missing: string[]`。把它当成“还差什么”的清单，不是“被拒绝”。

## 推荐节奏

1. `init`；
2. 精炼 2+2：每个新的 [J,P]/候选 `add`；剪枝 `prune`；
3. 精炼 1+3：同样；
4. 组合：`add` 组合行/删除；
5. 结束前 `check`，把 missing 补完或写 skipped + 原因；
6. `status`/`ATTEMPT-MATRIX.md` 作为报告附录。

**不要**用矩阵替代 fit：它只记录，不产生 NLL。

## 与 goal 的关系

goal 模板要求“矩阵 check 无 missing”；这个要求由 agent 自检执行，工具本身不阻止。若以后加门禁，应在 `auto_pwa_loop_next`/`pwa-guard` 里调用 `matrixCheck`，而不是改这个工具。
