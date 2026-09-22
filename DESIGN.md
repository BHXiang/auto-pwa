# auto-pwa 优化架构设计（Design Doc）

> 状态：设计讨论稿 v0.1 —— 供研究，未进入实现
> 范围：拟合循环的**分层架构**、**ΔNLL 预测器（nllSimulate）接口**、**决策轨迹管道（manifest / 教训库 / 校准）**

---

## 1. 核心共识

1. **物理拟合层用解析梯度，不用生成式优化。**
   nllSimulate 的 ΔNLL 预测（耦合子空间 Lagrange 检验 + (m,Γ) 网格扫描）比任何 LLM 文本梯度精确几个数量级。TextGrad 存在是因为多数任务没有解析梯度——我们有，所以那一层直接跳过。

2. **决策策略层用生成式优化，但"优化器"就是 LLM 本身（OPRO 洞见），不需要从头写。**
   需要的只是**轨迹管道**：记录 → 结构化 → 注入下一轮决策上下文。这个管道已建一半（SUMMARY.jsonl 日记），缺的是结构化（manifest）与消费端（教训库、校准、few-shot 历史）。

3. **Trace 做结构化采样，不做全量录制。**
   全量对话文本轨迹噪声大、LLM 读不完；值钱的是决策点上的数字：predicted/actual ΔNLL、pull 吸收、Hessian 正定性、参数稳定性。

4. **不集成 LangSmith / Weave / Opik 平台。**
   它们是通用 LLM 应用的观测平台，看不懂我们的观测面（fit.json、weight_best.root、Hessian）。借理念，不借工具。

---

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────┐
│ L3  收敛/报告层    loop 状态机、FINAL-REPORT、eval 门禁    │
├──────────────────────────────────────────────────────────┤
│ L2  决策策略层    suggest / loop_next / 教训库 / 校准      │  ← 生成式优化（LLM 当优化器）
├──────────────────────────────────────────────────────────┤
│ L1  解析梯度层    nllSimulate 代理模型（ΔNLL 预测+归因）    │  ← 解析优化（物理，GPU 内做）
├──────────────────────────────────────────────────────────┤
│ L0  拟合执行层    ctpwa 引擎 / aifit.py / fit.json        │  ← 昂贵评估（GPU 分钟级）
└──────────────────────────────────────────────────────────┘
         ↑ 轨迹管道（iter-manifest.json + SUMMARY.jsonl）贯穿全部 ↑
