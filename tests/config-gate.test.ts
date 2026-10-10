import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config-edit.js'
import { gateConfig, renderGate, md5, resonancesIncludeOf } from '../src/config-gate.js'
import { defaultDb } from '../src/db.js'

/** Clean base: J/psi -> eta + R_KK, R_KK -> K+ K-, phi(1020) in [1-]. */
const CLEAN = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969}
  eta: {J: 0, P: -1, mass: 0.5478}
  Kp: {J: 0, P: -1, mass: 0.4937}
  Km: {J: 0, P: -1, mass: 0.4937}

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
    R_KK: [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
`

const gate = (text: string, options?: Parameters<typeof gateConfig>[3]) =>
  gateConfig(parseConfig(text), text, defaultDb, options)

describe('gateConfig (run-time gate)', () => {
  it('passes a clean config and reports every check it ran', () => {
    const r = gate(CLEAN)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.checks.map((c) => c.name)).toEqual([
      'structure',
      'cross-reference',
      'two-vertex-jpc',
      'identical-symmetry',
      'pdg-threshold',
      'budget',
    ])
    expect(r.checks.every((c) => c.ran)).toBe(true)
    expect(r.stats.resonances).toBe(1)
    expect(r.stats.groups).toBe(1)
    expect(r.stats.definedUnreferenced).toBe(0)
    expect(r.configMd5).toHaveLength(32)
    expect(r.resonancesExternal).toBe(false)
    expect(md5(CLEAN)).toBe(r.configMd5)
    expect(renderGate(r)).toMatch(/通过/)
  })

  it('HARD-errors a three-body step instead of silently dropping the third daughter', () => {
    // ctpwa's amplitude is two-body PER VERTEX (Amp2BD). Reading `[Kp, Km, eta]`
    // as `Kp Km` silently dropped `eta` and fitted a wrong amplitude — the
    // four/five-body case (ω→3π, η→3π, a1→3π intermediates) hit exactly this.
    const bad = CLEAN.replace('R_KK: [Kp, Km]', 'R_KK: [Kp, Km, eta]')
    const r = gate(bad)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('step-not-two-body')
    // 关键：这一步不能被当成二体读进来
    const cfg = parseConfig(bad)
    expect(cfg.decayChains.decay1.steps.some((s) => s.mother === 'R_KK')).toBe(false)
    expect(cfg.stepIssues?.map((i) => i.code)).toEqual(['step-not-two-body'])
  })

  it('still accepts a two-body step with its optional {opts} map', () => {
    const ok = CLEAN.replace('R_KK: [Kp, Km]', 'R_KK: [Kp, Km, {sl: [0, 1]}]')
    const r = gate(ok)
    expect(r.errors.map((e) => e.code)).not.toContain('step-not-two-body')
    const step = parseConfig(ok).decayChains.decay1.steps.find((s) => s.mother === 'R_KK')!
    expect(step.daughters).toEqual(['Kp', 'Km'])
    expect(step.sl).toEqual([[1, 1]]) // sl 是 (S, L) → 内部 (2S+1, L)
  })

  it('HARD-errors a malformed mode instead of dropping the step silently', () => {
    const r = gate(CLEAN.replace('R_KK: [Kp, Km]', 'R_KK: [Kp]'))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('step-malformed')
  })

  // --- 全同粒子对称化（4/5 体才有跨步同种粒子的形态）---------------------

  /** π₁ 是旁观者、π₂ 在中间态衰变里 → 两颗 π⁰ 分处不同衰变步。 */
  const TWO_PION = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969}
  pi01: {J: 0, P: -1, mass: 0.135, pdgid: 111}
  pi02: {J: 0, P: -1, mass: 0.135, pdgid: 111}
  Kp: {J: 0, P: -1, mass: 0.4937, pdgid: 321}
  Km: {J: 0, P: -1, mass: 0.4937, pdgid: -321}

DecayChains:
  decay1:
    Jpsi:
      - [pi01, R_Kpi]
    R_Kpi: [Kp, pi02]
    intermediates:
      R_Kpi:
        - [J: 0, P: 1]: [f0_980]

Resonances:
  f0_980: {J: 0, P: 1, model: BWR, parameters: [0.99, 0.06]}
`

  it('warns that a chain-level `symmetrize` key is ignored by ctpwa', () => {
    // ctpwa 只在 "跳过这个键" 的地方提到 symmetrize（Config.cu 822/860/1320），
    // 它不做任何对称化 —— 写了它的人会以为它起作用。
    const r = gate(CLEAN.replace('  decay1:', '  decay1:\n    symmetrize: true'))
    expect(r.warnings.map((w) => w.code)).toContain('symmetrize-ignored')
  })

  it('warns about identical daughters spread over different steps', () => {
    const r = gate(TWO_PION)
    expect(r.warnings.map((w) => w.code)).toContain('identical-cross-step')
    expect(r.warnings.find((w) => w.code === 'identical-cross-step')!.message).toContain('pi01')
  })

  it('stays quiet about that when Constraints.trans already ties the topologies', () => {
    // 标准做法：把交换拓扑写成独立链，并用 trans 绑定耦合 —— 这时不该再提示。
    const cfg = parseConfig(TWO_PION)
    cfg.constraints.trans = [{ names: ['R_Kpi_0', 'R_KK_0'], value: [1] }]
    const r = gateConfig(cfg, TWO_PION, defaultDb)
    expect(r.warnings.map((w) => w.code)).not.toContain('identical-cross-step')
  })

  it('HARD-errors a state above the production threshold', () => {
    const r = gate(CLEAN.replace('parameters: [1.0195, 0.0045]', 'parameters: [2.9, 0.0045]'))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('above-threshold')
  })

  it('HARD-errors a C-violating wave (same case validate_add rejects)', () => {
    // [2+] of K+K- under J/psi -> R + eta: the pair has C=+ at 2+, but the
    // production vertex requires C(R) = C(J/psi)*C(eta) = -1.
    const r = gate(CLEAN.replace('[J: 1, P: -1]: [phi1020]', '[J: 2, P: 1]: [phi1020]'))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
  })

  it('HARD-errors a decay-vertex-forbidden group', () => {
    // K+K- (both spin 0) cannot realize [3+]: P = P1*P2*(-1)^L = (+1)(-1)^L,
    // so odd J only, and C = (-1)^(L+S) with S=0 gives (-1)^L — [3+] is not in
    // the decay-vertex set.
    const r = gate(CLEAN.replace('[J: 1, P: -1]: [phi1020]', '[J: 3, P: 1]: [phi1020]'))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('decay-vertex-forbidden')
  })

  it('detects an external Resonances include and suppresses the false undefined-resonance errors', () => {
    const text = CLEAN.replace(/Resonances:\n[\s\S]*$/, 'Resonances: Resonances.yml\n')
    const cfg = parseConfig(text)
    expect(resonancesIncludeOf(cfg.raw)).toBe('Resonances.yml')
    const r = gateConfig(cfg, text, defaultDb)
    expect(r.resonancesExternal).toBe(true)
    expect(r.resonancesIncludePath).toBe('Resonances.yml')
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('resonances-external')
    expect(r.checks.find((c) => c.name === 'two-vertex-jpc')?.ran).toBe(false)
  })

  it('warns (never blocks) on a duplicate PDG id under two names', () => {
    const text = CLEAN.replace(
      '- [J: 1, P: -1]: [phi1020]',
      '- [J: 1, P: -1]: [phi1020, phi_1020]',
    ).replace(
      '  phi1020:\n    J: 1\n    P: -1\n    model: BWR\n    parameters: [1.0195, 0.0045]',
      '  phi1020:\n    J: 1\n    P: -1\n    model: BWR\n    parameters: [1.0195, 0.0045]\n  phi_1020:\n    J: 1\n    P: -1\n    model: BWR\n    parameters: [1.0195, 0.0045]',
    )
    const r = gate(text)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('duplicate-pdg-id')
  })

  it('warns on the soft state-count budget without blocking', () => {
    const r = gate(CLEAN, { maxResonances: 0 })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('budget-resonances')
  })

  it('lets an unknown model through with no PDG claim (ctpwa owns the verdict)', () => {
    const text = CLEAN.replace('model: BWR', 'model: WeirdNewModel')
    const r = gate(text)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).not.toContain('not-on-pdg')
  })

  it('accepts an Interp model with an empty parameter list + options payload', () => {
    const text = CLEAN
      .replace('    model: BWR\n    parameters: [1.0195, 0.0045]', '    model: Interp\n    parameters: []\n    options:\n      file: /tmp/table.dat\n      method: linear')
    const r = gate(text)
    expect(r.ok).toBe(true)
    const cfg = parseConfig(text)
    expect(cfg.resonances.phi1020?.options).toEqual({ file: '/tmp/table.dat', method: 'linear' })
  })

  it('warns for a non-particle state that is not on PDG (provenance nag, not a block)', () => {
    const text = CLEAN.replaceAll('phi1020', 'X_custom_state')
    const r = gate(text)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('not-on-pdg')
  })
})
