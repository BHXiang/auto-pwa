/**
 * fit-runner-sbatch — SbatchFitRunner: run ctpwa fits through the cluster
 * scheduler instead of spawning them locally.
 *
 * It implements the same FitSpawner surface as LocalFitRunner (submit /
 * settled / cancel) so the pwa-fit-local provider can swap transports with no
 * other change. It additionally:
 *   - writes a `.slurm` script into the iteration dir and submits it via
 *     `sbatch` (fail-fast with a clear diagnostic if sbatch is absent);
 *   - polls `squeue`/`sacct` on the login node until the job leaves the queue,
 *     then reads the fit log tail — so the DSH background job's `done` stays
 *     pending exactly as long as the cluster job runs (that is what makes DSH
 *     "wake the AI after the job finishes" work for cluster jobs);
 *   - cancel -> `scancel`;
 *   - supports a batch (one DSH job over N cluster jobs / one merged script)
 *     so several candidate fits finish with a single wake;
 *   - persists a `slurm-jobs.json` registry in the iterations root so the AI can
 *     quickly reconstruct cluster job state (also useful after a restart).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderSlurmBatchSubmission, renderSlurmSubmission, type SlurmTemplateKind } from './slurm-template.js'
import type { SlurmClusterConfig } from './fit-transport.js'
import type { FitStatus, FitState } from './fit-runner.js'

export type { FitState, FitStatus }

/** Configuration for the SLURM runner. */
export interface SbatchFitRunnerConfig {
  /** ctpwa env python, baked into the submission script (absolute path on shared FS). */
  python: string
  /** LD_LIBRARY_PATH baked into the submission script; '' = inherit on compute node. */
  ldLibraryPath: string
  /** Template kind (a100/v100) for partition/qos/account/gres defaults. */
  template: SlurmTemplateKind
  /** Cluster settings (overrides template defaults) resolved from the env. */
  cluster: SlurmClusterConfig
  /** Fit entry script name inside the iteration dir (default 'fit.py' = aifit link). */
  fitScript?: string
  /** Polling interval for squeue/sacct (default 15000 ms). */
  pollIntervalMs?: number
  /** Timeout for a single sbatch/squeue/sacct spawn (default 30s). */
  cliTimeoutMs?: number
}

/** A submitted SLURM job (single) tracked by the runner. */
interface SbatchJob extends FitStatus {
  sbatchId: string
  /** Batch jobs carry their sub job ids; single jobs do not. */
  subKeys?: string[]
  /** Canonical dir for the persistent registry (first real iter dir for batches). */
  regIterDir: string
}

const LOG_TAIL_BYTES = 4096

/** Walk up from iterDir to the ancestor directory named 'iterations' (fallback:
 * the parent, matching iterationsRootOf). */
export function findIterationsRoot(iterDir: string): string {
  let d = iterDir
  for (let i = 0; i < 8; i += 1) {
    if (d.endsWith('iterations')) return d
    const p = dirname(d)
    if (p === d) break
    d = p
  }
  return dirname(iterDir)
}

/** Read the persistent SLURM job registry (keyed by runner job id). */
export interface SlurmJobRecord {
  key: string
  sbatchId: string
  iterDir: string
  state: FitState
  batch?: boolean
  subKeys?: string[]
  startedAt: number
  finishedAt?: number
}

export function slurmJobRegistryPath(iterDir: string): string {
  const root = findIterationsRoot(iterDir)
  return join(root, '.slurm-jobs.json')
}

export function readSlurmJobRegistry(iterDir: string): Record<string, SlurmJobRecord> {
  const p = slurmJobRegistryPath(iterDir)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, SlurmJobRecord>
  } catch {
    return {}
  }
}

/** Read the registry directly from an iterations root (AI/user state view). */
export function readSlurmRegistryAt(iterationsRoot: string): Record<string, SlurmJobRecord> {
  const p = join(iterationsRoot, '.slurm-jobs.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, SlurmJobRecord>
  } catch {
    return {}
  }
}

