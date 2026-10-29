/**
 * fit-target — decide WHERE one fit runs, per call.
 *
 * The old design chose a transport ONCE at plugin load (`pickFitRunner`):
 * "CUDA visible -> local, else slurm clients -> slurm, else local (which then
 * failed with no GPU)". That made two legitimate cases impossible:
 *
 *   - ctpwa has a CPU backend (0.3.19+): a low-statistics fit should be able
 *     to run on the CPU without joining the cluster queue;
 *   - a login node has slurm but no GPU, so every fit was forced into the
 *     queue even when the AI wanted a 30-second CPU smoke test.
 *
 * The AI knows the statistics, so it chooses per call. What the plugin still
 * guarantees: the config gate runs before any compute, and the fit is a DSH
 * background job (completion wakes the AI).
 *
 * Resolution rules (target omitted = "auto"):
 *   1. a runScript given -> 'script' (the AI owns the command entirely);
 *   2. explicit cpu / gpu / slurm -> validated against the host;
 *   3. PWA_FIT_TARGET env (deployment default) -> treated as explicit;
 *   4. auto -> gpu if the HOST probe sees CUDA, else cpu — but when the host
 *      has slurm clients and no GPU, AUTO REFUSES to guess: running a
 *      production fit on a login node is 20-60x slower, while queueing is a
 *      different tradeoff the AI should make on purpose. The error tells it
 *      exactly which two targets to choose from (or set PWA_FIT_TARGET).
 *
 * Why the probe must run in the host: the bash sandbox hides the GPU device
 * (`nvidia-smi` / torch both report none) while the harness process sees it.
 * `detectGpuAvailability` spawns the configured python from THIS process, so
 * it reports the truth for the process that will actually spawn the fit.
 */
import { detectGpuAvailability } from './fit-runner.js'
import { hasSlurmClients } from './fit-transport.js'

/** Target requested by the AI (or the deployment default). */
export type FitTarget = 'auto' | 'cpu' | 'gpu' | 'slurm'

/** Target actually used for one submission. */
export type ResolvedFitTarget = 'cpu' | 'gpu' | 'slurm' | 'script'

/** Host capabilities relevant to target choice (probed from this process). */
export interface HostCapabilities {
  /** torch sees a usable CUDA device from the host process. */
  gpu: boolean
  /** Diagnostic when gpu === false. */
  gpuIssue?: string
  /** sbatch/squeue/sacct are on PATH. */
  slurm: boolean
}

/** Result of resolving one submission. */
export interface TargetResolution {
  target: ResolvedFitTarget
  /** One-line explanation shown in the tool output. */
  reason: string
  /** When set, the submission must not proceed; the message says what to pass. */
  error?: string
}

/** Parse a user/env target string; unknown values fall back to 'auto'. */
export function parseFitTarget(value: string | undefined): FitTarget {
  const v = (value ?? '').trim().toLowerCase()
  if (v === 'cpu' || v === 'gpu' || v === 'slurm') return v
  return 'auto'
}

/**
 * Deployment default: `PWA_FIT_TARGET`, with the old `PWA_FIT_TRANSPORT` kept
 * as a deprecated alias (`local` = auto, `slurm` = slurm).
 */
export function defaultFitTarget(env: NodeJS.ProcessEnv = process.env): FitTarget {
  const explicit = env.PWA_FIT_TARGET
  if (explicit !== undefined && explicit.trim() !== '') return parseFitTarget(explicit)
  const legacy = (env.PWA_FIT_TRANSPORT ?? '').trim().toLowerCase()
  if (legacy === 'slurm') return 'slurm'
  if (legacy === 'local') return 'auto'
  return 'auto'
}

/** Cache key -> capabilities (probe spawns python, so cache a short while). */
const CAP_CACHE_TTL_MS = 30_000
const capCache = new Map<string, { at: number; caps: HostCapabilities }>()

/**
 * Probe the host once (cached for 30 s): CUDA visibility from the configured
 * python + slurm clients on PATH. Never throws; a missing python counts as
 * "no GPU" with the diagnostic attached.
 */
