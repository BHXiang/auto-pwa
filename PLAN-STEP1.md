# dsh-pwa 第一步方案：迭代准备 + 共振态验证 + config 生成 + 提交拟合

> 状态: 方案定稿（决策点已确认）
> 依据: dev-plan.html 的 M2 目标 + 对 ctpwa/fit.py/运行环境的实测调研

## 0.1 已确认决策（2026-08 用户答复）

1. **集群访问**：作业(sbatch)能力后续再开发；用户确认"当前机器可以直接使用 GPU"——但实测本机当前无 CUDA 设备（无 `/dev/dxg`，`torch.cuda.is_available()=False`，ctpwa 报"无可用 CUDA 设备"），真拟合暂不可跑。→ 传输层做 `FitRunner` 抽象：`LocalRunner`（本机 spawn，立即可用，等 GPU 就绪即生效）+ `SbatchRunner`（后续接入），插件 config 切换；无 GPU 时 fail-fast 给出明确诊断
2. **迭代目录**：`<analysis>/iterations/iter-N/`（iter-000 为基线，只读参照）
3. **迭代 0 基线**：`Jpsi2KKeta/solve2/config.yml`

**ctpwa 环境实测要点（已在 ctpwa 源码 Config.cu/Resonance.cu/ResModel.cu 中核实）**：
- `import ctpwa` 需要完整库路径：`LD_LIBRARY_PATH=/home/whitewash/pkgs/root/lib:/usr/local/cuda-13.2/lib64:<ctpwa env>/lib/python3.12/site-packages/torch/lib`（ROOT 的 libCore + CUDA + torch 的 libc10；三者缺一不可）。验证过此组合下 `import ctpwa` 成功（editable 安装于 `/home/whitewash/pkgs/ctpwa/ctpwa.so`）。用户交互 shell 可直接运行，说明其 shell 已具备该组合
- `ctpwa.analysis()` 从 **cwd** 读 config.yml：已用 solve2 真实 config 验证解析成功（读入 4491 个 background 事件）
- 本机当前无 CUDA 设备（无 `/dev/dxg`，`torch.cuda.is_available()=False`）：`ctpwa.analysis()` 快速失败并报明确中文错误 "无可用 CUDA 设备。ctpwa 当前仅支持 GPU 计算（CPU 后端尚未实现），无法继续。"——LocalRunner 应识别该签名并给出明确诊断，不挂死
- `import ctpwa` 单独失败(缺 libc10.so)、`import torch` 在先则成功——fit.py 的 import 顺序天然正确

---

## 0. 调研发现（与 dev-plan 的差异）

| 假设 | 实测 | 影响 |
|---|---|---|
| "本机直接运行, 不涉及 sbatch"(dev-plan §7) | **本机(WSL)跑不了拟合**: ctpwa conda env 缺 libc10.so(torch 不完整)；nvidia-smi 被 WSL 屏蔽；无 sbatch/srun | `pwa_run_fit` 必须有传输层(集群提交)。第一步方案把它显式列为模块，不假设本机可跑 |
| 模型写 config.yml | `fit.py` 不解析 config——`ctpwa.analysis()` 构造时**从 cwd 读 config.yml**；`Resonances.parameters` 直接 `as<vector<double>>`，长度/类型错即崩溃；J 可写成 `"3/2"` 字符串(spin*2+1) | config 必须程序生成+程序校验，不能手写 |
| 单次拟合很快 | 10 个 seed × 最高 10000 次 LBFGS 迭代，单 run 约 55–300s，全程 ~10–30min | 必须后台任务 + 轮询；GPU 是共享资源(集群 qos) |
| pdg.json 只是种子 | 已用 scikit-hep `particle` 包拉取权威数据: **200 个介子条目, status 全为 pdg** | 共振态候选可以直接程序化对照 PDG 表 |

## 1. 第一步闭环（要实现的流程）

```
模型决策层(自由)          程序执行层(强约束)
─────────────────────────────────────────────
提出: 加共振态 X 到链 R_KK 的 [J:1,P:-1] 组
  + float 策略 (mass/width 是否自由)
        │
        ▼
① resonance-validate.ts   PDG 依据 / JPC 一致性 / 质量阈值
        │                 重复检查 / 参数长度 / 链内归属  → errors 阻止, warnings 提示
        ▼
② config-edit.ts          解析现有 config.yml → 改 intermediates + Resonances
        │                 交叉引用校验(被引用必有定义) → 渲染回 YAML
        ▼
③ 迭代文件夹              iterations/iter-N/{config.yml, fit.py→链接, results/, note.md}
        │
        ▼
④ pwa_run_fit(传输层)     sbatch/ssh 提交 → 后台轮询 → 取回 results/
        │
        ▼
(第二步) pwa_evaluate      nll_history / parameters / weight_best.root → 判断 → 下一轮
```

