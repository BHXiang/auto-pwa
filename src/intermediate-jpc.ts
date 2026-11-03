/**
 * Two-vertex J^PC analysis of one config intermediate (shared by the
 * auto_pwa_jpc_check view tool and the write gate in resonance-validate.ts,
 * so the "what the model sees" and "what the gate enforces" can never
 * drift apart).
 *
 * For an intermediate R of a decay chain:
 *   - production vertex: A -> R + B — allowed J^P from angular momentum +
 *     parity conservation (allowedIntermediateJP), plus the required
 *     C(R) = C(A) * C(B) whenever both A and B have defined C.
 *   - decay vertex: R -> d1 + d2 — per-step J^PC sets from pairJPC
 *     (Amp2BD::ComSL replica + identical selection rule).
 *   - intersection: waves realizable at BOTH vertices; waves whose C
 *     contradicts the production requirement are reported as cBlocked.
 *
 * Pure functions; no I/O.
 */
import type { PwaConfig, ResonanceDb } from './types.js'
import { allowedIntermediateJP } from './decay-check.js'
import { pairJPC, pairKind, jpcLabel, filterToLS, toLS, type PairKind } from './jpc.js'
import { classifyPairPhysics, getParticleInfo, resolveC } from './particle-info.js'
import type { JP } from './types.js'

export interface ProductionView {
  mother?: string
  daughter?: string
  threshold?: number
  /** Allowed J^P at the production vertex (A -> R + B). */
  allowedJP: JP[]
  /** C(R) required by C(A) = C(R) * C(B); null when not determined. */
  cRequired: 1 | -1 | null
  /** C of the mother / the spectator (undefined = not a C eigenstate). */
  cMother?: 1 | -1
  cDaughter?: 1 | -1
}

/**
 * Whether C conservation is applied at the production vertex, and why.
 *   - 'enforced'       : A and B are both C eigenstates -> C(R) is fixed;
 *   - 'not-applicable' : at least one of A/B has no C -> nothing to enforce
 *                        (e.g. J/psi -> K+ eta: the charged kaon has no C);
 *   - 'unknown'        : no production kinematics available.
 * C is not an engine input (Amp2BD never sees C), so this gate is the only
 * thing that stops a C-violating wave from being written.
 */
export interface CStatusView {
  status: 'enforced' | 'not-applicable' | 'unknown'
  required: 1 | -1 | null
  reason: string
}

export interface StepView {
  daughters: string[]
  /** pair classification (identical-boson / pair-anti / distinct / ...). */
  kind: PairKind
  /** Engine truth: both daughters sit in one DECLARED Constraints.identical group. */
  identical: boolean
  /**
   * Physics truth from the PDGIDs: the two daughters are the same species.
   * `identical === false && identicalDerived === true` is exactly the silent
   * hole (add the identical group or the engine skips symmetrisation).
   */
  identicalDerived: boolean
  cDefined: boolean
  /**
   * The step's wave whitelist in ctpwa's user-side notation `[L, S_phys]`
   * (config key `ls: [L, S]`); null = the step does not filter waves.
   */
  ls: [number, number][] | null
  /** J^PC labels of this step's waves (C appended when defined). */
  jpc: string[]
  /** J^P-only labels (C-independent membership). */
  jp: string[]
  /** Per-wave C values keyed by J^P-only label (undefined = not defined). */
  cOf: Record<string, 1 | -1 | 'x'>
}

export interface MergedWave {
  j: number
  p: 1 | -1
  c: 1 | -1 | null
  /** Realizing waves in ctpwa's user-side notation `[L, S_phys]` (not 2S+1). */
  ls: [number, number][]
  jpc: string
  jpKey: string
}

export interface IntermediateJpcAnalysis {
  chain: string
  production?: ProductionView
  /** Whether C conservation is enforced at the production vertex. */
  cStatus: CStatusView
  decaySteps: StepView[]
  /** J^P-only union over all decay modes. */
  jpUnion: string[]
  /** Waves merged over all modes (C-aware), before production filtering. */
  merged: MergedWave[]
  /** Merged ∩ production-reachable ∧ C-consistent (unique J^PC). */
  allowed: MergedWave[]
  /** J^PC labels blocked only by C conservation at the production vertex. */
  cBlocked: string[]
}

/** The config surface the analysis reads (PwaConfig subset, also satisfied
 * by resonance-validate's ValidationConfig). */
export type JpcConfig = Pick<PwaConfig, 'kinematics' | 'particles'> & {
  decayChains?: PwaConfig['decayChains']
  constraints?: PwaConfig['constraints']
}

export interface AnalyzeOptions {
  /** Orbital-momentum cap; default config Constraints.maxL, else 4. */
  maxL?: number
}

