import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { IterationLog, startIteration, absolutizeDataPaths } from '../src/iteration-log.js'
import type { IterationRecord } from '../src/report.js'

function tempIterations(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-iter-'))
  return dir
}

const rec0: IterationRecord = {
  iter: 0,
  title: '基线',
  kind: 'other',
  nll: -18623.5,
  conclusion: '基线可接受，KK 链有偏差',
  nextPlan: '加 rho(1450)',
}

describe('IterationLog', () => {
  it('appends records, reads them back sorted, renders HTML', () => {
    const root = tempIterations()
    const log = new IterationLog({ rootDir: root })
    expect(log.nextIter()).toBe(0)
    log.append(rec0)
    const rec1: IterationRecord = { ...rec0, iter: 1, title: '加 rho(1450)', nll: -18635.9, deltaNll: -12.4 }
    log.append(rec1)
    const all = log.readAll()
    expect(all.map((r) => r.iter)).toEqual([0, 1])
    expect(log.nextIter()).toBe(2)
    expect(existsSync(join(root, 'SUMMARY.jsonl'))).toBe(true)
    expect(existsSync(join(root, 'index.html'))).toBe(true)
    expect(existsSync(join(root, 'iter-001', 'report.html'))).toBe(true)
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('加 rho(1450)')
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects duplicate iters', () => {
    const root = tempIterations()
    const log = new IterationLog({ rootDir: root })
    log.append(rec0)
    expect(() => log.append(rec0)).toThrow(/duplicate/)
    rmSync(root, { recursive: true, force: true })
  })

  it('skips malformed lines', () => {
    const root = tempIterations()
    const log = new IterationLog({ rootDir: root })
    writeFileSync(join(root, 'SUMMARY.jsonl'), '{bad json}\n')
    log.append(rec0)
    expect(log.readAll()).toHaveLength(1)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('absolutizeDataPaths', () => {
  it('resolves relative Data paths against the base dir, keeps absolute and comments', () => {
    const root = tempIterations()
    const base = join(root, 'solve1')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(base)
    const cfg = join(base, 'config.yml')
    writeFileSync(cfg, `# my config
Data:
  order: [Ks1, Ks2, omega]
  data: [dat, "../root/cut_data.root"]
  phsp: [ROOT, "../root/cut_phsp.root", "OmegaKsKs", "p4_ks1"]
  bkg:  [dat, "/abs/already.root"]
    # keep me
`)
    absolutizeDataPaths(cfg, base)
    const out = readFileSync(cfg, 'utf8')
    expect(out).toContain(`data: [dat, "${resolve(base, '../root/cut_data.root')}"]`)
    expect(out).toContain(`phsp: [ROOT, "${resolve(base, '../root/cut_phsp.root')}", "OmegaKsKs", "p4_ks1"]`)
    expect(out).toContain('"/abs/already.root"') // absolute untouched
    expect(out).toContain('# keep me') // comments preserved
    expect(out).toContain('# my config')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('startIteration', () => {
  it('creates iter dir with copied config and symlinked scripts', () => {
    const root = tempIterations()
    const base = join(root, 'solve2')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(base)
    writeFileSync(join(base, 'config.yml'), 'base config')
    writeFileSync(join(base, 'fit.py'), 'print(1)')
    const r = startIteration({
      iterationsRoot: join(root, 'iterations'),
      baseConfigPath: join(base, 'config.yml'),
      fitScriptPath: join(base, 'fit.py'),
    })
    expect(r.iter).toBe(0)
    expect(existsSync(join(r.iterDir, 'config.yml'))).toBe(true)
    expect(readFileSync(join(r.iterDir, 'config.yml'), 'utf8')).toBe('base config')
    expect(existsSync(join(r.iterDir, 'fit.py'))).toBe(true)
    expect(existsSync(join(r.iterDir, 'note.md'))).toBe(true)
    // second call -> iter-001
    const r2 = startIteration({
      iterationsRoot: join(root, 'iterations'),
      baseConfigPath: join(base, 'config.yml'),
      fitScriptPath: join(base, 'fit.py'),
    })
    expect(r2.iter).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })
})
