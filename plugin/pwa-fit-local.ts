/**
 * pwa-fit-local（服务三角色之二，Provider）：ctpwa 本地提供者。
 *
 * 把一次拟合提交映射成 ctx.jobs 后台任务（自定义 JobKind 'ctpwa'，
 * owner = 调用 agent）——会话围栏、owner 清理、完成通知（tool-jobs 的
 * "background job ctpwa-N finished" 自动注入/唤醒下一轮）、统一 job 工具
 * （job_output/job_list/job_kill）全部由 DSH 运行时白拿。
 *
 * 进程管理复用 src/fit-runner.ts 的 LocalFitRunner（spawn + GPU 探测 +
 * fit.log 尾部）；本文件只做 JobHooks 适配：
 *   cancel  -> runner.cancel
 *   done    -> runner.settled() 映射为 JobOutcome
 *   （无 readOutput：final-output job，输出在 settled 后经 jobs.read 幂等可取）
 *
 * 挂载：patch 文件与 pwa-fit.ts、auto-pwa.ts 一起插入 profile；
 * 依赖 ctx.jobs（dsh-jobs-local 提供）与 ctx.pwaFit（本文件注册）。
 */
import { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { join } from 'node:path'
import { readLogTail, type FitStatus } from '../src/fit-runner.js'
import { pickFitRunner, type FitTransport } from '../src/fit-transport.js'
import { FitService, type FitOwner, type FitRequest, type FitStatusView } from './pwa-fit.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    ctpwa: 'ctpwa'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: import('@deepseek-ai/dsh-jobs').JobRegistry
  }
}

export const name = 'pwa-fit-local'
export const inject = ['jobs']

/** 拟合 job 的模型可见输出字节帽（完成通知 + job_output）。 */
export const FIT_OUTPUT_LIMIT_BYTES = 32 * 1024

/**
 * Flatten a `ctx.jobs.read()` result into text across DSH generations.
 *
 * The released registry returned `{ text, snapshot }`; the current one (dev
 * checkout and 0.2.0-rc.2) returns `{ chunks: JobChunk[], lossy, result?, job }`
 * and has NO `text` field. Reading `.text` there yields `undefined`, which the
 * tool-output validator rejects for every settled job ("value is not lossless
 * JSON"). Discriminate on the shape — the same discipline agentIdentity applies
 * to identity — and always return a string so `logTail` stays JSON-safe.
 */
function readJobText(result: unknown): string {
  if (result === null || typeof result !== 'object') return ''
  const record = result as { text?: unknown; chunks?: unknown }
  if (Array.isArray(record.chunks)) {
    let text = ''
    for (const chunk of record.chunks) {
      if (chunk === null || typeof chunk !== 'object') continue
      const piece = (chunk as { text?: unknown }).text
      if (typeof piece === 'string') text += piece
    }
    return text
  }
  return typeof record.text === 'string' ? record.text : ''
}

/** The runner surface the provider needs (LocalFitRunner/SbatchFitRunner satisfy it; tests inject fakes). */
export interface FitSpawner {
  submit(iterDir: string, options?: { timeoutMs?: number; scriptArgs?: string[] }): FitStatus
  /** Batch (multiple iteration dirs under one DSH job). Optional: the provider
   * falls back to single submit when the transport has no batch support. */
  submitBatch?(iterDirs: string[], options?: { timeoutMs?: number; scriptArgs?: string[] }): FitStatus
  settled(jobId: string): Promise<FitStatus>
  cancel(jobId: string): boolean
}

/** Parse "exit code: N" job detail back into a number. */
function exitCodeOf(detail: string | undefined): number | undefined {
  if (detail === undefined) return undefined
  const m = /exit code:\s*(\d+)/i.exec(detail)
  return m ? Number(m[1]) : undefined
}

