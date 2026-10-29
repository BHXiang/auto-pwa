import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTransportMode, hasSlurmClients, pickTransport, slurmConfigFromEnv } from '../src/fit-transport.js'
import { bundledJobTemplatePath, resolveJobScript } from '../src/slurm-template.js'

const ORIGINAL_PATH = process.env.PATH

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  delete process.env.PWA_FIT_TRANSPORT
  delete process.env.PWA_SLURM_SCANCEL_ON_CANCEL
})

/** Create fake slurm CLIs on PATH so hasSlurmClients/pickTransport see them. */
function makeFakeSlurmBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-pwa-slurm-bin-'))
  for (const name of ['sbatch', 'squeue', 'sacct', 'scancel']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`
  return bin
}

describe('fit-transport', () => {
  it('resolveTransportMode defaults to auto and honors explicit values', () => {
    expect(resolveTransportMode({})).toBe('auto')
    expect(resolveTransportMode({ PWA_FIT_TRANSPORT: 'slurm' })).toBe('slurm')
    expect(resolveTransportMode({ PWA_FIT_TRANSPORT: 'LOCAL' })).toBe('local')
    expect(resolveTransportMode({ PWA_FIT_TRANSPORT: 'weird' })).toBe('auto')
  })

  it('hasSlurmClients is true when the three clients are on PATH', () => {
    const bin = makeFakeSlurmBin()
    expect(hasSlurmClients()).toBe(true)
    process.env.PATH = ORIGINAL_PATH // still on ORIGINAL, likely no slurm
    // Restore the fake PATH from a fresh check only if it is present; otherwise
    // we cannot assert a negative reliably on a machine without slurm.
    void bin
  })

  it('slurmConfigFromEnv keeps only detach semantics (resources live in job.sh)', () => {
    const { cluster, config } = slurmConfigFromEnv({})
    expect(cluster.transport).toBe('slurm')
    // No partition/qos/gres/template knobs any more: the script owns them.
    expect('partition' in cluster).toBe(false)
    expect('template' in cluster).toBe(false)
    expect('template' in config).toBe(false)
    expect(cluster.scancelOnCancel).toBe(false)
    expect(slurmConfigFromEnv({ PWA_SLURM_SCANCEL_ON_CANCEL: '1' }).cluster.scancelOnCancel).toBe(true)
  })

  it('pickTransport: torch-visible GPU -> local; no GPU + slurm clients -> slurm', () => {
    const bin = makeFakeSlurmBin()
    // Fake python that reports CUDA available.
    const pyTrue = mkdtempSync(join(tmpdir(), 'dsh-pwa-py-'))
    const truePy = join(pyTrue, 'py')
    writeFileSync(truePy, '#!/bin/sh\necho True\n', { mode: 0o755 })
    expect(pickTransport(truePy, '')).toBe('local')
    // Fake python that reports no CUDA -> fall through to slurm because clients exist.
    const pyFalse = mkdtempSync(join(tmpdir(), 'dsh-pwa-py2-'))
    const falsePy = join(pyFalse, 'py')
    writeFileSync(falsePy, '#!/bin/sh\necho False\n', { mode: 0o755 })
    expect(pickTransport(falsePy, '')).toBe('slurm')
    rmSync(pyTrue, { recursive: true, force: true })
    rmSync(pyFalse, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
})

describe('slurm-template (AI-authored job.sh contract)', () => {
  const mkIter = (): string => mkdtempSync(join(tmpdir(), 'dsh-pwa-iter-'))

  it('installs the bundled template as <iterDir>/job.sh when missing', () => {
    const dir = mkIter()
    const r = resolveJobScript({ iterDir: dir })
    expect(r.installed).toBe(true)
    expect(r.path).toBe(join(dir, 'job.sh'))
    const s = readFileSync(r.path, 'utf8')
    expect(s).toContain('#SBATCH --partition=gpu')
    expect(s).toContain('#SBATCH --qos=pwanormal')
    expect(s).toContain('#SBATCH --gres=gpu:v100:1')
    expect(s).toContain('#SBATCH --output=fit.log')
    // Contract: no hard-coded iteration path (--chdir sets the cwd), args forwarded.
    expect(s).not.toMatch(/\n\s*cd\s+"?\//)
    expect(s).toContain('fit.py "$@"')
    expect(s).toContain('CUDA_HOME=/usr/local/cuda-12.9')
    // conda activate must not be *executed* (compute nodes lack the shell hook);
    // it may only be mentioned in the header comment explaining why not.
    expect(s).not.toMatch(/^(?!\s*#).*conda activate/m)
    expect(s).not.toMatch(/^(?!\s*#)\s*source\s/m)
    rmSync(dir, { recursive: true, force: true })
  })

  it('there is exactly ONE template: v100/a100/auto all install the same file', () => {
    for (const spec of ['auto', 'v100', 'a100']) {
      const dir = mkIter()
      const r = resolveJobScript({ iterDir: dir, jobScript: spec })
      expect(r.installed, spec).toBe(true)
      expect(r.path).toBe(join(dir, 'job.sh'))
      const s = readFileSync(r.path, 'utf8')
      // Default is V100, and the A100 swap is documented inside the file.
      expect(s, spec).toContain('#SBATCH --partition=gpu')
      expect(s, spec).toContain('#SBATCH --gres=gpu:v100:1')
      expect(s, spec).toContain('gpupwa')
      expect(s, spec).toContain('gpu:a100:1')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an existing job.sh (the AI may have customized it)', () => {
    const dir = mkIter()
    writeFileSync(join(dir, 'job.sh'), '#!/bin/bash\n#SBATCH --partition=custom\n')
    const r = resolveJobScript({ iterDir: dir })
    expect(r.installed).toBe(false)
    expect(readFileSync(r.path, 'utf8')).toContain('--partition=custom')
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves an explicit path relative to the iteration dir, and fails loudly when absent', () => {
    const dir = mkIter()
    writeFileSync(join(dir, 'my_job.sh'), '#!/bin/bash\n')
    expect(resolveJobScript({ iterDir: dir, jobScript: 'my_job.sh' }).path).toBe(join(dir, 'my_job.sh'))
    expect(() => resolveJobScript({ iterDir: dir, jobScript: 'nope.sh' })).toThrow(/nope\.sh/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('install:false never writes (preflight/validation)', () => {
    const dir = mkIter()
    const r = resolveJobScript({ iterDir: dir, install: false })
    expect(r.installed).toBe(false)
    expect(existsSync(join(dir, 'job.sh'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('the single bundled template keeps the runner contract', () => {
    const p = bundledJobTemplatePath()
    expect(existsSync(p), p).toBe(true)
    expect(p).toMatch(/scripts\/slurm-job\.sh$/)
    const s = readFileSync(p, 'utf8')
    // The runner submits with --chdir; a hard-coded cd would defeat _trials/.
    expect(s).not.toMatch(/^\s*cd\s/m)
    // --output must stay relative so it lands in the --chdir directory.
    expect(s).toContain('#SBATCH --output=fit.log')
    // Args must reach fit.py (--runs/--max-iter/--config).
    expect(s).toContain('fit.py "$@"')
    expect(s).toMatch(/#SBATCH --gres=gpu:v100:1/)
    // Part 1/Part 2 structure with per-line explanations (the user's format).
    expect(s).toContain('######## Part 1 #########')
    expect(s).toContain('######## Part 2 ######')
    // The A100 switch must be a table the AI can apply without guessing.
    expect(s).toContain('gpupwa')
    expect(s).toContain('pwadedicate')
  })
})
