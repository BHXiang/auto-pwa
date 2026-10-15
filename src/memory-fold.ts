/**
 * memory-fold：把日记记录序列"折叠"成**当前状态**。
 *
 * 为什么必须 fold：当前状态**不等于任何一条记录**。实测反例（`chic2ppeta`）：
 * 模型基线是 `iter-009`，但从 iter-013 起记录里反复出现"以 iter-006 为基座"、
 * "基座 iter-016"——这些都是**实验基座**（某次尝试从哪个 config 出发），
 * 不是模型基线。于是任何"取最后一次 iter-N 提法"的启发式都会答错。
 *
 * 因此本模块区分两种语义并按**规则优先级**折叠：
 *   ① 模型基线（model baseline）：回退目标 / "最终模型定为 iter-N" / "基线仍 iter-N"
 *   ② 实验基座（experiment base）："以 iter-N 为基座"、"基座 iter-N"
 * 只把 ① 的结果当作"当前基线"，并把 ② 记下来供交叉检查。
 *
 * 能力边界（诚实声明）：prose 里"某态被删/被建议回退"的**是否已生效**无法只靠
 * 正则判定，因此 `pendingEdits` 带 `advisory` 标记，且不据此自动计分。
 */
import type { IterationRecord } from './report.js'

export type TouchOp = 'add' | 'remove'

export interface TouchEvent {
  iter: number
  kind: string
  op: TouchOp
  name: string
  /** delta = 来自 `+=` / `-=`；prose = 从"移除/删除…"散文里勉强抽出（低可信）。 */
  source: 'delta' | 'prose'
  raw: string
}

/** 名字 token 的清洗：取"以字母开头的标识符"，允许 ASCII 括号（如 `eta2(1870)`），
 * 并砍掉不平衡的尾部括号（`X2200 (` → `X2200`）。 */
function cleanName(token: string): string {
  const m = /^[A-Za-z][A-Za-z0-9_*()]*/.exec(token.trim())
  if (m === null) return ''
  let s = m[0]
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') {
      depth--
      if (depth < 0) return s.slice(0, i)
    }
  }
  if (depth > 0) {
    const cut = s.lastIndexOf('(')
    if (cut > 0) s = s.slice(0, cut)
  }
  return s
}

/** 明显不是共振态名的 token（链名、区间、泛指词、参数名）。 */
const NOT_A_NAME =
  /^(chain\d+|Resonances|BWR|BW|GS|Flatte|ONE|Interp|Custom|new|group|free|range|init|value|lower|upper|mass|width|iter|config|LS)$/i

/** 散文形态的动作词：`重建 X2200`、`移除 chain2/chain3 [3-] K3*_1780`、`… 定义删除`。 */
const PROSE_ACTIONS: { re: RegExp; op: TouchOp }[] = [
  { re: /(?:移除|删除|删掉|删去)/, op: 'remove' },
  { re: /(?:重建|重新挂|改挂|添加|加入|挂上)/, op: 'add' },
]

const PROSE_STOPWORDS = /^(建议|回退|回滚|实验|定义|保留|区间|初值|成分|组|个|处|的)$/

/**
 * 从一条记录的 `changes[]` 抽 touch 事件。
 *
 * 可信来源是 `+=` / `-=`；散文形态（实测至少 4 种写法：`移除 chain2/chain3 [3-] X`、
 * `重建 X`、`以 iter-N 为基座重建 X`、`Resonances.X 定义删除`）另标
 * `source:'prose'`——**低可信**，因为正则不可能穷尽写法。散文形态取"动作词之后
 * 第一个合法名字"；若之后没有（如 `… 定义删除`），退而取动作词之前最后一个。
 */
