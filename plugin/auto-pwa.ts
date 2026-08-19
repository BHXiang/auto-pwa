/**
 * auto-pwa plugin: auto_pwa_* tools for partial-wave analysis in the DeepSeek
 * Harness. Thin wrappers over the pure core in ../src — the strong
 * constraints (physics validation, YAML rendering, atomic writes) live in the
 * core; this file only declares the model-facing surface.
 *
 * Mount via:  pnpm dsh web --patch /home/whitewash/pkgs/auto-pwa/patch/auto-pwa.cordis.yml
 *
 * Tools:
 *   auto_pwa_lookup        query the PDG resonance table
 *   auto_pwa_decay_check   allowed intermediate J^P for A -> R + B, + candidates
 *   auto_pwa_jpc_check     two-vertex J^PC check (decay ∩ production, C conservation)
 *   auto_pwa_config_view   read-only JSON view of config.yml
 *   auto_pwa_validate_add  gate a resonance addition (PDG/JPC/threshold/duplicate)
 *   auto_pwa_edit_config   validate + apply + render + atomically write config.yml
 *   auto_pwa_run_fit       submit a fit via ctx.pwaFit (DSH background job)
 *   auto_pwa_fit_status    poll a fit job and summarize results/ (fit.json preferred)
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDb } from '../src/db.js'
import { lookupResonance, lookupC } from '../src/lookup.js'
import { decayCheck, allowedIntermediateJP } from '../src/decay-check.js'
import { pairJPC, pairKind, jpcLabel } from '../src/jpc.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { parseConfig, applyResonanceAddition, dumpConfig, crossReferenceErrors, validateConfig } from '../src/config-edit.js'
import { suggestFree } from '../src/float-policy.js'
import { defaultFitRunnerConfig } from '../src/fit-runner.js'
import { summarizeFitDir } from '../src/fit-summary.js'
import { resolveEnv } from '../src/config.js'
import { existsSync as fsExists } from 'node:fs'
import { IterationLog, startIteration, iterationsRootOf, listIterations } from '../src/iteration-log.js'
import { existsSync as fsExistsSync } from 'node:fs'
import type { IterationRecord } from '../src/report.js'
import { spawnSync } from 'node:child_process'
import type { JP, ResonanceProposal } from '../src/types.js'
import { createUsageTracker, maybeSpill, type TokenTotals } from './pwa-utils.js'

export const name = 'auto-pwa'
export const inject = ['tools', 'pwaFit']

const text = (t: string) => [{ type: 'text' as const, text: t }]

/** Map a tool execution's agent to a pwaFit owner (jobs session fence). */
const ownerOf = (exec: { agent?: { sessionId?: string } }): { sessionId: string } | undefined =>
  exec.agent?.sessionId !== undefined ? { sessionId: exec.agent.sessionId } : undefined

// ---------------------------------------------------------------------------
// shared parameter fragments
// ---------------------------------------------------------------------------

const jpParam = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    j: { type: 'number' as const, description: '总角动量 J' },
    p: { type: 'integer' as const, enum: [-1, 1] as const, description: '宇称 P: +1 或 -1' },
  },
  description: '自旋宇称 (J, P)',
} as const

const proposalParam = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, required: true, description: '共振态名（分析命名，如 phi1680；须能匹配 PDG 表的 id/别名，除非 model=ONE）' },
    chain: { type: 'string' as const, required: true, description: '加入的 intermediate 名，如 R_KK' },
    jpGroup: { ...jpParam, required: true, description: '要加入（或新建）的 [J,P] 组' },
    model: { type: 'string' as const, required: true, enum: ['BWR', 'BW', 'ONE', 'Flatte'] as const, description: '线形模型：BWR/BW（有传播子，需 PDG 依据）；ONE=相空间项（无需 PDG）' },
    parameters: { type: 'array' as const, required: true, items: { type: 'number' as const }, description: '[质量, 宽度] GeV；ONE 恰好 1 个 [质量]（占位，不参与振幅）' },
    free: { type: 'array' as const, items: { type: 'integer' as const }, description: 'float 的参数索引：0=质量, 1=宽度, -1=全部' },
    freeRange: { type: 'array' as const, items: { type: 'array' as const, items: { type: 'number' as const } }, description: '每个 free 参数一个 [lo, hi] GeV 区间，须包含初始值' },
    tex: { type: 'string' as const, description: 'LaTeX 标签' },
  },
  description: '共振态添加提议（强约束：物理校验与 YAML 渲染均由程序完成）',
} as const

