/**
 * eval-score：P0 探针的**确定性评分器**（零 LLM 打分）。
 *
 * 输入：
 *   - 探针集（`probe-out/probes.jsonl`，真值 100% 由代码复算）
 *   - 答案集（任意 driver 产生：subagent / 人工 / 后续的真实 harness 运行）
 *     每行 `{ id, arm, run, answer, tokensIn?, tokensOut?, latencyMs? }`
 * 输出：
 *   - 每探针对错 + 按 arm × 类别聚合的指标 + attribution markdown
 *
 * 硬约束（docs/memory-system-design-and-eval.md §3.2/§5.2）：
 *   - **代码判定**，绝不调用 LLM 打分；
 *   - 报**可靠性**不只报单次：`pass^k` = 同一探针 k 次全部正确；
 *   - 成本入账：注入 token 与输出 token；
 *   - **重复率** = 提案落在"已否决集"里的比例（需要调用方给 rejectedNames）。
 */
import type { IterationRecord } from './report.js'
import { parseTouchEvents } from './memory-fold.js'

export interface Probe {
  id: string
  analysis: string
  category: string
  question: string
  answer: unknown
  truth: Record<string, unknown>
  judge: string
  contextUpToIter?: number
}

export interface AnswerRecord {
  id: string
  /** 记忆档位（M0–M4 / R0–R2 / P0–P3 …），用于跨档对比。 */
  arm?: string
  /** 第几次重复（同 id 多次 → pass^k）。 */
  run?: number
  answer: unknown
  tokensIn?: number
  tokensOut?: number
  latencyMs?: number
  /** E4：这次作答用掉的 memory 调用次数（查历史/检索的次数）→ Pass@B 与 P90R。 */
  memoryCalls?: number
  /** E4：规模梯的档位（注入的无关轮次数）。 */
  scale?: number
}

export interface ProbeScore {
  id: string
  analysis: string
  category: string
  arm: string
  run: number
  correct: boolean
  /**
   * 答案的**实验条件直接带在分数上**（不做 (arm,id,run) join）。
   *
   * 为什么：E4 的规模梯会对**同一探针、同一档位**多次作答，只差 `scale`——
   * 用 join 会 key 撞车、只认最后一条（实测踩过：onset 从 50 变成 200）。
   */
  scale?: number
  memoryCalls?: number
  tokensIn?: number
  tokensOut?: number
  /** next-step 专用：与真值的集合重合度（Jaccard）。 */
  overlap?: number
  /** next-step 专用：所选动作是否落在"已否决集"里（重复率分子）。 */
  repeated?: boolean
  /** 该探针是"近似名陷阱"（如 K2*_1430 vs K2_1430）——混淆会被单列，不混进记忆失败。 */
  aliasTrap?: boolean
  detail?: string
}

export interface Metrics {
  arm: string
  n: number
  correct: number
  accuracy: number
  /** 同一探针多次运行**全部**正确的比例（需要 run 字段）。 */
  passK?: number
  passKValue?: number
  /** next-step 的重复率（分子/分母只在 next-step 且有 rejectedNames 时有效）。 */
  repeatRate?: number
  nextStepN?: number
  nextStepRepeats?: number
  meanOverlap?: number
  tokensInTotal: number
  tokensOutTotal: number
  meanTokensIn?: number
  byCategory: Record<string, { n: number; correct: number }>
  byAnalysis: Record<string, { n: number; correct: number }>
  /**
   * `tried-before` ∪ `abstention` 的**联合**准确率。
   *
   * 为什么必须报这个：实测零记忆档（M0）在 abstention 上是 **100%**——因为
   * "永远说没试过"恰好是保守默认、而 abstention 的真值就是"没试过"；同一个档位在
   * tried-before 上是 **0%**。只看 abstention 会得出"没有记忆也很好"的荒谬结论。
   */
  verdictAccuracy?: number
  verdictN?: number
  /** 近名陷阱 vs 干净题的分组准确率（试点实测：混淆集中在近名上）。 */
  byAlias?: { alias: { n: number; correct: number }; clean: { n: number; correct: number } }
  // ---- E4 诊断量（Scale-Conditioned Eval 的四个量）----
  /** 预算 B（默认 2）。 */
  budgetB?: number
  /** 正确 **且** memory 调用 ≤ B 的比例。 */
  passAtB?: number
  /** memory 调用数的第 90 百分位（尾部长尾负担）。 */
  p90R?: number
  /** 预算内答错的比例。 */
  pWrong?: number
  /** 超预算的比例。 */
  pExh?: number
  /** 按规模档位分组的准确率（evidence-preserving 梯）。 */
  byScale?: Record<string, { n: number; correct: number; accuracy: number }>
  /** 可靠性首次跌破阈值的规模档（无则 undefined = 未观测到崩塌）。 */
  breakdownOnset?: number
}

