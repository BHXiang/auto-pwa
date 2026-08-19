import { describe, expect, it } from 'vitest'
import { PwaFitLocalService, FIT_OUTPUT_LIMIT_BYTES } from '../plugin/pwa-fit-local.js'
import type { JobHooks, JobKind, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { FitStatus } from '../src/fit-runner.js'
import type { Context } from '@deepseek-ai/cordis'

/** In-memory ctx.jobs registry mirroring the real semantics (start/read/kill). */
class FakeJobRegistry {
  jobs = new Map<string, { snapshot: () => JobSnapshot; hooks: JobHooks; output: () => string }>()
  seq = 0
  attached: string[] = []

  start(spec: { kind: JobKind; label: string; outputLimitBytes?: number; owner?: { sessionId: string }; run(): JobHooks }): string {
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

  get(id: string): JobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    return job.snapshot()
  }

  read(id: string): { text: string; snapshot: JobSnapshot } {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    return { text: job.output(), snapshot: job.snapshot() }
  }

  kill(id: string): 'requested' | 'already-finished' {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    if (job.snapshot().status !== 'running') return 'already-finished'
    job.hooks.cancel('killed by test')
    return 'requested'
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((j) => j.snapshot())
  }

  onJobDone(): () => void {
    return () => {}
  }

  attachController(name: string): void {
    this.attached.push(name)
  }
}

/** Controllable fake runner: settled() resolves when the test says so. */
class FakeRunner {
  submitted: { iterDir: string; timeoutMs?: number }[] = []
  canceled: string[] = []
  private settleFns = new Map<string, (s: FitStatus) => void>()

  submit(iterDir: string, options: { timeoutMs?: number } = {}): FitStatus {
    const jobId = `fit-${this.submitted.length + 1}`
    this.submitted.push({ iterDir, timeoutMs: options.timeoutMs })
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

const ctx = (registry: FakeJobRegistry) => ({ jobs: registry } as unknown as Context)

describe('PwaFitLocalService (ctx.jobs provider)', () => {
  it('submits a fit as a ctpwa job owned by the caller, with output cap', () => {
    const registry = new FakeJobRegistry()
    const service = new PwaFitLocalService(ctx(registry), { runner: new FakeRunner() })
    expect(registry.attached).toContain('pwa-fit-local')
    const jobId = service.submit({ iterDir: '/pwa/iter-001' }, { sessionId: 'sess-1' })
    expect(jobId).toBe('ctpwa-1')
    const snap = registry.get(jobId)
    expect(snap.kind).toBe('ctpwa')
    expect(snap.label).toContain('/pwa/iter-001')
    expect(snap.outputLimitBytes).toBe(FIT_OUTPUT_LIMIT_BYTES)
    expect(service.status(jobId).state).toBe('running')
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
})
