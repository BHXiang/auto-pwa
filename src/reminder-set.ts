/**
 * reminder-set：E3（物理特例提醒 = 程序性记忆）的**原子提醒集**。
 *
 * 实验设计（docs/memory-system-design-and-eval.md §5.3）：
 *   R0 = 不给提醒
 *   R1 = **全部**原子提醒（≈"SKILL 常驻"档）
 *   R2 = 只给与**本步动作类型**相关的提醒（由代码按动作挑）
 *
 * 为什么用"原子提醒"而不是直接塞 SKILL.md：R1 与 R2 必须**只差选中的条目**，
 * 措辞要完全一致，否则比的是文案而不是"按需 vs 常驻"。SKILL.md 是给人读的叙事
 * 文档（237 行），保留为 R1 的上位替代说明；本模块的条目与它一一对应，并由
 * `tests/reminder-set.test.ts` 守住锚点（SKILL 改了章节标题就会红）。
 *
 * 与实测教训挂钩：§4.2(a) 的事故说明**写死的规则会过期**（引擎升级后 Hessian
 * 判据失效）——所以本模块提供 `engine` 字段，渲染时带上版本，规则可整体失效。
 */

export type ActionKind = 'add' | 'remove' | 'float' | 'converge' | 'any'

export interface Reminder {
  id: string
  /** 该提醒与哪些动作类型相关（`any` = 总是相关）。 */
  triggers: ActionKind[]
  /** 一句话提醒（<= 100 字，便于控制 token）。 */
  text: string
  /** SKILL.md 的出处（章节锚点），由测试守卫。 */
  skillRef: string
}

/**
 * 原子提醒集。逐条对应 `skills/auto-pwa-analysis/SKILL.md` 的硬规则与策略，
 * 只保留"做下一步提案时会被违反"的那些。
 */
export const REMINDERS: Reminder[] = [
  { id: 'pdg-evidence', triggers: ['add'], text: 'BWR/BW/Flatte/GS 必须有 PDG 依据；PDG 上没有的新粒子一律拒绝（例外：model=ONE）。', skillRef: '## PDG 依据的语义' },
  { id: 'jpc-consistency', triggers: ['add'], text: '提案 (J,P) 必须与 PDG 条目一致；PDG 没有的量子数不许发明。', skillRef: '## PDG 依据的语义' },
  { id: 'jpc-from-group', triggers: ['add'], text: '新增共振态不写 J/P：量子数由所属 intermediates [J,P] 组决定（共轭链 P 反号是正常的）。', skillRef: '## PDG 依据的语义' },
  { id: 'threshold-margin', triggers: ['add', 'float'], text: '检查运动学阈值 m_R ≤ m_A − m_B；接近阈值 → off-shell 风险 → 建议 float 质量。', skillRef: '## 量子数与顶点门禁' },
  { id: 'reachability', triggers: ['add'], text: '先确认该 J^P 物理可达（角动量+宇称守恒，maxL 截断）；不可达会被门禁拒绝。', skillRef: '## 量子数与顶点门禁' },
  { id: 'decay-vertex', triggers: ['add'], text: '衰变顶点：提案 J^P 必须在 R→d1+d2 的允许集合里，否则振幅恒为零（零-SL）。', skillRef: '## 量子数与顶点门禁' },
  { id: 'c-parity', triggers: ['add'], text: '若母子均为 C 本征态：C(R) = C(A)·C(B) 强制；Kη、Kπ 这类无 C 系统只查 J^P，不要伪造 C。', skillRef: '## 量子数与顶点门禁' },
  { id: 'identical-particles', triggers: ['any'], text: '全同粒子必须声明进 Constraints.identical，否则引擎不对称化（π⁰π⁰ 的奇 L 波会被放进波表）。', skillRef: '## 2.1 两顶点 J^PC 检查' },
  { id: 'narrow-fixed', triggers: ['add', 'float'], text: '窄共振、PDG 测定良好（Γ ≲ 50 MeV）→ 参数固定，float 会与耦合退化。', skillRef: '## 4. float' },
  { id: 'new-res-float', triggers: ['add', 'float'], text: '新加入的态第一轮建议只 float 质量，区间 = PDG 质量 ± max(0.5Γ, 30 MeV)。', skillRef: '## 4. float' },
  { id: 'broad-float', triggers: ['add', 'float'], text: '宽态（Γ > 0.2 GeV）或近阈值 → 质量+宽度都 float，宽度区间 ±50%Γ。', skillRef: '## 4. float' },
  { id: 'boundary-handling', triggers: ['float', 'converge'], text: '参数撞 free_range 端点 = 数据不支持该自由度 → 放宽区间 / 固定 / 删态，不许当测量值上报。', skillRef: '## 4. float' },
  { id: 'insignificant-prune', triggers: ['remove'], text: '份额 < 2σ 或 ΔNLL 不显著的态应删除；删完必须重拟合确认。', skillRef: '## 2.2 删除共振态' },
  { id: 'group-index-stable', triggers: ['remove'], text: '删除是按名摘除：[J,P] 组即使变空也保留（组顺序 = 振幅块索引，删组会错位）。', skillRef: '## 2.2 删除共振态' },
  { id: 'cancellation-brake', triggers: ['converge', 'add'], text: '退化解刹车：波强度之和/总强度 ≥3 = 靠大振幅互消凑出来的解，NLL 更好也不能信。', skillRef: '## 5.3 跑前门禁' },
  { id: 'chi2-and-pull', triggers: ['converge'], text: '收敛要两个都过：逐分布 chi2/ndf < 2 且 max|pull| < 5（两者不等价，别只看一个）。', skillRef: '## 6. 拟合质量判断' },
  { id: 'hessian-and-delta', triggers: ['converge', 'add'], text: 'Hessian 正定才有可信误差；|ΔNLL| ≥ 3（2 自由度）才算显著改进，< 3 考虑删除。', skillRef: '## 6. 拟合质量判断' },
  { id: 'engine-version', triggers: ['any'], text: '以上判据依附于**当前引擎版本**（Hessian 诊断曾因引擎升级失效）；跨引擎的 ΔNLL 不可直接比较。', skillRef: '## 6. 拟合质量判断' },
]

