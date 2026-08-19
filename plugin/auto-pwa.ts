/**
 * dsh-pwa plugin: auto_pwa_* tools for partial-wave analysis in the DeepSeek
 * Harness. Thin wrappers over the pure core in ../src — the strong
 * constraints (physics validation, YAML rendering, atomic writes) live in the
 * core; this file only declares the model-facing surface.
 *
 * Mount via:  pnpm dsh web --patch /home/whitewash/dsh-pwa/patch/auto-pwa.cordis.yml
 *
 * Tools:
 *   auto_pwa_lookup        query the PDG resonance table
 *   auto_pwa_decay_check   allowed intermediate J^P for A -> R + B, + candidates
 *   auto_pwa_validate_add  gate a resonance addition (PDG/JPC/threshold/duplicate)
 *   auto_pwa_edit_config   validate + apply + render + atomically write config.yml
 *   auto_pwa_run_fit       submit a fit in an iteration dir (background job)
 *   auto_pwa_fit_status    poll a fit job and summarize results/
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDb } from '../src/db.js'
import { lookupResonance } from '../src/lookup.js'
import { decayCheck } from '../src/decay-check.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { parseConfig, applyResonanceAddition, dumpConfig, crossReferenceErrors } from '../src/config-edit.js'
import { suggestFree } from '../src/float-policy.js'
import { LocalFitRunner, defaultFitRunnerConfig } from '../src/fit-runner.js'
import { summarizeFitDir } from '../src/fit-summary.js'
import { resolveEnv } from '../src/config.js'
import { existsSync as fsExists } from 'node:fs'
import { IterationLog, startIteration, iterationsRootOf, listIterations } from '../src/iteration-log.js'
import { existsSync as fsExistsSync } from 'node:fs'
import type { IterationRecord } from '../src/report.js'
import { spawnSync } from 'node:child_process'
import type { JP, ResonanceProposal } from '../src/types.js'

export const name = 'auto-pwa'
export const inject = ['tools']

const text = (t: string) => [{ type: 'text' as const, text: t }]

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
  const runner = new LocalFitRunner(defaultFitRunnerConfig())

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
    async execute(args: { baseIterDir: string; proposal?: ResonanceProposal; fitScriptPath?: string; plotScriptPath?: string }) {
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
          const status = runner.submit(started.iterDir)
          out.jobId = status.jobId
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
    }) {
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
              },
            },
          },
          nextIter: { type: 'integer', required: true },
          iterDirs: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value: {
        records: { iter: number; title: string; kind: string; nll?: number; deltaNll?: number; conclusion?: string; nextPlan?: string }[]
        nextIter: number
        iterDirs: string[]
      }) => {
        if (value.records.length === 0) return text('（迭代日记为空）')
        const lines = value.records.map((r) => {
          const d = r.deltaNll === undefined ? '' : ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(1)}`
          const c = r.conclusion ? ` | 结论: ${r.conclusion.slice(0, 120)}` : ''
          const p = r.nextPlan ? ` | 下一步: ${r.nextPlan.slice(0, 120)}` : ''
          return `iter-${String(r.iter).padStart(3, '0')} ${r.title}${d}${c}${p}`
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
        } = { iter: r.iter, title: r.title, kind: r.kind }
        if (r.nll !== undefined) out.nll = r.nll
        if (r.deltaNll !== undefined) out.deltaNll = r.deltaNll
        if (r.hessianPositive !== undefined) out.hessianPositive = r.hessianPositive
        if (r.changes !== undefined) out.changes = r.changes
        if (r.conclusion !== undefined) out.conclusion = r.conclusion
        if (r.nextPlan !== undefined) out.nextPlan = r.nextPlan
        if (r.evidence !== undefined) out.evidence = r.evidence
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
    async execute(args: { baseIterDir: string; proposal: ResonanceProposal; fitScriptPath?: string; plotScriptPath?: string }) {
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
        const status = runner.submit(started.iterDir)
        jobId = status.jobId
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
        return text(lines.join('\n'))
      },
    },
    async execute(args: { rootPath: string; outDir?: string }) {
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
      return {
        ok: true,
        evaluateJsonPath: jsonPath,
        worst: ev.worst_distributions ?? [],
        distributions,
        pngFiles: pngs,
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_run_fit
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_run_fit',
    description: '在迭代目录提交拟合（spawn ctpwa env 的 python fit.py，注入 ROOT/CUDA/torch 库路径）。返回 jobId，用 auto_pwa_fit_status 轮询。无 GPU 时立即失败并给出诊断。',
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
    async execute(args: { iterDir: string; timeoutMs?: number }) {
      const status = runner.submit(args.iterDir, { timeoutMs: args.timeoutMs })
      const out: { jobId: string; state: 'running' | 'done' | 'failed' | 'canceled'; logPath: string; error?: string } = {
        jobId: status.jobId,
        state: status.state,
        logPath: join(args.iterDir, 'fit.log'),
      }
      if (status.error !== undefined) out.error = status.error
      return out
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
        summary?: { bestNll?: number; lastNll?: number; totalRuns?: number; positiveDefinite?: boolean; files?: string[] }
      }) => {
        const lines = [`job ${value.jobId}: ${value.state}${value.exitCode !== undefined ? ` (exit ${value.exitCode})` : ''}`]
        if (value.error) lines.push(`  error: ${value.error}`)
        if (value.summary) {
          const s = value.summary
          lines.push(`  最佳 NLL: ${s.bestNll ?? '-'}${s.totalRuns !== undefined ? `（${s.totalRuns} 次运行）` : ''}${s.positiveDefinite !== undefined ? `, Hessian 正定: ${s.positiveDefinite}` : ''}`)
          lines.push(`  最后 NLL: ${s.lastNll ?? '-'}`)
          if (s.files) lines.push(`  results/: ${s.files.join(', ')}`)
        }
        const tail = value.logTail.trim().split('\n').slice(-6).map((l) => `  | ${l}`).join('\n')
        if (tail) lines.push(`  日志尾部:\n${tail}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { jobId: string }) {
      const status = runner.status(args.jobId)
      if (!status) {
        return { jobId: args.jobId, state: 'failed' as const, logTail: '', error: `unknown job ${args.jobId}` }
      }
      const out: {
        jobId: string
        state: 'running' | 'done' | 'failed' | 'canceled'
        exitCode?: number
        error?: string
        logTail: string
        summary?: { bestNll?: number; lastNll?: number; totalRuns?: number; positiveDefinite?: boolean; files: string[] }
      } = {
        jobId: status.jobId,
        state: status.state,
        logTail: status.logTail,
      }
      if (status.exitCode !== null && status.exitCode !== undefined) out.exitCode = status.exitCode
      if (status.error !== undefined) out.error = status.error
      if (status.state === 'done' || status.state === 'failed') {
        const { summary, history, files } = summarizeFitDir(status.iterDir)
        out.summary = {
          bestNll: summary.bestNll ?? undefined,
          lastNll: history.lastNll ?? undefined,
          totalRuns: summary.totalRuns ?? undefined,
          positiveDefinite: summary.positiveDefinite ?? undefined,
          files,
        }
      }
      return out
    },
  }))
}
