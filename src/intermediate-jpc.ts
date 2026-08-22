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
import { lookupC } from './lookup.js'
import type { JP } from './types.js'

export interface ProductionView {
  mother?: string
  daughter?: string
  threshold?: number
  /** Allowed J^P at the production vertex (A -> R + B). */
  allowedJP: JP[]
  /** C(R) required by C(A) = C(R) * C(B); null when not determined. */
  cRequired: 1 | -1 | null
}

export interface StepView {
  daughters: string[]
  /** pair classification (identical-boson / pair-anti / distinct / ...). */
  kind: PairKind
  identical: boolean
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
): { name: string; j: number; p: 1 | -1 } | undefined {
  const p = config.particles[name]
  return p === undefined ? undefined : { name, j: p.j, p: p.p }
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
  const chainEntry = Object.entries(config.decayChains ?? {}).find(([, c]) => c.intermediates[intName] !== undefined)
  if (chainEntry === undefined) return undefined
  const [chain, chainCfg] = chainEntry
  const maxL = options.maxL ?? config.constraints?.maxL ?? 4
  const identicalGroups = config.constraints?.identical
  const kin = config.kinematics[intName]

  let production: ProductionView | undefined
  if (kin !== undefined) {
    const allowedJP = allowedIntermediateJP(kin.mother, kin.daughter, maxL).map((a) => a.jp)
    const motherC = kin.motherName !== undefined ? lookupC(db, kin.motherName) : undefined
    const daughterC = kin.daughterName !== undefined ? lookupC(db, kin.daughterName) : undefined
    production = {
      mother: kin.motherName,
      daughter: kin.daughterName,
      threshold: kin.threshold,
      allowedJP,
      cRequired: motherC !== undefined && daughterC !== undefined ? ((motherC * daughterC) as 1 | -1) : null,
    }
  }

  const steps = chainCfg.steps.filter((s) => s.mother === intName)
  const decaySteps: StepView[] = []
  const jpUnion = new Set<string>()
  const byKey = new Map<string, MergedWave>()
  for (const step of steps) {
    const d1 = named(config, step.daughters[0])
    const d2 = named(config, step.daughters[1])
    if (d1 === undefined || d2 === undefined) {
      decaySteps.push({
        daughters: step.daughters,
        kind: 'distinct',
        identical: false,
        cDefined: false,
        sl: step.sl ?? null,
        jpc: [],
        jp: [],
        cOf: {},
      })
      continue
    }
    const waves = pairJPC(d1, d2, { maxL, identicalGroups, slFilter: step.sl })
    const kind = pairKind(d1, d2, identicalGroups)
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
    decaySteps,
    jpUnion: [...jpUnion],
    merged: [...byKey.values()],
    allowed,
    cBlocked,
  }
}
