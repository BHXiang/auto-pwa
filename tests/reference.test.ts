import { describe, expect, it } from 'vitest'
import { parseConfig, dumpConfig, applyResonanceAddition } from '../src/config-edit.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { defaultDb } from '../src/db.js'
import type { ResonanceProposal } from '../src/types.js'

const CONFIG = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  eta:
    J: 0
    P: -1
    mass: 0.5478
  Kp:
    J: 0
    P: -1
    mass: 0.4937
  Km:
    J: 0
    P: -1
    mass: 0.4937

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
      - [Kp, R_Keta]
    R_KK: [Kp, Km]
    R_Keta: [Kp, eta]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_Keta:
        - [J: 1, P: -1]: [K1_1410]

Constraints:
  maxL: 3

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
  K1_1410:
    J: 1
    P: -1
    model: BWR
    parameters: [1.403, 0.174]
`

const cfg = () => parseConfig(CONFIG)

const base = (over: Partial<ResonanceProposal>): ResonanceProposal => ({
  name: 'phi1020',
  chain: 'R_KK',
  jpGroup: { j: 1, p: -1 },
  model: 'BWR',
  parameters: [1.0195, 0.0045],
  ...over,
})

describe('provenance (reference) gate semantics', () => {
  it('without reference: non-PDG name is still rejected', () => {
    const r = validateResonanceAddition(defaultDb, cfg(), base({ name: 'X_never_on_pdg' }))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('not-on-pdg')
  })

  it('with reference: non-PDG name is allowed (warning), physics gates still apply', () => {
    const r = validateResonanceAddition(defaultDb, cfg(), base({ name: 'X_never_on_pdg', reference: 'BESIII 2025 arXiv:2501.12345' }))
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('not-on-pdg-with-reference')
    expect(r.errors.map((e) => e.code)).not.toContain('not-on-pdg')
  })

  it('without reference: mass deviating from the PDG average is an error', () => {
    // phi(1680) exists in PDG (m≈1.68) but is not in the config yet.
    const r = validateResonanceAddition(defaultDb, cfg(), base({ name: 'phi(1680)', parameters: [1.8, 0.15] }))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('mass-mismatch')
  })

  it('with reference: mass may follow the cited experiment instead of the average', () => {
    const r = validateResonanceAddition(defaultDb, cfg(), base({ name: 'phi(1680)', parameters: [1.8, 0.15], reference: 'doi:10.1134/S1063779624701715' }))
    expect(r.ok).toBe(true)
    expect(r.errors.map((e) => e.code)).not.toContain('mass-mismatch')
    expect(r.warnings.map((w) => w.code)).toContain('reference-not-found') // DOI not a phi(1680) measurement
  })

  it('with reference: J^P deviating from PDG downgrades to a warning (still physically reachable)', () => {
    // f0(980) is 0+ on PDG; proposing [1-] deviates, but 1- is reachable at
    // the R_KK vertex and C-consistent — only provenance makes it legal.
    const r = validateResonanceAddition(defaultDb, cfg(), base({ name: 'f0(980)', jpGroup: { j: 1, p: -1 }, parameters: [0.99, 0.1], reference: 'PDG 2026 update note' }))
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('jpc-deviates-with-reference')
    expect(r.errors.map((e) => e.code)).not.toContain('jpc-mismatch')
  })

  it('with reference: physics gates (threshold, decay vertex, C) are NOT exempted', () => {
    // 2+ into R_KK is C-forbidden regardless of provenance.
    const r = validateResonanceAddition(defaultDb, cfg(), base({ jpGroup: { j: 2, p: 1 }, reference: 'any paper' }))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
    // Mass above the kinematic threshold stays rejected.
    const r2 = validateResonanceAddition(defaultDb, cfg(), base({ parameters: [3.0, 0.1], reference: 'any paper' }))
    expect(r2.ok).toBe(false)
    expect(r2.errors.map((e) => e.code)).toContain('above-threshold')
  })
})

describe('provenance data integration (pdg.json measurements)', () => {
  it('with reference: a matching measurement DOI triggers the cross-check warning', () => {
    // Find a PDG entry (not in the config) whose measurements carry a DOI
    // and whose J^P is reachable at the R_KK vertex (1- / 3-).
    const entry = defaultDb.resonances.find(
      (e) => e.jp.j === 1 && e.jp.p === -1 && e.mass < 2.5 && (e.measurements ?? []).some((m) => m.doi !== undefined) && !['phi1020', 'K1_1410'].includes(e.id),
    )
    expect(entry).toBeDefined()
    const m = entry!.measurements!.find((x) => x.doi !== undefined)!
    const r = validateResonanceAddition(defaultDb, cfg(), {
      name: entry!.id,
      chain: 'R_KK',
      jpGroup: { j: entry!.jp.j, p: entry!.jp.p },
      model: 'BWR',
      parameters: [m.value!, 0.05],
      reference: m.doi,
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('reference-measurement-check')
  })

  it('lookup exposes the measurement history (single-experiment values)', () => {
    const entry = defaultDb.resonances.find((e) => e.id === 'phi(1020)')!
    expect((entry.measurements ?? []).length).toBeGreaterThan(0)
    const newest = entry.measurements![0]!
    expect(newest.year).toBeGreaterThanOrEqual(2020)
    expect(newest.doi).toBeDefined()
    expect(newest.value).toBeGreaterThan(0)
    expect(typeof newest.usedInAverage).toBe('boolean')
    // Newest first.
    const years = entry.measurements!.map((x) => x.year ?? 0)
    expect([...years].sort((a, b) => b - a)).toEqual(years)
  })
})

describe('reference round-trips through config.yml', () => {
  it('apply writes reference into the YAML and reparse reads it back', () => {
    const proposal: ResonanceProposal = {
      name: 'f2_1270',
      chain: 'R_KK',
      jpGroup: { j: 2, p: 1 },
      model: 'BWR',
      parameters: [1.275, 0.187],
      reference: 'BESIII 2025 arXiv:2501.12345',
    }
    const applied = applyResonanceAddition(cfg(), proposal)
    expect(applied.errors).toHaveLength(0)
    expect(applied.changed.some((c) => c.includes('reference="BESIII 2025'))).toBe(true)
    const text = dumpConfig(applied.config)
    expect(text).toContain('reference: BESIII 2025 arXiv:2501.12345')
    const reparsed = parseConfig(text)
    expect(reparsed.resonances['f2_1270']?.reference).toBe('BESIII 2025 arXiv:2501.12345')
  })
})