function writeSlurmJobRegistry(iterDir: string, records: Record<string, SlurmJobRecord>): void {
  const p = slurmJobRegistryPath(iterDir)
  mkdirSync(dirname(p), { recursive: true })
  // Only keep the most recent N records so the file stays small.
  const keys = Object.keys(records)
  if (keys.length > 200) {
    const sorted = keys.sort((a, b) => (records[a]!.startedAt ?? 0) - (records[b]!.startedAt ?? 0))
    for (const k of sorted.slice(0, keys.length - 200)) delete records[k]
  }
  writeFileSync(p, JSON.stringify(records, null, 2))
}

function runCli(cmd: string[], timeoutMs: number): { stdout: string; stderr: string; code: number | null; error?: Error } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: timeoutMs })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status, error: r.error }
}

/** Parse `sbatch` stdout: "Submitted batch job 123456". */
function parseSbatchId(stdout: string): number | undefined {
  const m = /Submitted batch job\s+(\d+)/i.exec(stdout)
  return m ? Number(m[1]) : undefined
}

/** Query one SLURM job's current state/exit via squeue + sacct. Returns a
 * terminal FitStatus when the job has left the queue, else a running one. */
function querySlurmJob(sbatchId: string, iterDir: string, key: string, fitScript: string, cliTimeoutMs: number): FitStatus {
  const squeue = runCli(['squeue', '-j', String(sbatchId), '-h', '-o', '%T'], cliTimeoutMs)
  const inQueue = squeue.stdout.trim().length > 0
  if (inQueue) {
    const st = squeue.stdout.trim().split(/\s+/)[0]
    return { jobId: key, iterDir, state: st === 'PENDING' || st === 'CONFIGURING' ? 'running' : 'running', exitCode: null, logTail: '', startedAt: Date.now() }
  }
  // Left the queue -> terminal. sacct gives the final state + exit code.
  const act = runCli(['sacct', '-j', String(sbatchId), '--format=State,ExitCode', '-n', '-P'], cliTimeoutMs)
  const row = act.stdout.trim().split('\n')[0] ?? ''
  const [stateField, exitField] = row.split('|')
  const upper = (stateField ?? '').toUpperCase()
  const exitCode = parseSacctExit(exitField)
  let state: Exclude<FitState, 'running'> = 'done'
  if (upper.includes('CANCELLED') || upper.includes('FAILED') || upper.includes('OUT_OF_MEMORY') || upper.includes('TIMEOUT')) state = 'failed'
  if (upper.includes('CANCELLED')) state = 'canceled'
  const logTail = readLogTail(join(iterDir, 'fit.log'))
  return { jobId: key, iterDir, state, exitCode, logTail, startedAt: Date.now(), finishedAt: Date.now() }
}

/** Parse sacct's ExitCode field ("major:minor" or "-"). */
function parseSacctExit(field: string | undefined): number | null {
  if (!field) return null
  const first = field.trim().split(/[:\s]/)[0]
  if (first === '' || first === '-') return null
  const n = Number(first)
  return Number.isFinite(n) ? n : null
}

function readLogTail(path: string): string {
  try {
    if (!existsSync(path)) return ''
    const text = readFileSync(path, 'utf8')
    return text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text
  } catch {
    return ''
  }
}

export class SbatchFitRunner {
  private jobs = new Map<string, SbatchJob>()
  private settlers = new Map<string, Set<(s: FitStatus) => void>>()
  private seq = 0

  constructor(private readonly cfg: SbatchFitRunnerConfig) {}

  private get pollMs(): number {
    return this.cfg.pollIntervalMs ?? 15_000
  }
  private get cliTimeout(): number {
    return this.cfg.cliTimeoutMs ?? 30_000
  }

  /** Submit a single iteration fit as one SLURM job. */
  submit(iterDir: string, options: { timeoutMs?: number; scriptArgs?: string[] } = {}): FitStatus {
    if (!hasSbatch()) {
      throw new Error('sbatch/squeue/sacct not available; the SLURM transport requires a login node with the slurm clients (or set PWA_FIT_TRANSPORT=local).')
    }
    const key = this.nextKey('slurm')
    const sbatchId = this.launchSingle(iterDir, key, options)
    const job: SbatchJob = {
      jobId: key,
      iterDir,
      sbatchId,
      regIterDir: iterDir,
      state: 'running',
      exitCode: null,
      logTail: '',
      startedAt: Date.now(),
    }
    this.jobs.set(key, job)
    this.persistRecord(job)
    this.startPoll(key)
    return this.statusOf(key)
  }