/** 分位数（线性插值，与 numpy 默认一致）。 */
export function percentile(xs: number[], q: number): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 1) return s[0]
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))

/** 从答案里抽第一个整数/迭代号。 */
function firstIter(text: string): number | null {
  const m = /iter\s*-?\s*(\d+)/i.exec(text) ?? /(\d+)/.exec(text)
  return m === null ? null : Number(m[1])
}

/** 答案文本 → 三态触碰判定（与 probe 真值的 verdict 词汇对齐）。 */
function verdictOf(text: string): 'never' | 'touched' | 'added-then-removed' {
  if (/added-then-removed|加了又(被)?删|先加后删|被删除/.test(text)) return 'added-then-removed'
  if (/没试过|未试过|没有试|never|无记录|不存在/.test(text)) return 'never'
  return 'touched'
}

/** 从答案里抽 next-step 动作集合（接受 `add:X` / `+X` / "加 X" / "删 X"）。 */
export function parseMoves(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:add|remove)\s*[:：]\s*([A-Za-z][A-Za-z0-9_*()]*)/gi)) {
    out.add(`${/^r/i.test(m[0]) ? 'remove' : 'add'}:${m[1]}`)
  }
  for (const m of text.matchAll(/([+＋−-])\s*([A-Za-z][A-Za-z0-9_*()]*)/g)) {
    const op = m[1] === '+' || m[1] === '＋' ? 'add' : 'remove'
    out.add(`${op}:${m[2]}`)
  }
  for (const m of text.matchAll(/(加|添加|挂|删|移除|去掉)\s*([A-Za-z][A-Za-z0-9_*()]*)/g)) {
    const op = /删|移除|去掉/.test(m[1]!) ? 'remove' : 'add'
    out.add(`${op}:${m[2]}`)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 1 : inter / union
}

