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
import { LocalFitRunner, defaultFitRunnerConfig, type FitStatus } from '../src/fit-runner.js'
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

/** The runner surface the provider needs (LocalFitRunner satisfies it; tests inject fakes). */
export interface FitSpawner {
  submit(iterDir: string, options?: { timeoutMs?: number; scriptArgs?: string[] }): FitStatus
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
  /** ctx.jobs 注册表（构造时从 Context 捕获，stub/真实签名一致）。 */
  private readonly jobs: import('@deepseek-ai/dsh-jobs').JobRegistry
  /** jobId -> iterDir（提交时记录，status 时供 Consumer 做 summarizeFitDir）。 */
  private readonly iterDirs = new Map<string, string>()

  constructor(ctx: Context, options: { runner?: FitSpawner } = {}) {
    super(ctx)
    this.jobs = ctx.jobs
    this.runner = options.runner ?? new LocalFitRunner(defaultFitRunnerConfig())
    // Producers may start work only while a controller is attached; tool-jobs
    // attaches its own, this is a defensive self-attach for mounts without it.
    if (typeof this.jobs.attachController === 'function') {
      this.jobs.attachController('pwa-fit-local')
    }
  }

  submit(request: FitRequest, owner?: FitOwner): string {
    const jobId = this.jobs.start({
      kind: 'ctpwa',
      label: `ctpwa fit ${request.iterDir}`,
      outputLimitBytes: FIT_OUTPUT_LIMIT_BYTES,
      owner,
      run: () => this.spawnFit(request),
    })
    // Key the iterDir record by the REGISTRY id (ctpwa-N) — the runner's own
    // id (fit-N-...) lives in a different namespace and is not user-visible.
    this.iterDirs.set(jobId, request.iterDir)
    return jobId
  }

  /** Spawn the process and return the JobHooks the registry controls. */
  private spawnFit(request: FitRequest): { cancel(reason?: string): void; done: Promise<JobOutcome> } {
    const status = this.runner.submit(request.iterDir, {
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
    const snap = this.jobs.get(jobId, caller)
    const out: FitStatusView = {
      jobId,
      iterDir: this.iterDirs.get(jobId) ?? '',
      state: snap.status === 'completed' ? 'done' : snap.status === 'killed' ? 'canceled' : snap.status === 'failed' ? 'failed' : 'running',
      logTail: '',
    }
    if (snap.detail !== undefined) out.error = snap.detail
    const exitCode = exitCodeOf(snap.detail)
    if (exitCode !== undefined) out.exitCode = exitCode
    if (snap.status !== 'running' && snap.status !== 'stopping') {
      // Final-output jobs: read() is idempotent after settlement.
      try {
        out.logTail = this.jobs.read(jobId, caller).text
      } catch {
        // The record may have been reaped with its owner; keep the snapshot.
      }
    }
    return out
  }

  kill(jobId: string, caller?: FitOwner): 'requested' | 'already-finished' {
    return this.jobs.kill(jobId, caller)
  }
}

export function apply(ctx: Context): void {
  new PwaFitLocalService(ctx)
}
