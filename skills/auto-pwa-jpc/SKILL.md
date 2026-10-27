---
name: auto-pwa-jpc
description: 'Use when checking quantum-number reachability before adding a resonance: two-vertex J^PC intersection, decay-vertex pairJPC gate, C conservation, kinematic thresholds and the maxL convention.'
---

# J^PC / 顶点 / 阈值（按需加载）

起草新链或加态前确认"这个 J^P 能不能产生"时读；核心流程见 `auto-pwa-analysis`。

## 2.1 两顶点 J^PC 检查（jpc_check / 规则 10–12）


每个中间态 R 有两类量子数约束，**都必须满足**：

| 顶点 | 规则 | 例子 |
|---|---|---|
| 衰变顶点 R→d1+d2 | S 由子自旋耦合（S∈[|J₁−J₂|, J₁+J₂]），J = L⊗S，P = P₁·P₂·(−1)^L；**C 只对共轭对/全同组定义** | K⁺K⁻（S=0）：J^PC = {0⁺⁺,1⁻⁻,2⁺⁺,3⁻⁻,4⁺⁺}；Kη：{0⁺,1⁻,2⁺,3⁻,4⁺}（C 未定义） |
| 产生顶点 A→R+B | 角动量三角 + P_A = P_R·P_B·(−1)^L'；**若 A、R、B 均有 C：C_A = C_R·C_B** | J/ψ(1⁻⁻)→η(0⁻⁺)+R：C(R)=−1 必需 |

**C 的定义范围（保守原则，勿伪造）**：
- 正反粒子对（K⁺K⁻、K⁰K̄⁰、π⁺π⁻…）：C = (−1)^{L+S}（自旋 0 介子对即 (−1)^L）；
- 全同粒子（`Constraints.identical` 组内，如 π⁰π⁰、KsKs）：(−1)^{L+S} = +1（玻色子）/ −1（费米子）——**这就是选择定则本身**；
- 其余（K⁺η、π⁺π⁰、K⁺K⁺…）：C 未定义，只查 J^P。

**优先用 PDGID 判决（`Particles.<name>.pdgid`，有符号 MC 编号：π⁰=111、K⁺=321、K⁻=−321、φ=333、J/ψ=443、Λ=3122、K_S=310）**：
- **全同**：同 pdgid ⇒ 同种粒子。config 必须给同种粒子不同分析名（`pi01`/`pi02`），所以**不能靠名字判全同**——写 pdgid 后 `auto_pwa_jpc_check` 用 `identicalDerived` 标出"同 PDGID 却未声明 `Constraints.identical`"（`identical-missing` warning），并给出该补的组。**引擎仍只认 `Constraints.identical`**：不声明就不对称化，波表还会放进 π⁰π⁰ 的奇 L 波。
- **正反粒子对**：pdgid 变号即共轭对（`CONJUGATE_PAIRS` 名字表只作无 pdgid 时的回退）。K⁰(311)/K̄⁰(−311) 即使被命名成 `K01/K02` 也不会被误判全同。
- **C 本征态**：`selfConjugate`（PDG `cc_type=='S'`）**且** PDG 给出确定 C 值。**不要只看 C 值**：PDG 表给带电态留了假 C（`rho(770)+ → '-'`），必须以 `selfConjugate` 为门。
- **C 三态**：`c-enforced`（母子均 C 本征态 → C(R) 钉死）/ `c-not-applicable`（某端无 C，不施加约束）/ `c-unknown`。C 不是引擎输入，这条门禁是唯一拦 C 违例的地方。
- 加新共振态前若不确定某粒子的 pdgid/自共轭/C，用 `auto_pwa_config_view` 看该粒子行（`pdgid=… = K(S)0 自共轭 C=-` 之类），或 `auto_pwa_lookup`。

