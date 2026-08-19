/**
 * auto_pwa_run_fit — LocalFitRunner: spawn the fit program in an iteration
 * directory and track it as a background job.
 *
 * This is the "local" transport of the FitRunner abstraction (PLAN-STEP1.md
 * §2.④): it runs `python fit.py` directly on this host. The ctpwa env python
 * needs the full library path (ROOT libs + CUDA + torch/lib) to import ctpwa;
 * the runner injects LD_LIBRARY_PATH. GPU-less hosts fail fast with a clear
 * diagnostic instead of hanging (ctpwa refuses: "no CUDA devices available").
 *
 * SbatchRunner/SSHRunner plug in later behind the same interface; the DSH tool
 * layer will map submit() onto ctx.jobs.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { resolveEnv } from './config.js'

export interface FitRunnerConfig {
  /** Absolute path to the ctpwa env python (or any python with ctpwa+torch). */
  python: string
  /** LD_LIBRARY_PATH: ROOT libs, CUDA lib64, torch/lib — required to import ctpwa. */
  ldLibraryPath: string
  /** Fit entry script name inside the iteration dir. Default 'fit.py'. */
  fitScript?: string
  /** Log file name inside the iteration dir. Default 'fit.log'. */
  logFile?: string
  /** Run the pre-spawn CUDA probe (default true). Disable in tests/stubs. */
  gpuProbe?: boolean
}

export type FitState = 'running' | 'done' | 'failed' | 'canceled'

export interface FitStatus {
  jobId: string
  iterDir: string
  state: FitState
  exitCode: number | null
  /** Last ~4 KB of the fit log. */
  logTail: string
  startedAt: number
  finishedAt?: number
  error?: string
}

interface FitJob extends FitStatus {
  child: ChildProcess
  logPath: string
}

const LOG_TAIL_BYTES = 4096

/**
 * Fail-fast check: is a usable GPU visible to torch on this host? ctpwa
 * refuses to run without CUDA, so we can report this before spawning.
 * Returns a diagnostic string when unusable, undefined when ctpwa would run.
 */
export function detectGpuAvailability(python: string, ldLibraryPath: string): string | undefined {
  if (!existsSync(python)) return `ctpwa python not found: ${python}`
  // Cheap synchronous probe: torch.cuda.is_available() via the env python.
  const r = spawnSync(python, ['-c', 'import torch; print(torch.cuda.is_available())'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
  })
  const out = (r.stdout ?? '').trim()
  if (r.status === 0 && out === 'True') return undefined
  return `no CUDA device available to torch (probe said "${out || (r.error ? r.error.message : 'no output')}"); ` +
    'ctpwa requires a GPU (CPU backend not implemented). Fits will fail on this host.'
}

export class LocalFitRunner {
  private jobs = new Map<string, FitJob>()
  private seq = 0
  /** Completion waiters per job id, resolved by finish(). */
  private settlers = new Map<string, Set<(s: FitStatus) => void>>()

  constructor(private readonly cfg: FitRunnerConfig) {}

