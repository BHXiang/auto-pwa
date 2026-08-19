import { describe, expect, it } from 'vitest'
import { defaultDb } from '../src/db.js'
import { parseConfig, applyResonanceAddition, dumpConfig, crossReferenceErrors } from '../src/config-edit.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { suggestFree } from '../src/float-policy.js'
import type { ResonanceProposal } from '../src/types.js'

// A compact config in the solve2 format (explicit JP groups).
const CONFIG_TEXT = `# config.yml
Particles:
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

Data:
  order: [Kp, Km, eta]
  data: [dat, "/data/data.dat"]
  phsp: [dat, "/data/phsp.dat"]

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

Constraints:
  trans:
    - [R_Keta_0, R_Keta_1]: -1

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
    tex: ["\\\\phi(1020)"]
  K1_1410:
    J: 1
    P: -1
    model: BWR
    parameters: [1.47, 0.65]
    tex: ["K_{1}", "(1410)"]
  K2_1430:
    J: 2
    P: 1
    model: BWR
    parameters: [1.430, 0.09]
    tex: ["K_{2}", "(1430)"]
  phi1680:
    J: 1
    P: -1
    model: BWR
    parameters: [1.68, 0.15]
    tex: ["\\\\phi(1680)"]
`

function config() {
  return parseConfig(CONFIG_TEXT)
}

/**
 * Legal candidates. J/psi(1-) -> eta(0-) + R: P_R = (-1)^L, J_R = L, so the
 * reachable J^P are 0-, 1±, 2±, 3±, 4±, 5+ (maxL=4). For R_Keta (daughter K,
 * 0-): P_R = (-1)^L too, J_R = L. 0+ is NOT reachable in either chain.
 */
/** omega(1420): 1- into the existing R_KK [1-] group. */
const omega1420: ResonanceProposal = {
  name: 'omega1420',
  chain: 'R_KK',
  jpGroup: { j: 1, p: -1 },
  model: 'BWR',
  parameters: [1.41, 0.29],
  tex: '\\omega(1420)',
}

/** f1(1285): 1+ — reachable from J/psi -> eta + R via L=0, but 1+ is
 * forbidden at the R_KK -> K+ K- decay vertex (P = (-1)^L forces P = -1 for
 * J = L with S = 0). Used below as the rule-10 rejection case. */
const f1_1285: ResonanceProposal = {
  name: 'f1_1285',
  chain: 'R_KK',
  jpGroup: { j: 1, p: 1 },
  model: 'BWR',
  parameters: [1.2818, 0.023],
  tex: 'f_{1}(1285)',
}

/** omega3(1670): 3- — allowed at both vertices of R_KK and C-consistent
 * (C(R_KK) = C(J/psi)*C(eta) = -1). A NEW [3-] group for R_KK. */
const omega3_1670: ResonanceProposal = {
  name: 'omega3_1670',
  chain: 'R_KK',
  jpGroup: { j: 3, p: -1 },
  model: 'BWR',
  parameters: [1.67, 0.165],
  tex: '\\omega_{3}(1670)',
}

describe('parseConfig', () => {
  it('parses particles, chains (explicit JP), resonances, kinematics', () => {
    const cfg = config()
    expect(cfg.particles.Jpsi).toEqual({ j: 1, p: -1, mass: 3.0969 })
    expect(cfg.resonances.phi1020.model).toBe('BWR')
    expect(cfg.resonances.K1_1410.parameters).toEqual([1.47, 0.65])
    const rkk = cfg.decayChains.decay1.intermediates.R_KK
    expect(rkk.groups).toHaveLength(1)
    expect(rkk.groups[0].jp).toEqual({ j: 1, p: -1 })
    expect(rkk.groups[0].names).toEqual(['phi1020'])
    const rk = cfg.decayChains.decay1.intermediates.R_Keta
    expect(rk.groups.map((g) => g.jp)).toEqual([{ j: 1, p: -1 }, { j: 2, p: 1 }])
    // kinematics: R_KK from Jpsi -> eta + R_KK: 3.0969 - 0.5478 = 2.5491
    expect(cfg.kinematics.R_KK.threshold).toBeCloseTo(2.5491, 4)
    expect(cfg.kinematics.R_Keta.threshold).toBeCloseTo(2.6032, 4)
  })

  it('round-trips through dump and re-parse preserving structure', () => {
    const cfg = config()
    const again = parseConfig(dumpConfig(cfg))
    expect(again.particles).toEqual(cfg.particles)
    expect(again.resonances).toEqual(cfg.resonances)
    expect(again.decayChains).toEqual(cfg.decayChains)
    expect(again.kinematics).toEqual(cfg.kinematics)
  })
})