export function parseTouchEvents(rec: Pick<IterationRecord, 'iter' | 'kind' | 'changes'>): TouchEvent[] {
  const out: TouchEvent[] = []
  for (const raw of rec.changes ?? []) {
    let matchedDelta = false
    for (const m of raw.matchAll(/([+-])=\s*([A-Za-z][A-Za-z0-9_*()]*)/g)) {
      const op: TouchOp = m[1] === '+' ? 'add' : 'remove'
      const name = cleanName(m[2] ?? '')
      if (name === '' || NOT_A_NAME.test(name)) continue
      out.push({ iter: rec.iter, kind: rec.kind, op, name, source: 'delta', raw })
      matchedDelta = true
    }
    if (matchedDelta) continue
    for (const action of PROSE_ACTIONS) {
      const mm = action.re.exec(raw)
      if (mm === null) continue
      const names = (text: string): string[] =>
        [...text.matchAll(/[A-Za-z][A-Za-z0-9_*()]*/g)]
          .map((m) => cleanName(m[0]))
          .filter((t) => t !== '' && !NOT_A_NAME.test(t) && !PROSE_STOPWORDS.test(t))
      const after = names(raw.slice(mm.index + mm[0].length))
      const before = names(raw.slice(0, mm.index))
      const name = after[0] ?? before[before.length - 1]
      if (name !== undefined) out.push({ iter: rec.iter, kind: rec.kind, op: action.op, name, source: 'prose', raw })
      break
    }
  }
  return out
}

/** 每个名字的触碰时间线（用于"试过没有/提过几次"）。 */
export interface TouchTimeline {
  name: string
  firstIter: number
  /** 该名字**首次/重新**出现的迭代号（集合增量语义，不是"每条记录都算一次"）。 */
  newlyAt: number[]
  events: TouchEvent[]
}

/**
 * 触碰时间线。`newlyAt` 用**集合增量**定义：某轮的名字集合相对**上一轮**新增了
 * 它才算一次"新触碰"。必要性来自实测——`chic2ppeta` 的 `changes[]` 每轮都把
 * 整个态栈重述一遍，若按"出现过就算一次"会把 X1835 数成 4 次、eta2(1870) 数成 5 次。
 */
