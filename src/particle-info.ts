/**
 * PDGID-driven particle identity — the data-decided replacement for the
 * hard-coded name heuristics.
 *
 * The config may give a particle a PDGID (`Particles: { pi01: {..., pdgid: 111} }`)
 * — the signed Monte-Carlo ID, i.e. what the community calls the PDGID
 * (K+ = 321, K- = -321, pi0 = 111, Lambda = 3122, K(S)0 = 310). From it the
 * three symmetry questions become table lookups instead of guesses:
 *
 *   - identical  : same PDGID  → identical boson/fermion (Bose/Fermi rule)
 *   - conjugate  : PDGID(B) === -PDGID(A) (or `conjugate`) → C = (-1)^(L+S)
 *   - self-conj. : `selfConjugate` (PDG cc_type 'S') → C from the PDG value
 *
 * Why this matters for configs: the config cannot use one name twice
 * (`Particles` is a map), so the same species carries distinct analysis names
 * (pi01 / pi02 / pi03). The old detection keyed on NAME equality, so those
 * slipped through: no warning, no engine symmetrisation, silently wrong
 * physics. Equal PDGIDs cannot slip through.
 *
 * Conservative by construction:
 *   - C is taken ONLY from self-conjugate states — the PDG table also carries
 *     spurious quantum_c values on charged multiplet members (rho(770)+ -> '-',
 *     a_2(1320)+ -> '+'), so `selfConjugate` is the gate, never `c` alone;
 *   - a particle with no PDGID falls back to the historical name tables
 *     (CONJUGATE_PAIRS), so old configs keep their exact behaviour;
 *   - missing data means "C undefined", never an invented C.
 *
 * Pure functions; no I/O.
 */
import type { PdgParticleInfo, ResonanceDb } from './types.js'
import { lookupC } from './lookup.js'

/** A particle reference as it appears in a config Particles block or a tool call. */
export interface ParticleRef {
  name?: string
  j?: number
  p?: 1 | -1
  pdgid?: number
  /** Explicit C, when the config states one. */
  c?: 1 | -1
}

/** Resolved identity of one particle (PDGID path only). */
export interface ParticleIdentity {
  pdgid: number
  info: PdgParticleInfo
  /** True when the state is a C eigenstate with a definite PDG C. */
  cDefined: boolean
  c?: 1 | -1
  /** Antiparticle PDGID; equals `pdgid` for self-conjugate states. */
  conjugatePdgid?: number
  conjugateName?: string
}

/** `PdgParticleInfo` for a PDGID, or undefined (unknown / no particles table). */
export function getParticleInfo(db: ResonanceDb, pdgid: number): PdgParticleInfo | undefined {
  return db.particles?.[String(pdgid)]
}

/**
 * Name key: like lookup.normalizeName but keeps the antiparticle mark, so
 * "K0" and "K~0" do not collapse together ('~' -> 'bar', charge sign after a
 * name character -> 'p'/'m').
 */
export function particleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/~/g, 'bar')
    .replace(/(?<=[a-z0-9])[+-]/g, (c) => (c === '+' ? 'p' : 'm'))
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Particle-antiparticle name pairs, used ONLY as a fallback for particles
 * that carry no PDGID (configs predating `pdgid`, and states the PDG table
 * has no distinct antiparticle for, e.g. K(S)0). When a PDGID is present it
 * always wins — this table is never consulted.
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

/** The antiparticle of `name` from the name table, if it has one. */
export function conjugateOf(name: string): string | undefined {
  const key = CONJUGATE_KEYS.get(particleKey(name))
  if (key === undefined) return undefined
  for (const [a, b] of CONJUGATE_PAIRS) {
    if (particleKey(a) === key) return a
    if (particleKey(b) === key) return b
  }
  return undefined
}

/** Whether the PDG entry is a C eigenstate with a definite value. */
export function isCEigenstate(info: PdgParticleInfo): boolean {
  return info.selfConjugate === true && (info.c === 1 || info.c === -1)
}

/** C value of a PDG entry, or undefined when C is not defined. */
export function cValueOf(info: PdgParticleInfo): 1 | -1 | undefined {
  return isCEigenstate(info) ? info.c : undefined
}

/** Antiparticle PDGID (equals `pdgid` for self-conjugate states). */
export function conjugatePdgidOf(db: ResonanceDb, pdgid: number): number | undefined {
  const info = getParticleInfo(db, pdgid)
  if (info === undefined) return undefined
  if (info.selfConjugate) return pdgid
  return info.conjugate
}

/** Full identity of a particle that carries a PDGID. */
export function resolveIdentity(db: ResonanceDb, p: ParticleRef): ParticleIdentity | undefined {
  if (p.pdgid === undefined) return undefined
  const info = getParticleInfo(db, p.pdgid)
  if (info === undefined) return undefined
  const c = cValueOf(info)
  const conjugatePdgid = info.selfConjugate ? p.pdgid : info.conjugate
  const identity: ParticleIdentity = {
    pdgid: p.pdgid,
    info,
    cDefined: c !== undefined,
  }
  if (c !== undefined) identity.c = c
  if (conjugatePdgid !== undefined) identity.conjugatePdgid = conjugatePdgid
  if (conjugatePdgid !== undefined) {
    const anti = getParticleInfo(db, conjugatePdgid)
    if (anti !== undefined) identity.conjugateName = anti.name
  }
  return identity
}

