/**
 * Shared types for the auto-pwa physics knowledge core.
 *
 * Units: all masses and widths are in GeV. Parity is +1 (natural) or -1.
 */

/** Spin-parity quantum numbers. */
export interface JP {
  /** Total angular momentum (non-negative integer or half-integer). */
  j: number
  /** Parity: +1 or -1. */
  p: 1 | -1
}

/** A two-body (or more) decay mode of a resonance. */
export interface DecayMode {
  /** Daughter particle names (PDG-ish; matched via alias normalization). */
  daughters: string[]
  /** Branching fraction if known. */
  br?: number
  /** true when the mode list is not exhaustive (seed data). */
  partial?: boolean
}

/** One entry of the resonance table (data/pdg.json). */
export interface ResonanceEntry {
  /** Canonical id, e.g. "phi(1020)". */
  id: string
  /** Alternative names used by analyses, e.g. "phi1020". */
  aliases: string[]
  jp: JP
  /** GeV. */
  mass: number
  /** GeV. */
  width?: number
  /** PDG mass uncertainty, GeV (pdg-2026 package). */
  massError?: number
  /** PDG width uncertainty, GeV. */
  widthError?: number
  /** "seed": hand-curated approximation; "pdg": authoritative fetch. */
  status: 'seed' | 'pdg'
  tex?: string
  decayModes?: DecayMode[]
}

/** The resonance database as serialized in data/pdg.json. */
export interface ResonanceDb {
  schemaVersion: string
  source: string
  resonances: ResonanceEntry[]
}

/** Query filters for auto_pwa_lookup; fields combine with AND. */
export interface LookupQuery {
  /** Matches id or any alias (normalized). */
  name?: string
  /** Exact spin-parity match. */
  jp?: JP
  /** [lo, hi] GeV, inclusive. */
  massRange?: [number, number]
  /** All listed daughters present in at least one decay mode. */
  decayTo?: string[]
}

/** A particle participating in a decay, e.g. the J/psi or a daughter. */
export interface Particle {
  j: number
  p: 1 | -1
  /** GeV. */
  mass: number
}

/** One allowed intermediate state J^P, with the feasible orbital momenta. */
export interface AllowedJP {
  jp: JP
  /** Orbital angular momenta L (with daughter spin) that satisfy the rules. */
  L: number[]
}

/** Options for decayCheck. */
export interface DecayCheckOptions {
  /** Maximum orbital momentum L to consider (analyses constrain this). */
  maxL?: number
  /** Extra mass slack beyond m_R <= m_A - m_B, for off-shell tails. */
  massTolerance?: number
  /**
   * Requested final-state daughters. When set, each candidate carries a
   * decaysTo flag (whether its listed decay modes include them); flagged
   * candidates sort first. Never a veto: an unlisted mode is a data gap,
   * not a physics exclusion.
   */
  decayTo?: string[]
}

/** One resonance-table candidate for an allowed J^P. */
export interface Candidate {
  entry: ResonanceEntry
  /** Whether listed decay modes include the requested daughters; undefined when no decayTo filter. */
  decaysTo: boolean | undefined
}

/** Result of a decay check A -> R + B. */
export interface DecayCheckResult {
  /** Whether any intermediate state is kinematically/quantum allowed. */
  allowed: AllowedJP[]
  /** Per allowed J^P, the resonance-table candidates below the mass threshold. */
  candidates: { jp: JP; resonances: Candidate[] }[]
}

// ---------------------------------------------------------------------------
// PWA config.yml model (the subset relevant to iteration).
// Mirrors the format consumed by ctpwa (see /home/whitewash/pkgs/ctauto_pwa_0629/src/Config.cu).
// ---------------------------------------------------------------------------

/** Resonance lineshape models supported by ctpwa (Resonance.cu type table). */
export type ResonanceModel = 'BWR' | 'BW' | 'ONE' | 'Flatte'

/** One entry of the config `Resonances:` section. */
export interface ResonanceSpec {
  j: number
  p: 1 | -1
  model: ResonanceModel
  /** BWR/BW: [mass, width(, r)]; ONE: [mass] (placeholder, unused by amplitude); Flatte: [mass, g1, ...]. */
  parameters: number[]
  /** Indices of parameters to float: [0]=mass, [1]=width; [-1] = all. */
  free?: number[]
  /** One [lo, hi] bound per floated parameter. */
  freeRange?: [number, number][]
  tex?: string | string[]
  /** Flatte only: channel thresholds/couplings metadata. */
  channels?: number[][]
}

/** One [J, P] group of an intermediate, listing the resonance names in it. */
export interface JPGroup {
  jp: JP
  names: string[]
}

/** An intermediate (e.g. R_KK) with its allowed J^P groups. */
export interface IntermediateSpec {
  groups: JPGroup[]
}

/** Kinematics of the production decay A -> R + B, derived from DecayChains. */
export interface ChainKinematics {
  /** Mother A. */
  mother: Particle
  /** Non-resonant sibling B. */
  daughter: Particle
  /** m_R <= mother.mass - daughter.mass (on-shell threshold). */
  threshold: number
}

/** Parsed config.yml, as produced by config-edit parseConfig. */
export interface PwaConfig {
  /** The whole document as nested Maps (complex YAML keys preserved). */
  raw: Map<unknown, unknown>
  particles: Record<string, Particle>
  decayChains: Record<string, { intermediates: Record<string, IntermediateSpec> }>
  resonances: Record<string, ResonanceSpec>
  /** Intermediate name -> production kinematics (tightest threshold across chains). */
  kinematics: Record<string, ChainKinematics>
}

// ---------------------------------------------------------------------------
// Resonance addition (resonance-validate / config-edit / float-policy).
// ---------------------------------------------------------------------------

/** A model-proposed resonance addition, fully structured (no free-form YAML). */
export interface ResonanceProposal {
  /** Analysis name, e.g. "phi1680" (must match an id/alias in the PDG table unless model=ONE). */
  name: string
  /** Intermediate to join, e.g. "R_KK". */
  chain: string
  /** [J, P] group of that intermediate to join. */
  jpGroup: JP
  model: ResonanceModel
  parameters: number[]
  free?: number[]
  freeRange?: [number, number][]
  tex?: string
  /** Flatte only. */
  channels?: number[][]
}

/** One structured finding from validation. */
export interface ValidationIssue {
  /** Stable machine-readable code, e.g. "not-on-pdg". */
  code: string
  message: string
}

/** Result of validateResonanceAddition: errors block the edit, warnings do not. */
export interface ValidationResult {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** Float-strategy suggestion for a resonance (float-policy). */
export interface FreeSuggestion {
  free?: number[]
  freeRange?: [number, number][]
  rationale: string
}

/** Result of applying a proposal to a config (config-edit). */
export interface ConfigEditResult {
  config: PwaConfig
  /** Human-readable list of what changed. */
  changed: string[]
  /** Structural errors; when non-empty the config was NOT modified. */
  errors: ValidationIssue[]
}
