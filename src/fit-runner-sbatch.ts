/**
 * fit-runner-sbatch — SbatchFitRunner: run ctpwa fits through the cluster
 * scheduler instead of spawning them locally.
 *
 * It implements the same FitSpawner surface as LocalFitRunner (submit /
 * settled / cancel) so the pwa-fit-local provider can swap transports with no
 * other change. It additionally:
 *   - submits a **user/AI-authored job script** (see slurm-template.ts) with
 *     `sbatch --chdir=<iterDir> <job.sh> [args]`; the plugin does not
 *     synthesize `#SBATCH` directives or environment setup any more;
 *   - polls `squeue`/`sacct` on the login node until the job leaves the queue,
 *     then reads the fit log tail — so the DSH background job's `done` stays
 *     pending exactly as long as the cluster job runs (that is what makes DSH
 *     "wake the AI after the job finishes" work for cluster jobs);
 *   - **cancel detaches instead of scancel by default**: a harness restart or a
 *     killed DSH job must not destroy hours of cluster compute. Set
 *     PWA_SLURM_SCANCEL_ON_CANCEL=1 to restore the old behavior;
 *   - persists a `slurm-jobs.json` registry in the iterations root so the AI can
 *     reconstruct cluster job state **after a restart** (`auto_pwa_fit_status`
 *     with `iterDir` re-queries squeue/sacct by sbatch id);
 *   - reports PENDING/queue reason while the job is still waiting (a job
 *     pending on 2×A100 used to look exactly like "running" for an hour).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { JOB_SCRIPT_NAME, resolveJobScript, type ResolvedJobScript } from './slurm-template.js'
import { configPathFromArgs, readLogTail, type FitStatus, type FitState } from './fit-runner.js'

export type { FitState, FitStatus }

/** Configuration for the SLURM runner. */
export interface SbatchFitRunnerConfig {
  /**
   * Cancel a DSH job -> also `scancel` the cluster job. Default false: a
   * harness restart / session teardown kills the DSH job, and that must not
   * kill a running cluster fit (it did: job 570080 was SIGNAL-killed mid-fit).
   */
  scancelOnCancel?: boolean
  /** Polling interval for squeue/sacct (default 15000 ms). */
  pollIntervalMs?: number
  /** Timeout for a single sbatch/squeue/sacct spawn (default 30s). */
  cliTimeoutMs?: number
  /**
   * Consecutive polls where both squeue (empty) and sacct (no row) say nothing
   * before the job is declared lost (default 20 ≈ 5 min at 15s): accounting can
   * lag a few seconds after a job leaves the queue, and treating that as
   * "done" produced fake successes.
   */
  accountingGracePolls?: number
}

/** A submitted SLURM job (single) tracked by the runner. */
interface SbatchJob extends FitStatus {
  sbatchId: string
  /** Batch jobs carry their sub job ids; single jobs do not. */
  subKeys?: string[]
  /** Canonical dir for the persistent registry (first real iter dir for batches). */
  regIterDir: string
  /** Submission script actually handed to sbatch. */
  scriptPath?: string
  /** Last `squeue` view (PENDING/RUNNING + reason + elapsed), for progress. */
  queue?: SlurmQueueView
  /** Consecutive polls with no squeue row and no sacct row. */
  misses?: number
  /** DSH job was cancelled but the cluster job was left running. */
  detached?: boolean
}

/** One `squeue` row. */
export interface SlurmQueueView {
  state: string
  reason: string
  elapsed: string
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
  /** Submission script used for this job (reproducibility). */
  scriptPath?: string
  /** DSH job cancelled, cluster job intentionally left running. */
  detached?: boolean
  /** Final exit code when known (survives a restart for status recovery). */
  exitCode?: number | null
}

export function slurmJobRegistryPath(iterDir: string): string {
  const root = findIterationsRoot(iterDir)
  return join(root, '.slurm-jobs.json')
}

export function readSlurmJobRegistry(iterDir: string): Record<string, SlurmJobRecord> {
  return readSlurmRegistryAt(findIterationsRoot(iterDir))
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

export function writeSlurmRegistryAt(iterationsRoot: string, records: Record<string, SlurmJobRecord>): void {
  const p = join(iterationsRoot, '.slurm-jobs.json')
  mkdirSync(dirname(p), { recursive: true })
  // Only keep the most recent N records so the file stays small.
  const keys = Object.keys(records)
  if (keys.length > 200) {
    const sorted = keys.sort((a, b) => (records[a]!.startedAt ?? 0) - (records[b]!.startedAt ?? 0))
    for (const k of sorted.slice(0, keys.length - 200)) delete records[k]
  }
  writeFileSync(p, JSON.stringify(records, null, 2))
}

function writeSlurmJobRegistry(iterDir: string, records: Record<string, SlurmJobRecord>): void {
  writeSlurmRegistryAt(findIterationsRoot(iterDir), records)
}

function runCli(
  cmd: string[],
  timeoutMs: number,
  cwd?: string,
): { stdout: string; stderr: string; code: number | null; error?: Error } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    ...(cwd !== undefined ? { cwd } : {}),
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status, error: r.error }
}

