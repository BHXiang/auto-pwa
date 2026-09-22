import { describe, expect, it } from 'vitest'
import { defaultDb } from '../src/db.js'
import { allowedIntermediateJP, decayCheck } from '../src/decay-check.js'
import { pairJPC } from '../src/jpc.js'
import { parseConfig, validateConfig, applyResonanceAddition } from '../src/config-edit.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import type { Particle } from '../src/types.js'

/**
 * Half-integer angular momentum (baryon resonances).
 *
 * psip -> gamma + chi_c0, chi_c0 -> N* + pbar, N* -> p + eta.
 * chi_c0 has J^P = 0+, pbar/proton J^P = 1/2, eta 0-: the production vertex
 * chi_c0 -> N* + pbar can ONLY reach half-integer J_R. Before the fix the
 * enumeration loop scanned integer J_R only and returned an EMPTY set, so
 * every N* or Delta* proposal was rejected by the J^P reachability gate.
 */

const chic0: Particle = { j: 0, p: 1, mass: 3.41471 }
const pbar: Particle = { j: 0.5, p: -1, mass: 0.938272 }
const proton: Particle = { j: 0.5, p: 1, mass: 0.938272 }
const eta: Particle = { j: 0, p: -1, mass: 0.547862 }
const jpsi: Particle = { j: 1, p: -1, mass: 3.0969 }
const kaon: Particle = { j: 0, p: -1, mass: 0.4937 }

const find = (allowed: ReturnType<typeof allowedIntermediateJP>, j: number, p: 1 | -1) =>
  allowed.find((a) => a.jp.j === j && a.jp.p === p)

const by = (candidates: ReturnType<typeof decayCheck>['candidates'], j: number, p: 1 | -1) =>
  candidates.find((c) => c.jp.j === j && c.jp.p === p)?.resonances.map((r) => r.entry.id) ?? []

describe('allowedIntermediateJP: baryon production (half-integer J_R)', () => {
  it('non-empty and half-integer-only for a half-integer spectator', () => {
    const allowed = allowedIntermediateJP(chic0, pbar, 4)
    expect(allowed.length).toBeGreaterThan(0)
    expect(allowed.every((a) => !Number.isInteger(a.jp.j))).toBe(true)
    // twoJ must be odd (0.5 grid), never an integer spin.
    expect(allowed.every((a) => Math.round(a.jp.j * 2) % 2 === 1)).toBe(true)
  })

  it('reaches N(1720) 3/2+ and N(1520) 3/2- with the expected L', () => {
    const allowed = allowedIntermediateJP(chic0, pbar, 4)
    // P_R = P_chic0 * P_pbar * (-1)^L = -(-1)^L: even L -> 3/2-, odd L -> 3/2+.
    expect(find(allowed, 1.5, 1)?.L).toContain(1)
    expect(find(allowed, 1.5, -1)?.L).toContain(2)
    expect(find(allowed, 0.5, -1)?.L).toContain(0)
    expect(find(allowed, 2.5, 1)?.L).toContain(3)
  })

  it('leaves the integer-spin spectrum intact', () => {
    const allowed = allowedIntermediateJP(jpsi, kaon, 4)
    expect(allowed.every((a) => Number.isInteger(a.jp.j))).toBe(true)
    expect(find(allowed, 1, -1)?.L).toContain(1)
    expect(find(allowed, 1, 1)?.L).toContain(0)
    expect(find(allowed, 0, -1)?.L).toEqual([1])
  })

  it('finds the N* candidates below the kinematic threshold', () => {
    const res = decayCheck(chic0, pbar, defaultDb, { maxL: 4, decayTo: ['p', 'eta'] })
    expect(by(res.candidates, 1.5, 1)).toContain('N(1720)+')
    expect(by(res.candidates, 1.5, -1)).toContain('N(1520)+')
    expect(by(res.candidates, 0.5, -1)).toContain('N(1535)+')
  })
})

describe('pairJPC: fermion daughter pair (even 2S+1)', () => {
  it('p + eta has S = 1/2 only: 2S+1 = 2, with half-integer J', () => {
    const waves = pairJPC({ name: 'p', ...proton }, { name: 'eta', ...eta }, { maxL: 4 })
    expect(waves.length).toBeGreaterThan(0)
    expect(waves.every((w) => w.sl.every((s) => s.s === 2))).toBe(true)
    expect(waves.every((w) => !Number.isInteger(w.jpc.j))).toBe(true)
    // The internal (2S+1, L) whitelist uses 2, not the old "odd only" rule.
    // L=1, S=1/2 couples to J = 1/2 and 3/2, both with P = +1.
    expect(pairJPC({ name: 'p', ...proton }, { name: 'eta', ...eta }, { maxL: 4, slFilter: [[2, 1]] }))
      .toHaveLength(2)
    expect(pairJPC({ name: 'p', ...proton }, { name: 'eta', ...eta }, { maxL: 4, slFilter: [[1, 1]] }))
      .toEqual([])
  })
})

// ---------------------------------------------------------------------------
// config parsing / structural gate
// ---------------------------------------------------------------------------

