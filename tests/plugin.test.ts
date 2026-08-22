import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync as readFileSyncSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply } from '../plugin/auto-pwa.js'
import { apply as applyGuard } from '../plugin/pwa-guard.js'
import { IterationLog } from '../src/iteration-log.js'
import { defaultFitRunnerConfig } from '../src/fit-runner.js'

/** Minimal ctx mock: collects tool definitions instead of registering them. */
function collectDefinitions() {
  const definitions: { name: string; description?: string; execute?: (args: never, exec: never) => Promise<unknown> }[] = []
  const ctx = {
    tools: {
      register: (def: { name: string; description?: string; execute?: (args: never, exec: never) => Promise<unknown> }) => {
        definitions.push(def)
      },
    },
  }
  apply(ctx as never)
  return definitions
}

describe('auto-pwa plugin', () => {
  it('registers the auto_pwa_* tools', () => {
    const defs = collectDefinitions()
    expect(defs.map((d) => d.name)).toEqual([
      'auto_pwa_lookup',
      'auto_pwa_decay_check',
      'auto_pwa_jpc_check',
      'auto_pwa_config_view',
      'auto_pwa_suggest',
      'auto_pwa_validate_add',
      'auto_pwa_edit_config',
      'auto_pwa_round',
      'auto_pwa_iter_start',
      'auto_pwa_note',
      'auto_pwa_history',
      'auto_pwa_iterate',
      'auto_pwa_evaluate',
      'auto_pwa_diagnose',
      'auto_pwa_root_view',
      'auto_pwa_wave_view',
      'auto_pwa_run_fit',
      'auto_pwa_fit_status',
      'auto_pwa_try_candidates',
      'auto_pwa_compare',
      'auto_pwa_loop_next',
      'auto_pwa_loop_status',
      'auto_pwa_loop_decide',
    ])
  })

  it('documents every tool for the model', () => {
    for (const d of collectDefinitions()) {
      expect(d.description?.length ?? 0).toBeGreaterThan(20)
    }
  })
})

