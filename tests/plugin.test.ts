import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync as readFileSyncSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin/auto-pwa.js'
import { apply as applyGuard } from '../plugin/pwa-guard.js'

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
  it('registers the fourteen auto_pwa_* tools', () => {
    const defs = collectDefinitions()
    expect(defs.map((d) => d.name)).toEqual([
      'auto_pwa_lookup',
      'auto_pwa_decay_check',
      'auto_pwa_jpc_check',
      'auto_pwa_config_view',
      'auto_pwa_validate_add',
      'auto_pwa_edit_config',
      'auto_pwa_round',
      'auto_pwa_iter_start',
      'auto_pwa_note',
      'auto_pwa_history',
      'auto_pwa_iterate',
      'auto_pwa_evaluate',
      'auto_pwa_run_fit',
      'auto_pwa_fit_status',
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

describe('auto-pwa harness wiring (ctx.jobs / guard / token-meter)', () => {
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
      // Feed two assistant/message usage events, then note with includeTokens.
      h.eventHandlers['session/event']!({ id: 'sess-1' }, { type: 'assistant/message', usage: { inputTokens: 1000, outputTokens: 200 } })
      h.eventHandlers['session/event']!({ id: 'sess-1' }, { type: 'assistant/message', usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 30 } })
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