## 2. 模块设计（延续 M1 纯 TS + 单测架构）

### ① `src/resonance-validate.ts` — 新增共振态检查器（核心）

```ts
validateResonanceAddition(
  db: ResonanceDb,            // data/pdg.json
  current: ParsedConfig,      // 现有 config 的解析结果
  proposal: {
    name: string              // 如 "phi1680" (analysis 命名) 或 "phi(1680)" (PDG 命名)
    chain: string             // 加入哪个 intermediate，如 "R_KK"
    jpGroup: JP               // 加入哪个 [J,P] 组
    model: 'BWR' | 'ONE' | ...  // 模型(ONE=NR 项)
    parameters: number[]      // [mass, width] 或 [m] (ONE)
    free?: number[]           // [0,1] / [-1]
    freeRange?: [number, number][]
  },
  options?: { massTolerance?: number }  // off-shell 容差, 默认 0
): { ok: boolean; errors: string[]; warnings: string[] }
```

**硬规则(errors, 任一触发即拒绝):**
1. **模型类型合法**: model ∈ {BWR, BW, ONE, Flatte}（ctpwa 源码 Resonance.cu 的映射表）；未知 model 拒绝
2. **PDG 依据（仅对有传播子的模型）**: BWR/BW/Flatte 的名字 `normalizeName(name)` 必须在 pdg.json 命中(id 或 aliases)。**ONE 是例外——但例外理由是"它根本不是粒子"**：ctpwa 源码中 ONE 的振幅 = 1 × Blatt-Weisskopf 势垒因子（`ResResult::make(bf, 0)`，mass 参数不参与振幅），即相空间/非共振项。**任何 BWR/BW/Flatte 新粒子若无 PDG 依据 → 拒绝**（"PDG 上没有的新粒子"由此机制化）；ONE 项命名建议 `NR*`（如 NR1_KK），不要求 PDG 依据
3. **JPC 一致性**: BWR/BW/Flatte 提案的 (J,P) 必须与 PDG 条目完全一致（防 phi(1020) 写成 0+ 这类错误）。ONE 跳过此检查（无 J^P 语义）
4. **质量在运动学范围内（仅对有传播子的模型）**: 对该链 m_R ≤ m_A − m_B（R_KK: ≤ m_Jpsi − m_eta = 2.549 GeV；R_Keta: ≤ 2.603 GeV；复用 decay-check 阈值逻辑 + massTolerance）。ONE 跳过（无传播子，质量无物理意义）
5. **不重复**: name 及别名不在现有 config 的 Resonances 中
6. **链内 J^P 归属**: 提案 J^P 必须等于要加入的 intermediates 组 [J,P]
7. **参数结构（按 ctpwa 的 Resonance 构造要求）**: BWR ≥ 2 个 [mass, width]（可带第 3 个半径 r）；BW = 2 个；**ONE 恰好 1 个 [mass]**（源码要求 params.size() ≥ 1，参数仅占位）；Flatte ≥ 2 个 [mass, g1, ...] 且必须带 `channels` 字段。长度/类型错 ctpwa 直接崩（`as<vector<double>>`）
8. **质量与 PDG 一致**: BWR/BW/Flatte 的 |m_提案 − m_PDG| ≤ 容差（默认 20 MeV 或 0.5×Γ，取大者）——防止随手填错质量
9. **free 合法性**: free 索引 ∈ {0,1} 或 −1，且 < len(parameters)；free_range 长度 == free 长度，且初始参数落在 range 内

**软规则(warnings, 不阻止):**
- 该共振态在 PDG 表中**未列出**本末态衰变模式（decayModes 缺失/无匹配，复用 hasDecayTo；数据缺口 ≠ 物理排除）
- 质量接近阈值（> 阈值 − 0.2 GeV）→ 提示 off-shell 风险，建议 float
- 候选质量在数据谱区没有明显峰值（留给 pwa_spectrum，第二步）

### ② `src/config-edit.ts` — 结构化 config 修改

- 依赖: 引入 `js-yaml`（目前项目零依赖，这是第一个运行时依赖；纯函数保持无 I/O，解析/渲染在内部完成）
- 操作原语（第一步只需 add）:
  - `addResonance(config, proposal)` → 同时改 `DecayChains.<chain>.intermediates` 的 [J,P] 组（追加名字）+ `Resonances.<name>` 段（J/P/model/parameters/free/free_range/tex）
  - `loadConfig(text)` / `dumpConfig(obj)`：解析与渲染，渲染保序（YAML 顺序在 ctpwa 中无影响，但人读友好）