describe('auto-pwa plugin tools (smoke)', () => {
  const CONFIG = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  eta:
    J: 0
    P: -1
    mass: 0.5478
  Kp:
    J: 0
    P: -1
    mass: 0.4937
  Km:
    J: 0
    P: -1
    mass: 0.4937

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
      - [Kp, R_Keta]
    R_KK: [Kp, Km]
    R_Keta: [Kp, eta]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_Keta:
        - [J: 1, P: -1]: [K1_1410]
        - [J: 2, P: 1]: [K2_1430]

Constraints:
  maxL: 3
  trans:
    - [R_Keta_0, R_Keta_1]: -1

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
  K1_1410:
    J: 1
    P: -1
    model: BWR
    parameters: [1.47, 0.65]
  K2_1430:
    J: 2
    P: 1
    model: BWR
    parameters: [1.430, 0.09]
`

  function withConfig(fn: (configPath: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-plugin-'))
    const configPath = join(dir, 'config.yml')
    writeFileSync(configPath, CONFIG)
    return fn(configPath).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  const execute = async (name: string, args: never, exec?: { agent?: { sessionId?: string }; rootCallId?: string }) => {
    const def = collectDefinitions().find((d) => d.name === name)!
    expect(def.execute).toBeDefined()
    return def.execute!(args, exec as never)
  }

  it('auto_pwa_jpc_check: R_KK intersection = {1--, 3--} at config maxL=3, f2 blocked by C', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_jpc_check', { configPath } as never)) as {
        maxL: number
        intermediates: { name: string; allowed: { jpc: string }[]; cBlocked: string[] }[]
      }
      expect(out.maxL).toBe(3) // from Constraints.maxL
      const rkk = out.intermediates.find((i) => i.name === 'R_KK')!
      expect(rkk.allowed.map((a) => a.jpc)).toEqual(['1--', '3--'])
      expect(rkk.cBlocked).toEqual(['2++'])
      const rk = out.intermediates.find((i) => i.name === 'R_Keta')!
      expect(rk.allowed.map((a) => a.jpc)).toEqual(['1-', '2+', '3-'])
      expect(rk.cBlocked).toEqual([])
    })
  })

  it('auto_pwa_config_view: constraints parsed, validation clean, PDG cross-refs present', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_config_view', { configPath } as never)) as {
        particles: unknown[]
        chains: unknown[]
        resonances: { name: string; pdg: { id: string } | null; jpcMatch: boolean; thresholdMargin: { chain: string; margin: number } | null }[]
        constraints: { maxL?: number; trans?: unknown[]; identical?: unknown[] }
        validation: { ok: boolean; errors: unknown[]; warnings: unknown[] }
      }
      expect(out.particles.length).toBe(4)
      expect(out.constraints.maxL).toBe(3)
      expect(out.constraints.trans).toHaveLength(1)
      expect(out.validation.ok).toBe(true)
      const phi = out.resonances.find((r) => r.name === 'phi1020')!
      expect(phi.pdg?.id).toBe('phi(1020)')
      expect(phi.jpcMatch).toBe(true)
      expect(phi.thresholdMargin?.chain).toBe('decay1')
    })
  })

  it('auto_pwa_validate_add runs rules 10-12 against the real PDG table', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: {
          name: 'f2_1270',
          chain: 'R_KK',
          jpGroup: { j: 2, p: 1 },
          model: 'BWR',
          parameters: [1.275, 0.187],
        },
      } as never)) as { ok: boolean; errors: { code: string }[] }
      expect(out.ok).toBe(false)
      expect(out.errors.map((e) => e.code)).toContain('c-violation')
    })
  })
})

/** ctx with a fake pwaFit service + guard recorder + session-event hook. */
function harnessCtx() {
  const definitions: { name: string; execute?: (args: never, exec: never) => Promise<unknown> }[] = []
  const guards: ((exec: { name: string; arguments: unknown }) => string | undefined)[] = []
  const eventHandlers: Record<string, (...args: unknown[]) => void> = {}
  const submits: { request: { iterDir: string }; owner?: { sessionId: string } }[] = []
  const statusCalls: { jobId: string; caller?: { sessionId: string } }[] = []
  const pwaFit = {
    submit: (request: { iterDir: string }, owner?: { sessionId: string }) => {
      submits.push({ request, owner })
      return 'ctpwa-9'
    },
    status: (jobId: string, caller?: { sessionId: string }) => {
      statusCalls.push({ jobId, caller })
      return { jobId, iterDir: '/pwa/iter-001', state: 'done' as const, exitCode: 0, logTail: 'log tail' }
    },
    kill: () => 'requested' as const,
  }
  const ctx = {
    tools: {
      register: (def: { name: string; execute?: (args: never, exec: never) => Promise<unknown> }) => definitions.push(def),
      guard: (g: (exec: { name: string; arguments: unknown }) => string | undefined) => {
        guards.push(g)
        return () => {}
      },
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers[event] = handler
    },
    pwaFit,
  }
  apply(ctx as never)
  applyGuard(ctx as never) // pwa-guard registers the config.yml write gate
  return { definitions, guards, eventHandlers, submits, statusCalls }
}

const run = async (h: ReturnType<typeof harnessCtx>, name: string, args: unknown, exec: unknown) => {
  const def = h.definitions.find((d) => d.name === name)!
  return def.execute!(args as never, exec as never)
}

describe('auto-pwa harness wiring (ctx.jobs / guard / token-meter)', () => {
  it('registers the config.yml write guard', () => {
    const h = harnessCtx()
    expect(h.guards).toHaveLength(1)
    expect(h.guards[0]!({ name: 'write', arguments: { file_path: '/pwa/config.yml' } })).toMatch(/auto_pwa_edit_config/)
    expect(h.guards[0]!({ name: 'write', arguments: { file_path: '/pwa/note.md' } })).toBeUndefined()
  })

  it('auto_pwa_run_fit submits through ctx.pwaFit with the calling agent as owner', async () => {
    const h = harnessCtx()
    const out = await run(h, 'auto_pwa_run_fit', { iterDir: '/pwa/iter-001' }, { agent: { sessionId: 'sess-1' } })
    expect(h.submits).toEqual([{ request: { iterDir: '/pwa/iter-001', timeoutMin: undefined }, owner: { sessionId: 'sess-1' } }])
    expect((out as { jobId: string }).jobId).toBe('ctpwa-9')
  })

  it('auto_pwa_fit_status reads through ctx.pwaFit (summary skipped without results/)', async () => {
    const h = harnessCtx()
    const out = await run(h, 'auto_pwa_fit_status', { jobId: 'ctpwa-9' }, { agent: { sessionId: 'sess-1' } })
    expect(h.statusCalls).toEqual([{ jobId: 'ctpwa-9', caller: { sessionId: 'sess-1' } }])
    expect((out as { state: string }).state).toBe('done')
    expect((out as { logTail: string }).logTail).toBe('log tail')
    // No real results/ dir under the fake iterDir: empty summary, no NLL.
    expect((out as { summary: { bestNll?: number; files: string[] } }).summary.files).toEqual([])
    expect((out as { summary: { bestNll?: number } }).summary.bestNll).toBeUndefined()
  })

  it('auto_pwa_note includeTokens writes the per-round token delta', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-note-'))
    try {
      // Feed two assistant/message usage events (harness envelope: usage at
      // data.usage), then note with includeTokens.
      h.eventHandlers['session/event']!({ id: 'sess-1' }, { type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 200 } } })
      h.eventHandlers['session/event']!({ id: 'sess-1' }, { type: 'assistant/message', data: { usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 30 } } })
      h.eventHandlers['session/event']!({ id: 'sess-1' }, { type: 'tool/result' })
      const iterDir = join(dir, 'iterations', 'iter-001')
      const out = await run(
        h,
        'auto_pwa_note',
        { iterDir, title: '加 phi(1680)', kind: 'added', conclusion: 'ok', includeTokens: true },
        { agent: { sessionId: 'sess-1' } },
      )
      expect((out as { ok: boolean }).ok).toBe(true)
      const summary = JSON.parse(readFileSyncSync(join(dir, 'iterations', 'SUMMARY.jsonl'), 'utf8').trim().split('\n')[0]!)
      expect(summary.tokens).toEqual({ input: 1500, output: 250, cacheRead: 30, cacheWrite: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_note without includeTokens records no tokens and re-anchors nothing', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-note2-'))
    try {
      h.eventHandlers['session/event']!({ id: 'sess-1' }, { type: 'assistant/message', usage: { inputTokens: 42, outputTokens: 7 } })
      const iterDir = join(dir, 'iterations', 'iter-001')
      await run(h, 'auto_pwa_note', { iterDir, title: 'x', kind: 'other', conclusion: 'c' }, { agent: { sessionId: 'sess-1' } })
      const summary = JSON.parse(readFileSyncSync(join(dir, 'iterations', 'SUMMARY.jsonl'), 'utf8').trim().split('\n')[0]!)
      expect(summary.tokens).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('auto-pwa batch-2/3 tools (trial fits + loop state machine)', () => {
  const LOOP_CONFIG = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  eta:
    J: 0
    P: -1
    mass: 0.5478
  Kp:
    J: 0
    P: -1
    mass: 0.4937
  Km:
    J: 0
    P: -1
    mass: 0.4937

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
      - [Kp, R_Keta]
    R_KK: [Kp, Km]
    R_Keta: [Kp, eta]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_Keta:
        - [J: 1, P: -1]: [K1_1410]
        - [J: 2, P: 1]: [K2_1430]

Constraints:
  maxL: 3

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
  K1_1410:
    J: 1
    P: -1
    model: BWR
    parameters: [1.403, 0.174]
  K2_1430:
    J: 2
    P: 1
    model: BWR
    parameters: [1.425, 0.098]
`

  function fitJson(nll: number) {
    return JSON.stringify({ status: 'ok', fit: { runs: 2, maxIter: 500, best: { nll, positiveDefinite: true, params: [], fitFractions: [] } } })
  }

  it('auto_pwa_try_candidates: valid candidate submitted with short-fit args, invalid skipped by the gate', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-trial-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      const iterDir = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iterDir, 'results'), { recursive: true })
      writeFileSync(join(iterDir, 'config.yml'), LOOP_CONFIG)
      const out = (await run(
        h,
        'auto_pwa_try_candidates',
        {
          baseIterDir: iterDir,
          candidates: [
            { name: 'omega1420', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.41, 0.29] },
            { name: 'f2_1270', chain: 'R_KK', jpGroup: { j: 2, p: 1 }, model: 'BWR', parameters: [1.275, 0.187] }, // C-violation
          ],
          shortRuns: 1,
          shortMaxIter: 300,
        },
        { agent: { sessionId: 'sess-1' } },
      )) as { ok: boolean; jobs: { candidate: string; iterDir: string; jobId: string }[]; skipped: { candidate: string; errors: { code: string }[] }[] }
      expect(out.ok).toBe(true)
      expect(out.jobs).toHaveLength(1)
      expect(out.jobs[0]!.candidate).toBe('omega1420')
      expect(out.jobs[0]!.iterDir).toContain(join(iterationsRoot, '_trials'))
      expect(out.skipped).toHaveLength(1)
      expect(out.skipped[0]!.candidate).toBe('f2_1270')
      expect(out.skipped[0]!.errors.map((e) => e.code)).toContain('c-violation')
      // Short fit args flow through ctx.pwaFit into the job request.
      const req = h.submits[0]!.request as { iterDir: string; scriptArgs?: string[] }
      expect(req.scriptArgs).toEqual(['--runs', '1', '--max-iter', '300'])
      expect(h.submits[0]!.owner).toEqual({ sessionId: 'sess-1' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_loop: next(propose) -> decide(iterate) -> next(converge) writes FINAL-REPORT.md', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-loop-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      const iter0 = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iter0, 'results'), { recursive: true })
      writeFileSync(join(iter0, 'config.yml'), LOOP_CONFIG)
      writeFileSync(join(iter0, 'results', 'fit.json'), fitJson(100))
      // Diary baseline so ΔNLL can be computed after the next iteration.
      new IterationLog({ rootDir: iterationsRoot }).append({
        iter: 0,
        timestamp: new Date().toISOString(),
        title: '基线',
        kind: 'other',
        configPath: join(iter0, 'config.yml'),
        iterDir: iter0,
        nll: 100,
        conclusion: 'baseline',
      })

      // 1. Start: evaluate the baseline (no ΔNLL yet -> propose).
      const first = (await run(h, 'auto_pwa_loop_next', { iterationsRoot, baseIterDir: iter0 }, { agent: { sessionId: 'sess-1' } })) as {
        ok: boolean
        phase: string
        converged: boolean
        reason?: string
        eval?: { nll: number | null }
      }
      expect(first.ok).toBe(true)
      expect(first.phase).toBe('propose')
      expect(first.converged).toBe(false)
      expect(first.eval?.nll).toBe(100)
      expect(existsLoopState(iterationsRoot)).toBe(true)

      // 2. Decide: iterate with a valid proposal -> new iteration + fit job.
      const decided = (await run(
        h,
        'auto_pwa_loop_decide',
        {
          iterationsRoot,
          action: 'iterate',
          proposal: { name: 'omega1420', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.41, 0.29] },
        },
        { agent: { sessionId: 'sess-1' } },
      )) as { ok: boolean; action: string; iter: number; iterDir: string; jobId?: string; phase: string }
      expect(decided.ok).toBe(true)
      expect(decided.iter).toBe(1)
      expect(decided.jobId).toBe('ctpwa-9')
      expect(decided.phase).toBe('evaluate')

      // 3. Simulate the fit finishing with a small (insignificant) gain.
      const iter1 = decided.iterDir
      mkdirSync(join(iter1, 'results'), { recursive: true })
      mkdirSync(join(iter1, 'evaluate'), { recursive: true })
      writeFileSync(join(iter1, 'results', 'fit.json'), fitJson(98))
      writeFileSync(
        join(iter1, 'evaluate', 'evaluate.json'),
        JSON.stringify({ worst_distributions: [{ name: 'mass_R_KK', max_abs_pull: 2.1, bins_over_5sigma: 0 }] }),
      )

      // 4. Next: ΔNLL = -2 (below threshold), pulls OK -> converged.
      const second = (await run(h, 'auto_pwa_loop_next', { iterationsRoot }, { agent: { sessionId: 'sess-1' } })) as {
        ok: boolean
        phase: string
        converged: boolean
        reportPath?: string
        reason?: string
      }
      expect(second.ok).toBe(true)
      expect(second.phase).toBe('done')
      expect(second.converged).toBe(true)
      expect(second.reportPath).toContain('FINAL-REPORT.md')
      expect(readFileSyncSync(join(iterationsRoot, 'FINAL-REPORT.md'), 'utf8')).toContain('收敛')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function existsLoopState(root: string): boolean {
    try {
      readFileSyncSync(join(root, '.loop-state.json'))
      return true
    } catch {
      return false
    }
  }
})

