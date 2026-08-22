/**
 * auto-pwa loop state machine: durable, restart-safe automation bookkeeping
 * for "iterate until the optimal fit".
 *
 * The AI is the decision layer (proposal / trials / rollback / converge); this
 * module owns the EXECUTION bookkeeping: what the accepted baseline is, which
 * iteration is being evaluated, the objective (stop criteria + significance
 * threshold), the round budget, and the final report. State persists in
 * iterations/.loop-state.json so the loop survives session restarts.
 *
 * Pure-ish functions over the state file (fs I/O only for load/save/report).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IterationLog, listIterations } from './iteration-log.js'

export interface LoopObjective {
  /** max|pull| below which pulls are acceptable; default 5. */
  stopMaxPull: number
  /** |ΔNLL| below which the last change is not worth keeping; default 10. */
  stopDeltaNll: number
  /** |ΔNLL| >= threshold counts as a significant change; default 3. */
  significanceThreshold: number
  /** Hard cap on accepted iterations; default 20. */
  maxRounds: number
}

export const DEFAULT_OBJECTIVE: LoopObjective = {
  stopMaxPull: 5,
  stopDeltaNll: 10,
  significanceThreshold: 3,
  maxRounds: 20,
}

export type LoopPhase = 'evaluate' | 'propose' | 'done'

export interface LoopEval {
  iter: number
  iterDir: string
  nll: number | null
  deltaNll: number | null
  maxPull: number | null
  hessianPositive: boolean | null
  verdict: 'significant-improvement' | 'not-significant' | 'no-data'
}

export interface LoopState {
  schemaVersion: 1
  iterationsRoot: string
  phase: LoopPhase
  /** Accepted baseline iteration dir (the last good fit). */
  baseIterDir: string
  /** Iteration currently being evaluated / to be iterated upon. */
  currentIterDir: string
  iter: number
  /** Number of accepted iterations so far (budget). */
  rounds: number
  objective: LoopObjective
  lastEval?: LoopEval
  finalized?: {
    bestIter: number
    bestNll: number | null
    reason: string
    reportPath: string
  }
}

export function loopStatePath(iterationsRoot: string): string {
  return join(iterationsRoot, '.loop-state.json')
}

export function loadLoopState(iterationsRoot: string): LoopState | undefined {
  const p = loopStatePath(iterationsRoot)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LoopState
  } catch {
    return undefined
  }
}

/** Persist state atomically (tmp + rename). */
export function saveLoopState(state: LoopState): void {
  const p = loopStatePath(state.iterationsRoot)
  const tmp = `${p}.tmp-${Date.now().toString(36)}`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, p)
}

/**
 * Initialize or re-initialize the loop around an accepted baseline iteration.
 * Fails when the baseline dir is missing or not an iter-N dir.
 */
export function initLoopState(
  iterationsRoot: string,
  baseIterDir: string,
  objective: Partial<LoopObjective> = {},
): LoopState {
  const m = /iter-(\d+)/.exec(baseIterDir)
  if (!existsSync(join(baseIterDir, 'config.yml'))) {
    throw new Error(`baseline iteration missing config.yml: ${baseIterDir}`)
  }
  const state: LoopState = {
    schemaVersion: 1,
    iterationsRoot,
    phase: 'evaluate',
    baseIterDir,
    currentIterDir: baseIterDir,
    iter: m !== null ? Number(m[1]) : -1,
    rounds: 0,
    objective: { ...DEFAULT_OBJECTIVE, ...objective },
  }
  saveLoopState(state)
  return state
}

/**
 * Pure convergence judgment for one evaluated iteration:
 * converged when pulls are acceptable AND the last change was NOT a
 * significant improvement (nothing more to gain from this direction) — or
 * when the round budget is exhausted.
 */
export function convergenceVerdict(
  evalResult: { nll: number | null; deltaNll: number | null; maxPull: number | null },
  objective: LoopObjective,
  rounds: number,
): { converged: boolean; reason?: string } {
  if (rounds >= objective.maxRounds) {
    return { converged: true, reason: `达到轮次预算上限（${objective.maxRounds} 轮）` }
  }
  if (evalResult.deltaNll === null) {
    return { converged: false, reason: '缺少上一轮 ΔNLL（首次评估或日记为空）——先执行一轮迭代再判断' }
  }
  const pullOk = evalResult.maxPull === null || evalResult.maxPull < objective.stopMaxPull
  const changedSignificantly = Math.abs(evalResult.deltaNll) >= objective.significanceThreshold
  if (!pullOk) {
    return { converged: false, reason: `max|pull| = ${evalResult.maxPull?.toFixed(2) ?? '?'} >= ${objective.stopMaxPull}：仍有偏差区待处理` }
  }
  if (changedSignificantly) {
    return {
      converged: false,
      reason: `ΔNLL = ${evalResult.deltaNll.toFixed(2)}（|ΔNLL| >= ${objective.significanceThreshold}）：仍有显著改进空间`,
    }
  }
  return {
    converged: true,
    reason: `max|pull| < ${objective.stopMaxPull} 且 |ΔNLL| < ${objective.significanceThreshold}：收敛判据满足`,
  }
}

/** Read the previous iteration's diary record (for ΔNLL), if any. */
export function previousDiaryNll(iterationsRoot: string, currentIter: number): number | undefined {
  const log = new IterationLog({ rootDir: iterationsRoot })
  const records = log.readAll()
  const prev = records.filter((r) => r.iter < currentIter).pop()
  return prev?.nll
}

/** The iteration dir before `iterDir` in the iter-N sequence (for rollback). */
export function previousIterDir(iterationsRoot: string, iterDir: string): string | undefined {
  const dirs = listIterations(iterationsRoot)
  const i = dirs.indexOf(iterDir)
  return i > 0 ? dirs[i - 1] : undefined
}

/**
 * Render the final report markdown from the diary + best evaluation.
 * Written to iterationsRoot/FINAL-REPORT.md.
 */
export function writeFinalReport(
  iterationsRoot: string,
  best: { iter: number; iterDir: string; nll: number | null },
  reason: string,
): string {
  const log = new IterationLog({ rootDir: iterationsRoot })
  const records = log.readAll()
  const lines: string[] = [
    `# PWA 自动迭代最终报告`,
    ``,
    `- 收敛原因: ${reason}`,
    `- 最优迭代: iter-${String(best.iter).padStart(3, '0')}（${best.iterDir}）`,
    `- 最佳 NLL: ${best.nll !== null ? best.nll.toFixed(4) : '—'}`,
    `- 迭代轮数: ${records.length}`,
    ``,
    `## 迭代历史`,
  ]
  for (const r of records) {
    const d = r.deltaNll === undefined ? '' : ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(2)}`
    lines.push(`- **iter-${String(r.iter).padStart(3, '0')}** ${r.title}${d}`)
    if (r.conclusion !== undefined) lines.push(`  - 结论: ${r.conclusion.replace(/\n/g, '\n    ')}`)
    if (r.nextPlan !== undefined) lines.push(`  - 下一步: ${r.nextPlan.replace(/\n/g, '\n    ')}`)
  }
  const reportPath = join(iterationsRoot, 'FINAL-REPORT.md')
  writeFileSync(reportPath, lines.join('\n') + '\n')
  return reportPath
}
