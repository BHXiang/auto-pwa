/**
 * pwa-fit-local（服务三角色之二，Provider）：ctpwa 执行提供者。
 *
 * 把一次拟合提交映射成 ctx.jobs 后台任务（自定义 JobKind 'ctpwa'，
 * owner = 调用 agent）——会话围栏、owner 清理、完成通知（tool-jobs 的
 * "background job ctpwa-N finished" 自动注入/唤醒下一轮）、统一 job 工具
 * （job_output/job_list/job_kill）全部由 DSH 运行时白拿。
 *
 * 执行目标**每次提交单独决定**（见 src/fit-target.ts）：
 *   - cpu    -> LocalFitRunner，跳过 CUDA 探测，CTPWA_DEVICE=cpu；
 *   - gpu    -> LocalFitRunner，要求 CUDA，CTPWA_DEVICE=cuda；
 *   - slurm  -> SbatchFitRunner（sbatch jobScript + 登录节点轮询 + registry）；
 *   - script -> LocalFitRunner 跑 AI 给的 runScript（bash，前台阻塞到结束）。
 * 四种都包在同一个 DSH 后台任务里，所以唤醒/取消/查询行为一致。
 */
import { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { isAbsolute, join } from 'node:path'
import { LocalFitRunner, defaultFitRunnerConfig, readLogTail, type FitStatus } from '../src/fit-runner.js'
import { SbatchFitRunner } from '../src/fit-runner-sbatch.js'
import { slurmConfigFromEnv, type FitTransport } from '../src/fit-transport.js'
import {
  probeHostCapabilities,
  resolveFitTarget,
  type HostCapabilities,
  type ResolvedFitTarget,
  type TargetResolution,
} from '../src/fit-target.js'
import { resolveEnv } from '../src/config.js'
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
  submit(
    iterDir: string,
    options?: {
      timeoutMs?: number
      scriptArgs?: string[]
      jobScript?: string
      device?: 'cpu' | 'gpu' | 'auto'
      command?: { file: string; args: string[] }
    },
  ): FitStatus
  /** Batch (multiple iteration dirs under one DSH job). Only the SLURM runner implements it. */
  submitBatch?(iterDirs: string[], options?: { timeoutMs?: number; scriptArgs?: string[]; jobScript?: string }): FitStatus
  settled(jobId: string): Promise<FitStatus>
  cancel(jobId: string): boolean
  /** Running-job progress line (SLURM queue state); optional. */
  progress?(jobId: string): string | undefined
}

/** Parse "exit code: N" job detail back into a number. */
function exitCodeOf(detail: string | undefined): number | undefined {
  if (detail === undefined) return undefined
  const m = /exit code:\s*(\d+)/i.exec(detail)
  return m ? Number(m[1]) : undefined
}

/** Construction options (tests inject fakes; production uses the defaults). */
export interface PwaFitServiceOptions {
  /** Single runner used for every local dispatch (tests / backward compat). */
  runner?: FitSpawner
  /** Injectable SLURM runner (tests). */
  slurmRunner?: FitSpawner
  /** Host capabilities; probed once when omitted. */
  capabilities?: HostCapabilities
  /** @deprecated informational only; the target is resolved per submission. */
  transport?: FitTransport
}

/** One launched runner job + the runner that owns it. */
interface Launch {
  runner: FitSpawner
  status: FitStatus
}

export class PwaFitLocalService extends FitService {
  private readonly localRunner: FitSpawner
  private readonly slurmRunner: FitSpawner
  /** Host capabilities (GPU/slurm) used to resolve `target`. */
  readonly capabilities: HostCapabilities
  /**
   * @deprecated Default transport implied by the host. Kept for consumers that
   * still read it; per-call `target` is authoritative.
   */
  readonly transport: FitTransport
  /** ctx.jobs 注册表（构造时从 Context 捕获，stub/真实签名一致）。 */
  private readonly jobs: import('@deepseek-ai/dsh-jobs').JobRegistry
  /** jobId -> iterDir（提交时记录，status 时供 Consumer 做 summarizeFitDir）。 */
  private readonly iterDirs = new Map<string, string>()
  /** jobId -> resolved execution target (shown by fit_status). */
  private readonly targets = new Map<string, ResolvedFitTarget>()
  /** batch jobId -> iterDirs（status 时给出整批目录）。 */
  private readonly batchIterDirs = new Map<string, string[]>()
  /** runner jobId -> owning runner (settled/cancel/progress routing). */
  private readonly jobRunner = new Map<string, FitSpawner>()
  /** DSH jobId -> runner jobId（progress 用；runner 的 id 命名空间不同）。 */
  private readonly runnerIds = new Map<string, string>()
  /** DSH jobId -> sbatch id（SLURM target；重启后仍可从 registry 恢复）。 */
  private readonly sbatchIds = new Map<string, string>()
  /** Set by spawnVia: the runner job just launched. */
  private lastSpawn: Launch | undefined
  /**
   * Which identity generation the running registry wants (see the vendored
   * dsh-jobs header): current DSH takes the live Agent for both `owner` and
   * `caller`, released DSH 0.2.0-rc.2 takes the SessionId string. Detected
   * once from the registry surface: `onJobDone` exists only in the generation
   * that speaks Agent identity.
   */
  private readonly agentIdentity: boolean