// ---------------------------------------------------------------------------
// auto_pwa_root_view: real-file smoke test (skipped without uproot/ROOT file)
// ---------------------------------------------------------------------------

/** The plugin's configured python (PATH 'python' or PWA_CTPWA_PYTHON). */
const PY = defaultFitRunnerConfig().python
const HAS_UPROOT = spawnSync(PY, ['-c', 'import uproot'], { encoding: 'utf8' }).status === 0
const ROOT_FILE = '/home/whitewash/pwa/Jpsi2KKeta/solve3/results/weight_best.root'
const HAS_ROOT_FILE = existsSync(ROOT_FILE)

describe.skipIf(!HAS_UPROOT || !HAS_ROOT_FILE)('auto_pwa_root_view (real weight_best.root)', () => {
  it('list discovers per-wave histograms and angular distributions', async () => {
    const defs = collectDefinitions()
    const tool = defs.find((d) => d.name === 'auto_pwa_root_view')!
    const out = (await tool.execute!({ rootPath: ROOT_FILE, mode: 'list' } as never, { agent: { sessionId: 'sess-1' } } as never)) as {
      ok: boolean
      mode: string
      objects: { path: string; bins: number }[]
    }
    expect(out.ok).toBe(true)
    expect(out.mode).toBe('list')
    expect(out.objects.length).toBeGreaterThan(100)
    expect(out.objects.some((o) => o.path.includes('/h_chain1-R_KK-phi1020'))).toBe(true)
    expect(out.objects.some((o) => o.path.startsWith('cosbeta'))).toBe(true)
    expect(out.objects.every((o) => o.bins > 0)).toBe(true)
  })

  it('read returns per-bin values for data and a wave spectrum', async () => {
    const defs = collectDefinitions()
    const tool = defs.find((d) => d.name === 'auto_pwa_root_view')!
    const out = (await tool.execute!(
      { rootPath: ROOT_FILE, mode: 'read', objects: ['mass0_Kp_Km/hdata', 'mass0_Kp_Km/h_chain1-R_KK-phi1020'] } as never,
      { agent: { sessionId: 'sess-1' } } as never,
    )) as { ok: boolean; histograms: { path: string; bins: number; integral: number; values: number[]; errors: number[] }[] }
    expect(out.ok).toBe(true)
    expect(out.histograms).toHaveLength(2)
    for (const h of out.histograms) {
      expect(h.bins).toBe(100)
      expect(h.values).toHaveLength(100)
      expect(h.errors).toHaveLength(100)
      expect(h.integral).toBeGreaterThan(0)
    }
    const data = out.histograms.find((h) => h.path.endsWith('/hdata'))!
    const phi = out.histograms.find((h) => h.path.includes('phi1020'))!
    // The phi(1020) wave contributes a fraction of the total data spectrum.
    expect(phi.integral).toBeLessThan(data.integral)
    expect(phi.integral).toBeGreaterThan(data.integral * 0.01)
  })
})

