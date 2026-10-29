import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PwaFitLocalService, FIT_OUTPUT_LIMIT_BYTES } from '../plugin/pwa-fit-local.js'
import type { JobHooks, JobIdentity, JobKind, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { FitOwner } from '../plugin/pwa-fit.js'
import type { FitStatus } from '../src/fit-runner.js'
import type { Context } from '@deepseek-ai/cordis'

/** In-memory ctx.jobs registry mirroring the real semantics (start/read/kill). */
class FakeJobRegistry {
  jobs = new Map<string, { snapshot: () => JobSnapshot; hooks: JobHooks; output: () => string }>()
  seq = 0
  attached: string[] = []
  /** Owner identity handed to start() — asserted by the generation tests. */
  owners: (JobIdentity | undefined)[] = []
  /** Caller identity handed to get()/read()/kill(). */
  callers: (JobIdentity | undefined)[] = []
  /**
   * Output shape the registry speaks. Current DSH returns `{ chunks, lossy, job }`
   * with NO `text`; only the released DSH returned `{ text, snapshot }`. Default
   * to the current shape so the suite models the runtime the plugin actually runs on.
   */
  readShape: 'chunks' | 'text' = 'chunks'
  start(spec: { kind: JobKind; label: string; outputLimitBytes?: number; owner?: JobIdentity; run(): JobHooks }): string {
    this.owners.push(spec.owner)
    const hooks = spec.run()
    const id = `ctpwa-${++this.seq}`
    const state = { status: 'running' as 'running' | 'completed' | 'killed' | 'failed', detail: undefined as string | undefined, output: '' }
    let settled = false
    hooks.done.then((outcome) => {
      settled = true
      state.status = outcome.status
      state.detail = outcome.detail
      state.output = outcome.output ?? ''
    })
    this.jobs.set(id, {
      snapshot: () => ({
        id,
        kind: spec.kind,
        label: spec.label,
        status: state.status,
        detail: state.detail,
        outputLimitBytes: spec.outputLimitBytes,
        startedAt: 1,
        finishedAt: settled ? 2 : undefined,
        reported: false,
      }),
      hooks,
      output: () => state.output,
    })
    return id
  }

  get(id: string, caller?: JobIdentity): JobSnapshot {
    this.callers.push(caller)
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    return job.snapshot()
  }

  read(id: string, caller?: JobIdentity): unknown {
    this.callers.push(caller)
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    if (this.readShape === 'text') return { text: job.output(), snapshot: job.snapshot() }
    // Current DSH: the output arrives as ordered chunks, and there is no `text`.
    const text = job.output()
    const chunks = text === ''
      ? []
      : (text.match(/[\s\S]{1,4}/g) ?? []).map((piece, i) => ({ at: i * 4, text: piece }))
    return { chunks, lossy: false, job: job.snapshot() }
  }

  kill(id: string, caller?: JobIdentity): 'requested' | 'already-finished' {
    this.callers.push(caller)
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    if (job.snapshot().status !== 'running') return 'already-finished'
    job.hooks.cancel('killed by test')
    return 'requested'
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((j) => j.snapshot())
  }

  attachController(name: string): void {
    this.attached.push(name)
  }
}

/** Current-DSH surface: `onJobDone` exists, so identity is the live Agent. */
class AgentFakeJobRegistry extends FakeJobRegistry {
  readonly onJobDone = () => () => {}
}

/** Controllable fake runner: settled() resolves when the test says so. */
class FakeRunner {
  submitted: { iterDir: string; timeoutMs?: number; device?: string; command?: { file: string; args: string[] }; jobScript?: string }[] = []
  canceled: string[] = []
  private settleFns = new Map<string, (s: FitStatus) => void>()

  submit(
    iterDir: string,
    options: { timeoutMs?: number; device?: 'cpu' | 'gpu' | 'auto'; command?: { file: string; args: string[] }; jobScript?: string } = {},
  ): FitStatus {
    const jobId = `fit-${this.submitted.length + 1}`
    this.submitted.push({
      iterDir,
      timeoutMs: options.timeoutMs,
      ...(options.device !== undefined ? { device: options.device } : {}),
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.jobScript !== undefined ? { jobScript: options.jobScript } : {}),
    })
    return { jobId, iterDir, state: 'running', exitCode: null, logTail: '', startedAt: 1 }
  }

  settled(jobId: string): Promise<FitStatus> {
    return new Promise((resolve) => {
      this.settleFns.set(jobId, resolve)
    })
  }

  finish(jobId: string, state: 'done' | 'failed' | 'canceled', opts: { exitCode?: number | null; logTail?: string; error?: string } = {}): void {
    const fn = this.settleFns.get(jobId)
    if (!fn) throw new Error(`no waiter for ${jobId}`)
    this.settleFns.delete(jobId)
    fn({ jobId, iterDir: 'iter-x', state, exitCode: opts.exitCode ?? null, logTail: opts.logTail ?? '', startedAt: 1, finishedAt: 2, error: opts.error })
  }

  cancel(jobId: string): boolean {
    this.canceled.push(jobId)
    this.finish(jobId, 'canceled', { error: 'canceled by caller' })
    return true
  }
}

