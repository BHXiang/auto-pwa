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
  /**
   * mcid-keyed particle table (the PDG Monte-Carlo ID = the community
   * "PDGID": K+ = 321, K- = -321, pi0 = 111, Lambda = 3122, K(S)0 = 310).
   * Added in schema 0.5.0; older files omit it (lookups then return undefined
   * and the tooling falls back to the name-based conjugate table).
   */
  particles?: Record<string, PdgParticleInfo>
}

/**
 * One entry of the PDGID particle table. This is what makes identical /
 * conjugate / self-conjugate decidable from data:
 *   - identical   : same mcid
 *   - conjugate   : `conjugate` (antiparticle mcid; unset for K(S)0/K(L)0)
 *   - self-conj.  : `selfConjugate` (PDG cc_type === 'S')
 *
 * `c` is present ONLY for self-conjugate states — the PDG table also carries
 * spurious C values on charged multiplet members (rho(770)+ -> '-'), so
 * `selfConjugate` is the gate and `c` only carries the value.
 */
export interface PdgParticleInfo {
  /** PDG particle name, e.g. "K+", "pi0", "f_2(1270)0". */
  name: string
  /** PDG charge-conjugation type: 'P' particle, 'A' antiparticle, 'S' self-conjugate. */
  ccType: string
  /** cc_type === 'S': the particle is its own antiparticle. */
  selfConjugate: boolean
  /** Electric charge (PDG unit). */
  charge?: number
  /** Mass in GeV (PDG summary value; absent for states the PDG gives no mass). */
  mass?: number
  /** Total angular momentum (0.5 grid). */
  j?: number
  /** Parity. */
  p?: 1 | -1
  /** Charge conjugation C — self-conjugate states only, when PDG gives a definite value. */
  c?: 1 | -1
  /** G parity — self-conjugate states only, when definite. */
  g?: 1 | -1
  /** Isospin as the PDG string, e.g. "1/2", "1". */
  i?: string
  /** Antiparticle mcid (unset for self-conjugate states and for K(S)0/K(L)0). */
  conjugate?: number
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
  /**
   * PDGID (signed Monte-Carlo ID, e.g. K+ = 321, K- = -321, pi0 = 111),
   * written as `pdgid:` in the config's `Particles` block. Optional: when
   * present it drives identical/conjugate/self-conjugate/C from data instead
   * of the name heuristics; when absent the historical name-based behaviour
   * is preserved. The ctpwa engine ignores an unknown `pdgid` key
   * (ConfigParser::parseParticles reads only J/P/mass/tex/polarization).
   */
  pdgid?: number
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

/** Resonance lineshape models whose parameter structure the plugin knows.
 *
 * BWR/BW/ONE/Flatte/GS carry a propagator or phase-space term with a fixed
 * parameter arity; Interp/Custom are table- and DSL-driven models whose
 * payload lives in `options` (see ResonanceSpec.options) and whose semantics
 * are owned by ctpwa, not by this plugin. */
export type KnownResonanceModel = 'BWR' | 'BW' | 'ONE' | 'Flatte' | 'GS' | 'Interp' | 'Custom'

/** Resonance lineshape model. The open `(string & {})` arm keeps future
 * ctpwa models writable: an unknown model is a WARNING (ctpwa --validate-only
 * decides whether it exists), never a hard error — otherwise a new engine
 * model could not be tried without a plugin release. */
export type ResonanceModel = KnownResonanceModel | (string & {})

/** One entry of the config `Resonances:` section. */
export interface ResonanceSpec {
  /** Explicit J — OPTIONAL, mirroring ctpwa ConfigParser::parseResonances:
   * when omitted, the [J,P] key of the intermediates group governs the quantum
   * numbers. Required for CP-conjugate pairs, where the same state appears
   * with opposite parity in the two chains (e.g. N* → p η is 3/2+ while
   * N̄* → p̄ η is 3/2−), so a single resonance-level J/P cannot describe it. */
  j?: number
  /** Explicit P — see {@link ResonanceSpec.j}; omit together with j. */
  p?: 1 | -1
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
  /** Model-specific payload passed through verbatim to ctpwa (escape hatch):
   * e.g. Interp `{file: "table.dat", method: linear}`, Custom `{expr: "..."}`.
   * The plugin checks only that the key is a mapping; the engine owns the
   * semantics, and the run gate delegates to `ctpwa --validate-only`. */
  options?: Record<string, unknown>
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
  /**
   * The chain carried a `symmetrize` key.
   *
   * ctpwa only ever SKIPS that key (Config.cu 822/860/1320) — it performs no
   * symmetrization — so this flag exists purely so the gate can warn that the
   * key does nothing. Identical daughters are handled by
   * `Constraints.identical` (vertex-level) plus explicit exchanged chains.
   */
  symmetrize?: boolean
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
  /**
   * Defects found while READING the chains — pieces of the file the parser
   * cannot represent, so the model would differ from what the file says.
   *
   * The reader stays total (a broken config must still be inspectable with
   * config_view), and `validateConfig` promotes these to blocking errors: a
   * step with three daughters used to be read as its first two, silently
   * dropping the rest and fitting a WRONG amplitude.
   */
  stepIssues?: ValidationIssue[]
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
  /**
   * Redefine an ALREADY-DEFINED resonance instead of only attaching it.
   *
   * Without this flag, attaching a resonance whose parameters differ is a
   * `param-conflict` (the existing definition wins and the proposal's
   * parameters are ignored); with it the definition is REPLACED by the proposal
   * (parameters/free/free_range/tex/options/channels/reference — anything the
   * proposal omits is dropped, so pass the full intended definition). An
   * explicit resonance-level J/P is preserved: the writer never owns it.
   */
  update?: boolean
  free?: number[]
  freeRange?: [number, number][]
  /** LaTeX label(s) — a plain string, or the multi-segment array form the config
   * stores (e.g. ["K_{2}", "(1980)"]); the writer normalizes to an array. */
  tex?: string | string[]
  /** Flatte only. */
  channels?: number[][]
  /** Model-specific payload passed through verbatim to ctpwa (see
   * ResonanceSpec.options): Interp tables, Custom DSL expressions, … */
  options?: Record<string, unknown>
  /** Provenance (see ResonanceSpec.reference): parameters follow this
   * experiment/paper instead of the PDG average. */
  reference?: string
}

/** Detach (and optionally delete) a resonance — the inverse of an addition.
 *
 * Removal is NAME-level on purpose: a [J,P] group is left in place even when
 * it becomes empty, because group order defines the amplitude-block indices
 * that `Constraints.trans` refers to (appending a group is safe, deleting one
 * would renumber everything after it). The `Resonances.<name>` definition is
 * deleted only once nothing references it any more. */
export interface ResonanceRemoval {
  /** Resonance name as used in the groups / `Resonances:` section. */
  name: string
  /** Restrict to this intermediate (e.g. "R_KK"); omit = every chain. */
  chain?: string
  /** Restrict to this [J,P] group; omit = every group holding the name. */
  jpGroup?: JP
  /** Delete the `Resonances.<name>` definition when it becomes unreferenced.
   * Default true; set false to keep the parameters for later re-attachment. */
  dropDefinition?: boolean
}

/** Result of a removal dry-run (auto_pwa_remove_resonance / loop gates). */
export interface RemovalValidation {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  /** Detached occurrences, e.g. "chain1.R_KK [1-]". */
  detached: string[]
  /** Whether the Resonances entry itself will be deleted. */
  definitionDropped: boolean
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

// ---------------------------------------------------------------------------
// Initial config authoring (auto_pwa_init_config) — build a config.yml from
// scratch out of a structured spec, then hand it to a human for review.
// ---------------------------------------------------------------------------

/** One particle of the initial `Particles` block. */
export interface InitialParticleSpec {
  /** Analysis name (the config key, e.g. "Kp", "pi01"). Must be unique. */
  name: string
  /**
   * PDGID (signed Monte-Carlo id, e.g. K+ = 321, pi0 = 111). Strongly
   * recommended: it drives identical/conjugate/self-conjugate/C checks.
   * When omitted, j/p/mass must be given.
   */
  pdgid?: number
  /** Total angular momentum; defaults to the PDG value when pdgid is given. */
  j?: number
  /** Parity; defaults to the PDG value when pdgid is given. */
  p?: 1 | -1
  /** GeV; defaults to the PDG value when pdgid is given. */
  mass?: number
  /** Explicit C, for states where the config wants to override the PDG value. */
  c?: 1 | -1
  /** LaTeX label (optional). */
  tex?: string
}

/** One two-body decay step (mother -> d1 + d2) of an initial chain. */
export interface InitialDecayStepSpec {
  /** Mother: a Particles name (production) or an intermediate name (cascade). */
  mother: string
  daughters: [string, string]
  /** (2S+1, L) whitelist, ctpwa internal notation. */
  sl?: [number, number][]
  /** Weak-decay parity breaking (ctpwa p_break). */
  pBreak?: boolean
  /** Barrier-factor switch / range (ctpwa has_bf / bf_d). */
  hasBf?: boolean | [boolean, boolean]
  bfD?: number | [number, number]
}

/** One intermediate (e.g. R_KK) with its allowed [J,P] groups. */
export interface InitialIntermediateSpec {
  name: string
  /**
   * The intermediate's [J,P] groups IN ORDER — the order fixes the amplitude
   * block index used by `Constraints.trans`, so it must not be reordered.
   * Resonances are attached separately via `InitialConfigSpec.resonances`
   * (every one of them passes the physics gate).
   */
  groups: JP[]
}

/** One decay chain of the initial config. */
export interface InitialChainSpec {
  /** Chain name, e.g. "decay1". */
  name: string
  /** All two-body steps: production (mother in Particles) + cascades. */
  steps: InitialDecayStepSpec[]
  /** Intermediates and their [J,P] groups (group order = amplitude index). */
  intermediates: InitialIntermediateSpec[]
}

/** `Data` block: order + one file spec per sample. `[dat, path]` or `[ROOT, path, TTree, ...branches]`. */
export interface InitialDataSpec {
  order: string[]
  /** REQUIRED: the data sample. */
  data: unknown[]
  /** REQUIRED for a normalised fit: phase-space MC. */
  phsp?: unknown[]
  /** Optional: no-efficiency MC truth (enables fit fractions). */
  phspTruth?: unknown[]
  /** Optional: background sample. */
  bkg?: unknown[]
  /** Optional: per-event background weights. */
  bkgWeights?: unknown[]
}

/** One `Plot` entry (ctpwa expr/expression format). */
export interface InitialPlotSpec {
  name?: string
  expression: string | string[]
  bins?: number[]
  ranges?: [number, number][]
  display?: string[]
}

/** One resonance to attach to an intermediate [J,P] group. */
export interface InitialResonanceSpec {
  name: string
  /** Intermediate name this resonance is attached to (e.g. "R_KK"). */
  chain: string
  jpGroup: JP
  model: ResonanceModel
  parameters: number[]
  free?: number[]
  freeRange?: [number, number][]
  tex?: string
  channels?: number[][]
  /** Model-specific payload passed through verbatim to ctpwa (see
   * ResonanceSpec.options). */
  options?: Record<string, unknown>
  reference?: string
}

/** A full from-scratch config proposal (structured — never free-form YAML). */
export interface InitialConfigSpec {
  particles: InitialParticleSpec[]
  chains: InitialChainSpec[]
  resonances?: InitialResonanceSpec[]
  /** Constraints written verbatim (identical/trans/maxL/bf_d/...). */
  constraints?: PwaConstraints
  data: InitialDataSpec
  plot?: InitialPlotSpec[]
  /** Optional root key `precision: auto|hybrid|float|double`. */
  precision?: string
}

/** Result of building an initial config: text + parsed views + diagnostics. */
export interface InitialConfigResult {
  /** Rendered YAML (`dumpConfig`), undefined when errors is non-empty. */
  text?: string
  /** Parsed views of the rendered text (round-trip verified). */
  config?: PwaConfig
  changed: string[]
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}