export type ReminderLevel = 'R0' | 'R1' | 'R2'

export interface ReminderBlock {
  level: ReminderLevel
  ids: string[]
  text: string
  approxTokens: number
}

const approxTokens = (s: string): number => Math.ceil(s.length / 3)

/**
 * 渲染某档提醒。`action` 用于 R2 的挑选；缺省视为 `any`（只给 any 类提醒）。
 * `engine` 提供时附带版本行——规则过期时能整体失效（§4.2a 的教训）。
 */
export function buildReminders(level: ReminderLevel, action: ActionKind = 'any', engine?: string): ReminderBlock {
  const picked =
    level === 'R0'
      ? []
      : level === 'R1'
        ? REMINDERS
        : REMINDERS.filter((r) => r.triggers.includes(action) || r.triggers.includes('any'))
  if (picked.length === 0) return { level, ids: [], text: '', approxTokens: 0 }
  const header = `作业提醒（${level}${level === 'R2' ? `，按动作 ${action} 挑选` : '，全部'}）${engine !== undefined ? ` · 引擎 ${engine}` : ''}:`
  const text = [header, ...picked.map((r) => `- [${r.id}] ${r.text}`)].join('\n')
  return { level, ids: picked.map((r) => r.id), text, approxTokens: approxTokens(text) }
}


/** `PWA_REMINDERS` → 档位；非法值按**关闭**处理（不猜）。 */
export function reminderLevelFromEnv(env: NodeJS.ProcessEnv = process.env): 'R1' | 'R2' | undefined {
  const v = (env.PWA_REMINDERS ?? '').trim().toUpperCase()
  return v === 'R1' || v === 'R2' ? v : undefined
}

/**
 * 动作推断（决定 R2 挑哪些条目）：上一轮是 `removed` 就按"删"，否则按"加"。
 * `phase === 'propose'` 时也是"加"——这正是需要提醒介入的时刻。
 */
export function inferAction(_phase: string | undefined, lastKind: string | undefined): ActionKind {
  return lastKind === 'removed' ? 'remove' : 'add'
}

/**
 * 生成**提醒注入块**——默认关闭，靠 `PWA_REMINDERS=R1|R2` 打开。
 *
 * 为什么默认关：§8.5.5 的离线读数表明"全量提醒会把模型压成不作为"，
 * 而离线材料又测不出净收益 → 接入产品必须能**一键关掉做 A/B**，而不是默认全开。
 * `engine` 一并带上：写死的规则会随引擎过期（§4.2a 的教训）。
 */
export function reminderInjection(opts: {
  level?: string
  action: ActionKind
  engine?: string
}): string {
  if (opts.level !== 'R1' && opts.level !== 'R2') return ''
  return buildReminders(opts.level, opts.action, opts.engine).text
}