const ctx = (registry: FakeJobRegistry, goals?: unknown) =>
  ({ jobs: registry, get: (n: string) => (n === 'goals' ? goals : undefined) } as unknown as Context)

describe('PwaFitLocalService (ctx.jobs provider)', () => {
  it('submits a fit as a ctpwa job owned by the caller, with output cap', () => {
    const registry = new AgentFakeJobRegistry()
    const service = new PwaFitLocalService(ctx(registry), { runner: new FakeRunner() })
    expect(registry.attached).toContain('pwa-fit-local')
    const owner: FitOwner = { id: 'sess-1', agent: { id: 'sess-1' } }
    const jobId = service.submit({ iterDir: '/pwa/iter-001' }, owner)
    expect(jobId).toBe('ctpwa-1')
    // Current DSH wants the live Agent as owner — a bare SessionId string (or
    // a wrong field like the old {sessionId}) would register the job UNOWNED,
    // which is why dsh-tool-jobs never delivered a completion notice.
    expect(registry.owners[0]).toBe(owner.agent)
    const snap = registry.get(jobId)
    expect(snap.kind).toBe('ctpwa')
    expect(snap.label).toContain('/pwa/iter-001')
    expect(snap.outputLimitBytes).toBe(FIT_OUTPUT_LIMIT_BYTES)
    expect(service.status(jobId).state).toBe('running')
  })

  it('passes the SessionId string to a released-DSH registry (no onJobDone)', () => {
    const registry = new FakeJobRegistry()
    const service = new PwaFitLocalService(ctx(registry), { runner: new FakeRunner() })
    service.submit({ iterDir: '/pwa/iter-legacy' }, { id: 'sess-9', agent: { id: 'sess-9' } })
    expect(registry.owners[0]).toBe('sess-9')
    // Reads take the same string identity in that generation.
    service.status('ctpwa-1', { id: 'sess-9', agent: { id: 'sess-9' } })
    expect(registry.callers).toContain('sess-9')
  })

  it('passes the Agent as the read/kill caller on current DSH', () => {
    const registry = new AgentFakeJobRegistry()
    const service = new PwaFitLocalService(ctx(registry), { runner: new FakeRunner() })
    const owner: FitOwner = { id: 'sess-1', agent: { id: 'sess-1' } }
    const jobId = service.submit({ iterDir: '/pwa/iter-owner' }, owner)
    service.status(jobId, owner)
    service.kill(jobId, owner)
    expect(registry.callers[0]).toBe(owner.agent)
    expect(registry.callers.every((c) => c === owner.agent)).toBe(true)
  })

  it('maps completion to done + exit code + log tail (final-output job)', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(registry), { runner })
    const jobId = service.submit({ iterDir: '/pwa/iter-002' })
    runner.finish('fit-1', 'done', { exitCode: 0, logTail: 'NLL best: -18623.5' })
    await registry.jobs.get(jobId)!.hooks.done
    const view = service.status(jobId)
    expect(view.state).toBe('done')
    expect(view.exitCode).toBe(0)
    expect(view.logTail).toContain('NLL best')
    expect(view.iterDir).toBe('/pwa/iter-002')
  })

  it('flattens the current-DSH chunked read (no `text` field) into logTail', async () => {
    // The regression this guards: reading `.text` off the current shape yields
    // undefined, so EVERY settled job failed output validation with "value is
    // not lossless JSON" — auto_pwa_fit_status was unusable on current DSH.
    const registry = new FakeJobRegistry() // chunked (current DSH) by default
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(registry), { runner })
    const jobId = service.submit({ iterDir: '/pwa/iter-chunked' })
    runner.finish('fit-1', 'done', { exitCode: 0, logTail: 'chunked-fit-log-tail' })
    await registry.jobs.get(jobId)!.hooks.done
    const view = service.status(jobId)
    expect(typeof view.logTail).toBe('string')
    expect(view.logTail).toBe('chunked-fit-log-tail') // multi-chunk output must be joined in order
  })

  it('still reads the released-DSH { text, snapshot } shape', async () => {
    const registry = new FakeJobRegistry()
    registry.readShape = 'text'
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(registry), { runner })
    const jobId = service.submit({ iterDir: '/pwa/iter-legacy-shape' })
    runner.finish('fit-1', 'done', { exitCode: 0, logTail: 'legacy-text-shape' })
    await registry.jobs.get(jobId)!.hooks.done
    expect(service.status(jobId).logTail).toBe('legacy-text-shape')
  })

  it('keeps logTail a string when the read result carries no readable shape', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(registry), { runner })
    const jobId = service.submit({ iterDir: '/pwa/iter-opaque' })
    runner.finish('fit-1', 'done', { exitCode: 0, logTail: 'ignored' })
    await registry.jobs.get(jobId)!.hooks.done
    registry.read = () => ({ lossy: false }) // neither text nor chunks
    expect(service.status(jobId).logTail).toBe('')
  })

  it('maps failure and cancellation', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(registry), { runner })
    const failed = service.submit({ iterDir: '/pwa/iter-003' })
    runner.finish('fit-1', 'failed', { exitCode: 1 })
    await registry.jobs.get(failed)!.hooks.done
    expect(service.status(failed).state).toBe('failed')
    expect(service.status(failed).error).toContain('exit code: 1')

    const killed = service.submit({ iterDir: '/pwa/iter-004' })
    service.kill(killed)
    await registry.jobs.get(killed)!.hooks.done
    expect(service.status(killed).state).toBe('canceled')
    expect(runner.canceled).toEqual(['fit-2'])
  })

  it('forwards unknown-job errors instead of guessing', () => {
    const registry = new FakeJobRegistry()
    const service = new PwaFitLocalService(ctx(registry), { runner: new FakeRunner() })
    expect(() => service.status('ctpwa-99')).toThrow(/unknown job/)
  })

  it('reports progress for a RUNNING job from the fit.log tail', () => {
    // A ctpwa job is a final-output job: the registry holds no bytes before
    // settlement, so without the log tail a running job showed an empty
    // 日志尾部 — no way to tell "run 3/10" from "hung".
    const dir = mkdtempSync(join(tmpdir(), 'pwa-fit-local-'))
    try {
      writeFileSync(
        join(dir, 'fit.log'),
        'Initialization complete.\n[aifit] run 3/10 NLL=-1187.82 PD=False iters=2705 t=48.2s\n',
      )
      const registry = new FakeJobRegistry()
      const service = new PwaFitLocalService(ctx(registry), { runner: new FakeRunner() })
      const jobId = service.submit({ iterDir: dir })
      const view = service.status(jobId)
      expect(view.state).toBe('running')
      expect(view.logTail).toContain('[aifit] run 3/10')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PwaFitLocalService target dispatch', () => {
  it('cpu/gpu pick the local runner with the device pinned', () => {
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(new FakeJobRegistry()), {
      runner,
      capabilities: { gpu: true, slurm: false },
    })
    const cpuId = service.submit({ iterDir: '/pwa/iter-001', target: 'cpu' })
    const gpuId = service.submit({ iterDir: '/pwa/iter-002', target: 'gpu' })
    expect(runner.submitted.map((r) => r.device)).toEqual(['cpu', 'gpu'])
    expect(service.status(cpuId).target).toBe('cpu')
    expect(service.status(gpuId).target).toBe('gpu')
  })

  it('runScript dispatches to the local runner as a command (target ignored)', () => {
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(new FakeJobRegistry()), {
      runner,
      capabilities: { gpu: false, slurm: true, gpuIssue: 'no CUDA' },
    })
    const id = service.submit({ iterDir: '/pwa/iter-003', target: 'slurm', runScript: 'run.sh' })
    expect(runner.submitted[0]?.command).toEqual({ file: '/pwa/iter-003/run.sh', args: [] })
    expect(service.status(id).target).toBe('script')
  })

  it('slurm dispatches to the slurm runner with the job script', () => {
    const local = new FakeRunner()
    const slurm = new FakeRunner()
    const service = new PwaFitLocalService(ctx(new FakeJobRegistry()), {
      runner: local,
      slurmRunner: slurm,
      capabilities: { gpu: false, slurm: true, gpuIssue: 'no CUDA' },
    })
    const id = service.submit({ iterDir: '/pwa/iter-004', target: 'slurm', jobScript: '/pwa/iter-004/job.sh' })
    expect(local.submitted).toHaveLength(0)
    expect(slurm.submitted[0]?.jobScript).toBe('/pwa/iter-004/job.sh')
    expect(service.status(id).target).toBe('slurm')
  })

  it('resolve() reports the login-node ambiguity without submitting', () => {
    const runner = new FakeRunner()
    const service = new PwaFitLocalService(ctx(new FakeJobRegistry()), {
      runner,
      capabilities: { gpu: false, slurm: true, gpuIssue: 'no CUDA' },
    })
    const res = service.resolve({ iterDir: '/pwa/iter-005' })
    expect(res.error).toContain('target:"slurm"')
    expect(() => service.submit({ iterDir: '/pwa/iter-005' })).toThrow(/target:"cpu"/)
    expect(runner.submitted).toHaveLength(0)
  })
})

