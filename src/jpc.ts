/**
 * Spin-statistics and J^PC rules for two-body decay vertices, replicated
 * 1:1 from the ctpwa engine so tool output matches the actual wave table:
 *
 *   - `enumerateSL`      == Amp2BD::ComSL (src/AmpGen.cu) — (S, L) waves of
 *                         one step, with identical selection rule, maxL and
 *                         the (2S+1, L) sl whitelist.
 *   - identical detection == src/Analysis.cu: two daughters are "identical"
 *                         iff both belong to the same Constraints.identical
 *                         group; selection rule (-1)^(L+S) = +1 (boson) / -1
 *                         (fermion).
 *   - `isFermion`        == Particle::is_fermion (include/Config.cuh):
 *                         half-integer spin.
 *
 * C-parity of a pair is only computed when it is well-defined and safe:
 *   - particle-antiparticle pairs from the CONJUGATE_PAIRS table:
 *     C = (-1)^(L+S)  (spin-0 meson pairs reduce to (-1)^L);
 *   - identical groups: C = (-1)^(L+S) fixed to +1 (bosons) / -1 (fermions),
 *     which IS the identical selection rule.
 * Everything else (charged pairs like K+ eta, pi+ pi0, non-C-eigenstate
 * pairs) is treated as C-undefined and falls back to J^P-only checks — a
 * missing C is safer than a wrong C.
 *
 * Pure functions; no I/O.
 */
import { allowedIntermediateJP } from './decay-check.js'
import type {
  AllowedJP,
  IsobarCheck,
  JP,
  JPC,
  JPCWave,
  Particle,
  SL,
} from './types.js'

/** Half-integer spin -> fermion (mirrors ctpwa Particle::is_fermion). */
export function isFermion(j: number): boolean {
  const twoJ = Math.round(j * 2)
  return Math.abs(twoJ % 2) === 1
}

/**
 * Name key for pair classification: like normalizeName, but keeps the
 * antiparticle mark: '~' -> 'bar' and charge signs after a name character
 * -> 'p'/'m'. This avoids the normalizeName collision where "K0" and "K~0"
 * both collapse to "k0".
 */
function particleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/~/g, 'bar')
    .replace(/(?<=[a-z0-9])[+-]/g, (c) => (c === '+' ? 'p' : 'm'))
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Particle-antiparticle name pairs (raw names as used in configs / the PDG
 * table). Charge conjugation of a pair is enabled ONLY for members of this
 * table; any other name combination is C-undefined (conservative). Self-
 * conjugate particles (pi0, eta, ...) intentionally have NO entry here —
 * two identical self-conjugate daughters must be handled via a
 * Constraints.identical group, which applies the Bose/Fermi selection rule.
 */
export const CONJUGATE_PAIRS: readonly (readonly [string, string])[] = [
  ['K+', 'K-'],
  ['K0', 'K~0'],
  ['pi+', 'pi-'],
  ['p', 'pbar'],
  ['n', 'nbar'],
  ['Lambda', 'Lambdabar'],
  ['Sigma+', 'Sigma-'],
  ['Xi-', 'Xi+'],
  ['Xi0', 'Xi~0'],
  ['Omega-', 'Omega+'],
  ['D+', 'D-'],
  ['D0', 'D~0'],
  ['Ds+', 'Ds-'],
  ['B+', 'B-'],
  ['B0', 'B~0'],
  ['Bs0', 'Bs~0'],
  ['Bc+', 'Bc-'],
  ['tau+', 'tau-'],
  ['mu+', 'mu-'],
  ['e+', 'e-'],
  ['K*(892)+', 'K*(892)-'],
  ['D*(2010)+', 'D*(2010)-'],
  ['B*+', 'B*-'],
]