/** 单个探针的判定（纯函数，按 category 分派）。 */
export function scoreOne(probe: Probe, answer: AnswerRecord, rejectedNames?: Set<string>): ProbeScore {
  const text = asText(answer.answer)
  const base: ProbeScore = {
    id: probe.id,
    analysis: probe.analysis,
    category: probe.category,
    arm: answer.arm ?? 'default',
    run: answer.run ?? 0,
    correct: false,
    ...(answer.scale !== undefined ? { scale: answer.scale } : {}),
    ...(answer.memoryCalls !== undefined ? { memoryCalls: answer.memoryCalls } : {}),
    ...(answer.tokensIn !== undefined ? { tokensIn: answer.tokensIn } : {}),
    ...(answer.tokensOut !== undefined ? { tokensOut: answer.tokensOut } : {}),
    ...(probe.truth.aliasOf !== undefined ? { aliasTrap: true } : {}),
  }
  switch (probe.category) {
    case 'current-state': {
      const want = probe.truth.baseIter as number | undefined
      const got = firstIter(text)
      const ok = want !== undefined && got === want
      return { ...base, correct: ok, detail: `want=${want ?? 'n/a'} got=${got ?? 'n/a'}` }
    }
    case 'alias': {
      // 记法变体：真值是本体名的判定（touched / added-then-removed），不是"没试过"
      const ok = text.includes(String(probe.truth.verdict))
      return { ...base, correct: ok, detail: `aliasOf=${String(probe.truth.aliasOf)} want=${String(probe.truth.verdict)}` }
    }
    case 'tried-before': {
      const ok = text.includes(String(probe.truth.verdict))
      return { ...base, correct: ok, detail: `want=${probe.truth.verdict as string}` }
    }
    case 'abstention': {
      const ok = verdictOf(text) === 'never'
      return { ...base, correct: ok, detail: 'want=没试过' }
    }
    case 'round-reference': {
      const computable = probe.truth.computable === true
      const want = probe.truth.prevIter as number | undefined
      const saysNo = /无法计算|算不出|不可计算|n\/a|无 NLL/.test(text)
      const got = firstIter(text)
      const ok = computable ? got === want : saysNo
      return { ...base, correct: ok, detail: `want=${computable ? `iter-${want}` : '无法计算'} got=${saysNo ? '无法计算' : (got ?? 'n/a')}` }
    }
    case 'repeat': {
      const want = probe.answer as number
      const got = firstIter(text)
      return { ...base, correct: got === want, detail: `want=${want} got=${got ?? 'n/a'}` }
    }
    case 'comparability': {
      const wantNotComparable = Array.isArray(probe.truth.reasons) && (probe.truth.reasons as string[]).length > 0
      const saysNotComparable = /不可比|不能比|不可直接比|not comparable/.test(text)
      const ok = wantNotComparable ? saysNotComparable : !saysNotComparable
      return { ...base, correct: ok, detail: `want=${wantNotComparable ? '不可比' : '可比'}` }
    }
    case 'next-step': {
      const want = new Set((probe.truth.moves as { op: string; name: string }[]).map((m) => `${m.op}:${m.name}`))
      const got = parseMoves(text)
      const overlap = jaccard(got, want)
      let repeated = false
      if (rejectedNames !== undefined) {
        for (const mv of got) {
          const name = mv.slice(mv.indexOf(':') + 1)
          if (rejectedNames.has(name)) repeated = true
        }
      }
      return { ...base, correct: overlap === 1, overlap, repeated, detail: `want=${[...want].join(',')} got=${[...got].join(',')}` }
    }
    default:
      return { ...base, detail: `unknown category ${probe.category}` }
  }
}

/** 从日记折叠出"已否决名字集"（next-step 重复率的分母依据）。 */
export function rejectedNamesOf(records: IterationRecord[]): Set<string> {
  const out = new Set<string>()
  for (const r of records) {
    const rejected = r.kind === 'removed' || /回退|回滚|被拒|否决|被否|不采纳/.test(r.title)
    if (!rejected) continue
    for (const e of parseTouchEvents(r)) out.add(e.name)
  }
  return out
}