export function probeHostCapabilities(
  python: string,
  ldLibraryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): HostCapabilities {
  const key = `${python}\u0000${ldLibraryPath}\u0000${env.PATH ?? ''}`
  const hit = capCache.get(key)
  if (hit !== undefined && now - hit.at < CAP_CACHE_TTL_MS) return hit.caps
  const gpuIssue = detectGpuAvailability(python, ldLibraryPath)
  const caps: HostCapabilities = {
    gpu: gpuIssue === undefined,
    ...(gpuIssue !== undefined ? { gpuIssue } : {}),
    slurm: hasSlurmClients(env),
  }
  capCache.set(key, { at: now, caps })
  return caps
}

/** Clear the probe cache (tests / explicit refresh). */
export function clearHostCapabilityCache(): void {
  capCache.clear()
}

/** Options for `resolveFitTarget`. */
export interface ResolveTargetOptions {
  /** Explicit `target` parameter (undefined = deployment default). */
  requested?: string
  /** True when a runScript was provided (it overrides every target). */
  hasRunScript?: boolean
  /** Host capabilities (from probeHostCapabilities). */
  caps: HostCapabilities
  /** Deployment default lookup (defaults to process.env). */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve one submission's target. Pure except for the env default lookup.
 * Never throws: failures come back as `{ error }` so the caller can render
 * them with the gate report.
 */
export function resolveFitTarget(opts: ResolveTargetOptions): TargetResolution {
  const env = opts.env ?? process.env
  if (opts.hasRunScript === true) {
    return { target: 'script', reason: 'runScript 优先：命令由 AI 完全决定，插件只负责门禁+后台等待+唤醒' }
  }
  const explicit = opts.requested !== undefined && opts.requested.trim() !== '' && opts.requested !== 'auto'
  const target = explicit ? parseFitTarget(opts.requested) : defaultFitTarget(env)
  const fromEnv = !explicit && target !== 'auto'
  const source = explicit ? '显式 target' : fromEnv ? 'PWA_FIT_TARGET/PWA_FIT_TRANSPORT' : 'auto'

  if (target === 'cpu') {
    return { target: 'cpu', reason: `${source} -> cpu（本机 CPU；比 GPU 慢 20~60×，只适合低统计/冒烟）` }
  }
  if (target === 'gpu') {
    if (!opts.caps.gpu) {
      return {
        target: 'gpu',
        reason: `${source} -> gpu`,
        error:
          `本机没有可用 GPU（宿主探测：${opts.caps.gpuIssue ?? 'unknown'}）。` +
          `改用 target:"cpu"（低统计/冒烟）或 target:"slurm"（集群），或去掉 target 让 auto 决定。`,
      }
    }
    return { target: 'gpu', reason: `${source} -> gpu（宿主 GPU 可用）` }
  }
  if (target === 'slurm') {
    if (!opts.caps.slurm) {
      return {
        target: 'slurm',
        reason: `${source} -> slurm`,
        error:
          '本机没有 sbatch/squeue/sacct（不是集群登录节点）。改用 target:"cpu"/"gpu"，' +
          '或到登录节点上运行 harness。',
      }
    }
    return { target: 'slurm', reason: `${source} -> slurm（集群作业，需要排队）` }
  }

  // auto
  if (opts.caps.gpu) return { target: 'gpu', reason: 'auto：宿主探测到 CUDA -> gpu' }
  if (opts.caps.slurm) {
    return {
      target: 'cpu',
      reason: 'auto：无 GPU 但有 slurm 客户端',
      error:
        '本机无 GPU、但有 sbatch/squeue/sacct：auto 不替你选（登录节点上跑 CPU 会比 GPU 慢 20~60×，' +
        '而 slurm 要排队）。显式传 target:"cpu"（低统计/冒烟）或 target:"slurm"（正式拟合）；' +
        '如果这台登录节点长期只跑集群作业，设 PWA_FIT_TARGET=slurm 让 auto 有默认值。',
    }
  }
  return { target: 'cpu', reason: 'auto：无 GPU、无 slurm -> cpu（本机 CPU 拟合）' }
}

/** Human one-liner for a run summary. */
export function describeTarget(res: TargetResolution): string {
  return `target=${res.target}（${res.reason}）`
}
