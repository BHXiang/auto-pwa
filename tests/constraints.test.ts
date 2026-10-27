import { describe, expect, it } from 'vitest'
import { parseConfig, validateConfig } from '../src/config-edit.js'

/**
 * Constraints are deliberately generous: keys are whitelisted and values are
 * shape-checked, but names/semantics are ctpwa's job (multi-body chain ids,
 * intermediate names, 3-name trans groups, ...). A wrong name is a no-op — the
 * fit gate reports it via ctpwa stderr / nFreeParams, and physics is judged by
 * ΔNLL + records.
 */
const BASE = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969}
  eta: {J: 0, P: -1, mass: 0.547862}
  Kp: {J: 0, P: -1, mass: 0.493677}
  Km: {J: 0, P: -1, mass: 0.493677}
Data:
  order: [Kp, Km, eta]
  data: [dat, ./data.dat]
DecayChains:
  decay1:
    Jpsi: [[eta, R_KK]]
    R_KK: [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi]
Resonances:
  phi: {model: BWR, parameters: [1.0195, 0.0045]}
`

const withConstraints = (body: string): string => `${BASE}Constraints:\n${body}\n`

const codes = (text: string): { errors: string[]; warnings: string[] } => {
  const v = validateConfig(parseConfig(text))
  return { errors: v.errors.map((e) => e.code), warnings: v.warnings.map((w) => w.code) }
}

describe('Constraints: key whitelist + shape, no name whitelist', () => {
  it('accepts a 3-name trans entry (full chain ids / arbitrary names)', () => {
    const c = codes(
      withConstraints(
        `  trans:\n    - [decay1_R_KK, decay2_R_KK, decay3_R_KK]: [1]`,
      ),
    )
    expect(c.errors).toEqual([])
    expect(c.errors).not.toContain('trans-bad-name')
    expect(c.errors).not.toContain('trans-unknown-intermediate')
    expect(c.errors).not.toContain('trans-group-index')
  })

  it('accepts [A,B,C]:[1] and [R_etap_pip, R_etap_pim]:1 shape-wise', () => {
    for (const body of [
      `  trans:\n    - [A, B, C]: [1]`,
      `  trans:\n    - [R_etap_pip, R_etap_pim]: 1`,
      `  trans:\n    - [R_etap_pip, R_etap_pim]: [[1, 0], [0, 1]]`,
    ]) {
      const c = codes(withConstraints(body))
      expect(c.errors).toEqual([])
    }
  })

  it('rejects a key typo (`maxl`) and suggests maxL', () => {
    const v = validateConfig(parseConfig(withConstraints('  maxl: 4')))
    const err = v.errors.find((e) => e.code === 'constraint-key-unknown')!
    expect(err).toBeDefined()
    expect(err.message).toContain('maxL')
    expect(err.message).toContain('did you mean')
  })

  it('rejects malformed trans/identical/var_range/gauss shape', () => {
    for (const body of [
      `  trans: 1`,
      `  trans:\n    - [only_one]: 1`,
      `  trans:\n    - [A, B]: not-a-number`,
      `  identical: 1`,
      `  identical:\n    - [pi0]`,
      `  var_range:\n    x: 1`,
      `  gauss_constr:\n    x: -0.1`,
    ]) {
      const c = codes(withConstraints(body))
      expect(c.errors).toContain('constraint-shape')
    }
  })

  it('downgrades unknown identical members/spins to warnings (no-op, not fatal)', () => {
    const c = codes(withConstraints(`  identical:\n    - [Kp, NotAParticle]`))
    expect(c.errors).toEqual([])
    expect(c.warnings).toContain('identical-unknown-particle')
    const spin = codes(withConstraints(`  identical:\n    - [eta, Jpsi]`))
    expect(spin.errors).toEqual([])
    expect(spin.warnings).toContain('identical-spin-mismatch')
  })

  it('accepts free_phsp_amplitudes and the rest of the ctpwa key set', () => {
    const c = codes(
      withConstraints(
        `  maxL: 4\n  bf_d: 1.5\n  has_bf: true\n  free_phsp_amplitudes: false\n  free_var: [a]\n  var_equal:\n    - [a, b]\n  fix_var:\n    a: 1.0\n  gauss_constr:\n    a: 0.1`,
      ),
    )
    expect(c.errors).toEqual([])
  })
})

describe('ONE phase-space incentive warnings', () => {
  it('flags ONE as C-unchecked and warns when the NR share is high', () => {
    const text = BASE.replace(
      'Resonances:\n  phi: {model: BWR, parameters: [1.0195, 0.0045]}',
      'Resonances:\n  phi: {model: BWR, parameters: [1.0195, 0.0045]}\n' +
        '  NR1: {model: ONE, parameters: []}\n' +
        '  NR2: {model: ONE, parameters: []}\n' +
        '  NR3: {model: ONE, parameters: []}',
    )
    const v = validateConfig(parseConfig(text))
    expect(v.errors).toEqual([])
    expect(v.warnings.map((w) => w.code)).toContain('one-c-unchecked')
    expect(v.warnings.map((w) => w.code)).toContain('nr-budget')
    expect(v.warnings.find((w) => w.code === 'nr-budget')!.message).toMatch(/3\/4/)
  })
})
