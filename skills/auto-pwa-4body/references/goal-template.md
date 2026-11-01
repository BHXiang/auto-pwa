# 4 体 goal 模板（复制到 `create_goal` 的 objective）

> 这是 `auto-pwa-4body` 的 goal 模板。把 `{反应道}` 换成实际道；不要写具体共振名（ω(1650)、a₀ 等）——峰/候选由数据和 `auto_pwa_lookup` 决定。  
> 数据特征（如“3π 在 1.65 GeV 附近有峰”）可作为人工输入写入 `features.json` 或 prompt，但只当数据特征，不当 truth。

```text
从零建立 {反应道，例如 J/ψ→η′π⁺π⁻π⁰} 的振幅模型。完成前必须：

1. 枚举全部一级拓扑（4 体共 7 种：4 个 1+3 + 3 个 2+2）；每个写 included/excluded + 数据理由；不许漏。

2. 建立并填完尝试矩阵（auto_pwa_matrix）：
   - 每个 included 拓扑的每个中间态，用 auto_pwa_jpc_check 列出所有可达 [J,P]；
   - 每个 [J,P] 用 auto_pwa_lookup/auto_pwa_suggest 列出 PDG 候选 + NR，并实际拟合；
   - 每个候选记录 NLL/k/AIC/BIC/ΔNLL/ΔBIC/status；未试的写 skipped + 原因；
   - 每个最终成分写 prune 行（ΔNLL/ΔBIC/status/reason）。

3. 对 3π、η′π、ππ 每个子系统检查质量谱/拟合残差；若数据有峰或人工提供了峰位置，测试能描述它的 PDG 候选和线形（BWR/GS/Flatte）；不要用 truth 状态名。

4. 对最终每个成分做删除显著性：ΔNLL<3 或 BIC 改善 → 删除；最终模型不允许保留不显著成分。

5. 分别拟合 2+2-only、1+3-only、组合；比较全局 NLL/AIC/BIC。1+3 是否保留按组合模型相对 2+2-only 的增量判断，不用 1+3-only 的 NLL 单独否决。

6. 收敛判据：所有分布 χ²/ndf≤2、max|pull|<5、Hessian 正定、无显著剩余候选；auto_pwa_matrix check 无 missing（advisory，不是门禁）。

7. 未收敛如实报告（REPORT-nonconverged.md）；不许 complete/forceConverge。
```

## 用法

1. 在第一次拟合前调用 `create_goal`，objective 用上面的全文；
2. 提交 fit 后等 job 完成通知，不要在 job 运行期间结束会话；
3. 每轮用 `auto_pwa_matrix add/prune/topology` 记录；结束前 `check`；
4. `check` 只是自检：它列出缺的拓扑/[J,P]/prune，不会阻止 fit；是否 complete 由 goal 的收敛判据决定。

## 为什么需要这几条

- **拓扑**：局部 fit-quality goal 会在 2+2 达标时停，漏 1+3；
- **矩阵**：没有记录就无法区分“试过且排除”与“根本没试”；
- **剪枝**：找到峰对应共振后，NR/额外 ρ 常不显著，不删会稀释组合增量；
- **组合增量**：1+3-only 的 NLL 可以为正（2+2 主导），不能用它单独否决 1+3；
- **收敛门禁**：审计表存在 ≠ 模型收敛；两条都要。