/** J^P-only key: "J" + sign of P. */
export function jpKeyOf(jp: { j: number; p: 1 | -1 }): string {
  return `${jp.j}${jp.p > 0 ? '+' : '-'}`
}

function named(
  config: JpcConfig,
  name: string,
): { name: string; j: number; p: 1 | -1; pdgid?: number } | undefined {
  const p = config.particles[name]
  if (p === undefined) return undefined
  return p.pdgid !== undefined
    ? { name, j: p.j, p: p.p, pdgid: p.pdgid }
    : { name, j: p.j, p: p.p }
}

/** Electric charge of a config particle, from its PDGID (undefined = unknown). */
export function particleCharge(
  config: JpcConfig,
  db: ResonanceDb,
  name: string,
): number | undefined {
  const p = config.particles[name]
  if (p === undefined || p.pdgid === undefined) return undefined
  return getParticleInfo(db, p.pdgid)?.charge
}

/**
 * Charge of every intermediate, from its decay daughters: Q(R) = Q(d1) + Q(d2)
 * (charge conservation at the decay vertex), resolved through cascades.
 *
 * Why C needs this: C is only a good quantum number for a NEUTRAL state. A
 * charged intermediate such as `R_pippi0 = pi+ pi0` must never inherit a C
 * from the neutral spelling of its group's resonance (`rho(770)0` -> C=-1):
 * that is exactly how a charged chain used to acquire a bogus C(R)=+1
 * requirement, and why a charged a0/a1 could not be added to an eta'pi- chain.
 *
 * A charge that cannot be derived stays ABSENT (never assumed 0) — the caller
 * then keeps its conservative behaviour.
 */
export function deriveIntermediateCharge(
  config: JpcConfig,
  db: ResonanceDb,
): Map<string, number> {
  const out = new Map<string, number>()
  const intNames = new Set<string>()
  const stepsOf = new Map<string, string[][]>()
  for (const chain of Object.values(config.decayChains ?? {})) {
    for (const n of Object.keys(chain.intermediates)) intNames.add(n)
  }
  for (const chain of Object.values(config.decayChains ?? {})) {
    for (const s of chain.steps) {
      if (!intNames.has(s.mother)) continue
      const list = stepsOf.get(s.mother) ?? []
      list.push([...s.daughters])
      stepsOf.set(s.mother, list)
    }
  }
  for (let pass = 0; pass <= intNames.size; pass++) {
    let changed = false
    for (const name of intNames) {
      if (out.has(name)) continue
      const steps = stepsOf.get(name) ?? []
      if (steps.length === 0) continue
      const sums = new Set<number>()
      let allKnown = true
      for (const daughters of steps) {
        let sum = 0
        for (const d of daughters) {
          const q = config.particles[d] !== undefined ? particleCharge(config, db, d) : out.get(d)
          if (q === undefined) {
            allKnown = false
            break
          }
          sum += q
        }
        if (!allKnown) break
        sums.add(sum)
      }
      if (allKnown && sums.size === 1) {
        out.set(name, [...sums][0]!)
        changed = true
      }
    }
    if (!changed) break
  }
  return out
}

/**
 * C of every cascade intermediate that is *derivable* from its production
 * vertex: C(A) = C(R) * C(B) => C(R) = C(A) * C(B). The fixed point lets C
 * propagate down a chain (J/psi -> eta' + R, R -> rho + pi0, ...).
 *
 * A name that is not in `Particles` is treated as an intermediate; when its C
 * is not derivable it stays absent (never invented).
 *
 * Charge gate: only a NEUTRAL intermediate can carry a C. A charged one
 * (pi+ pi0, eta' pi-) gets none — neither from the fixed point nor from the
 * neutral spelling of its group's resonances.
 */
