/**
 * Model selection scores (AIC / BIC) for comparing PWA models.
 *
 * AIC = 2k - 2 lnL, BIC = k ln(N) - 2 lnL, with lnL = -NLL.
 * k = number of free parameters: each floating coupling contributes 2
 * (real + imaginary; the reference amplitude's real/imag are fixed), each
 * floating resonance parameter contributes 1.
 *
 * Comparing trial vs base:
 *   ΔAIC = 2Δk - 2ΔNLL,   ΔBIC = Δk·ln(N) - 2ΔNLL
 * with ΔNLL = NLL_trial - NLL_base (<0 = improved). A trial with ΔAIC/ΔBIC
 * > 0 is disfavoured despite any ΔNLL improvement (complexity penalty).
 *
 * Pure functions; no I/O.
 */
import type { FitJsonView } from './fit-summary.js'

/** Number of free parameters from a fit.json (nCouplingFree = couplings,
 * of which the reference amplitude is fixed; nResFree = free resonance
 * parameters). */
export function freeParamCount(fitJson: FitJsonView | undefined): number | undefined {
  const fit = fitJson?.fit
  if (fit === undefined) return undefined
  const nC = fit.nCouplingFree
  const nR = fit.nResFree
  if (nC === undefined && nR === undefined) return undefined
  return 2 * Math.max((nC ?? 0) - 1, 0) + (nR ?? 0)
}

export interface ModelCompare {
  deltaNll: number | null
  deltaK: number | null
  aicDelta: number | null
  bicDelta: number | null
  /** N used for BIC (data event count proxy); null when unknown. */
  n: number | null
  /** True when BIC (and AIC) favour the trial. */
  favoured: boolean
}

/**
 * Compare a trial model against the base: ΔNLL with AIC/BIC complexity
 * penalties. `n` is the data event count for BIC (use the hdata integral as
 * a proxy when exact counts are unavailable).
 */
export function compareModels(
  base: { nll: number | null; k: number | undefined },
  trial: { nll: number | null; k: number | undefined },
  n: number | null,
): ModelCompare {
  const deltaNll = base.nll !== null && trial.nll !== null ? trial.nll - base.nll : null
  const deltaK = base.k !== undefined && trial.k !== undefined ? trial.k - base.k : null
  let aicDelta: number | null = null
  let bicDelta: number | null = null
  // lnL = -NLL, so Δ(lnL) = -(NLL_t - NLL_b) = -ΔNLL:
  //   ΔAIC = 2Δk - 2·Δ(lnL) = 2Δk + 2ΔNLL
  //   ΔBIC = Δk·ln(N) - 2·Δ(lnL) = Δk·ln(N) + 2ΔNLL
  if (deltaNll !== null && deltaK !== null) {
    aicDelta = 2 * deltaK + 2 * deltaNll
    if (n !== null && n > 0) bicDelta = deltaK * Math.log(n) + 2 * deltaNll
  }
  const favoured = aicDelta !== null && aicDelta < 0 && (bicDelta === null || bicDelta < 0)
  return { deltaNll, deltaK, aicDelta, bicDelta, n, favoured }
}
