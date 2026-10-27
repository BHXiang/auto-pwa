import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config-edit.js'
import { analyzeIntermediateJPC } from '../src/intermediate-jpc.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { defaultDb } from '../src/db.js'

/**
 * 4 体拓扑：`A -> R1 + R2`（两个 daughter 都是中间态）。
 *
 * 这是 4/5 体分析最常见的第一级：二体级联下的 4 体 = 产生步 + 两个二体衰变步。
 * 工具链之前把产生顶点写死成 `A -> R + B`（一个中间态 + 一个粒子），于是：
 *   - `kinematics` 里没有这两条产生步 → 阈值余量/`decay_check` 提示缺失；
 *   - `analyzeIntermediateJPC` 拿不到 production 行 → `allowedJP` 空、C 判据静默失效。
 * 现在两边都登记（各自用对方的组内质量算阈值），并保留一条诚实的 C 状态。
 */
const FOUR_BODY = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  Kp: {J: 0, P: -1, mass: 0.4937, pdgid: 321}
  Km: {J: 0, P: -1, mass: 0.4937, pdgid: -321}
  pip: {J: 0, P: -1, mass: 0.1396, pdgid: 211}
  pim: {J: 0, P: -1, mass: 0.1396, pdgid: -211}
DecayChains:
  decay1:
    Jpsi:
      - [R_KK, R_pipi]
    R_KK: [Kp, Km]
    R_pipi: [pip, pim]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_pipi:
        - [J: 1, P: -1]: [rho770]
Resonances:
  phi1020: {J: 1, P: -1, model: BWR, parameters: [1.0195, 0.0045]}
  rho770: {J: 1, P: -1, model: BWR, parameters: [0.7753, 0.1491]}
`

describe('4 体拓扑 A -> R1 + R2', () => {
  it('为两侧都登记产生步 kinematics（阈值用对方的组内质量）', () => {
    const cfg = parseConfig(FOUR_BODY)
    const kk = cfg.kinematics['R_KK']
    const pp = cfg.kinematics['R_pipi']
    expect(kk, 'R_KK 缺产生步 kinematics').toBeDefined()
    expect(pp, 'R_pipi 缺产生步 kinematics').toBeDefined()
    expect(kk!.motherName).toBe('Jpsi')
    expect(kk!.daughterName).toBe('R_pipi')
    expect(kk!.threshold).toBeCloseTo(3.0969 - 0.7753, 4)
    expect(pp!.daughterName).toBe('R_KK')
    expect(pp!.threshold).toBeCloseTo(3.0969 - 1.0195, 4)
  })

  it('两顶点检查拿到 production 行（allowedJP 非空）', () => {
    const cfg = parseConfig(FOUR_BODY)
    const ana = analyzeIntermediateJPC(cfg, defaultDb, 'R_KK')
    expect(ana, 'R_KK 应在某条链里被声明').toBeDefined()
    expect(ana!.production, 'production 行缺失 → C/阈值检查会静默失效').toBeDefined()
    expect(ana!.production!.mother).toBe('Jpsi')
    expect(ana!.production!.daughter).toBe('R_pipi')
    expect(ana!.production!.allowedJP.length).toBeGreaterThan(0)
    // 衰变顶点的波表也要在（与 production 来自同一条链）
    expect(ana!.decaySteps.length).toBeGreaterThan(0)
  })

  it('姊妹是中间态时，C 状态明确标为不适用（而不是看起来通过）', () => {
    const cfg = parseConfig(FOUR_BODY)
    const ana = analyzeIntermediateJPC(cfg, defaultDb, 'R_KK')!
    // R_pipi 是中间态名，其 C 取决于组内哪个共振态贡献 —— 不能猜一个 C 去"通过"。
    expect(ana.cStatus.status).toBe('not-applicable')
    expect(ana.cStatus.required).toBeNull()
    expect(ana.cStatus.reason).toContain('R_pipi')
    expect(ana.cStatus.reason).toContain('不等于 C 守恒已通过')
  })

  it('优先选"该中间态真的在其中衰变"的链（否则波表为空）', () => {
    // R_X 在 decay1 里只被声明、并不衰变；真正带衰变步的是 decay2。
    const cfg = parseConfig(`Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  eta: {J: 0, P: -1, mass: 0.5478, pdgid: 221}
  Kp: {J: 0, P: -1, mass: 0.4937, pdgid: 321}
