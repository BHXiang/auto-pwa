import { describe, expect, it } from 'vitest'
import { defaultDb } from '../src/db.js'
import { lookupResonance, normalizeName } from '../src/lookup.js'

describe('normalizeName', () => {
  it('strips case, spaces and symbols', () => {
    expect(normalizeName('phi(1020)')).toBe('phi1020')
    expect(normalizeName("f2'(1525)")).toBe('f21525')
    expect(normalizeName('K*_1410')).toBe('k1410')
  })
})

describe('lookupResonance by name', () => {
  it('matches canonical ids and analysis-style aliases', () => {
    expect(lookupResonance(defaultDb, { name: 'phi1020' }).map((r) => r.id)).toEqual(['phi(1020)'])
    // Alias lands on one charge member of the pdg multiplet.
    const k1 = lookupResonance(defaultDb, { name: 'K1_1410' })
    expect(k1).toHaveLength(1)
    expect(k1[0].aliases).toContain('K1_1410')
    expect(k1[0].jp).toEqual({ j: 1, p: -1 })
    const k2 = lookupResonance(defaultDb, { name: 'K2*_1980' })
    expect(k2).toHaveLength(2)
    for (const r of k2) expect(r.jp).toEqual({ j: 2, p: 1 })
  })

  it('returns [] for an unknown name', () => {
    expect(lookupResonance(defaultDb, { name: 'does_not_exist' })).toEqual([])
  })
})

describe('lookupResonance by quantum numbers', () => {
  it('filters by exact JP', () => {
    const hits = lookupResonance(defaultDb, { jp: { j: 3, p: -1 } })
    // Whole 3- multiplet families: omega3, rho3, K3*, phi3.
    const ids = hits.map((r) => r.id)
    expect(ids).toContain('omega(3)(1670)')
    expect(ids).toContain('rho(3)(1690)0')
    expect(ids).toContain('K(3)*(1780)0')
    expect(ids).toContain('phi(3)(1850)')
    expect(ids).toHaveLength(9)
  })

  it('filters by mass range ascending', () => {
    const hits = lookupResonance(defaultDb, { massRange: [1.0, 1.1] })
    expect(hits.map((r) => r.id)).toEqual(['phi(1020)'])
  })

  it('combines filters with AND', () => {
    const hits = lookupResonance(defaultDb, { jp: { j: 1, p: -1 }, massRange: [0.7, 1.1] })
    const ids = hits.map((r) => r.id)
    expect(ids).toContain('rho(770)0')
    expect(ids).toContain('omega(782)')
    expect(ids).toContain('K*(892)0')
    expect(ids).toContain('phi(1020)')
    expect(ids).toHaveLength(9)
    for (const r of hits) {
      expect(r.jp).toEqual({ j: 1, p: -1 })
      expect(r.mass).toBeGreaterThanOrEqual(0.7)
      expect(r.mass).toBeLessThanOrEqual(1.1)
    }
  })
})

describe('lookupResonance by decay mode', () => {
  it('finds resonances whose daughters include K+ K-', () => {
    const hits = lookupResonance(defaultDb, { decayTo: ['K+', 'K-'] })
    const ids = hits.map((r) => r.id)
    expect(ids).toContain('phi(1020)')
    expect(ids).toContain("f(2)'(1525)")
    expect(ids).toHaveLength(5) // phi(1020), f(0)(980), f(0)(1500), f(0)(1710), f(2)'(1525)
  })
})
