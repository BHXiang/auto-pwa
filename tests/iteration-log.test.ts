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

  it('also handles block style and unquoted paths (AI-written configs)', () => {
    const root = tempIterations()
    const base = join(root, 'solve1')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(base)
    const cfg = join(base, 'config.yml')
    writeFileSync(cfg, `Data:
  order: [Kp, Km, eta]
  data:
    - dat
    - ./data.dat
  phsp:
    - dat
    - ../root/phsp.dat
  bkg: [dat, /abs/bkg.dat]
`)
    const stat = absolutizeDataPaths(cfg, base)
    expect(stat).toEqual({ found: 3, rewritten: 2, unresolved: 0 })
    const out = readFileSync(cfg, 'utf8')
    expect(out).toContain(resolve(base, './data.dat'))
    expect(out).toContain(resolve(base, '../root/phsp.dat'))
    expect(out).toContain('/abs/bkg.dat')
    rmSync(root, { recursive: true, force: true })
  })

  it('flags a malformed sample instead of silently keeping a relative path', () => {
    const root = tempIterations()
    const base = join(root, 'solve1')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(base)
    const cfg = join(base, 'config.yml')
    writeFileSync(cfg, `Data:
  order: [Kp, Km, eta]
  data: [dat]
`)
    const stat = absolutizeDataPaths(cfg, base)
    expect(stat.found).toBe(1)
    expect(stat.unresolved).toBe(1)
    expect(stat.rewritten).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  it('does not count *_weights as samples (they carry numbers, not paths)', () => {
    // Every iter_start used to warn "1/4 个样本的路径无法读取" because
    // `bkg_weights: [0.8]` was counted as a sample and then failed the
    // path-element check — pure noise that could also mask a real bad path.
    const root = tempIterations()
    const base = join(root, 'solve1')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(base)
    const cfg = join(base, 'config.yml')
    writeFileSync(cfg, `Data:
  order: [Kp, Km, eta]
  data: [dat, "./data.dat"]
  bkg: [dat, "./bkg.dat"]
  bkg_weights: [0.8]
`)
    const stat = absolutizeDataPaths(cfg, base)
    expect(stat).toEqual({ found: 2, rewritten: 2, unresolved: 0 })
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves an all-absolute config byte-identical', () => {
    const root = tempIterations()
    const base = join(root, 'solve1')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(base)
    const cfg = join(base, 'config.yml')
    const text = `# untouched
Data:
  order: [Kp, Km, eta]
  data: [dat, "/abs/data.dat"]
`
    writeFileSync(cfg, text)
    const stat = absolutizeDataPaths(cfg, base)
    expect(stat).toEqual({ found: 1, rewritten: 0, unresolved: 0 })
    expect(readFileSync(cfg, 'utf8')).toBe(text)
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
    // Source may be named anything (e.g. the bundled aifit.py): the link in
    // the iteration dir must still be the canonical fit.py.
    writeFileSync(join(base, 'aifit.py'), 'print(1)')
    const r = startIteration({
      iterationsRoot: join(root, 'iterations'),
      baseConfigPath: join(base, 'config.yml'),
      fitScriptPath: join(base, 'aifit.py'),
    })
    expect(r.iter).toBe(0)
    expect(existsSync(join(r.iterDir, 'config.yml'))).toBe(true)
    expect(readFileSync(join(r.iterDir, 'config.yml'), 'utf8')).toBe('base config')
    expect(existsSync(join(r.iterDir, 'fit.py'))).toBe(true)
    // S2：不再生成 note.md 骨架（实测无任何读取者；本轮结论走 SUMMARY.jsonl）
    expect(existsSync(join(r.iterDir, 'note.md'))).toBe(false)
    // second call -> iter-001
    const r2 = startIteration({
      iterationsRoot: join(root, 'iterations'),
      baseConfigPath: join(base, 'config.yml'),
      fitScriptPath: join(base, 'aifit.py'),
    })
    expect(r2.iter).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it('inherits job.sh from the base iteration (one SLURM script serves every round)', () => {
    const root = tempIterations()
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    const ir = join(root, 'iterations')
    mkdirSync(join(ir, 'iter-000'), { recursive: true })
    writeFileSync(join(ir, 'iter-000', 'config.yml'), 'cfg0')
    writeFileSync(join(ir, 'iter-000', 'job.sh'), '#!/bin/bash\n#SBATCH --gres=gpu:v100:1\n')
    const r = startIteration({ iterationsRoot: ir, baseConfigPath: join(ir, 'iter-000', 'config.yml') })
    expect(r.iter).toBe(1)
    // Copied (not symlinked): the next round is allowed to edit its own script.
    expect(readFileSync(join(r.iterDir, 'job.sh'), 'utf8')).toContain('gpu:v100:1')
    expect(r.changed.some((c) => c.includes('job.sh'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})
