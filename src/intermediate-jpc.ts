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
import { pairJPC, pairKind, jpcLabel, type PairKind } from './jpc.js'
import { classifyPairPhysics, resolveC } from './particle-info.js'
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
  sl: [number, number][] | null
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
  sl: [number, number][]
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

  const refOf = (name: string | undefined): { name?: string; pdgid?: number; c?: 1 | -1 } => {
    if (name === undefined) return {}
    const p = config.particles[name]
    return p !== undefined ? { ...p, name } : { name }
  }

  let production: ProductionView | undefined
  let cStatus: CStatusView = { status: 'unknown', required: null, reason: 'no production kinematics' }
  if (kin !== undefined) {
    const allowedJP = allowedIntermediateJP(kin.mother, kin.daughter, maxL).map((a) => a.jp)
    const motherC = resolveC(db, refOf(kin.motherName))
    const daughterC = resolveC(db, refOf(kin.daughterName))
    production = {
      mother: kin.motherName,
      daughter: kin.daughterName,
      threshold: kin.threshold,
      allowedJP,
      cRequired: motherC !== undefined && daughterC !== undefined ? ((motherC * daughterC) as 1 | -1) : null,
    }
    if (motherC !== undefined) production.cMother = motherC
    if (daughterC !== undefined) production.cDaughter = daughterC
    if (motherC !== undefined && daughterC !== undefined) {
      cStatus = {
        status: 'enforced',
        required: (motherC * daughterC) as 1 | -1,
        reason: `C(${kin.motherName}) = ${motherC > 0 ? '+' : '-'}, C(${kin.daughterName}) = ${daughterC > 0 ? '+' : '-'} => C(R) = ${motherC * daughterC > 0 ? '+' : '-'}`,
      }
    } else {
      const missing: string[] = []
      if (motherC === undefined) missing.push(`${kin.motherName} (no C)`)
      if (daughterC === undefined) missing.push(`${kin.daughterName} (no C)`)
      // A -> R1 + R2: the "sibling" is an INTERMEDIATE, so its C is not fixed by
      // the config — it depends on which resonance inside that group contributes
      // (a group may hold states of different C). Say so instead of leaving a
      // bare "no C", which reads like the vertex was checked and passed.
      const siblingIsIntermediate = chainCfg.intermediates[kin.daughterName ?? ''] !== undefined
      cStatus = {
        status: 'not-applicable',
        required: null,
        reason:
          `${missing.join(' and ')} — not a C eigenstate, so C conservation does not constrain this vertex` +
          (siblingIsIntermediate
            ? `（${kin.daughterName} 是中间态而非 Particles 里的粒子：它的 C 取决于该组内哪个共振态贡献，` +
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
        sl: step.sl ?? null,
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
      const e = byKey.get(key) ?? { j: w.jpc.j, p: w.jpc.p, c: w.jpc.c ?? null, sl: [], jpc: label, jpKey }
      for (const x of w.sl) e.sl.push([x.s, x.l] as [number, number])
      byKey.set(key, e)
    }
    decaySteps.push({
      daughters: step.daughters,
      kind: kind.kind,
      identical: kind.kind.startsWith('identical'),
      identicalDerived: derivedIdentical,
      cDefined: kind.cDefined,
      sl: step.sl ?? null,
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