export function apply(ctx: Context) {
  // token-meter: 累计本会话各 session 的 assistant/message usage；
  // auto_pwa_note 的 includeTokens 按轮取差值写进日记。
  const usage = createUsageTracker()
  ctx.on?.('session/event', (session: unknown, event: unknown) => {
    const sessionId = typeof (session as { id?: unknown } | null | undefined)?.id === 'string'
      ? (session as { id: string }).id
      : '?'
    usage.onSessionEvent(sessionId, event as { type?: string; usage?: unknown } as never)
  })

  // ---------------------------------------------------------------------
  // auto_pwa_lookup
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_lookup',
    description: '查询 PDG 共振态表（data/pdg.json，scikit-hep particle 权威数据）。按名称/别名、J^P、质量范围、衰变末态过滤，按质量升序返回。用于：确认共振态存在、查 J^P/质量/宽度、找 pull 偏差区的候选。',
    parameters: {
      name: { type: 'string', description: '粒子名或其别名，如 "phi1680" 或 "phi(1680)"；省略则按其他条件过滤' },
      jp: jpParam,
      massRange: { type: 'array', items: { type: 'number' }, description: '[lo, hi] GeV 闭区间' },
      decayTo: { type: 'array', items: { type: 'string' }, description: '末态粒子名列表（如 ["K+","eta"]）；命中至少一个衰变模式包含全部末态' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                jp: { type: 'object', required: true, additionalProperties: false, properties: { j: { type: 'number' }, p: { type: 'integer' } } },
                mass: { type: 'number', required: true },
                width: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                status: { type: 'string' },
                decayModes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { hits: { id: string; jp: JP; mass: number; width?: number }[]; total: number }) => {
        if (value.hits.length === 0) return text('(无命中)')
        const lines = value.hits.map((h) => `${h.id.padEnd(16)} J^P=${h.jp.j}${h.jp.p > 0 ? '+' : '-'}  m=${h.mass.toFixed(4)} GeV  Γ=${h.width?.toFixed(4) ?? '-'} GeV`)
        return text(`PDG 命中 ${value.total} 条:\n${lines.join('\n')}`)
      },
    },
    async execute(args: { name?: string; jp?: JP; massRange?: [number, number]; decayTo?: string[] }) {
      const hits = lookupResonance(defaultDb, {
        name: args.name,
        jp: args.jp,
        massRange: args.massRange,
        decayTo: args.decayTo,
      })
      return {
        total: hits.length,
        hits: hits.map((h) => ({
          id: h.id,
          jp: h.jp,
          mass: h.mass,
          width: h.width ?? null,
          status: h.status,
          decayModes: (h.decayModes ?? []).map((m) => m.daughters.join(' -> ')),
        })),
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_decay_check
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_decay_check',
    description: '物理可达性检查：枚举 A -> R + B 允许的中间态 J^P（角动量+宇称守恒，maxL 截断），并列出质量阈值以下、每个 J^P 的 PDG 候选。加共振态前先查这个，确认 J^P 物理允许。',
    parameters: {
      mother: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: { j: { type: 'number' }, p: { type: 'integer', enum: [-1, 1] }, mass: { type: 'number' } },
        description: '母粒子 A，如 J/psi {j:1, p:-1, mass:3.0969}',
      },
      daughter: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: { j: { type: 'number' }, p: { type: 'integer', enum: [-1, 1] }, mass: { type: 'number' } },
        description: '非共振子粒子 B（如 eta 或 K）',
      },
      maxL: { type: 'integer', description: '最大轨道角动量，默认 4' },
      decayTo: { type: 'array', items: { type: 'string' }, description: '末态粒子名；命中衰变模式的候选排序靠前并标记' },
      massTolerance: { type: 'number', description: '质量阈值额外容差 GeV（off-shell），默认 0' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threshold: { type: 'number', required: true },
          allowed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                jp: { type: 'object', additionalProperties: false, properties: { j: { type: 'number' }, p: { type: 'integer' } } },
                L: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                jp: { type: 'object', additionalProperties: false, properties: { j: { type: 'number' }, p: { type: 'integer' } } },
                resonances: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      mass: { type: 'number', required: true },
                      width: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                      decaysTo: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value: { threshold: number; allowed: { jp: JP; L: number[] }[]; candidates: { jp: JP; resonances: { id: string; mass: number; decaysTo: boolean | undefined }[] }[] }) => {
        const lines = [`阈值 m_R <= ${value.threshold.toFixed(4)} GeV`, `允许的 J^P: ${value.allowed.map((a) => `${a.jp.j}${a.jp.p > 0 ? '+' : '-'}(L=${a.L.join(',')})`).join(' ')}`]
        for (const c of value.candidates) {
          lines.push(`[${c.jp.j}${c.jp.p > 0 ? '+' : '-'}] ${c.resonances.length} 个候选: ${c.resonances.slice(0, 12).map((r) => `${r.id}${r.decaysTo ? '★' : ''}`).join(', ')}${c.resonances.length > 12 ? ' …' : ''}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { mother: { j: number; p: 1 | -1; mass: number }; daughter: { j: number; p: 1 | -1; mass: number }; maxL?: number; decayTo?: string[]; massTolerance?: number }) {
      const r = decayCheck(args.mother, args.daughter, defaultDb, {
        maxL: args.maxL ?? 4,
        massTolerance: args.massTolerance ?? 0,
        decayTo: args.decayTo,
      })
      return {
        threshold: args.mother.mass - args.daughter.mass + (args.massTolerance ?? 0),
        allowed: r.allowed.map((a) => ({ jp: a.jp, L: a.L })),
        candidates: r.candidates.map((c) => ({
          jp: c.jp,
          resonances: c.resonances.map((x) => ({ id: x.entry.id, mass: x.entry.mass, width: x.entry.width ?? null, decaysTo: x.decaysTo })),
        })),
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_jpc_check（两顶点 J^PC 检查）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_jpc_check',
    description:
      '两顶点 J^PC 检查（只读）：对 config 中每个中间态输出——① 衰变顶点 J^PC 全集（R→d1+d2：S 来自子自旋、J=L⊗S、P=P1·P2·(−1)^L；C 仅对共轭对（K+K−、K0K~0…）与 Constraints.identical 组定义：C=(−1)^(L+S)，全同组施加 Bose/Fermi 选择定则；sl 白名单与 maxL 生效，波表与 ctpwa Amp2BD::ComSL 逐点一致）② 产生顶点允许 J^P（A→R+B 角动量+宇称）与 C 守恒要求（母子均自共轭时 C(R)=C(A)·C(B)）③ 两顶点交集（唯一可写入的 J^PC）④ 每个允许 J^PC 的 PDG 候选（按 J^PC 过滤）。加共振态前先查这个，能直接看到 f2(1270)→R_KK 这类 C 违例为什么被拦。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径' },
      target: { type: 'string', description: '链名（如 decay1）或中间态名（如 R_KK）；省略 = 全部链的全部中间态' },
      maxL: { type: 'integer', description: '轨道角动量上限；默认取 config Constraints.maxL，未设置则 4' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configPath: { type: 'string', required: true },
          maxL: { type: 'integer', required: true },
          intermediates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                chain: { type: 'string', required: true },
                production: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mother: { type: 'string' },
                    daughter: { type: 'string' },
                    threshold: { type: 'number' },
                    allowedJP: { type: 'array', items: { type: 'string' } },
                    cRequired: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                  },
                },
                decaySteps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      daughters: { type: 'array', items: { type: 'string' } },
                      identical: { type: 'boolean' },
                      cDefined: { type: 'boolean' },
                      sl: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                      jpc: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                allowed: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      jpc: { type: 'string' },
                      c: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                      sl: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                      candidates: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            id: { type: 'string', required: true },
                            mass: { type: 'number', required: true },
                            width: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                            cMatch: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
                cBlocked: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          spilled: {
            type: 'object',
            additionalProperties: false,
            properties: {
              locator: { type: 'string' },
              bytes: { type: 'integer' },
              retrievalHint: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value: {
        maxL: number
        intermediates: {
          name: string
          chain: string
          production?: { mother?: string; daughter?: string; threshold?: number; allowedJP?: string[]; cRequired?: number | null }
          decaySteps?: { daughters: string[]; identical?: boolean; cDefined?: boolean; sl?: [number, number][]; jpc?: string[] }[]
          allowed?: { jpc: string; sl?: [number, number][]; candidates?: { id: string; mass: number; cMatch?: string }[] }[]
          cBlocked?: string[]
        }[]
        spilled?: { locator: string; bytes: number; retrievalHint: string }
      }) => {
        const lines = [`JPC 检查（maxL=${value.maxL}）`]
        for (const it of value.intermediates) {
          lines.push(`== ${it.name} (chain ${it.chain}) ==`)
          const prod = it.production
          if (prod) {
            lines.push(
              `  产生: ${prod.mother ?? '?'} -> R + ${prod.daughter ?? '?'}, 阈值 ${prod.threshold?.toFixed(4) ?? '?'}, ` +
                `允许 J^P: ${prod.allowedJP?.join(' ') ?? '?'}${prod.cRequired !== undefined && prod.cRequired !== null ? `, C(R)=${prod.cRequired > 0 ? '+' : '-'} 必需` : ''}`,
            )
          }
          for (const st of it.decaySteps ?? []) {
            lines.push(
              `  衰变: ${st.daughters.join(' + ')}${st.identical ? ' (identical)' : ''}${st.sl ? ` sl=${JSON.stringify(st.sl)}` : ''} -> J^PC: ${st.jpc?.join(' ') ?? '?'}`,
            )
          }
          for (const a of it.allowed ?? []) {
            const cands = (a.candidates ?? []).slice(0, 10).map((c) => `${c.id}${c.cMatch === 'unknown' ? '~' : ''}`).join(', ')
            lines.push(`  ✓ ${a.jpc} (sl ${(a.sl ?? []).map((s) => `${s[0]}/${s[1]}`).join(' ')}) 候选: ${cands}${(a.candidates ?? []).length > 10 ? ' …' : ''}`)
          }
          for (const b of it.cBlocked ?? []) lines.push(`  ✗ ${b} (C 守恒拦截)`)
        }
        if (value.spilled) lines.push(`（完整输出已 spill: ${value.spilled.locator} — ${value.spilled.retrievalHint}）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath: string; target?: string; maxL?: number }, exec) {
      const cfg = parseConfig(readFileSync(args.configPath, 'utf8'))
      const maxL = args.maxL ?? cfg.constraints.maxL ?? 4
      const identicalGroups = cfg.constraints.identical
      // Resolve target: chain name, intermediate name, or everything.
      let chains: string[]
      if (args.target === undefined) {
        chains = Object.keys(cfg.decayChains)
      } else if (cfg.decayChains[args.target] !== undefined) {
        chains = [args.target]
      } else {
        chains = Object.keys(cfg.decayChains).filter((c) => cfg.decayChains[c].intermediates[args.target!] !== undefined)
        if (chains.length === 0) {
          return {
            configPath: args.configPath,
            maxL,
            intermediates: [],
            error: `no chain or intermediate named "${args.target}" in the config`,
          } as never
        }
      }
      const named = (n: string): { name: string; j: number; p: 1 | -1; c?: 1 | -1 } | undefined => {
        const p = cfg.particles[n]
        return p === undefined ? undefined : { name: n, j: p.j, p: p.p, c: lookupC(defaultDb, n) }
      }
      const intermediates: {
        name: string
        chain: string
        production?: {
          mother?: string
          daughter?: string
          threshold?: number
          allowedJP?: string[]
          cRequired?: 1 | -1 | null
        }
        decaySteps?: {
          daughters: string[]
          identical?: boolean
          cDefined?: boolean
          sl?: [number, number][]
          jpc?: string[]
        }[]
        allowed?: { jpc: string; c: 1 | -1 | null; sl: [number, number][]; candidates: { id: string; mass: number; width: number | null; cMatch: string }[] }[]
        cBlocked?: string[]
      }[] = []
      for (const chainName of chains) {
        const chain = cfg.decayChains[chainName]
        for (const intName of Object.keys(chain.intermediates)) {
          const kin = cfg.kinematics[intName]
          const production = kin ? allowedIntermediateJP(kin.mother, kin.daughter, maxL) : []
          const motherC = kin?.motherName !== undefined ? lookupC(defaultDb, kin.motherName) : undefined
          const daughterC = kin?.daughterName !== undefined ? lookupC(defaultDb, kin.daughterName) : undefined
          const cRequired = motherC !== undefined && daughterC !== undefined ? ((motherC * daughterC) as 1 | -1) : undefined
          // Merge J^PC sets over all decay modes of this intermediate.
          const byKey = new Map<string, { jpc: JP; sl: [number, number][] }>()
          const stepInfos: { daughters: string[]; identical: boolean; cDefined: boolean; sl?: [number, number][]; jpc: string[] }[] = []
          for (const step of chain.steps.filter((s) => s.mother === intName)) {
            const d1 = named(step.daughters[0])
            const d2 = named(step.daughters[1])
            if (!d1 || !d2) continue
            const waves = pairJPC(d1, d2, { maxL, identicalGroups, slFilter: step.sl })
            const { kind, cDefined } = pairKind(d1, d2, identicalGroups)
            stepInfos.push({
              daughters: step.daughters,
              identical: kind.startsWith('identical'),
              cDefined,
              sl: step.sl,
              jpc: waves.map((w) => jpcLabel(w.jpc)),
            })
            for (const w of waves) {
              const key = `${w.jpc.j}|${w.jpc.p}|${w.jpc.c ?? 'x'}`
              const e = byKey.get(key) ?? { jpc: w.jpc, sl: [] }
              e.sl.push(...w.sl.map((x) => [x.s, x.l] as [number, number]))
              byKey.set(key, e)
            }
          }
          const prodHas = (jpc: JP): boolean => production.some((p) => p.jp.j === jpc.j && p.jp.p === jpc.p)
          const allowed: { jpc: string; c: 1 | -1 | null; sl: [number, number][]; candidates: { id: string; mass: number; width: number | null; cMatch: string }[] }[] = []
          const cBlocked: string[] = []
          for (const e of byKey.values()) {
            if (!prodHas(e.jpc)) continue
            if (cRequired !== undefined && e.jpc.c !== undefined && e.jpc.c !== cRequired) {
              cBlocked.push(jpcLabel(e.jpc))
              continue
            }
            const c = e.jpc.c ?? null
            const candidates = lookupResonance(defaultDb, { jp: { j: e.jpc.j, p: e.jpc.p } })
              .filter((r) => {
                if (c === null) return true
                return r.c === c || r.c === undefined // undefined C = data gap, flagged
              })
              .map((r) => ({
                id: r.id,
                mass: r.mass,
                width: r.width ?? null,
                cMatch: c === null ? 'n/a' : r.c === c ? 'yes' : 'unknown',
              }))
            allowed.push({ jpc: jpcLabel(e.jpc), c, sl: e.sl, candidates })
          }
          intermediates.push({
            name: intName,
            chain: chainName,
            production: kin
              ? {
                  mother: kin.motherName,
                  daughter: kin.daughterName,
                  threshold: kin.threshold,
                  allowedJP: production.map((p) => `${p.jp.j}${p.jp.p > 0 ? '+' : '-'}`),
                  cRequired: cRequired ?? null,
                }
              : undefined,
            decaySteps: stepInfos,
            allowed,
            cBlocked,
          })
        }
      }
      const out: { configPath: string; maxL: number; intermediates: unknown[]; spilled?: { locator: string; bytes: number; retrievalHint: string } } =
        { configPath: args.configPath, maxL, intermediates }
      // Spill oversized outputs so long autonomous sessions stay lean
      // (model reads the locator on demand instead of carrying the payload).
      const ref = await maybeSpill(ctx, exec, 'auto_pwa_jpc_check', JSON.stringify(out), null)
      return ref === null ? out : { ...out, spilled: ref }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_config_view（只读 JSON 视图）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_config_view',
    description:
      'config.yml 的只读 JSON 视图（AI 阅读用）：Particles / DecayChains（intermediates 组 + 衰变步含 sl/p_break opts）/ Resonances / 运动学阈值 / Constraints 解析（identical/trans/maxL/bf_d/has_bf/fix_var/free_var/var_range/var_equal/gauss_constr）/ validateConfig 校验结果 / 每个共振态的 PDG 命中与阈值余量。config.yml 是唯一源头（人看、引擎读），此视图是机器/AI 读法——要修改必须走 auto_pwa_edit_config，禁止用视图直接改文件。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径' },
      filter: {
        type: 'string',
        enum: ['all', 'particles', 'chains', 'resonances', 'constraints', 'kinematics', 'validation'],
        description: '视图过滤；默认 all',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configPath: { type: 'string', required: true },
          particles: { type: 'array', items: { type: 'object', additionalProperties: false } },
          chains: { type: 'array', items: { type: 'object', additionalProperties: false } },
          resonances: { type: 'array', items: { type: 'object', additionalProperties: false } },
          kinematics: { type: 'array', items: { type: 'object', additionalProperties: false } },
          constraints: { type: 'object', additionalProperties: false },
          validation: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, errors: { type: 'array', items: { type: 'object', additionalProperties: false } }, warnings: { type: 'array', items: { type: 'object', additionalProperties: false } } } },
          spilled: {
            type: 'object',
            additionalProperties: false,
            properties: {
              locator: { type: 'string' },
              bytes: { type: 'integer' },
              retrievalHint: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value: {
        particles?: { name: string; jp: string; mass: number }[]
        chains?: { name: string; intermediates: string; steps: number }[]
        resonances?: { name: string; jp: string; model: string; pdg?: string | null; jpcMatch?: boolean; thresholdMargin?: { chain: string; margin: number } | null }[]
        kinematics?: { intermediate: string; threshold: number }[]
        constraints?: { identical?: string[][]; maxL?: number; trans?: number }
        validation?: { ok: boolean; errors: { code: string; message: string }[]; warnings: { code: string; message: string }[] }
      }) => {
        const lines = [`config 视图: ${value.particles?.length ?? 0} particles, ${value.chains?.length ?? 0} chains, ${value.resonances?.length ?? 0} resonances`]
        const con = value.constraints
        if (con && Object.keys(con).length > 0) {
          lines.push(`Constraints: maxL=${con.maxL ?? '-'} identical=${JSON.stringify(con.identical ?? [])} trans=${con.trans ?? 0} 条`)
        }
        for (const r of value.resonances ?? []) {
          const m = r.thresholdMargin
          lines.push(
            `  ${r.name} [${r.jp}] ${r.model} ${r.pdg ? `PDG=${r.pdg}${r.jpcMatch ? '' : ' (JPC 不一致!)'}` : 'PDG 未命中'}${m ? ` 阈值余量 ${m.margin >= 0 ? '+' : ''}${m.margin.toFixed(4)}` : ''}`,
          )
        }
        for (const k of value.kinematics ?? []) {
          lines.push(`  ${k.intermediate}: 阈值 <= ${k.threshold.toFixed(4)} GeV`)
        }
        const v = value.validation
        if (v) {
          lines.push(`校验: ${v.ok ? '通过' : '失败'}（${v.errors.length} errors, ${v.warnings.length} warnings）`)
          for (const e of v.errors) lines.push(`  [error] ${e.code}: ${e.message}`)
          for (const w of v.warnings) lines.push(`  [warn]  ${w.code}: ${w.message}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath: string; filter?: string }, exec) {
      const cfg = parseConfig(readFileSync(args.configPath, 'utf8'))
      const filter = args.filter ?? 'all'
      const out: Record<string, unknown> = { configPath: args.configPath }
      if (filter === 'all' || filter === 'particles') {
        out.particles = Object.entries(cfg.particles).map(([name, p]) => ({
          name,
          jp: `${p.j}${p.p > 0 ? '+' : '-'}`,
          mass: p.mass,
          c: p.c ?? null,
        }))
      }
      if (filter === 'all' || filter === 'chains') {
        out.chains = Object.entries(cfg.decayChains).map(([name, chain]) => ({
          name,
          intermediates: Object.entries(chain.intermediates).map(([intName, int]) => ({
            name: intName,
            groups: int.groups.map((g) => ({
              jp: `${g.jp.j}${g.jp.p > 0 ? '+' : '-'}`,
              names: g.names,
            })),
          })),
          steps: chain.steps.map((s) => ({
            mother: s.mother,
            daughters: s.daughters,
            sl: s.sl ?? null,
            pBreak: s.pBreak ?? false,
          })),
        }))
      }
      if (filter === 'all' || filter === 'resonances') {
        out.resonances = Object.entries(cfg.resonances).map(([name, spec]) => {
          const hit = lookupResonance(defaultDb, { name })[0]
          let thresholdMargin: { chain: string; margin: number } | null = null
          for (const [cname, chain] of Object.entries(cfg.decayChains)) {
            for (const [intName, int] of Object.entries(chain.intermediates)) {
              if (int.groups.some((g) => g.names.includes(name))) {
                const kin = cfg.kinematics[intName]
                if (kin) {
                  thresholdMargin = { chain: cname, margin: kin.threshold - spec.parameters[0] }
                }
              }
            }
          }
          return {
            name,
            jp: `${spec.j}${spec.p > 0 ? '+' : '-'}`,
            model: spec.model,
            parameters: spec.parameters,
            free: spec.free ?? null,
            pdg: hit ? { id: hit.id, jp: `${hit.jp.j}${hit.jp.p > 0 ? '+' : '-'}`, c: hit.c ?? null, mass: hit.mass } : null,
            jpcMatch: hit !== undefined && hit.jp.j === spec.j && hit.jp.p === spec.p,
            thresholdMargin,
          }
        })
      }
      if (filter === 'all' || filter === 'kinematics') {
        out.kinematics = Object.entries(cfg.kinematics).map(([intName, kin]) => ({
          intermediate: intName,
          mother: kin.motherName ?? '?',
          daughter: kin.daughterName ?? '?',
          threshold: kin.threshold,
        }))
      }
      if (filter === 'all' || filter === 'constraints') {
        out.constraints = cfg.constraints
      }
      if (filter === 'all' || filter === 'validation') {
        const v = validateConfig(cfg)
        out.validation = { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings }
      }
      const ref = await maybeSpill(ctx, exec, 'auto_pwa_config_view', JSON.stringify(out), null)
      return ref === null ? out : { ...out, spilled: ref }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_validate_add
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_validate_add',
    description: '验证"添加共振态"提议（只读，不写文件）：PDG 依据、JPC 一致性、运动学阈值、重复、参数/free 结构、J^P 物理可达性。errors 阻止写入；warnings 提示风险；附 float 策略建议。任何 error 出现时不要调用 auto_pwa_edit_config。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径' },
      proposal: { ...proposalParam, required: true },
      massTolerance: { type: 'number', description: '运动学阈值容差 GeV' },
      decayTo: { type: 'array', items: { type: 'string' }, description: '末态粒子（用于衰变模式 warning）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errors: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          warnings: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          threshold: { type: 'number' },
          floatSuggestion: {
            type: 'object',
            additionalProperties: false,
            properties: {
              free: { type: 'array', items: { type: 'integer' } },
              freeRange: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
              rationale: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`验证: ${value.ok ? '通过' : '拒绝'}（${value.errors.length} errors, ${value.warnings.length} warnings）`]
        for (const e of value.errors) lines.push(`  [error] ${e.code}: ${e.message}`)
        for (const w of value.warnings) lines.push(`  [warn]  ${w.code}: ${w.message}`)
        if (value.floatSuggestion) {
          lines.push(`float 建议: free=${JSON.stringify(value.floatSuggestion.free ?? [])} range=${JSON.stringify(value.floatSuggestion.freeRange ?? [])}`)
          lines.push(`  ${value.floatSuggestion.rationale}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath: string; proposal: ResonanceProposal; massTolerance?: number; decayTo?: string[] }) {
      const cfg = parseConfig(readFileSync(args.configPath, 'utf8'))
      const result = validateResonanceAddition(defaultDb, cfg, args.proposal, {
        massTolerance: args.massTolerance,
        decayTo: args.decayTo,
      })
      const kin = cfg.kinematics[args.proposal.chain]
      const out: {
        ok: boolean
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
        threshold?: number
        floatSuggestion?: { free?: number[]; freeRange?: [number, number][]; rationale: string }
      } = {
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
      }
      if (kin) out.threshold = kin.threshold
      if (result.ok && kin) {
        const pdg = lookupResonance(defaultDb, { name: args.proposal.name })[0]
        out.floatSuggestion = suggestFree(pdg, args.proposal, { threshold: kin.threshold })
      }
      return out
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_edit_config
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_edit_config',
    description: '把"添加共振态"提议写入 config.yml（强约束：先物理校验→结构化修改→交叉引用→YAML 渲染→原子写）。errors 非空时绝不写文件。写前自动备份原文件为 config.yml.bak。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径（会被修改）' },
      proposal: { ...proposalParam, required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          written: { type: 'boolean', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          errors: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          warnings: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          configPath: { type: 'string', required: true },
          backupPath: { type: 'string' },
          resonanceCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value: {
        ok: boolean
        written: boolean
        changed: string[]
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
        configPath: string
        backupPath?: string
        resonanceCount: number
      }) => {
        if (!value.ok) {
          return text(`拒绝写入（${value.errors.length} errors）:\n${value.errors.map((e) => `  [error] ${e.code}: ${e.message}`).join('\n')}`)
        }
        const lines = [`已写入 ${value.configPath}（备份: ${value.backupPath}）:`, ...value.changed.map((c) => `  ${c}`)]
        if (value.warnings.length > 0) lines.push(...value.warnings.slice(0, 5).map((w) => `  [warn] ${w.code}: ${w.message}`))
        if (value.warnings.length > 5) lines.push(`  … 共 ${value.warnings.length} 条 warning`)
        lines.push(`共振态总数: ${value.resonanceCount}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath: string; proposal: ResonanceProposal }) {
      const configPath = args.configPath
      const cfg = parseConfig(readFileSync(configPath, 'utf8'))
      const v = validateResonanceAddition(defaultDb, cfg, args.proposal)
      if (!v.ok) {
        return { ok: false, written: false, changed: [], errors: v.errors, warnings: v.warnings, configPath, resonanceCount: Object.keys(cfg.resonances).length }
      }
      const applied = applyResonanceAddition(cfg, args.proposal)
      if (applied.errors.length > 0) {
        return { ok: false, written: false, changed: [], errors: applied.errors, warnings: v.warnings, configPath, resonanceCount: Object.keys(cfg.resonances).length }
      }
      const rendered = dumpConfig(applied.config)
      // Atomic write: backup, tmp file, rename.
      const backupPath = `${configPath}.bak`
      copyFileSync(configPath, backupPath)
      const tmpPath = join(dirname(configPath), `.config.yml.tmp-${Date.now().toString(36)}`)
      writeFileSync(tmpPath, rendered)
      renameSync(tmpPath, configPath)
      const xref = crossReferenceErrors(applied.config)
      return {
        ok: true,
        written: true,
        changed: applied.changed,
        errors: [],
        warnings: [...v.warnings, ...xref.warnings],
        configPath,
        backupPath,
        resonanceCount: Object.keys(applied.config.resonances).length,
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_round（一步化主路径：评估上轮 + 迭代 + 提交）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_round',
    description: '一轮完整迭代（主路径，一次调用）：自动评估上一轮拟合（NLL、ΔNLL、pull 诊断）→ 若提供 proposal 则物理验证（0 errors 才继续）→ 创建新迭代目录 → 写入 config.yml → 提交后台拟合。模型每轮只需：决定 proposal（加/挂什么共振态）或省略 proposal 做纯评估。内部机械链全部原子化，禁止也不用自己写脚本。',
    parameters: {
      baseIterDir: { type: 'string', required: true, description: '上一轮迭代目录（如 .../iterations/iter-004），其 config.yml 为基座、results/ 被评估' },
      proposal: { ...proposalParam, description: '要添加/挂载的共振态（省略 = 纯评估模式，不创建新轮）' },
      fitScriptPath: { type: 'string', description: 'fit.py 来源（默认 solve2）' },
      plotScriptPath: { type: 'string', description: 'plot.py 来源（默认 solve2）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, enum: ['evaluate-only', 'iterate'] },
          iter: { type: 'integer', required: true },
          iterDir: { type: 'string', required: true },
          jobId: { type: 'string' },
          nll: { type: 'number' },
          deltaNll: { type: 'number' },
          hessianPositive: { type: 'boolean' },
          worst: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                max_abs_pull: { type: 'number', required: true },
                chi2_ndf: { type: 'number' },
                bins_over_5sigma: { type: 'integer', required: true },
              },
            },
          },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          errors: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          warnings: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          convergenceHint: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        mode: 'evaluate-only' | 'iterate'
        iter: number
        iterDir: string
        jobId?: string
        nll?: number
        deltaNll?: number
        hessianPositive?: boolean
        worst?: { name: string; max_abs_pull: number; chi2_ndf?: number; bins_over_5sigma: number }[]
        changed: string[]
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
        convergenceHint?: string
      }) => {
        const lines: string[] = []
        if (value.nll !== undefined) {
          const d = value.deltaNll === undefined ? '' : `（ΔNLL=${value.deltaNll > 0 ? '+' : ''}${value.deltaNll.toFixed(2)}）`
          lines.push(`上轮评估: NLL=${value.nll.toFixed(2)}${d}${value.hessianPositive === false ? ' ⚠️Hessian 不正定' : ''}`)
        }
        if (value.worst && value.worst.length > 0) {
          lines.push('worst 分布: ' + value.worst.slice(0, 3).map((w) => `${w.name} (pull=${w.max_abs_pull})`).join(', '))
        }
        if (value.convergenceHint) lines.push(`收敛提示: ${value.convergenceHint}`)
        if (!value.ok) {
          lines.push(`迭代未执行（${value.errors.length} errors）:`)
          lines.push(...value.errors.map((e) => `  [error] ${e.code}: ${e.message}`))
          return text(lines.join('\n'))
        }
        if (value.mode === 'evaluate-only') {
          lines.push('（纯评估模式，未创建新迭代）')
        } else {
          lines.push(`iter-${String(value.iter).padStart(3, '0')} 已创建并提交拟合（job ${value.jobId}）:`)
          lines.push(...value.changed.map((c) => '  ' + c))
          if (value.warnings.length > 0) lines.push(...value.warnings.slice(0, 3).map((w) => `  [warn] ${w.message}`))
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { baseIterDir: string; proposal?: ResonanceProposal; fitScriptPath?: string; plotScriptPath?: string }, exec) {
      const baseConfig = `${args.baseIterDir}/config.yml`
      const iterationsRoot = iterationsRootOf(args.baseIterDir)
      const errors: { code: string; message: string }[] = []
      const warnings: { code: string; message: string }[] = []
      const changed: string[] = []
      const out: {
        ok: boolean
        mode: 'evaluate-only' | 'iterate'
        iter: number
        iterDir: string
        jobId?: string
        nll?: number
        deltaNll?: number
        hessianPositive?: boolean
        worst?: { name: string; max_abs_pull: number; chi2_ndf?: number; bins_over_5sigma: number }[]
        changed: string[]
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
        convergenceHint?: string
      } = { ok: false, mode: 'evaluate-only', iter: -1, iterDir: '', changed, errors, warnings }

      // ---- 1. evaluate the previous round ----
      const baseCfgExists = fsExists(baseConfig)
      if (baseCfgExists) {
        const { summary, history } = summarizeFitDir(args.baseIterDir)
        if (summary.bestNll !== null) out.nll = summary.bestNll
        if (history.lastNll !== null) out.nll = out.nll ?? history.lastNll
        if (summary.positiveDefinite !== null) out.hessianPositive = summary.positiveDefinite
        const rootFile = `${args.baseIterDir}/results/weight_best.root`
        if (fsExists(rootFile)) {
          try {
            const evalDir = `${resolveEnv().evaluateOutDir}/round-${Date.now().toString(36)}`
            const script = new URL('../scripts/auto_pwa_evaluate.py', import.meta.url).pathname
            const py = defaultFitRunnerConfig().python
            const r = spawnSync(py, [script, rootFile, evalDir], { encoding: 'utf8', timeout: 120_000 })
            if (r.status === 0 && fsExists(`${evalDir}/evaluate.json`)) {
              const ev = JSON.parse(readFileSync(`${evalDir}/evaluate.json`, 'utf8'))
              out.worst = (ev.worst_distributions ?? []).slice(0, 3).map((w: { name: string; max_abs_pull: number; chi2_ndf?: number; bins_over_5sigma: number }) => ({
                name: w.name,
                max_abs_pull: w.max_abs_pull,
                chi2_ndf: w.chi2_ndf,
                bins_over_5sigma: w.bins_over_5sigma,
              }))
            }
          } catch {
            // evaluation is best-effort
          }
        }
        // deltaNll vs previous diary record
        try {
          const log = new IterationLog({ rootDir: iterationsRoot })
          const prev = log.readAll().filter((rec) => rec.iter !== Number(/iter-(\d+)/.exec(args.baseIterDir)?.[1] ?? -1))
          const last = prev[prev.length - 1]
          if (last?.nll !== undefined && out.nll !== undefined) out.deltaNll = out.nll - last.nll
        } catch {
          // diary may be empty
        }
        const worst = out.worst ?? []
        const maxPull = Math.max(...worst.map((w) => w.max_abs_pull), 0)
        if (out.worst && maxPull < 5 && (out.deltaNll === undefined || Math.abs(out.deltaNll) < 10)) {
          out.convergenceHint = 'max|pull| < 5 且 ΔNLL < 10：满足收敛判据，可考虑停止迭代'
        }
      } else {
        errors.push({ code: 'no-base-config', message: `基座 config 不存在: ${baseConfig}` })
      }

      // ---- 2. iterate when a proposal is given ----
      if (args.proposal && baseCfgExists) {
        out.mode = 'iterate'
        const cfg = parseConfig(readFileSync(baseConfig, 'utf8'))
        const v = validateResonanceAddition(defaultDb, cfg, args.proposal)
        warnings.push(...v.warnings)
        if (!v.ok) {
          errors.push(...v.errors)
          return out
        }
        let started: { iterDir: string; iter: number; changed: string[] }
        try {
          started = startIteration({
            iterationsRoot,
            baseConfigPath: baseConfig,
            fitScriptPath: args.fitScriptPath ?? '/home/whitewash/pwa/Jpsi2KKeta/solve2/fit.py',
            plotScriptPath: args.plotScriptPath ?? '/home/whitewash/pwa/Jpsi2KKeta/solve2/plot.py',
          })
        } catch (e) {
          errors.push({ code: 'iter-start-failed', message: (e as Error).message })
          return out
        }
        changed.push(...started.changed)
        out.iter = started.iter
        out.iterDir = started.iterDir
        const newCfg = parseConfig(readFileSync(`${started.iterDir}/config.yml`, 'utf8'))
        const applied = applyResonanceAddition(newCfg, args.proposal)
        if (applied.errors.length > 0) {
          errors.push(...applied.errors)
          return out
        }
        const target = `${started.iterDir}/config.yml`
        copyFileSync(target, `${target}.bak`)
        const tmp = `${target}.tmp-${Date.now().toString(36)}`
        writeFileSync(tmp, dumpConfig(applied.config))
        renameSync(tmp, target)
        changed.push(...applied.changed)
        const xref = crossReferenceErrors(applied.config)
        warnings.push(...xref.warnings)
        try {
          out.jobId = ctx.pwaFit.submit({ iterDir: started.iterDir }, ownerOf(exec))
        } catch (e) {
          errors.push({ code: 'fit-submit-failed', message: (e as Error).message })
          return out
        }
      }
      out.ok = errors.length === 0
      return out
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_iter_start
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_iter_start',
    description: '创建下一轮迭代目录 iterations/iter-N/：复制基座 config.yml，软链 fit.py/plot.py，写 note.md 骨架。返回新目录路径。每轮拟合前先调用它。',
    parameters: {
      iterationsRoot: { type: 'string', required: true, description: 'iterations/ 目录（如 /home/whitewash/pwa/Jpsi2KKeta/iterations）' },
      baseConfigPath: { type: 'string', required: true, description: '本轮基座 config.yml（上一轮的 config 或 solve2/config.yml）' },
      fitScriptPath: { type: 'string', description: 'fit.py 来源（默认 solve2/fit.py）' },
      plotScriptPath: { type: 'string', description: 'plot.py 来源（默认 solve2/plot.py）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iter: { type: 'integer', required: true },
          iterDir: { type: 'string', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { iter: number; iterDir: string; changed: string[]; error?: string }) =>
        text(value.error ? `迭代目录创建失败: ${value.error}` : `iter-${String(value.iter).padStart(3, '0')}: ${value.iterDir}\n${value.changed.map((c) => '  ' + c).join('\n')}`),
    },
    async execute(args: { iterationsRoot: string; baseConfigPath: string; fitScriptPath?: string; plotScriptPath?: string }) {
      try {
        const r = startIteration(args)
        return { iter: r.iter, iterDir: r.iterDir, changed: r.changed }
      } catch (e) {
        return { iter: -1, iterDir: '', changed: [], error: (e as Error).message }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_note
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_note',
    description: '把本轮迭代的结论写入迭代日记（SUMMARY.jsonl + 重渲染 HTML 日记页）。结论（conclusion/nextPlan）会持久化，下一轮开始时用 auto_pwa_history 读取——这是"拟合结论传给下一步"的通道。',
    parameters: {
      iterDir: { type: 'string', required: true, description: '本轮迭代目录（如 .../iterations/iter-001）' },
      title: { type: 'string', required: true, description: '本轮决策一句话（如 "添加 rho(1450) 到 R_KK [1-]"）' },
      kind: { type: 'string', required: true, enum: ['added', 'removed', 'float', 'converged', 'other'] as const, description: '决策类型' },
      nll: { type: 'number', description: '最佳 NLL' },
      deltaNll: { type: 'number', description: '相对上一轮 NLL 变化（改进为负）' },
      hessianPositive: { type: 'boolean', description: '最佳 run 的 Hessian 是否正定' },
      changes: { type: 'array', items: { type: 'string' }, description: 'config 变更列表（来自 auto_pwa_edit_config.changed）' },
      warnings: { type: 'array', items: { type: 'string' }, description: '验证警告' },
      floatDecision: { type: 'string', description: '参数 float 决策' },
      conclusion: { type: 'string', required: true, description: '本轮结论：拟合好坏判断 + 诊断要点（模型自己写）' },
      nextPlan: { type: 'string', description: '下一步计划（加/删什么共振态，float 策略）' },
      evidence: { type: 'string', description: '证据引用（如 evaluate.json 路径）' },
      notes: { type: 'array', items: { type: 'string' }, description: '自由笔记行' },
      includeTokens: { type: 'boolean', description: 'true 时把本轮 token 消耗（上次记账以来的差值）写进记录（token-meter 成本追踪；每轮建议开启）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          iter: { type: 'integer', required: true },
          summaryPath: { type: 'string', required: true },
          records: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) =>
        text(value.ok ? `已记录第 ${value.iter} 轮 → ${value.summaryPath}（共 ${value.records} 轮）` : `记录失败: ${value.error ?? '未知'}`),
    },
    async execute(args: {
      iterDir: string
      title: string
      kind: 'added' | 'removed' | 'float' | 'converged' | 'other'
      nll?: number
      deltaNll?: number
      hessianPositive?: boolean
      changes?: string[]
      warnings?: string[]
      floatDecision?: string
      conclusion: string
      nextPlan?: string
      evidence?: string
      notes?: string[]
      /** 记入本轮 token 消耗（token-meter：上次记账以来的差值）。 */
      includeTokens?: boolean
    }, exec) {
      const root = iterationsRootOf(args.iterDir)
      const m = /iter-(\d+)/.exec(args.iterDir)
      if (!m) return { ok: false, iter: -1, summaryPath: '', records: 0, error: `iterDir 不含 iter-N: ${args.iterDir}` }
      const log = new IterationLog({ rootDir: root })
      const record: IterationRecord = {
        iter: Number(m[1]),
        timestamp: new Date().toISOString(),
        title: args.title,
        kind: args.kind,
        configPath: `${args.iterDir}/config.yml`,
        iterDir: args.iterDir,
        nll: args.nll,
        deltaNll: args.deltaNll,
        hessianPositive: args.hessianPositive,
        changes: args.changes,
        warnings: args.warnings,
        floatDecision: args.floatDecision,
        conclusion: args.conclusion,
        nextPlan: args.nextPlan,
        evidence: args.evidence,
        notes: args.notes,
      }
      if (args.includeTokens === true && exec.agent?.sessionId !== undefined) {
        const t: TokenTotals = usage.takeDelta(exec.agent.sessionId)
        record.tokens = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }
      }
      try {
        log.append(record)
        return { ok: true, iter: record.iter, summaryPath: log.summaryPath, records: log.readAll().length }
      } catch (e) {
        return { ok: false, iter: record.iter, summaryPath: log.summaryPath, records: 0, error: (e as Error).message }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_history
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_history',
    description: '读取迭代日记（iterations/SUMMARY.jsonl）的全部记录：每轮的决策、NLL、ΔNLL、结论与下一步计划。新一轮决策前必读——它是"上一轮结论 → 本轮方向"的输入。',
    parameters: {
      iterationsRoot: { type: 'string', required: true, description: 'iterations/ 目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                iter: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                nll: { type: 'number' },
                deltaNll: { type: 'number' },
                hessianPositive: { type: 'boolean' },
                changes: { type: 'array', items: { type: 'string' } },
                conclusion: { type: 'string' },
                nextPlan: { type: 'string' },
                evidence: { type: 'string' },
                tokens: { type: 'object', additionalProperties: false, properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } } },
              },
            },
          },
          nextIter: { type: 'integer', required: true },
          iterDirs: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value: {
        records: { iter: number; title: string; kind: string; nll?: number; deltaNll?: number; conclusion?: string; nextPlan?: string; tokens?: { input: number; output: number } }[]
        nextIter: number
        iterDirs: string[]
      }) => {
        if (value.records.length === 0) return text('（迭代日记为空）')
        const lines = value.records.map((r) => {
          const d = r.deltaNll === undefined ? '' : ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(1)}`
          const t = r.tokens ? ` [tokens: ${r.tokens.input}+${r.tokens.output}]` : ''
          const c = r.conclusion ? ` | 结论: ${r.conclusion.slice(0, 120)}` : ''
          const p = r.nextPlan ? ` | 下一步: ${r.nextPlan.slice(0, 120)}` : ''
          return `iter-${String(r.iter).padStart(3, '0')} ${r.title}${d}${t}${c}${p}`
        })
        return text(`迭代历史（${value.records.length} 轮，下一轮 iter-${String(value.nextIter).padStart(3, '0')}）:\n${lines.join('\n')}`)
      },
    },
    async execute(args: { iterationsRoot: string }) {
      const log = new IterationLog({ rootDir: args.iterationsRoot })
      const records = log.readAll().map((r) => {
        const out: {
          iter: number
          title: string
          kind: string
          nll?: number
          deltaNll?: number
          hessianPositive?: boolean
          changes?: string[]
          conclusion?: string
          nextPlan?: string
          evidence?: string
          tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
        } = { iter: r.iter, title: r.title, kind: r.kind }
        if (r.nll !== undefined) out.nll = r.nll
        if (r.deltaNll !== undefined) out.deltaNll = r.deltaNll
        if (r.hessianPositive !== undefined) out.hessianPositive = r.hessianPositive
        if (r.changes !== undefined) out.changes = r.changes
        if (r.conclusion !== undefined) out.conclusion = r.conclusion
        if (r.nextPlan !== undefined) out.nextPlan = r.nextPlan
        if (r.evidence !== undefined) out.evidence = r.evidence
        if (r.tokens !== undefined) out.tokens = r.tokens
        return out
      })
      return { records, nextIter: log.nextIter(), iterDirs: listIterations(args.iterationsRoot) }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_iterate（复合工具：防偏离核心——机械链原子化）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_iterate',
    description: '一轮完整迭代（复合操作，模型只需决策提议什么）：以上一轮迭代目录为基座 → 物理验证提案（0 errors 才继续）→ 创建新迭代目录 → 写入 config.yml → 提交后台拟合。一次调用完成 iter_start+edit_config+run_fit 的全部机械步骤，内部强约束，模型无需也不能干预中间过程。评估上轮结果用 auto_pwa_evaluate，记录结论用 auto_pwa_note。',
    parameters: {
      baseIterDir: { type: 'string', required: true, description: '上一轮迭代目录（如 .../iterations/iter-000），其 config.yml 作为本轮基座' },
      proposal: proposalParam,
      fitScriptPath: { type: 'string', description: 'fit.py 来源（默认 /home/whitewash/pwa/Jpsi2KKeta/solve2/fit.py）' },
      plotScriptPath: { type: 'string', description: 'plot.py 来源（默认 /home/whitewash/pwa/Jpsi2KKeta/solve2/plot.py）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          iter: { type: 'integer', required: true },
          iterDir: { type: 'string', required: true },
          jobId: { type: 'string' },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          errors: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          warnings: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
        },
      },
      render: (_args, value: {
        ok: boolean
        iter: number
        iterDir: string
        jobId?: string
        changed: string[]
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
      }) => {
        if (!value.ok) {
          return text(`迭代未执行（${value.errors.length} errors）:\n${value.errors.map((e) => `  [error] ${e.code}: ${e.message}`).join('\n')}`)
        }
        return text(`iter-${String(value.iter).padStart(3, '0')} 已创建并提交拟合（job ${value.jobId}）:\n${value.changed.map((c) => '  ' + c).join('\n')}${value.warnings.length > 0 ? '\n' + value.warnings.slice(0, 3).map((w) => `  [warn] ${w.message}`).join('\n') : ''}`)
      },
    },
    async execute(args: { baseIterDir: string; proposal: ResonanceProposal; fitScriptPath?: string; plotScriptPath?: string }, exec) {
      const baseConfig = `${args.baseIterDir}/config.yml`
      const iterationsRoot = iterationsRootOf(args.baseIterDir)
      if (!fsExistsSync(baseConfig)) {
        return { ok: false, iter: -1, iterDir: '', changed: [], errors: [{ code: 'no-base-config', message: `基座 config 不存在: ${baseConfig}` }], warnings: [] }
      }
      // 1. validate against the base config
      const cfg = parseConfig(readFileSync(baseConfig, 'utf8'))
      const v = validateResonanceAddition(defaultDb, cfg, args.proposal)
      if (!v.ok) {
        return { ok: false, iter: -1, iterDir: '', changed: [], errors: v.errors, warnings: v.warnings }
      }
      // 2. new iteration dir (config copied + Data paths absolutized)
      let started: { iterDir: string; iter: number; changed: string[] }
      try {
        started = startIteration({
          iterationsRoot,
          baseConfigPath: baseConfig,
          fitScriptPath: args.fitScriptPath ?? resolveEnv().fitScript,
          plotScriptPath: args.plotScriptPath ?? resolveEnv().plotScript,
        })
      } catch (e) {
        return { ok: false, iter: -1, iterDir: '', changed: [], errors: [{ code: 'iter-start-failed', message: (e as Error).message }], warnings: [] }
      }
      // 3. apply + write config in the new dir
      const newCfg = parseConfig(readFileSync(`${started.iterDir}/config.yml`, 'utf8'))
      const applied = applyResonanceAddition(newCfg, args.proposal)
      if (applied.errors.length > 0) {
        return { ok: false, iter: started.iter, iterDir: started.iterDir, changed: started.changed, errors: applied.errors, warnings: v.warnings }
      }
      const target = `${started.iterDir}/config.yml`
      copyFileSync(target, `${target}.bak`)
      const tmp = `${target}.tmp-${Date.now().toString(36)}`
      writeFileSync(tmp, dumpConfig(applied.config))
      renameSync(tmp, target)
      const xref = crossReferenceErrors(applied.config)
      // 4. submit fit
      let jobId: string | undefined
      try {
        jobId = ctx.pwaFit.submit({ iterDir: started.iterDir }, ownerOf(exec))
      } catch (e) {
        return {
          ok: false,
          iter: started.iter,
          iterDir: started.iterDir,
          changed: [...started.changed, ...applied.changed],
          errors: [{ code: 'fit-submit-failed', message: (e as Error).message }],
          warnings: [...v.warnings, ...xref.warnings],
        }
      }
      return {
        ok: true,
        iter: started.iter,
        iterDir: started.iterDir,
        jobId,
        changed: [...started.changed, ...applied.changed],
        errors: [],
        warnings: [...v.warnings, ...xref.warnings],
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_evaluate
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_evaluate',
    description: '把 weight_best.root 转成 AI 可读的数值评估包：每个分布（mass/cosbeta）的 chi2/ndf、max|pull|、>3σ/>5σ bin 数、偏差区域、每个分波占总拟合的份额。数值化是 AI 判断拟合好坏的主通道（当前模型不能直接看图）；PNG 图同时生成供人阅读。',
    parameters: {
      rootPath: { type: 'string', required: true, description: 'weight_best.root 绝对路径' },
      outDir: { type: 'string', description: '评估输出目录（默认 root 同目录下的 evaluate/）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          evaluateJsonPath: { type: 'string', required: true },
          worst: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                max_abs_pull: { type: 'number', required: true },
                chi2_ndf: { type: 'number' },
                bins_over_5sigma: { type: 'integer', required: true },
              },
            },
          },
          distributions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                chi2_ndf: { type: 'number' },
                max_abs_pull: { type: 'number' },
                bins_over_5sigma: { type: 'integer' },
                bins_over_3sigma: { type: 'integer' },
                pull_regions_over_3sigma: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                worst_bin: { type: 'object', additionalProperties: false, properties: { center: { type: 'number' }, pull: { type: 'number' } } },
              },
            },
          },
          pngFiles: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
          spilled: {
            type: 'object',
            additionalProperties: false,
            properties: {
              locator: { type: 'string' },
              bytes: { type: 'integer' },
              retrievalHint: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`评估失败: ${value.error ?? '未知错误'}`)
        const lines = ['拟合质量评估（按最差排序）:']
        for (const w of value.worst) {
          lines.push(
            `  ${w.name}: chi2/ndf=${w.chi2_ndf ?? '—'}, max|pull|=${w.max_abs_pull}, ` +
              `>5σ bins=${w.bins_over_5sigma}${w.max_abs_pull > 5 ? ' ⚠️严重' : w.max_abs_pull > 3 ? ' ⚠️' : ''}`,
          )
        }
        lines.push(`评估 JSON: ${value.evaluateJsonPath}`)
        if (value.pngFiles && value.pngFiles.length > 0) lines.push(`PNG 图: ${value.pngFiles.length} 张`)
        if (value.spilled) lines.push(`（完整输出已 spill: ${value.spilled.locator} — ${value.spilled.retrievalHint}）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { rootPath: string; outDir?: string }, exec) {
      const script = new URL('../scripts/auto_pwa_evaluate.py', import.meta.url).pathname
      const outDir = args.outDir ?? `${dirname(args.rootPath)}/evaluate`
      const py = defaultFitRunnerConfig().python
      const r = spawnSync(py, [script, args.rootPath, outDir], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env },
      })
      if (r.status !== 0) {
        return {
          ok: false,
          evaluateJsonPath: '',
          worst: [],
          error: (r.stderr || r.stdout || '').slice(0, 500),
        }
      }
      const { existsSync } = await import('node:fs')
      const jsonPath = `${outDir}/evaluate.json`
      if (!existsSync(jsonPath)) {
        return { ok: false, evaluateJsonPath: jsonPath, worst: [], error: 'evaluate.json not produced' }
      }
      const ev = JSON.parse(readFileSync(jsonPath, 'utf8'))
      // Map ONLY the schema-declared fields; spreading raw JSON would leak
      // undeclared keys and fail the additionalProperties:false check.
      const distributions: {
        name: string
        chi2_ndf?: number
        max_abs_pull?: number
        bins_over_5sigma?: number
        bins_over_3sigma?: number
        pull_regions_over_3sigma?: number[][]
        worst_bin?: { center?: number; pull?: number }
      }[] = []
      for (const [name, d] of Object.entries(ev.distributions ?? {})) {
        if (d === null || typeof d !== 'object') continue
        const item: (typeof distributions)[number] = { name }
        const rec = d as Record<string, unknown>
        for (const k of ['chi2_ndf', 'max_abs_pull', 'bins_over_5sigma', 'bins_over_3sigma', 'pull_regions_over_3sigma', 'worst_bin'] as const) {
          if (typeof rec[k] === 'number' || typeof rec[k] === 'object') (item as Record<string, unknown>)[k] = rec[k]
        }
        distributions.push(item)
      }
      const pngs = existsSync(outDir) ? (await import('node:fs')).readdirSync(outDir).filter((f) => f.endsWith('.png')) : []
      const out = {
        ok: true,
        evaluateJsonPath: jsonPath,
        worst: ev.worst_distributions ?? [],
        distributions,
        pngFiles: pngs,
      }
      // The full numeric payload stays on disk (evaluate.json); when the
      // mapped summary itself grows large, spill it for on-demand reads.
      const ref = await maybeSpill(ctx, exec, 'auto_pwa_evaluate', JSON.stringify(out), null)
      return ref === null ? out : { ...out, spilled: ref }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_run_fit（Consumer：经 ctx.pwaFit -> ctx.jobs 提交）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_run_fit',
    description: '在迭代目录提交拟合（pwa-fit-local 经 ctx.jobs 启动 ctpwa env 的 python fit.py，注入 ROOT/CUDA/torch 库路径）。返回 jobId（ctpwa-N），完成时 DSH 会自动通知（background job ctpwa-N finished），用 auto_pwa_fit_status 或 job_output 查结果。无 GPU 时立即失败并给出诊断。',
    parameters: {
      iterDir: { type: 'string', required: true, description: '迭代目录绝对路径（须含 fit.py 与 config.yml）' },
      timeoutMs: { type: 'integer', description: '超时毫秒，超过则终止（默认无）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['running', 'done', 'failed', 'canceled'] },
          logPath: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.error ? `拟合提交失败: ${value.error}` : `拟合已提交: job ${value.jobId} (${value.state}), 日志: ${value.logPath}`),
    },
    async execute(args: { iterDir: string; timeoutMs?: number }, exec) {
      try {
        const jobId = ctx.pwaFit.submit(
          { iterDir: args.iterDir, timeoutMin: args.timeoutMs !== undefined ? Math.ceil(args.timeoutMs / 60_000) : undefined },
          ownerOf(exec),
        )
        return { jobId, state: 'running' as const, logPath: join(args.iterDir, 'fit.log') }
      } catch (e) {
        return { jobId: '', state: 'failed' as const, logPath: join(args.iterDir, 'fit.log'), error: (e as Error).message }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_fit_status
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_fit_status',
    description: '查询拟合任务状态：running/done/failed，附日志尾部；拟合完成后解析 results/ 给出最佳 NLL、迭代数、正定性等摘要。',
    parameters: {
      jobId: { type: 'string', required: true, description: 'auto_pwa_run_fit 返回的 jobId' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['running', 'done', 'failed', 'canceled'] },
          exitCode: { type: 'integer' },
          error: { type: 'string' },
          logTail: { type: 'string', required: true },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bestNll: { type: 'number' },
              lastNll: { type: 'number' },
              totalRuns: { type: 'integer' },
              positiveDefinite: { type: 'boolean' },
              files: { type: 'array', items: { type: 'string' } },
              params: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    kind: { type: 'string' },
                    value: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                    error: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                    lower: { type: 'number' },
                    upper: { type: 'number' },
                    atBoundary: { type: 'boolean' },
                    real: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                    imag: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  },
                },
              },
              fitFractions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    amplitude: { type: 'string' },
                    fraction: { type: 'number' },
                    error: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  },
                },
              },
              warnings: { type: 'array', items: { type: 'string' } },
              interference: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  available: { type: 'boolean' },
                  reason: { type: 'string' },
                  totalIntensity: { type: 'number' },
                  topInterference: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        pair: { type: 'array', items: { type: 'string' } },
                        value: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value: {
        jobId: string
        state: string
        exitCode?: number
        error?: string
        logTail: string
        summary?: {
          bestNll?: number
          lastNll?: number
          totalRuns?: number
          positiveDefinite?: boolean
          files?: string[]
          params?: { name: string; kind?: string; value?: number | null; error?: number | null; lower?: number; upper?: number; atBoundary?: boolean; real?: number | null; imag?: number | null }[]
          fitFractions?: { amplitude: string; fraction: number; error?: number | null }[]
          warnings?: string[]
          interference?: { available: boolean; reason?: string; totalIntensity?: number; topInterference?: { pair: string[]; value: number }[] }
        }
      }) => {
        const lines = [`job ${value.jobId}: ${value.state}${value.exitCode !== undefined ? ` (exit ${value.exitCode})` : ''}`]
        if (value.error) lines.push(`  error: ${value.error}`)
        if (value.summary) {
          const s = value.summary
          lines.push(`  最佳 NLL: ${s.bestNll ?? '-'}${s.totalRuns !== undefined ? `（${s.totalRuns} 次运行）` : ''}${s.positiveDefinite !== undefined ? `, Hessian 正定: ${s.positiveDefinite}` : ''}`)
          lines.push(`  最后 NLL: ${s.lastNll ?? '-'}`)
          const resParams = (s.params ?? []).filter((p) => p.kind === 'resonance')
          if (resParams.length > 0) {
            lines.push('  共振态参数:')
            for (const p of resParams) {
              lines.push(
                `    ${p.name} = ${p.value?.toFixed(6) ?? '—'}${p.error !== undefined && p.error !== null ? ` ± ${p.error.toFixed(6)}` : ''}` +
                  `${p.atBoundary ? ' ⚠️撞边界' : ''}${p.lower !== undefined && p.upper !== undefined ? ` [${p.lower.toFixed(4)}, ${p.upper.toFixed(4)}]` : ''}`,
              )
            }
          }
          const fractions = s.fitFractions ?? []
          if (fractions.length > 0) {
            const top = [...fractions].sort((a, b) => b.fraction - a.fraction).slice(0, 6)
            lines.push(`  分波贡献 (top ${top.length}):`)
            for (const f of top) lines.push(`    ${f.amplitude}: ${(f.fraction * 100).toFixed(1)}%${f.error !== undefined && f.error !== null ? ` ± ${(f.error * 100).toFixed(1)}%` : ''}`)
            if (fractions.length > top.length) lines.push(`    … 共 ${fractions.length} 个分波`)
          }
          for (const w of s.warnings ?? []) lines.push(`  [warn] ${w}`)
          const inter = s.interference
          if (inter) {
            if (inter.available) {
              lines.push('  干涉摘要 (top):')
              for (const t of (inter.topInterference ?? []).slice(0, 5)) {
                lines.push(`    ${t.pair[0]} <-> ${t.pair[1]}: ${t.value >= 0 ? '+' : ''}${(t.value * 100).toFixed(1)}%`)
              }
            } else {
              lines.push(`  [warn] 干涉矩阵不可用: ${inter.reason ?? 'unknown'}`)
            }
          }
          if (s.files) lines.push(`  results/: ${s.files.join(', ')}`)
        }
        const tail = value.logTail.trim().split('\n').slice(-6).map((l) => `  | ${l}`).join('\n')
        if (tail) lines.push(`  日志尾部:\n${tail}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { jobId: string }, exec) {
      let view: import('./pwa-fit.js').FitStatusView
      try {
        view = ctx.pwaFit.status(args.jobId, ownerOf(exec))
      } catch (e) {
        return { jobId: args.jobId, state: 'failed' as const, logTail: '', error: (e as Error).message }
      }
      const out: {
        jobId: string
        state: 'running' | 'done' | 'failed' | 'canceled'
        exitCode?: number
        error?: string
        logTail: string
        summary?: {
          bestNll?: number
          lastNll?: number
          totalRuns?: number
          positiveDefinite?: boolean
          files: string[]
          params?: { name: string; kind: string; value?: number | null; error?: number | null; lower?: number; upper?: number; atBoundary?: boolean; real?: number | null; imag?: number | null }[]
          fitFractions?: { amplitude: string; fraction: number; error?: number | null }[]
          warnings?: string[]
          interference?: { available: boolean; reason?: string; totalIntensity?: number; topInterference?: { pair: string[]; value: number }[] }
        }
      } = {
        jobId: view.jobId,
        state: view.state,
        logTail: view.logTail,
      }
      if (view.exitCode !== undefined) out.exitCode = view.exitCode
      if (view.error !== undefined) out.error = view.error
      if ((view.state === 'done' || view.state === 'failed') && view.iterDir !== '') {
        try {
          const { summary, history, files, fitJson } = summarizeFitDir(view.iterDir)
          out.summary = {
            bestNll: summary.bestNll ?? undefined,
            lastNll: history.lastNll ?? undefined,
            totalRuns: summary.totalRuns ?? undefined,
            positiveDefinite: summary.positiveDefinite ?? undefined,
            files,
          }
          const best = fitJson?.fit?.best
          if (best !== undefined) {
            const params = (best.params ?? [])
              .filter((p) => p.kind === 'resonance' || p.kind === 'coupling')
              .map((p) => ({
                name: p.name,
                kind: p.kind,
                ...(p.kind === 'resonance'
                  ? { value: p.value ?? null, error: p.error ?? null, lower: p.lower, upper: p.upper, atBoundary: p.atBoundary }
                  : { real: p.real ?? null, imag: p.imag ?? null }),
              }))
            if (params.length > 0) out.summary.params = params
            if (best.fitFractions !== undefined && best.fitFractions !== null) {
              out.summary.fitFractions = best.fitFractions.map((f) => ({ amplitude: f.amplitude, fraction: f.fraction, error: f.error ?? null }))
            }
            if (fitJson?.fit?.warnings !== undefined) out.summary.warnings = fitJson.fit.warnings
            const inter = fitJson?.fit?.interference
            if (inter !== undefined) {
              out.summary.interference = {
                available: inter.available,
                reason: inter.reason,
                totalIntensity: inter.totalIntensity,
                topInterference: (inter.topInterference ?? []).map((t) => ({ pair: [...t.pair], value: t.value })),
              }
            }
          }
        } catch {
          // results/ may be absent on early failure; summary stays undefined.
        }
      }
      return out
    },
  }))
}
