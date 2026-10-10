import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../src/config-edit.js'
import { gateConfig } from '../src/config-gate.js'
import { defaultDb } from '../src/db.js'
import {
  buildProvenance,
  writeProvenance,
  readProvenance,
  checkProvenanceDrift,
  initFromScriptArgs,
  provenancePath,
  provenanceSummary,
} from '../src/provenance.js'

const CONFIG = `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969}
  eta: {J: 0, P: -1, mass: 0.5478}
  Kp: {J: 0, P: -1, mass: 0.4937}
  Km: {J: 0, P: -1, mass: 0.4937}
Data:
  order: [Kp, Km, eta]
  data: [dat, "/pwa/data.dat"]
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
    free: [0, 1]
`

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-prov-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function build(iterDir: string, text = CONFIG, scriptArgs?: string[]) {
  const cfg = parseConfig(text)
  const gate = gateConfig(cfg, text, defaultDb)
  return buildProvenance({
    tool: 'test',
    iterDir,
    configPath: join(iterDir, 'config.yml'),
    configText: text,
    config: cfg,
    gate,
    ...(scriptArgs !== undefined ? { scriptArgs } : {}),
  })
}

describe('initFromScriptArgs', () => {
  it('recognises --warm / --init-from / --resume-from with both spellings', () => {
    expect(initFromScriptArgs(['--warm', 'iter-003/results/fit.json'])).toEqual({ source: 'warm', from: 'iter-003/results/fit.json' })
    expect(initFromScriptArgs(['--warm=iter-1/results/fit.json'])).toEqual({ source: 'warm', from: 'iter-1/results/fit.json' })
    expect(initFromScriptArgs(['--init-from', 'x.json'])).toEqual({ source: 'warm', from: 'x.json' })
  })

  it('recognises an explicit --seed and falls back to the driver default', () => {
    expect(initFromScriptArgs(['--runs', '1', '--seed', '7'])).toEqual({ source: 'random', seed: 7, note: '显式 --seed' })
    expect(initFromScriptArgs(['--seed=9'])).toEqual({ source: 'random', seed: 9, note: '显式 --seed' })
    expect(initFromScriptArgs(['--runs', '1']).source).toBe('random')
    expect(initFromScriptArgs(undefined).source).toBe('random')
  })

  it('default note points at the warm start the driver actually has', () => {
    // aifit gained --warm <fit.json> (name-aligned, first run only); the note must
    // match the driver instead of describing a flag that does not exist.
    const note = initFromScriptArgs(['--runs', '1']).note ?? ''
    expect(note).toContain('--warm')
    expect(note).toContain('按参数名对齐')
    expect(note).toContain('seed=42')
  })
})

describe('provenance record (B1)', () => {
  it('round-trips through results/provenance.json without undefined keys', () => {
    withTmp((dir) => {
      const p = build(dir, CONFIG, ['--runs', '1'])
      const file = writeProvenance(dir, p)
      expect(file).toBe(provenancePath(dir))
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toMatch(/undefined/)
      const back = readProvenance(dir)!
      expect(back.configMd5).toBe(p.configMd5)
      expect(back.resonances.map((r) => r.name)).toEqual(['phi1020'])
      expect(back.resonances[0]!.free).toEqual([0, 1])
      expect(back.scriptArgs).toEqual(['--runs', '1'])
      expect(back.stats.resonances).toBe(1)
      expect(back.data.data).toEqual(['dat', '/pwa/data.dat'])
    })
  })

  it('keeps the include file in the record when Resonances is external', () => {
    withTmp((dir) => {
      const text = CONFIG.replace(/Resonances:\n[\s\S]*$/, 'Resonances: Resonances.yml\n')
      const p = build(dir, text)
      expect(p.resonancesInclude?.path).toBe('Resonances.yml')
    })
  })

  it('flags config drift in the same directory (old results no longer describe it)', () => {
    withTmp((dir) => {
      writeProvenance(dir, build(dir, CONFIG))
      expect(checkProvenanceDrift(dir, CONFIG).drift).toEqual([])
      const changed = CONFIG.replace('parameters: [1.0195, 0.0045]', 'parameters: [1.03, 0.005]')
      const codes = checkProvenanceDrift(dir, changed).drift.map((d) => d.code)
      expect(codes).toContain('config-changed-since-record')
    })
  })

  it('flags run-settings drift (NLL comparability guard, C2)', () => {
    withTmp((dir) => {
      writeProvenance(dir, build(dir, CONFIG, ['--runs', '10']))
      const codes = checkProvenanceDrift(dir, CONFIG, ['--runs', '1']).drift.map((d) => d.code)
      expect(codes).toContain('run-settings-changed')
      expect(checkProvenanceDrift(dir, CONFIG, ['--runs', '10']).drift).toEqual([])
    })
  })

  it('reports no drift when there is no record at all', () => {
    withTmp((dir) => {
      expect(checkProvenanceDrift(dir, CONFIG).drift).toEqual([])
    })
  })

  it('summarises into the diary subset (resonances + md5 + init source)', () => {
    withTmp((dir) => {
      const p = build(dir, CONFIG, ['--seed', '5'])
      const s = provenanceSummary(p)
      expect(s.configMd5).toBe(p.configMd5)
      expect(s.resonances?.map((r) => r.name)).toEqual(['phi1020'])
      expect(s.scriptArgs).toEqual(['--seed', '5'])
    })
  })
})
