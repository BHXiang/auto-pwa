/**
 * auto_pwa_diagnose: turn results/fit.json into actionable hypotheses.
 *
 * Reads the structured aifit output (FitJsonView from fit-summary.ts) and
 * produces a ranked list of diagnosis items with concrete suggestions —
 * the decision-layer input the model uses to pick the next step.
 *
 * Pure functions; no I/O.
 */
import type { FitJsonView } from './fit-summary.js'
import type { PwaConfig } from './types.js'

export interface DiagnosisItem {
  severity: 'info' | 'warn' | 'danger'
  code: string
  message: string
  suggestion?: string
}

export interface DiagnoseOptions {
  /** |ρ| above which a parameter pair is flagged; default 0.8. */
  correlationThreshold?: number
  /** Max flagged pairs; default 6. */
  maxCorrelationPairs?: number
}

/** Is this correlation-matrix row a resonance (physical) parameter name? */
function isResonanceParamName(name: string): boolean {
  return !name.startsWith('Re(') && !name.startsWith('Im(')
}

/** A resonance's chain/group context from the config (for removal suggestions). */
function resonanceContext(config: PwaConfig | undefined, name: string): string | undefined {
  if (config === undefined) return undefined
  for (const [chainName, chain] of Object.entries(config.decayChains)) {
    for (const [intName, int] of Object.entries(chain.intermediates)) {
      for (const g of int.groups) {
        if (g.names.includes(name)) return `${chainName}.${intName} [${g.jp.j}${g.jp.p > 0 ? '+' : '-'}]`
      }
    }
  }
  return undefined
}

type InterferenceView = NonNullable<NonNullable<FitJsonView['fit']>['interference']>

/**
 * R = (sum of the interference-matrix diagonal) / totalIntensity.
 *
 * Diagonal element i is the intensity of wave i while totalIntensity is the
 * intensity of the coherent sum, so R >> 1 means the solution is built from
 * large mutually-cancelling amplitudes (a degenerate, unphysical minimum that
 * can still post a lower NLL). Returns undefined on any missing/malformed/
 * non-finite input so callers emit nothing rather than a bogus ratio.
 *
 * Only the matrix diagonal is used. `fractions` is deliberately NOT used as a
 * fallback: fit-summary.ts types it as a plain wave/branch fraction with no
 * guarantee that it is normalized as diag/total, so substituting it would be
 * unproven (see the report accompanying this change).
 */
function waveCancellationRatio(inter: InterferenceView): number | undefined {
  const total = inter.totalIntensity
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined
  const matrix = inter.matrix
  if (!Array.isArray(matrix) || matrix.length === 0) return undefined
  const n = matrix.length
  let diagSum = 0
  for (let i = 0; i < n; i++) {
    const row = matrix[i]
    if (!Array.isArray(row) || row.length !== n) return undefined // non-square
    for (let j = 0; j < n; j++) {
      const entry = row[j]
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined // non-finite entry
    }
    diagSum += row[i]!
  }
  if (!Number.isFinite(diagSum)) return undefined // overflowed diag sum
  return diagSum / total
}

/**
 * Tolerance for "sits exactly on an analysis-supplied bound": the larger of
 * absolute 1e-9 and relative 1e-9 (float comparison, never string equality).
 */
function onBoundTolerance(bound: number): number {
  return Math.max(1e-9, Math.abs(bound) * 1e-9)
}

/** True when `value` is numerically pinned to `bound` within the tolerance. */
function isPinnedTo(value: number, bound: number): boolean {
  return Number.isFinite(value) && Number.isFinite(bound) && Math.abs(value - bound) <= onBoundTolerance(bound)
}

/** Compact number label that keeps enough digits to expose an exact-bound hit. */
function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return String(Number(x.toPrecision(10)))
}

/**
 * Diagnose one fit result. `fitJson` comes from results/fit.json (may be
 * partial); `config` is optional context for naming suggestions.
 */
