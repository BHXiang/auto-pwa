---
name: auto-pwa-4body
description: Use when building a 4-body partial-wave model from scratch: enumerate all first-level topologies, record every [J,P]/PDG/NR attempt in auto_pwa_matrix, scan subsystem mass spectra, prune insignificant components, combine 2+2 and 1+3, and only complete when converged. Pairs with the goal template.
---

# 4 体分波：拓扑、尝试矩阵、剪枝、组合

适用：`J/ψ → η′π⁺π⁻π⁰` 这类 4 体末态，从空 config 开始，需要穷举拓扑并说明“试过什么”。

配套：

- **goal 模板**：`references/goal-template.md`（复制到 `create_goal` 的 objective）
- **矩阵格式/用法**：`references/matrix.md`
- **工具**：`auto_pwa_matrix`（记录/自检，**advisory，不做门禁**）

## 0. 先建 goal（不是先建链）

在开始拟合前，用 `create_goal`，objective 用 `references/goal-template.md` 的全文。goal 必须同时包含：

- 7 个一级拓扑逐个 included/excluded + 理由；
- 尝试矩阵（每个中间态、每个 [J,P]、每个 PDG/NR 候选）；
- 删除显著性（不显著必须删）；
- 2+2-only / 1+3-only / 组合的全局比较，1+3 按组合增量；
- 收敛判据；未收敛如实报告，不 complete/forceConverge。

没有 goal 的 one-shot 会话容易在提交 fit 后直接结束；goal 是跨轮继续的载体。

## 1. 拓扑：7 种，全部要表态

4 体一级划分 = 4 个 1+3 + 3 个 2+2。用 `auto_pwa_init_config` 的预览会列出这张表；每个都要写：

- **included**：config 里真的有对应链；
- **excluded**：写数据理由（例如该 side 的质量谱无增强、C/J^P 禁戒、阈值不允许）；
- **不要**只写“没试”。

`auto_pwa_matrix init` 会按当前 config 自动建 7 行；`present` 的拓扑初始 `included`，其余 `pending`；用 `action=topology` 把 excluded 的理由补上。

## 2. [J,P] × 候选：矩阵的主体

对每个 included 拓扑的每个中间态：

1. `auto_pwa_jpc_check` 列出产生/衰变顶点可达的 [J,P]；
2. 对每个 [J,P]，用 `auto_pwa_lookup` / `auto_pwa_suggest` 找 PDG 候选；再加 NR（ONE）作为对照；
3. 每个候选实际拟合（`auto_pwa_try_candidates` 或 `auto_pwa_run_fit`），记录：

```
intermediate, jp, candidate, model,
nll, k, aic, bic, deltaNll, deltaBic,
status: kept | rejected | skipped,
reason
```

4. 没试的候选写 `status=skipped` + 原因（阈值、C 禁戒、已被其他态吸收、预算），**不能留空**。

`auto_pwa_matrix add` 一行；`auto_pwa_matrix check` 会列出缺的 `(intermediate, jp)` 和缺 prune 的成分。

## 3. 分子系统质量谱 / 数据特征

- 对 3π、η′π、ππ 每个子系统看 data/phsp 比值或拟合残差；
- 有峰/宽增强 → 试 PDG 候选的线形（BWR/GS/Flatte），记录线形比较；
- 用户给的数据特征（例如“3π 在 1.65 GeV 附近有峰”）写进 `features.json` 或 prompt，**只当数据输入，不当 truth**；
- 不要在 skill/prompt 里写具体共振名；峰 → PDG 候选由工具查。

## 4. 剪枝：不显著就删

对最终模型的每个成分做删除检查（`auto_pwa_try_candidates` 的 removals、`auto_pwa_remove_resonance`，或手动复制 config）：

- **ΔNLL < 3** 或 **BIC 改善** → 删除；
- 删除后重拟合，确认 NLL 不显著变差；
- 每个删除写 `auto_pwa_matrix prune`：component / ΔNLL / ΔBIC / status(kept|removed) / reason；
- 最终模型不允许保留不显著成分。

注意：1+3 的 `NR_3π`、额外 `ρ(1450)` 常在这里被删；不要因为“加了更多态”就保留。

## 5. 组合：按组合增量，不按 1+3-only

分别拟合：

1. `2+2-only`；
2. `1+3-only`；
3. `2+2+1+3` 组合。

比较 NLL/AIC/BIC。**1+3 是否保留，看组合相对 2+2-only 的增量**，不要用 1+3-only 的 NLL 单独否决——数据被 2+2 主导时，1+3-only 天然可以很差。

组合后仍要做删除显著性；如果组合只改善很小且 Hessian 非正定/简并，回到 1+3 的 [J,P] 或 2+2 的复杂度，而不是直接退回 2+2。

## 6. 完成条件

- 所有分布 χ²/ndf ≤ 2；
- max|pull| < 5；
- Hessian 正定；
- 无显著剩余候选；
- `auto_pwa_matrix check` 无 missing（**自检，不是门禁**——工具只报告，不阻止）；
- 未收敛：如实写 `REPORT-nonconverged.md`，不 complete、不 forceConverge。

## 7. 常见坑

- **省略拓扑**：局部 fit-quality 达标就 complete，漏掉 1+3；先矩阵后收敛。
- **最小模型审计**：组合时用“最小 2+2”而不是精炼 2+2，NLL 差几千；先精炼每个拓扑，再组合。
- **1+3-only 否决**：1+3-only 的 NLL 可以为正；看组合增量。
- **不剪枝**：NR/额外 ρ 留在 1+3 里，组合增益小、Hessian 简并。
- **C 门禁**：带电中间态没有 C；`c-unverified` 不应拒绝带电态（见 `auto-pwa-jpc`）。先确认 C 语义，再归因于物理。
