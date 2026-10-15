/**
 * state-digest：把"当前状态"渲染成一小段**代码生成**的注入文本。
 *
 * 用途：作为 DSH 的 runtime context（`ctx.systemPrompt.context`）每轮自动注入，
 * 让模型不必（也不能）自己"记"当前基线、否决清单与未决预测。
 *
 * 设计约束（来自 docs/memory-system-design-and-eval.md §7.5 与 §8.2 实测）：
 *   - **不是**"读最后一条记录"：比对基线由 `modelBaselineFold` 折叠得到，并且当
 *     naive 的"取最新一轮"会答错时**显式点出来**（实测 28/31 个 round 会答错）；
 *   - 注入体积必须小（实测全量日记 4.7k–6.9k tokens → 摘要 ~100–200 tokens）；
 *   - 纯函数、无 I/O：便于单测，也保证 sync provider 不会抛。
 */
import { modelBaselineFold, naiveAnswers } from './memory-fold.js'
import type { IterationRecord } from './report.js'

export interface DigestLoopState {
  phase?: string
  iter?: number
  lastEval?: { nll?: number | null; maxPull?: number | null } | null
  pendingPrediction?: { hypothesis?: string } | null
}

export interface DigestInput {
  analysisRoot: string
  records: IterationRecord[]
  loopState?: DigestLoopState
  /** 最近一轮的 run-to-run NLL 极差（"ΔNLL 小于它不可信"），可选。 */
  noise?: { iter: number; nRuns: number; spread: number }
}

const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/**
 * 渲染注入文本。没有日记 → 返回空串（"不注入"必须是一个合法结果，
 * 否则插件在无关工作区里会污染每一轮上下文）。
 */
export function buildStateDigest(input: DigestInput): string {
  const { analysisRoot, records } = input
  if (records.length === 0) return ''
  const sorted = [...records].sort((a, b) => a.iter - b.iter)
  const last = sorted[sorted.length - 1]!
  const withNll = sorted.filter((r) => typeof r.nll === 'number')
  const lastNll = withNll[withNll.length - 1]
  const bestNll = withNll.reduce<IterationRecord | undefined>(
    (best, r) => (best === undefined || (r.nll as number) < (best.nll as number) ? r : best),
    undefined,
  )
  const fold = modelBaselineFold(sorted)
  const naive = naiveAnswers(sorted)
  const rejected = sorted.filter((r) => r.kind === 'removed' || /回退|回滚|被拒|否决|被否|不采纳/.test(r.title))

  const pad = (n: number): string => String(n).padStart(3, '0')
  const lines: string[] = ['<system-reminder>', 'auto-pwa 当前状态（代码生成，非模型记忆；据此决策，不要凭印象）']
  lines.push(`分析目录: ${analysisRoot}`)
  lines.push(`最近一轮: iter-${pad(last.iter)} [${last.kind}] ${cut(last.title, 80)}`)
  if (fold.baseIter !== null) {
    const disagree =
      naive.maxIter !== null && naive.maxIter !== fold.baseIter
        ? ` ⚠️ 最后一条记录是 iter-${pad(naive.maxIter)}——"取最新一轮"会答错`
        : ''
    lines.push(`ΔNLL 比对基线: iter-${pad(fold.baseIter)}（fold rule=${fold.rule ?? 'n/a'}, confidence=${fold.confidence}）${disagree}`)
  } else {
    lines.push('ΔNLL 比对基线: 未知（日记里没有基线声明）——先确认基线再比 ΔNLL')
  }
  if (lastNll !== undefined) {
    const d = typeof lastNll.deltaNll === 'number' ? ` ΔNLL=${lastNll.deltaNll > 0 ? '+' : ''}${lastNll.deltaNll.toFixed(2)}` : ''
    lines.push(`最后带 NLL **字段**的记录: iter-${pad(lastNll.iter)} NLL=${(lastNll.nll as number).toFixed(2)}${d}`)
  }
  // 字段为空但结论里写了数字（实测 chicj2KKeta iter-016：字段 null、文本 -3954.88）
  // → 单独提示并标明来源，避免 fold/噪声判据误用，也提醒补结构化字段。
  if (typeof last.nll !== 'number' && last.conclusion !== undefined) {
    const m = /NLL\s*[=＝]\s*(-?\d+(?:\.\d+)?)/.exec(last.conclusion)
    if (m !== null) {
      lines.push(`⚠️ 最近一轮的 NLL 只在结论文本里（${m[1]}），字段为空——建议 auto_pwa_note 写结构化 nll（否则 fold/噪声判据都用不上这个数）`)
    }
  }
  if (bestNll !== undefined && bestNll.iter !== lastNll?.iter) {
    lines.push(`NLL 最低的一轮: iter-${pad(bestNll.iter)} NLL=${(bestNll.nll as number).toFixed(2)}（≠ 比对基线时不要混用两个数）`)
  }
  if (rejected.length > 0) {
    const tail = rejected.slice(-5).map((r) => {
      const d = typeof r.deltaNll === 'number' ? `(${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(1)})` : ''
      return `iter-${pad(r.iter)} ${cut(r.title, 34)}${d}`
    })
    lines.push(`已否决/回退（共 ${rejected.length}，最近 5）: ${tail.join('；')}`)
  }
  if (input.loopState?.pendingPrediction != null) {
    const h = input.loopState.pendingPrediction.hypothesis
    lines.push(`未决预测: ${h === undefined ? '（本轮提交的预测尚未验证）' : cut(h, 90)}`)
  }
  if (input.loopState?.phase !== undefined) lines.push(`循环阶段: ${input.loopState.phase}${input.loopState.iter === undefined ? '' : `（iter-${pad(input.loopState.iter)}）`}`)
  if (input.noise !== undefined && input.noise.spread > 0) {
    lines.push(
      `噪声地板: iter-${pad(input.noise.iter)} 的 ${input.noise.nRuns} 个随机初值 NLL 极差=${input.noise.spread.toFixed(0)}；|ΔNLL| 远小于它时**不可信**（要 warm start + 多次重复）`,
    )
  }
  if (last.nextPlan !== undefined && last.nextPlan.trim() !== '') lines.push(`上轮计划: ${cut(last.nextPlan, 120)}`)
  lines.push('</system-reminder>')
  return lines.join('\n')
}