  /**
   * Start a fit in `iterDir` (must contain the fit script). Returns a
   * synchronous "running" status; completion arrives via status()/await.
   */
  submit(iterDir: string, options: { timeoutMs?: number } = {}): FitStatus {
    const fitScript = this.cfg.fitScript ?? 'fit.py'
    const scriptPath = join(iterDir, fitScript)
    if (!existsSync(scriptPath)) {
      throw new Error(`fit script not found: ${scriptPath}`)
    }
    if (!existsSync(this.cfg.python)) {
      throw new Error(`ctpwa python not found: ${this.cfg.python}`)
    }
    const gpuIssue = this.cfg.gpuProbe === false ? undefined : detectGpuAvailability(this.cfg.python, this.cfg.ldLibraryPath)
    if (gpuIssue) {
      throw new Error(gpuIssue)
    }

    mkdirSync(iterDir, { recursive: true })
    const jobId = `fit-${++this.seq}-${Date.now().toString(36)}`
    const logPath = join(iterDir, this.cfg.logFile ?? 'fit.log')
    const logStream = createWriteStream(logPath, { flags: 'a' })
    // The iteration dir may be removed by the caller before the stream opens;
    // swallow the async ENOENT instead of crashing the process.
    logStream.on('error', () => {})
    logStream.write(`# auto-pwa fit job ${jobId} started ${new Date().toISOString()}\n`)

    const child = spawn(this.cfg.python, [fitScript], {
      cwd: iterDir,
      env: { ...process.env, LD_LIBRARY_PATH: this.cfg.ldLibraryPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d: Buffer) => logStream.write(d))
    child.stderr.on('data', (d: Buffer) => logStream.write(d))

    const job: FitJob = {
      jobId,
      iterDir,
      state: 'running',
      exitCode: null,
      logTail: '',
      startedAt: Date.now(),
      child,
      logPath,
    }
    this.jobs.set(jobId, job)

    let timer: NodeJS.Timeout | undefined
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        job.child.kill('SIGTERM')
        job.error = `fit timed out after ${options.timeoutMs} ms`
        this.finish(job, 'canceled')
      }, options.timeoutMs)
    }

    child.on('error', (err) => {
      job.error = err.message
      this.finish(job, 'failed')
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (job.state === 'running') {
        job.exitCode = code
        this.finish(job, code === 0 ? 'done' : 'failed')
      }
      logStream.end()
    })

    return this.statusOf(job)
  }

  status(jobId: string): FitStatus | undefined {
    const job = this.jobs.get(jobId)
    return job ? this.statusOf(job) : undefined
  }

  /** Cancel a running job (SIGTERM). Returns false if not running. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running') return false
    job.child.kill('SIGTERM')
    job.error = 'canceled by caller'
    this.finish(job, 'canceled')
    return true
  }

  /** Await a job until it leaves 'running'. */
  async await(jobId: string, pollMs = 5000): Promise<FitStatus> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown job ${jobId}`)
    while (job.state === 'running') {
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return this.statusOf(job)
  }

  /**
   * Completion promise for one job (no polling): resolves when the job leaves
   * 'running' — done/failed/canceled — with its final status. Rejects for an
   * unknown job. This is the hook a ctx.jobs producer maps onto `JobHooks.done`.
   */
  settled(jobId: string): Promise<FitStatus> {
    const job = this.jobs.get(jobId)
    if (!job) return Promise.reject(new Error(`unknown job ${jobId}`))
    if (job.state !== 'running') return Promise.resolve(this.statusOf(job))
    return new Promise((resolve) => {
      const waiters = this.settlers.get(jobId) ?? new Set()
      waiters.add(resolve)
      this.settlers.set(jobId, waiters)
    })
  }

  list(): FitStatus[] {
    return [...this.jobs.values()].map((j) => this.statusOf(j))
  }

  private finish(job: FitJob, state: Exclude<FitState, 'running'>): void {
    if (job.state !== 'running') return
    job.state = state
    job.finishedAt = Date.now()
    const waiters = this.settlers.get(job.jobId)
    if (waiters) {
      this.settlers.delete(job.jobId)
      const status = this.statusOf(job)
      for (const resolve of waiters) resolve(status)
    }
  }

  private statusOf(job: FitJob): FitStatus {
    // Cheap tail read: last bytes of the log file.
    let logTail = ''
    try {
      const fd = openSync(job.logPath, 'r')
      const size = fstatSync(fd).size
      const start = Math.max(0, size - LOG_TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      closeSync(fd)
      logTail = buf.toString('utf8')
    } catch {
      logTail = ''
    }
    return {
      jobId: job.jobId,
      iterDir: job.iterDir,
      state: job.state,
      exitCode: job.exitCode,
      logTail,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    }
  }
}

/**
 * Default configuration resolved from the environment (see src/config.ts).
 * On the original developer host this mirrors /home/whitewash/Script/conda.sh
 * ctpwa: CUDA_HOME=/usr/local/cuda-13.2,
 * LD_LIBRARY_PATH=${CUDA_LIB}:${TORCH_LIB}:${LD_LIBRARY_PATH(root/lib,...)}.
 */
export function defaultFitRunnerConfig(): FitRunnerConfig {
  const env = resolveEnv()
  return {
    python: env.ctpwaPython,
    ldLibraryPath: env.ldLibraryPath,
  }
}
