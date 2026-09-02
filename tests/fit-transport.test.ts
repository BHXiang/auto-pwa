import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTransportMode, hasSlurmClients, pickTransport, slurmConfigFromEnv } from '../src/fit-transport.js'
import { renderSlurmSubmission, renderSlurmBatchSubmission, resolveSlurmTemplateKind } from '../src/slurm-template.js'

const ORIGINAL_PATH = process.env.PATH

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  delete process.env.PWA_FIT_TRANSPORT
  delete process.env.PWA_SLURM_TEMPLATE
  delete process.env.PWA_SLURM_PARTITION
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

  it('slurmConfigFromEnv reads PWA_SLURM_* and the template kind', () => {
    const env = { PWA_SLURM_TEMPLATE: 'v100', PWA_SLURM_PARTITION: 'gpu-x', PWA_SLURM_QOS: 'q' }
    const { cluster } = slurmConfigFromEnv(env)
    expect(cluster.transport).toBe('slurm')
    expect(cluster.template).toBe('v100')
    expect(cluster.partition).toBe('gpu-x')
    expect(cluster.qos).toBe('q')
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

describe('slurm-template', () => {
  it('renders the A100 template with a foreground python run and hard-coded cwd', () => {
    const s = renderSlurmSubmission({
      kind: 'a100',
      jobName: 'Jpsi2KKeta',
      output: '/x/iter-000/fit.log',
      python: '/env/ctpwa/bin/python',
      ldLibraryPath: '',
      fitScript: 'fit.py',
      scriptArgs: ['--runs', '1', '--max-iter', '500'],
      cwd: '/x/iter-000',
    })
    expect(s).toContain('#SBATCH --partition=gpupwa')
    expect(s).toContain('#SBATCH --qos=pwadedicate')
    expect(s).toContain('#SBATCH --gres=gpu:a100:2')
    expect(s).toContain('cd "/x/iter-000"')
    expect(s).toContain('/env/ctpwa/bin/python fit.py --runs 1 --max-iter 500')
    // No backgrounding: the fit must run in the foreground.
    expect(s).not.toContain('--max-iter 500 &')
  })

  it('renders the V100 template with the same foreground python run', () => {
    const s = renderSlurmSubmission({ kind: 'v100', jobName: 'j', output: 'log', python: 'python', ldLibraryPath: '', fitScript: 'fit.py', cwd: '/x' })
    expect(s).toContain('#SBATCH --partition=gpu')
    expect(s).toContain('#SBATCH --gres=gpu:v100:2')
    expect(s).toContain('python fit.py')
  })

  it('injects LD_LIBRARY_PATH when set', () => {
    const s = renderSlurmSubmission({ kind: 'a100', jobName: 'j', output: 'log', python: 'python', ldLibraryPath: '/a:/b', fitScript: 'fit.py', cwd: '/x' })
    expect(s).toContain('export LD_LIBRARY_PATH="/a:/b:$LD_LIBRARY_PATH"')
  })

  it('renders a batch script that cd-es into each iteration dir', () => {
    const s = renderSlurmBatchSubmission({
      kind: 'a100',
      jobName: 'batch',
      output: '/x/fit.log',
      commands: [
        { iterDir: '/x/iter-001', python: 'python', ldLibraryPath: '', fitScript: 'fit.py', scriptArgs: ['--runs', '1'] },
        { iterDir: '/x/iter-002', python: 'python', ldLibraryPath: '', fitScript: 'fit.py', scriptArgs: ['--runs', '1'] },
      ],
    })
    expect(s).toContain('cd "/x/iter-001"')
    expect(s).toContain('cd "/x/iter-002"')
    expect(s).toContain('python fit.py --runs 1')
    expect(s).toContain('batch done')
  })

  it('resolveSlurmTemplateKind defaults to a100 and honors v100', () => {
    expect(resolveSlurmTemplateKind({})).toBe('a100')
    expect(resolveSlurmTemplateKind({ PWA_SLURM_TEMPLATE: 'v100' })).toBe('v100')
  })
})