**教学案例（为什么会被拦）**：
- **案例 1（C 守恒）**：J/ψ→η R_KK、R_KK→K⁺K⁻。C(R_KK) 必须 = C(J/ψ)·C(η) = −1。K⁺K⁻ 的 2⁺⁺ 波 C=+1 → **f2(1270) 提案被 `c-violation` 拒绝**（产生顶点可达、PDG 有、阈值过也没用）。
- **案例 2（衰变顶点宇称）**：R_Keta→K⁺η 的 1⁺ 波不存在（P=(−1)^L 迫使 J=L 时 P=−1）→ **K1(1410) 按 1⁺ 提案被 `decay-vertex-forbidden` 拒绝**。
- **案例 3（全同选择定则）**：π⁰π⁰ 只允许 L 偶（0⁺⁺,2⁺⁺,4⁺⁺）；ΛΛ（费米子）要求 (−1)^{L+S}=−1。两个全同粒子**必须声明进 `Constraints.identical`**，否则引擎不对称化（validate 会 warning）。

**sl 白名单记号**：config 里 `sl: [S, L]`、`ls: [L, S]`，**S 是物理自旋（整数或半整数，如 0.5 / 1.5）**，与 ctpwa `ConfigParser::parseSLFilter` 一致；工具内部转成 ctpwa 的 **(2S+1, L)** 记号（如 `sl: [0.5, 1]` → 内部 `[2, 1]`；`ls: [1, 1]` → 内部 `[3, 1]`），工具输出的波表用内部记号。两个键都支持，`ls` 在前者优先。

**半整数角动量（重子共振态）**：末态含核子时（p pbar η、K Λ …），中间态 J 是半整数（1/2, 3/2, 5/2 …），`Particles` 的 J 写 `0.5`/`1.5` 或 `"1/2"`/`"3/2"`，`[J, P]` 组同理。产生顶点枚举、波表、`sl` 门禁都支持半整数（2S+1 可为偶数，如 p+η 只有 S=1/2 → 2S+1=2）；PDG 表已含 N*/Δ* 全谱（`auto_pwa_lookup` 可查 N(1720)、N(1520)、Δ(1905) 等）。


## 量子数与顶点门禁（补充）

- **运动学阈值**：m_R ≤ m_A − m_B（on-shell）。接近阈值 → off-shell 风险 → 建议 float 质量；具体阈值随通道而变，用 `auto_pwa_decay_check` 查你的通道。
- **J^P 可达性**：J/ψ(1⁻) → 0⁻ + R 时，可达 J^P 为 0⁻, 1±, 2±, 3±, 4±, 5⁺（maxL=4）。**0⁺ 不可达**（需要 L=0 但角动量要求 L=1）。
- **多体第一级（1+3 / 2+2）**：4 体末态先枚举 4 个 **1+3** 与 3 个 **2+2** 划分（5 体再加 5 个 1+4、10 个 2+3）。1+3 用 bachelor 的 J^P 查 R_BCD 可达性；2+2 的产生顶点 A→R1+R2 **两侧都是中间态**，要同时枚举 pairJPC(R1)、pairJPC(R2)，并逐**组对**要求 C(R1)·C(R2)=C(A)（C(R) 从各自衰变顶点推导）。例如 `J/ψ(1^-) → f0(0^+) + a0(0^+)`：C = (+1)(+1)=+1 ≠ −1，**C 禁戒**；不能因为它“两侧都是中间态、单个 R 的 cRequired 为 null”就放行。`auto_pwa_config_view` 会打印第一级拓扑覆盖（`[ ]` = 尚未纳入）。
- **衰变顶点门禁（规则 10）**：提案 J^P 必须在 R→d1+d2 的 pairJPC 集合里（见 §2.1），否则振幅恒为零（ctpwa 零-SL 诊断同源）。
- **C 守恒（规则 11）**：产生顶点 A→R+B 若母子均自共轭（如 J/ψ、η），C(R)=C(A)·C(B) 强制；K⁺η 这类无 C 系统只查 J^P。
- **maxL 来源**：优先 config `Constraints.maxL`；未设置时工具默认 4（与 skill 一致；ctpwa 引擎默认不限，注意 config 显式设置后工具与引擎同步）。