export function touchTimeline(records: IterationRecord[], opts: { includeProse?: boolean } = {}): TouchTimeline[] {
  const includeProse = opts.includeProse === true
  const sorted = [...records].sort((a, b) => a.iter - b.iter)
  const byName = new Map<string, TouchTimeline>()
  let prevSet = new Set<string>()
  for (const rec of sorted) {
    const evs = parseTouchEvents(rec).filter((e) => includeProse || e.source === 'delta')
    const here = new Set(evs.map((e) => e.name))
    for (const e of evs) {
      const tl = byName.get(e.name) ?? { name: e.name, firstIter: rec.iter, newlyAt: [], events: [] }
      tl.events.push(e)
      if (!prevSet.has(e.name) && !tl.newlyAt.includes(rec.iter)) tl.newlyAt.push(rec.iter)
      byName.set(e.name, tl)
    }
    prevSet = here
  }
  return [...byName.values()].sort((a, b) => a.firstIter - b.firstIter || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// 模型基线 fold
// ---------------------------------------------------------------------------

interface BaselineRule {
  rule: string
  re: RegExp
  confidence: 'high' | 'low'
  /** 只在某个字段范围内匹配：`changes` 是"本轮从哪出发"的结构位置。 */
  scope: 'full' | 'changes'
}

/**
 * 规则**按优先级排序**（同一条记录内先匹配者胜）。设计依据是实测语料，不是猜的：
 *
 * - `base-of-change` 限定在 **changes[]** 里匹配 `基座 iter-N`：KsKs 用它表示
 *   "本轮起点 = iter-004"（正确），而 chic2ppeta iter-017 的 `基座 iter-016`
 *   出现在 conclusion（是"某次单删测试的基座"）→ 不匹配。**字段位置**是这两种
 *   相反语义的唯一可靠区分。
 * - `rollback-bare` 带 `(?!\s*的)`：KsKs 的"回退 iter-008 **的** K2*_1980 实验"
 *   是"撤销 8 号实验"，不是"回退到 8"。
 * - `以 iter-N 为基座` **不属于**基线规则（那是实验基座，见 `EXPERIMENT_BASE_RE`）。
 */
const BASELINE_RULES: BaselineRule[] = [
  { rule: 'final-model', re: /最终模型\s*(?:定|确定|确立)?\s*(?:为|是)?\s*iter-(\d+)(?!\d)/g, confidence: 'high', scope: 'full' },
  { rule: 'rollback-target', re: /(?:回退|回滚)\s*(?:到|至)\s*iter-(\d+)(?!\d)/g, confidence: 'high', scope: 'full' },
  // "回退基线到 iter-009"（动词在基线之前）——实测 chic2ppeta 的写法
  { rule: 'rollback-via-base', re: /(?:回退|回滚)\s*(?:到|至)?\s*(?:基线|基座)\s*(?:到|至|为)?\s*iter-(\d+)(?!\d)/g, confidence: 'high', scope: 'full' },
  // "基座回退 iter-004"（基线词在动词之前）——实测 KsKs 的写法
  { rule: 'rollback-base-first', re: /(?:基线|基座)\s*(?:回退|回滚)\s*(?:到|至)?\s*iter-(\d+)(?!\d)/g, confidence: 'high', scope: 'full' },
  // 裸"回退 iter-N"，但"回退 iter-N 的…实验"是**撤销**该实验，不是回退目标
  { rule: 'rollback-bare', re: /(?:回退|回滚)\s*iter-(\d+)(?!\d)(?!\s*的)/g, confidence: 'high', scope: 'full' },
  { rule: 'base-declared', re: /(?:以\s*)?iter-(\d+)(?!\d)\s*为\s*(?:新的?|当前)?\s*基线/g, confidence: 'high', scope: 'full' },
  { rule: 'still-base', re: /基线\s*(?:仍|仍为|仍然|依旧)?\s*(?:为|是)?\s*iter-(\d+)(?!\d)/g, confidence: 'high', scope: 'full' },
  { rule: 'still-best', re: /iter-(\d+)(?!\d)\s*(?:仍|依旧)\s*(?:为|是)?\s*(?:最佳)?基线/g, confidence: 'high', scope: 'full' },
  { rule: 'base-of-change', re: /(?:^|[^以\s])基座\s*(?:是|=|：)?\s*iter-(\d+)(?!\d)/g, confidence: 'high', scope: 'changes' },
  { rule: 'base-near', re: /基线\s*[（(]?\s*(?:用|取|是)?\s*iter-(\d+)(?!\d)/g, confidence: 'low', scope: 'full' },
]

const EXPERIMENT_BASE_RE = /以\s*iter-(\d+)\s*为基座/g

export interface BaselineFoldStep {
  iter: number
  rule: string
  baseIter: number
  confidence: 'high' | 'low'
}

export interface BaselineFold {
  /** 折叠出的当前模型基线；无任何信号时 null。 */
  baseIter: number | null
  rule?: string
  confidence: 'high' | 'low' | 'none'
  steps: BaselineFoldStep[]
  /** 出现过"以 iter-N 为基座"的迭代 → 说明为什么不能用"最后一次 iter-N 提法"。 */
  experimentBases: { iter: number; baseIter: number }[]
  /** 基线确定之后出现的触碰事件（"当前模型 = baseIter + pendingEdits"的候选）。 */
  pendingEdits: { iter: number; op: TouchOp; name: string; advisory: boolean }[]
}

function recordText(rec: IterationRecord): string {
  return [rec.title ?? '', rec.conclusion ?? '', rec.nextPlan ?? '', ...(rec.changes ?? [])].join(' | ')
}

/** 折叠模型基线（可选 `untilIter` 只看到第 k 轮为止——E1 的"第 k 步状态"探针要用）。 */
export function modelBaselineFold(records: IterationRecord[], untilIter?: number): BaselineFold {
  const sorted = [...records].filter((r) => untilIter === undefined || r.iter <= untilIter).sort((a, b) => a.iter - b.iter)
  const steps: BaselineFoldStep[] = []
  const experimentBases: { iter: number; baseIter: number }[] = []
  let baseIter: number | null = null
  let rule: string | undefined
  let confidence: 'high' | 'low' | 'none' = 'none'
  let baseSetAt = -1

  for (const rec of sorted) {
    const text = recordText(rec)
    const changesText = (rec.changes ?? []).join(' | ')
    for (const m of text.matchAll(EXPERIMENT_BASE_RE)) experimentBases.push({ iter: rec.iter, baseIter: Number(m[1]) })

    for (const r of BASELINE_RULES) {
      const target = r.scope === 'changes' ? changesText : text
      if (target === '') continue
      r.re.lastIndex = 0
      const m = r.re.exec(target)
      if (m === null) continue
      const n = Number(m[1])
      baseIter = n
      rule = r.rule
      confidence = r.confidence
      baseSetAt = rec.iter
      steps.push({ iter: rec.iter, rule: r.rule, baseIter: n, confidence: r.confidence })
      break
    }
  }

  const pendingEdits: BaselineFold['pendingEdits'] = []
  for (const rec of sorted) {
    if (rec.iter <= baseSetAt) continue
    for (const e of parseTouchEvents(rec)) {
      pendingEdits.push({ iter: rec.iter, op: e.op, name: e.name, advisory: /建议|考虑|若|待确认/.test(e.raw) })
    }
  }

  return {
    baseIter,
    ...(rule !== undefined ? { rule } : {}),
    confidence,
    steps,
    experimentBases,
    pendingEdits,
  }
}

/** "这个态试过吗"——代码可判定的三态答案。 */
export function triedBefore(
  records: IterationRecord[],
  name: string,
  opts: { includeProse?: boolean } = {},
): { verdict: 'never' | 'touched' | 'added-then-removed'; events: TouchEvent[] } {
  const tl = touchTimeline(records, opts).find((t) => t.name === name)
  if (tl === undefined) return { verdict: 'never', events: [] }
  const firstAdd = tl.events.find((e) => e.op === 'add')
  const laterRemove = firstAdd !== undefined && tl.events.some((e) => e.op === 'remove' && e.iter > firstAdd.iter)
  return { verdict: laterRemove ? 'added-then-removed' : 'touched', events: tl.events }
}

/**
 * 两种 **naive 启发式**的答案，用来量化"不做 fold 会错多少"：
 *  - `lastRecordWithNll`：最后一条带 NLL 的记录所对应的迭代号（"取最后一条记录"）
 *  - `maxIter`：日记里最大的迭代号（"取最新一轮"）
 *  - `lastTextualMention`：全文最后一次出现的 `iter-N`（"取最后一次提及"——注意它
 *    可能**碰巧**答对，例如 chic2ppeta 的 iter-017 结论末尾又提了"从 iter-009 基座"；
 *    所以它单独不足以作为对照，必须和上面两个一起看）
 */
export function naiveAnswers(
  records: IterationRecord[],
  untilIter?: number,
): { lastTextualMention: number | null; lastRecordWithNll: number | null; maxIter: number | null } {
  const sorted = [...records].filter((r) => untilIter === undefined || r.iter <= untilIter).sort((a, b) => a.iter - b.iter)
  let lastTextualMention: number | null = null
  for (const rec of sorted) {
    for (const m of recordText(rec).matchAll(/iter-(\d+)/g)) lastTextualMention = Number(m[1])
  }
  let lastRecordWithNll: number | null = null
  for (const rec of sorted) if (typeof rec.nll === 'number') lastRecordWithNll = rec.iter
  const maxIter = sorted.length === 0 ? null : sorted[sorted.length - 1]!.iter
  return { lastTextualMention, lastRecordWithNll, maxIter }
}
