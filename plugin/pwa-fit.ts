/**
 * pwa-fit 服务定义（服务三角色之一，Definition）：
 * `ctx.pwaFit` 抽象服务——拟合提交/查询/取消的契约。
 * 不负责具体执行：Provider（pwa-fit-local）把提交映射到 ctx.jobs
 * （JobKind 'ctpwa'，owner 围栏、完成通知、清理全由 jobs 运行时提供），
 * Consumer（auto-pwa.ts 的 auto_pwa_run_fit / auto_pwa_fit_status）只面向本契约。
 *
 * 挂载方式：与 pwa-fit-local、auto-pwa 一同 patch 进 DSH profile。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** 一次拟合提交请求（Consumer -> Provider）。 */
export interface FitRequest {
  /** 迭代目录绝对路径（须含 fit.py 与 config.yml）。 */
  iterDir: string
  /** 批量提交：多个迭代目录共享一个后台任务（全部完成才唤醒）。
   * Provider 仅在当前 transport 支持批次时接受（否则抛错）。 */
  iterDirs?: string[]
  /** 超时分钟数；省略 = 不设超时。 */
  timeoutMin?: number
  /** 追加在脚本名后的 CLI 参数（如 aifit 的 --runs/--max-iter 短拟合）。 */
  scriptArgs?: string[]
  /**
   * SLURM 提交脚本：`"auto"` = 安装内置模板为 `<iterDir>/job.sh`，
   * 或一个路径（相对 iterDir / 绝对）。省略 = `<iterDir>/job.sh`（缺失时装模板）。
   * 只在 target=slurm 时使用。脚本契约见 `src/slurm-template.ts`：
   * `sbatch --chdir=<iterDir> job.sh [scriptArgs]`，脚本不写 cd、日志写
   * fit.log、参数透传给 fit.py。
   */
  jobScript?: string
  /**
   * 执行目标（每次提交决定）：auto（宿主 GPU→CPU）/ cpu / gpu / slurm。
   * 省略 = `PWA_FIT_TARGET`（部署默认）或 auto。见 src/fit-target.ts。
   */
  target?: string
  /**
   * AI 自己写的启动脚本（runScript）：给了它就忽略 target，由插件用 bash
   * 在 iterDir 里执行（前台阻塞到拟合结束），**仍作为 DSH 后台任务**，
   * 所以跑完照样唤醒。相对路径按 iterDir 解析。
   */
  runScript?: string
}

/** 一次拟合的状态视图（Provider -> Consumer）。 */
export interface FitStatusView {
  /** ctx.jobs 注册的 job id（`ctpwa-N`）。 */
  jobId: string
  /** 提交时的迭代目录（从提交记录解析，status 时可直接 summarizeFitDir）。 */
  iterDir: string
  state: 'running' | 'done' | 'failed' | 'canceled'
  /** 进程退出码（done/failed 时）。 */
  exitCode?: number
  /** 失败/取消原因（detail）。 */
  error?: string
  /** 日志尾部（settled 后从 job output 取）。 */
  logTail: string
  /** 运行中作业的进度行（SLURM: 队列状态/PENDING 原因/已排队时长）。 */
  progress?: string
  /** SLURM 作业号（`sbatch` 返回的那个），非 SLURM 目标无。 */
  sbatchId?: string
  /** 实际使用的执行目标（cpu/gpu/slurm/script）。 */
  target?: string
}

/**
 * Fit-job identity. DSH's job registry changed generations (see the vendored
 * dsh-jobs header), so this carries BOTH handles rather than one guessed shape:
 *   - `id`    — the SessionId string: always available; what released DSH
 *               (0.2.0-rc.2) wants for owner and caller, and what every
 *               generation accepts as the caller.
 *   - `agent` — the live Agent: what current DSH wants for owner and caller
 *               (its `.id` is the SessionId, and it carries the scope context).
 *
 * Historically this type was `{ sessionId: string }`, copied from a wrong
 * vendored stub: the real Agent exposes `id` (no `sessionId`), so every fit
 * job was registered UNOWNED and dsh-tool-jobs therefore never delivered the
 * completion notice — the "submitted, then silence" bug.
 */
export interface FitOwner {
  /** Session id (registry authorization key in every generation). */
  readonly id: string
  /** The live Agent (owner/caller identity in current DSH). */
  readonly agent?: { readonly id?: string; readonly ctx?: unknown }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pwaFit: FitService
  }
}

/**
 * 抽象拟合服务。子类实现 submit/status/kill 并注册为 ctx.pwaFit
 * （一个 context 一份实现；加载第二个抛重复服务错误——cordis 标准行为）。
 */
export abstract class FitService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'pwaFit')
  }

  /** 提交拟合并立即注册后台任务，返回 job id（`ctpwa-N`）。 */
  abstract submit(request: FitRequest, owner?: FitOwner): string

  /**
   * 批量提交：多个迭代目录共享一个后台任务（全部完成才 settle，即一次唤醒）。
   * 仅当所用 transport 支持批次时可用；否则抛错。Consumer 需先判
   * `typeof ctx.pwaFit.submitBatch === 'function'`（测试/降级直接走 submit）。
   */
  submitBatch?(request: FitRequest, owner?: FitOwner): string

  /** 查询任务状态（含最终日志尾部与迭代目录）。 */
  abstract status(jobId: string, caller?: FitOwner): FitStatusView

  /** 请求取消。返回 requested（运行中）或 already-finished。 */
  abstract kill(jobId: string, caller?: FitOwner): 'requested' | 'already-finished'
}

export default FitService