```

**层间规则：**

- 昂贵评估（L0 完整拟合）只在 L1 代理模型选定 argmax 候选后执行一次；禁止无预测的盲试。
- L2 只能消费 L1 的预测与 L0 的实测（经 manifest），不直接读原始 root 文件做数值判断。
- L1 内核在 ctpwa 中实现（单分波振幅 [A_L,S] 与逐事件量在引擎 GPU 内存里），auto-pwa 只做编排与决策。
- 轨迹管道是所有层的写接口：每轮迭代结束时由 L3 写 manifest，L2 决策时读。

---

## 3. L1：nllSimulate —— ΔNLL 预测器

### 3.1 数学（已校正，修正"共振参数导数需要新耦合参数"的错误）

在最佳拟合点 θ₀（新态耦合 c = 0）处，∂L/∂m_r 与 ∂L/∂Γ_r 自动为零（振幅因子 P_{r,λ} ∝ c），
因此**不能**对共振参数做一阶灵敏度分析。正确方法：

1. **固定 (m, Γ)**，对耦合 c 做 Lagrange 检验（c 子空间二阶展开）：

   ```
   ΔNLL(m,Γ) = −½ · g_c†(m,Γ) · H_cc⁻¹(m,Γ) · g_c(m,Γ)
   ```

   其中 g_c = Σ_λ ∂L/∂c |_{c=0}，H_cc = Σ_λ ∂²L/∂c² |_{c=0}（负定时为 -ΔNLL 增益）。

2. **网格扫描 (m,Γ)**：F(m;m_r,Γ_r) 是标量传播子，与逐事件缓存好的
   F 无关量 G₀ 相乘即可，网格几乎免费；argmin 即最优初始值 (m*, Γ*)。

3. 显著性判据：ΔNLL_pred < −3（≈ 2σ 量级，与决策层阈值对齐）。

### 3.2 接口草案（ctpwa `analysis.nllSimulate`）

```
nllSimulate(
  params,                // 当前 best 参数 θ₀（耦合固定，c=0）
  candidates: [{
    waveIdx,             // 已有组内加态：挂到的分波索引（如 chain1-R_KK-f2_1525 的 (L,S)）
    model: "BWR"|"BW"|"Flatte",
    mGrid:  [...],       // 缺省自动生成（阈值 ~ 上限）
    GammaGrid: [...],    // 缺省自动生成
  }],
  perEvent: false        // true 时输出逐事件归因直方图
)
→ {
  candidates: [{
    grid: [[m, Gamma, deltaNll], ...],   // 完整景观（可画热图）
    best: { m, Gamma, deltaNll },        // argmin
    significance: 2.1,                   // σ 量级（按 ΔNLL 换算）
    attribution: { mass: [hist], cosBeta: [hist] }   // perEvent=true 时
  }]
}
```

**两种路径：**

| 路径 | 场景 | 成本 |
|---|---|---|
| 已有组加态 | 给现有 intermediate 的 [J,P] 组挂新共振态 | 几乎免费：F 标量 × 缓存 G₀，纯 GPU 张量运算 |
| 新建 [J,P] 组 | 需要新 (L,S) 组合 | 一次 AmpGen 构造（新增通道 b_{a′a}），之后网格扫描仍免费 |

### 3.3 逐事件归因（trace 思想在目标函数上的体现）

ΔNLL ≈ −½ (Σ_i g_i)² / (Σ_i h_i) 中 g_i 是逐事件的。perEvent=true 时按事件累加
Re[g_i] 权重，画 mass/cosβ 直方图：**"这个候选会吃掉哪些事件"**。

三个用途（决策层消费）：

1. **预验证**：归因峰位 vs 当前 pull 区；不吻合 = 加错地方，连短拟合都省了。
2. **定位**：增益集中在哪个质量区/角分布 bin，下轮评估专门看那里。
3. **校准**：真实拟合后 ΔNLL_actual ≈ ΔNLL_pred（H 非对角忽略时），形成校准点。

---

## 4. L2：决策策略层（生成式优化）

### 4.1 现有机制（已实现）

- suggest：pull 区 × 允许 J^PC → PDG 候选排序
- loop_next：评估 + 预测验证 + 收敛判定
- SUMMARY.jsonl：散文日记（轨迹）

### 4.2 教训库（Reflexion 理念：失败的结构化反思进情景记忆）

每轮验证失败时生成结构化教训，注入下次 suggest/决策上下文：

**失败分类表（草案）：**

| category | 含义 | 触发信号 | 可行动作示例 |
|---|---|---|---|
| `bound_hit` | 参数撞界 | fit.json atBoundary | 加宽 freeRange 或改固定 |
| `hessian_non_pd` | Hessian 不正定 | positiveDefinite=false | 降参数相关性 / 删态 |
| `pull_not_absorbed` | 加了但 pull 区没消 | maxPull 未降 | 换 J^P / 换模型 |
| `interference` | 与强共振干涉、参数漂移 | 耦合跨迭代翻转 / 误差膨胀 | float 加范围限制 / 分离链 |
| `charge_asymmetry` | 电荷不对称 | 耦合符号比率异常 | 检查数据 / 对称约束 |
| `insignificant` | 份额 <2σ | diagnose 报告 | 删除该态 |
| `prediction_miss` | 预测偏差大 | \|ΔNLL_actual − ΔNLL_pred\| 大 | 更新校准曲线 |

### 4.3 校准 + 回测（MIPRO / OPRO 理念）

- **预测校准**：manifest 累积后画 predicted vs actual 散点（斜率/偏置/噪声）。
  suggest 用**校准后的预测**排序；校准曲线告诉模型何时不该信预测
  （如预测 |ΔNLL| < 1 时实测常翻号 → 不试）。
- **策略回测（DSPy 理念的离线版）**：suggest 排序权重（PDG 对齐 / pull 对齐 /
  预测 ΔNLL）声明为参数，用历史 manifest 离线调优——对过去每轮问
  "若按权重 W 排序，是否会选中实际改善的候选？"。
- **few-shot exemplars（OPRO 理念）**：决策时注入历史"提议→得分"对，
  并保持候选多样性（覆盖不同 J^P/质量区，避免 5 个同区候选）。

### 4.4 eval 门禁（LangSmith 理念）

每轮自动判分清单（机器执行，不进 AI 上下文，不合格直接标记）：

- [ ] Hessian 正定
- [ ] 无参数撞界
- [ ] 预测验证 passed（若上轮有 prediction）
- [ ] pull 收敛方向正确

---

## 5. 轨迹管道：iter-manifest.json

SUMMARY.jsonl 是给人读的叙事；manifest 是给代码读的事实。

### 5.1 Schema 草案

```jsonc
{
  "iter": 13,
  "baseIter": 12,
  "baseConfigHash": "sha256:…",          // config.yml 哈希，血缘溯源
  "proposal": {
    "name": "f0(1500)", "chain": "R_KK",
    "jp": {"j": 0, "p": 1}, "model": "BWR",
    "initParams": [1.505, 0.109],
    "free": [0, 1], "freeRanges": [[1.4,1.6],[0.05,0.3]],
    "tex": "$f_0(1500)$", "reference": null
  },
  "prediction": {                          // 来自 nllSimulate
    "predictedDeltaNll": -12.5,
    "predictedMStar": 1.51, "predictedGammaStar": 0.11,
    "confidence": "high"
  },
  "actual": {
    "deltaNll": -18.3,
    "maxPullBefore": 5.4, "maxPullAfter": 3.1,
    "hessianPositive": true, "nBoundHits": 0
  },
  "verdict": {"passed": true, "note": "pull 5.4→3.1，预测低估 46%" },
  "lessons": [{
    "category": "interference",
    "text": "f0(1500) 与 NR2_KK 干涉致宽度漂移",
    "action": "float 时收紧宽度范围"
  }],
  "evalGates": {"hessianPd": true, "noBoundHits": true, "pullAbsorbed": true}
}
```

### 5.2 写入时机

每轮 loop_next 结束时：实际结果 + 验证结论 + 教训 + 门禁全落盘。
nllSimulate 的预测在提议时已记录（prediction 字段），避免事后污染。

---

## 6. 工具理念借鉴对照表

| 工具 | 理念 | 在本设计中的落点 | 状态 |
|---|---|---|---|
| LangSmith/Weave/Opik | trace + eval + 血缘 | §4.4 eval 门禁、§5 manifest 血缘 | 设计 |
| DSPy | 策略声明为可优化参数 | §4.3 排序权重回测（离线，非 prompt 搜索） | 设计 |
| TextGrad | 文本梯度 | **不采用**（拟合层有解析梯度；决策层用教训库替代） | 否决 |
| OPRO | LLM 当优化器 + 轨迹打分 + 多样性 | §4.3 few-shot exemplars、候选多样性 | 部分已实现 |
| MIPRO | 代理模型引导搜索 + 校准 | §3 nllSimulate（代理模型）、§4.3 校准 | 设计 |
| Reflexion | 失败反思进情景记忆 | §4.2 教训库 | 设计 |

---

## 7. 里程碑（落地顺序）

| 里程碑 | 内容 | 依赖 | 产出验证 |
|---|---|---|---|
| M0（现状） | L0 完整 + L2 基础 + 散文日记 | — | chicj2KKeta iter-012 已收敛 |
| **M1** | manifest 结构化（schema + 写入器 + 读接口） | — | 回放 iter-000..012 生成 manifest 序列 |
| **M2** | ctpwa nllSimulate 内核 + aifit `--nll-sim` + plugin 集成 | M1 | 对 iter-012 预测 ΔNLL，与历史实测对照 |
| **M3** | 教训库（分类表 + 注入 suggest 上下文） | M1 | 回放：教训命中率统计 |
| **M4** | 校准散点 + suggest 排序权重离线回测 | M1+M2 | 校准 R²；回测选对率提升 |
| **M5** | eval 门禁自动化 | M1 | 每轮门禁全过才进决策上下文 |

**建议并行起点：** M1 与 M2 互不依赖（M1 纯插件侧，M2 纯引擎侧），可同时开工。
M2 先做"已有组加态"最小版（传播子比值路径，无需 AmpGen 构造），
新组路径作为第二步。

---

## 8. 明确不做（边界）

1. 不引入 LangSmith / Weave / Opik 等平台依赖。
2. 不做 TextGrad 式文本梯度。
3. 不做 DSPy 式 prompt 自动搜索（在线）；策略调优一律离线回测。
4. Trace 不做全量会话录制，只做决策点结构化采样。
5. nllSimulate 只做预测与归因，**不做**"对残差拟合 BW"（残差受归一化符号与干涉扭曲，已被否决）。

---

*附：本设计的数学推导背景（ΔNLL = −½ g†H⁻¹g 的 c 子空间 Lagrange 检验、
逐事件归因、AIC/BIC 模型选择）见会话记录与 src/model-selection.ts。*
