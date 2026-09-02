/**
 * fit-transport — decide where a fit runs: locally (this host has a usable CUDA
 * device) or on the cluster via SLURM (this host has the slurm clients but no
 * local GPU). This is the "no CUDA but has SLURM -> submit a job" rule the
 * plugin adds on top of the existing local runner.
 *
 * Selection is driven by `PWA_FIT_TRANSPORT` (auto|local|slurm), defaulting to
 * auto:
 *   auto  -> local if torch sees a CUDA device, else slurm if sbatch/ps/sbatch
 *            clients exist, else local (so the existing "no GPU" fail-fast
 *            diagnostic fires, extended with a PWA_FIT_TRANSPORT hint).
 *   local -> force the local runner (no GPU -> fail fast, as today).
 *   slurm -> force the slurm runner (no slurm clients -> fail fast here).
 *
 * The runner factory keeps the local path untouched, so a GPU author machine
 * and the in-box test suite behave exactly as before.
 */
import { spawnSync } from 'node:child_process'
import { detectGpuAvailability, LocalFitRunner, defaultFitRunnerConfig } from './fit-runner.js'
import { SbatchFitRunner, type SbatchFitRunnerConfig } from './fit-runner-sbatch.js'
import { resolveSlurmTemplateKind, type SlurmTemplateKind } from './slurm-template.js'
import { resolveEnv as resolveEnvSafe } from './config.js'

export type FitTransport = 'local' | 'slurm'
export type TransportMode = FitTransport | 'auto'

/** Resolve the explicitly-requested transport mode from the environment. */
export function resolveTransportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  const v = (env.PWA_FIT_TRANSPORT ?? 'auto').toLowerCase().trim()
  if (v === 'local' || v === 'slurm') return v
  return 'auto'
}

/** True when the host has the slurm submission/query clients on PATH. */
export function hasSlurmClients(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const bin of ['sbatch', 'squeue', 'sacct']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (r.error || r.status !== 0) return false
  }
  return true
}

/**
 * Detect which transport to use. `python`/`ldLibraryPath` are only consumed for
 * the local-GPU probe; in 'slurm' mode they are simply not needed here (they
 * are baked into the submission script instead).
 */
export function pickTransport(
  python: string,
  ldLibraryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): FitTransport {
  const mode = resolveTransportMode(env)
  if (mode === 'local') return 'local'
  if (mode === 'slurm') return 'slurm'
  // auto
  const localGpu = detectGpuAvailability(python, ldLibraryPath) === undefined
  if (localGpu) return 'local'
  if (hasSlurmClients(env)) return 'slurm'
  // Neither: fall back to local so submit() fails fast with the evocative
  // "no CUDA device" diagnostic (extended below with the transport hint).
  return 'local'
}

/** SLURM cluster config resolved from the environment (falling back to the
 * template defaults). */
export interface SlurmClusterConfig {
  transport: 'slurm'
  template: SlurmTemplateKind
  partition?: string
  qos?: string
  account?: string
  gres?: string
  ntasks?: number
  memPerCpu?: number
  timeLimit?: string
}

/** Basename of an absolute/relative script path (fit.py link lives in iterDir). */
function filenameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1]
}

/** Build the SbatchFitRunnerConfig from the environment. */
export function slurmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  config: SbatchFitRunnerConfig
  cluster: SlurmClusterConfig
} {
  const fitEnv = resolveEnvSafe(env)
  const template = resolveSlurmTemplateKind(env)
  const parse = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const cluster: SlurmClusterConfig = {
    transport: 'slurm',
    template,
    partition: env.PWA_SLURM_PARTITION,
    qos: env.PWA_SLURM_QOS,
    account: env.PWA_SLURM_ACCOUNT,
    gres: env.PWA_SLURM_GRES,
    ntasks: parse(env.PWA_SLURM_NTASKS),
    memPerCpu: parse(env.PWA_SLURM_MEM_PER_CPU),
    timeLimit: env.PWA_SLURM_TIME,
  }
  const config: SbatchFitRunnerConfig = {
    python: fitEnv.ctpwaPython,
    ldLibraryPath: fitEnv.ldLibraryPath,
    template,
    cluster,
    fitScript: env.PWA_FIT_SCRIPT !== undefined && env.PWA_FIT_SCRIPT !== '' ? filenameOf(env.PWA_FIT_SCRIPT) : 'fit.py',
  }
  return { config, cluster }
}

/** How a fit actually runs, exposed to instrument the consumer's batch decision. */
export interface PickedFitRunner {
  transport: FitTransport
  runner: LocalFitRunner | SbatchFitRunner
  /** Human-readable hint when neither transport was usable. */
  hint?: string
}

/**
 * Build the runner for the resolved transport. Kept separate from pickTransport
 * so the service can store the resolved transport alongside the runner.
 */
export function pickFitRunner(env: NodeJS.ProcessEnv = process.env): PickedFitRunner {
  const fitEnv = resolveEnvSafe(env)
  const python = fitEnv.ctpwaPython
  const ld = fitEnv.ldLibraryPath
  const transport = pickTransport(python, ld, env)
  if (transport === 'slurm') {
    const { config } = slurmConfigFromEnv(env)
    if (!hasSlurmClients(env)) {
      throw new Error(
        'PWA_FIT_TRANSPORT=slurm but the slurm clients (sbatch/squeue/sacct) are not on PATH; ' +
          'run the harness on a login node with the slurm clients available, or unset PWA_FIT_TRANSPORT.',
      )
    }
    return { transport: 'slurm', runner: new SbatchFitRunner(config) }
  }
  return { transport: 'local', runner: new LocalFitRunner(defaultFitRunnerConfig()) }
}
