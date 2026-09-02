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
  /**
   * Charge conjugation C: +1/-1 for self-conjugate states only.
   * Absent (undefined) = C not defined (charged or non-C eigenstate);
   * never invent a C for those.
   */
  c?: 1 | -1
}

/** J^PC: a JP with (possibly undefined) charge conjugation. */
export type JPC = JP

/**
 * One (S, L) partial wave of a two-body step. **S is stored in the 2S+1
 * multiplicity notation**, matching ctpwa config `sl` whitelist entries and
 * Amp2BD::ComSL output (see src/jpc.ts).
 */
export interface SL {
  /** 2S+1 (multiplicity; odd positive integer). */
  s: number
  /** Orbital angular momentum (non-negative integer). */
  l: number
}

/** One J^PC value with the (S, L) waves that realize it at a decay vertex. */
export interface JPCWave {
  jpc: JPC
  /** (S, L) waves (2S+1 notation), sorted. */
  sl: SL[]
}

/** Result of an isobar J^PC check A -> d1 d2 d3 with R = (di dj). */
export interface IsobarCheck {
  /** Intermediate name, e.g. "R_KK". */
  isobarName: string
  /** The daughter pair realizing the isobar. */
  pair: [string, string]
  /** Whether the pair members are in the same Constraints.identical group. */
  identical: boolean
  /** Whether C is well-defined for the pair (conjugate pair or identical group). */
  cDefined: boolean
  /** Decay-vertex J^PC full set (R -> d1 + d2). */
  decayVertex: JPCWave[]
  /** Production-vertex allowed J^P (A -> R + spectator). */
  production: AllowedJP[]
  /** C required by C(A) = C(R)·C(B); undefined when A or B has no C. */
  cRequired?: 1 | -1
  /** Intersection of the two vertices (with C conservation when applicable). */
  allowed: JPCWave[]
  /** Waves with allowed J^P but violating C conservation (diagnostic). */
  cBlocked: JPCWave[]
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

/** One individual experimental measurement (pdg-2026 mass_measurements). */
export interface MeasurementEntry {
  /** Publication year (0/absent when unknown). */
  year?: number
  /** Publication short name, e.g. "PPN 56 405". */
  publication?: string
  doi?: string
  inspireId?: number
  technique?: string
  comment?: string
  /** Measured mass, GeV. */
  value?: number
  errorPositive?: number
  errorNegative?: number
  statError?: number
  systError?: number
  /** Whether this measurement entered the PDG average. */
  usedInAverage?: boolean
}

/** One entry of the resonance table (data/pdg.json). */
export interface ResonanceEntry {
  /** Canonical id, e.g. "phi(1020)". */
  id: string
  /** Alternative names used by analyses, e.g. "phi1020". */
  aliases: string[]
  jp: JP
  /** Charge conjugation C (+1/-1) — only for self-conjugate states (pdg-2026 quantum_c, charge 0). */
  c?: 1 | -1
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
  /** Individual mass measurements (newest first; from the pdg-2026 package). */
  measurements?: MeasurementEntry[]
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
  /** Exact J^PC match: when `c` is set, entries without a defined C do not match. */
  jpc?: JPC
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
  /** C (self-conjugate states only; filled from the PDG table where known). */
  c?: 1 | -1
  /** Antiparticle name if this particle has a distinct one (conjugate-pair table). */
  conjugate?: string
  /** Whether this is a fermion (half-integer spin). */
  fermion?: boolean
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
// Mirrors the format consumed by ctpwa (see ctpwa's src/Config.cu).
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
  /** Provenance: parameters follow this experiment/paper instead of the PDG
   * average (e.g. a DOI, "BESIII 2024", or a free-text citation). When set,
   * the write gate skips the PDG-average agreement checks. */
  reference?: string
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
  /** Mother name (config Particles key, e.g. "Jpsi") — for C lookups. */
  motherName?: string
  /** Sibling name (config Particles key, e.g. "eta"). */
  daughterName?: string
}

/** One two-body decay step of a chain (decay vertex R -> d1 + d2). */
export interface DecayStep {
  /** Mother of this step (particle or intermediate name). */
  mother: string
  daughters: [string, string]
  /** (2S+1, L) whitelist from the per-step `sl` opts; undefined = no filter. */
  sl?: [number, number][]
  /** Per-step parity-breaking flag (`p_break`; weak decays). */
  pBreak?: boolean
  /** Per-step barrier-factor switch (`has_bf`); may be per daughter. */
  hasBf?: boolean | [boolean, boolean]
  /** Per-step barrier-factor range (`bf_d`); may be per daughter. */
  bfD?: number | [number, number]
}

/** Parsed `Constraints` section of config.yml (subset relevant to validation). */
export interface PwaConstraints {
  /** `identical`: groups of identical-particle names (e.g. [[pi01, pi02]]). */
  identical?: string[][]
  /** `trans`: amplitude couplings, e.g. [{names: [R_Keta_0, R_Keta_1], value: [-1]}]. */
  trans?: { names: string[]; value: number[] }[]
  /** `maxL`: global orbital-momentum cap. */
  maxL?: number
  /** `bf_d`: global barrier-factor range. */
  bfD?: number
  /** `has_bf`: global barrier-factor switch. */
  hasBf?: boolean
  /** `fix_var`: {paramName: value} fixed named parameters. */
  fixVar?: Record<string, number>
  /** `free_var`: names released from fix_var. */
  freeVar?: string[]
  /** `var_range`: {paramName: [lo, hi]} fit ranges. */
  varRange?: Record<string, [number, number]>
  /** `var_equal`: groups of parameters sharing one slot. */
  varEqual?: string[][]
  /** `gauss_constr`: {paramName: sigma} Gaussian penalties. */
  gaussConstr?: Record<string, number>
}

/** One chain of a parsed config. */
export interface ChainSpec {
  intermediates: Record<string, IntermediateSpec>
  /** Decay steps in order (production first, then intermediate decays). */
  steps: DecayStep[]
}

/** Parsed config.yml, as produced by config-edit parseConfig. */
export interface PwaConfig {
  /** The whole document as nested Maps (complex YAML keys preserved). */
  raw: Map<unknown, unknown>
  particles: Record<string, Particle>
  decayChains: Record<string, ChainSpec>
  resonances: Record<string, ResonanceSpec>
  /** Intermediate name -> production kinematics (tightest threshold across chains). */
  kinematics: Record<string, ChainKinematics>
  /** Parsed Constraints section. */
  constraints: PwaConstraints
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
  /** Provenance (see ResonanceSpec.reference): parameters follow this
   * experiment/paper instead of the PDG average. */
  reference?: string
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