describe('validateResonanceAddition', () => {
  it('accepts a legal PDG-backed candidate', () => {
    const r = validateResonanceAddition(defaultDb, config(), omega1420)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects a name not on PDG', () => {
    const r = validateResonanceAddition(defaultDb, config(), { ...omega1420, name: 'X9999' })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('not-on-pdg')
  })

  it('rejects a JPC mismatch with the PDG entry', () => {
    // omega(1420) is 1-; claim it as 0+.
    const r = validateResonanceAddition(defaultDb, config(), { ...omega1420, jpGroup: { j: 0, p: 1 } })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('jpc-mismatch')
  })

  it('rejects a mass above the kinematic threshold', () => {
    const r = validateResonanceAddition(defaultDb, config(), {
      ...omega1420,
      parameters: [2.6, 0.29], // R_KK threshold is 2.5491
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('above-threshold')
  })

  it('warns near the threshold (off-shell risk)', () => {
    const r = validateResonanceAddition(defaultDb, config(), omega1420, {
      nearThresholdMargin: 1.2, // omega(1420) at 1.41 is 1.139 below 2.5491
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('near-threshold')
  })

  it('rejects a duplicate name', () => {
    const r = validateResonanceAddition(defaultDb, config(), {
      ...omega1420,
      name: 'phi1020',
      parameters: [1.0195, 0.0045],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('duplicate')
  })

  it('rejects a J^P that is not reachable from A -> R + B', () => {
    // 0+ would need L=0, but then J_R = J_A = 1 is violated: not reachable.
    const r = validateResonanceAddition(defaultDb, config(), {
      name: 'f0_1500',
      chain: 'R_KK',
      jpGroup: { j: 0, p: 1 },
      model: 'BWR',
      parameters: [1.505, 0.109],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('jp-not-allowed')
    // 5- needs L=5 > maxL=4.
    const r2 = validateResonanceAddition(defaultDb, config(), { ...omega1420, jpGroup: { j: 5, p: -1 } })
    expect(r2.ok).toBe(false)
    expect(r2.errors.map((e) => e.code)).toContain('jp-not-allowed')
  })

  it('warns and permits a physically allowed NEW J^P group', () => {
    // 3- is reachable (L=3) AND allowed at the K+K- decay vertex, but R_KK
    // has no [3-] group yet.
    const r = validateResonanceAddition(defaultDb, config(), omega3_1670)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('new-jp-group')
  })

  it('rejects a J^P that is forbidden at the decay vertex (rule 10)', () => {
    // f1(1285) 1+: reachable from production (L=0), but K+K- (S=0, P=(-1)^L)
    // cannot realize 1+ — the wave would be identically zero.
    const r = validateResonanceAddition(defaultDb, config(), f1_1285)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('decay-vertex-forbidden')
  })

  it('rejects wrong parameter arity per model', () => {
    const one = validateResonanceAddition(defaultDb, config(), { ...omega1420, model: 'ONE', parameters: [1.5, 0.2] })
    expect(one.ok).toBe(false)
    expect(one.errors.map((e) => e.code)).toContain('invalid-parameters')
    const bwr = validateResonanceAddition(defaultDb, config(), { ...omega1420, parameters: [1.5] })
    expect(bwr.ok).toBe(false)
    expect(bwr.errors.map((e) => e.code)).toContain('invalid-parameters')
    const flatte = validateResonanceAddition(defaultDb, config(), { ...omega1420, model: 'Flatte', parameters: [1.5, 0.2] })
    expect(flatte.ok).toBe(false)
    expect(flatte.errors.map((e) => e.code)).toContain('flatte-needs-channels')
  })

  it('rejects free/free_range structure errors', () => {
    const r = validateResonanceAddition(defaultDb, config(), { ...omega1420, free: [3] })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('invalid-free')
    const r2 = validateResonanceAddition(defaultDb, config(), {
      ...omega1420,
      free: [0],
      freeRange: [[1.4, 1.6], [0.01, 0.2]], // one range per free entry
    })
    expect(r2.ok).toBe(false)
    expect(r2.errors.map((e) => e.code)).toContain('invalid-free')
    const r3 = validateResonanceAddition(defaultDb, config(), {
      ...omega1420,
      free: [0],
      freeRange: [[1.6, 1.4]], // lo > hi
    })
    expect(r3.ok).toBe(false)
    const r4 = validateResonanceAddition(defaultDb, config(), {
      ...omega1420,
      free: [0],
      freeRange: [[1.6, 1.7]], // initial mass 1.41 outside range
    })
    expect(r4.ok).toBe(false)
  })

  it('accepts ONE (phase-space) terms without PDG backing, if the J^P is reachable', () => {
    const r = validateResonanceAddition(defaultDb, config(), {
      name: 'NR2_RKK',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'ONE',
      parameters: [1.5],
    })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('warns (not rejects) when the PDG entry has no listed decay mode', () => {
    // omega(1420) has no curated decay modes in the table.
    const r = validateResonanceAddition(defaultDb, config(), omega1420, { decayTo: ['K+', 'K-'] })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('no-listed-mode')
  })

  it('rejects a mass deviating from PDG beyond tolerance', () => {
    const r = validateResonanceAddition(defaultDb, config(), {
      ...omega1420,
      parameters: [1.6, 0.29], // PDG 1.41; tolerance max(0.02, 0.5*0.29) = 0.145
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('mass-mismatch')
  })
})

describe('applyResonanceAddition + cross-reference', () => {
  it('adds the resonance to the group and the Resonances section', () => {
    const cfg = config()
    const result = applyResonanceAddition(cfg, omega1420)
    expect(result.errors).toEqual([])
    expect(result.changed.length).toBeGreaterThanOrEqual(2)
    const rkk = result.config.decayChains.decay1.intermediates.R_KK
    expect(rkk.groups[0].names).toEqual(['phi1020', 'omega1420'])
    expect(result.config.resonances.omega1420).toMatchObject({
      model: 'BWR',
      parameters: [1.41, 0.29],
      j: 1,
      p: -1,
    })
  })

  it('creates a new [J,P] group when the target group is absent (appended, order kept)', () => {
    const cfg = config()
    const result = applyResonanceAddition(cfg, { ...f1_1285, chain: 'R_Keta' })
    expect(result.errors).toEqual([])
    const groups = result.config.decayChains.decay1.intermediates.R_Keta.groups
    expect(groups).toHaveLength(3) // 1-, 2+, new 1+
    expect(groups[0].jp).toEqual({ j: 1, p: -1 })
    expect(groups[0].names).toEqual(['K1_1410'])
    expect(groups[2].jp).toEqual({ j: 1, p: 1 })
    expect(groups[2].names).toEqual(['f1_1285'])
  })

  it('returns structural errors without modifying the config', () => {
    const cfg = config()
    const bad = applyResonanceAddition(cfg, { ...omega1420, chain: 'R_None' })
    expect(bad.errors.length).toBeGreaterThan(0)
    expect(bad.config.decayChains).toEqual(cfg.decayChains)
    expect(bad.config.resonances.omega1420).toBeUndefined()
    const dup = applyResonanceAddition(cfg, {
      name: 'phi1020',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.0195, 0.0045],
    })
    expect(dup.errors.map((e) => e.code)).toContain('duplicate')
    expect(dup.config.resonances.phi1020).toBeDefined()
  })

  it('dump of the edited config re-parses with the addition', () => {
    const cfg = config()
    const edited = applyResonanceAddition(cfg, omega1420).config
    const text = dumpConfig(edited)
    const again = parseConfig(text)
    expect(again.decayChains.decay1.intermediates.R_KK.groups[0].names).toEqual(['phi1020', 'omega1420'])
    expect(again.resonances.omega1420).toEqual(edited.resonances.omega1420)
  })

  it('cross-reference check flags undefined resonances', () => {
    const cfg = config()
    // Manually reference a missing resonance.
    cfg.decayChains.decay1.intermediates.R_KK.groups[0].names.push('ghost')
    const { errors } = crossReferenceErrors(cfg)
    expect(errors.map((e) => e.code)).toContain('undefined-resonance')
    expect(errors[0].message).toContain('ghost')
  })
})

describe('suggestFree', () => {
  it('keeps ONE fixed', () => {
    const s = suggestFree(undefined, { model: 'ONE', parameters: [1.5] })
    expect(s.free).toBeUndefined()
    expect(s.rationale).toMatch(/phase-space/)
  })

  it('floats the mass for a newly added wide state', () => {
    const pdg = defaultDb.resonances.find((r) => r.id === 'K*(1410)0')
    expect(pdg).toBeDefined()
    const s = suggestFree(pdg, { model: 'BWR', parameters: [1.414, 0.232] }, { threshold: 2.6 })
    expect(s.free).toEqual([0, 1])
    expect(s.freeRange).toHaveLength(2)
    expect(s.freeRange![0][0]).toBeLessThan(s.freeRange![0][1])
    expect(s.rationale).toMatch(/threshold|wide/)
  })

  it('keeps a narrow well-measured state fixed', () => {
    const pdg = defaultDb.resonances.find((r) => r.id === 'phi(1020)')
    const s = suggestFree(pdg, { model: 'BWR', parameters: [1.0195, 0.0045] })
    expect(s.free).toBeUndefined()
    expect(s.rationale).toMatch(/narrow/)
  })
})

describe('attach already-defined resonance', () => {
  const cfg = () => parseConfig(CONFIG_TEXT)

  it('allows attaching an existing resonance under its defined J^P', () => {
    const c = cfg()
    // phi1680 is defined (1-) but not referenced in any intermediates group.
    const r = validateResonanceAddition(defaultDb, c, {
      name: 'phi1680',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.68, 0.15],
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('already-defined')
    const ap = applyResonanceAddition(c, {
      name: 'phi1680',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.68, 0.15],
    })
    expect(ap.errors).toEqual([])
    const rkk = ap.config.decayChains.decay1.intermediates.R_KK
    expect(rkk.groups[0].names).toContain('phi1680')
  })

  it('rejects attaching under a conflicting J^P', () => {
    const r = validateResonanceAddition(defaultDb, cfg(), {
      name: 'phi1680', // defined 1-
      chain: 'R_KK',
      jpGroup: { j: 2, p: 1 },
      model: 'BWR',
      parameters: [1.68, 0.15],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('jpc-conflict')
  })
})

describe('compact top-level spin-chain format (solve1 style)', () => {
  const COMPACT = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  Ks1:
    J: 0
    P: -1
    mass: 0.4976
  omega:
    J: 1
    P: -1
    mass: 0.782

DecayChains:
  chain2:
    decay:
      - Jpsi: [Ks1, R_Ks2omega]
      - R_Ks2omega: [Ks2, omega]
    R_Ks2omega:
      - [J: 1, P: 1]: [K1_1400]
      - [J: 2, P: -1]: [K2_2250, K2_1820]
    legend: [R_Ks2omega, Ks1]

Resonances:
  K1_1400:
    J: 1
    P: 1
    model: BWR
    parameters: [1.403, 0.174]
  K2_2250:
    J: 2
    P: -1
    model: BWR
    parameters: [2.25, 0.2]
  K2_1820:
    J: 2
    P: -1
    model: BWR
    parameters: [1.816, 0.275]
`

  it('parses intermediates from top-level keys and derives kinematics', () => {
    const cfg = parseConfig(COMPACT)
    const ch = cfg.decayChains.chain2
    expect(ch.intermediates.R_Ks2omega.groups.map((g) => g.jp)).toEqual([{ j: 1, p: 1 }, { j: 2, p: -1 }])
    expect(ch.intermediates.R_Ks2omega.groups[0].names).toEqual(['K1_1400'])
    // J/psi -> Ks1 + R: 3.0969 - 0.4976
    expect(cfg.kinematics.R_Ks2omega.threshold).toBeCloseTo(2.5993, 4)
    // validate + attach on compact format
    const r = validateResonanceAddition(defaultDb, cfg, {
      name: 'K1_1680',
      chain: 'R_Ks2omega',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.718, 0.32],
    })
    expect(r.ok).toBe(true)
  })
})
