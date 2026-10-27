/**
 * auto_pwa_float_policy: suggest whether a resonance's mass/width parameters should
 * be floated (free) and with what bounds. Decision support only — the model
 * makes the final call; validateResonanceAddition still enforces the
 * structural legality of whatever it chooses.
 *
 * Heuristics (physics-grounded, conservative):
 *   - FIRST PASS (default): keep every resonance mass/width fixed at PDG; fit
 *     only the couplings. Floating early can absorb missing waves/topologies
 *     and makes ΔNLL comparisons uninterpretable.
 *   - TUNE mode (`mode: 'tune'`): after the model is stable and a fit shows a
 *     mass pull / free_range boundary, float one state at a time. Wide states
 *     (Gamma > 0.2 GeV) or states near threshold get a width window too.
 *   - ONE (phase-space): the mass parameter does not enter the amplitude
 *     (ctpwa ResModel.cu) — floating it is meaningless.
 *   - Well-measured narrow states (small PDG width): fix.
 *   - Newly added states: fix on the first pass; tune later with a window
 *     within max(0.5*Gamma, 30 MeV) of the PDG mass.
 */
import type { FreeSuggestion, ResonanceEntry, ResonanceProposal } from './types.js'

export interface FreePolicyOptions {
  /** 'first-pass' (default) advises keeping parameters fixed; 'tune' returns
   * concrete free/freeRange suggestions for a later tuning round. */
  mode?: 'first-pass' | 'tune'
  /** Threshold proximity (GeV) that triggers the wide/off-shell policy. Default 0.2. */
  nearThresholdMargin?: number
  /** Mass window = max(massMarginFraction * width, minMassMargin). Default 0.5. */
  massMarginFraction?: number
  /** Minimum mass window, GeV. Default 0.03. */
  minMassMargin?: number
  /** PDG width above which the width is floated too, GeV. Default 0.2. */
  wideWidthThreshold?: number
  /** Width window as a fraction of the PDG width. Default 0.5. */
  widthMarginFraction?: number
  /** Kinematic threshold m_A - m_B for the chain, GeV. */
  threshold?: number
  /** Center windows on the proposal's parameters instead of the PDG values
   * (true when the proposal carries a reference/provenance). Default false. */
  centerOnProposal?: boolean
}

