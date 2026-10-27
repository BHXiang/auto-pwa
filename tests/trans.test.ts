import { describe, expect, it } from 'vitest'
import { clebschGordan, suggestTransRatios } from '../src/isospin.js'

describe('isospin CG / trans suggestion', () => {
  it('computes the standard I=0 -> 1+1 CG triplet', () => {
    const s = 1 / Math.sqrt(3)
    expect(clebschGordan(1, 1, 1, -1, 0, 0)).toBeCloseTo(s, 12)
    expect(clebschGordan(1, 0, 1, 0, 0, 0)).toBeCloseTo(-s, 12)
    expect(clebschGordan(1, -1, 1, 1, 0, 0)).toBeCloseTo(s, 12)
  })

  it('is reaction-agnostic: J/psi -> eta′ + R_3pi, R_3pi -> rho + pi', () => {
    const particles = {
      Jpsi: { I: 0, I3: 0 },
      etap: { I: 0, I3: 0 },
      R3: { I: 0, I3: 0 },
      rhoP: { I: 1, I3: 1 },
      rho0: { I: 1, I3: 0 },
      rhoM: { I: 1, I3: -1 },
      piP: { I: 1, I3: 1 },
      pi0: { I: 1, I3: 0 },
      piM: { I: 1, I3: -1 },
    }
    const r = suggestTransRatios({
      base: 'pipiM',
      particles,
      chains: [
        { name: 'pipiM', steps: [
          { mother: 'Jpsi', daughters: ['etap', 'R3'] },
          { mother: 'R3', daughters: ['rhoP', 'piM'] },
        ] },
        { name: 'pi0pi0', steps: [
          { mother: 'Jpsi', daughters: ['etap', 'R3'] },
          { mother: 'R3', daughters: ['rho0', 'pi0'] },
        ] },
        { name: 'pimpiP', steps: [
          { mother: 'Jpsi', daughters: ['etap', 'R3'] },
          { mother: 'R3', daughters: ['rhoM', 'piP'] },
        ] },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.ratios.map((x) => x.target)).toEqual(['pi0pi0', 'pimpiP'])
    expect(r.ratios[0]!.ratio).toBeCloseTo(-1, 12)
    expect(r.ratios[1]!.ratio).toBeCloseTo(1, 12)
    expect(r.trans).toEqual({ names: ['pipiM', 'pi0pi0', 'pimpiP'], value: [-1, 1] })
  })

  it('checks C per vertex when all C values are supplied', () => {
    const r = suggestTransRatios({
      base: 'base',
      particles: {
        Jpsi: { I: 1, I3: 0, C: -1 },
        f0: { I: 0, I3: 0, C: 1 },
        a0: { I: 1, I3: 0, C: 1 },
      },
      chains: [
        { name: 'base', steps: [{ mother: 'Jpsi', daughters: ['f0', 'a0'] }] },
        { name: 'other', steps: [{ mother: 'Jpsi', daughters: ['f0', 'a0'] }] },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
  })

  it('reports missing isospin instead of inventing it', () => {
    const r = suggestTransRatios({
      base: 'a',
      chains: [
        { name: 'a', steps: [{ mother: 'A', daughters: ['B', 'C'] }] },
        { name: 'b', steps: [{ mother: 'A', daughters: ['B', 'C'] }] },
      ],
      particles: { A: { I: 0, I3: 0 } },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('missing-isospin')
  })
})