const BARYON_CONFIG = `
Particles:
  psip:  {J: 1, P: -1, mass: 3.686}
  gamma: {J: 1, P: -1, mass: 0.0}
  eta:   {J: 0, P: -1, mass: 0.547862}
  p:     {J: 0.5, P: 1, mass: 0.938272}
  pbar:  {J: 0.5, P: -1, mass: 0.938272}
DecayChains:
  chain1:
    psip:
      - [gamma, R_chicj, {ls: [1, 1]}]
    R_chicj:
      - [R_peta, pbar]
    R_peta:
      - [p, eta, {sl: [0.5, 1]}]
    intermediates:
      R_chicj:
        - [J: 0, P: 1]: [chic0]
      R_peta:
        - [J: 1.5, P: 1]: [N1720]
Resonances:
  chic0:
    J: 0
    P: 1
    model: ONE
    parameters: [3.41471]
  N1720:
    J: 1.5
    P: 1
    model: BW
    parameters: [1.72, 0.25]
`

describe('config: half-integer spin parsing and sl gate', () => {
  it('parses J: 0.5 / J: 1.5 and physical-S sl/ls into internal {2S+1, L}', () => {
    const cfg = parseConfig(BARYON_CONFIG)
    expect(cfg.particles.p?.j).toBe(0.5)
    expect(cfg.resonances.N1720?.j).toBe(1.5)
    // ls: [L=1, S=1] -> internal {2*1+1, 1} = {3, 1}
    expect(cfg.decayChains.chain1?.steps.find((s) => s.mother === 'psip')?.sl).toEqual([[3, 1]])
    // sl: [S=0.5, L=1] -> internal {2*0.5+1, 1} = {2, 1}
    expect(cfg.decayChains.chain1?.steps.find((s) => s.mother === 'R_peta')?.sl).toEqual([[2, 1]])
  })

  it('accepts an even 2S+1 for a fermion step (no odd-multiplicity rule)', () => {
    const v = validateConfig(parseConfig(BARYON_CONFIG))
    expect(v.errors).toEqual([])
  })

  it('rejects a 2S+1 that is unrealizable for the daughter spins', () => {
    const bad = BARYON_CONFIG.replace('{sl: [0.5, 1]}', '{sl: [1, 1]}') // 2S+1=3 for J=1/2 ⊗ 0
    const v = validateConfig(parseConfig(bad))
    expect(v.errors.map((e) => e.code)).toContain('sl-spin-mismatch')
  })

  it('accepts a bare intermediate name in Constraints.trans (ctpwa form)', () => {
    const cfg = parseConfig(`${BARYON_CONFIG}
Constraints:
  trans:
    - [R_peta, R_chicj]: 1
`)
    const v = validateConfig(cfg)
    expect(v.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Resonance-level J/P is OPTIONAL: the intermediates [J,P] group governs
// ---------------------------------------------------------------------------

const CP_CONFIG = `
Particles:
  psip:  {J: 1, P: -1, mass: 3.686}
  gamma: {J: 1, P: -1, mass: 0.0}
  eta:   {J: 0, P: -1, mass: 0.547862}
  p:     {J: 0.5, P: 1, mass: 0.938272}
  pbar:  {J: 0.5, P: -1, mass: 0.938272}
DecayChains:
  chain1:
    psip:
      - [gamma, R_chicj, {ls: [1, 1]}]
    R_chicj:
      - [R_peta, pbar]
      - [R_pbareta, p]
    R_peta:
      - [p, eta]
    R_pbareta:
      - [pbar, eta]
    intermediates:
      R_chicj:
        - [J: 0, P: 1]: [chic0]
      R_peta:
        - [J: 1.5, P: 1]: [N1720]
      R_pbareta:
        - [J: 1.5, P: -1]: [N1720]
Resonances:
  chic0:
    J: 0
    P: 1
    model: ONE
    parameters: [3.41471]
  N1720:
    model: BW
    parameters: [1.72, 0.25]
`

describe('resonance J/P is optional (ctpwa: the [J,P] group governs)', () => {
  it('keeps a resonance without J/P instead of silently dropping it', () => {
    const cfg = parseConfig(CP_CONFIG)
    expect(cfg.resonances.N1720).toBeDefined()
    expect(cfg.resonances.N1720?.j).toBeUndefined()
    expect(cfg.resonances.N1720?.p).toBeUndefined()
    expect(validateConfig(cfg).errors).toEqual([])
  })

  it('lets one state sit in opposite-parity CP-conjugate groups', () => {
    const cfg = parseConfig(CP_CONFIG)
    const r = validateResonanceAddition(defaultDb, cfg, {
      name: 'N1720',
      chain: 'R_peta',
      jpGroup: { j: 1.5, p: -1 }, // opposite parity to the group it already sits in
      model: 'BW',
      parameters: [1.72, 0.25],
    })
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).toContain('already-defined')
  })

  it('still rejects an EXPLICIT J/P that contradicts the target group', () => {
    const cfg = parseConfig(
      CP_CONFIG.replace('  N1720:\n    model: BW', '  N1720:\n    J: 1.5\n    P: -1\n    model: BW'),
    )
    const r = validateResonanceAddition(defaultDb, cfg, {
      name: 'N1720',
      chain: 'R_peta',
      jpGroup: { j: 1.5, p: 1 },
      model: 'BW',
      parameters: [1.72, 0.25],
    })
    expect(r.errors.map((e) => e.code)).toContain('jpc-conflict')
  })

  it('does not stamp J/P onto a newly added resonance', () => {
    const ap = applyResonanceAddition(parseConfig(CP_CONFIG), {
      name: 'N1520',
      chain: 'R_peta',
      jpGroup: { j: 1.5, p: -1 },
      model: 'BW',
      parameters: [1.515, 0.11],
    })
    expect(ap.errors).toEqual([])
    expect(ap.config.resonances.N1520?.j).toBeUndefined()
    expect(ap.config.resonances.N1520?.p).toBeUndefined()
  })
})