/** normalized key -> normalized partner key (from CONJUGATE_PAIRS). */
const CONJUGATE_KEYS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [a, b] of CONJUGATE_PAIRS) {
    const ka = particleKey(a)
    const kb = particleKey(b)
    if (ka === kb) continue // degenerate pair; ignore
    m.set(ka, kb)
    m.set(kb, ka)
  }
  return m
})()

/** The antiparticle of `name`, if it has one in the conjugate-pair table. */
export function conjugateOf(name: string): string | undefined {
  const key = CONJUGATE_KEYS.get(particleKey(name))
  if (key === undefined) return undefined
  for (const [a, b] of CONJUGATE_PAIRS) {
    if (particleKey(a) === key) return a
    if (particleKey(b) === key) return b
  }
  return undefined
}

export type PairKind = 'identical-boson' | 'identical-fermion' | 'pair-anti' | 'distinct'

export interface PairKindResult {
  kind: PairKind
  /** Whether C is well-defined for the pair. */
  cDefined: boolean
}

/**
 * Classify a daughter pair of a two-body step. Identical detection matches
 * the engine: both members in the same Constraints.identical group. Only the
 * conjugate-pair table (and identical groups) enable C.
 */
export function pairKind(
  d1: { name?: string; j: number },
  d2: { name?: string; j: number },
  identicalGroups?: readonly (readonly string[])[],
): PairKindResult {
  if (d1.name !== undefined && d2.name !== undefined) {
    const group = identicalGroups?.find((g) => g.includes(d1.name!) && g.includes(d2.name!))
    if (group) {
      return {
        kind: isFermion(d1.j) ? 'identical-fermion' : 'identical-boson',
        cDefined: true,
      }
    }
    if (d1.name !== d2.name) {
      const partner = CONJUGATE_KEYS.get(particleKey(d1.name))
      if (partner !== undefined && partner === particleKey(d2.name)) {
        return { kind: 'pair-anti', cDefined: true }
      }
    }
  }
  return { kind: 'distinct', cDefined: false }
}

export interface EnumerateSLOptions {
  /** Orbital-momentum cap; default 4 (plugin/skill convention). <= 0 = no limit (ctpwa -1). */
  maxL?: number
  /** Daughters in the same Constraints.identical group (selection rule applies). */
  identical?: boolean
  /** Boson pair when identical (default true; fermions -> (-1)^(L+S) = -1). */
  isBoson?: boolean
  /** Skip the parity condition (weak decays, ctpwa p_break). */
  pBreak?: boolean
  /** (2S+1, L) whitelist; empty/undefined = no filter. */
  slFilter?: readonly (readonly [number, number])[]
}

/**
 * Enumerate the (S, L) waves of one two-body step, replicating ctpwa
 * Amp2BD::ComSL exactly (integer arithmetic on doubled spins; S and L are
 * truncated like the C++ int division two_S/2, two_L/2; output S in 2S+1
 * notation).
 */
export function enumerateSL(
  mother: JP,
  d1: { j: number; p: 1 | -1 },
  d2: { j: number; p: 1 | -1 },
  options: EnumerateSLOptions = {},
): SL[] {
  const { maxL = 4, identical = false, isBoson = true, pBreak = false, slFilter } = options
  const twoJ1 = Math.round(mother.j * 2)
  const twoJ2 = Math.round(d1.j * 2)
  const twoJ3 = Math.round(d2.j * 2)
  const out: SL[] = []
  const twoSMin = Math.abs(twoJ2 - twoJ3)
  const twoSMax = twoJ2 + twoJ3
  for (let twoS = twoSMin; twoS <= twoSMax; twoS += 2) {
    // ctpwa: int S = two_S / 2 (truncates half-integers).
    const S = Math.trunc(twoS / 2)
    const twoLMin = Math.abs(twoJ1 - twoS)
    const twoLMax = twoJ1 + twoS
    for (let twoL = twoLMin; twoL <= twoLMax; twoL += 2) {
      // ctpwa: int L = two_L / 2 (truncates half-integers).
      const L = Math.trunc(twoL / 2)
      // Parity: P1 = P2 * P3 * (-1)^L (skipped when parity is broken).
      const sign = L % 2 === 0 ? 1 : -1
      if (!pBreak && mother.p !== d1.p * d2.p * sign) continue
      // Identical selection rule: (-1)^(L+S) = +1 (Bose) / -1 (Fermi).
      if (identical) {
        const lsParity = (L + S) % 2 === 0 ? 1 : -1
        if (lsParity !== (isBoson ? 1 : -1)) continue
      }
      // maxL cutoff (ctpwa: only when maxL_ > 0).
      if (maxL > 0 && L > maxL) continue
      // (2S+1, L) whitelist.
      if (slFilter !== undefined && slFilter.length > 0) {
        if (!slFilter.some(([s, l]) => s === twoS + 1 && l === L)) continue
      }
      out.push({ s: twoS + 1, l: L })
    }
  }
  return out
}

