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
 *   - particle-antiparticle pairs: identified by PDGID when the config gives
 *     one (PDGID(B) === -PDGID(A)), else by the CONJUGATE_PAIRS name table:
 *     C = (-1)^(L+S)  (spin-0 meson pairs reduce to (-1)^L);
 *   - identical groups: C = (-1)^(L+S) fixed to +1 (bosons) / -1 (fermions),
 *     which IS the identical selection rule — and, matching the engine, only
 *     a DECLARED Constraints.identical group counts (the engine's ComSL sees
 *     only identical_group tags; the PDGID derivation lives in
 *     particle-info.ts / validation and never silently changes what the
 *     engine computes).
 * Everything else (charged pairs like K+ eta, pi+ pi0, non-C-eigenstate
 * pairs) is treated as C-undefined and falls back to J^P-only checks — a
 * missing C is safer than a wrong C.
 *
 * Pure functions; no I/O.
 */
import { allowedIntermediateJP } from './decay-check.js'
import { classifyPairPhysics, conjugateOf, particleKey, resolveC } from './particle-info.js'
import type {
  AllowedJP,
  IsobarCheck,
  JP,
  JPC,
  JPCWave,
  Particle,
  ResonanceDb,
  SL,
} from './types.js'

/** The antiparticle name table is owned by particle-info; re-exported here
 * because it historically lived in this module (jpc consumers / tests). */
export { CONJUGATE_PAIRS, conjugateOf } from './particle-info.js'

/** Half-integer spin -> fermion (mirrors ctpwa Particle::is_fermion). */
export function isFermion(j: number): boolean {
  const twoJ = Math.round(j * 2)
  return Math.abs(twoJ % 2) === 1
}

/**
 * The explicit J^P written on a `Resonances:` entry — defined only when BOTH
 * J and P are present.
 *
 * ctpwa treats a resonance-level J/P as optional (ConfigParser::parseResonances
 * falls back to sentinels): when omitted, the [J,P] key of the intermediates
 * group is authoritative. That is what makes CP-conjugate chains work — e.g.
 * the same N* is 3/2+ in R_peta (N* → p η) and 3/2− in R_pbareta
 * (N̄* → p̄ η) — so "no explicit J/P" must be a legal, non-conflicting state
 * rather than a missing field to be filled in.
 */
export function explicitJp(spec: { j?: number; p?: 1 | -1 }): JP | undefined {
  return spec.j !== undefined && spec.p !== undefined ? { j: spec.j, p: spec.p } : undefined
}

export type PairKind = 'identical-boson' | 'identical-fermion' | 'pair-anti' | 'distinct'

export interface PairKindResult {
  kind: PairKind
  /** Whether C is well-defined for the pair. */
  cDefined: boolean
}

/** Daughter reference accepted by pairKind / pairJPC. */
export interface DaughterRef {
  name?: string
  j: number
  p?: 1 | -1
  /**
   * PDGID when the config declares one. Only used to identify conjugate
   * pairs (C = (-1)^(L+S)) beyond the name table; identical detection stays
   * engine-faithful (declared Constraints.identical groups only).
   */
  pdgid?: number
}

/**
 * Classify a daughter pair of a two-body step.
 *
 * `identical` mirrors the ENGINE exactly: both members in the same declared
 * Constraints.identical group (Analysis.cu compares identical_group tags).
 * A PDGID-equal pair that is NOT declared identical is deliberately reported
 * as `distinct` here — the engine would not symmetrise it — and the missing
 * declaration is raised as a validation warning instead (see
 * resonance-validate / config-edit deriveIdenticalGroups).
 *
 * `pair-anti` (which enables C) uses the PDGID table when a `db` is given,
 * and the historical name table otherwise.
 */
export function pairKind(
  d1: DaughterRef,
  d2: DaughterRef,
  identicalGroups?: readonly (readonly string[])[],
  db?: ResonanceDb,
): PairKindResult {
  if (d1.name !== undefined && d2.name !== undefined) {
    const group = identicalGroups?.find((g) => g.includes(d1.name!) && g.includes(d2.name!))
    if (group) {
      return {
        kind: isFermion(d1.j) ? 'identical-fermion' : 'identical-boson',
        cDefined: true,
      }
    }
  }
  const conjugate =
    db !== undefined
      ? classifyPairPhysics(db, d1, d2).conjugate
      : d1.name !== undefined &&
        d2.name !== undefined &&
        d1.name !== d2.name &&
        particleKey(conjugateOf(d1.name) ?? '') === particleKey(d2.name)
  if (conjugate) return { kind: 'pair-anti', cDefined: true }
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
  /** PDG particle table: enables PDGID-based conjugate-pair detection. */
  db?: ResonanceDb
}

/**
 * Decay-vertex J^PC full set for R -> d1 + d2: every J^PC realizable by some
 * (S, L) wave (S from the daughter spins, J = L (x) S, P = P1*P2*(-1)^L, C
 * per pair kind). `jpc.c` is undefined when C is not defined for the pair.
 */
export function pairJPC(
  d1: DaughterRef & { p: 1 | -1 },
  d2: DaughterRef & { p: 1 | -1 },
  options: PairJPCOptions = {},
): JPCWave[] {
  const { maxL = 4, identicalGroups, slFilter, db } = options
  const { kind, cDefined } = pairKind(d1, d2, identicalGroups, db)
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
  /** PDG particle table: enables PDGID-based C and conjugate detection. */
  db?: ResonanceDb
}

/**
 * Three-body isobar check A -> d1 + d2 + d3 with R = (di dj):
 * decay-vertex J^PC set (pairJPC) intersected with the production-vertex
 * J^P (A -> R + spectator; allowedIntermediateJP) and C conservation
 * C(A) = C(R)*C(B) whenever A, B and the pair all have defined C.
 */
export function allowedIsobarJPC(
  mother: Particle,
  d1: { name?: string; j: number; p: 1 | -1; c?: 1 | -1; pdgid?: number },
  d2: { name?: string; j: number; p: 1 | -1; c?: 1 | -1; pdgid?: number },
  d3: { name?: string; j: number; p: 1 | -1; c?: 1 | -1; pdgid?: number },
  options: IsobarOptions = {},
): IsobarCheck[] {
  const { maxL = 4, identicalGroups, isobarName = '', db } = options
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
    const decay = pairJPC(pi, pj, { maxL, identicalGroups, db })
    const production = allowedIntermediateJP(mother, pk as Particle, maxL)
    const cMother = db !== undefined ? resolveC(db, mother) : mother.c
    const cSpectator = db !== undefined ? resolveC(db, pk) : pk.c
    const cRequired =
      cMother !== undefined && cSpectator !== undefined
        ? ((cMother * cSpectator) as 1 | -1)
        : undefined
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
      identical: pairKind(pi, pj, identicalGroups, db).kind.startsWith('identical'),
      cDefined: pairKind(pi, pj, identicalGroups, db).cDefined,
      decayVertex: decay,
      production,
      cRequired,
      allowed,
      cBlocked,
    })
  }
  return results
}

/** Label a J^P value, e.g. 1-, 0+, 3/2+ (no C). */
export function jpLabel(jp: { j: number; p: 1 | -1 }): string {
  return `${jp.j}${jp.p > 0 ? '+' : '-'}`
}

/** Label a J^PC value, e.g. 1--, 0++, 2+ (C undefined). */
export function jpcLabel(jpc: { j: number; p: 1 | -1; c?: 1 | -1 }): string {
  const base = jpLabel(jpc)
  return jpc.c === undefined ? base : `${base}${jpc.c > 0 ? '+' : '-'}`
}
