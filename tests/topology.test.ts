import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config-edit.js'
import { firstLevelTopologies } from '../src/topology.js'

/**
 * J/psi -> eta' pi+ pi- pi0 with two 1+3 chains (the shape the previous
 * from-scratch run produced): the view must still show that the other two
 * 1+3 partitions and all three 2+2 partitions are absent.
 */
const TWO_CHAINS = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  etap: {J: 0, P: -1, mass: 0.957784, pdgid: 331}
  pip: {J: 0, P: -1, mass: 0.13957, pdgid: 211}
  pim: {J: 0, P: -1, mass: 0.13957, pdgid: -211}
  pi0: {J: 0, P: -1, mass: 0.134977, pdgid: 111}
DecayChains:
  decay1:
    Jpsi: [[etap, R_3pi]]
    R_3pi: [[pi0, R_pipi]]
    R_pipi: [pip, pim]
    intermediates:
      R_3pi:
        - [J: 1, P: -1]: []
      R_pipi:
        - [J: 1, P: -1]: []
  decay2:
    Jpsi: [[pi0, R_etaprho]]
    R_etaprho: [etap, R_pipi2]
    R_pipi2: [pip, pim]
    intermediates:
      R_etaprho:
        - [J: 1, P: -1]: []
      R_pipi2:
        - [J: 1, P: -1]: []
`

const FINAL = ['etap', 'pip', 'pim', 'pi0']

const labels = (text: string): string[] =>
  firstLevelTopologies(parseConfig(text), FINAL).topologies.map(
    (t) => `${t.kind} ${t.sides.map((s) => s.particles.join('+')).join(' | ')} ${t.present ? 'Y' : '-'}`,
  )

describe('first-level topology coverage (4-body)', () => {
  it('enumerates 4 x 1+3 and 3 x 2+2 and marks the two written chains', () => {
    const cov = firstLevelTopologies(parseConfig(TWO_CHAINS), FINAL)
    expect(cov.total).toBe(7)
    expect(cov.present).toBe(2)
    expect(labels(TWO_CHAINS)).toEqual([
      '1+3 etap | pip+pim+pi0 Y',
      '1+3 pip | etap+pim+pi0 -',
      '1+3 pim | etap+pip+pi0 -',
      '1+3 pi0 | etap+pip+pim Y',
      '2+2 etap+pip | pim+pi0 -',
      '2+2 etap+pim | pip+pi0 -',
      '2+2 etap+pi0 | pip+pim -',
    ])
  })

  it('recognizes a 2+2 chain when both production daughters are intermediates', () => {
    const text = `${TWO_CHAINS}
  decay3:
    Jpsi: [[R_etappip, R_pimpipi0]]
    R_etappip: [etap, pip]
    R_pimpipi0: [pim, pi0]
    intermediates:
      R_etappip:
        - [J: 0, P: -1]: []
      R_pimpipi0:
        - [J: 1, P: -1]: []
`
    const cov = firstLevelTopologies(parseConfig(text), FINAL)
    expect(cov.present).toBe(3)
    const pair = cov.topologies.find((t) => t.present && t.kind === '2+2')!
    expect(pair.sides.map((s) => s.particles)).toEqual([
      ['etap', 'pip'],
      ['pim', 'pi0'],
    ])
    expect(pair.realizedBy?.chain).toBe('decay3')
    expect(pair.realizedBy?.mother).toBe('Jpsi')
  })

  it('supports 5-body shapes (1+4 and 2+3)', () => {
    const cov = firstLevelTopologies(parseConfig(TWO_CHAINS), ['etap', 'pip', 'pim', 'pi0', 'Kp'])
    expect(cov.topologies.filter((t) => t.kind === '1+4')).toHaveLength(5)
    expect(cov.topologies.filter((t) => t.kind === '2+3')).toHaveLength(10)
    // The existing chains still only cover the subsets that use the four
    // known final particles; Kp is never produced, so nothing matches fully.
    expect(cov.present).toBe(0)
  })
})