/**
 * C of a particle for the production vertex A -> R + B.
 *
 * Priority: an explicit config `c` > the PDGID's PDG C (authoritative — an
 * unknown C stays undefined rather than falling back to a name guess) > the
 * historical name lookup. A particle with a PDGID that is not a C eigenstate
 * therefore never gets a C from its name.
 */
export function resolveC(db: ResonanceDb, p: ParticleRef): 1 | -1 | undefined {
  if (p.c === 1 || p.c === -1) return p.c
  if (p.pdgid !== undefined) {
    const info = getParticleInfo(db, p.pdgid)
    if (info !== undefined) return cValueOf(info)
  }
  if (p.name !== undefined) return lookupC(db, p.name)
  return undefined
}

/** How a pair's identity was decided. */
export type PairIdentitySource = 'pdgid' | 'name-table' | 'none'

/** Physics identity of a daughter pair (independent of the engine's declared groups). */
export interface PairPhysics {
  /** Same PDGID: the two daughters are the same species (Bose/Fermi applies). */
  identical: boolean
  /** Particle-antiparticle pair: C = (-1)^(L+S) applies. */
  conjugate: boolean
  /** Per-member self-conjugacy (from the PDG table). */
  selfConjugate: [boolean, boolean]
  /** Whether C is defined for the pair by the identity alone. */
  cDefined: boolean
  source: PairIdentitySource
}

/**
 * Classify a daughter pair by physics identity (PDGID first, name table as
 * the fallback). This is the *truth* the validation reports; the engine's
 * actual symmetrisation still depends on `Constraints.identical` being
 * declared, which is exactly what the validation warns about.
 */
export function classifyPairPhysics(
  db: ResonanceDb,
  d1: ParticleRef,
  d2: ParticleRef,
): PairPhysics {
  if (d1.pdgid !== undefined && d2.pdgid !== undefined) {
    const i1 = getParticleInfo(db, d1.pdgid)
    const i2 = getParticleInfo(db, d2.pdgid)
    if (i1 !== undefined && i2 !== undefined) {
      const identical = d1.pdgid === d2.pdgid
      const isAntiPair =
        !identical &&
        i1.selfConjugate === false &&
        i2.selfConjugate === false &&
        d1.pdgid === -d2.pdgid
      return {
        identical,
        conjugate: isAntiPair,
        selfConjugate: [i1.selfConjugate === true, i2.selfConjugate === true],
        cDefined: identical || isAntiPair,
        source: 'pdgid',
      }
    }
  }
  // Name fallback. Compare NORMALIZED keys, not raw strings: analysis
  // spellings differ from PDG ones (config "Kp"/"Km" vs table "K+"/"K-"),
  // and particleKey maps both to 'kp'/'km'.
  const partner = d1.name !== undefined ? conjugateOf(d1.name) : undefined
  const conj =
    partner !== undefined &&
    d2.name !== undefined &&
    particleKey(partner) === particleKey(d2.name)
  return {
    identical: false,
    conjugate: conj,
    selfConjugate: [false, false],
    cDefined: conj,
    source: conj ? 'name-table' : 'none',
  }
}

/** True when both particles carry the same PDGID (identical species). */
export function isIdenticalByPdgid(db: ResonanceDb, d1: ParticleRef, d2: ParticleRef): boolean {
  if (d1.pdgid === undefined || d2.pdgid === undefined) return false
  if (getParticleInfo(db, d1.pdgid) === undefined) return false
  if (getParticleInfo(db, d2.pdgid) === undefined) return false
  return d1.pdgid === d2.pdgid
}

/** The minimal config surface used to derive identical groups. */
export interface IdentityConfigView {
  particles: Record<string, { pdgid?: number; j: number }>
  decayChains: Record<string, { steps: { daughters: readonly [string, string] }[] }>
}

/**
 * Derive the `Constraints.identical` groups the PDGIDs imply: any two
 * daughters of the same two-body step whose PDGIDs are equal must be
 * symmetrised. Groups are merged transitively (union-find), so a 3-body
 * pi01/pi02/pi03 final state yields one group. Purely a derivation — nothing
 * is written here; validation compares it against what the config declares.
 */
export function deriveIdenticalGroups(cfg: IdentityConfigView, db: ResonanceDb): string[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = parent.get(x) ?? x
    if (r !== x) {
      r = find(r)
      parent.set(x, r)
    }
    return r
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  let any = false
  for (const chain of Object.values(cfg.decayChains)) {
    for (const step of chain.steps) {
      const [n1, n2] = step.daughters
      if (n1 === n2) continue
      const p1 = cfg.particles[n1]
      const p2 = cfg.particles[n2]
      if (p1 === undefined || p2 === undefined) continue
      if (p1.pdgid === undefined || p2.pdgid === undefined) continue
      if (getParticleInfo(db, p1.pdgid) === undefined) continue
      if (p1.pdgid !== p2.pdgid) continue
      parent.set(n1, parent.get(n1) ?? n1)
      parent.set(n2, parent.get(n2) ?? n2)
      union(n1, n2)
      any = true
    }
  }
  if (!any) return []
  const groups = new Map<string, string[]>()
  for (const name of parent.keys()) {
    const root = find(name)
    const g = groups.get(root) ?? []
    g.push(name)
    groups.set(root, g)
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => g.sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!))
}