/** Minimal ctx.goals stand-in: armed goal, records disarm/resume. */
class FakeGoals {
  view: { id: string; revision: number; phase: string; activation: string } | undefined = {
    id: 'goal-1',
    revision: 1,
    phase: 'active',
    activation: 'armed',
  }
  disarmed = 0
  resumed = 0
  get(_agent: unknown) {
    return this.view
  }
  disarm(_agent: unknown) {
    this.disarmed += 1
    if (this.view !== undefined) this.view = { ...this.view, activation: 'disarmed' }
    return this.view
  }
  resume(_agent: unknown, ref: { id: string; revision: number }) {
    this.resumed += 1
    if (this.view !== undefined) this.view = { ...this.view, revision: ref.revision, activation: 'armed' }
    return this.view
  }
}

const OWNER: FitOwner = { id: 'sess-1', agent: { id: 'sess-1' } }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('PwaFitLocalService goal parking (no busy-wait goal rounds while a fit runs)', () => {
  it('disarms an armed goal on submit and re-arms it when the fit settles', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const goals = new FakeGoals()
    const service = new PwaFitLocalService(ctx(registry, goals), {
      runner,
      capabilities: { gpu: false, slurm: false },
    })
    const id = service.submit({ iterDir: '/pwa/iter-001' }, OWNER)
    expect(goals.disarmed).toBe(1)
    expect(goals.view?.activation).toBe('disarmed')
    expect(service.status(id).state).toBe('running')
    runner.finish('fit-1', 'done')
    await tick()
    expect(goals.resumed).toBe(1)
    expect(goals.view?.activation).toBe('armed')
  })

  it('ref-counts concurrent fits: re-arm only after the LAST one settles', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const goals = new FakeGoals()
    const service = new PwaFitLocalService(ctx(registry, goals), {
      runner,
      capabilities: { gpu: false, slurm: false },
    })
    service.submit({ iterDir: '/pwa/iter-001' }, OWNER)
    service.submit({ iterDir: '/pwa/iter-002' }, OWNER)
    expect(goals.disarmed).toBe(1)
    runner.finish('fit-1', 'done')
    await tick()
    expect(goals.resumed).toBe(0)
    runner.finish('fit-2', 'done')
    await tick()
    expect(goals.resumed).toBe(1)
  })

  it('never touches a paused/replaced/cleared goal (human intent wins)', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const goals = new FakeGoals()
    goals.view = { id: 'goal-1', revision: 1, phase: 'paused', activation: 'disarmed' }
    const service = new PwaFitLocalService(ctx(registry, goals), {
      runner,
      capabilities: { gpu: false, slurm: false },
    })
    service.submit({ iterDir: '/pwa/iter-001' }, OWNER)
    expect(goals.disarmed).toBe(0)
    runner.finish('fit-1', 'done')
    await tick()
    expect(goals.resumed).toBe(0)
  })

  it('does not re-arm when the goal was paused (or replaced) during the wait', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const goals = new FakeGoals()
    const service = new PwaFitLocalService(ctx(registry, goals), {
      runner,
      capabilities: { gpu: false, slurm: false },
    })
    service.submit({ iterDir: '/pwa/iter-001' }, OWNER)
    expect(goals.disarmed).toBe(1)
    // Human pauses it while the fit runs.
    goals.view = { id: 'goal-1', revision: 2, phase: 'paused', activation: 'disarmed' }
    runner.finish('fit-1', 'done')
    await tick()
    expect(goals.resumed).toBe(0)
  })

  it('PWA_GOAL_PARK=off keeps goal rounds running during fits', async () => {
    const registry = new FakeJobRegistry()
    const runner = new FakeRunner()
    const goals = new FakeGoals()
    process.env.PWA_GOAL_PARK = 'off'
    try {
      const service = new PwaFitLocalService(ctx(registry, goals), {
        runner,
        capabilities: { gpu: false, slurm: false },
      })
      service.submit({ iterDir: '/pwa/iter-001' }, OWNER)
      expect(goals.disarmed).toBe(0)
    } finally {
      delete process.env.PWA_GOAL_PARK
    }
  })
})