export interface PairJPCOptions {
  /** Orbital-momentum cap (default 4). */
  maxL?: number
  /** Constraints.identical groups (raw names) for identical-particle detection. */
  identicalGroups?: readonly (readonly string[])[]
  /** (2S+1, L) whitelist of this decay step (per-step `sl` opts). */
  slFilter?: readonly (readonly [number, number])[]
}

/**
 * Decay-vertex J^PC full set for R -> d1 + d2: every J^PC realizable by some
 * (S, L) wave (S from the daughter spins, J = L (x) S, P = P1*P2*(-1)^L, C
 * per pair kind). `jpc.c` is undefined when C is not defined for the pair.
 */
export function pairJPC(
  d1: { name?: string; j: number; p: 1 | -1 },
  d2: { name?: string; j: number; p: 1 | -1 },
  options: PairJPCOptions = {},
): JPCWave[] {
  const { maxL = 4, identicalGroups, slFilter } = options
  const { kind, cDefined } = pairKind(d1, d2, identicalGroups)
  const twoJ2 = Math.round(d1.j * 2)
  const twoJ3 = Math.round(d2.j * 2)
  const byJpc = new Map<string, JPCWave>()
  const twoSMin = Math.abs(twoJ2 - twoJ3)
  const twoSMax = twoJ2 + twoJ3
  // No-limit mode (maxL <= 0) uses a generous fixed cap; real analyses never
  // reach it and the engine's sl table is equally finite.
  const lCap = maxL > 0 ? maxL : 24
  for (let twoS = twoSMin; twoS <= twoSMax; twoS += 2) {
    const S = twoS / 2
    for (let L = 0; L <= lCap; L++) {
      // Parity of R -> d1 + d2.
      const P: 1 | -1 = (d1.p * d2.p * (L % 2 === 0 ? 1 : -1)) as 1 | -1
      // C per pair kind; identical groups apply the (-1)^(L+S) selection rule.
      let C: 1 | -1 | undefined
      if (kind === 'identical-boson') {
        if (((L + S) % 2 === 0 ? 1 : -1) !== 1) continue
        C = 1
      } else if (kind === 'identical-fermion') {
        if (((L + S) % 2 === 0 ? 1 : -1) !== -1) continue
        C = -1
      } else if (kind === 'pair-anti') {
        C = ((L + S) % 2 === 0 ? 1 : -1) as 1 | -1
      } else {
        C = undefined
      }
      // (2S+1, L) whitelist.
      if (slFilter !== undefined && slFilter.length > 0) {
        if (!slFilter.some(([s, l]) => s === twoS + 1 && l === L)) continue
      }
      // J = L (x) S.
      const twoJLo = Math.abs(2 * L - twoS)
      const twoJHi = 2 * L + twoS
      for (let twoJ = twoJLo; twoJ <= twoJHi; twoJ += 2) {
        const J = twoJ / 2
        const jpc: JPC = cDefined ? { j: J, p: P, c: C } : { j: J, p: P }
        const key = `${J}|${P}|${C ?? 'x'}`
        const w = byJpc.get(key) ?? { jpc, sl: [] }
        w.sl.push({ s: twoS + 1, l: L })
        byJpc.set(key, w)
      }
    }
  }
  return [...byJpc.values()].sort(
    (a, b) => a.jpc.j - b.jpc.j || a.jpc.p - b.jpc.p || (a.jpc.c ?? 2) - (b.jpc.c ?? 2),
  )
}

