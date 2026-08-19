/**
 * Vendored minimal type surface + runtime stub for `@deepseek-ai/dsh-jobs`.
 * Mirrors the real package's public vocabulary (jobs/src/types.ts) at the
 * level the pwa-fit-local provider consumes: kind map (declaration-merge
 * extensible), JobStart/JobHooks/JobOutcome, snapshots, and the JobRegistry
 * service surface. The stub declares `ctpwa` in the kind map directly so
 * both the provider and its tests typecheck without the augmentation;
 * pwa-fit-local still performs the canonical `declare module` merge so the
 * REAL registry accepts the kind at runtime.
 */
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

/** Producer declaration passed to JobRegistry.start. */
export interface JobStart {
  /** Producer kind — also the id prefix ('ctpwa', ...). */
  kind: JobKind
  /** One-line model-facing label. */
  label: string
  /** Optional UTF-8 byte cap for model-facing completion notices / reads. */
  outputLimitBytes?: number
  /** Owning live agent (session fence + owner cleanup); undefined = unowned. */
  owner?: { sessionId: string }
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
  owner: { sessionId: string } | undefined,
) => void | PromiseLike<void>

/** The abstract background job registry exposed as ctx.jobs. */
export interface JobRegistry {
  start(spec: JobStart): string
  list(caller?: { sessionId: string }): JobSnapshot[]
  get(id: string, caller?: { sessionId: string }): JobSnapshot
  read(id: string, caller?: { sessionId: string }): JobRead
  kill(id: string, caller?: { sessionId: string }, reason?: string): 'requested' | 'already-finished'
  wait(id: string, timeoutMs: number, caller?: { sessionId: string }, signal?: AbortSignal): Promise<JobSnapshot>
  onJobDone(listener: JobDoneListener): () => void
  attachController?(name: string): void
}

/** JobId brand; plain string in the stub. */
export function JobId(id: string): string {
  return id
}