  constructor(ctx: Context, options: PwaFitServiceOptions = {}) {
    super(ctx)
    this.jobs = ctx.jobs
    this.agentIdentity = typeof (this.jobs as { onJobDone?: unknown }).onJobDone === 'function'
    this.localRunner = options.runner ?? new LocalFitRunner(defaultFitRunnerConfig())
    this.slurmRunner = options.slurmRunner ?? new SbatchFitRunner(slurmConfigFromEnv().config)
    const env = resolveEnv()
    this.capabilities =
      options.capabilities ??
      // Injected fake runner (tests): do not spawn a GPU probe.
      (options.runner !== undefined
        ? { gpu: false, slurm: false }
        : probeHostCapabilities(env.ctpwaPython, env.ldLibraryPath))
    this.transport = options.transport ?? (this.capabilities.gpu ? 'local' : this.capabilities.slurm ? 'slurm' : 'local')
    // Producers may start work only while a controller is attached; tool-jobs
    // attaches its own, this is a defensive self-attach for mounts without it.
    if (typeof this.jobs.attachController === 'function') {
      this.jobs.attachController('pwa-fit-local')
    }
  }

  /**
   * Resolve where this request would run (no submission). Consumers call it
   * before spending the config gate so a bad target fails fast.
   */
  resolve(request: FitRequest): TargetResolution {
    return resolveFitTarget({
      ...(request.target !== undefined ? { requested: request.target } : {}),
      hasRunScript: request.runScript !== undefined && request.runScript !== '',
      caps: this.capabilities,
    })
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
    const resolved = this.resolve(request)
    if (resolved.error !== undefined) throw new Error(resolved.error)
    this.lastSpawn = undefined
    const jobId = this.jobs.start({
      kind: 'ctpwa',
      label: `ctpwa fit [${resolved.target}] ${request.iterDir}`,
      outputLimitBytes: FIT_OUTPUT_LIMIT_BYTES,
      ...(owner !== undefined ? { owner: this.identityOf(owner) } : {}),
      run: () => this.spawnFit(request, resolved.target),
    })
    // Key the iterDir record by the REGISTRY id (ctpwa-N) — the runner's own
    // id (fit-N-...) lives in a different namespace and is not user-visible.
    this.iterDirs.set(jobId, request.iterDir)
    this.targets.set(jobId, resolved.target)
    this.rememberSpawn(jobId)
    return jobId
  }

  submitBatch(request: FitRequest, owner?: FitOwner): string {
    const resolved = this.resolve(request)
    if (resolved.error !== undefined) throw new Error(resolved.error)
    if (resolved.target !== 'slurm') {
      throw new Error(`batch submission requires the slurm target (got ${resolved.target}); submit candidates one by one instead`)
    }
    if (this.slurmRunner.submitBatch === undefined) {
      throw new Error('batch submission is not supported by the slurm runner')
    }
    const dirs = request.iterDirs ?? (request.iterDir !== '' ? [request.iterDir] : [])
    if (dirs.length === 0) throw new Error('batch submission requires at least one iterDir')
    this.lastSpawn = undefined
    const jobId = this.jobs.start({
      kind: 'ctpwa',
      label: `ctpwa batch ${dirs.length} (${dirs[0]})`,
      outputLimitBytes: FIT_OUTPUT_LIMIT_BYTES,
      ...(owner !== undefined ? { owner: this.identityOf(owner) } : {}),
      run: () => this.spawnBatch(dirs, request),
    })
    this.batchIterDirs.set(jobId, dirs)
    this.iterDirs.set(jobId, dirs[0]!)
    this.targets.set(jobId, 'slurm')
    this.rememberSpawn(jobId)
    return jobId
  }