/** 聚合指标。`budgetB` 默认 2（Scale-Conditioned Eval 的主结果）；`onsetThreshold` 默认 0.7。 */
export function aggregate(
  scores: ProbeScore[],
  _answers: AnswerRecord[],
  opts: { budgetB?: number; onsetThreshold?: number } = {},
): Metrics[] {
  const budgetB = opts.budgetB ?? 2
  const onsetThreshold = opts.onsetThreshold ?? 0.7
  const byArm = new Map<string, ProbeScore[]>()
  for (const s of scores) {
    const list = byArm.get(s.arm) ?? []
    list.push(s)
    byArm.set(s.arm, list)
  }

  const out: Metrics[] = []
  for (const [arm, list] of [...byArm.entries()].sort()) {
    const correct = list.filter((s) => s.correct).length
    const byCategory: Record<string, { n: number; correct: number }> = {}
    const byAnalysis: Record<string, { n: number; correct: number }> = {}
    for (const s of list) {
      byCategory[s.category] = byCategory[s.category] ?? { n: 0, correct: 0 }
      byCategory[s.category]!.n += 1
      if (s.correct) byCategory[s.category]!.correct += 1
      byAnalysis[s.analysis] = byAnalysis[s.analysis] ?? { n: 0, correct: 0 }
      byAnalysis[s.analysis]!.n += 1
      if (s.correct) byAnalysis[s.analysis]!.correct += 1
    }
    // pass^k：按 id 分组，每组内 k 次全对才算过；取所有组里出现过的最大 k
    const byId = new Map<string, boolean[]>()
    for (const s of list) {
      const arr = byId.get(s.id) ?? []
      arr.push(s.correct)
      byId.set(s.id, arr)
    }
    const maxK = Math.max(0, ...[...byId.values()].map((v) => v.length))
    let passK: number | undefined
    if (maxK > 1) {
      const complete = [...byId.values()].filter((v) => v.length === maxK)
      passK = complete.length === 0 ? undefined : complete.filter((v) => v.every(Boolean)).length / complete.length
    }
    const nextStep = list.filter((s) => s.category === 'next-step')
    const repeats = nextStep.filter((s) => s.repeated === true).length
    const overlaps = nextStep.map((s) => s.overlap).filter((x): x is number => typeof x === 'number')
    let tokensInTotal = 0
    let tokensOutTotal = 0
    const calls: number[] = []
    let within = 0
    let passB = 0
    let wrongInBudget = 0
    const byScale = new Map<number, { n: number; correct: number }>()
    for (const s of list) {
      tokensInTotal += s.tokensIn ?? 0
      tokensOutTotal += s.tokensOut ?? 0
      if (typeof s.memoryCalls === 'number') {
        calls.push(s.memoryCalls)
        if (s.memoryCalls <= budgetB) {
          within += 1
          if (s.correct) passB += 1
          else wrongInBudget += 1
        }
      }
      if (typeof s.scale === 'number') {
        const cur = byScale.get(s.scale) ?? { n: 0, correct: 0 }
        cur.n += 1
        if (s.correct) cur.correct += 1
        byScale.set(s.scale, cur)
      }
    }
    const verdict = list.filter((s) => s.category === 'tried-before' || s.category === 'abstention')
    const aliasGroup = list.filter((s) => s.aliasTrap === true)
    const cleanGroup = list.filter((s) => s.aliasTrap !== true && (s.category === 'tried-before' || s.category === 'abstention'))
    let breakdownOnset: number | undefined
    const scaleOut: Record<string, { n: number; correct: number; accuracy: number }> = {}
    for (const [sc, v] of [...byScale.entries()].sort((x, y) => x[0] - y[0])) {
      const accuracy = v.n === 0 ? 0 : v.correct / v.n
      scaleOut[String(sc)] = { n: v.n, correct: v.correct, accuracy }
      if (breakdownOnset === undefined && accuracy < onsetThreshold) breakdownOnset = sc
    }
    out.push({
      arm,
      n: list.length,
      correct,
      accuracy: list.length === 0 ? 0 : correct / list.length,
      ...(passK !== undefined ? { passK, passKValue: maxK } : {}),
      ...(nextStep.length > 0 ? { repeatRate: repeats / nextStep.length, nextStepN: nextStep.length, nextStepRepeats: repeats } : {}),
      ...(overlaps.length > 0 ? { meanOverlap: overlaps.reduce((a, b) => a + b, 0) / overlaps.length } : {}),
      tokensInTotal,
      tokensOutTotal,
      ...(list.length > 0 ? { meanTokensIn: tokensInTotal / list.length } : {}),
      byCategory,
      byAnalysis,
      ...(verdict.length > 0
        ? { verdictAccuracy: verdict.filter((s) => s.correct).length / verdict.length, verdictN: verdict.length }
        : {}),
      ...(aliasGroup.length > 0 || cleanGroup.length > 0
        ? {
            byAlias: {
              alias: { n: aliasGroup.length, correct: aliasGroup.filter((s) => s.correct).length },
              clean: { n: cleanGroup.length, correct: cleanGroup.filter((s) => s.correct).length },
            },
          }
        : {}),
      ...(calls.length > 0
        ? {
            budgetB,
            passAtB: passB / calls.length,
            p90R: percentile(calls, 0.9),
            pWrong: wrongInBudget / calls.length,
            pExh: (calls.length - within) / calls.length,
          }
        : {}),
      ...(Object.keys(scaleOut).length > 0 ? { byScale: scaleOut } : {}),
      ...(breakdownOnset !== undefined ? { breakdownOnset } : {}),
    })
  }
  return out
}

