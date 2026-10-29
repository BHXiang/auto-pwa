import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync as readFileSyncSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply, __resetActiveAnalysisRoot } from '../plugin/auto-pwa.js'
import { apply as applyGuard } from '../plugin/pwa-guard.js'
import { parseConfig } from '../src/config-edit.js'
import { IterationLog } from '../src/iteration-log.js'
import { dbIntegrity } from '../src/db.js'
import { defaultFitRunnerConfig } from '../src/fit-runner.js'
import type { FitOwner } from '../plugin/pwa-fit.js'

/** Minimal gate-clean config (single chain, phi(1020) in R_KK [1-]) used by the
 * harness-wiring tests: passes structure, cross-reference, two-vertex J^PC and
 * threshold, so only the run-time gate's outcome is under test. */
const GATE_CONFIG = `Particles:
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

Data:
  order: [Kp, Km, eta]
  data: [dat, "/pwa/data.dat"]

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
    R_KK: [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
`

/** Minimal ctx mock: collects tool definitions instead of registering them. */
function collectDefinitions() {
  const definitions: {
    name: string
    description?: string
    output?: { schema?: unknown }
    execute?: (args: never, exec: never) => Promise<unknown>
  }[] = []
  const ctx = {
    tools: {
      register: (def: {
        name: string
        description?: string
        output?: { schema?: unknown }
        execute?: (args: never, exec: never) => Promise<unknown>
      }) => {
        definitions.push(def)
      },
    },
  }
  apply(ctx as never)
  return definitions
}

/**
 * Validate a value against a tool's declared output schema (the subset the
 * plugins use: type / properties / items / additionalProperties / required).
 * The harness rejects a tool result whose shape violates its own schema, so
 * this catches "declares additionalProperties:false but returns extra fields"
 * bugs in CI instead of at runtime.
 */
function assertSchema(value: unknown, schema: unknown, path = '$'): void {
  if (schema === null || typeof schema !== 'object') return
  const s = schema as {
    type?: string
    properties?: Record<string, unknown>
    items?: unknown
    additionalProperties?: boolean
    required?: boolean | string[]
  }
  if (s.type === 'object') {
    expect(typeof value, path).toBe('object')
    const obj = value as Record<string, unknown>
    const props = s.properties ?? {}
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (props[k] === undefined) throw new Error(`${path}.${k} is not a declared property (additionalProperties:false)`)
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      const subSchema = sub as { required?: boolean }
      const required = subSchema.required === true || (Array.isArray(s.required) && s.required.includes(k))
      if (required && obj[k] === undefined) throw new Error(`${path}.${k} is required`)
      if (obj[k] !== undefined) assertSchema(obj[k], sub, `${path}.${k}`)
    }
  } else if (s.type === 'array') {
    expect(Array.isArray(value), path).toBe(true)
    ;(value as unknown[]).forEach((v, i) => assertSchema(v, s.items, `${path}[${i}]`))
  } else if (s.type === 'string') {
    expect(typeof value, path).toBe('string')
  } else if (s.type === 'number' || s.type === 'integer') {
    expect(typeof value, path).toBe('number')
  } else if (s.type === 'boolean') {
    expect(typeof value, path).toBe('boolean')
  }
}

/**
 * The harness snapshots every tool result as lossless JSON: an own property
 * whose value is undefined (or an undefined array element) makes the whole
 * result invalid, even though the declared schema allows the key to be
 * absent. Assert the executed value carries no such hole.
 */
function assertNoUndefined(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (v === undefined) throw new Error(`${path}[${i}] is undefined`)
      assertNoUndefined(v, `${path}[${i}]`)
    })
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) throw new Error(`${path}.${k} is undefined`)
    assertNoUndefined(v, `${path}.${k}`)
  }
}

describe('auto-pwa plugin', () => {
  it('registers the auto_pwa_* tools', () => {
    const defs = collectDefinitions()
    expect(defs.map((d) => d.name)).toEqual([
      'auto_pwa_lookup',
      'auto_pwa_decay_check',
      'auto_pwa_jpc_check',
      'auto_pwa_init_config',
      'auto_pwa_config_view',
      'auto_pwa_validate_config',
      'auto_pwa_suggest',
      'auto_pwa_validate_add',
      'auto_pwa_trans_suggest',
      'auto_pwa_edit_config',
      'auto_pwa_remove_resonance',
      'auto_pwa_iter_start',
      'auto_pwa_note',
      'auto_pwa_git_log',
      'auto_pwa_history',
      'auto_pwa_evaluate',
      'auto_pwa_diagnose',
      'auto_pwa_root_view',
      'auto_pwa_wave_view',
      'auto_pwa_run_fit',
      'auto_pwa_fit_status',
      'auto_pwa_try_candidates',
      'auto_pwa_compare',
      'auto_pwa_loop_next',
    ])
  })

  it('documents every tool for the model', () => {
    for (const d of collectDefinitions()) {
      expect(d.description?.length ?? 0).toBeGreaterThan(20)
    }
  })
})