- **交叉引用校验**（可加载验证，ctpwa 构造前最后一道防线）:
  - 每个 intermediates 组里出现的名字，必须在 Resonances 有定义
  - 每个 Resonances 定义，J/P/parameters 结构完整
  - 数据文件路径存在性（Data 段，绝对路径优先——solve2 用绝对路径）
- 原子写：临时文件 + rename；写前备份上一版 config（沿用 solve2 的 `config.yml_back` 习惯）

### ③ 迭代文件夹约定

**位置: 分波分析的工作文件夹**（用户用 deepseek harness 操作分波的那个目录，如 `/home/whitewash/pwa/Jpsi2KKeta/`），**不是** dsh-pwa 插件开发目录。dsh-pwa 只提供代码与工具，不存放分析产物。

```
<分析工作目录>/iterations/
  iter-000/          # 基线: 复制 solve2 当前 config 作为迭代 0（只读参照）
  iter-001/          # 第一次修改
    config.yml
    fit.py           # 符号链接到 ../../solve2/fit.py（或复制）
    plot.py          # 同上
    job.sh           # 由传输层生成（sbatch 参数固定）
    results/         # 拟合输出落这里
    note.md          # 本轮决策记录（模型写，第二步的 pwa_note 落点）
  SUMMARY.md         # 迭代汇总表: iter | 变更 | NLL | ΔNLL | 判定
```

config.yml 的 Data 路径用**绝对路径**（ctpwa 从 cwd 读 config，绝对路径最稳；pipieta 的相对路径 `../data/` 是另一种可接受写法，但绝对路径零歧义）。

### ④ `scripts/pwa_run_fit` — 传输层（FitRunner 抽象）

本机当前无 GPU 驱动、无 sbatch，但传输层**现在就要按可插拔设计**，不能阻塞纯 TS 部分开发：

```ts
interface FitRunner {
  submit(iterDir: string, opts: FitOptions): Promise<{ jobId: string }>   // 后台启动
  poll(jobId: string): Promise<FitStatus>                                 // running | done | failed
  collect(iterDir: string): Promise<FitOutput>                            // 取回 results/ 摘要
}
type FitRunnerKind = 'local' | 'sbatch' | 'ssh'   // 插件 config 选择，默认 local
```

- **LocalRunner（本期实现）**：`spawn('<ctpwa env>/bin/python', ['fit.py'], { cwd: iterDir, env: { ...process.env, LD_LIBRARY_PATH: '<root/lib>:<cuda lib64>:<torch/lib>' } })`——**必须注入 §0.1 验证过的完整库路径组合**，否则 ctpwa 导入即失败；stdout 落 `iterations/iter-N/fit.log`；后台进程用 DSH `ctx.jobs.start()` 挂入统一任务运行时（或先纯 Node 版 child_process + 轮询文件）。**无 GPU 时快速失败并给出明确诊断**（日志含 "无可用 CUDA 设备"/"no CUDA devices available" 即报 "ctpwa 需要 CUDA，当前机器无 GPU 驱动"），不挂死。GPU 就绪后此 runner 直接可用
- **SbatchRunner（后续）**：生成 job.sh（复刻 pipieta/test/job_a100.sh 模式）→ sbatch → squeue 轮询 → 取回。GPU 分区/qos（gpupwa/pwadedicate vs pwadebug）做成插件 config 可配
- **SSHRunner（按需）**：ssh 到 GPU 机 nohup 执行 + scp 取回
- 插件侧统一成 `pwa_run_fit(iterDir, timeoutMin) → {jobId, status}`，先返回 jobId，后台轮询，结束时返回 `{nll, summaryPath, logTail}`（nll 从 results/optimization_summary.txt 的"最佳NLL"行解析）

### ⑤ float 决策支持（`src/float-policy.ts` + skill 知识）

"共振态参数是否 float"先做成**规则函数 + skill 文本**，决策权留模型，规则程序化校验:
- 状态良好的窄共振（phi1020: PDG 质量精度 ~0.02 MeV 级）→ **固定**（省略 free）
- PDG 质量/宽度不确定度大，或候选质量接近运动学阈值 → **float**，free_range 以 PDG 值为中心 ± 若干 σ（质量 ±10–30 MeV 级，宽度 ±20–50%，具体按 PDG 不确定度，规则函数给出建议区间）
- 新加入的共振态：第一轮建议 float 质量（free:[0]），若拟合后参数撞边界/误差巨大再固定（决策链记入 note.md）
- NR 项（ONE，相空间模型）：振幅 = 势垒因子，mass 参数不参与振幅（ctpwa 源码核实）——参数固定即可，无 float 意义
- 检查器只保证 free/free_range **结构合法**，策略合理性由 skill 指导模型

