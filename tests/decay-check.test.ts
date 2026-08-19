import { describe, expect, it } from 'vitest'
import { defaultDb } from '../src/db.js'
import { allowedIntermediateJP, decayCheck } from '../src/decay-check.js'
import type { DecayCheckResult, Particle, ResonanceDb } from '../src/types.js'

// J/psi -> K + R: the K-eta chain of Jpsi2KKeta.
const jpsi: Particle = { j: 1, p: -1, mass: 3.0969 }
const kaon: Particle = { j: 0, p: -1, mass: 0.4937 }

const find = (allowed: ReturnType<typeof allowedIntermediateJP>, j: number, p: 1 | -1) =>
  allowed.find((a) => a.jp.j === j && a.jp.p === p)

const by = (candidates: DecayCheckResult['candidates'], j: number, p: 1 | -1) =>
  candidates.find((c) => c.jp.j === j && c.jp.p === p)?.resonances.map((r) => r.entry.id)

const flagged = (candidates: DecayCheckResult['candidates'], j: number, p: 1 | -1) =>
  candidates
    .find((c) => c.jp.j === j && c.jp.p === p)
    ?.resonances.filter((r) => r.decaysTo)
    .map((r) => r.entry.id)

describe('allowedIntermediateJP: J/psi -> K + R', () => {
  it('allows 1- via L=1 and 1+ via L=0', () => {
    const allowed = allowedIntermediateJP(jpsi, kaon)
    // Parity P_R = P_A*P_B*(-1)^L = (-1)^L: odd L -> 1-, even L -> 1+.
    expect(find(allowed, 1, -1)?.L).toContain(1)
    expect(find(allowed, 1, 1)?.L).toContain(0)
    expect(find(allowed, 2, 1)?.L).toContain(2)
    expect(find(allowed, 3, -1)?.L).toContain(3)
  })

  it('allows 0- via L=1 but never 0+ or J beyond jrMax', () => {
    const allowed = allowedIntermediateJP(jpsi, kaon)
    expect(find(allowed, 0, -1)?.L).toEqual([1]) // L=1 triangle with jr=0
    expect(find(allowed, 0, 1)).toBeUndefined() // 0+ would need even L and jr=0, impossible
    expect(find(allowed, 6, 1)).toBeUndefined() // beyond jrMax = jA + jB + maxL
    expect(allowed.every((a) => Number.isInteger(a.jp.j))).toBe(true)
  })

  it('grows the allowed set with maxL', () => {
    const low = allowedIntermediateJP(jpsi, kaon, 1)
    const high = allowedIntermediateJP(jpsi, kaon, 4)
    expect(find(low, 3, -1)).toBeUndefined() // needs L=3
    expect(find(high, 3, -1)).toBeDefined() // K3*(1780) family
  })
})

describe('allowedIntermediateJP: J/psi -> omega + R', () => {
  const omega: Particle = { j: 1, p: -1, mass: 0.78265 }

  it('allows 0+/1+/2+ (L=0) and 0-/1-/2-/3- (L=1) at maxL=1', () => {
    const allowed = allowedIntermediateJP(jpsi, omega, 1)
    for (const [j, p] of [[0, 1], [1, 1], [2, 1], [0, -1], [1, -1], [2, -1], [3, -1]] as const) {
      expect(find(allowed, j, p), `${j}${p === 1 ? '+' : '-'}`).toBeDefined()
    }
    expect(find(allowed, 4, -1)).toBeUndefined()
  })
})