  /**
   * Submit several iteration fits that share ONE DSH job (they finish/wake
   * together). Mode controls how they map to cluster jobs:
   *   one     -> each fit is its own SLURM job (parallel, up to the caller's
   *              concurrency cap); the batch waits for all of them.
   *   script  -> one merged SLURM script runs all fits sequentially (single
   *              cluster slot, single wake) — for short fits.
   */
  submitBatch(iterDirs: string[], options: { timeoutMs?: number; scriptArgs?: string[]; mode?: 'one' | 'script' } = {}): FitStatus {
    const mode = options.mode ?? 'one'
    const subKeys = mode === 'script'
      ? [this.submitMerged(iterDirs, options.scriptArgs)]
      : iterDirs.map((d) => this.submit(d, { scriptArgs: options.scriptArgs }).jobId)
    const key = this.nextKey('batch')
    const job: SbatchJob = {
      jobId: key,
      iterDir: iterDirs.join(','),
      sbatchId: 'batch',
      subKeys,
      regIterDir: iterDirs[0]!,
      state: 'running',
      exitCode: null,
      logTail: '',
      startedAt: Date.now(),
    }
    this.jobs.set(key, job)
    this.persistRecord(job)
    // When every sub job settles, finish the batch once (one wake).
    void Promise.all(subKeys.map((k) => this.settled(k))).then((results) => {
      const state: Exclude<FitState, 'running'> = results.every((r) => r.state === 'done')
        ? 'done'
        : results.some((r) => r.state === 'canceled') ? 'canceled' : 'failed'
      this.finish(job, state, results[0]?.exitCode ?? null)
    })
    return this.statusOf(key)
  }

  /** Launch one merged SLURM script that runs all iterDirs sequentially. */
  private submitMerged(iterDirs: string[], scriptArgs?: string[]): string {
    const iterDir = iterDirs[0]!
    const key = this.nextKey('slurm')
    const logPath = join(iterDir, 'fit.log')
    const commands = iterDirs.map((dir) => ({
      iterDir: dir,
      python: this.cfg.python,
      ldLibraryPath: this.cfg.ldLibraryPath,
      fitScript: this.cfg.fitScript,
      scriptArgs,
    }))
    const script = renderSlurmBatchSubmission({
      kind: this.cfg.template,
      partition: this.cfg.cluster.partition,
      qos: this.cfg.cluster.qos,
      account: this.cfg.cluster.account,
      gres: this.cfg.cluster.gres,
      ntasks: this.cfg.cluster.ntasks,
      memPerCpu: this.cfg.cluster.memPerCpu,
      timeLimit: this.cfg.cluster.timeLimit,
      jobName: `fit-batch-${key}`,
      output: logPath,
      commands,
    })
    const sbatchId = this.sbatch(iterDir, script)
    const job: SbatchJob = {
      jobId: key,
      iterDir,
      sbatchId,
      regIterDir: iterDir,
      state: 'running',
      exitCode: null,
      logTail: '',
      startedAt: Date.now(),
    }
    this.jobs.set(key, job)
    this.persistRecord(job)
    this.startPoll(key)
    return key
  }

  /** Await a job (single or batch) until it leaves 'running'. */
  async settled(jobId: string): Promise<FitStatus> {
    const job = this.jobs.get(jobId)
    if (!job) return Promise.reject(new Error(`unknown slurm job ${jobId}`))
    if (job.state !== 'running') return Promise.resolve(this.statusOf(jobId))
    return new Promise((resolve) => {
      const waiters = this.settlers.get(jobId) ?? new Set()
      waiters.add(resolve)
      this.settlers.set(jobId, waiters)
    })
  }

  status(jobId: string): FitStatus | undefined {
    const job = this.jobs.get(jobId)
    return job ? this.statusOf(jobId) : undefined
  }

  list(): FitStatus[] {
    return [...this.jobs.values()].map((j) => this.statusOf(j.jobId))
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running') return false
    if (job.subKeys && job.subKeys.length > 0) {
      for (const k of job.subKeys) this.scancel(k)
    } else {
      this.scancel(jobId)
    }
    return true
  }