## 3. 落地顺序

1. ✅ `src/resonance-validate.ts` + 单测（PDG/JPC/阈值/重复/参数结构/容差 各一组 case）——9 条硬规则 + 7 条软规则，物理可达性 gate（jp-not-allowed）已嵌入
2. ✅ `src/config-edit.ts` + `yaml` 包 + 单测（增删共振态、新组自动创建、交叉引用、往返渲染保真——渲染输出已用 ctpwa.analysis() 实测可解析）
3. ✅ `src/float-policy.ts` + 单测（窄共振固定 / 宽态 float 质量+宽度 / ONE 固定）
4. ✅ `scripts/demo-step1.ts`：solve2 基线 → rho1450（宽态）+ f1_1285（新组）→ 拒绝案例 → 输出 demo-out/iter-001/config.yml，`--ctpwa` 实测 ctpwa 解析通过
5. ✅ 传输层：`FitRunner` 接口雏形 + `LocalFitRunner`（本机 spawn + fit.log + GPU fail-fast 探测 + 超时/取消；SbatchRunner 后置）
6. ✅ 接入 DSH：`plugin/pwa-tools.ts` 注册 6 个 `pwa_*` 工具 + `patch/pwa.cordis.yml` 挂载 + `skills/pwa-analysis/SKILL.md`（源文件在仓库，安装到 `~/.dsh/skills/`）——已用 `pnpm dsh --profile headless --patch ...` 三次真实会话验证：pwa_lookup 查询 φ(1020) ✓、pwa_decay_check 候选枚举 ✓、pwa_validate_add 真实 config 验证 ✓、skill 目录可见 ✓。修复了 width: undefined 非 lossless JSON 的序列化 bug`

## 3.1 架构决策：迭代主循环 = 同会话 goal（2026-08 用户提出）

用户提议："会话设定结束时间，这段时间内多次跑循环"，担忧跨会话（A 写结论 → B 读）丢失信息。结论：**采纳，且这是 DSH goal 工具的原生用途**。

- 一个会话内 `create_goal(objective=收敛判据+时间预算, max_goal_rounds=15)`，DSH 自动续回合，**上下文连续**（模型记得上轮全部推理，无压缩损失）
- 每轮回合：fit_status → evaluate → 分析 → lookup/decay_check → validate → iter_start → edit_config → run_fit → note
- 时间预算实现：objective 写明 + 每轮 note 记录耗时；轮数硬上限 = max_goal_rounds
- `pwa_note`/`pwa_history` 降级为审计 + 崩溃恢复 + 用户阅读（HTML），不再是决策主通道
- 验证：headless 冒烟测试——create_goal 成功（goal-97be5184, 10 轮, armed）+ pwa_history 准确恢复 iter-000 结论

## 4. 决策点记录（已确认）

| 决策点 | 结论 |
|---|---|
| 集群访问方式 | 后续开发作业能力；当前本机直跑 GPU（实测本机暂无 GPU 驱动，LocalRunner 等 GPU 就绪即生效） |
| 迭代目录位置 | `<analysis>/iterations/iter-N/` |
| 迭代 0 基线 | `Jpsi2KKeta/solve2/config.yml` |

## 9. GUI 自动多回合验证（最后一环，需用户操作）

headless 只能验证单回合（进程任务结束即退出）；goal-round-driver 的自动续回合
（agent idle 后自动注入下一回合）是**常驻 GUI 专属**。验证步骤：

1. 以 ctpwa 环境启动 GUI（一次性，之后 bash 工具自动带环境）：
   ```sh
   source /home/whitewash/Script/conda.sh ctpwa
   pnpm dsh web --patch /home/whitewash/dsh-pwa/patch/pwa.cordis.yml
   ```
   打开 http://127.0.0.1:3080
2. 发送：
   ```
   用 pwa_round 继续 KsKs 分波迭代：先 create_goal（objective=收敛判据 max|pull|<5 且 ΔNLL<10，
   max_goal_rounds=5），然后每回合调 pwa_round（从 iter-004 开始），收敛即 complete。
   ```
3. 观察：每回合结束（模型输出回合报告）后，应自动进入下一回合（driver 注入），
   直到收敛 complete 或轮数耗尽。目标达成 = "goal 回合自动衔接"实测通过。

已 headless 实测通过的部分：create_goal（armed）→ 回合内 pwa_round（评估摘要
nll/deltaNll/worst/convergenceHint 全返回）→ 收敛判断 → update_goal complete。
