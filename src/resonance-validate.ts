/**
 * auto_pwa_resonance_validate: programmatic gate for adding a resonance to a PWA
 * config. Errors block the edit; warnings inform the model's decision.
 *
 * Hard rules (errors):
 *   1. model is one of ctpwa's supported types (BWR/BW/ONE/Flatte)
 *   2. PDG backing: BWR/BW/Flatte names must hit data/pdg.json.
 *      ONE (phase-space term) is exempt — its amplitude is the barrier
 *      factor only and the mass parameter is a placeholder (ctpwa
 *      Resonance.cu), so it is not a particle claim.
 *   3. JPC consistency: (J,P) of the proposal must equal the PDG entry's.
 *   4. Kinematic threshold: m_R <= m_A - m_B (+ tolerance) for the chain.
 *   5. No duplicate (name or normalized alias already in config).
 *   6. The [J,P] group must exist in the chain's intermediates.
 *   7. Parameter structure per model (ctpwa parses parameters as a plain
 *      double vector — wrong length crashes the fit).
 *   8. Mass agrees with PDG within tolerance.
 *   9. free/free_range structure legal; initial values inside ranges.
 *
 * Pure function; no I/O.
 */
import { normalizeName } from './lookup.js'
import { hasDecayTo, allowedIntermediateJP } from './decay-check.js'
import type {
  ChainKinematics,
  JP,
  PwaConfig,
  ResonanceDb,
  ResonanceModel,
  ResonanceProposal,
  ValidationIssue,
  ValidationResult,
} from './types.js'

/** ctpwa's resonance model table (Resonance.cu: model -> ResModelType). */
export const RESONANCE_MODELS: readonly ResonanceModel[] = ['BWR', 'BW', 'ONE', 'Flatte']

/** Models with a real propagator: must have PDG backing and kinematics checks. */
const PARTICLE_MODELS: readonly ResonanceModel[] = ['BWR', 'BW', 'Flatte']

/** Parameter arity constraints per model (ctpwa Resonance constructor). */
const PARAM_ARITY: Record<ResonanceModel, { min: number; max?: number }> = {
  BWR: { min: 2 }, // [mass, width(, r)]
  BW: { min: 2 }, // [mass, width]
  ONE: { min: 1, max: 1 }, // [mass] placeholder
  Flatte: { min: 2 }, // [mass, g1, ...]
}

export interface ValidateOptions {
  /** Extra slack beyond m_R <= m_A - m_B for off-shell tails, GeV. */
  massTolerance?: number
  /** PDG mass agreement tolerance, GeV. Default max(0.020, 0.5 * width). */
  massAgreementTolerance?: number
  /** Threshold proximity that triggers the off-shell warning, GeV. Default 0.2. */
  nearThresholdMargin?: number
  /** Width deviation fraction for the warning. Default 0.5. */
  widthDeviationFraction?: number
  /** Final-state daughters for the decay-mode warning, e.g. ['K+', 'eta']. */
  decayTo?: string[]
  /** Group size above which the crowded-group warning fires. Default 6. */
  crowdedGroupSize?: number
  /** Mass window (GeV) for the overlapping-mass warning. Default 0.05. */
  overlapWindow?: number
  /** Max orbital momentum for the J^P reachability gate. Default 4. */
  maxL?: number
}

/** The config surface validation reads (PwaConfig subset). */
export interface ValidationConfig {
  resonances: Record<string, { j: number; p: 1 | -1; parameters: number[] }>
  decayChains?: PwaConfig['decayChains']
  kinematics: Record<string, ChainKinematics>
}

const err = (code: string, message: string): ValidationIssue => ({ code, message })
const warn = err

/**
 * Validate a model-proposed resonance addition against the PDG table and the
 * current config. `config` is the parsed config.yml (config-edit parseConfig).
 */