export function deriveIntermediateC(config: JpcConfig, db: ResonanceDb): Map<string, 1 | -1> {
  const out = new Map<string, 1 | -1>()
  const intNames = new Set<string>()
  const charges = deriveIntermediateCharge(config, db)
  for (const chain of Object.values(config.decayChains ?? {})) {
    for (const n of Object.keys(chain.intermediates)) intNames.add(n)
  }
  const isCharged = (name: string): boolean => {
    const q = charges.get(name)
    return q !== undefined && q !== 0
  }
  const cOf = (name: string | undefined): 1 | -1 | undefined => {
    if (name === undefined) return undefined
    const p = config.particles[name]
    if (p !== undefined) return resolveC(db, { ...p, name })
    return out.get(name)
  }
  // C of an intermediate may also be read from its group's resonances when
  // they carry a unique PDG C (e.g. R_pipi with rho770 => -1).  This covers
  // cascade steps whose sibling has no C (R_3pi -> pi+ + R_pipi), where the
  // production-vertex fixed point alone leaves the intermediate undefined.
  // Only for NEUTRAL channels: rho(770)0's C says nothing about pi+ pi0.
  const resonanceC = (name: string): 1 | -1 | undefined => {
    if (charges.get(name) !== 0) return undefined
    for (const chain of Object.values(config.decayChains ?? {})) {
      const int = chain.intermediates[name]
      if (int === undefined) continue
      const cs = new Set<number>()
      for (const g of int.groups) {
        for (const rn of g.names) {
          const c = resolveC(db, { name: rn })
          if (c === 1 || c === -1) cs.add(c)
        }
      }
      return cs.size === 1 ? ([...cs][0] as 1 | -1) : undefined
    }
    return undefined
  }
  for (let pass = 0; pass < intNames.size + 1; pass++) {
    let changed = false
    for (const intName of intNames) {
      if (out.has(intName)) continue
      // A charged intermediate is not a C eigenstate — do not derive one.
      if (isCharged(intName)) continue
      const kin = config.kinematics[intName]
      const cMother = kin === undefined ? undefined : cOf(kin.motherName)
      const cDaughter = kin === undefined ? undefined : cOf(kin.daughterName)
      if (cMother !== undefined && cDaughter !== undefined) {
        out.set(intName, (cMother * cDaughter) as 1 | -1)
        changed = true
      } else {
        const c = resonanceC(intName)
        if (c !== undefined) {
          out.set(intName, c)
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return out
}

/**
 * Analyze one intermediate across every chain that defines it (usually one).
 * Returns the full two-vertex view described above.
 */
export function analyzeIntermediateJPC(
  config: JpcConfig,
  db: ResonanceDb,
  intName: string,
  options: AnalyzeOptions = {},
): IntermediateJpcAnalysis | undefined {
  // Prefer a chain where the intermediate actually DECAYS: its wave table comes
  // from that chain's steps, and a chain that merely declares it would report an
  // empty wave table (while the production row below may come from a different
  // chain — kinematics keeps the tightest threshold across all of them). Falls
  // back to the first declaring chain when no chain decays it.
  const declaring = Object.entries(config.decayChains ?? {}).filter(([, c]) => c.intermediates[intName] !== undefined)
  const chainEntry = declaring.find(([, c]) => c.steps.some((s) => s.mother === intName)) ?? declaring[0]
  if (chainEntry === undefined) return undefined
  const [chain, chainCfg] = chainEntry
  const maxL = options.maxL ?? config.constraints?.maxL ?? 4
  const identicalGroups = config.constraints?.identical
  const kin = config.kinematics[intName]

  // C of an intermediate can be derived from its own production vertex when
  // both ends are C eigenstates; propagate that down the chain so a cascade
  // daughter (e.g. rho in R_3pi -> rho + pi0) is not treated as "C unknown".
  const derivedC = deriveIntermediateC(config, db)
  const cOfName = (name: string | undefined): 1 | -1 | undefined => {
    if (name === undefined) return undefined
    const p = config.particles[name]
    return p !== undefined ? resolveC(db, { ...p, name }) : derivedC.get(name)
  }
  const refOf = (name: string | undefined): { name?: string; pdgid?: number; c?: 1 | -1 } => {
    if (name === undefined) return {}
    const p = config.particles[name]
    return p !== undefined ? { ...p, name } : { name }
  }

  let production: ProductionView | undefined
  let cStatus: CStatusView = { status: 'unknown', required: null, reason: 'no production kinematics' }
  const charges = deriveIntermediateCharge(config, db)
  const ownCharge = charges.get(intName)
  // A CHARGED intermediate is not a C eigenstate: even when both ends of the
  // production vertex have a C, C conservation says nothing about it. (A
  // charged R_3pi = pi+ R_pipi used to inherit C(R) = -1 from J/psi -> eta' R.)
  const ownCharged = ownCharge !== undefined && ownCharge !== 0
  const whyNoC = (name: string | undefined): string => {
    if (name === undefined) return ''
    const q = charges.get(name)
    return q !== undefined && q !== 0
      ? `（带电 Q=${q > 0 ? '+' : ''}${q}：C 不是好量子数）`
      : ''
  }
  if (kin !== undefined) {
    const allowedJP = allowedIntermediateJP(kin.mother, kin.daughter, maxL).map((a) => a.jp)
    const motherC = cOfName(kin.motherName)
    const daughterC = cOfName(kin.daughterName)
    const cRequired =
      !ownCharged && motherC !== undefined && daughterC !== undefined
        ? ((motherC * daughterC) as 1 | -1)
        : null
    production = {
      mother: kin.motherName,
      daughter: kin.daughterName,
      threshold: kin.threshold,
      allowedJP,
      cRequired,
    }
    if (motherC !== undefined) production.cMother = motherC
    if (daughterC !== undefined) production.cDaughter = daughterC
    if (cRequired !== null) {
      cStatus = {
        status: 'enforced',
        required: cRequired,
        reason: `C(${kin.motherName}) = ${motherC! > 0 ? '+' : '-'}, C(${kin.daughterName}) = ${daughterC! > 0 ? '+' : '-'} => C(R) = ${cRequired > 0 ? '+' : '-'}`,
      }
    } else if (ownCharged) {
      cStatus = {
        status: 'not-applicable',
        required: null,
        reason:
          `${intName} 带电（Q=${ownCharge! > 0 ? '+' : ''}${ownCharge}）：C 不是好量子数，` +
          `本顶点的 C 守恒不适用（不是"通过"，只是无从约束）`,
      }
    } else {
      const missing: string[] = []
      if (motherC === undefined) missing.push(`${kin.motherName} (no C)${whyNoC(kin.motherName)}`)
      if (daughterC === undefined) missing.push(`${kin.daughterName} (no C)${whyNoC(kin.daughterName)}`)
      const siblingIsIntermediate = chainCfg.intermediates[kin.daughterName ?? ''] !== undefined
      cStatus = {
        status: 'not-applicable',
        required: null,
        reason:
          `${missing.join(' and ')} — not a C eigenstate, so C conservation does not constrain this vertex` +
          (siblingIsIntermediate
            ? `（${kin.daughterName} 是中间态且其 C 无法从其产生顶点导出：` +
              `所以此处不做 C 判据 —— 这不等于 C 守恒已通过）`
            : ''),
      }
    }
  }

  const steps = chainCfg.steps.filter((s) => s.mother === intName)
  const decaySteps: StepView[] = []
  const jpUnion = new Set<string>()
  const byKey = new Map<string, MergedWave>()
  for (const step of steps) {
    const d1 = named(config, step.daughters[0])
    const d2 = named(config, step.daughters[1])
    const declaredIdentical =
      identicalGroups?.some((g) => g.includes(step.daughters[0]) && g.includes(step.daughters[1])) ?? false
    const derivedIdentical = classifyPairPhysics(
      db,
      refOf(step.daughters[0]),
      refOf(step.daughters[1]),
    ).identical
    if (d1 === undefined || d2 === undefined) {
      decaySteps.push({
        daughters: step.daughters,
        kind: 'distinct',
        identical: false,
        identicalDerived: derivedIdentical,
        cDefined: false,
        ls: step.sl ? filterToLS(step.sl) : null,
        jpc: [],
        jp: [],
        cOf: {},
      })
      continue
    }
    const waves = pairJPC(d1, d2, { maxL, identicalGroups, slFilter: step.sl, db })
    const kind = pairKind(d1, d2, identicalGroups, db)
    const cOf: Record<string, 1 | -1 | 'x'> = {}
    const jpcLabels: string[] = []
    const jpLabels: string[] = []
    const seenJp = new Set<string>()
    for (const w of waves) {
      const label = jpcLabel(w.jpc)
      const key = `${w.jpc.j}|${w.jpc.p}|${w.jpc.c ?? 'x'}`
      const jpKey = jpKeyOf(w.jpc)
      jpcLabels.push(label)
      if (!seenJp.has(jpKey)) {
        seenJp.add(jpKey)
        jpLabels.push(jpKey)
        cOf[jpKey] = w.jpc.c ?? 'x'
      }
      jpUnion.add(jpKey)
      // C-aware key: same J^P with different C stays a separate wave.
      const e = byKey.get(key) ?? { j: w.jpc.j, p: w.jpc.p, c: w.jpc.c ?? null, ls: [], jpc: label, jpKey }
      for (const x of w.sl) e.ls.push(toLS(x))
      byKey.set(key, e)
    }
    decaySteps.push({
      daughters: step.daughters,
      kind: kind.kind,
      identical: kind.kind.startsWith('identical'),
      identicalDerived: derivedIdentical,
      cDefined: kind.cDefined,
      ls: step.sl ? filterToLS(step.sl) : null,
      jpc: jpcLabels,
      jp: jpLabels,
      cOf,
    })
  }

  const prodHas = (w: MergedWave): boolean =>
    production === undefined || production.allowedJP.some((a) => a.j === w.j && a.p === w.p)

  const allowed: MergedWave[] = []
  const cBlocked: string[] = []
  for (const w of byKey.values()) {
    if (!prodHas(w)) continue
    if (production?.cRequired !== undefined && production.cRequired !== null && w.c !== null && w.c !== production.cRequired) {
      cBlocked.push(w.jpc)
      continue
    }
    allowed.push(w)
  }
  allowed.sort((a, b) => a.j - b.j || a.p - b.p || (a.c ?? 2) - (b.c ?? 2))

  return {
    chain,
    production,
    cStatus,
    decaySteps,
    jpUnion: [...jpUnion],
    merged: [...byKey.values()],
    allowed,
    cBlocked,
  }
}