  private launchSingle(iterDir: string, key: string, options: { scriptArgs?: string[] }): string {
    const configPath = join(iterDir, 'config.yml')
    if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`)
    const logPath = join(iterDir, 'fit.log')
    const script = renderSlurmSubmission({
      kind: this.cfg.template,
      partition: this.cfg.cluster.partition,
      qos: this.cfg.cluster.qos,
      account: this.cfg.cluster.account,
      gres: this.cfg.cluster.gres,
      ntasks: this.cfg.cluster.ntasks,
      memPerCpu: this.cfg.cluster.memPerCpu,
      timeLimit: this.cfg.cluster.timeLimit,
      jobName: `fit-${key}`,
      output: logPath,
      python: this.cfg.python,
      ldLibraryPath: this.cfg.ldLibraryPath,
      fitScript: this.cfg.fitScript,
      scriptArgs: options.scriptArgs,
      cwd: iterDir,
    })
    return this.sbatch(iterDir, script)
  }

  private sbatch(iterDir: string, script: string): string {
    const scriptPath = join(iterDir, 'fit.slurm')
    writeFileSync(scriptPath, script)
    const r = runCli(['sbatch', scriptPath], this.cliTimeout)
    if (r.error || r.code !== 0) {
      throw new Error(`sbatch failed: ${r.stderr.trim() || r.error?.message || 'unknown'}`)
    }
    const id = parseSbatchId(r.stdout)
    if (id === undefined) throw new Error(`could not parse sbatch job id from: ${r.stdout.trim()}`)
    return String(id)
  }

  private scancel(key: string): void {
    const job = this.jobs.get(key)
    if (!job) return
    void job
    runCli(['scancel', String(job.sbatchId)], this.cliTimeout)
    this.finish(job, 'canceled', null)
  }

  private startPoll(key: string): void {
    const job = this.jobs.get(key)
    if (!job || job.state !== 'running') return
    const check = (): void => {
      const cur = this.jobs.get(key)
      if (!cur || cur.state !== 'running') return
      const st = querySlurmJob(cur.sbatchId, cur.iterDir, cur.jobId, this.cfg.fitScript ?? 'fit.py', this.cliTimeout)
      if (st.state === 'running') {
        setTimeout(check, this.pollMs)
        return
      }
      this.finish(cur, st.state as Exclude<FitState, 'running'>, st.exitCode, st.logTail)
    }
    check()
  }

  private finish(job: SbatchJob, state: Exclude<FitState, 'running'>, exitCode: number | null, logTail = ''): void {
    if (job.state !== 'running') return
    job.state = state
    job.exitCode = exitCode
    if (logTail !== '') job.logTail = logTail
    job.finishedAt = Date.now()
    this.persistRecord(job)
    const waiters = this.settlers.get(job.jobId)
    if (waiters) {
      this.settlers.delete(job.jobId)
      const status = this.statusOf(job.jobId)
      for (const resolve of waiters) resolve(status)
    }
  }

  private statusOf(jobId: string): FitStatus {
    const job = this.jobs.get(jobId)!
    return {
      jobId: job.jobId,
      iterDir: job.iterDir,
      state: job.state,
      exitCode: job.exitCode,
      logTail: job.logTail,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: undefined,
    }
  }

  private nextKey(prefix: string): string {
    return `${prefix}-${++this.seq}-${Date.now().toString(36)}`
  }

  private persistRecord(job: SbatchJob): void {
    const records = readSlurmJobRegistry(job.regIterDir)
    records[job.jobId] = {
      key: job.jobId,
      sbatchId: job.sbatchId,
      iterDir: job.iterDir,
      state: job.state,
      batch: job.subKeys !== undefined,
      subKeys: job.subKeys,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }
    writeSlurmJobRegistry(job.regIterDir, records)
  }
}

/** Cheap PATH check for the three slurm clients. */
function hasSbatch(): boolean {
  for (const bin of ['sbatch', 'squeue', 'sacct']) {
    const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 5_000 })
    if (r.status !== 0 || r.stdout.trim() === '') return false
  }
  return true
}
