/**
 * auto_pwa_fit_summary: parse fit outputs into structured numbers for the model.
 * Primary channel: results/fit.json (aifit.py — AI-first driver). Fallback:
 * results/optimization_summary.txt + nll_history.txt (fit.py text outputs).
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
  bestRun?: { runId: number; nll: number; iterations: number | null }
}

export interface NllHistoryTail {
  /** Last recorded NLL value. */
  lastNll: number | null
  /** Number of recorded iterations. */
  iterations: number | null
}

/** One best-fit parameter (aifit.py fit.json). */
export interface FitParamView {
  name: string
  kind: 'coupling' | 'resonance'
  /** Resonance params: physical value/error + bounds. */
  value?: number | null
  error?: number | null
  lower?: number
  upper?: number
  /** True when the value sits on a free_range boundary (撞边界). */
  atBoundary?: boolean
  /** Coupling params: complex value with errors. */
  real?: number | null
  imag?: number | null
  realError?: number | null
  imagError?: number | null
}

/** One wave/branch fraction (aifit.py fit.json). */
export interface FitFractionView {
  amplitude: string
  fraction: number
  error?: number | null
}

/** Structured view of aifit.py's results/fit.json. */
export interface FitJsonView {
  schemaVersion?: string
  status: string
  error?: { code: string; message: string } | null
  fit?: {
    nCouplingFree?: number
    nResFree?: number
    runs?: number
    maxIter?: number
    timeSec?: number
    runSummaries?: { runId: number; nll?: number; iterations?: number; positiveDefinite?: boolean; error?: string }[]
    best?: {
      runId?: number
      nll?: number
      positiveDefinite?: boolean
      params?: FitParamView[]
      fitFractions?: FitFractionView[] | null
      branchFractions?: FitFractionView[] | null
    }
    /** Interference matrix read back from weight_best.root (available=false = untrustworthy). */
    interference?: {
      available: boolean
      reason?: string
      totalIntensity?: number
      matrix?: number[][]
      fractions?: FitFractionView[]
      topInterference?: { pair: [string, string]; value: number }[]
    }
    warnings?: string[]
  }
}

/** Parse results/fit.json (aifit.py schema; tolerant of missing fields). */
export function parseFitJson(text: string): FitJsonView {
  const raw = JSON.parse(text) as Record<string, unknown>
  const fit = raw.fit as Record<string, unknown> | undefined
  const best = fit?.best as Record<string, unknown> | undefined
  const out: FitJsonView = {
    schemaVersion: typeof raw.schemaVersion === 'string' ? raw.schemaVersion : undefined,
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    error: raw.error as FitJsonView['error'],
  }
  if (fit) {
    out.fit = {
      nCouplingFree: asNum(fit.nCouplingFree),
      nResFree: asNum(fit.nResFree),
      runs: asNum(fit.runs),
      maxIter: asNum(fit.maxIter),
      timeSec: asNum(fit.timeSec),
      runSummaries: Array.isArray(fit.runSummaries)
        ? fit.runSummaries.filter((r): r is { runId: number; nll?: number; iterations?: number; positiveDefinite?: boolean; error?: string } =>
            r !== null && typeof r === 'object' && typeof (r as { runId?: unknown }).runId === 'number')
        : undefined,
      warnings: Array.isArray(fit.warnings) ? fit.warnings.map(String) : undefined,
    }
    if (best) {
      out.fit.best = {
        runId: asNum(best.runId),
        nll: asNum(best.nll),
        positiveDefinite: typeof best.positiveDefinite === 'boolean' ? best.positiveDefinite : undefined,
        params: Array.isArray(best.params) ? best.params.map((p) => p as FitParamView) : undefined,
        fitFractions: Array.isArray(best.fitFractions) ? best.fitFractions.map((f) => f as FitFractionView) : undefined,
        branchFractions: Array.isArray(best.branchFractions) ? best.branchFractions.map((f) => f as FitFractionView) : undefined,
      }
    }
    const inter = fit.interference as Record<string, unknown> | undefined
    if (inter !== undefined && typeof inter.available === 'boolean') {
      out.fit.interference = {
        available: inter.available,
        reason: typeof inter.reason === 'string' ? inter.reason : undefined,
        totalIntensity: asNum(inter.totalIntensity),
        matrix: Array.isArray(inter.matrix) ? inter.matrix.map((row) => Array.isArray(row) ? row.map(Number) : []) : undefined,
        fractions: Array.isArray(inter.fractions) ? inter.fractions.map((f) => f as FitFractionView) : undefined,
        topInterference: Array.isArray(inter.topInterference)
          ? inter.topInterference.filter((p): p is { pair: [string, string]; value: number } =>
              p !== null && typeof p === 'object' && Array.isArray((p as { pair?: unknown }).pair) && typeof (p as { value?: unknown }).value === 'number')
          : undefined,
      }
    }
  }
  return out
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
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

/**
 * Convenience: read+parse a fit's results directory (node fs).
 * Prefers results/fit.json (aifit.py) over the legacy text outputs;
 * `fitJson` carries the full structured view (params/fractions/warnings).
 */
export function summarizeFitDir(iterDir: string): {
  summary: OptimizationSummary
  history: NllHistoryTail
  files: string[]
  fitJson?: FitJsonView
} {
  const resultsDir = `${iterDir}/results`
  const files = existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => !f.endsWith('.root') || f === 'weight_best.root') : []
  const fitJsonPath = `${resultsDir}/fit.json`
  let fitJson: FitJsonView | undefined
  let summary: OptimizationSummary
  if (existsSync(fitJsonPath)) {
    try {
      fitJson = parseFitJson(readFileSync(fitJsonPath, 'utf8'))
    } catch {
      fitJson = undefined
    }
  }
  const best = fitJson?.fit?.best
  if (best !== undefined) {
    const runSummary = fitJson!.fit!.runSummaries?.find((r) => r.runId === best.runId)
    summary = {
      bestNll: best.nll ?? null,
      totalRuns: fitJson!.fit!.runSummaries?.filter((r) => r.nll !== undefined).length ?? fitJson!.fit!.runs ?? null,
      couplingParams: fitJson!.fit!.nCouplingFree ?? null,
      freeResParams: fitJson!.fit!.nResFree ?? null,
      positiveDefinite: best.positiveDefinite ?? null,
      bestRun: best.runId !== undefined && best.nll !== undefined
        ? { runId: best.runId, nll: best.nll, iterations: runSummary?.iterations ?? null }
        : undefined,
    }
  } else {
    summary = existsSync(`${resultsDir}/optimization_summary.txt`)
      ? parseOptimizationSummary(readFileSync(`${resultsDir}/optimization_summary.txt`, 'utf8'))
      : parseOptimizationSummary('')
  }
  const history = existsSync(`${resultsDir}/nll_history.txt`)
    ? parseNllHistoryTail(readFileSync(`${resultsDir}/nll_history.txt`, 'utf8'))
    : parseNllHistoryTail('')
  return { summary, history, files, fitJson }
}