describe('decayCheck candidates', () => {
  it('finds the KK-eta resonances under the kinematic threshold, flagged by decay mode', () => {
    const { candidates } = decayCheck(jpsi, kaon, defaultDb, { decayTo: ['K+', 'eta'] })
    // Threshold m_R <= 3.0969 - 0.4937 = 2.603 GeV.
    const v1 = candidates.find((c) => c.jp.j === 1 && c.jp.p === -1)!
    // Only K*(1410) lists a K eta mode; all other 1- states below threshold
    // are flagged false, not excluded, and flagged candidates come first.
    expect(flagged(candidates, 1, -1)).toHaveLength(1)
    expect(flagged(candidates, 1, -1)![0]).toContain('1410')
    expect(v1.resonances.length).toBeGreaterThanOrEqual(20)
    expect(v1.resonances.slice(0, 1).every((r) => r.decaysTo)).toBe(true)
    expect(v1.resonances.map((r) => r.entry.id)).toEqual(
      expect.arrayContaining(['rho(770)+', 'K*(892)0', 'phi(1680)']),
    )
    // 2+ is unflagged (no K eta mode in seed), sorted by mass across families.
    const t2 = candidates.find((c) => c.jp.j === 2 && c.jp.p === 1)!
    expect(t2.resonances.every((r) => !r.decaysTo)).toBe(true)
    for (const [i, r] of t2.resonances.entries()) {
      if (i > 0) expect(r.entry.mass).toBeGreaterThanOrEqual(t2.resonances[i - 1].entry.mass)
    }
    expect(t2.resonances.map((r) => r.entry.id)).toEqual(
      expect.arrayContaining(['f(2)(1270)', 'K(2)*(1430)+', "f(2)'(1525)", 'f(2)(2150)']),
    )
    // 3-: whole tensor-meson family present.
    expect(by(candidates, 3, -1)).toEqual(
      expect.arrayContaining(['omega(3)(1670)', 'K(3)*(1780)0', 'phi(3)(1850)']),
    )
  })

  it('flags the KsKs scalar/tensor candidates, ranked before generic ones', () => {
    const omega: Particle = { j: 1, p: -1, mass: 0.78265 }
    const { candidates } = decayCheck(jpsi, omega, defaultDb, { decayTo: ['Ks', 'Ks'] })
    // Threshold 3.0969 - 0.78265 = 2.314 GeV.
    expect(flagged(candidates, 0, 1)).toEqual(['f(0)(980)', 'f(0)(1370)', 'f(0)(1500)', 'f(0)(1710)', 'f0(1770)'])
    // Flagged first (f2 family), then unflagged by mass (a2/K2* family).
    expect(flagged(candidates, 2, 1)).toEqual(['f(2)(1270)', "f(2)'(1525)", 'f(2)(2150)'])
    const t2 = candidates.find((c) => c.jp.j === 2 && c.jp.p === 1)!
    const nFlagged = 3
    // Flagged group ranks first; no global mass order across the two groups.
    expect(t2.resonances.slice(0, nFlagged).every((r) => r.decaysTo)).toBe(true)
    for (const [i, r] of t2.resonances.slice(nFlagged).entries()) {
      expect(r.decaysTo).toBe(false)
      if (i > 0) {
        expect(r.entry.mass).toBeGreaterThanOrEqual(t2.resonances[nFlagged + i - 1].entry.mass)
      }
    }
  })

  it('applies the mass threshold m_R <= m_A - m_B', () => {
    const fixture: ResonanceDb = {
      schemaVersion: 'test',
      source: 'fixture',
      resonances: [
        { id: 'rA', aliases: [], jp: { j: 0, p: 1 }, mass: 0.9, status: 'seed' },
        { id: 'rB', aliases: [], jp: { j: 0, p: 1 }, mass: 1.2, status: 'seed' },
        { id: 'rC', aliases: [], jp: { j: 2, p: 1 }, mass: 0.5, status: 'seed' },
      ],
    }
    // 0- -> R + 0- : J_R = L, P_R = (-1)^L, so 0+ (L=0) and 2+ (L=2) are allowed.
    const light: Particle = { j: 0, p: -1, mass: 1.5 }
    const heavy: Particle = { j: 0, p: -1, mass: 0.5 } // threshold 1.0
    const { candidates } = decayCheck(light, heavy, fixture)
    expect(by(candidates, 0, 1)).toEqual(['rA']) // rB (1.2) above threshold
    expect(by(candidates, 2, 1)).toEqual(['rC'])
  })
})