DecayChains:
  decay1:
    Jpsi:
      - [eta, R_X]
    intermediates:
      R_X:
        - [J: 1, P: -1]: [phi1020]
  decay2:
    Jpsi:
      - [Kp, R_X]
    R_X: [Kp, eta]
    intermediates:
      R_X:
        - [J: 1, P: -1]: [phi1020]
Resonances:
  phi1020: {J: 1, P: -1, model: BWR, parameters: [1.0195, 0.0045]}
`)
    const ana = analyzeIntermediateJPC(cfg, defaultDb, 'R_X')
    expect(ana).toBeDefined()
    expect(ana!.chain).toBe('decay2')
    expect(ana!.decaySteps.length).toBeGreaterThan(0)
  })
})

/**
 * J/psi -> eta' + R(3pi), R(3pi) -> rho + pi: the C of the intermediate is
 * fixed by the production vertex even though the decay step's sister is an
 * intermediate. The gate must use that (and, at R(3pi) itself, the resonance's
 * PDG C) instead of silently skipping the check.
 */
const JPSI_ETAP_3PI = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  etap: {J: 0, P: -1, mass: 0.957784, pdgid: 331}
  pip: {J: 0, P: -1, mass: 0.13957, pdgid: 211}
  pim: {J: 0, P: -1, mass: 0.13957, pdgid: -211}
  pi0: {J: 0, P: -1, mass: 0.134977, pdgid: 111}
DecayChains:
  decay1:
    Jpsi: [[etap, R_3pi]]
    R_3pi: [[pi0, R_pipi]]
    R_pipi: [[pip, pim]]
    intermediates:
      R_3pi:
        - [J: 1, P: -1]: [omega1420]
      R_pipi:
        - [J: 1, P: -1]: [rho770]
Resonances:
  omega1420: {model: BWR, parameters: [1.41, 0.29]}
  rho770: {model: BWR, parameters: [0.7753, 0.1474]}
`

describe("cascade C parity (J/psi -> eta' + 3pi)", () => {
  it('propagates C(R_3pi) = - into R_pipi and blocks the C = +1 pi+pi- waves', () => {
    const cfg = parseConfig(JPSI_ETAP_3PI)
    const ana = analyzeIntermediateJPC(cfg, defaultDb, 'R_pipi')!
    expect(ana.cStatus.status).toBe('enforced')
    expect(ana.cStatus.required).toBe(-1)
    // 0++, 2++, 4++ of pi+pi- have C=+1; the production vertex forbids them.
    expect(ana.cBlocked).toContain('2++')
  })

  it('uses the resonance PDG C when the decay vertex is unresolved (a1(1260))', () => {
    const cfg = parseConfig(JPSI_ETAP_3PI)
    const r = validateResonanceAddition(defaultDb, cfg, {
      name: 'a(1)(1260)0',
      chain: 'R_3pi',
      jpGroup: { j: 1, p: 1 },
      model: 'BWR',
      parameters: [1.23, 0.42],
    })
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
  })

  it('threshold is the propagated production bound, not the first resonance mass', () => {
    const cfg = parseConfig(JPSI_ETAP_3PI)
    // R_pipi <= m(J/psi) - m(eta') - m(pi0) = 2.0041, not 1.41 - 0.135.
    expect(cfg.kinematics['R_pipi']!.threshold).toBeCloseTo(3.0969 - 0.957784 - 0.134977, 4)
    const r = validateResonanceAddition(defaultDb, cfg, {
      name: 'f(2)(1270)',
      chain: 'R_pipi',
      jpGroup: { j: 2, p: 1 },
      model: 'BWR',
      parameters: [1.2754, 0.1867],
    })
    // Mass is well below the kinematic bound now; the rejection is the real C
    // violation (f2(1270) has C=+1, R_pipi requires C=-1), not a 0.4 MeV
    // kinematic artefact.
    expect(r.errors.map((e) => e.code)).not.toContain('above-threshold')
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
  })

  it('rejects an ambiguous charge spelling when the PDG C cannot be resolved', () => {
    const cfg = parseConfig(JPSI_ETAP_3PI)
    // `a1(1260)` normalizes onto the charged PDG entries a(1)(1260)+/- (whose C
    // is undefined), not the neutral a(1)(1260)0 (C=+1). A silent "unverified"
    // warning would let it through; require the neutral spelling instead.
    const r = validateResonanceAddition(defaultDb, cfg, {
      name: 'a1(1260)',
      chain: 'R_3pi',
      jpGroup: { j: 1, p: 1 },
      model: 'BWR',
      parameters: [1.23, 0.42],
    })
    expect(r.errors.map((e) => e.code)).toContain('c-unverified')
  })
})