describe('auto-pwa plugin tools (smoke)', () => {
  it('auto_pwa_lookup returns lossless JSON with measurement history', async () => {
    const defs = collectDefinitions()
    const tool = defs.find((d) => d.name === 'auto_pwa_lookup')!
    const out = (await tool.execute!({ name: 'phi(1020)' } as never, {} as never)) as {
      total: number
      hits: { id: string; measurements: Record<string, unknown>[] }[]
    }
    expect(out.total).toBeGreaterThan(0)
    const phi = out.hits.find((h) => h.id === 'phi(1020)')!
    expect(phi.measurements.length).toBeGreaterThan(0)
    // No undefined values anywhere (the tool framework rejects them).
    const bad = phi.measurements.filter((m) => Object.values(m).some((v) => v === undefined))
    expect(bad).toHaveLength(0)
  })

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

  const execute = async (name: string, args: never, exec?: { agent?: { id?: string; sessionId?: string }; rootCallId?: string }) => {
    const def = collectDefinitions().find((d) => d.name === name)!
    expect(def.execute).toBeDefined()
    const out = await def.execute!(args, exec as never)
    // Same gate the harness applies to every tool result: a value that violates
    // its own declared schema (extra keys under additionalProperties:false, an
    // undefined hole, a wrong type) turns the call into an error at runtime.
    assertSchema(out, def.output?.schema)
    assertNoUndefined(out)
    return out
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

  // A radiative 4-body chain: the top intermediate has a production vertex,
  // the nested ones do not. Their missing production must be an ABSENT key,
  // not `production: undefined` (which the harness rejects as lossy JSON).
  const RADIATIVE_CONFIG = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  gamma:
    J: 1
    P: -1
    mass: 0
  Kp:
    J: 0
    P: -1
    mass: 0.4937
  Km:
    J: 0
    P: -1
    mass: 0.4937
  pi01:
    J: 0
    P: -1
    mass: 0.135
  pi02:
    J: 0
    P: -1
    mass: 0.135

DecayChains:
  decay1:
    Jpsi:
      - [R_KKpipi, gamma]
    R_KKpipi:
      - [R_KK, R_pipi]
    R_KK: [Kp, Km]
    R_pipi: [pi01, pi02]
    intermediates:
      R_KKpipi:
        - [J: 0, P: 1]: [f0_1710]
        - [J: 0, P: -1]: [etac]
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_pipi:
        - [J: 0, P: 1]: [f0_980]

Constraints:
  identical:
    - [pi01, pi02]
  maxL: 4

Resonances:
  f0_1710:
    J: 0
    P: 1
    model: BWR
    parameters: [1.723, 0.149]
  etac:
    J: 0
    P: -1
    model: BWR
    parameters: [2.9839, 0.032]
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
  f0_980:
    J: 0
    P: 1
    model: BWR
    parameters: [0.99, 0.06]
`

  function withConfigText(text: string, fn: (configPath: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-plugin-'))
    const configPath = join(dir, 'config.yml')
    writeFileSync(configPath, text)
    return fn(configPath).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  it('auto_pwa_jpc_check candidate list carries on-shell margins, decay flags and a threshold filter', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_jpc_check', { configPath } as never)) as {
        intermediates: {
          name: string
          allowed: { jpc: string; candidates: { id: string; mass: number; thresholdMargin: number | null; decaysTo: boolean }[] }[]
          filteredAboveThreshold?: number
        }[]
      }
      const rkk = out.intermediates.find((i) => i.name === 'R_KK')!
      const oneMinus = rkk.allowed.find((a) => a.jpc === '1--')!
      const phi = oneMinus.candidates.find((c) => c.id === 'phi(1020)')!
      // PDG lists phi -> K+ K-, and the config daughters are Kp/Km (same species).
      expect(phi.decaysTo).toBe(true)
      // on-shell margin m_threshold - m_phi = (m_Jpsi - m_eta) - m_phi
      expect(phi.thresholdMargin).toBeCloseTo(3.0969 - 0.5478 - 1.0195, 3)
      // psi(3770) (1--) is above the 2.549 GeV threshold -> filtered out
      expect(oneMinus.candidates.some((c) => c.id === 'psi(3770)')).toBe(false)
      expect(rkk.filteredAboveThreshold ?? 0).toBeGreaterThan(0)
      // every candidate carries the new fields (lossless JSON, no undefined)
      for (const a of rkk.allowed) {
        for (const c of a.candidates) {
          expect(typeof c.decaysTo).toBe('boolean')
          expect(c.thresholdMargin === null || typeof c.thresholdMargin === 'number').toBe(true)
        }
      }
      assertNoUndefined(out)
      // The model-facing render must carry the new legend + margins.
      const def = collectDefinitions().find((d) => d.name === 'auto_pwa_jpc_check')!
      const rendered = (def.output as { render: (a: unknown, v: unknown) => { text: string }[] }).render({}, out)
      expect(rendered[0]!.text).toContain('候选标记')
      expect(rendered[0]!.text).toContain('phi(1020)')
    })
  })

  it('auto_pwa_jpc_check registers production through a nested cascade (A -> R1 + R2)', async () => {
    // R_KKpipi -> R_KK + R_pipi is the FOUR-body shape: BOTH daughters are
    // intermediates. It used to be skipped ("2-body production only"), which
    // left those intermediates with no production row at all — hence no
    // threshold margin and no C check for a topology that is the norm in 4/5-body
    // analyses.
    await withConfigText(RADIATIVE_CONFIG, async (configPath) => {
      const out = await execute('auto_pwa_jpc_check', { configPath } as never)
      assertNoUndefined(out)
      const body = (out as { intermediates: { name: string; production?: { mother?: string; daughter?: string } }[] })
        .intermediates
      const top = body.find((i) => i.name === 'R_KKpipi')!
      expect(top.production).toBeDefined()
      const nested = body.find((i) => i.name === 'R_KK')!
      expect(nested.production, '嵌套级联的产生行不该再缺失').toBeDefined()
      expect(nested.production!.mother).toBe('R_KKpipi')
      expect(nested.production!.daughter).toBe('R_pipi')
      // 另一侧同样登记，且互为姊妹
      const sibling = body.find((i) => i.name === 'R_pipi')!
      expect(sibling.production!.daughter).toBe('R_KK')
    })
  })

  it('auto_pwa_jpc_check still omits production for an intermediate that is never produced', async () => {
    // Declared under `intermediates:` and decaying, but no step produces it →
    // there is genuinely no production vertex, so the key must stay absent.
    const orphaned = RADIATIVE_CONFIG.replace('      - [R_KK, R_pipi]\n', '')
    await withConfigText(orphaned, async (configPath) => {
      const out = (await execute('auto_pwa_jpc_check', { configPath } as never)) as {
        intermediates: { name: string; production?: unknown }[]
      }
      assertNoUndefined(out)
      for (const name of ['R_KK', 'R_pipi']) {
        const nested = out.intermediates.find((i) => i.name === name)!
        expect(nested.production, `${name} 没有被任何步产生`).toBeUndefined()
        expect(Object.keys(nested)).not.toContain('production')
      }
    })
  })

  it('auto_pwa_jpc_check enforces C(X) = +1 at a J/psi -> gamma + X vertex', async () => {
    await withConfigText(RADIATIVE_CONFIG, async (configPath) => {
      const out = (await execute('auto_pwa_jpc_check', { configPath } as never)) as {
        intermediates: { name: string; production?: { cRequired: number | null } }[]
      }
      // C(J/psi) = -1 and C(gamma) = -1, so the recoil system must carry C = +1.
      expect(out.intermediates.find((i) => i.name === 'R_KKpipi')!.production!.cRequired).toBe(1)
    })
  })

  it('auto_pwa_decay_check returns lossless JSON when decayTo is omitted', async () => {
    const out = await execute('auto_pwa_decay_check', {
      mother: { j: 1, p: -1, mass: 3.0969 },
      daughter: { j: 1, p: -1, mass: 0 },
      maxL: 4,
    } as never)
    assertNoUndefined(out)
    const candidates = (out as { candidates: { resonances: Record<string, unknown>[] }[] }).candidates
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.some((c) => c.resonances.length > 0)).toBe(true)
  })

  it('auto_pwa_config_view: constraints parsed, validation clean, PDG cross-refs present', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_config_view', { configPath } as never)) as {
        particles: unknown[]
        chains: unknown[]
        resonances: { name: string; pdg: string | null; jpcMatch: boolean; thresholdMargin: { chain: string; margin: number } | null }[]
        constraints: { maxL?: number; trans?: unknown[]; identical?: unknown[] }
        validation: { ok: boolean; errors: unknown[]; warnings: unknown[] }
      }
      expect(out.particles.length).toBe(4)
      expect(out.constraints.maxL).toBe(3)
      expect(out.constraints.trans).toHaveLength(1)
      expect(out.validation.ok).toBe(true)
      const phi = out.resonances.find((r) => r.name === 'phi1020')!
      expect(phi.pdg).toContain('phi(1020)')
      expect(phi.jpcMatch).toBe(true)
      expect(phi.thresholdMargin?.chain).toBe('decay1')
    })
  })

  it('auto_pwa_config_view output conforms to its declared schema when validation fails', async () => {
    // A Constraints key typo (`maxl`) is a key-whitelist error: the tool result
    // carries validation.errors items whose {code,message} fields MUST be
    // declared in the output schema (the harness rejects undeclared fields).
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-plugin-'))
    const configPath = join(dir, 'config.yml')
    writeFileSync(configPath, CONFIG.replace('maxL: 3', 'maxl: 3'))
    try {
      const def = collectDefinitions().find((d) => d.name === 'auto_pwa_config_view')!
      const out = (await def.execute!({ configPath } as never, {} as never)) as {
        validation: { ok: boolean; errors: { code: string; message: string }[] }
      }
      expect(out.validation.ok).toBe(false)
      expect(out.validation.errors.length).toBeGreaterThan(0)
      expect(out.validation.errors[0]).toHaveProperty('code')
      expect(out.validation.errors[0]).toHaveProperty('message')
      assertSchema(out, def.output?.schema)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_config_view lists first-level topology coverage for a 4-body final state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-topo-'))
    const configPath = join(dir, 'config.yml')
    writeFileSync(
      configPath,
      `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  etap: {J: 0, P: -1, mass: 0.957784, pdgid: 331}
  pip: {J: 0, P: -1, mass: 0.13957, pdgid: 211}
  pim: {J: 0, P: -1, mass: 0.13957, pdgid: -211}
  pi0: {J: 0, P: -1, mass: 0.134977, pdgid: 111}
Data:
  order: [etap, pip, pim, pi0]
  data: [dat, ./data.dat]
DecayChains:
  decay1:
    Jpsi: [[etap, R_3pi]]
    R_3pi: [[pi0, R_pipi]]
    R_pipi: [pip, pim]
    intermediates:
      R_3pi:
        - [J: 1, P: -1]: []
      R_pipi:
        - [J: 1, P: -1]: []
  decay2:
    Jpsi: [[pi0, R_etaprho]]
    R_etaprho: [etap, R_pipi2]
    R_pipi2: [pip, pim]
    intermediates:
      R_etaprho:
        - [J: 1, P: -1]: []
      R_pipi2:
        - [J: 1, P: -1]: []
Resonances: {}
`,
    )
    try {
      const def = collectDefinitions().find((d) => d.name === 'auto_pwa_config_view')!
      const out = (await def.execute!({ configPath } as never, {} as never)) as {
        topologyCoverage?: { total: number; present: number; topologies: { kind: string; present: boolean }[] }
      }
      expect(out.topologyCoverage?.total).toBe(7)
      expect(out.topologyCoverage?.present).toBe(2)
      expect(out.topologyCoverage?.topologies.filter((t) => t.kind === '2+2')).toHaveLength(3)
      expect(out.topologyCoverage?.topologies.filter((t) => t.present).map((t) => t.kind)).toEqual(['1+3', '1+3'])
      assertSchema(out, def.output?.schema)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_remove_resonance detaches a name, keeps the group, drops the definition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-plugin-'))
    const configPath = join(dir, 'config.yml')
    writeFileSync(configPath, CONFIG)
    try {
      const def = collectDefinitions().find((d) => d.name === 'auto_pwa_remove_resonance')!
      const out = (await def.execute!({ configPath, removals: [{ name: 'K2_1430' }] } as never, {} as never)) as {
        ok: boolean
        written: boolean
        changed: string[]
        dropped: string[]
      }
      expect(out.ok).toBe(true)
      expect(out.written).toBe(true)
      expect(out.dropped).toEqual(['K2_1430'])
      assertSchema(out, def.output?.schema)
      const after = parseConfig(readFileSyncSync(configPath, 'utf8'))
      expect(after.resonances.K2_1430).toBeUndefined()
      // The [2+] group stays (empty) so Constraints.trans indices are intact.
      expect(after.decayChains.decay1?.intermediates.R_Keta?.groups).toHaveLength(2)
      expect(after.decayChains.decay1?.intermediates.R_Keta?.groups[1]?.names).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PDG 表完整性：内容与 manifest 一致（手改 pdg.json 会让这条测试红）', () => {
    // data/pdg.json 是校验门的信任锚；改了内容却忘了 `npm run check:pdg -- --write`
    // 会让"PDG 依据"判定不可信——所以这里直接钉住。
    expect(dbIntegrity.ok).toBe(true)
    expect(dbIntegrity.expected).toBe(dbIntegrity.actual)
  })

  it('本地登记（非 PDG）的态：给 local-not-pdg warning，而不是 not-on-pdg error', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: {
          name: 'K1_2100',
          chain: 'R_KK',
          jpGroup: { j: 1, p: -1 },
          model: 'BWR',
          parameters: [2.1, 0.3],
        },
      } as never)) as { errors: { code: string }[]; warnings: { code: string }[] }
      // 关键：名字在表里（seed）≠ 有 PDG 依据 —— 不能再报 not-on-pdg，也不能静默通过
      expect(out.errors.map((e) => e.code)).not.toContain('not-on-pdg')
      expect(out.warnings.map((w) => w.code)).toContain('local-not-pdg')
    })
  })

  it('auto_pwa_lookup 的渲染标注 [PDG] / [本地] 出处', async () => {
    const h = harnessCtx()
    const def = h.definitions.find((d) => d.name === 'auto_pwa_lookup') as unknown as {
      execute: (a: unknown, e: unknown) => Promise<unknown>
      output?: { render?: (a: unknown, v: unknown) => unknown }
    }
    const pdgHit = await def.execute({ name: 'f2_1270' }, {})
    const localHit = await def.execute({ name: 'K1_2100' }, {})
    const rt = JSON.stringify(def.output?.render?.({ name: 'x' }, pdgHit) ?? '')
    const rl = JSON.stringify(def.output?.render?.({ name: 'x' }, localHit) ?? '')
    expect(rt).toContain('[PDG]')
    expect(rl).toContain('[本地]')
  })

  it('P1：pdg.json 里没有非 PDG 条目（本地态一律在 data/local-states.json）', async () => {
    const { readFileSync } = await import('node:fs')
    const url = new URL('../data/pdg.json', import.meta.url)
    const db = JSON.parse(readFileSync(url, 'utf8')) as { resonances: { id: string; status: string }[] }
    const nonPdg = db.resonances.filter((r) => r.status !== 'pdg').map((r) => r.id)
    expect(nonPdg).toEqual([])
  })

  it('P1：<analysis>/local-states.json 让"本分析自己的态"通过（只 warning）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pwa-localstates-'))
    try {
      // 一个 PDG 里完全不存在的名字，只在本分析的本地登记表里
      writeFileSync(
        join(root, 'local-states.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          states: [{ id: 'Z(9999)', aliases: ['Z9999'], jp: { j: 1, p: -1 }, mass: 9.999, width: 0.1, reason: '测试用本地态' }],
        }),
      )
      mkdirSync(join(root, 'iterations'), { recursive: true })
      const configPath = join(root, 'config.yml')
      writeFileSync(configPath, GATE_CONFIG)
      const ok = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: { name: 'Z9999', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [9.999, 0.1] },
      } as never)) as { errors: { code: string }[]; warnings: { code: string }[] }
      expect(ok.warnings.map((w) => w.code)).toContain('local-not-pdg')
      expect(ok.errors.map((e) => e.code)).not.toContain('not-on-pdg')

      // 换个目录（没有本地登记）→ 同样的名字必须被拒绝
      const other = mkdtempSync(join(tmpdir(), 'pwa-nolocal-'))
      const otherConfig = join(other, 'config.yml')
      writeFileSync(otherConfig, GATE_CONFIG)
      const bad = (await execute('auto_pwa_validate_add', {
        configPath: otherConfig,
        proposal: { name: 'Z9999', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [9.999, 0.1] },
      } as never)) as { errors: { code: string }[] }
      expect(bad.errors.map((e) => e.code)).toContain('not-on-pdg')
      rmSync(other, { recursive: true, force: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('线形惯例只提醒：偏离给 warning、不产生 error', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: { name: 'f0_980', chain: 'R_KK', jpGroup: { j: 0, p: 1 }, model: 'BWR', parameters: [0.98, 0.07] },
      } as never)) as { errors: { code: string }[]; warnings: { code: string }[] }
      expect(out.warnings.map((w) => w.code)).toContain('model-deviates-from-convention')
      // 关键：**永不因此报错**（用户明确要求"只提醒、不强制"）
      expect(out.errors.map((e) => e.code)).not.toContain('model-deviates-from-convention')
    })
  })

  it('auto_pwa_lookup 给出 suggestedModel（f0(980) → Flatte）', async () => {
    const h = harnessCtx()
    const def = h.definitions.find((d) => d.name === 'auto_pwa_lookup') as unknown as {
      execute: (a: unknown, e: unknown) => Promise<{ hits: { id: string; suggestedModel?: string; modelHint?: string }[] }>
    }
    const out = await def.execute({ name: 'f0_980' }, {})
    expect(out.hits[0]!.suggestedModel).toBe('Flatte')
    expect(out.hits[0]!.modelHint).toContain('阈值')
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

  it('auto_pwa_validate_add accepts a half-integer baryon (N(1520) 3/2-)', async () => {
    // chic0(0+) -> N* + pbar can only reach half-integer J_R; N(1520) 3/2- is
    // realizable with L=2. Before the half-integer fix the production-vertex
    // enumeration was empty, so every baryon proposal failed the J^P gate.
    const BARYON = `Particles:
  psip: {J: 1, P: -1, mass: 3.686}
  gamma: {J: 1, P: -1, mass: 0.0}
  eta: {J: 0, P: -1, mass: 0.547862}
  p: {J: 0.5, P: 1, mass: 0.938272}
  pbar: {J: 0.5, P: -1, mass: 0.938272}
DecayChains:
  chain1:
    psip:
      - [gamma, R_chicj, {ls: [1, 1]}]
    R_chicj:
      - [R_peta, pbar]
    R_peta:
      - [p, eta]
    intermediates:
      R_chicj:
        - [J: 0, P: 1]: [chic0]
      R_peta:
        - [J: 1.5, P: 1]: []
Resonances:
  chic0:
    J: 0
    P: 1
    model: ONE
    parameters: [3.41471]
`
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-plugin-'))
    const configPath = join(dir, 'config.yml')
    writeFileSync(configPath, BARYON)
    try {
      const out = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: {
          name: 'N1520',
          chain: 'R_peta',
          jpGroup: { j: 1.5, p: -1 },
          model: 'BW',
          parameters: [1.515, 0.11],
          free: [0],
          freeRange: [[1.45, 1.6]],
        },
        decayTo: ['p', 'eta'],
      } as never)) as { ok: boolean; errors: { code: string }[]; warnings: { code: string }[] }
      expect(out.errors).toEqual([])
      expect(out.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_validate_add: unknown model is a warning, not a block (special-formula escape hatch)', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: {
          name: 'phi1020',
          chain: 'R_KK',
          jpGroup: { j: 1, p: -1 },
          model: 'SomeNewCtpwaModel',
          parameters: [1.02, 0.005],
        },
      } as never)) as { ok: boolean; errors: { code: string }[]; warnings: { code: string }[] }
      // Attaching an already-defined state is legal; the only new signal is the
      // unknown-model warning (PDG/arity checks deferred to ctpwa).
      expect(out.warnings.map((w) => w.code)).toContain('unknown-model')
    })
  })

  it('auto_pwa_validate_add: Interp with an options payload passes the structure gate', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_validate_add', {
        configPath,
        proposal: {
          name: 'K1_interp_new',
          chain: 'R_Keta',
          jpGroup: { j: 1, p: -1 },
          model: 'Interp',
          parameters: [],
          options: { file: '/tmp/interp_Keta.dat', method: 'linear' },
        },
      } as never)) as { ok: boolean; errors: { code: string }[]; warnings: { code: string }[] }
      expect(out.errors).toEqual([])
      expect(out.warnings.map((w) => w.code)).not.toContain('interp-needs-file')
    })
  })

  it('auto_pwa_edit_config writes the options escape hatch into config.yml', async () => {
    await withConfig(async (configPath) => {
      const out = (await execute('auto_pwa_edit_config', {
        configPath,
        proposal: {
          name: 'K1_1410_interp',
          chain: 'R_Keta',
          jpGroup: { j: 1, p: -1 },
          model: 'Interp',
          parameters: [],
          options: { file: '/tmp/interp_Keta.dat', method: 'linear' },
          tex: ['K_{1}', '(1410)'],
          reference: 'BESIII 2024',
        },
      } as never)) as { ok: boolean; written: boolean; errors: { code: string; message: string }[] }
      expect(out.errors).toEqual([])
      expect(out.written).toBe(true)
      const cfg = parseConfig(readFileSyncSync(configPath, 'utf8'))
      expect(cfg.resonances.K1_1410_interp?.model).toBe('Interp')
      expect(cfg.resonances.K1_1410_interp?.options).toEqual({ file: '/tmp/interp_Keta.dat', method: 'linear' })
    })
  })

  it('auto_pwa_validate_config validates YAML text without any file or GPU', async () => {
    const out = (await execute('auto_pwa_validate_config', { yamlText: CONFIG } as never)) as {
      ok: boolean
      gateReport: string
      errors: { code: string }[]
      checks: { name: string; ran: boolean }[]
      ctpwa: { ran: boolean; error?: string }
      stats: { resonances: number }
    }
    expect(out.ok).toBe(true)
    expect(out.errors).toEqual([])
    expect(out.stats.resonances).toBe(3)
    expect(out.checks.map((c) => c.name)).toContain('two-vertex-jpc')
    // No file path -> the authoritative ctpwa layer cannot run; it says so.
    expect(out.ctpwa.ran).toBe(false)
    expect(out.ctpwa.error).toMatch(/yamlText/)
    expect(out.gateReport).toMatch(/通过/)
  })

  it('auto_pwa_validate_config rejects malformed YAML with an actionable error', async () => {
    const out = (await execute('auto_pwa_validate_config', { yamlText: 'Particles: [oops\n' } as never)) as {
      ok: boolean
      errors: { code: string }[]
    }
    expect(out.ok).toBe(false)
    expect(out.errors.map((e) => e.code)).toContain('yaml-parse')
  })

  it('auto_pwa_validate_config HARD-errors a C-violating wave in a written config', async () => {
    const text = CONFIG.replace('- [J: 1, P: -1]: [phi1020]', '- [J: 2, P: 1]: [phi1020]')
    const out = (await execute('auto_pwa_validate_config', { yamlText: text } as never)) as {
      ok: boolean
      errors: { code: string }[]
    }
    expect(out.ok).toBe(false)
    expect(out.errors.map((e) => e.code)).toContain('c-violation')
  })
})

// The authoritative layer needs the real ctpwa python env; skip elsewhere.
const HAS_CTPWA = spawnSync(defaultFitRunnerConfig().python, ['-c', 'import ctpwa'], { encoding: 'utf8' }).status === 0

describe.skipIf(!HAS_CTPWA)('auto_pwa_validate_config: deep (ctpwa) layer', () => {
  it('rejects a config that ctpwa parses but builds 0 amplitudes', async () => {
    // Flat production pair: ctpwa's compact detector requires a mode list, so
    // it silently builds no amplitude. DecayInfo.isValid() is still true.
    const dir = mkdtempSync(join(tmpdir(), 'auto-pwa-zeroamp-'))
    try {
      const p = join(dir, 'config.yml')
      writeFileSync(p, `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  eta: {J: 0, P: -1, mass: 0.5478, pdgid: 221}
  Kp: {J: 0, P: -1, mass: 0.4937, pdgid: 321}
  Km: {J: 0, P: -1, mass: 0.4937, pdgid: -321}
Data:
  order: [Kp, Km, eta]
  data: [dat, ./data.dat]
DecayChains:
  decay1:
    Jpsi: [eta, R_KK]
    R_KK: [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
Resonances:
  phi1020: {model: BWR, parameters: [1.0195, 0.0045]}
`)
      const tool = collectDefinitions().find((d) => d.name === 'auto_pwa_validate_config')!
      const out = (await tool.execute!({ configPath: p, deep: true } as never, {} as never)) as {
        ok: boolean
        errors: { code: string; message: string }[]
        ctpwa?: { ran: boolean; ok: boolean; nAmplitudes?: number; status?: string }
      }
      expect(out.ctpwa?.ran).toBe(true)
      expect(out.ctpwa?.nAmplitudes).toBe(0)
      expect(out.ok).toBe(false)
      expect(out.errors.map((e) => e.code)).toContain('ctpwa-config-invalid')
      expect(out.errors.map((e) => e.message).join(' ')).toMatch(/0 amplitudes|振幅数为 0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forwards ctpwa stderr and flags a trans constraint that does not change nFreeParams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-pwa-trans-noop-'))
    try {
      const p = join(dir, 'config.yml')
      writeFileSync(p, `Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  eta: {J: 0, P: -1, mass: 0.547862, pdgid: 221}
  Kp: {J: 0, P: -1, mass: 0.493677, pdgid: 321}
  Km: {J: 0, P: -1, mass: 0.493677, pdgid: -321}
Data:
  order: [Kp, Km, eta]
  data: [dat, ./data.dat]
DecayChains:
  decay1:
    Jpsi: [[eta, R_KK]]
    R_KK: [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
  decay2:
    Jpsi: [[eta, R_KK2]]
    R_KK2: [Kp, Km]
    intermediates:
      R_KK2:
        - [J: 1, P: -1]: [phi1020]
Constraints:
  trans:
    - [R_nonexistent_A, R_nonexistent_B]: 1
Resonances:
  phi1020: {model: BWR, parameters: [1.0195, 0.0045]}
`)
      const def = collectDefinitions().find((d) => d.name === 'auto_pwa_validate_config')!
      const out = (await def.execute!({ configPath: p, deep: true } as never, {} as never)) as {
        ok: boolean
        warnings: { code: string; message: string }[]
        ctpwa?: { constraintEffect?: { noOp: boolean; withConstraints: number; withoutConstraints: number }; stderr?: string[] }
      }
      // A no-op trans is a warning, not a hard error: names/semantics belong to
      // ctpwa; the effect is judged by nFreeParams and ΔNLL/records.
      expect(out.ok).toBe(true)
      expect(out.ctpwa?.constraintEffect?.noOp).toBe(true)
      expect(out.ctpwa?.constraintEffect?.withConstraints).toBe(out.ctpwa?.constraintEffect?.withoutConstraints)
      expect(out.warnings.map((w) => w.code)).toContain('constraints-no-effect')
      expect(out.warnings.map((w) => w.code)).toContain('ctpwa-stderr')
      expect(out.warnings.map((w) => w.message).join(' ')).toMatch(/R_nonexistent|未匹配|trans/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** ctx with a fake pwaFit service + guard recorder + session-event hook. */
function harnessCtx(options: { transport?: string; capabilities?: { gpu: boolean; slurm: boolean }; statusImpl?: (jobId: string, caller?: FitOwner) => unknown } = {}) {
  const definitions: {
    name: string
    output?: { schema?: unknown }
    execute?: (args: never, exec: never) => Promise<unknown>
  }[] = []
  const guards: ((exec: { name: string; arguments: unknown }) => string | undefined)[] = []
  const eventHandlers: Record<string, (...args: unknown[]) => void> = {}
  const submits: { request: { iterDir: string; jobScript?: string; target?: string; runScript?: string; timeoutMin?: number }; owner?: FitOwner }[] = []
  const statusCalls: { jobId: string; caller?: FitOwner }[] = []
  const pwaFit = {
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    submit: (request: { iterDir: string; jobScript?: string }, owner?: FitOwner) => {
      submits.push({ request, owner })
      return 'ctpwa-9'
    },
    status: (jobId: string, caller?: FitOwner) => {
      statusCalls.push({ jobId, caller })
      if (options.statusImpl !== undefined) return options.statusImpl(jobId, caller)
      return { jobId, iterDir: '/pwa/iter-001', state: 'done' as const, exitCode: 0, logTail: 'log tail' }
    },
    kill: () => 'requested' as const,
  }
  const contexts: { name: string; order: number; text: string | (() => string) }[] = []
  const ctx = {
    tools: {
      register: (def: { name: string; output?: { schema?: unknown }; execute?: (args: never, exec: never) => Promise<unknown> }) => definitions.push(def),
      guard: (g: (exec: { name: string; arguments: unknown }) => string | undefined) => {
        guards.push(g)
        return () => {}
      },
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers[event] = handler
    },
    systemPrompt: {
      context: (c: { name: string; order: number; text: string | (() => string) }) => {
        contexts.push(c)
        return () => {}
      },
    },
    pwaFit,
  }
  apply(ctx as never)
  applyGuard(ctx as never) // pwa-guard registers the config.yml write gate
  // 事件助手：摘要现在是**按 agent 注册**的（agent.id === session.id），
  // 分析目录也由 session/event 的工具调用流归档——测试照真实路径触发。
  const fireSessionEvent = (session: unknown, event: unknown) => eventHandlers['session/event']?.(session, event)
  const fireAgentCreated = (id: string) =>
    eventHandlers['agent/created']?.({
      agent: { id, ctx: { inject: (_deps: string[], cb: (scope: unknown) => void) => cb({ systemPrompt: ctx.systemPrompt }) } },
      source: 'startup',
    })
  return { definitions, guards, eventHandlers, submits, statusCalls, contexts, fireSessionEvent, fireAgentCreated }
}

const run = async (h: ReturnType<typeof harnessCtx>, name: string, args: unknown, exec: unknown) => {
  const def = h.definitions.find((d) => d.name === name)!
  const out = await def.execute!(args as never, exec as never)
  assertSchema(out, def.output?.schema)
  assertNoUndefined(out)
  return out
}

describe('auto-pwa harness wiring (ctx.jobs / guard / token-meter)', () => {
  it('guards init_config.yml only (config.yml is validated at fit time, not write time)', () => {
    const h = harnessCtx()
    expect(h.guards).toHaveLength(1)
    // config.yml writes are allowed now — the run gate + provenance replaced it.
    expect(h.guards[0]!({ name: 'write', arguments: { file_path: '/pwa/config.yml' } })).toBeUndefined()
    expect(h.guards[0]!({ name: 'write', arguments: { file_path: '/pwa/note.md' } })).toBeUndefined()
    expect(h.guards[0]!({ name: 'write', arguments: { file_path: '/pwa/init_config.yml' } })).toMatch(/auto_pwa_init_config/)
    // 校验门的信任锚不允许模型改写（否则"PDG 依据"会被自己的数据糊弄）
    for (const f of ['/pwa/data/pdg.json', '/pwa/data/pdg.manifest.json', '/pwa/data/lineshape-conventions.json']) {
      expect(h.guards[0]!({ name: 'write', arguments: { file_path: f } })).toMatch(/信任锚/)
      expect(h.guards[0]!({ name: 'edit', arguments: { file_path: f } })).toMatch(/信任锚/)
    }
    expect(h.guards[0]!({ name: 'bash', arguments: { command: 'echo "{}" > data/pdg.json' } })).toMatch(/信任锚/)
    expect(h.guards[0]!({ name: 'bash', arguments: { command: 'sed -i "s/x/y/" data/lineshape-conventions.json' } })).toMatch(/信任锚/)
    // Arrows in a prompt (`J/psi -> ...`) and fd redirects (`2>&1`) are not writes.
    expect(
      h.guards[0]!({
        name: 'bash',
        arguments: { command: 'echo "J/psi -> eta\' pi+ pi- pi0" && cat init_config.orig.yml 2>&1' },
      }),
    ).toBeUndefined()
    expect(
      h.guards[0]!({ name: 'bash', arguments: { command: 'printf "%s" x > init_config.yml' } }),
    ).toMatch(/auto_pwa_init_config/)
  })

  it('auto_pwa_run_fit runs the pre-fit gate first and refuses a missing config', async () => {
    const h = harnessCtx()
    const out = (await run(h, 'auto_pwa_run_fit', { iterDir: '/pwa/iter-001' }, { agent: { id: 'sess-1' } })) as {
      jobId: string
      state: string
      error?: string
      gate?: { ok: boolean; report: string }
    }
    // /pwa/iter-001 does not exist in the test sandbox: the gate refuses and
    // nothing is submitted (the old behavior submitted blindly).
    expect(h.submits).toEqual([])
    expect(out.state).toBe('failed')
    expect(out.gate?.ok).toBe(false)
    expect(out.error).toMatch(/跑前门禁拒绝/)
  })

  it('auto_pwa_run_fit submits through ctx.pwaFit with the calling agent as owner (gate passes)', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir }, { agent: { id: 'sess-1' } })) as {
        jobId: string
        gate?: { ok: boolean }
      }
      // The real DSH Agent exposes `id` (no `sessionId`). Forwarding the Agent
      // is what makes the job OWNED — an unowned job never wakes the agent.
      expect(h.submits).toEqual([{ request: { iterDir: dir, timeoutMin: 30, target: 'cpu' }, owner: { id: 'sess-1', agent: { id: 'sess-1' } } }])
      expect(out.jobId).toBe('ctpwa-9')
      expect(out.gate?.ok).toBe(true)
      // `run` already validated the whole result against the declared schema:
      // leaking the internal gate `severity` tag used to make every run_fit
      // return fail output validation *after* the job had been submitted — the
      // fit ran, but the agent never learned its jobId.
      // B1: the provenance record was written next to the results.
      const prov = JSON.parse(readFileSyncSync(join(dir, 'results', 'provenance.json'), 'utf8'))
      expect(prov.configMd5).toBeTruthy()
      expect(prov.resonances.map((r: { name: string }) => r.name)).toEqual(['phi1020'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit on a LOCAL machine ignores jobScript (no job.sh, no sbatch, target=cpu)', async () => {
    const h = harnessCtx() // no transport -> local
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-local-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, jobScript: 'auto' }, { agent: { id: 'sess-1' } })) as {
        jobScript?: string
        transport?: string
        target?: string
        gate?: { warnings?: { code: string; message?: string }[] }
      }
      // No slurm side effects on a machine without slurm.
      expect(existsSync(join(dir, 'job.sh'))).toBe(false)
      expect(existsSync(join(dir, '.slurm-jobs.json'))).toBe(false)
      // Local dispatch: cpu target, no jobScript forwarded.
      expect(h.submits[0]?.request).toEqual({ iterDir: dir, timeoutMin: 30, target: 'cpu' })
      expect(out.jobScript).toBeUndefined()
      expect(out.transport).toBe('local')
      expect(out.target).toBe('cpu')
      // ...but the ignored parameter is called out instead of vanishing silently.
      expect(out.gate?.warnings?.some((w) => (w.message ?? '').includes('jobScript 被忽略'))).toBe(true)
      // Provenance has no cluster fields.
      const prov = JSON.parse(readFileSyncSync(join(dir, 'results', 'provenance.json'), 'utf8'))
      expect(prov.jobScript).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit on the SLURM transport installs <iterDir>/job.sh and hands it to submit', async () => {
    const h = harnessCtx({ transport: 'slurm', capabilities: { gpu: false, slurm: true } })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-slurm-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, target: 'slurm', jobScript: 'auto' }, { agent: { id: 'sess-1' } })) as {
        jobId: string
        jobScript?: string
        jobScriptInstalled?: boolean
        transport?: string
      }
      // run_fit 交两样东西：config.yml（门禁）+ job.sh（sbatch）。
      const script = join(dir, 'job.sh')
      expect(existsSync(script)).toBe(true)
      expect(readFileSyncSync(script, 'utf8')).toContain('#SBATCH --gres=gpu:v100:1')
      expect(h.submits[0]?.request.jobScript).toBe(script)
      expect(out.jobScript).toBe(script)
      expect(out.jobScriptInstalled).toBe(true)
      expect(out.transport).toBe('slurm')
      // The script is recorded in provenance so a result can be traced to its job.
      const prov = JSON.parse(readFileSyncSync(join(dir, 'results', 'provenance.json'), 'utf8'))
      expect(prov.jobScript).toBe(script)
      expect(prov.jobScriptMd5).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit warns when the same iterDir already has a running cluster job', async () => {
    const h = harnessCtx({ transport: 'slurm', capabilities: { gpu: false, slurm: true } })
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-dup-'))
    const dir = join(root, 'iter-001')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      writeFileSync(
        join(root, '.slurm-jobs.json'),
        JSON.stringify({
          'slurm-1-x': { key: 'slurm-1-x', sbatchId: '570473', iterDir: dir, state: 'running', startedAt: Date.now() },
        }),
      )
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, target: 'slurm', jobScript: 'auto' }, {})) as {
        gate?: { warnings?: { code: string; message?: string }[] }
      }
      expect(out.gate?.warnings?.some((w) => w.code === 'duplicate-running-job')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit rejects a missing jobScript before submitting', async () => {
    const h = harnessCtx({ transport: 'slurm', capabilities: { gpu: false, slurm: true } })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-nojob-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, target: 'slurm', jobScript: 'nope.sh' }, {})) as {
        jobId: string
        state: string
        error?: string
      }
      expect(out.jobId).toBe('')
      expect(out.state).toBe('failed')
      expect(out.error).toContain('nope.sh')
      expect(h.submits).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit: auto on a GPU host resolves to gpu (no job.sh, no slurm)', async () => {
    const h = harnessCtx({ capabilities: { gpu: true, slurm: false } })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-gpu-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir }, {})) as { target?: string; jobScript?: string }
      expect(out.target).toBe('gpu')
      expect(out.jobScript).toBeUndefined()
      expect(existsSync(join(dir, 'job.sh'))).toBe(false)
      expect(h.submits[0]?.request.target).toBe('gpu')
      // No CPU timeout on the GPU path.
      expect(h.submits[0]?.request.timeoutMin).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit: auto with slurm but no GPU refuses to guess and says what to pass', async () => {
    const h = harnessCtx({ capabilities: { gpu: false, slurm: true } })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-amb-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir }, {})) as { jobId: string; error?: string }
      expect(out.jobId).toBe('')
      expect(out.error).toContain('target:"cpu"')
      expect(out.error).toContain('target:"slurm"')
      expect(h.submits).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit: target gpu without a GPU fails before the gate', async () => {
    const h = harnessCtx({ capabilities: { gpu: false, slurm: false } })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-nogpu-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, target: 'gpu' }, {})) as { error?: string }
      expect(out.error).toContain('没有可用 GPU')
      expect(h.submits).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit: runScript overrides target, is recorded in provenance, and still submits', async () => {
    const h = harnessCtx({ capabilities: { gpu: true, slurm: false } })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-script-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      writeFileSync(join(dir, 'run.sh'), '#!/bin/bash\npython fit.py "$@"\n')
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, target: 'slurm', runScript: 'run.sh' }, {})) as {
        target?: string
        runScript?: string
        gate?: { warnings?: { code: string; message?: string }[] }
      }
      expect(out.target).toBe('script')
      expect(out.runScript).toBe(join(dir, 'run.sh'))
      expect(h.submits[0]?.request.target).toBe('script')
      expect(h.submits[0]?.request.runScript).toBe(join(dir, 'run.sh'))
      // runScript wins over target=slurm: no cluster script installed.
      expect(existsSync(join(dir, 'job.sh'))).toBe(false)
      expect(out.gate?.warnings?.some((w) => (w.message ?? '').includes('runScript 优先'))).toBe(true)
      const prov = JSON.parse(readFileSyncSync(join(dir, 'results', 'provenance.json'), 'utf8'))
      expect(prov.target).toBe('script')
      expect(prov.runScript).toBe(join(dir, 'run.sh'))
      expect(prov.runScriptMd5).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit: a missing runScript fails before submitting', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-noscript-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir, runScript: 'nope.sh' }, {})) as { error?: string }
      expect(out.error).toContain('nope.sh')
      expect(h.submits).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_fit_status recovers a SLURM job from .slurm-jobs.json after a restart', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'dsh-pwa-fakebin-'))
    const oldPath = process.env.PATH
    try {
      writeFileSync(join(bin, 'squeue'), '#!/bin/sh\necho "PENDING|Resources|1:02:03"\n', { mode: 0o755 })
      writeFileSync(join(bin, 'sacct'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      process.env.PATH = `${bin}:${oldPath}`
      const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-recover-'))
      const dir = join(root, 'iter-001')
      mkdirSync(dir, { recursive: true })
      const key = 'slurm-7-abc'
      writeFileSync(
        join(root, '.slurm-jobs.json'),
        JSON.stringify({ [key]: { key, sbatchId: '570473', iterDir: dir, state: 'running', startedAt: Date.now() } }),
      )
      // A fresh session no longer knows the job id (DSH keeps jobs in memory).
      const h = harnessCtx({
        statusImpl: () => {
          throw new Error(`unknown job ${key}`)
        },
      })
      const out = (await run(h, 'auto_pwa_fit_status', { jobId: key, iterDir: root }, {})) as {
        state: string
        sbatchId?: string
        progress?: string
      }
      expect(out.state).toBe('running')
      expect(out.sbatchId).toBe('570473')
      expect(out.progress).toContain('PENDING')
      rmSync(root, { recursive: true, force: true })
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('auto_pwa_run_fit refuses a config that fails the physics gate (no submit)', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-bad-'))
    try {
      // [2+] of K+K- under J/psi -> eta + R_KK violates C conservation.
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG.replace('[J: 1, P: -1]: [phi1020]', '[J: 2, P: 1]: [phi1020]'))
      const out = (await run(h, 'auto_pwa_run_fit', { iterDir: dir }, { agent: { id: 'sess-1' } })) as {
        state: string
        error?: string
        gate?: { ok: boolean; report: string }
      }
      expect(h.submits).toEqual([])
      expect(out.state).toBe('failed')
      expect(out.error).toMatch(/c-violation/)
      expect(out.gate?.report).toMatch(/c-violation/)
      // Nothing was recorded for a refused run.
      expect(existsSync(join(dir, 'results', 'provenance.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_note commits the round and auto_pwa_git_log shows it (B2)', async () => {
    const h = harnessCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-gitnote-'))
    try {
      const iterDir = join(root, 'iterations', 'iter-001')
      mkdirSync(join(iterDir, 'results'), { recursive: true })
      writeFileSync(join(iterDir, 'config.yml'), GATE_CONFIG)
      writeFileSync(join(iterDir, 'results', 'fit.json'), '{"fit":{"best":{"nll":-18685.8}}}\n')
      const out = (await run(
        h,
        'auto_pwa_note',
        { iterDir, title: 'add phi1680', kind: 'added', nll: -18685.8, deltaNll: -12.3, hessianPositive: true, conclusion: 'ok' },
        { agent: { id: 'sess-1' } },
      )) as { ok: boolean; gitCommit?: string }
      expect(out.ok).toBe(true)
      expect(out.gitCommit).toMatch(/^[0-9a-f]{7,}$/)

      // History carries the decision AND the result number in one line, and the
      // tree is clean afterwards (the round is fully recorded).
      const log = (await run(h, 'auto_pwa_git_log', { path: iterDir, action: 'log' }, {})) as {
        ok: boolean
        initialized: boolean
        commit?: string
        dirty?: boolean
        entries: { short: string; subject: string }[]
      }
      expect(log.ok).toBe(true)
      expect(log.initialized).toBe(true)
      expect(log.dirty).toBe(false)
      expect(log.entries[0]!.short).toBe(out.gitCommit)
      expect(log.entries[0]!.subject).toContain('iter-001 result: add phi1680 NLL=-18685.80 dNLL=-12.30')

      // A manual edit shows up as dirty (results no longer reproducible from HEAD).
      writeFileSync(join(iterDir, 'config.yml'), `${GATE_CONFIG}# touched\n`)
      const status = (await run(h, 'auto_pwa_git_log', { path: iterDir, action: 'status' }, {})) as { dirty: boolean }
      expect(status.dirty).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto_pwa_edit_config commits the config change, and pickaxe finds it', async () => {
    const h = harnessCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-gitsearch-'))
    try {
      const iterDir = join(root, 'iterations', 'iter-001')
      mkdirSync(iterDir, { recursive: true })
      const configPath = join(iterDir, 'config.yml')
      writeFileSync(configPath, GATE_CONFIG)
      const edit = (await run(
        h,
        'auto_pwa_edit_config',
        {
          configPath,
          proposal: { name: 'omega1420', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.41, 0.35] },
        },
        {},
      )) as { ok: boolean; changed: string[] }
      expect(edit.ok).toBe(true)
      expect(edit.changed.some((c) => c.startsWith('git '))).toBe(true)

      const found = (await run(
        h,
        'auto_pwa_git_log',
        { path: configPath, action: 'search', needle: 'omega1420', file: 'config.yml' },
        {},
      )) as { ok: boolean; text?: string }
      expect(found.ok).toBe(true)
      expect(found.text ?? '').toMatch(/config: add omega1420|omega1420/)

      const shown = (await run(h, 'auto_pwa_git_log', { path: configPath, action: 'show', rev: 'HEAD', file: 'config.yml' }, {})) as {
        ok: boolean
        text?: string
      }
      expect(shown.ok).toBe(true)
      expect(shown.text ?? '').toContain('omega1420')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('warns when the config being fitted is not in git HEAD (fake reproducibility)', async () => {
    const h = harnessCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-gituntracked-'))
    try {
      const iterDir = join(root, 'iterations', 'iter-001')
      mkdirSync(join(iterDir, 'results'), { recursive: true })
      writeFileSync(join(iterDir, 'config.yml'), GATE_CONFIG)
      // Create the repo (through the note path), then hand-write an UNTRACKED
      // variant: dirty stays false, yet the fitted config is nowhere in HEAD.
      await run(h, 'auto_pwa_note', { iterDir, title: 'setup', kind: 'other', conclusion: 'x' }, { agent: { id: 's1' } })
      writeFileSync(join(iterDir, 'variant.yml'), GATE_CONFIG)

      const out = (await run(h, 'auto_pwa_run_fit', { iterDir, config: join(iterDir, 'variant.yml') }, { agent: { id: 's1' } })) as {
        jobId: string
        gate?: { ok: boolean; warnings: { code: string }[] }
      }
      expect(out.gate?.ok).toBe(true) // warning only — it never blocks a fit
      expect(out.gate?.warnings.map((w) => w.code)).toContain('git-config-not-committed')
      expect(h.submits).toHaveLength(1)
      expect(h.submits[0]!.request.iterDir).toBe(iterDir)
      const prov = JSON.parse(readFileSyncSync(join(iterDir, 'results', 'provenance.json'), 'utf8')) as {
        gitVerified?: boolean
        git?: { commit?: string; dirty?: boolean }
      }
      expect(prov.gitVerified).toBe(false)
      expect(prov.git?.commit).toBeTruthy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts the canonical run_fit parameter names (configPath / timeoutMin)', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-runfit-canon-'))
    try {
      writeFileSync(join(dir, 'config.yml'), GATE_CONFIG)
      const variant = join(dir, 'variant_broad.yml')
      writeFileSync(variant, GATE_CONFIG)
      const out = (await run(
        h,
        'auto_pwa_run_fit',
        { iterDir: dir, configPath: variant, timeoutMin: 5 },
        { agent: { id: 'sess-1' } },
      )) as { jobId: string; gate?: { ok: boolean } }
      expect(out.gate?.ok).toBe(true)
      expect(out.jobId).toBe('ctpwa-9')
      const req = h.submits[0]!.request as { iterDir: string; timeoutMin?: number; scriptArgs?: string[] }
      expect(req.timeoutMin).toBe(5)
      // The variant config is passed through to the driver (and gate/provenance
      // recorded that same file, not <iterDir>/config.yml).
      expect(req.scriptArgs).toEqual(['--config', variant])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_fit_status reads through ctx.pwaFit (summary skipped without results/)', async () => {
    const h = harnessCtx()
    const out = await run(h, 'auto_pwa_fit_status', { jobId: 'ctpwa-9' }, { agent: { id: 'sess-1' } })
    expect(h.statusCalls).toEqual([{ jobId: 'ctpwa-9', caller: { id: 'sess-1', agent: { id: 'sess-1' } } }])
    expect((out as { state: string }).state).toBe('done')
    expect((out as { logTail: string }).logTail).toBe('log tail')
    // No real results/ dir under the fake iterDir: empty summary, no NLL.
    expect((out as { summary: { bestNll?: number; files: string[] } }).summary.files).toEqual([])
    expect((out as { summary: { bestNll?: number } }).summary.bestNll).toBeUndefined()
  })

  it('auto_pwa_history：asOf 给出「截至 iter-N」的前缀折叠（替代逐轮遍历）', async () => {
    const h = harnessCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-asof-'))
    try {
      const iterations = join(root, 'iterations')
      for (const n of [1, 2, 3, 4]) mkdirSync(join(iterations, `iter-00${n}`), { recursive: true })
      const diary = [
        { iter: 1, kind: 'other', title: '基线仍为 iter-001', nll: -100, conclusion: '基线仍为 iter-001' },
        { iter: 2, kind: 'added', title: '加 X2200', nll: -110, deltaNll: -10, changes: ['R_ppbar [0-] += X2200'] },
        { iter: 3, kind: 'removed', title: 'X2200 被拒 → 回滚到 iter-001', nll: -95, deltaNll: 15 },
        { iter: 4, kind: 'added', title: '加 K1_1410', nll: -130, deltaNll: -20, conclusion: '最终模型定为 iter-004' },
      ]
      writeFileSync(join(iterations, 'SUMMARY.jsonl'), diary.map((r) => JSON.stringify(r)).join('\n') + '\n')

      const asOf2 = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, asOf: 2 }, {})) as {
        records: { iter: number }[]
        total: number
        nextIter: number
        state: { baseIter?: number }
      }
      // 前缀过滤 + 前缀折叠：截至 iter-2，基线仍是 iter-001（不是后面的 iter-004）
      expect(asOf2.records.map((r) => r.iter)).toEqual([1, 2])
      expect(asOf2.total).toBe(2)
      expect(asOf2.nextIter).toBe(3)
      expect(asOf2.state.baseIter).toBe(1)

      const asOf4 = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, asOf: 4 }, {})) as {
        records: { iter: number }[]
        state: { baseIter?: number }
      }
      expect(asOf4.records.map((r) => r.iter)).toEqual([1, 2, 3, 4])
      expect(asOf4.state.baseIter).toBe(4)

      // 渲染出来的头部要明确标注 as-of，避免把快照误读成"当前状态"
      const def = h.definitions.find((d) => d.name === 'auto_pwa_history') as unknown as {
        output?: { render?: (a: unknown, v: unknown) => unknown }
      }
      const rendered = JSON.stringify(def.output?.render?.({ iterationsRoot: iterations, asOf: 2 }, asOf2) ?? '')
      expect(rendered).toContain('as-of')
      expect(rendered).toContain('iter-002')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto_pwa_history：按键检索 + 补回被丢弃的字段 + fold 出的当前状态', async () => {
    const h = harnessCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-hist-'))
    try {
      const iterations = join(root, 'iterations')
      for (const n of [1, 2, 3]) mkdirSync(join(iterations, `iter-00${n}`), { recursive: true })
      const diary = [
        {
          iter: 1,
          kind: 'added',
          title: '加 X2200',
          nll: -100,
          deltaNll: -10,
          changes: ['R_ppbar [0-] += X2200'],
          hypothesis: 'X2200 吸收 0-+ 区',
          prediction: { metric: 'maxPull', threshold: 3, direction: 'below' },
        },
        {
          iter: 2,
          kind: 'removed',
          title: 'X2200 被拒：pull 未降',
          nll: -95,
          deltaNll: 5,
          conclusion: 'pull 未降',
          verification: { passed: false, actual: 5.4, note: 'maxPull 未降到 3 以下' },
        },
        { iter: 3, kind: 'added', title: '加 K1_1410', nll: -120, deltaNll: -25, changes: ['chain1.R_Reta [1-] += K1_1410'], notes: ['注意 C 守恒'] },
      ]
      writeFileSync(join(iterations, 'SUMMARY.jsonl'), diary.map((r) => JSON.stringify(r)).join('\n') + '\n')

      const all = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations }, {})) as {
        records: { iter: number; hypothesis?: string; verification?: { passed: boolean; actual?: number } }[]
        total: number
        state: { confidence: string; baseIter?: number; naiveAgrees: boolean; rejected: { iter: number }[] }
      }
      expect(all.records).toHaveLength(3)
      expect(all.total).toBe(3)
      // 这两个字段以前被输出 schema 丢弃 → 新会话看不到"为什么被证伪"
      expect(all.records[0]!.hypothesis).toBe('X2200 吸收 0-+ 区')
      expect(all.records[1]!.verification).toMatchObject({ passed: false, actual: 5.4 })
      // 没有任何基线声明 → fold 不编答案
      expect(all.state.confidence).toBe('none')

      const byNeedle = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, needle: 'X2200' }, {})) as { records: { iter: number }[] }
      expect(byNeedle.records.map((r) => r.iter)).toEqual([1, 2])

      const rejected = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, status: 'rejected' }, {})) as { records: { iter: number }[] }
      expect(rejected.records.map((r) => r.iter)).toEqual([2])
      const verified = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, status: 'verified' }, {})) as { records: { iter: number }[] }
      expect(verified.records.map((r) => r.iter)).toEqual([2])
      const pending = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, status: 'pending' }, {})) as { records: { iter: number }[] }
      expect(pending.records.map((r) => r.iter)).toEqual([1])
      const limited = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, limit: 1 }, {})) as { records: { iter: number }[] }
      expect(limited.records.map((r) => r.iter)).toEqual([3])
      const byKind = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations, kind: 'removed' }, {})) as { records: { iter: number }[] }
      expect(byKind.records.map((r) => r.iter)).toEqual([2])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto_pwa_history：状态行点出"取最新一轮会答错"（fold vs naive）', async () => {
    const h = harnessCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-histfold-'))
    try {
      const iterations = join(root, 'iterations')
      for (const n of [9, 11]) mkdirSync(join(iterations, `iter-0${String(n).padStart(2, '0')}`), { recursive: true })
      const diary = [
        { iter: 9, kind: 'added', title: 'iter-009', conclusion: 'iter-010 已证伪 → 回退基线到 iter-009', nll: -1759.42 },
        { iter: 11, kind: 'removed', title: 'iter-011：X2450 被数据拒绝 → 回退 iter-009', nll: -1432.39, deltaNll: 327.03 },
      ]
      writeFileSync(join(iterations, 'SUMMARY.jsonl'), diary.map((r) => JSON.stringify(r)).join('\n') + '\n')

      const out = (await run(h, 'auto_pwa_history', { iterationsRoot: iterations }, {})) as {
        state: { baseIter?: number; rule?: string; naiveMaxIter?: number; naiveAgrees: boolean; rejected: { iter: number }[] }
      }
      expect(out.state.baseIter).toBe(9)
      // 两个记录都指向 9：iter-009 的"回退基线到 iter-009"与 iter-011 的"回退 iter-009"；
      // rule 记的是**最后一次**生效的规则。
      expect(out.state.rule).toBe('rollback-bare')
      expect(out.state.naiveMaxIter).toBe(11)
      expect(out.state.naiveAgrees).toBe(false)
      expect(out.state.rejected.map((r) => r.iter)).toEqual([11])

      // 渲染文本必须把这条歧义说出来（否则模型仍会按"最新一轮"理解）
      const def = h.definitions.find((d) => d.name === 'auto_pwa_history')!
      const render = (def.output as unknown as { render: (a: unknown, v: unknown) => { text: string }[] }).render
      const rendered = render({}, out)
        .map((c) => c.text)
        .join('')
      expect(rendered).toContain('比对基线 iter-009')
      expect(rendered).toContain('取最新一轮')
      expect(rendered).toContain('已否决/回退')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto_pwa_state：注册 runtime context，且"没有分析目录时不注入"', async () => {
    const h = harnessCtx()
    h.fireAgentCreated('sess-digest') // 摘要按 agent 注册（agent.id === session.id）
    const provider = (): string => {
      const c = h.contexts.find((x) => x.name === 'auto-pwa:state')!
      return typeof c.text === 'function' ? c.text() : c.text
    }
    expect(h.contexts.map((c) => c.name)).toContain('auto-pwa:state')
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-digest-'))
    try {
      __resetActiveAnalysisRoot()
      // 插件还没见过任何分析目录、且 cwd 不是分析目录 → 空串（合法结果：不注入）
      expect(provider()).toBe('')

      const iterations = join(root, 'iterations')
      mkdirSync(join(iterations, 'iter-009'), { recursive: true })
      writeFileSync(
        join(iterations, 'SUMMARY.jsonl'),
        JSON.stringify({ iter: 9, kind: 'added', title: 'iter-009', conclusion: '回退基线到 iter-009', nll: -1759.42, nextPlan: '试 X2200' }) + '\n',
      )
      // 让插件"见过"这个分析目录（history 是最自然的入口）；
      // 真实 harness 会为每次工具调用发 session/event(tool/call)，插件据此按 session 归档 root。
      await run(h, 'auto_pwa_history', { iterationsRoot: iterations }, { agent: { id: 'sess-digest' } })
      h.fireSessionEvent(
        { id: 'sess-digest' },
        { type: 'tool/call', data: { name: 'auto_pwa_history', arguments: { iterationsRoot: iterations } } },
      )
      const txt = provider()
      expect(txt).toContain('<system-reminder>')
      expect(txt).toContain('ΔNLL 比对基线: iter-009')
      expect(txt).toContain('上轮计划: 试 X2200')
      // 程序性记忆（提醒）**默认关闭**：不开环境开关时不能出现在注入里
      expect(txt).not.toContain('作业提醒')

      // 打开开关后必须真的注入（真机 A/B 的入口）
      process.env.PWA_REMINDERS = 'R1'
      try {
        const withR = provider()
        expect(withR).toContain('作业提醒（R1')
        expect(withR).toContain('pdg-evidence')
      } finally {
        delete process.env.PWA_REMINDERS
      }
      expect(provider()).not.toContain('作业提醒')
    } finally {
      __resetActiveAnalysisRoot()
      rmSync(root, { recursive: true, force: true })
    }
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
        { agent: { id: 'sess-1' } },
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
      await run(h, 'auto_pwa_note', { iterDir, title: 'x', kind: 'other', conclusion: 'c' }, { agent: { id: 'sess-1' } })
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
        { agent: { id: 'sess-1' } },
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
      expect(h.submits[0]!.owner).toEqual({ id: 'sess-1', agent: { id: 'sess-1' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_try_candidates: warm-starts short fits from the base fit.json', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-trial-warm-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      const iterDir = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iterDir, 'results'), { recursive: true })
      writeFileSync(join(iterDir, 'config.yml'), LOOP_CONFIG)
      writeFileSync(join(iterDir, 'results', 'fit.json'), '{}')
      const out = (await run(
        h,
        'auto_pwa_try_candidates',
        {
          baseIterDir: iterDir,
          candidates: [{ name: 'omega1420', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.41, 0.29] }],
          shortRuns: 1,
          shortMaxIter: 300,
        },
        { agent: { id: 'sess-1' } },
      )) as { ok: boolean; warmFromBase?: boolean }
      expect(out.ok).toBe(true)
      expect(out.warmFromBase).toBe(true)
      const req = h.submits[0]!.request as { scriptArgs?: string[] }
      expect(req.scriptArgs).toEqual(['--runs', '1', '--max-iter', '300', '--warm', join(iterDir, 'results', 'fit.json')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto_pwa_try_candidates: removals get their own trials (significance pruning)', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-trial-rm-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      const iterDir = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iterDir, 'results'), { recursive: true })
      writeFileSync(join(iterDir, 'config.yml'), LOOP_CONFIG)
      const out = (await run(
        h,
        'auto_pwa_try_candidates',
        { baseIterDir: iterDir, removals: [{ name: 'K2_1430' }], shortRuns: 1, shortMaxIter: 300 },
        { agent: { id: 'sess-1' } },
      )) as { ok: boolean; jobs: { candidate: string; iterDir: string }[]; skipped: unknown[] }
      expect(out.ok).toBe(true)
      expect(out.skipped).toHaveLength(0)
      expect(out.jobs).toHaveLength(1)
      expect(out.jobs[0]!.candidate).toBe('rm:K2_1430')
      // The trial config really has the state removed (trial dir, base untouched).
      const trialCfg = parseConfig(readFileSyncSync(join(out.jobs[0]!.iterDir, 'config.yml'), 'utf8'))
      expect(trialCfg.resonances.K2_1430).toBeUndefined()
      expect(parseConfig(readFileSyncSync(join(iterDir, 'config.yml'), 'utf8')).resonances.K2_1430).toBeDefined()
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
      const first = (await run(h, 'auto_pwa_loop_next', { iterationsRoot, baseIterDir: iter0 }, { agent: { id: 'sess-1' } })) as {
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

      // 2. Plan A: iter_start is the new-round entry; it advances the loop state.
      const started = (await run(
        h,
        'auto_pwa_iter_start',
        { iterationsRoot, baseConfigPath: join(iter0, 'config.yml') },
        { agent: { id: 'sess-1' } },
      )) as { iter: number; iterDir: string }
      expect(started.iter).toBe(1)

      // 3. Simulate the fit finishing with a small (insignificant) gain.
      const iter1 = started.iterDir
      mkdirSync(join(iter1, 'results'), { recursive: true })
      mkdirSync(join(iter1, 'evaluate'), { recursive: true })
      writeFileSync(join(iter1, 'results', 'fit.json'), fitJson(98))
      writeFileSync(
        join(iter1, 'evaluate', 'evaluate.json'),
        JSON.stringify({ worst_distributions: [{ name: 'mass_R_KK', max_abs_pull: 2.1, bins_over_5sigma: 0 }] }),
      )

      // 4. Next: ΔNLL = -2 (below threshold), pulls OK -> converged.
      const second = (await run(h, 'auto_pwa_loop_next', { iterationsRoot }, { agent: { id: 'sess-1' } })) as {
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

  it('loop_next forceConverge 直接写 FINAL-REPORT，不依赖 loop_decide', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-loop-force-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      const iter0 = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iter0, 'results'), { recursive: true })
      writeFileSync(join(iter0, 'config.yml'), LOOP_CONFIG)
      writeFileSync(join(iter0, 'results', 'fit.json'), fitJson(100))
      await run(h, 'auto_pwa_loop_next', { iterationsRoot, baseIterDir: iter0 }, { agent: { id: 'sess-1' } })
      const out = (await run(
        h,
        'auto_pwa_loop_next',
        { iterationsRoot, forceConverge: true, reason: 'manual stop for test' },
        { agent: { id: 'sess-1' } },
      )) as { ok: boolean; phase: string; converged: boolean; reportPath?: string }
      expect(out.ok).toBe(true)
      expect(out.phase).toBe('done')
      expect(out.converged).toBe(true)
      expect(out.reportPath).toContain('FINAL-REPORT.md')
      expect(readFileSyncSync(join(iterationsRoot, 'FINAL-REPORT.md'), 'utf8')).toContain('manual stop for test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('P1c 验证账本：loop_next 把"预测→验证"追加落盘（不再依赖模型抄进 note）', async () => {
    const h = harnessCtx()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-ledger-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      const iter0 = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iter0, 'results'), { recursive: true })
      writeFileSync(join(iter0, 'config.yml'), LOOP_CONFIG)
      writeFileSync(join(iter0, 'results', 'fit.json'), fitJson(100))
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
      await run(h, 'auto_pwa_loop_next', { iterationsRoot, baseIterDir: iter0 }, { agent: { id: 'sess-1' } })
      const started = (await run(
        h,
        'auto_pwa_iter_start',
        { iterationsRoot, baseConfigPath: join(iter0, 'config.yml') },
        { agent: { id: 'sess-1' } },
      )) as { iterDir: string }
      // Plan A has no loop_decide: the ledger prediction is a state field, set here
      // to exercise loop_next's automatic verification.
      const statePath = join(iterationsRoot, '.loop-state.json')
      const st = JSON.parse(readFileSyncSync(statePath, 'utf8')) as {
        pendingPrediction?: unknown
      }
      st.pendingPrediction = {
        prediction: { metric: 'deltaNll', threshold: -3, direction: 'below' },
        hypothesis: 'omega1420 会吸收 ΔNLL 大改善',
        iter: 1,
      }
      writeFileSync(statePath, JSON.stringify(st))
      // 拟合完成：ΔNLL = 98-100 = -2 → 预测不成立（阈值 -3）
      mkdirSync(join(started.iterDir, 'results'), { recursive: true })
      mkdirSync(join(started.iterDir, 'evaluate'), { recursive: true })
      writeFileSync(join(started.iterDir, 'results', 'fit.json'), fitJson(98))
      writeFileSync(
        join(started.iterDir, 'evaluate', 'evaluate.json'),
        JSON.stringify({ worst_distributions: [{ name: 'mass_R_KK', max_abs_pull: 2.1, bins_over_5sigma: 0 }] }),
      )

      const next = (await run(h, 'auto_pwa_loop_next', { iterationsRoot }, { agent: { id: 'sess-1' } })) as {
        verification?: { passed: boolean; actual: number | null }
      }
      expect(next.verification).toMatchObject({ passed: false })
      // 关键：**代码侧留痕**（此前 pendingPrediction 一清就什么都不剩）
      const state = JSON.parse(readFileSyncSync(join(iterationsRoot, '.loop-state.json'), 'utf8')) as {
        verifications?: { iter: number; verifiedAtIter: number; passed: boolean; hypothesis?: string }[]
      }
      expect(state.verifications).toHaveLength(1)
      expect(state.verifications![0]).toMatchObject({ iter: 1, passed: false, hypothesis: 'omega1420 会吸收 ΔNLL 大改善' })

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