export class PwaFitLocalService extends FitService {
  private readonly runner: FitSpawner
  /** Resolved transport ('local' | 'slurm') — readable by consumers to decide
   * batching. Injected runners default to 'local' (tests). */
  readonly transport: FitTransport
  /** ctx.jobs 注册表（构造时从 Context 捕获，stub/真实签名一致）。 */
  private readonly jobs: import('@deepseek-ai/dsh-jobs').JobRegistry
  /** jobId -> iterDir（提交时记录，status 时供 Consumer 做 summarizeFitDir）。 */
  private readonly iterDirs = new Map<string, string>()
  /** batch jobId -> iterDirs（status 时给出整批目录）。 */
  private readonly batchIterDirs = new Map<string, string[]>()
  /**
   * Which identity generation the running registry wants (see the vendored
   * dsh-jobs header): current DSH takes the live Agent for both `owner` and
   * `caller`, released DSH 0.2.0-rc.2 takes the SessionId string. Detected
   * once from the registry surface: `onJobDone` exists only in the generation
   * that speaks Agent identity.
   */
  private readonly agentIdentity: boolean

  constructor(ctx: Context, options: { runner?: FitSpawner; transport?: FitTransport } = {}) {
    super(ctx)
    this.jobs = ctx.jobs
    this.agentIdentity = typeof (this.jobs as { onJobDone?: unknown }).onJobDone === 'function'
    const picked = options.runner !== undefined
      ? { transport: (options.transport ?? 'local') as FitTransport, runner: options.runner }
      : pickFitRunner()
    this.runner = picked.runner
    this.transport = picked.transport
    // Producers may start work only while a controller is attached; tool-jobs
    // attaches its own, this is a defensive self-attach for mounts without it.
    if (typeof this.jobs.attachController === 'function') {
      this.jobs.attachController('pwa-fit-local')
    }
  }

  /**
   * The value to pass as `owner` / `caller` for this registry generation.
   *
   * CRITICAL: an owner of the wrong shape does not fail loudly on current DSH —
   * the job is created UNOWNED, and dsh-tool-jobs then skips the completion
   * notice entirely (`event.job.owner === undefined`). The agent never wakes
   * up, which is the whole point of registering the fit as a background job.
   * So: Agent when the registry speaks Agent identity, SessionId otherwise.
   */
  private identityOf(owner?: FitOwner): import('@deepseek-ai/dsh-jobs').JobIdentity | undefined {
    if (owner === undefined) return undefined
    if (this.agentIdentity) return (owner.agent ?? owner.id) as import('@deepseek-ai/dsh-jobs').JobIdentity
    return owner.id
  }

  submit(request: FitRequest, owner?: FitOwner): string {
    const jobId = this.jobs.start({
      kind: 'ctpwa',
      label: `ctpwa fit ${request.iterDir}`,
      outputLimitBytes: FIT_OUTPUT_LIMIT_BYTES,
      ...(owner !== undefined ? { owner: this.identityOf(owner) } : {}),
      run: () => this.spawnFit(request),
    })
    // Key the iterDir record by the REGISTRY id (ctpwa-N) — the runner's own
    // id (fit-N-...) lives in a different namespace and is not user-visible.
    this.iterDirs.set(jobId, request.iterDir)
    return jobId
  }

  submitBatch(request: FitRequest, owner?: FitOwner): string {
    if (this.runner.submitBatch === undefined) {
      throw new Error('batch submission is not supported on this transport (use single-job submit)')
    }
    const dirs = request.iterDirs ?? (request.iterDir !== '' ? [request.iterDir] : [])
    if (dirs.length === 0) throw new Error('batch submission requires at least one iterDir')
    const jobId = this.jobs.start({
      kind: 'ctpwa',
      label: `ctpwa batch ${dirs.length} (${dirs[0]})`,
      outputLimitBytes: FIT_OUTPUT_LIMIT_BYTES,
      ...(owner !== undefined ? { owner: this.identityOf(owner) } : {}),
      run: () => this.spawnBatch(dirs, request),
    })
    this.batchIterDirs.set(jobId, dirs)
    return jobId
  }