/** Parse `sbatch` stdout: "Submitted batch job 123456". */
function parseSbatchId(stdout: string): number | undefined {
  const m = /Submitted batch job\s+(\d+)/i.exec(stdout)
  return m ? Number(m[1]) : undefined
}

/** Ask squeue about one job. undefined = the job is not in the queue. */
export function querySlurmQueue(sbatchId: string, cliTimeoutMs = 30_000): SlurmQueueView | undefined {
  const r = runCli(['squeue', '-j', String(sbatchId), '-h', '-o', '%T|%r|%M'], cliTimeoutMs)
  const line = (r.stdout ?? '').trim().split('\n')[0]?.trim() ?? ''
  if (line === '') return undefined
  const [state = '', reason = '', elapsed = ''] = line.split('|').map((s) => s.trim())
  return { state, reason, elapsed }
}

/** Terminal/active state as understood by the runner (sacct State strings are free-form). */
function normalizeSlurmState(state: string): FitState {
  const u = state.toUpperCase().trim()
  if (u === '' || ['PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'SUSPENDED', 'REQUEUED', 'RESIZING', 'STAGE_OUT'].includes(u)) {
    return 'running'
  }
  if (u.includes('CANCELLED') || u.includes('CANCELED')) return 'canceled'
  if (u.startsWith('COMPLETED')) return 'done'
  return 'failed'
}

/** Ask sacct about one job's terminal state. undefined = no accounting row yet. */
export function querySlurmAccounting(
  sbatchId: string,
  cliTimeoutMs = 30_000,
): { state: FitState; exitCode: number | null } | undefined {
  const r = runCli(['sacct', '-j', String(sbatchId), '--format=JobID,State,ExitCode', '-n', '-P'], cliTimeoutMs)
  for (const raw of (r.stdout ?? '').trim().split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const [jobId = '', stateField = '', exitField = ''] = line.split('|')
    // Skip step rows (`570080.batch`, `.extern`): only the allocation matters.
    if (jobId.includes('.')) continue
    return { state: normalizeSlurmState(stateField), exitCode: parseSacctExit(exitField) }
  }
  return undefined
}

/** Parse sacct's ExitCode field ("major:minor" or "-"). */
function parseSacctExit(field: string | undefined): number | null {
  if (!field) return null
  const first = field.trim().split(/[:\s]/)[0]
  if (first === '' || first === '-') return null
  const n = Number(first)
  return Number.isFinite(n) ? n : null
}

/** One live observation of a cluster job. */
export interface SlurmLiveState {
  state: FitState
  exitCode: number | null
  /** Present while the job is still in the queue. */
  queue?: SlurmQueueView
  logTail: string
  /** squeue empty AND sacct has no row yet (accounting lag / job record gone). */
  unknown: boolean
}

/** Query one cluster job's live state (squeue first, then sacct). */
export function inspectSlurmJob(sbatchId: string, iterDir: string, cliTimeoutMs = 30_000): SlurmLiveState {
  const logTail = readLogTail(join(iterDir, 'fit.log'), LOG_TAIL_BYTES)
  const queue = querySlurmQueue(sbatchId, cliTimeoutMs)
  if (queue !== undefined) {
    return { state: 'running', exitCode: null, queue, logTail, unknown: false }
  }
  const acct = querySlurmAccounting(sbatchId, cliTimeoutMs)
  if (acct !== undefined) {
    return { state: acct.state, exitCode: acct.exitCode, logTail, unknown: false }
  }
  // Left the queue but sacct has no row (yet): keep polling instead of
  // reporting a fake "done" (which the old code did).
  return { state: 'running', exitCode: null, logTail, unknown: true }
}

/** Describe a queue view in one model-readable line. */
export function describeQueue(queue: SlurmQueueView | undefined): string {
  if (queue === undefined) return ''
  const reason = queue.reason !== '' && queue.reason !== 'None' ? ` (${queue.reason})` : ''
  return `[slurm] ${queue.state}${reason} elapsed=${queue.elapsed}`
}

/** Find a persisted job record by runner key or by sbatch id. */
export function findSlurmJobRecord(iterationsRoot: string, idOrSbatchId: string): SlurmJobRecord | undefined {
  const reg = readSlurmRegistryAt(iterationsRoot)
  const direct = reg[idOrSbatchId]
  if (direct !== undefined) return direct
  const wanted = String(idOrSbatchId)
  return Object.values(reg).find((r) => r.sbatchId === wanted)
}

/** A cluster job recovered from the on-disk registry (works after a restart). */
export interface RecoveredSlurmJob {
  record: SlurmJobRecord
  state: FitState
  exitCode: number | null
  logTail: string
  queue?: SlurmQueueView
}

/**
 * Re-query a persisted cluster job. Used by `auto_pwa_fit_status` when the
 * session that submitted the job is gone (harness restart): DSH's in-memory
 * job table is lost, but `<iterations>/.slurm-jobs.json` + squeue/sacct are not.
 */
export function recoverSlurmJob(
  iterationsRoot: string,
  idOrSbatchId: string,
  cliTimeoutMs = 30_000,
): RecoveredSlurmJob | undefined {
  const record = findSlurmJobRecord(iterationsRoot, idOrSbatchId)
  if (record === undefined) return undefined
  // A detached job is 'canceled' from DSH's point of view but may still be
  // running on the cluster — that is the whole point of not scancelling it, so
  // re-query the scheduler instead of trusting the on-disk state.
  const mayStillRun = record.state === 'running' || (record.detached === true && record.state === 'canceled')
  if (!mayStillRun || record.sbatchId === 'batch') {
    return {
      record,
      state: record.state,
      exitCode: record.exitCode ?? null,
      logTail: readLogTail(join(record.iterDir, 'fit.log'), LOG_TAIL_BYTES),
    }
  }
  const live = inspectSlurmJob(record.sbatchId, record.iterDir, cliTimeoutMs)
  if (live.state !== 'running') {
    const records = readSlurmRegistryAt(iterationsRoot)
    const cur = records[record.key] ?? record
    cur.state = live.state
    cur.exitCode = live.exitCode
    cur.finishedAt = Date.now()
    records[cur.key] = cur
    writeSlurmRegistryAt(iterationsRoot, records)
  }
  return {
    record,
    state: live.state,
    exitCode: live.exitCode,
    logTail: live.logTail,
    ...(live.queue !== undefined ? { queue: live.queue } : {}),
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
  private get gracePolls(): number {
    return this.cfg.accountingGracePolls ?? 20
  }

  /** Submit a single iteration fit as one SLURM job. */
  submit(
    iterDir: string,
    options: { timeoutMs?: number; scriptArgs?: string[]; jobScript?: string } = {},
  ): FitStatus {
    if (!hasSbatch()) {
      throw new Error(
        'sbatch/squeue/sacct not available; the SLURM transport requires a login node with the slurm clients (or set PWA_FIT_TRANSPORT=local).',
      )
    }
    const resolved = resolveJobScript({
      iterDir,
      ...(options.jobScript !== undefined ? { jobScript: options.jobScript } : {}),
    })
    const key = this.nextKey('slurm')
    const sbatchId = this.launchSingle(iterDir, resolved, options)
    const job: SbatchJob = {
      jobId: key,
      iterDir,
      sbatchId,
      regIterDir: iterDir,
      scriptPath: resolved.path,
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
   * together): each dir is its own SLURM job, all launched from the same
   * user/AI-authored script with `--chdir=<dir>` (parallel, one wake).
   */
  submitBatch(
    iterDirs: string[],
    options: { timeoutMs?: number; scriptArgs?: string[]; jobScript?: string } = {},
  ): FitStatus {
    if (iterDirs.length === 0) throw new Error('batch submission requires at least one iterDir')
    // One shared script for the whole batch: resolve it once at the base dir
    // (installing the template there if needed), then submit it with
    // --chdir=<trialDir> for each candidate. That is what lets a single
    // job.sh serve `_trials/<candidate>/` without hard-coded paths.
    const sharedScript =
      options.jobScript ?? resolveJobScript({ iterDir: iterDirs[0]! }).path
    const key = this.nextKey('batch')
    const subKeys = iterDirs.map(
      (d) =>
        this.submit(d, {
          ...(options.scriptArgs !== undefined ? { scriptArgs: options.scriptArgs } : {}),
          jobScript: sharedScript,
        }).jobId,
    )
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
        : results.some((r) => r.state === 'canceled')
          ? 'canceled'
          : 'failed'
      this.finish(job, state, results[0]?.exitCode ?? null)
    })
    return this.statusOf(key)
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

  /** Progress line for a still-running job (queue state), else undefined. */
  progress(jobId: string): string | undefined {
    const job = this.jobs.get(jobId)
    if (job === undefined || job.state !== 'running') return undefined
    const parts: string[] = []
    if (job.queue !== undefined) parts.push(describeQueue(job.queue))
    if (job.sbatchId !== 'batch') parts.push(`sbatch ${job.sbatchId}`)
    return parts.length > 0 ? parts.join(' · ') : undefined
  }

  /**
   * Cancel the DSH job. By default this DETACHES: the cluster job keeps
   * running (a harness restart must not kill hours of compute). Set
   * `scancelOnCancel: true` (PWA_SLURM_SCANCEL_ON_CANCEL=1) for the old
   * scancel-everything behavior.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running') return false
    if (job.subKeys && job.subKeys.length > 0) {
      for (const k of job.subKeys) this.cancelOne(k)
    } else {
      this.cancelOne(jobId)
    }
    return true
  }

  private cancelOne(key: string): void {
    if (this.cfg.scancelOnCancel === true) {
      this.scancel(key)
      return
    }
    const job = this.jobs.get(key)
    if (job === undefined || job.state !== 'running') return
    job.detached = true
    this.finish(
      job,
      'canceled',
      null,
      `[slurm] DSH 任务已取消；集群作业 ${job.sbatchId} 仍在运行（未 scancel）。\n[slurm] 需要停止: scancel ${job.sbatchId}`,
    )
  }

  private launchSingle(iterDir: string, script: ResolvedJobScript, options: { scriptArgs?: string[] }): string {
    // The engine reads `--config <path>` (aifit default: config.yml); honor it
    // so variant experiments run on the cluster exactly as they do locally.
    const fromArgs = configPathFromArgs(options.scriptArgs)
    const configPath =
      fromArgs !== undefined
        ? isAbsolute(fromArgs)
          ? fromArgs
          : join(iterDir, fromArgs)
        : join(iterDir, 'config.yml')
    if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`)
    return this.sbatch(iterDir, script.path, options.scriptArgs)
  }

  private sbatch(iterDir: string, scriptPath: string, scriptArgs: string[] | undefined): string {
    if (!existsSync(scriptPath)) {
      throw new Error(`SLURM 提交脚本不存在: ${scriptPath}（auto_pwa_run_fit 传 jobScript: "auto" 或省略即可安装内置模板）`)
    }
    // --chdir: the job starts in the iteration dir, which is what makes one
    // job.sh reusable for _trials/<candidate>/ and lets --output=fit.log land
    // in the right place. cwd is set too: SLURM resolves relative --output
    // against the directory sbatch was invoked from.
    const cmd = ['sbatch', `--chdir=${iterDir}`, scriptPath, ...(scriptArgs ?? [])]
    const r = runCli(cmd, this.cliTimeout, iterDir)
    if (r.error || r.code !== 0) {
      throw new Error(`sbatch failed: ${r.stderr.trim() || r.error?.message || 'unknown'}\n  cmd: ${cmd.join(' ')}`)
    }
    const id = parseSbatchId(r.stdout)
    if (id === undefined) throw new Error(`could not parse sbatch job id from: ${r.stdout.trim()}`)
    return String(id)
  }

  private scancel(key: string): void {
    const job = this.jobs.get(key)
    if (!job) return
    if (job.sbatchId !== 'batch') runCli(['scancel', String(job.sbatchId)], this.cliTimeout)
    this.finish(job, 'canceled', null)
  }

  private startPoll(key: string): void {
    const job = this.jobs.get(key)
    if (!job || job.state !== 'running') return
    const check = (): void => {
      const cur = this.jobs.get(key)
      if (!cur || cur.state !== 'running') return
      const st = inspectSlurmJob(cur.sbatchId, cur.iterDir, this.cliTimeout)
      cur.queue = st.queue
      cur.logTail = st.logTail
      if (st.state === 'running') {
        if (st.unknown) {
          cur.misses = (cur.misses ?? 0) + 1
          if (cur.misses > this.gracePolls) {
            this.finish(
              cur,
              'failed',
              null,
              st.logTail +
                `\n[slurm] squeue/sacct 都查不到 sbatch ${cur.sbatchId}（作业可能被清理或记账延迟）：手动确认 squeue -j ${cur.sbatchId} / sacct -j ${cur.sbatchId}`,
            )
            return
          }
        } else {
          cur.misses = 0
        }
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
      ...(job.sbatchId !== 'batch' ? { sbatchId: job.sbatchId } : {}),
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
      ...(job.scriptPath !== undefined ? { scriptPath: job.scriptPath } : {}),
      ...(job.detached === true ? { detached: true } : {}),
      ...(job.exitCode !== null ? { exitCode: job.exitCode } : {}),
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

/** Re-exported so callers can report the file name without importing the template module. */
export { JOB_SCRIPT_NAME }
