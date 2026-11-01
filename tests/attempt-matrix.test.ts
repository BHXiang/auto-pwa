import { describe, expect, it } from 'vitest'
import {
  createMatrix,
  addRow,
  addPrune,
  setTopologyStatus,
  matrixStatus,
  matrixCheck,
  renderMatrixMarkdown,
} from '../src/attempt-matrix.js'
import type { TopologyCoverage } from '../src/topology.js'
import type { PwaConfig } from '../src/types.js'

const coverage: TopologyCoverage = {
  finalState: ['a', 'b', 'c', 'd'],
  topologies: [
    {
      kind: '2+2',
      sides: [{ particles: ['a', 'b'] }, { particles: ['c', 'd'] }],
      present: true,
      realizedBy: { chain: 'decay1', mother: 'Jpsi', daughters: ['R_ab', 'R_cd'] },
    },
    {
      kind: '1+3',
      sides: [{ particles: ['a'] }, { particles: ['b', 'c', 'd'] }],
      present: false,
    },
  ],
  present: 1,
  total: 2,
}

const config = {
  particles: {},
  decayChains: {
    decay1: {
      steps: [{ mother: 'Jpsi', daughters: ['R_ab', 'R_cd'] }],
      intermediates: {
        R_ab: { groups: [{ jp: { j: 0, p: 1 }, names: ['NR_ab'] }] },
        R_cd: { groups: [{ jp: { j: 1, p: -1 }, names: ['rho'] }] },
      },
    },
  },
  resonances: { NR_ab: { model: 'ONE', parameters: [] }, rho: { model: 'BWR', parameters: [0.775, 0.149] } },
} as unknown as PwaConfig

describe('attempt matrix', () => {
  it('starts with pending topologies and reports missing coverage', () => {
    const m = createMatrix(coverage.finalState, coverage)
    expect(m.topologies.map((t) => t.status)).toEqual(['included', 'pending'])
    const c = matrixCheck(m, config)
    expect(c.ok).toBe(false)
    expect(c.missing.join('\n')).toContain('topology 1+3')
    expect(c.missing.join('\n')).toContain('no candidate row for R_ab [0+]')
    expect(c.missing.join('\n')).toContain('component NR_ab: no prune row')
  })

  it('is complete once every topology, [J,P] group and component has a row', () => {
    let m = createMatrix(coverage.finalState, coverage)
    m = setTopologyStatus(m, '1+3:a|b+c+d', 'excluded', 'no 3-body enhancement in data/phsp')
    m = addRow(m, { intermediate: 'R_ab', jp: '0+', candidate: 'NR_ab', model: 'ONE', nll: -100.0, k: 2, status: 'kept' })
    m = addRow(m, { intermediate: 'R_cd', jp: '1-', candidate: 'rho', model: 'BWR', nll: -120.0, k: 2, status: 'kept' })
    m = addRow(m, { intermediate: 'R_cd', jp: '1-', candidate: 'NR_cd', model: 'ONE', deltaNll: 1.2, status: 'rejected', reason: 'ΔNLL<3' })
    m = addPrune(m, { component: 'NR_ab', deltaNll: 50.0, status: 'kept', reason: 'significant' })
    m = addPrune(m, { component: 'rho', deltaNll: 80.0, status: 'kept', reason: 'significant' })
    const c = matrixCheck(m, config)
    expect(c.ok).toBe(true)
    expect(c.missing).toEqual([])
    const s = matrixStatus(m)
    expect(s.topologies).toBe(2)
    expect(s.included).toBe(1)
    expect(s.excluded).toBe(1)
    expect(s.kept).toBe(2)
    expect(s.rejected).toBe(1)
    expect(s.prunes).toBe(2)
    expect(renderMatrixMarkdown(m, c)).toContain('Attempt matrix')
  })

  it('reports a skipped row without reason and a pending row', () => {
    let m = createMatrix(coverage.finalState, coverage)
    m = setTopologyStatus(m, '1+3:a|b+c+d', 'excluded', 'no enhancement')
    m = addRow(m, { intermediate: 'R_ab', jp: '0+', candidate: 'NR_ab', model: 'ONE', status: 'skipped' })
    m = addRow(m, { intermediate: 'R_cd', jp: '1-', candidate: 'rho', model: 'BWR', status: 'pending' })
    const c = matrixCheck(m, config)
    expect(c.missing.join('\n')).toContain('skipped without reason')
    expect(c.missing.join('\n')).toContain('status pending')
  })
})