/** attribution markdown（一档一行；用于 docs/attribution 表）。 */
export function attributionMarkdown(metrics: Metrics[], title = '记忆档位 attribution'): string {
  const pct = (x: number | undefined): string => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`)
  const lines = [
    `# ${title}`,
    '',
    '| 档位 | n | 准确率 | 判定类联合* | pass^k | 重复率 | 平均重合 | Pass@B | P90R | p_wrong | p_exh | onset | 注入 tokens/条 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  const num = (x: number | undefined, d = 2): string => (x === undefined ? '—' : x.toFixed(d))
  for (const m of metrics) {
    lines.push(
      `| ${m.arm} | ${m.n} | ${pct(m.accuracy)} | ${pct(m.verdictAccuracy)} | ${m.passK === undefined ? '—' : `${pct(m.passK)} (k=${m.passKValue ?? '?'})`} | ${pct(m.repeatRate)} | ${m.meanOverlap === undefined ? '—' : m.meanOverlap.toFixed(2)} | ${pct(m.passAtB)}${m.budgetB === undefined ? '' : ` (B=${m.budgetB})`} | ${num(m.p90R, 1)} | ${pct(m.pWrong)} | ${pct(m.pExh)} | ${m.breakdownOnset ?? '—'} | ${m.meanTokensIn === undefined ? '—' : Math.round(m.meanTokensIn)} |`,
    )
  }
  const withScale = metrics.filter((m) => m.byScale !== undefined)
  if (withScale.length > 0) {
    lines.push('', '规模梯（evidence-preserving：只加无关历史）：', '', '| 档位 | 规模 | n | 准确率 |', '|---|---|---|---|')
    for (const m of withScale) {
      for (const [sc, v] of Object.entries(m.byScale!).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        lines.push(`| ${m.arm} | ${sc} | ${v.n} | ${pct(v.accuracy)} |`)
      }
    }
  }
  lines.push('', '\* 判定类联合 = tried-before ∪ abstention（防止只看 abstention：零记忆档在那里是 100%）。', '')
  const withAlias = metrics.filter((m) => m.byAlias !== undefined)
  if (withAlias.length > 0) {
    lines.push('', '近名陷阱 vs 干净题（判定类内）：', '', '| 档位 | 分组 | n | 准确率 |', '|---|---|---|---|')
    for (const m of withAlias) {
      const pct2 = (v: { n: number; correct: number }): string => (v.n === 0 ? '—' : `${((v.correct / v.n) * 100).toFixed(1)}%`)
      lines.push(`| ${m.arm} | 近名陷阱 | ${m.byAlias!.alias.n} | ${pct2(m.byAlias!.alias)} |`)
      lines.push(`| ${m.arm} | 干净 | ${m.byAlias!.clean.n} | ${pct2(m.byAlias!.clean)} |`)
    }
  }
  lines.push('分类别准确率：', '', '| 档位 | 类别 | n | 准确率 |', '|---|---|---|---|')
  for (const m of metrics) {
    for (const [cat, v] of Object.entries(m.byCategory).sort()) {
      lines.push(`| ${m.arm} | ${cat} | ${v.n} | ${pct(v.correct / v.n)} |`)
    }
  }
  return lines.join('\n') + '\n'
}

/** 便捷入口：探针 + 答案 → 分数 + 指标 + markdown。 */
export function scoreAll(
  probes: Probe[],
  answers: AnswerRecord[],
  rejected: Map<string, Set<string>> = new Map(),
): { scores: ProbeScore[]; metrics: Metrics[]; markdown: string } {
  const byId = new Map(probes.map((p) => [p.id, p]))
  const scores: ProbeScore[] = []
  for (const a of answers) {
    const p = byId.get(a.id)
    if (p === undefined) continue // 未知探针 id：忽略（不猜）
    scores.push(scoreOne(p, a, rejected.get(p.analysis)))
  }
  const metrics = aggregate(scores, answers)
  return { scores, metrics, markdown: attributionMarkdown(metrics) }
}
