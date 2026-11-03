import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultDb, pdgProvider } from '../src/db.js'
import { lookupResonance } from '../src/lookup.js'
import { auditLocalStates } from '../src/local-states.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const tsx = join(root, 'node_modules', '.bin', 'tsx')

function childDb(source: 'api', python: string) {
  // The annotation keeps the index signature: TS object spread does not carry
  // `ProcessEnv`'s `[key: string]: string | undefined` over to the literal.
  const env: NodeJS.ProcessEnv = { ...process.env, PWA_PDG_SOURCE: source, PWA_PDG_PYTHON: python }
  delete env.VITEST
  delete env.NODE_ENV
  const script = `
    import { defaultDb, pdgProvider } from './src/db.ts'
    import { lookupResonance } from './src/lookup.ts'
    const phi = lookupResonance(defaultDb, { name: 'phi2170' })[0]
    console.log(JSON.stringify({ provider: pdgProvider, entries: defaultDb.resonances.length,
      phi: phi && { id: phi.id, status: phi.status, mass: phi.mass, width: phi.width, c: phi.c } }))
  `
  const run = spawnSync(tsx, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 90000 })
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as {
    provider: typeof pdgProvider
    entries: number
    phi?: { id: string; status: string; mass: number; width: number; c?: number }
  }
}

const python = process.env.PWA_PDG_PYTHON ?? process.env.PWA_CTPWA_PYTHON ?? 'python'
const hasPdg = spawnSync(python, ['-c', 'import pdg'], { encoding: 'utf8' }).status === 0

describe('PDG provider', () => {
  it('uses the deterministic snapshot in the unit-test process', () => {
    expect(pdgProvider.source).toBe('snapshot')
    const phi = lookupResonance(defaultDb, { name: 'phi2170' })[0]
    expect(phi).toMatchObject({ id: 'phi(2170)', status: 'pdg', c: -1 })
    expect(phi?.mass).toBeCloseTo(2.16381, 6)
    expect(phi?.width).toBeCloseTo(0.08843, 6)
  })

  ;(hasPdg ? it : it.skip)('builds the production table from the official local PDG API', () => {
    const out = childDb('api', python)
    expect(out.provider.source).toBe('pdg-api')
    expect(out.provider.edition).toBe('2026')
    expect(out.provider.sqliteSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.entries).toBeGreaterThan(300)
    expect(out.phi).toMatchObject({ id: 'phi(2170)', status: 'pdg', c: -1 })
    expect(out.phi?.mass).toBeCloseTo(2.16381, 6)
  }, 90000)

  it('falls back explicitly when the PDG API cannot start', () => {
    const out = childDb('api', '/bin/false')
    expect(out.provider.source).toBe('snapshot-fallback')
    expect(out.provider.warning).toContain('回退到 pdg.json')
    expect(out.phi?.status).toBe('pdg')
  }, 30000)
})

describe('local-state scope', () => {
  it('records analysis-local additions separately from the reviewed global registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwa-local-audit-'))
    try {
      writeFileSync(join(dir, 'local-states.json'), JSON.stringify({
        states: [{ id: 'Z(9999)', aliases: ['Z9999'], jp: { j: 1, p: -1 }, mass: 9.999 }],
      }))
      const audit = auditLocalStates(dir)
      expect(audit.global.states).toEqual([])
      expect(audit.analysis?.states).toEqual(['Z(9999)'])
      expect(audit.analysis?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(auditLocalStates(join(dir, 'other')).analysis).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