/** Pure decision function; returns a suggestion plus its rationale. */
function suggestFreeTune(
  pdg: ResonanceEntry | undefined,
  proposal: { model: ResonanceProposal['model']; parameters: number[]; name?: string },
  options: FreePolicyOptions = {},
): FreeSuggestion {
  const {
    nearThresholdMargin = 0.2,
    massMarginFraction = 0.5,
    minMassMargin = 0.03,
    wideWidthThreshold = 0.2,
    widthMarginFraction = 0.5,
    threshold,
    centerOnProposal = false,
  } = options

  if (proposal.model === 'ONE') {
    return {
      rationale:
        'ONE is a phase-space term: the barrier factor uses a fixed reference q0 (ctpwa ResModel.cuh oneRefQ0), so the mass placeholder never enters the amplitude — floating it has no effect. Keep it fixed, or omit parameters entirely.',
    }
  }

  // Table-/DSL-driven models (Interp/Custom) and unknown models carry no
  // numeric parameters to float — the payload is `options`. Returning early
  // keeps the PDG-centric logic below free of undefined arithmetic.
  const first = proposal.parameters[0]
  if (!Number.isFinite(first)) {
    return {
      rationale:
        `${proposal.name ?? proposal.model}（model ${proposal.model}）没有可 float 的数值参数` +
        `（Interp/Custom 的载荷在 options 里）——自由参数由 ctpwa 从选项推导，插件不做 float 建议。`,
    }
  }

  const mass = first as number
  const width = proposal.parameters[1]
  // With a reference (provenance), windows center on the proposal's own
  // parameters — they follow the cited experiment, not the PDG average.
  const pdgMass = centerOnProposal ? mass : pdg?.mass ?? mass
  const pdgWidth = pdg?.width

  const widthIsKnown = pdgWidth !== undefined && pdgWidth > 0
  const isNarrow = widthIsKnown && pdgWidth <= 0.05
  const nearThreshold = threshold !== undefined && mass > threshold - nearThresholdMargin
  const isWide = widthIsKnown && pdgWidth > wideWidthThreshold

  // Well-measured narrow state: fix both.
  if (isNarrow && !nearThreshold && !isWide) {
    return {
      rationale:
        `${pdg?.id ?? proposal.name} is a narrow, well-measured state (PDG width ${pdgWidth?.toFixed(4)} GeV). ` +
        'Keep both mass and width fixed; floating them risks degeneracy with the fit.',
    }
  }

  // Default: float the mass first round. Window from the official PDG
  // uncertainty when available (3 sigma), else the width heuristic.
  const massMargin = Math.max(
    pdg?.massError !== undefined ? 3 * pdg.massError : massMarginFraction * (pdgWidth ?? 0.05),
    minMassMargin,
  )
  let massLo = Math.max(pdgMass - massMargin, 0)
  let massHi = pdgMass + massMargin

  const parts: string[] = []

  // Wide or near threshold: also float the width, widen the mass window.
  const floatWidth = isWide || nearThreshold
  if (floatWidth && widthIsKnown) {
    const wMargin = Math.max(widthMarginFraction * pdgWidth, 0.02)
    const widthCenter = centerOnProposal && width !== undefined ? width : pdgWidth
    const widthLo = Math.max(widthCenter - wMargin, 0.001)
    const widthHi = widthCenter + wMargin
    if (nearThreshold && threshold !== undefined) {
      // Off-shell-prone: allow the mass window to reach toward the threshold.
      massHi = Math.max(massHi, threshold - 0.02)
      parts.push(
        `${pdg?.id ?? proposal.name} sits within ${nearThresholdMargin.toFixed(2)} GeV of the kinematic threshold ` +
          `(${threshold.toFixed(4)} GeV): off-shell tails likely, so float both mass and width and extend ` +
          `the mass window toward the threshold`,
      )
    } else {
      parts.push(
        `${pdg?.id ?? proposal.name} has a wide PDG width (${pdgWidth.toFixed(3)} GeV): float both mass and width`,
      )
    }
    return {
      free: [0, 1],
      freeRange: [
        [round3(massLo), round3(massHi)],
        [round3(widthLo), round3(widthHi)],
      ],
      rationale: parts.join('. ') + '.',
    }
  }

  parts.push(
    `${pdg?.id ?? proposal.name}: float the mass within ` +
      `[${round3(massLo)}, ${round3(massHi)}] GeV (PDG ${pdgMass.toFixed(4)} ± ` +
      `${round3(massMargin)}), keep the width fixed at ${width === undefined ? 'PDG value' : round3(width) + ' GeV'} ` +
      'for the first round; float the width only if the fit pushes the mass to a boundary.',
  )
  return { free: [0], freeRange: [[round3(massLo), round3(massHi)]], rationale: parts.join('. ') + '.' }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

/**
 * Default wrapper: the FIRST-PASS advice is to keep every resonance parameter
 * fixed at its PDG value and fit only the couplings. Floating masses/widths in
 * the initial model can absorb missing waves/topologies and makes ΔNLL
 * comparisons less interpretable. Tune later, one state at a time, when a fit
 * shows a mass pull or a free_range boundary; call with `mode: 'tune'` to get
 * the concrete free/freeRange values.
 */
export function suggestFree(
  pdg: ResonanceEntry | undefined,
  proposal: { model: ResonanceProposal['model']; parameters: number[]; name?: string },
  options: FreePolicyOptions = {},
): FreeSuggestion {
  const mode = options.mode ?? 'first-pass'
  const tuned = suggestFreeTune(pdg, proposal, options)
  if (mode === 'tune' || tuned.free === undefined) return tuned
  const ranges: string[] = []
  for (const [i, r] of (tuned.freeRange ?? []).entries()) {
    if (r === undefined) continue
    ranges.push(`${i === 0 ? '质量' : '宽度'} [${r[0]}, ${r[1]}]`)
  }
  return {
    ...(tuned.freeRange !== undefined ? { freeRange: tuned.freeRange } : {}),
    rationale:
      `首轮建议固定：${proposal.name ?? '该态'} 的 mass/width 按 PDG 取值，先只拟合耦合；` +
      `首轮 float 会吸收缺失的波/拓扑，也让 ΔNLL 难解释。` +
      (ranges.length > 0
        ? `若后续拟合出现质量 pull>2σ 或参数撞 free_range 边界，再逐个调节；可选范围 ${ranges.join('、')}。`
        : '') +
      `（需要具体 free/freeRange 时用 mode='tune'。）`,
  }
}
