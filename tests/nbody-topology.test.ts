import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config-edit.js'
import { analyzeIntermediateJPC } from '../src/intermediate-jpc.js'
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
