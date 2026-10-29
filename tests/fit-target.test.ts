import { describe, expect, it } from 'vitest'
import {
  defaultFitTarget,
  parseFitTarget,
  resolveFitTarget,
  type HostCapabilities,
} from '../src/fit-target.js'

const GPU: HostCapabilities = { gpu: true, slurm: false }
const SLURM: HostCapabilities = { gpu: false, slurm: true, gpuIssue: 'no CUDA device' }
const BARE: HostCapabilities = { gpu: false, slurm: false, gpuIssue: 'no CUDA device' }

const resolve = (opts: { requested?: string; hasRunScript?: boolean; caps: HostCapabilities; env?: NodeJS.ProcessEnv }) =>
  resolveFitTarget({ ...opts, env: opts.env ?? {} })

describe('fit-target', () => {
  it('parseFitTarget accepts the four targets and defaults to auto', () => {
    expect(parseFitTarget('cpu')).toBe('cpu')
    expect(parseFitTarget('GPU')).toBe('gpu')
    expect(parseFitTarget('slurm')).toBe('slurm')
    expect(parseFitTarget('auto')).toBe('auto')
    expect(parseFitTarget('nonsense')).toBe('auto')
    expect(parseFitTarget(undefined)).toBe('auto')
  })

  it('deployment default: PWA_FIT_TARGET, with PWA_FIT_TRANSPORT as the legacy alias', () => {
    expect(defaultFitTarget({})).toBe('auto')
    expect(defaultFitTarget({ PWA_FIT_TARGET: 'cpu' })).toBe('cpu')
    expect(defaultFitTarget({ PWA_FIT_TARGET: 'slurm' })).toBe('slurm')
    // Legacy: local meant "this host", which now means auto (GPU -> CPU).
    expect(defaultFitTarget({ PWA_FIT_TRANSPORT: 'local' })).toBe('auto')
    expect(defaultFitTarget({ PWA_FIT_TRANSPORT: 'slurm' })).toBe('slurm')
    // PWA_FIT_TARGET wins over the alias.
    expect(defaultFitTarget({ PWA_FIT_TARGET: 'cpu', PWA_FIT_TRANSPORT: 'slurm' })).toBe('cpu')
  })

  it('runScript overrides every target', () => {
    const r = resolve({ requested: 'slurm', hasRunScript: true, caps: SLURM })
    expect(r.target).toBe('script')
    expect(r.error).toBeUndefined()
    expect(r.reason).toContain('runScript')
  })

  it('explicit targets are validated against the host', () => {
    expect(resolve({ requested: 'cpu', caps: GPU }).target).toBe('cpu')
    expect(resolve({ requested: 'gpu', caps: GPU }).target).toBe('gpu')
    expect(resolve({ requested: 'slurm', caps: SLURM }).target).toBe('slurm')
    // gpu without a GPU -> actionable error naming the alternatives
    const noGpu = resolve({ requested: 'gpu', caps: SLURM })
    expect(noGpu.error).toContain('没有可用 GPU')
    expect(noGpu.error).toContain('"cpu"')
    expect(noGpu.error).toContain('"slurm"')
    // slurm without clients -> actionable error
    const noSlurm = resolve({ requested: 'slurm', caps: GPU })
    expect(noSlurm.error).toContain('sbatch')
  })

  it('auto: GPU first, then CPU when the host has neither', () => {
    expect(resolve({ caps: GPU }).target).toBe('gpu')
    expect(resolve({ caps: BARE }).target).toBe('cpu')
    expect(resolve({ caps: BARE }).reason).toContain('cpu')
  })

  it('auto refuses to guess on a login node (slurm but no GPU)', () => {
    const r = resolve({ caps: SLURM })
    expect(r.error).toContain('target:"cpu"')
    expect(r.error).toContain('target:"slurm"')
    expect(r.error).toContain('PWA_FIT_TARGET=slurm')
  })

  it('PWA_FIT_TARGET resolves the login-node ambiguity once, at deployment', () => {
    expect(resolve({ caps: SLURM, env: { PWA_FIT_TARGET: 'slurm' } }).target).toBe('slurm')
    expect(resolve({ caps: SLURM, env: { PWA_FIT_TARGET: 'cpu' } }).target).toBe('cpu')
    expect(resolve({ caps: SLURM, env: { PWA_FIT_TRANSPORT: 'slurm' } }).target).toBe('slurm')
  })

  it('explicit target beats the deployment default', () => {
    expect(resolve({ requested: 'cpu', caps: GPU, env: { PWA_FIT_TARGET: 'slurm' } }).target).toBe('cpu')
    expect(resolve({ requested: 'gpu', caps: GPU, env: { PWA_FIT_TARGET: 'cpu' } }).target).toBe('gpu')
  })
})
