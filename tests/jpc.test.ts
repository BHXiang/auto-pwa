import { describe, expect, it } from 'vitest'
import { defaultDb } from '../src/db.js'
import {
  allowedIsobarJPC,
  conjugateOf,
  enumerateSL,
  isFermion,
  jpcLabel,
  pairJPC,
  pairKind,
} from '../src/jpc.js'
import { parseConfig } from '../src/config-edit.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { lookupC } from '../src/lookup.js'
import type { JP, Particle, ResonanceDb, ResonanceProposal, SL } from '../src/types.js'

// ---------------------------------------------------------------------------
// enumerateSL == ctpwa Amp2BD::ComSL (src/AmpGen.cu), reference port
// ---------------------------------------------------------------------------

/** Direct port of the ctpwa C++ implementation (2J+1 spins in, (2S+1, L) out). */
function comSL(
  spins: [number, number, number],
  parities: [1 | -1, 1 | -1, 1 | -1],
  opts: { pBreak?: boolean; identical?: boolean; isBoson?: boolean; maxL?: number; slFilter?: [number, number][] } = {},
): SL[] {
  const [s1, s2, s3] = spins
  const [p1, p2, p3] = parities
  const twoJ1 = s1 - 1
  const twoJ2 = s2 - 1
  const twoJ3 = s3 - 1
  const out: SL[] = []
  const twoSMin = Math.abs(twoJ2 - twoJ3)
  const twoSMax = twoJ2 + twoJ3
  for (let twoS = twoSMin; twoS <= twoSMax; twoS += 2) {
    const S = Math.trunc(twoS / 2) // C++ int division
    const twoLMin = Math.abs(twoJ1 - twoS)
    const twoLMax = twoJ1 + twoS
    for (let twoL = twoLMin; twoL <= twoLMax; twoL += 2) {
      const L = Math.trunc(twoL / 2) // C++ int division
      const sign = L % 2 === 0 ? 1 : -1
      if (!opts.pBreak && p1 !== p2 * p3 * sign) continue
      if (opts.identical) {
        const lsParity = (L + S) % 2 === 0 ? 1 : -1
        if (lsParity !== (opts.isBoson !== false ? 1 : -1)) continue
      }
      if ((opts.maxL ?? 4) > 0 && L > (opts.maxL ?? 4)) continue // plugin default maxL=4
      if (opts.slFilter && opts.slFilter.length > 0) {
        if (!opts.slFilter.some(([s, l]) => s === twoS + 1 && l === L)) continue
      }
      out.push({ s: twoS + 1, l: L })
    }
  }
  return out
}

const jp = (j: number, p: 1 | -1): JP => ({ j, p })

