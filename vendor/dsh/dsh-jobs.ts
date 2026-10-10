/**
 * Vendored minimal type surface + runtime stub for `@deepseek-ai/dsh-jobs`.
 * Mirrors the real package's public vocabulary at the level the pwa-fit-local
 * provider consumes: kind map (declaration-merge extensible), JobStart/
 * JobHooks/JobOutcome, snapshots, and the JobRegistry service surface. The
 * stub declares `ctpwa` in the kind map directly so both the provider and its
 * tests typecheck without the augmentation; pwa-fit-local still performs the
 * canonical `declare module` merge so the REAL registry accepts the kind.
 */
/**
 * Job identity. The registry contract changed between DSH releases and this
 * stub must model BOTH, because the plugin runs against whichever harness the
 * user has installed:
 *
 *   - current DSH (dsh-jobs 0.1.5-rc.1): a job's owner AND every read/kill
 *     caller is the live **Agent** (`Agent.id` is the SessionId; the Agent also
 *     carries the context used for scope routing). The registry exposes
 *     `onJobDone`.
 *   - released DSH 0.2.0-rc.2 and earlier: owner and caller are the bare
 *     **SessionId string**; the registry exposes `readAt`/`remove`.
 *
 * Getting this wrong does NOT throw in the current generation — the job is
 * silently created UNOWNED, and `dsh-tool-jobs` then returns early
 * (`event.job.owner === undefined`) so no completion notice is ever delivered.
 * That is precisely the "fit submitted, agent never wakes up" failure, which
 * is why pwa-fit-local adapts at runtime instead of trusting one shape.
 */
export interface JobAgent {
  /** Session id of the live agent (the registry's authorization key). */
  readonly id: string
  /** Agent context — used by the registry's scope routing. */
  readonly ctx?: unknown
}

/** Owner / caller identity accepted by the running registry generation. */
export type JobIdentity = JobAgent | string

export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
  ctpwa: 'ctpwa'
}

/** The merge-extensible union of registered producer kind names. */
export type JobKind = JobKindMap[keyof JobKindMap]

/** Terminal result supplied by a producer through JobHooks.done. */
export interface JobOutcome {
  /** How the job ended: finished, cancelled, or broke. */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3'). */
  detail?: string
  /** Final output for jobs without readOutput; stream jobs leave it unset. */
  output?: string
}

/** Hooks through which the runtime controls and observes producer work. */
export interface JobHooks {
  /** Request termination: synchronous, idempotent, eventually settles `done`. */
  cancel(reason?: string): void
  /** Resolves after the producer releases its resources. */
  done: Promise<JobOutcome>
  /** Stream jobs only: consume output produced since the previous call. */
  readOutput?(): string
}

/** Owner of a job: the live Agent (current DSH) or the SessionId (released). */
export type JobOwner = JobIdentity
/** Read/kill caller: same union as the owner (see {@link JobIdentity}). */
export type JobCaller = JobIdentity

/** Producer declaration passed to JobRegistry.start. */
export interface JobStart {
  /** Producer kind — also the id prefix ('ctpwa', ...). */
  kind: JobKind
  /** One-line model-facing label. */
  label: string
  /** Optional UTF-8 byte cap for model-facing completion notices / reads. */
  outputLimitBytes?: number
  /** Owning live agent (session fence + owner cleanup); undefined = unowned. */
  owner?: JobOwner
  /** Start the work after preflight and synchronously return its hooks. */
  run(): JobHooks
}

/** A read-only projection of one job. */
export interface JobSnapshot {
  /** The registry-issued id (`<kind>-N`). */
  id: string
  kind: JobKind
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  outputLimitBytes?: number
  startedAt: number
  finishedAt?: number
  reported: boolean
}

/** Output and post-read state returned by JobRegistry.read. */
export interface JobRead {
  text: string
  snapshot: JobSnapshot
}

/** Completion callback with the exact owner supplied at start. */
export type JobDoneListener = (
  snapshot: JobSnapshot,
  owner: JobOwner | undefined,
) => void | PromiseLike<void>

/** The abstract background job registry exposed as ctx.jobs. */
export interface JobRegistry {
  start(spec: JobStart): string
  list(caller?: JobCaller): JobSnapshot[]
  get(id: string, caller?: JobCaller): JobSnapshot
  read(id: string, caller?: JobCaller): JobRead
  kill(id: string, caller?: JobCaller, reason?: string): 'requested' | 'already-finished'
  wait(id: string, timeoutMs: number, caller?: JobCaller, signal?: AbortSignal): Promise<JobSnapshot>
  /** Current DSH: done-listener registration (its presence identifies the Agent-identity generation). */
  onJobDone?(listener: JobDoneListener): () => void
  /** Released DSH: incremental read (its presence identifies the SessionId generation). */
  readAt?(id: string, from: number, caller?: JobCaller): { text: string; snapshot: JobSnapshot }
  remove?(id: string, caller?: JobCaller): void
  attachController?(name: string): void
}

/** JobId brand; plain string in the stub. */
export function JobId(id: string): string {
  return id
}
