import { describe, expect, it } from 'vitest'
import {
  parseConfig,
  validateConfig,
  validateResonanceRemoval,
  applyResonanceRemoval,
} from '../src/config-edit.js'

/**
 * Resonance removal — the inverse of addition, needed for significance-driven
 * pruning. Name-level detachment must NOT renumber [J,P] groups (group order
 * defines Constraints.trans amplitude-block indices), so an emptied group is
 * kept.
 */

const CONFIG = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969}
  eta: {J: 0, P: -1, mass: 0.5478}
  Kp: {J: 0, P: -1, mass: 0.4937}
  Km: {J: 0, P: -1, mass: 0.4937}

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
    R_KK:
      - [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020, omega1420]
        - [J: 3, P: -1]: [phi1680]

Constraints:
  trans:
    - [R_KK_0, R_KK_1]: -1

Resonances:
  phi1020:
    model: BWR
    parameters: [1.0195, 0.0045]
  omega1420:
    model: BWR
    parameters: [1.41, 0.29]
  phi1680:
    model: BWR
    parameters: [1.68, 0.15]
`

const cfg = () => parseConfig(CONFIG)
const group = (c: ReturnType<typeof parseConfig>, i: number) =>
  c.decayChains.decay1?.intermediates.R_KK?.groups[i]

describe('resonance removal: validation', () => {
  it('reports the detached occurrences and the dropped definition', () => {
    const v = validateResonanceRemoval(cfg(), { name: 'phi1680' })
    expect(v.ok).toBe(true)
    expect(v.detached).toEqual(['decay1.R_KK [3-]'])
    expect(v.definitionDropped).toBe(true)
  })

  it('rejects an unknown name and an out-of-scope request', () => {
    expect(validateResonanceRemoval(cfg(), { name: 'nope' }).errors.map((e) => e.code)).toContain('not-found')
    const scoped = validateResonanceRemoval(cfg(), { name: 'phi1020', chain: 'R_Keta' })
    expect(scoped.ok).toBe(false)
    expect(scoped.errors.map((e) => e.code)).toContain('not-in-scope')
  })

  it('does not drop the definition when dropDefinition=false', () => {
    const v = validateResonanceRemoval(cfg(), { name: 'phi1680', dropDefinition: false })
    expect(v.definitionDropped).toBe(false)
    expect(v.warnings.map((w) => w.code)).toContain('definition-kept')
  })
})

describe('resonance removal: apply', () => {
  it('detaches a name but keeps the (now empty) group and its index', () => {
    const c = cfg()
    const ap = applyResonanceRemoval(c, { name: 'phi1680' })
    expect(ap.errors).toEqual([])
    expect(group(c, 1)?.names).toEqual([]) // group kept, index preserved
    expect(c.decayChains.decay1?.intermediates.R_KK?.groups).toHaveLength(2)
    expect(c.resonances.phi1680).toBeUndefined() // unreferenced -> dropped
    // trans R_KK_0 / R_KK_1 still resolves: whole config stays valid.
    expect(validateConfig(c).errors).toEqual([])
  })

  it('removes one member of a multi-member group without touching the others', () => {
    const c = cfg()
    applyResonanceRemoval(c, { name: 'omega1420' })
    expect(group(c, 0)?.names).toEqual(['phi1020'])
    expect(c.resonances.omega1420).toBeUndefined()
    expect(c.resonances.phi1020).toBeDefined()
  })

  it('honours chain + jpGroup scope', () => {
    const c = cfg()
    const ap = applyResonanceRemoval(c, { name: 'phi1020', chain: 'R_KK', jpGroup: { j: 3, p: -1 } })
    // phi1020 is not in [3-]: nothing detached -> the scope error blocks the edit
    expect(ap.errors.map((e) => e.code)).toContain('not-in-scope')
    expect(c.resonances.phi1020).toBeDefined()
  })

  it('can drop several states in sequence and leave the config valid', () => {
    const c = cfg()
    for (const r of [{ name: 'phi1680' }, { name: 'omega1420' }, { name: 'phi1020' }]) {
      expect(applyResonanceRemoval(c, r).errors).toEqual([])
    }
    expect(Object.keys(c.resonances)).toEqual([])
    expect(c.decayChains.decay1?.intermediates.R_KK?.groups).toHaveLength(2)
    expect(validateConfig(c).errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// CP-conjugate scope: remove from ONE chain only
// ---------------------------------------------------------------------------

const CP = `Particles:
  psip: {J: 1, P: -1, mass: 3.686}
  gamma: {J: 1, P: -1, mass: 0.0}
  eta: {J: 0, P: -1, mass: 0.547862}
  p: {J: 0.5, P: 1, mass: 0.938272}
  pbar: {J: 0.5, P: -1, mass: 0.938272}
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

describe('resonance removal: CP-conjugate chains', () => {
  it('can prune one parity chain while the state stays attached to the other', () => {
    const c = parseConfig(CP)
    const ap = applyResonanceRemoval(c, { name: 'N1720', chain: 'R_pbareta' })
    expect(ap.errors).toEqual([])
    expect(c.decayChains.chain1?.intermediates.R_pbareta?.groups[0]?.names).toEqual([])
    expect(c.decayChains.chain1?.intermediates.R_peta?.groups[0]?.names).toEqual(['N1720'])
    // still referenced by R_peta -> the definition survives
    expect(c.resonances.N1720).toBeDefined()
    expect(validateConfig(c).errors).toEqual([])
  })
})