export interface IsobarOptions {
  /** Orbital-momentum cap (default 4). */
  maxL?: number
  /** Constraints.identical groups (raw names). */
  identicalGroups?: readonly (readonly string[])[]
  /** Intermediate name for the result (e.g. "R_KK"). */
  isobarName?: string
}

/**
 * Three-body isobar check A -> d1 + d2 + d3 with R = (di dj):
 * decay-vertex J^PC set (pairJPC) intersected with the production-vertex
 * J^P (A -> R + spectator; allowedIntermediateJP) and C conservation
 * C(A) = C(R)*C(B) whenever A, B and the pair all have defined C.
 */
export function allowedIsobarJPC(
  mother: Particle,
  d1: { name?: string; j: number; p: 1 | -1; c?: 1 | -1 },
  d2: { name?: string; j: number; p: 1 | -1; c?: 1 | -1 },
  d3: { name?: string; j: number; p: 1 | -1; c?: 1 | -1 },
  options: IsobarOptions = {},
): IsobarCheck[] {
  const { maxL = 4, identicalGroups, isobarName = '' } = options
  const nameOf = (p: { name?: string }): string => p.name ?? '?'
  const triples: { pi: typeof d1; pj: typeof d2; pk: typeof d3; pair: [string, string] }[] = [
    { pi: d1, pj: d2, pk: d3, pair: [nameOf(d1), nameOf(d2)] },
    { pi: d1, pj: d3, pk: d2, pair: [nameOf(d1), nameOf(d3)] },
    { pi: d2, pj: d3, pk: d1, pair: [nameOf(d2), nameOf(d3)] },
  ]
  const sameJp = (a: { j: number; p: 1 | -1 }, b: { j: number; p: 1 | -1 }): boolean =>
    a.j === b.j && a.p === b.p
  const results: IsobarCheck[] = []
  for (const { pi, pj, pk, pair } of triples) {
    const decay = pairJPC(pi, pj, { maxL, identicalGroups })
    const production = allowedIntermediateJP(mother, pk as Particle, maxL)
    const cRequired =
      mother.c !== undefined && pk.c !== undefined ? ((mother.c * pk.c) as 1 | -1) : undefined
    const prodHas = (jpc: JPC): boolean => production.some((p) => sameJp(p.jp, jpc))
    const allowed: JPCWave[] = []
    const cBlocked: JPCWave[] = []
    for (const w of decay) {
      if (!prodHas(w.jpc)) continue
      if (cRequired !== undefined && w.jpc.c !== undefined && w.jpc.c !== cRequired) {
        cBlocked.push(w)
        continue
      }
      allowed.push(w)
    }
    results.push({
      isobarName,
      pair,
      identical: pairKind(pi, pj, identicalGroups).kind.startsWith('identical'),
      cDefined: pairKind(pi, pj, identicalGroups).cDefined,
      decayVertex: decay,
      production,
      cRequired,
      allowed,
      cBlocked,
    })
  }
  return results
}

/** Label a J^PC value, e.g. 1--, 0++, 2+ (C undefined). */
export function jpcLabel(jpc: { j: number; p: 1 | -1; c?: 1 | -1 }): string {
  const base = `${jpc.j}${jpc.p > 0 ? '+' : '-'}`
  return jpc.c === undefined ? base : `${base}${jpc.c > 0 ? '+' : '-'}`
}