  /** Spawn the process and return the JobHooks the registry controls. */
  private spawnFit(request: FitRequest): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    return this.spawnVia(
      (options) => this.runner.submit(request.iterDir, options),
      request,
    )
  }

  private spawnBatch(dirs: string[], request: FitRequest): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    const submit = this.runner.submitBatch!
    return this.spawnVia(
      (options) => submit(dirs, options),
      request,
    )
  }

  private spawnVia(
    launch: (opts: { timeoutMs?: number; scriptArgs?: string[] }) => FitStatus,
    request: FitRequest,
  ): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    const status = launch({
      timeoutMs: request.timeoutMin !== undefined ? request.timeoutMin * 60_000 : undefined,
      scriptArgs: request.scriptArgs,
    })
    const jobId = status.jobId
    const done = this.runner.settled(jobId).then(
      (s): JobOutcome => {
        switch (s.state) {
          case 'done':
            return { status: 'completed', detail: `exit code: ${s.exitCode ?? 0}`, output: s.logTail }
          case 'canceled':
            return { status: 'killed', detail: s.error ?? 'canceled', output: s.logTail }
          default:
            return { status: 'failed', detail: `exit code: ${s.exitCode ?? '?'}`, output: s.logTail }
        }
      },
      (error: unknown): JobOutcome => ({ status: 'failed', detail: String(error) }),
    )
    return {
      cancel: (reason?: string) => {
        void reason
        this.runner.cancel(jobId)
      },
      done,
    }
  }

  status(jobId: string, caller?: FitOwner): FitStatusView {
    const ident = this.identityOf(caller)
    const snap = ident === undefined ? this.jobs.get(jobId) : this.jobs.get(jobId, ident)
    const out: FitStatusView = {
      jobId,
      iterDir: this.iterDirs.get(jobId) ?? this.batchIterDirs.get(jobId)?.join(',') ?? '',
      state: snap.status === 'completed' ? 'done' : snap.status === 'killed' ? 'canceled' : snap.status === 'failed' ? 'failed' : 'running',
      logTail: '',
    }
    if (snap.detail !== undefined) out.error = snap.detail
    const exitCode = exitCodeOf(snap.detail)
    if (exitCode !== undefined) out.exitCode = exitCode
    if (snap.status === 'running' || snap.status === 'stopping') {
      // A ctpwa job is a FINAL-OUTPUT job: the registry carries no bytes before
      // settlement, so jobs.read() cannot report progress mid-run. The spawn
      // pipes stdout/stderr into `<iterDir>/fit.log` (LocalFitRunner's default
      // name — nothing configures logFile), and aifit prints one line per run,
      // so tailing that file is the only running-progress signal. A batch job
      // keeps one dir per trial, so tail every dir but keep the total bounded.
      const dirs =
        this.batchIterDirs.get(jobId) ??
        (this.iterDirs.get(jobId) !== undefined ? [this.iterDirs.get(jobId)!] : [])
      const joined = dirs
        .map((dir) => readLogTail(join(dir, 'fit.log')))
        .filter((tail) => tail !== '')
        .join('\n')
      out.logTail = joined.length > 4096 ? joined.slice(-4096) : joined
    } else {
      // Settled: read() is idempotent after settlement. Flatten the result by
      // shape — current DSH returns chunks, not `text` (readJobText).
      try {
        const result = ident === undefined ? this.jobs.read(jobId) : this.jobs.read(jobId, ident)
        out.logTail = readJobText(result)
      } catch {
        // The record may have been reaped with its owner; keep the snapshot.
      }
    }
    return out
  }

  kill(jobId: string, caller?: FitOwner): 'requested' | 'already-finished' {
    const ident = this.identityOf(caller)
    return ident === undefined ? this.jobs.kill(jobId) : this.jobs.kill(jobId, ident)
  }
}

export function apply(ctx: Context): void {
  new PwaFitLocalService(ctx)
}
