/**
 * auto_pwa_float_policy: suggest whether a resonance's mass/width parameters should
 * be floated (free) and with what bounds. Decision support only — the model
 * makes the final call; validateResonanceAddition still enforces the
 * structural legality of whatever it chooses.
 *
 * Heuristics (physics-grounded, conservative):
 *   - ONE (phase-space): the mass parameter does not enter the amplitude
 *     (ctpwa ResModel.cu) — floating it is meaningless.
 *   - Well-measured narrow states (small PDG width): fix.
 *   - Newly added states: float the mass first round, within
 *     max(0.5*Gamma, 30 MeV) of the PDG mass.
 *   - Wide states (Gamma > 0.2 GeV) or states near the kinematic threshold:
 *     also float the width, and widen the mass window toward the threshold.
 *   - A state at/near threshold is off-shell-prone: widen the window.
 */
import type { FreeSuggestion, ResonanceEntry, ResonanceProposal } from './types.js'

export interface FreePolicyOptions {
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
}

/** Pure decision function; returns a suggestion plus its rationale. */
export function suggestFree(
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
  } = options

  if (proposal.model === 'ONE') {
    return {
      rationale:
        'ONE is a phase-space term: the mass parameter does not enter the amplitude (ctpwa ResModel.cu), so floating it has no effect. Keep it fixed.',
    }
  }

  const mass = proposal.parameters[0]
  const width = proposal.parameters[1]
  const pdgMass = pdg?.mass ?? mass
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
    const widthLo = Math.max(pdgWidth - wMargin, 0.001)
    const widthHi = pdgWidth + wMargin
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