  /** Capture the runner job created synchronously inside `jobs.start(run)`. */
  private rememberSpawn(dshJobId: string): void {
    const spawned = this.lastSpawn
    if (spawned === undefined) return
    this.jobRunner.set(spawned.status.jobId, spawned.runner)
    this.runnerIds.set(dshJobId, spawned.status.jobId)
    if (spawned.status.sbatchId !== undefined) this.sbatchIds.set(dshJobId, spawned.status.sbatchId)
  }

  /** Launch one fit on the runner that matches the resolved target. */
  private launch(
    request: FitRequest,
    target: ResolvedFitTarget,
    options: { timeoutMs?: number; scriptArgs?: string[] },
  ): Launch {
    const common = {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.scriptArgs !== undefined ? { scriptArgs: options.scriptArgs } : {}),
    }
    if (target === 'slurm') {
      return {
        runner: this.slurmRunner,
        status: this.slurmRunner.submit(request.iterDir, {
          ...common,
          ...(request.jobScript !== undefined ? { jobScript: request.jobScript } : {}),
        }),
      }
    }
    if (target === 'script') {
      const script = request.runScript ?? ''
      const file = isAbsolute(script) ? script : join(request.iterDir, script)
      return {
        runner: this.localRunner,
        status: this.localRunner.submit(request.iterDir, {
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          command: { file, args: options.scriptArgs ?? [] },
        }),
      }
    }
    return {
      runner: this.localRunner,
      status: this.localRunner.submit(request.iterDir, { ...common, device: target }),
    }
  }

  private spawnFit(
    request: FitRequest,
    target: ResolvedFitTarget,
  ): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    return this.spawnVia((options) => this.launch(request, target, options), request)
  }

  private spawnBatch(dirs: string[], request: FitRequest): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    const submit = this.slurmRunner.submitBatch!
    return this.spawnVia(
      (options) => ({
        runner: this.slurmRunner,
        status: submit(dirs, {
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.scriptArgs !== undefined ? { scriptArgs: options.scriptArgs } : {}),
          ...(request.jobScript !== undefined ? { jobScript: request.jobScript } : {}),
        }),
      }),
      request,
    )
  }

  private spawnVia(
    launch: (opts: { timeoutMs?: number; scriptArgs?: string[] }) => Launch,
    request: FitRequest,
  ): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    const spawned = launch({
      timeoutMs: request.timeoutMin !== undefined ? request.timeoutMin * 60_000 : undefined,
      scriptArgs: request.scriptArgs,
    })
    this.lastSpawn = spawned
    const jobId = spawned.status.jobId
    const done = spawned.runner.settled(jobId).then(
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
        spawned.runner.cancel(jobId)
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
      ...(this.targets.get(jobId) !== undefined ? { target: this.targets.get(jobId) } : {}),
    }
    // Only a failed/killed job has an error: for completed jobs `detail` is
    // "exit code: 0" and used to render as "error: exit code: 0" in fit_status.
    if (snap.detail !== undefined && (snap.status === 'failed' || snap.status === 'killed')) out.error = snap.detail
    const runnerId = this.runnerIds.get(jobId)
    const runner = runnerId !== undefined ? this.jobRunner.get(runnerId) : undefined
    const sbatchId = this.sbatchIds.get(jobId)
    if (sbatchId !== undefined) out.sbatchId = sbatchId
    if (snap.status === 'running' || snap.status === 'stopping') {
      const progress = runnerId !== undefined ? runner?.progress?.(runnerId) : undefined
      if (progress !== undefined && progress !== '') out.progress = progress
    }
    const exitCode = exitCodeOf(snap.detail)
    if (exitCode !== undefined) out.exitCode = exitCode
    if (snap.status === 'running' || snap.status === 'stopping') {
      // A ctpwa job is a FINAL-OUTPUT job: the registry carries no bytes before
      // settlement, so jobs.read() cannot report progress mid-run. The spawn
      // pipes stdout/stderr into `<iterDir>/fit.log`, and aifit prints one line
      // per run, so tailing that file is the only running-progress signal. A
      // batch job keeps one dir per trial, so tail every dir but keep the total
      // bounded.
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