export function validateResonanceAddition(
  db: ResonanceDb,
  config: ValidationConfig,
  proposal: ResonanceProposal,
  options: ValidateOptions = {},
): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const {
    massTolerance = 0,
    nearThresholdMargin = 0.2,
    widthDeviationFraction = 0.5,
    crowdedGroupSize = 6,
    overlapWindow = 0.05,
    decayTo,
  } = options

  // --- 1. model type -------------------------------------------------------
  if (!RESONANCE_MODELS.includes(proposal.model)) {
    errors.push(err('invalid-model', `model "${proposal.model}" is not supported (${RESONANCE_MODELS.join('/')})`))
    return { ok: false, errors, warnings }
  }
  const isParticle = PARTICLE_MODELS.includes(proposal.model)
  const arity = PARAM_ARITY[proposal.model]

  // --- 7. parameter structure (early, cheap; blocks everything else) -------
  if (!Number.isFinite(proposal.parameters[0]) || proposal.parameters[0] <= 0) {
    errors.push(err('invalid-parameters', 'parameters[0] (mass) must be a positive number'))
  }
  if (proposal.parameters.length < arity.min) {
    errors.push(err('invalid-parameters', `${proposal.model} needs >= ${arity.min} parameters, got ${proposal.parameters.length}`))
  } else if (arity.max !== undefined && proposal.parameters.length > arity.max) {
    errors.push(err('invalid-parameters', `${proposal.model} takes exactly ${arity.max} parameter(s), got ${proposal.parameters.length}`))
  }
  if (proposal.model === 'BWR' && proposal.parameters.length >= 2 && proposal.parameters[1] < 0) {
    errors.push(err('invalid-parameters', 'BWR width (parameters[1]) must be >= 0'))
  }
  if (proposal.model === 'Flatte' && !proposal.channels) {
    errors.push(err('flatte-needs-channels', 'Flatte model requires the channels field'))
  }

  // --- 9. free/free_range structure ----------------------------------------
  const free = proposal.free ?? []
  const freeRange = proposal.freeRange ?? []
  const freeAll = free.includes(-1)
  const freeIndexes = freeAll ? proposal.parameters.map((_, i) => i) : free
  for (const idx of freeIndexes) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= proposal.parameters.length) {
      errors.push(err('invalid-free', `free index ${idx} out of range for ${proposal.parameters.length} parameters`))
    }
  }
  if (freeRange.length !== 0 && freeRange.length !== (freeAll ? proposal.parameters.length : free.length)) {
    errors.push(err('invalid-free', `free_range has ${freeRange.length} entries but free has ${freeAll ? proposal.parameters.length : free.length}`))
  }
  for (const [i, [lo, hi]] of freeRange.entries()) {
    const idx = freeAll ? i : free[i]
    if (!(lo < hi)) {
      errors.push(err('invalid-free', `free_range[${i}] must satisfy lo < hi, got [${lo}, ${hi}]`))
      continue
    }
    if (idx >= 0 && idx < proposal.parameters.length) {
      const v = proposal.parameters[idx]
      if (!(v >= lo && v <= hi)) {
        errors.push(err('invalid-free', `initial parameter[${idx}] = ${v} lies outside free_range [${lo}, ${hi}]`))
      }
    }
  }

  // --- PDG lookup (particle models only) -----------------------------------
  const pdgHits = isParticle ? db.resonances.filter((r) => normalizeName(r.id) === normalizeName(proposal.name) || r.aliases.some((a) => normalizeName(a) === normalizeName(proposal.name))) : []
  const pdg = pdgHits[0]

  // --- 2. PDG backing ------------------------------------------------------
  if (isParticle && !pdg) {
    errors.push(
      err(
        'not-on-pdg',
        `"${proposal.name}" is not in the PDG table. New particles not on PDG are rejected; ` +
          `only ONE (phase-space) terms may use analysis-invented names (e.g. NR1_KK).`,
      ),
    )
  }

  // --- 3. JPC consistency --------------------------------------------------
  if (isParticle && pdg && !sameJp(pdg.jp, proposal.jpGroup)) {
    errors.push(
      err(
        'jpc-mismatch',
        `PDG gives ${proposal.name} J^P = ${jpLabel(pdg.jp)}, but the proposal targets ${jpLabel(proposal.jpGroup)}`,
      ),
    )
  }

  // --- 8. mass agreement with PDG ------------------------------------------
  if (isParticle && pdg) {
    // Tolerance from the official PDG uncertainty when available (3 sigma,
    // floored at 20 MeV); falls back to the width heuristic for seed entries.
    const tol =
      options.massAgreementTolerance ??
      Math.max(pdg.massError !== undefined ? 3 * pdg.massError : 0, 0.02, 0.5 * (pdg.width ?? 0.05))
    if (Math.abs(proposal.parameters[0] - pdg.mass) > tol) {
      errors.push(
        err(
          'mass-mismatch',
          `proposed mass ${proposal.parameters[0].toFixed(4)} GeV deviates from PDG ${pdg.mass.toFixed(4)} GeV ` +
            `by more than ${tol.toFixed(4)} GeV`,
        ),
      )
    }
  }

  // --- 4. kinematic threshold ----------------------------------------------
  const kin = config.kinematics[proposal.chain]
  if (!kin) {
    errors.push(err('unknown-chain', `no production kinematics for intermediate "${proposal.chain}"`))
  } else if (isParticle) {
    const threshold = kin.threshold + massTolerance
    if (proposal.parameters[0] > threshold) {
      errors.push(
        err(
          'above-threshold',
          `${proposal.name}: m = ${proposal.parameters[0].toFixed(4)} GeV exceeds the kinematic threshold ` +
            `${kin.threshold.toFixed(4)} GeV (m_${proposal.chain} <= m_mother - m_daughter)`,
        ),
      )
    } else if (proposal.parameters[0] > threshold - nearThresholdMargin) {
      warnings.push(
        warn(
          'near-threshold',
          `${proposal.name} sits within ${nearThresholdMargin.toFixed(2)} GeV of the kinematic threshold ` +
            `(${kin.threshold.toFixed(4)} GeV): off-shell tails possible — consider floating its mass`,
        ),
      )
    }
  }

  // --- 5. duplicate / attach-already-defined ------------------------------
  const chainGroup_ = findGroup(config, proposal.chain, proposal.jpGroup)
  if (chainGroup_ && chainGroup_.names.includes(proposal.name)) {
    errors.push(err('duplicate', `"${proposal.name}" is already in ${proposal.chain} [${jpLabel(proposal.jpGroup)}]`))
  }
  const existing = config.resonances[proposal.name]
  if (existing !== undefined) {
    // Attaching a resonance that is already defined (e.g. a reserve wave):
    // legal when JP and parameters agree; the edit then only links the chain.
    if (existing.j !== proposal.jpGroup.j || existing.p !== proposal.jpGroup.p) {
      errors.push(
        err(
          'jpc-conflict',
          `"${proposal.name}" is already defined with J^P ${existing.j}${existing.p > 0 ? '+' : '-'} but the ` +
            `proposal targets ${jpLabel(proposal.jpGroup)} — attach it under its defined J^P or rename`,
        ),
      )
    } else if (
      existing.parameters.length !== proposal.parameters.length ||
      existing.parameters.some((v, i) => Math.abs(v - proposal.parameters[i]) > 1e-6)
    ) {
      errors.push(
        err(
          'param-conflict',
          `"${proposal.name}" is already defined with parameters ${JSON.stringify(existing.parameters)}; ` +
            `to attach it, pass the same parameters (or omit them)`,
        ),
      )
    } else {
      warnings.push(
        warn(
          'already-defined',
          `"${proposal.name}" is already defined in the config — this edit will ATTACH it to ` +
            `${proposal.chain} [${jpLabel(proposal.jpGroup)}] without redefining it`,
        ),
      )
    }
  } else {
    const dup = Object.keys(config.resonances).find((n) => normalizeName(n) === normalizeName(proposal.name))
    if (dup !== undefined) {
      errors.push(err('duplicate', `"${proposal.name}" duplicates existing resonance "${dup}"`))
    }
  }

  // --- 6. chain & J^P group membership -------------------------------------
  const chainGroup = findGroup(config, proposal.chain, proposal.jpGroup)
  if (kin) {
    // Physics gate: the J^P must be reachable from A -> R + B (angular
    // momentum + parity conservation, up to maxL). This embeds auto_pwa_decay_check
    // so an impossible wave can never be written into the config.
    const allowed = allowedIntermediateJP(kin.mother, kin.daughter, options.maxL ?? 4)
    if (!allowed.some((a) => sameJp(a.jp, proposal.jpGroup))) {
      errors.push(
        err(
          'jp-not-allowed',
          `[${jpLabel(proposal.jpGroup)}] is not reachable for ${proposal.chain} ` +
            `(A=${kin.mother.j}${kin.mother.p > 0 ? '+' : '-'} -> R + B=${kin.daughter.j}${kin.daughter.p > 0 ? '+' : '-'}, ` +
            `maxL=${options.maxL ?? 4}); allowed: ${allowed.map((a) => jpLabel(a.jp)).join(', ')}`,
        ),
      )
    } else if (!chainGroup) {
      warnings.push(
        warn(
          'new-jp-group',
          `[${jpLabel(proposal.jpGroup)}] is a new group for ${proposal.chain} — it will be appended ` +
            `(existing groups: ${groupLabels(config, proposal.chain)})`,
        ),
      )
    }
  }

  // ---- soft rules ---------------------------------------------------------
  if (isParticle && pdg && decayTo !== undefined && !hasDecayTo(pdg, decayTo)) {
    warnings.push(
      warn(
        'no-listed-mode',
        `PDG lists no ${decayTo.join(' ')} decay mode for ${proposal.name} — a data gap, not a physics veto`,
      ),
    )
  }
  if (isParticle && pdg && pdg.width !== undefined && proposal.parameters[1] !== undefined) {
    const ref = Math.max(pdg.width, 0.05)
    if (Math.abs(proposal.parameters[1] - pdg.width) > widthDeviationFraction * ref) {
      warnings.push(
        warn(
          'width-deviation',
          `proposed width ${proposal.parameters[1].toFixed(3)} GeV deviates >${widthDeviationFraction * 100}% ` +
            `from PDG ${pdg.width.toFixed(3)} GeV (acceptable when the analysis tunes it)`,
        ),
      )
    }
  }
  if (proposal.model === 'ONE' && !/^NR/i.test(proposal.name)) {
    warnings.push(
      warn('nr-naming', `ONE (phase-space) terms are conventionally named NR* — "${proposal.name}" is not`),
    )
  }
  if (chainGroup && chainGroup.names.length >= crowdedGroupSize) {
    warnings.push(
      warn(
        'crowded-group',
        `[${jpLabel(proposal.jpGroup)}] of ${proposal.chain} already has ${chainGroup.names.length} members — ` +
          `more waves may overfit; consider replacing rather than adding`,
      ),
    )
  }
  if (chainGroup && isParticle) {
    const near = chainGroup.names.filter((n) => {
      const spec = findResonance(config, n)
      return spec !== undefined && Math.abs(spec.mass - proposal.parameters[0]) <= overlapWindow
    })
    if (near.length > 0) {
      warnings.push(
        warn(
          'overlapping-mass',
          `${proposal.name} (${proposal.parameters[0].toFixed(3)} GeV) overlaps within ${overlapWindow.toFixed(3)} GeV ` +
            `of existing ${near.join(', ')} — ambiguous separation likely`,
        ),
      )
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sameJp(a: { j: number; p: 1 | -1 }, b: { j: number; p: 1 | -1 }): boolean {
  return a.j === b.j && a.p === b.p
}

function jpLabel(jp: { j: number; p: 1 | -1 }): string {
  return `${jp.j}${jp.p > 0 ? '+' : '-'}`
}

/** Find the [J,P] group of an intermediate across all decay chains. */
function findGroup(
  config: { decayChains?: PwaConfig['decayChains'] },
  chain: string,
  jp: JP,
): { jp: JP; names: string[] } | undefined {
  for (const c of Object.values(config.decayChains ?? {})) {
    const found = c.intermediates[chain]?.groups.find((g) => sameJp(g.jp, jp))
    if (found) return found
  }
  return undefined
}

function groupLabels(
  config: { decayChains?: PwaConfig['decayChains'] },
  chain: string,
): string {
  for (const c of Object.values(config.decayChains ?? {})) {
    const groups = c.intermediates[chain]?.groups
    if (groups) return groups.map((g) => jpLabel(g.jp)).join(', ')
  }
  return '(none)'
}

/** Look up a resonance spec in the config by name. */
function findResonance(
  config: { resonances: Record<string, { parameters: number[] }> },
  name: string,
): { mass: number } | undefined {
  const spec = config.resonances[name]
  return spec === undefined ? undefined : { mass: spec.parameters[0] }
}
