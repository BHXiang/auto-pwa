/**
 * auto_pwa_fit_summary: parse fit outputs (results/optimization_summary.txt,
 * results/nll_history.txt) into structured numbers for the model.
 * Pure functions; no I/O (callers read the files).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'

export interface OptimizationSummary {
  /** Best NLL across runs ("最佳NLL: <v>"). */
  bestNll: number | null
  /** Number of runs ("总运行次数: <v>"). */
  totalRuns: number | null
  /** Free coupling parameter count ("耦合参数数量: <v>"). */
  couplingParams: number | null
  /** Free resonance parameter count ("自由共振态参数: <v>"). */
  freeResParams: number | null
  /** Whether the best result's Hessian was positive definite. */
  positiveDefinite: boolean | null
  /** "排名 1" row's run id, nll, iterations when present. */
  bestRun?: { runId: number; nll: number; iterations: number }
}

export interface NllHistoryTail {
  /** Last recorded NLL value. */
  lastNll: number | null
  /** Number of recorded iterations. */
  iterations: number | null
}

/** Parse results/optimization_summary.txt (Chinese labels, see fit.py). */
export function parseOptimizationSummary(text: string): OptimizationSummary {
  const out: OptimizationSummary = {
    bestNll: null,
    totalRuns: null,
    couplingParams: null,
    freeResParams: null,
    positiveDefinite: null,
  }
  const num = (label: string): number | null => {
    const m = new RegExp(`${label}\\s*:\\s*([-+0-9.eE]+)`).exec(text)
    return m ? Number(m[1]) : null
  }
  out.bestNll = num('最佳NLL')
  out.totalRuns = num('总运行次数')
  out.couplingParams = num('耦合参数数量')
  out.freeResParams = num('自由共振态参数')
  out.positiveDefinite = /正定\s+True/.test(text)
  // Best row: first line under the ranking header that starts with "1 ".
  const rankRow = /^1\s+(\d+)\s+([-+0-9.eE]+)\s+(\d+)/m.exec(text)
  if (rankRow) {
    out.bestRun = { runId: Number(rankRow[1]), nll: Number(rankRow[2]), iterations: Number(rankRow[3]) }
  }
  return out
}

/** Parse results/nll_history.txt tail (lines "N  nll", per-run sections). */
export function parseNllHistoryTail(text: string): NllHistoryTail {
  const lines = text.split('\n').filter((l) => /^\s*\d+\s+[-+0-9.eE]+/.test(l))
  if (lines.length === 0) return { lastNll: null, iterations: null }
  const last = lines[lines.length - 1].trim().split(/\s+/)
  return { lastNll: Number(last[1]), iterations: Number(last[0]) }
}

/** Convenience: read+parse a fit's results directory (node fs). */
export function summarizeFitDir(iterDir: string): {
  summary: OptimizationSummary
  history: NllHistoryTail
  files: string[]
} {
  const resultsDir = `${iterDir}/results`
  const files = existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => !f.endsWith('.root') || f === 'weight_best.root') : []
  const summary = existsSync(`${resultsDir}/optimization_summary.txt`)
    ? parseOptimizationSummary(readFileSync(`${resultsDir}/optimization_summary.txt`, 'utf8'))
    : parseOptimizationSummary('')
  const history = existsSync(`${resultsDir}/nll_history.txt`)
    ? parseNllHistoryTail(readFileSync(`${resultsDir}/nll_history.txt`, 'utf8'))
    : parseNllHistoryTail('')
  return { summary, history, files }
}