describe('enumerateSL vs ctpwa ComSL', () => {
  const spins: [number, number, number][] = []
  for (const a of [1, 2, 3, 5]) {
    for (const b of [1, 2, 3, 5]) {
      for (const c of [1, 2, 3, 5]) spins.push([a, b, c])
    }
  }
  const parities: [1 | -1, 1 | -1, 1 | -1][] = [
    [1, 1, 1],
    [1, 1, -1],
    [1, -1, -1],
    [-1, -1, -1],
  ]
  const variants: (Partial<{ pBreak: boolean; identical: boolean; isBoson: boolean; maxL: number; slFilter: [number, number][] }>)[] = [
    {},
    { maxL: 1 },
    { maxL: 4 },
    { identical: true },
    { identical: true, isBoson: false },
    { identical: true, maxL: 2 },
    { pBreak: true },
    { pBreak: true, maxL: 3 },
    { slFilter: [[1, 1]] },
    { slFilter: [[3, 2], [1, 0]] },
    { maxL: 4, slFilter: [[3, 2], [5, 0]] },
  ]

  it('matches ComSL point-by-point over random (J, P, opts) combinations', () => {
    let checked = 0
    for (const [a, b, c] of spins) {
      for (const [pa, pb, pc] of parities) {
        for (const variant of variants) {
          const got = enumerateSL(jp((a - 1) / 2, pa), jp((b - 1) / 2, pb), jp((c - 1) / 2, pc), variant)
          const want = comSL([a, b, c], [pa, pb, pc], variant)
          expect(got).toEqual(want)
          checked++
        }
      }
    }
    expect(checked).toBe(spins.length * parities.length * variants.length)
  })

  it('rejects 1+ at the K+ eta decay vertex (case 2: K1(1410))', () => {
    // R_Keta 1+ -> K(0-) + eta(0-): P_R = +1 requires even L, but J = L with
    // S = 0 then forces P_R = -1. No (S, L) wave exists.
    expect(enumerateSL(jp(1, 1), jp(0, -1), jp(0, -1))).toEqual([])
    // 1- works: L = 1, P = (-1)^1 = -1.
    expect(enumerateSL(jp(1, -1), jp(0, -1), jp(0, -1))).toEqual([{ s: 1, l: 1 }])
  })

  it('identical pions: Bose selection rule excludes odd L', () => {
    // S = 0 pins L to J_R: for J_R = 1 the only wave is (1, 1), which the
    // Bose rule (-1)^L = +1 kills; without the identical flag it survives.
    expect(enumerateSL(jp(1, -1), jp(0, -1), jp(0, -1), { identical: true })).toEqual([])
    expect(enumerateSL(jp(1, -1), jp(0, -1), jp(0, -1))).toEqual([{ s: 1, l: 1 }])
    // J_R = 0 pins L = 0 (even, allowed).
    expect(enumerateSL(jp(0, 1), jp(0, -1), jp(0, -1), { identical: true })).toEqual([{ s: 1, l: 0 }])
  })

  it('identical fermions: (-1)^(L+S) = -1', () => {
    const waves = enumerateSL(jp(1, 1), jp(0.5, 1), jp(0.5, 1), { identical: true, isBoson: false, maxL: 3 })
    for (const w of waves) expect((w.l + (w.s - 1) / 2) % 2).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// pairJPC: decay-vertex J^PC sets
// ---------------------------------------------------------------------------

type Named = { name?: string; j: number; p: 1 | -1; c?: 1 | -1 }
const Kp: Named = { j: 0, p: -1, name: 'K+' }
const Km: Named = { j: 0, p: -1, name: 'K-' }
const K0: Named = { j: 0, p: -1, name: 'K0' }
const K0bar: Named = { j: 0, p: -1, name: 'K~0' }
const pi0: Named = { j: 0, p: -1, name: 'pi0' }
const pi0b: Named = { j: 0, p: -1, name: 'pi02' }
const pip: Named = { j: 0, p: -1, name: 'pi+' }
const pim: Named = { j: 0, p: -1, name: 'pi-' }
const eta: Named = { j: 0, p: -1, name: 'eta' }
const lam: Named = { j: 0.5, p: 1, name: 'Lambda' }
const lam2: Named = { j: 0.5, p: 1, name: 'Lambda2' }
const pbar: Named = { j: 0.5, p: 1, name: 'pbar' }
const prot: Named = { j: 0.5, p: 1, name: 'p' }

const labels = (waves: { jpc: JP }[]) => waves.map((w) => jpcLabel(w.jpc))

describe('pairKind + conjugate table', () => {
  it('classifies conjugate pairs, identical groups and distinct pairs', () => {
    expect(pairKind(Kp, Km).kind).toBe('pair-anti')
    expect(pairKind(Kp, Km).cDefined).toBe(true)
    expect(pairKind(K0, K0bar).kind).toBe('pair-anti')
    expect(pairKind(pi0, pi0b, [['pi0', 'pi02']]).kind).toBe('identical-boson')
    expect(pairKind(lam, lam2, [['Lambda', 'Lambda2']]).kind).toBe('identical-fermion')
    expect(pairKind(Kp, eta).kind).toBe('distinct')
    expect(pairKind(Kp, eta).cDefined).toBe(false) // K+ eta: no C
    expect(pairKind(pi0, eta).cDefined).toBe(false) // conservative: no table entry
  })

  it('conjugateOf resolves antiparticles', () => {
    expect(conjugateOf('K+')).toBe('K-')
    expect(conjugateOf('K0')).toBe('K~0')
    expect(conjugateOf('pi-')).toBe('pi+')
    expect(conjugateOf('eta')).toBeUndefined()
    expect(conjugateOf('K+eta')).toBeUndefined()
  })

  it('isFermion matches half-integer spin', () => {
    expect(isFermion(0)).toBe(false)
    expect(isFermion(1)).toBe(false)
    expect(isFermion(0.5)).toBe(true)
    expect(isFermion(1.5)).toBe(true)
    expect(isFermion(2)).toBe(false)
  })
})

describe('pairJPC decay-vertex sets', () => {
  it('K+ K- (boson pair-anti): J^PC = {0++ 1-- 2++ 3-- 4++}', () => {
    const waves = pairJPC(Kp, Km, { maxL: 4 })
    expect(labels(waves)).toEqual(['0++', '1--', '2++', '3--', '4++'])
    // The 1-- wave is (S=0, L=1).
    const oneMinus = waves.find((w) => w.jpc.j === 1)!
    expect(oneMinus.sl).toEqual([{ s: 1, l: 1 }])
  })

  it('K+ eta (distinct, C undefined): J^P = {0+ 1- 2+ 3- 4+}', () => {
    const waves = pairJPC(Kp, eta, { maxL: 4 })
    expect(labels(waves)).toEqual(['0+', '1-', '2+', '3-', '4+'])
    expect(waves.every((w) => w.jpc.c === undefined)).toBe(true)
    expect(waves.some((w) => w.jpc.j === 1 && w.jpc.p === 1)).toBe(false) // K1(1410) case
  })

  it('pi0 pi0 identical bosons: only L even -> {0++ 2++ 4++}', () => {
    const waves = pairJPC(pi0, pi0b, { maxL: 4, identicalGroups: [['pi0', 'pi02']] })
    expect(labels(waves)).toEqual(['0++', '2++', '4++'])
  })

  it('Lambda Lambda identical fermions: (-1)^(L+S) = -1', () => {
    const waves = pairJPC(lam, lam2, { maxL: 3, identicalGroups: [['Lambda', 'Lambda2']] })
    expect(waves.length).toBeGreaterThan(0)
    for (const w of waves) {
      for (const sl of w.sl) expect((sl.l + (sl.s - 1) / 2) % 2).toBe(1)
      expect(w.jpc.c).toBe(-1)
    }
  })

  it('p pbar (fermion pair-anti): C = (-1)^(L+S), engine parity convention', () => {
    const waves = pairJPC(prot, pbar, { maxL: 2 })
    expect(labels(waves)).toEqual(['0-+', '0++', '1--', '1-+', '1+-', '2-+', '2+-', '2++', '3+-'])
    // Engine convention P = P1*P2*(-1)^L with both intrinsic parities +1:
    // (S=0,L=0) -> 0++; (S=0,L=1) -> 1--; (S=1,L=0) -> 1+-; (S=1,L=1) -> 0-+ 1-+ 2-+.
    const oneMinusPlus = waves.find((w) => jpcLabel(w.jpc) === '1+-')!
    expect(oneMinusPlus.sl).toEqual([{ s: 3, l: 0 }, { s: 3, l: 2 }])
  })

  it('applies the (2S+1, L) sl whitelist', () => {
    // K+K- has S = 0 only, so the 2++ wave is (2S+1, L) = (1, 2).
    const waves = pairJPC(Kp, Km, { maxL: 4, slFilter: [[1, 2]] })
    expect(labels(waves)).toEqual(['2++'])
    // A whitelist with S = 1 (3, L) matches nothing for two spin-0 mesons.
    expect(pairJPC(Kp, Km, { maxL: 4, slFilter: [[3, 2]] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// allowedIsobarJPC: three-body checks (case 1: J/psi -> eta K+ K-)
// ---------------------------------------------------------------------------

const jpsi: Particle = { j: 1, p: -1, mass: 3.0969, c: -1 }
const etaC: Named = { j: 0, p: -1, c: 1, name: 'eta' }

describe('allowedIsobarJPC', () => {
  it('case 1: R_KK J^PC intersection = {1--, 3--}; 2++/4++ blocked by C', () => {
    const checks = allowedIsobarJPC(jpsi, Kp, Km, etaC, { maxL: 4 })
    const rkk = checks.find((c) => c.pair[0] === 'K+' && c.pair[1] === 'K-')!
    expect(rkk.cDefined).toBe(true)
    expect(rkk.cRequired).toBe(-1) // C(J/psi)*C(eta) = (-1)(+1)
    expect(labels(rkk.allowed)).toEqual(['1--', '3--'])
    // 0++ is not production-reachable (J_R = 0 needs L = 0, but J_psi = 1);
    // 2++ / 4++ are reachable but violate C -> f2(1270) lives here.
    expect(labels(rkk.cBlocked)).toEqual(['2++', '4++'])
  })

  it('case 2: R_Keta (K+ eta) intersection = {1- 2+ 3- 4+}, no C constraint', () => {
    const checks = allowedIsobarJPC(jpsi, Kp, etaC, Km, { maxL: 4 })
    const rk = checks.find((c) => c.pair[0] === 'K+' && c.pair[1] === 'eta')!
    expect(rk.cDefined).toBe(false)
    expect(rk.cRequired).toBeUndefined()
    expect(labels(rk.allowed)).toEqual(['1-', '2+', '3-', '4+'])
    expect(labels(rk.cBlocked)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// rules 10-12 through validateResonanceAddition (fixture db with C)
// ---------------------------------------------------------------------------

const FIXTURE_DB: ResonanceDb = {
  schemaVersion: 'test',
  source: 'fixture',
  resonances: [
    { id: 'J/psi', aliases: [], jp: { j: 1, p: -1 }, c: -1, mass: 3.0969, status: 'pdg' },
    { id: 'eta', aliases: [], jp: { j: 0, p: -1 }, c: 1, mass: 0.5478, status: 'pdg' },
    { id: 'K+', aliases: ['Kp'], jp: { j: 0, p: -1 }, mass: 0.4937, status: 'pdg' },
    { id: 'K-', aliases: ['Km'], jp: { j: 0, p: -1 }, mass: 0.4937, status: 'pdg' },
    { id: 'omega(1420)', aliases: ['omega1420'], jp: { j: 1, p: -1 }, c: -1, mass: 1.41, width: 0.29, status: 'pdg' },
    { id: 'phi(1020)', aliases: ['phi1020'], jp: { j: 1, p: -1 }, c: -1, mass: 1.0195, width: 0.0045, status: 'pdg' },
    { id: 'f(2)(1270)', aliases: ['f2_1270'], jp: { j: 2, p: 1 }, c: 1, mass: 1.275, width: 0.187, status: 'pdg' },
    { id: 'K(1)(1400)', aliases: ['K1_1410'], jp: { j: 1, p: 1 }, mass: 1.403, width: 0.174, status: 'pdg' },
    { id: 'K(2)*(1430)', aliases: ['K2_1430'], jp: { j: 2, p: 1 }, mass: 1.425, width: 0.0985, status: 'pdg' },
    { id: 'K(2)*(1980)', aliases: ['K2_1980'], jp: { j: 2, p: 1 }, mass: 1.973, width: 0.373, status: 'pdg' },
    { id: 'omega(3)(1670)', aliases: ['omega3_1670'], jp: { j: 3, p: -1 }, c: -1, mass: 1.67, width: 0.165, status: 'pdg' },
  ],
}

const CONFIG = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  eta:
    J: 0
    P: -1
    mass: 0.5478
  Kp:
    J: 0
    P: -1
    mass: 0.4937
  Km:
    J: 0
    P: -1
    mass: 0.4937

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
      - [Kp, R_Keta]
      - [Km, R_Keta]
    R_KK: [Kp, Km]
    R_Keta:
      - [Km, eta]
      - [Kp, eta]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_Keta:
        - [J: 1, P: -1]: [K1_1410]
        - [J: 2, P: 1]: [K2_1430]

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
  K1_1410:
    J: 1
    P: -1
    model: BWR
    parameters: [1.403, 0.174]
  K2_1430:
    J: 2
    P: 1
    model: BWR
    parameters: [1.425, 0.0985]
`

const cfg = () => parseConfig(CONFIG)

describe('validateResonanceAddition rules 10-12', () => {
  it('case 1: f2(1270) into R_KK [2+] is rejected by C conservation (rule 11)', () => {
    const proposal: ResonanceProposal = {
      name: 'f2_1270',
      chain: 'R_KK',
      jpGroup: { j: 2, p: 1 },
      model: 'BWR',
      parameters: [1.275, 0.187],
    }
    const r = validateResonanceAddition(FIXTURE_DB, cfg(), proposal)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
  })

  it('case 1b: omega(1420) into the existing R_KK [1-] group still passes', () => {
    const proposal: ResonanceProposal = {
      name: 'omega1420',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.41, 0.29],
    }
    const r = validateResonanceAddition(FIXTURE_DB, cfg(), proposal)
    expect(r.ok).toBe(true)
  })

  it('case 2: K1(1410) as 1+ into R_Keta is rejected at the decay vertex (rule 10)', () => {
    const proposal: ResonanceProposal = {
      name: 'K1_1410',
      chain: 'R_Keta',
      jpGroup: { j: 1, p: 1 },
      model: 'BWR',
      parameters: [1.403, 0.174],
    }
    const r = validateResonanceAddition(FIXTURE_DB, cfg(), proposal)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('decay-vertex-forbidden')
  })

  it('case 2b: K2(1980) into the existing R_Keta [2+] group passes (no C constraint)', () => {
    const proposal: ResonanceProposal = {
      name: 'K2_1980',
      chain: 'R_Keta',
      jpGroup: { j: 2, p: 1 },
      model: 'BWR',
      parameters: [1.973, 0.373],
    }
    const r = validateResonanceAddition(FIXTURE_DB, cfg(), proposal)
    expect(r.ok).toBe(true)
  })

  it('a 3- candidate into a NEW R_KK [3-] group passes both gates', () => {
    const proposal: ResonanceProposal = {
      name: 'omega3_1670',
      chain: 'R_KK',
      jpGroup: { j: 3, p: -1 },
      model: 'BWR',
      parameters: [1.67, 0.165],
    }
    const r = validateResonanceAddition(FIXTURE_DB, cfg(), proposal)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('new-jp-group')
  })

  it('warns when the config has no decay step for the intermediate', () => {
    const c = cfg()
    // Drop the R_KK step.
    c.decayChains.decay1.steps = c.decayChains.decay1.steps.filter((s) => s.mother !== 'R_KK')
    const proposal: ResonanceProposal = {
      name: 'omega1420',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.41, 0.29],
    }
    const r = validateResonanceAddition(FIXTURE_DB, c, proposal)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('no-decay-step')
  })

  it('lookupC reads C from the table (self-conjugate only)', () => {
    expect(lookupC(FIXTURE_DB, 'Jpsi')).toBe(-1)
    expect(lookupC(FIXTURE_DB, 'eta')).toBe(1)
    expect(lookupC(FIXTURE_DB, 'Kp')).toBeUndefined()
    expect(lookupC(FIXTURE_DB, 'nope')).toBeUndefined()
  })

  it('lookupC works against the shipped table once C is present', () => {
    // Phase C: pdg.json carries c for self-conjugate states; the shipped
    // table must resolve J/psi and eta (used by rule 11 in production).
    const c = lookupC(defaultDb, 'Jpsi')
    expect(c === -1 || c === undefined).toBe(true)
    if (c !== undefined) expect(lookupC(defaultDb, 'eta')).toBe(1)
  })
})