// ---------------------------------------------------------------------------
// auto_pwa_wave_view: python pure-logic tests (uproot only, no GPU needed)
// ---------------------------------------------------------------------------

const HAS_UPROOT2 = HAS_UPROOT
const WAVE_CFG = '/home/whitewash/pwa/Jpsi2KKeta/solve3/config.yml'
const WAVE_ROOT = '/home/whitewash/pwa/Jpsi2KKeta/solve3/results/weight_best.root'

describe.skipIf(!HAS_UPROOT2 || !existsSync(WAVE_ROOT) || !existsSync(WAVE_CFG))('auto_pwa_wave_view pure logic', () => {
  const runPy = (code: string) => {
    const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', env: { ...process.env } })
    if (r.status !== 0) throw new Error(r.stderr || r.stdout)
    return r.stdout.trim()
  }

  it('rebuilds writeResult params from fit.json in aifit layout', () => {
    const out = runPy(`
import sys; sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'scripts'))})
import wave_view as wv
fit = {'fit': {'best': {'params': [
  {'kind': 'coupling', 'real': 1.0, 'imag': 0.0},
  {'kind': 'coupling', 'real': 0.5, 'imag': -0.3},
  {'kind': 'resonance', 'value': 1.0195},
  {'kind': 'resonance', 'value': 1.275},
]}}}
p = wv.rebuild_params_from_fit_json(fit)
assert list(p) == [1.0, 0.5, 0.0, -0.3, 1.0195, 1.275], list(p)
print('ok')
`)
    expect(out).toBe('ok')
  })

  it('maps wave names to partial indices from the real weight_best.root', () => {
    const out = runPy(`
import sys; sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'scripts'))})
import wave_view as wv
names = wv.partial_names_from_root(${JSON.stringify(WAVE_ROOT)})
assert len(names) > 20, len(names)
idx, missing = wv.resolve_wave_indices(names, ['chain1-R_KK-phi1020', 'chain1-R_KK-X1750'])
assert len(idx) == 2 and not missing, (idx, missing)
idx2, miss2 = wv.resolve_wave_indices(names, ['does-not-exist'])
assert not idx2 and miss2 == ['does-not-exist']
print('ok', len(names))
`)
    expect(out.startsWith('ok')).toBe(true)
  })

  it('parses decay steps from the real solve3 config (decay-list style)', () => {
    const out = runPy(`
import sys; sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'scripts'))})
import wave_view as wv
steps = wv.chain_steps_from_config(open(${JSON.stringify(WAVE_CFG)}).read())
assert steps.get('R_KK') == ['Kp', 'Km'], steps.get('R_KK')
assert steps.get('R_Kpeta') == ['Kp', 'eta'], steps.get('R_Kpeta')
assert wv.wave_intermediate_from_name('chain1-R_KK-phi1020') == 'R_KK'
print('ok')
`)
    expect(out).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// evaluate.py Plot meta parsing (new expr format + legacy mass/cosbeta)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_UPROOT || !existsSync(WAVE_CFG))('evaluate.py Plot meta parsing', () => {
  const runPy = (code: string) => {
    const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', env: { ...process.env } })
    if (r.status !== 0) throw new Error(r.stderr || r.stdout)
    return r.stdout.trim()
  }

  it('parses the legacy mass/cosbeta format from the real solve3 config', () => {
    const out = runPy(`
import sys; sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'scripts'))})
import auto_pwa_evaluate as ev
meta = ev.parse_plot_meta(open(${JSON.stringify(WAVE_CFG)}).read())
m = meta.get('mass0_Kp_Km')
assert m and m['kind'] == 'mass' and m['intermediate'] == 'R_KK', m
c = meta.get('cosbeta0_Jpsi_KpKm_Kp')
assert c and c['kind'] == 'cosbeta' and c['intermediate'] == 'R_KK', c
assert c['display'], c
print('ok', len(meta))
`)
    expect(out.startsWith('ok')).toBe(true)
  })

  it('parses the new expr/expression format with custom names', () => {
    const cfg = `
Particles:
  Kp: {J: 0, P: -1, mass: 0.4937}
  Km: {J: 0, P: -1, mass: 0.4937}
  eta: {J: 0, P: -1, mass: 0.5478}
  Jpsi: {J: 1, P: -1, mass: 3.0969}
DecayChains:
  chain1:
    decay:
      - Jpsi: [eta, R_KK]
      - Jpsi: [Kp, R_Kpeta]
      - R_KK: [Kp, Km]
      - R_Kpeta: [Kp, eta]
    R_KK:
      - [J: 1, P: -1]: [phi1020]
Plot:
  - expr: "M([Kp,Km])"
    bins: [60]
    ranges: [[1.0, 2.6]]
    name: m_kk
  - expression: ["M([Kp,Km])", "CosAngle([Kp], [Kp,Km])"]
    bins: [60, 50]
    ranges: [[1.0, 2.6], [-1, 1]]
    name: m_kk_cos
  - expr: "M([Kp,eta])"
    bins: [60]
    ranges: [[1.0, 2.6]]
`
    const out = runPy(`
import sys; sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'scripts'))})
import auto_pwa_evaluate as ev
meta = ev.parse_plot_meta(${JSON.stringify(cfg)})
m = meta.get('m_kk')
assert m and m['kind'] == 'mass' and m['intermediate'] == 'R_KK', m
c = meta.get('m_kk_cos')
assert c and c['kind'] == '2d', c
# unnamed third item -> obs2, intermediate R_Kpeta
u = meta.get('obs2')
assert u and u['intermediate'] == 'R_Kpeta', u
print('ok', len(meta))
`)
    expect(out).toBe('ok 3')
  })
})

// ---------------------------------------------------------------------------
// evaluate.py moments: real weight_best.root cosbeta distributions
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_UPROOT || !existsSync(WAVE_ROOT) || !existsSync(WAVE_CFG))('evaluate.py Legendre moments', () => {
  it('computes moments for cosbeta distributions in a real fit output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-mom-'))
    try {
      const r = spawnSync(PY, [
        join(process.cwd(), 'scripts/auto_pwa_evaluate.py'),
        WAVE_ROOT,
        join(dir, 'eval'),
        WAVE_CFG,
      ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env } })
      expect(r.status).toBe(0)
      const ev = JSON.parse(readFileSyncSync(join(dir, 'eval', 'evaluate.json'), 'utf8'))
      const dists = ev.distributions as Record<string, { moments?: Record<string, { data?: number; fit?: number; delta?: number }> }>
      const cos = Object.entries(dists).find(([, d]) => d.moments !== undefined)
      expect(cos).toBeDefined()
      const m = cos![1].moments!
      expect(Object.keys(m)).toContain('2')
      for (const L of ['2', '4', '6']) {
        expect(typeof m[L]!.data).toBe('number')
        expect(typeof m[L]!.fit).toBe('number')
        expect(Math.abs(m[L]!.data!)).toBeLessThan(1)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
