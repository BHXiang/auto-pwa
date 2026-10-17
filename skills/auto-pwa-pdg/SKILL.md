---
name: auto-pwa-pdg
description: 'Use when deciding whether a resonance may be added and which line shape to use: PDG backing vs local registrations, [PDG]/[local] provenance, reference overrides, per-analysis local-states.json, line-shape conventions (advisory only), and experiment-base vs model-baseline.'
---

# PDG 依据 / 本地登记 / 线形选择（按需加载）

只在"要不要加这个态 / 用哪个线形 / 算不算 PDG 依据"时读；核心流程见 `auto-pwa-analysis`。

## PDG 依据的语义

- **PDG 依据**：BWR/BW/Flatte/GS 共振态必须能在 PDG 表命中（名字匹配 id/别名）。**PDG 上没有的新粒子一律拒绝**（`auto_pwa_validate_add`/`edit_config` 路径）——分波分析不能发明粒子。唯一例外：`model: ONE`（相空间项），其振幅 = 势垒因子，mass 参数不参与振幅，命名惯例 `NR*`（如 NR1_KK）。**注意跑前门禁的分工**：门禁把"PDG 无依据"降为 **warning**（出处问题不阻塞，但要在报告里写清），把"阈值/J^PC/C/全同/结构"作为 **error**。手写配置里出现非 PDG 名字时，补 `reference` 或改用 ONE。
- **出处（reference）例外**：若参数来自**最新实验结果**（而非 PDG 平均）或该态尚未被 PDG 收录，提案必须带 `reference`（DOI 或论文名）——此时 PDG 平均一致性检查（质量/J^P/未收录）降为警告并记录出处，但**物理门禁（阈值/衰变顶点 J^P/C 守恒）绝不豁免**。reference 会写入 config.yml 并随迭代继承。用 `auto_pwa_lookup` 看单实验测量历史（stat/syst 分离 + DOI），确认引用的实验值真实存在。
- **JPC 一致性**：提案 (J,P) 必须与 PDG 条目一致。ρ(770) 是 1⁻，写成 0⁺ 会被拒。
- **共振态 J/P 可以不写（ctpwa 约定）**：`Resonances.<name>` 里不写 `J`/`P` 时，量子数完全由它所在的 intermediates `[J,P]` 组决定——**这正是共轭链的写法**：同一个 N(1720) 在 `R_peta`（N*→p η）是 `[1.5, +1]`，在 `R_pbareta`（N̄*→p̄ η）是 `[1.5, −1]`（反粒子内禀宇称约定使 P 反号）。工具**新增共振态时不写 J/P**（只写 model/parameters/free/…），并且不会因为同一态进了 P 相反的组而报 `jpc-conflict`。门禁按组的 J 与 PDG 对齐：**J 不一致 = error**；只在 J 相同、P 相反且共振态没有显式 J/P 时给 `jpc-parity-convention` **warning**（提示确认这是有意的共轭波）。若共振态**显式**写了 J/P（如 `J: 1.5, P: -1`），则与提案组不一致仍是 `jpc-conflict` error。
- **参数结构（含特殊公式逃生舱）**：BWR/BW/GS 恰好 [质量, 宽度] GeV；Flatte 需要 `channels`；ONE 给 0 或 1 个占位质量（可不写 `parameters`）；**Interp**（外部插值表）与 **Custom**（DSL）参数可空，载荷写在 `options`（如 `options: {file: ..., method: linear}`）。**未知模型名不再被插件拒绝**（只 warning），由 ctpwa `--validate-only` 在跑前定论——这条逃生舱就是为了试新公式。参数长度错 ctpwa 直接崩溃（门禁的 deep 检查会先拦）。

## 官方事实 vs 本地登记（`[PDG]` / `[本地]`）

- `data/pdg.json` = **官方事实**（294 条，全部 `status:"pdg"`），由 `data/pdg.manifest.json` 校验和钉住；**模型不允许改它**（guard deny write/edit 与 bash 重定向）。
- `data/local-states.json` = 跨分析本地登记；`<analysis>/local-states.json` = 本分析自己的追加登记。
- `auto_pwa_lookup` 每个命中前缀标 **`[PDG]`** 或 **`[本地]`** —— 只有 `[PDG]` 才算"有 PDG 依据"。
  命中本地登记 → `validate_add` 给 **`local-not-pdg` warning**（不阻塞），提示补 `reference` 或改用 `model: ONE`。
- 表内容与 manifest 不符 → `pdg-integrity` 警告；修法 `npm run check:pdg`。

## 名称、别名与 pdgid

- 分析里写 `f0_980`、`K1_2100` 都行，工具按 **id + aliases** 解析；
- **身份**以 PDG 条目为准：有单一 mcId 的态（`K^*(892)+` = 323）用 pdgid 精确区分；多重态名（`rho(770)`、`f(0)(980)`）按 **family**（PDG item 名）区分电荷伙伴；
- 结论：**名字只做输入**，比较/去重/惯例匹配一律走 pdgid 或 family。

## 实验基座 ≠ 模型基线

- `以 iter-N 为基座` 是**实验基座**，不是模型基线；
- 模型基线只认 `回退到 iter-N` / `基线仍为 iter-N` / `最终模型定为 iter-N`；
- 回答"截至某轮基线是哪轮"用 `auto_pwa_history` 的 `asOf`（按前缀折叠）。

## 线形模型惯例（**只提醒，不强制**）


`data/lineshape-conventions.json` 记的是**惯例**：`auto_pwa_lookup` 会返回 `suggestedModel`，
`auto_pwa_validate_add` 在偏离时给 `model-deviates-from-convention` warning。**永远不会因此报错**——
同一个共振态在不同过程形状里可以合法地选不同线形（语料证据见 `data/lineshape-usage-stats.json`：
`f0_980` 在 chicj2KKeta 用 BWR、在 KsKs 用 Flatte，两种都在用）。

| 态 | 惯例 | 何时可以不用 |
|---|---|---|
| f0(980) / a0(980) | **Flatte** | 阈值效应不主导、或不需要 K K̄ 耦合道时 |
| ρ(770) | **GS** | 远离 ρ 峰、或拟合需要更简单线形时 |
| f2(1270) / K1(1270) | **BWR** | 与强阈值道耦合时考虑 Flatte |
| f0(1500) | **BWR**（默认起点） | 各分析用法不一（BWR/BW/GS 都出现过），按需替换 |

**为什么要保留"偏离"的自由**：线形是拟合选择（阈值位置、附近道、稳定性都会改变最优选择），
不是粒子属性。惯例只是让你从"常见做法"起步，并在偏离时提醒你确认是不是有意的。