export function diagnoseFit(fitJson: FitJsonView, config?: PwaConfig, options: DiagnoseOptions = {}): DiagnosisItem[] {
  const out: DiagnosisItem[] = []
  const corrThreshold = options.correlationThreshold ?? 0.8
  const maxCorrPairs = options.maxCorrelationPairs ?? 6
  const fit = fitJson.fit
  if (fit === undefined || fit.best === undefined) {
    out.push({
      severity: 'danger',
      code: 'no-best-fit',
      message: 'fit.json 没有 best 结果（拟合可能全部失败）',
      suggestion: '查看 runSummaries 的错误字段；修正 config 或资源问题后重跑',
    })
    return out
  }
  const best = fit.best

  if (best.positiveDefinite === false) {
    out.push({
      severity: 'danger',
      code: 'hessian-indefinite',
      message: 'best run 的 Hessian 不是正定的 —— 误差与显著性不可信',
      suggestion: '先处理撞边界/退化参数，或增加拟合运行次数后重拟合',
    })
  }

  // Wave-cancellation ratio (matrix diagonal / total intensity): R >> 1 means
  // the coherent sum is built from large mutually-cancelling amplitudes — a
  // degenerate minimum that can look better in NLL without being physical.
  const inter = fit.interference
  if (inter !== undefined && inter.available === true) {
    const ratio = waveCancellationRatio(inter)
    if (ratio !== undefined && ratio >= 1.5) {
      const danger = ratio >= 3
      out.push({
        severity: danger ? 'danger' : 'warn',
        code: 'wave-cancellation',
        message: `分波强度之和/总强度 R=${ratio.toFixed(2)}（总强度 ${fmtNum(inter.totalIntensity!)}）—— 拟合由大振幅相消构成`,
        suggestion: danger
          ? '该解是相消假象：各分波强度之和远超相干总强度，这个 NLL 不可信 —— 应减少/合并分波或重新拟合，不要据此宣称改进'
          : '各分波强度之和明显大于总强度，存在较强相消 —— 检查是否有多余的大振幅分波在互相抵消',
      })
    }
  }

  // Resonance parameters at boundaries -> the resonance may be redundant.
  // A value pinned *exactly* on an analysis-supplied bound is a stronger
  // statement than the generic atBoundary flag (it is not a measurement), so
  // it gets its own item, emitted before the generic one for the same param.
  for (const p of best.params ?? []) {
    if (p.kind !== 'resonance') continue
    const where = resonanceContext(config, p.name)
    const value = p.value
    if (typeof value === 'number' && Number.isFinite(value)) {
      const onLower = typeof p.lower === 'number' && isPinnedTo(value, p.lower)
      const onUpper = typeof p.upper === 'number' && isPinnedTo(value, p.upper)
      if (onLower || onUpper) {
        const boundName = onLower && onUpper ? '下限/上限' : onLower ? '下限' : '上限'
        const bound = onLower ? p.lower : p.upper
        const lo = typeof p.lower === 'number' ? fmtNum(p.lower) : '-∞'
        const hi = typeof p.upper === 'number' ? fmtNum(p.upper) : '+∞'
        out.push({
          severity: 'warn',
          code: 'param-exact-boundary',
          message: `${p.name}${where !== undefined ? `（${where}）` : ''} 拟合值 ${fmtNum(value)} 精确落在${boundName} ${fmtNum(bound!)}（区间 [${lo}, ${hi}]）—— 这不是测量值`,
          suggestion: '该值被钉在分析设定的边界上：不应带误差引用为测量结果 —— 应放宽该参数的 free_range、把它固定，或移除对应共振态',
        })
      }
    }
    if (p.atBoundary === true) {
      out.push({
        severity: 'warn',
        code: 'param-at-boundary',
        message: `${p.name}${where !== undefined ? `（${where}）` : ''} 参数 ${p.value?.toFixed(4)} GeV 撞在边界 [${p.lower}, ${p.upper}]`,
        suggestion: '该共振态可能冗余或线形不对：考虑移除、换模型（如 Flatte），或放宽 free_range 重拟合',
      })
    }
  }

  // Fractions: fraction/error < 2 -> insignificant amplitude.
  const fractions = best.fitFractions ?? []
  for (const f of fractions) {
    if (f.error === undefined || f.error === null || f.error === 0) continue
    const sig = Math.abs(f.fraction) / f.error
    if (sig < 2) {
      out.push({
        severity: 'warn',
        code: 'insignificant-amplitude',
        message: `${f.amplitude} 份额 ${(f.fraction * 100).toFixed(1)}% ± ${(f.error * 100).toFixed(1)}% （significance ${sig.toFixed(1)}σ < 2σ）`,
        suggestion: '该分波对拟合无显著贡献 —— 移除后 ΔNLL 预计 < 3，可考虑删除以简化模型',
      })
    } else if (sig > 6) {
      out.push({
        severity: 'info',
        code: 'dominant-amplitude',
        message: `${f.amplitude} 份额 ${(f.fraction * 100).toFixed(1)}% ± ${(f.error * 100).toFixed(1)}% （${sig.toFixed(1)}σ，主导分波）`,
      })
    }
  }

  // Interference hotspots.
  if (inter !== undefined && inter.available && (inter.topInterference ?? []).length > 0) {
    const top = inter.topInterference!.slice(0, 3)
    for (const t of top) {
      if (Math.abs(t.value) > 0.2) {
        out.push({
          severity: 'warn',
          code: 'strong-interference',
          message: `${t.pair[0]} <-> ${t.pair[1]} 干涉 ${(t.value * 100).toFixed(0)}%`,
          suggestion: '强干涉对通常需要独立的耦合参数 —— 检查两分波是否共享耦合，必要时拆开',
        })
      }
    }
  } else if (inter !== undefined && !inter.available) {
    out.push({
      severity: 'info',
      code: 'interference-unavailable',
      message: `干涉矩阵不可用: ${inter.reason ?? 'unknown'}`,
    })
  }

  // Parameter correlation pairs from the Hessian inversion: |ρ| > threshold
  // means the two parameters cannot be determined independently — a
  // degeneracy the fit is silently trading against.
  const corr = best.correlation
  if (corr !== undefined && corr.names.length === corr.matrix.length && corr.names.length > 0) {
    const pairs: { a: string; b: string; rho: number; aRes: boolean; bRes: boolean }[] = []
    for (let i = 0; i < corr.names.length; i++) {
      const row = corr.matrix[i]!
      for (let j = i + 1; j < corr.names.length; j++) {
        const rho = row[j]
        if (Number.isFinite(rho) && Math.abs(rho) >= corrThreshold) {
          pairs.push({
            a: corr.names[i]!,
            b: corr.names[j]!,
            rho,
            aRes: isResonanceParamName(corr.names[i]!),
            bRes: isResonanceParamName(corr.names[j]!),
          })
        }
      }
    }
    pairs.sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho))
    for (const p of pairs.slice(0, maxCorrPairs)) {
      const bothRes = p.aRes && p.bRes
      out.push({
        severity: 'warn',
        code: 'parameter-correlation',
        message: `${p.a} ↔ ${p.b} 相关系数 ρ=${p.rho > 0 ? '+' : ''}${p.rho.toFixed(2)}`,
        suggestion: bothRes
          ? '两个共振态参数强相关（简并）：数据无法独立确定它们 —— 考虑固定其中一个、合并为单一态，或改线形模型'
          : '该参数对强相关：模型存在退化方向 —— 考虑固定冗余参数或拆开共享耦合',
      })
    }
  }

  for (const w of fit.warnings ?? []) {
    out.push({ severity: 'info', code: 'fit-warning', message: w })
  }

  if (best.nll !== undefined) {
    out.push({
      severity: 'info',
      code: 'nll',
      message: `最佳 NLL = ${best.nll.toFixed(2)}（${fit.runs ?? '?'} 次运行，${fit.maxIter ?? '?'} max-iter）`,
    })
  }
  return out
}
