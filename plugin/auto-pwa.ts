/**
 * auto-pwa plugin: auto_pwa_* tools for partial-wave analysis in the DeepSeek
 * Harness. Thin wrappers over the pure core in ../src — the strong
 * constraints (physics validation, YAML rendering, atomic writes) live in the
 * core; this file only declares the model-facing surface.
 *
 * Mount via:  pnpm dsh web --patch <auto-pwa>/patch/auto-pwa.bundle.yml
 *
 * Tools:
 *   auto_pwa_lookup        query the PDG resonance table
 *   auto_pwa_decay_check   allowed intermediate J^P for A -> R + B, + candidates
 *   auto_pwa_jpc_check     two-vertex J^PC check (decay ∩ production, C conservation)
 *   auto_pwa_config_view   read-only JSON view of config.yml
 *   auto_pwa_validate_add  gate a resonance addition (PDG/JPC/threshold/duplicate)
 *   auto_pwa_trans_suggest  generic isospin/CG ratios for Constraints.trans
 *   auto_pwa_validate_config  run-time gate preview (structure/JPC/C + ctpwa --validate-only)
 *   auto_pwa_edit_config   validate + apply + render + atomically write config.yml
 *   auto_pwa_run_fit       gate the config, record provenance, submit via ctx.pwaFit
 *   auto_pwa_fit_status    poll a fit job and summarize results/ (fit.json preferred)
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDb, dbIntegrity } from '../src/db.js'
import { conventionFor } from '../src/lineshape.js'
import { dbWithLocal } from '../src/local-states.js'
import { inferAction, reminderInjection, reminderLevelFromEnv } from '../src/reminder-set.js'
import { engineFingerprint } from '../src/git-log.js'
import { cValueOf, getParticleInfo } from '../src/particle-info.js'
import { lookupResonance, lookupC } from '../src/lookup.js'
import { decayCheck, hasDecayTo } from '../src/decay-check.js'
import { analyzeIntermediateJPC } from '../src/intermediate-jpc.js'
import { explicitJp } from '../src/jpc.js'
import { firstLevelTopologies, type TopologyCoverage } from '../src/topology.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import {
  parseConfig,
  applyResonanceAddition,
  applyResonanceRemoval,
  validateResonanceRemoval,
  dumpConfig,
  crossReferenceErrors,
  validateConfig,
} from '../src/config-edit.js'
import { suggestFree } from '../src/float-policy.js'
import { suggestTransRatios } from '../src/isospin.js'
import { gateConfig, productionCErrors, renderGate, type GateResult } from '../src/config-gate.js'
import {
  buildProvenance,
  writeProvenance,
  readProvenance,
  provenanceSummary,
  checkProvenanceDrift,
  initFromScriptArgs,
  type Provenance,
  type ProvenanceInit,
} from '../src/provenance.js'
import { defaultFitRunnerConfig, detectGpuAvailability, withConfigArg } from '../src/fit-runner.js'
import { hasSlurmClients, pickTransport } from '../src/fit-transport.js'
import { summarizeFitDir, parseFitJson } from '../src/fit-summary.js'
import { suggestCandidates } from '../src/suggest.js'
import { diagnoseFit } from '../src/diagnose.js'
import { freeParamCount, compareModels, simplerFavoured } from '../src/model-selection.js'
import { resolveEnv, bundledAifitPath } from '../src/config.js'
import { IterationLog, startIteration, iterationsRootOf, listIterations, createTrialDir } from '../src/iteration-log.js'
import {
  loadLoopState,
  saveLoopState,
  initLoopState,
  convergenceVerdict,
  previousDiaryNll,
  previousIterDir,
  writeFinalReport,
  verifyPrediction,
  appendVerification,
  type LoopState,
  type LoopEval,
  type LoopObjective,
  type Prediction,
  type VerificationResult,
} from '../src/loop-state.js'
import type { IterationRecord } from '../src/report.js'
import { modelBaselineFold, naiveAnswers,
  canonicalDelta,
  droppedByRollback,
  strictDeltaWarning,
} from '../src/memory-fold.js'
import { buildStateDigest, type DigestLoopState } from '../src/state-digest.js'
import { spawnSync } from 'node:child_process'
import type {
  InitialConfigResult,
  InitialConfigSpec,
  JP,
  ResonanceProposal,
  ResonanceRemoval,
} from '../src/types.js'
import { buildInitialConfig } from '../src/config-init.js'
import { createUsageTracker, maybeSpill, snapshotOnce, spillOutputSchema, type TokenTotals, type TokenUsageLike } from './pwa-utils.js'
import {
  analysisRootOf,
  blobMd5,
  commitPaths,
  gitAvailable,
  gitDisabled,
  gitLog,
  gitProvenance,
  gitSearch,
  gitShow,
  PWA_GIT_DIRNAME,
  relInside,
  repoCoexistence,
  repoStatus,
  type Trailers,
} from '../src/git-log.js'
import type { FitOwner } from './pwa-fit.js'

export const name = 'auto-pwa'
export const inject = ['tools', 'pwaFit']

const text = (t: string) => [{ type: 'text' as const, text: t }]

/** One line per first-level partition: `[✓] 1+3 etap + [pip,pim,pi0]`. */
function renderTopologyCoverage(cov: TopologyCoverage): string[] {
  const side = (s: TopologyCoverage['topologies'][number]['sides'][number]): string =>
    s.particles.length === 1 ? (s.particles[0] ?? '?') : `[${s.particles.join(',')}]`
  const lines = [`第一级拓扑（${cov.finalState.length} 体，已写 ${cov.present}/${cov.total}）:`]
  for (const t of cov.topologies) {
    const how =
      t.realizedBy !== undefined
        ? `  (${t.realizedBy.chain}: ${t.realizedBy.mother} -> ${t.realizedBy.daughters.join(' + ')})`
        : ''
    lines.push(`  ${t.present ? '[✓]' : '[ ]'} ${t.kind} ${side(t.sides[0])} + ${side(t.sides[1])}${how}`)
  }
  lines.push('  （[ ] = 未写入模型；数据不一定支持所有过程，但应显式判断是否纳入）')
  return lines
}

/**
 * Human-facing review summary for a freshly built initial config: what reaction
 * and chains were written, which [J,P] groups each intermediate has and which
 * resonances sit in them, the particle identities (PDGID-derived), the data
 * samples, the constraints, and the open questions a physicist must confirm
 * before the automation starts.
 */
function renderInitReview(spec: InitialConfigSpec, r: InitialConfigResult): string {
  const lines: string[] = ['分波分析初始配置 — 请人工复核', '']
  const cfg = r.config
  const jpText = (j: number, p: number): string => `${j}${p > 0 ? '+' : '-'}`

  if (cfg) {
    lines.push('【反应道 / 衰变链】')
    for (const [chainName, chain] of Object.entries(cfg.decayChains)) {
      const prod = chain.steps.filter((s) => cfg.particles[s.mother] !== undefined)
      for (const s of prod) {
        lines.push(`  ${chainName}: ${s.mother} → ${s.daughters[0]} + ${s.daughters[1]}`)
      }
      for (const [intName, int] of Object.entries(chain.intermediates)) {
        const groups = int.groups
          .map((g) => `[${jpText(g.jp.j, g.jp.p)}]: ${g.names.length > 0 ? g.names.join(', ') : '(空)'}`)
          .join('  ')
        lines.push(`    ${intName}  ${groups}`)
      }
    }
    // Multi-body combinatorics: show every first-level partition (1+3/2+2 for
    // four bodies, ...) and whether the spec realizes it. The data decides
    // which ones matter, but an omitted partition must be an explicit choice.
    if (spec.data.order.length >= 3) {
      try {
        lines.push('', ...renderTopologyCoverage(firstLevelTopologies(cfg, spec.data.order)))
      } catch {
        // The coverage view is advisory; never block the review on it.
      }
      if (r.warnings.some((w) => w.code === 'topology-incomplete')) {
        lines.push(
          '  ⚠ 第一级拓扑未全覆盖：数据不一定需要所有划分，但请先枚举并显式说明取舍（补链，或用 spec.topology.excluded 记录理由）。',
        )
      }
    }
    lines.push('', '【粒子】')
    for (const [name, p] of Object.entries(cfg.particles)) {
      const info = p.pdgid !== undefined ? getParticleInfo(defaultDb, p.pdgid) : undefined
      const id = p.pdgid !== undefined ? `pdgid=${p.pdgid}${info ? ` (${info.name})` : ' ⚠ 表中无此 id'}` : '无 pdgid'
      const c = info ? cValueOf(info) : undefined
      const pol = spec.particles.find((x) => x.name === name)?.polarization
      const bits = [
        `  ${name}: ${id}`,
        `J^P=${jpText(p.j, p.p)}`,
        `m=${p.mass}`,
        c !== undefined ? `C=${c > 0 ? '+' : '-'}` : '',
        pol !== undefined && pol.length > 0 ? `polarization=[${pol.join(',')}]` : '',
      ].filter((x) => x !== '')
      lines.push(bits.join('  '))
    }
    lines.push('', '【数据】')
    const dr = cfg.raw.get('Data') as Map<unknown, unknown> | undefined
    const sample = (k: string): string => {
      const v = dr?.get(k)
      return Array.isArray(v) ? JSON.stringify(v) : '未提供'
    }
    lines.push(`  order: ${(dr?.get('order') as string[] | undefined)?.join(', ') ?? '?'}`)
    for (const k of ['data', 'phsp', 'phsp_truth', 'bkg', 'bkg_weights']) {
      lines.push(`  ${k}: ${sample(k)}`)
    }
    lines.push('', '【约束】')
    const con = cfg.constraints
    lines.push(
      `  maxL=${con.maxL ?? '-'}  bf_d=${con.bfD ?? '-'}  identical=${JSON.stringify(con.identical ?? [])}  ` +
        `trans=${con.trans?.length ?? 0}  fix_var=${con.fixVar ? Object.keys(con.fixVar).length : 0}  ` +
        `var_range=${con.varRange ? Object.keys(con.varRange).length : 0}`,
    )
    lines.push('', `【共振态】共 ${Object.keys(cfg.resonances).length} 个`)
    for (const [name, rs] of Object.entries(cfg.resonances)) {
      lines.push(
        `  ${name}: ${rs.model} ${JSON.stringify(rs.parameters)}` +
          `${rs.free && rs.free.length > 0 ? ` free=${JSON.stringify(rs.free)}` : ' (参数全固定)'}` +
          `${rs.freeRange ? ` range=${JSON.stringify(rs.freeRange)}` : ''}` +
          `${rs.reference ? ` reference="${rs.reference}"` : ''}`,
      )
    }
    const mcidMissing = Object.entries(cfg.particles)
      .filter(([, p]) => p.pdgid === undefined)
      .map(([n]) => n)
    if (mcidMissing.length > 0) {
      lines.push('', `⚠ 未写 pdgid 的粒子: ${mcidMissing.join(', ')}（全同/正反/C 判定会退回名字启发式）`)
    }
    if (con.identical === undefined || con.identical.length === 0) {
      const sameSpecies: string[] = []
      for (const chain of Object.values(cfg.decayChains)) {
        for (const s of chain.steps) {
          const a = cfg.particles[s.daughters[0]]
          const b = cfg.particles[s.daughters[1]]
          if (a?.pdgid !== undefined && a.pdgid === b?.pdgid) sameSpecies.push(`${s.daughters[0]}+${s.daughters[1]}`)
        }
      }
      if (sameSpecies.length > 0) {
        lines.push(`⚠ 检测到同 PDGID 的末态对但未声明 identical: ${sameSpecies.join(', ')}（引擎不会对称化）`)
      }
    }
  }

  lines.push('', `changed: ${r.changed.join(' | ')}`)
  lines.push(`errors: ${r.errors.length}  warnings: ${r.warnings.length}`)
  for (const e of r.errors) lines.push(`  [error] ${e.code}: ${e.message}`)
  for (const w of r.warnings) lines.push(`  [warn]  ${w.code}: ${w.message}`)
  lines.push('', '复核重点：反应道/末态是否正确；每个中间态的 [J,P] 组是否符合自旋分析假设；')
  lines.push('共振态是否 PDG 真实且质量在阈值内；数据/MC 路径与格式；free/free_range 策略。')
  return lines.join('\n')
}

/**
 * Locate a bundled python script (auto_pwa_evaluate.py / root_view.py /
 * wave_view.py) from the plugin source layout or the compiled lib layout.
 *
 * - plugin/auto-pwa.ts   (source, run via tsx):  '../scripts/x.py' -> scripts/x.py ✓
 * - lib/plugin/auto-pwa.js (compiled):          '../scripts/x.py' -> lib/scripts/x.py
 *   (a STALE duplicate shipped in published tarballs), while '../../scripts/x.py'
 *   is the package-root scripts/x.py ✓ — so any candidate under lib/scripts/ is
 *   only a last resort and can never shadow the real script.
 *
 * Resolution happens at call time, so creating the file at the returned path
 * fixes an already-loaded plugin process without a restart.
 */
function bundledScriptPath(name: string): string {
  const candidates = [
    new URL(`../scripts/${name}`, import.meta.url).pathname, // plugin/ or lib/plugin/
    new URL(`../../scripts/${name}`, import.meta.url).pathname, // lib/plugin/ -> package root
  ]
  return (
    candidates.find((p) => !p.includes('/lib/scripts/') && existsSync(p)) ??
    candidates.find((p) => existsSync(p)) ??
    candidates[0]!
  )
}

/**
 * Map a tool execution's agent to a pwaFit owner (jobs session fence).
 *
 * The DSH `Agent` exposes `id` (the SessionId) — NOT `sessionId`. Reading the
 * wrong field yields `undefined`, which registers the fit job UNOWNED: the fit
 * still runs and shows up in job_list, but dsh-tool-jobs skips the completion
 * notice (`event.job.owner === undefined`), so the agent is never woken. Both
 * handles are forwarded here and the provider picks per registry generation.
 */
const ownerOf = (exec: { agent?: { id?: string; sessionId?: string } }): FitOwner | undefined => {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const id = typeof agent.id === 'string' ? agent.id : typeof agent.sessionId === 'string' ? agent.sessionId : undefined
  if (id === undefined) return undefined
  return { id, agent }
}

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

/**
 * One nullable number. A 2D moment bin can have no data, and the DSH schema
 * subset rejects `type` ARRAYS ("type arrays are not supported"), so nullable
 * has to be expressed as a two-branch oneOf.
 */
const nullableNumberParam = { oneOf: [{ type: 'number' as const }, { type: 'null' as const }] } as const

/** One 1D Legendre moment (scalar): M_L for data and fit, plus the signed delta. */
const momentParam = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    data: { type: 'number' as const },
    fit: { type: 'number' as const },
    delta: { type: 'number' as const },
  },
} as const

/**
 * One 2D (mass × cosθ) moment: `data`/`fit` are per-mass-bin SERIES aligned with
 * `massBins`, and there is no `delta` — the diagnostic is max|data−fit| over
 * bins. Kept in a separate field from the scalar moments because mixing the two
 * shapes in one schema is what made every evaluate call fail validation.
 */
const moment2dParam = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    data: { type: 'array' as const, items: nullableNumberParam },
    fit: { type: 'array' as const, items: nullableNumberParam },
  },
} as const

/** Legendre orders the evaluate script emits (1D). */
const momentProperties = { '2': momentParam, '4': momentParam, '6': momentParam } as const
/** The same orders, in their mass-binned (2D) shape. */
const moment2dProperties = { '2': moment2dParam, '4': moment2dParam, '6': moment2dParam } as const

const proposalParam = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, required: true, description: '共振态名（分析命名，如 phi1680；须能匹配 PDG 表的 id/别名，除非 model=ONE）' },
    chain: { type: 'string' as const, required: true, description: '加入的 intermediate 名，如 R_KK' },
    jpGroup: { ...jpParam, required: true, description: '要加入（或新建）的 [J,P] 组' },
    model: { type: 'string' as const, required: true, description: '线形模型。已知：BWR/BW（有传播子，需 PDG 依据）、ONE（相空间项，无需 PDG）、Flatte（需 channels）、GS（Gounaris-Sakurai）、Interp（需 options.file/method）、Custom（需 options，DSL）。其它字符串不被插件拦（只 warning），由 ctpwa --validate-only 在跑前定论' },
    parameters: { type: 'array' as const, required: true, items: { type: 'number' as const }, description: '[质量, 宽度] GeV；ONE 给 0 或 1 个 [质量] 占位（Bf 的 q0 用固定参考，占位值不进入振幅；可写 []）；Interp/Custom 可写 []' },
    update: { type: 'boolean' as const, description: 'true = 覆盖**已定义**共振态的定义：parameters/free/free_range/tex/options/reference 以 proposal 为准，未给出的一律丢弃（显式 J/P 保留）。默认 false = 只挂链、不动定义；此时参数与既有定义不同会报 param-conflict' },
    free: { type: 'array' as const, items: { type: 'integer' as const }, description: 'float 的参数索引：0=质量, 1=宽度, -1=全部' },
    freeRange: { type: 'array' as const, items: { type: 'array' as const, items: { type: 'number' as const } }, description: '每个 free 参数一个 [lo, hi] GeV 区间，须包含初始值' },
    tex: {
      oneOf: [
        { type: 'string' as const },
        { type: 'array' as const, items: { type: 'string' as const } },
      ],
      description: 'LaTeX 标签：可传字符串，也可传与 config 一致的数组形式（多段标签如 ["K_{2}", "(1980)"]）；写回时统一归一化成数组',
    },
    channels: { type: 'array' as const, items: { type: 'array' as const, items: { type: 'number' as const } }, description: 'Flatte 专用：道阈值/耦合元数据' },
    options: { type: 'object' as const, additionalProperties: true, description: '特殊公式逃生舱：原样透传给 ctpwa 的模型载荷（Interp: {file, method}；Custom: {expr,...}）。插件只检查它是 mapping，语义由 ctpwa --validate-only 定论' },
    reference: { type: 'string' as const, description: '出处（可选）：参数遵循该实验/论文而非 PDG 平均值（如 DOI 或 "BESIII 2024"）。提供时跳过 PDG 平均一致性检查（质量/J^P 与 PDG 的偏离改为警告），物理可达性（阈值/J^P/C）仍强制。会写入 config.yml 的 reference 字段并随迭代继承' },
  },
  description: '共振态添加提议（强约束：物理校验与 YAML 渲染均由程序完成）',
} as const

/** One resonance-removal item (auto_pwa_remove_resonance / round removals). */
const removalParam = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, required: true, description: '要删除的共振态名（从 [J,P] 组摘除；组本身保留以维持 Constraints.trans 的振幅块索引）' },
    chain: { type: 'string' as const, description: '限定 intermediate（如 R_peta）；省略 = 所有链' },
    jpGroup: { ...jpParam, description: '限定 [J,P] 组；省略 = 所有含该名的组' },
    dropDefinition: { type: 'boolean' as const, description: '已无任何组引用时是否删除 Resonances 定义（默认 true；false = 保留参数以便再挂回）' },
  },
  description: '共振态删除项',
} as const

const removalListParam = {
  type: 'array' as const,
  items: removalParam,
  description: '要删除/摘除的共振态列表（显著性检查用：删掉份额不显著或撞边界的态，对比 ΔNLL）。与 proposal 同时给出时先删后加',
} as const

/**
 * Apply validated removals and then an optional add-proposal to a parsed
 * config (in place). Shared by the standalone removal tool and every
 * iteration driver so removal and addition always go through the same gate.
 */
function applyRoundEdits(
  cfg: Parameters<typeof applyResonanceAddition>[0],
  removals: ResonanceRemoval[] | undefined,
  proposal: ResonanceProposal | undefined,
): { errors: { code: string; message: string }[]; warnings: { code: string; message: string }[]; changed: string[] } {
  const errors: { code: string; message: string }[] = []
  const warnings: { code: string; message: string }[] = []
  const changed: string[] = []
  for (const r of removals ?? []) {
    const dry = validateResonanceRemoval(cfg, r)
    warnings.push(...dry.warnings)
    if (!dry.ok) {
      errors.push(...dry.errors)
      return { errors, warnings, changed }
    }
    const ap = applyResonanceRemoval(cfg, r)
    if (ap.errors.length > 0) {
      errors.push(...ap.errors)
      return { errors, warnings, changed }
    }
    changed.push(...ap.changed)
  }
  if (proposal !== undefined) {
    const v = validateResonanceAddition(defaultDb, cfg, proposal)
    warnings.push(...v.warnings)
    if (!v.ok) {
      errors.push(...v.errors)
      return { errors, warnings, changed }
    }
    const ap = applyResonanceAddition(cfg, proposal)
    if (ap.errors.length > 0) {
      errors.push(...ap.errors)
      return { errors, warnings, changed }
    }
    changed.push(...ap.changed)
  }
  return { errors, warnings, changed }
}

// ---------------------------------------------------------------------------
// 跑前门禁（run-time gate）+ 拟合记录（B1 provenance）
//
// 取代旧的"写 config.yml 就拦"：guard 管的是谁写文件，既盖不住变体 yml /
// 外部 Resonances include，又把所有系统检验堵死。现在无论配置是谁写的、
// 叫什么名字，提交拟合前一律过一遍门禁（TS 结构+物理 → ctpwa 权威解析），
// 通过则记下"这次到底用了什么"（config md5 / 态清单 / 初值来源 / runs）。
// ---------------------------------------------------------------------------

interface DeepValidateResult {
  /** The ctpwa parser actually ran (python + ctpwa importable). */
  ran: boolean
  /** ctpwa says the config parses and DecayInfo.isValid() === true. */
  ok: boolean
  status?: string
  message?: string
  paramNames?: string[]
  amplitudeNames?: string[]
  nAmplitudes?: number
  nFreeParams?: number
  /** ctpwa stderr lines (warnings/notes about trans matching, var_equal, ...). */
  stderr?: string[]
  /** Effect of Constraints on the free-parameter count (nFreeParams fallback). */
  constraintEffect?: {
    withConstraints: number
    withoutConstraints: number
    keys: string[]
    noOp: boolean
  }
  error?: string
}

/** Lines worth surfacing from ctpwa's stderr (not the whole banner). */
function ctpwaStderrLines(stderr: string | undefined): string[] {
  if (stderr === undefined) return []
  const out: string[] = []
  for (const raw of stderr.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (!/\[ctpwa\]\s*(?:warn|note|error)|(?:^|\s)(?:warning|warn|note|error)\s*[:\]]|未匹配|未配成|两侧组合数|var_equal/i.test(line)) continue
    if (!out.includes(line)) out.push(line)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Authoritative config check via the bundled aifit.py `--validate-only`
 * (no GPU): resolves `Resonances: <file>` includes, validates model names and
 * parameter arity with the engine's own parser. Writes its JSON to a temp file
 * (never to the iteration's results/fit.json).
 */
function runValidatePath(configPath: string): DeepValidateResult {
  const script = bundledAifitPath()
  if (!existsSync(script)) return { ran: false, ok: false, error: `aifit.py 不存在: ${script}` }
  const tmp = join(tmpdir(), `pwa-validate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`)
  try {
    const py = defaultFitRunnerConfig().python
    const r = spawnSync(py, [script, '--config', configPath, '--validate-only', '--json', tmp], {
      cwd: dirname(configPath),
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env },
    })
    if (r.error !== undefined || r.status === null) {
      return { ran: false, ok: false, error: `无法启动 ctpwa 校验进程: ${r.error?.message ?? `信号 ${r.signal ?? '?'}`}` }
    }
    if (!existsSync(tmp)) {
      const tail = (r.stderr ?? '').trim().split('\n').slice(-4).join(' | ')
      return { ran: false, ok: false, error: `校验未产出 JSON（exit ${r.status}）${tail !== '' ? `: ${tail}` : ''}` }
    }
    const parsed = JSON.parse(readFileSync(tmp, 'utf8')) as {
      status?: string
      error?: { code?: string; message?: string } | null
      config?: {
        valid?: boolean
        nAmplitudes?: number
        nFreeParams?: number
        amplitudeNames?: string[]
        paramNames?: string[]
        resonanceNames?: string[]
      }
    }
    const cfg = parsed.config
    // DecayInfo.isValid() only says "the particles parsed": a config whose
    // production step is in the wrong compact shape (or whose [J,P] groups are
    // empty) yields ZERO amplitudes yet isValid() === true. A zero-amplitude
    // config cannot describe data, so the authoritative gate must reject it.
    const zeroAmplitudes = cfg?.valid === true && cfg?.nAmplitudes === 0
    const ok = parsed.status === 'ok' && cfg?.valid === true && !zeroAmplitudes
    return {
      ran: true,
      ok,
      status: zeroAmplitudes ? 'no-amplitudes' : parsed.status,
      ...(cfg?.paramNames !== undefined ? { paramNames: cfg.paramNames } : {}),
      ...(cfg?.amplitudeNames !== undefined ? { amplitudeNames: cfg.amplitudeNames } : {}),
      ...(cfg?.nAmplitudes !== undefined ? { nAmplitudes: cfg.nAmplitudes } : {}),
      ...(cfg?.nFreeParams !== undefined ? { nFreeParams: cfg.nFreeParams } : {}),
      ...(ctpwaStderrLines(r.stderr).length > 0 ? { stderr: ctpwaStderrLines(r.stderr) } : {}),
      ...(zeroAmplitudes
        ? {
            message:
              'ctpwa 解析成功但振幅数为 0：产生步必须是模式列表（Jpsi: [[d1, d2]]），' +
              '且至少有一个 [J,P] 组挂上能产生振幅的共振态；空组本身不是错误，整体振幅为 0 才是。',
          }
        : parsed.error?.message !== undefined
          ? { message: parsed.error.message }
          : {}),
    }
  } catch (e) {
    return { ran: false, ok: false, error: (e as Error).message }
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort temp cleanup
    }
  }
}

/** Warnings derived from ctpwa stderr + the nFreeParams constraints probe. */
function deepConstraintWarnings(deep: DeepValidateResult): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = []
  for (const line of deep.stderr ?? []) out.push({ code: 'ctpwa-stderr', message: line })
  const effect = deep.constraintEffect
  if (effect?.noOp === true) {
    out.push({
      code: 'constraints-no-effect',
      message:
        `Constraints ${effect.keys.join('/')} 没有减少自由参数数（with=${effect.withConstraints}, ` +
        `without=${effect.withoutConstraints}）——名字/配对可能没有命中，属于 no-op；` +
        `引擎 stderr 会给出具体未匹配项。物理效果以 ΔNLL/记录为准，不做硬拦截。`,
    })
  }
  return out
}

/**
 * Authoritative check + a **constraints-effect probe**: validate once, then
 * once with `trans`/`var_equal`/`fix_var`/`free_var` stripped. If nFreeParams
 * does not drop, the constraints had no effect (no-op) — reported as a warning,
 * never a hard error. Values/names are ctpwa's job; this is the "nFreeParams
 * fallback" for semantics.
 */
function deepValidateConfig(configPath: string): DeepValidateResult {
  const main = runValidatePath(configPath)
  if (!main.ran || !main.ok || main.nFreeParams === undefined) return main
  try {
    const text = readFileSync(configPath, 'utf8')
    const cfg = parseConfig(text)
    if (typeof cfg.raw.get('Resonances') === 'string') return main
    const con = (cfg.raw.get('Constraints') ?? cfg.raw.get('constraints')) as Map<unknown, unknown> | undefined
    if (!(con instanceof Map)) return main
    const keys = ['trans', 'var_equal', 'fix_var', 'free_var'].filter((k) => con.has(k))
    if (keys.length === 0) return main
    const clone = parseConfig(text)
    const cloneCon = (clone.raw.get('Constraints') ?? clone.raw.get('constraints')) as Map<unknown, unknown> | undefined
    if (!(cloneCon instanceof Map)) return main
    for (const k of keys) cloneCon.delete(k)
    const tmpYml = join(tmpdir(), `pwa-constraints-baseline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.yml`)
    try {
      writeFileSync(tmpYml, dumpConfig(clone))
      const base = runValidatePath(tmpYml)
      if (!base.ran || base.nFreeParams === undefined) return main
      return {
        ...main,
        constraintEffect: {
          withConstraints: main.nFreeParams,
          withoutConstraints: base.nFreeParams,
          keys,
          noOp: main.nFreeParams >= base.nFreeParams,
        },
      }
    } finally {
      try {
        rmSync(tmpYml, { force: true })
      } catch {
        // best-effort
      }
    }
  } catch {
    return main
  }
}

/**
 * 本地 git 记录（B2）：把本次写入的文本产物提交进 `<分析目录>/.pwa-git`。
 *
 * 尽力而为：`PWA_GIT=off`、git 缺失、无改动都静默跳过；只有真正的失败降级成
 * warning——记录不是门禁，绝不因为它阻塞拟合。
 */
function gitRecord(
  anchorPath: string,
  paths: string[],
  message: string,
  trailers?: Trailers,
): { commit?: string; changed?: string; warnings: { code: string; message: string }[] } {
  if (gitDisabled()) return { warnings: [] }
  const analysisDir = analysisRootOf(anchorPath)
  noteAnalysisRoot(analysisDir)
  // 引擎指纹由 commitPaths 统一兜底（单一来源），这里不再重复添加
  const res = commitPaths(analysisDir, paths, message, trailers)
  if (res.committed) {
    const short = res.sha ?? '?'
    return { commit: short, changed: `git ${short}: ${message}`, warnings: res.warnings ?? [] }
  }
  if (res.reason === 'nothing-to-commit' || res.reason === 'disabled' || res.reason === 'unavailable') {
    return { warnings: res.warnings ?? [] }
  }
  return {
    warnings: [
      ...(res.warnings ?? []),
      { code: 'git-record-failed', message: `本地 git 记录失败（${res.reason ?? 'unknown'}）：${res.error ?? ''}` },
    ],
  }
}

/** S1：提案/删除类提交的 trailer（键落在"链/态"这一层，供按键查询与 fold 用）。 */
function proposalTrailers(
  iter: number | undefined,
  proposal?: ResonanceProposal,
  removals?: ResonanceRemoval[],
): Trailers {
  const t: Trailers = { 'Pwa-Kind': proposal !== undefined ? 'proposal' : 'removal' }
  if (iter !== undefined) t['Pwa-Iter'] = iter
  if (proposal !== undefined) {
    t['Pwa-Resonance'] = proposal.name
    t['Pwa-Chain'] = proposal.chain
    t['Pwa-Jp'] = `${proposal.jpGroup.j}${proposal.jpGroup.p > 0 ? '+' : '-'}`
    t['Pwa-Model'] = proposal.model
  }
  const names = (removals ?? []).map((r) => r.name)
  if (names.length > 0) {
    t['Pwa-Remove'] = names.join(',')
    if (proposal === undefined) t['Pwa-Resonance'] = names.join(',')
  }
  return t
}

/** 一句话描述本轮编辑，用于 git 提交信息。 */
function editSummary(proposal: ResonanceProposal | undefined, removals: ResonanceRemoval[]): string {
  const parts: string[] = []
  if (proposal !== undefined) {
    parts.push(`add ${proposal.name} -> ${proposal.chain} [${proposal.jpGroup.j}${proposal.jpGroup.p > 0 ? '+' : '-'}]`)
  }
  for (const r of removals) parts.push(`remove ${r.name}`)
  return parts.length > 0 ? parts.join('; ') : 'edit'
}

/** Gate issues as plain {code, message} tool-output items (severity implied). */
function plainIssues(list: { code: string; message: string }[]): { code: string; message: string }[] {
  return list.map((i) => ({ code: i.code, message: i.message }))
}

/**
 * `PWA_GATE_REQUIRE_DEEP=1` turns "ctpwa 权威校验跑不起来" into a hard error
 * (default: a loud warning). Rationale: a missing loader path / un-importable
 * ctpwa on a login node is an ENVIRONMENT failure, not a config error — it must
 * not lock the user out of submitting fits. Set the knob in a strict pipeline.
 */
function requireDeep(): boolean {
  const v = process.env.PWA_GATE_REQUIRE_DEEP
  return v === '1' || v?.toLowerCase() === 'true'
}

interface PreFitGate {
  ok: boolean
  configPath: string
  gate: GateResult
  deep: DeepValidateResult
  errors: { code: string; message: string }[]
  warnings: { code: string; message: string }[]
  provenance?: Provenance
  provenanceFile?: string
  /** Rendered human/model-readable gate report. */
  report: string
}

/**
 * Gate one config that is about to be fitted and, when it passes, record the
 * provenance (B1). Returns ok=false with actionable errors instead of
 * submitting — the run never starts on a config that fails the gate.
 */
function gateBeforeFit(args: {
  iterDir: string
  tool: string
  configPath?: string
  fitScript?: string
  scriptArgs?: string[]
  init?: ProvenanceInit
  /** Skip the ctpwa deep check (structure+physics only); default false. */
  skipDeep?: boolean
}): PreFitGate {
  const configPath = args.configPath ?? join(args.iterDir, 'config.yml')
  const errors: { code: string; message: string }[] = []
  const warnings: { code: string; message: string }[] = []
  const emptyGate: GateResult = {
    ok: false,
    errors: [],
    warnings: [],
    checks: [],
    stats: { resonances: 0, groups: 0, definedUnreferenced: 0, freeResonanceParams: 0, dataSamples: 0 },
    resonancesExternal: false,
    configMd5: '',
  }
  if (!existsSync(configPath)) {
    return {
      ok: false,
      configPath,
      gate: emptyGate,
      deep: { ran: false, ok: false },
      errors: [{ code: 'config-missing', message: `config 不存在: ${configPath}` }],
      warnings,
      report: `跑前门禁: 拒绝 — config 不存在: ${configPath}`,
    }
  }
  const text = readFileSync(configPath, 'utf8')
  let cfg: ReturnType<typeof parseConfig>
  try {
    cfg = parseConfig(text)
  } catch (e) {
    return {
      ok: false,
      configPath,
      gate: { ...emptyGate, configMd5: '' },
      deep: { ran: false, ok: false },
      errors: [{ code: 'yaml-parse', message: `YAML 解析失败: ${(e as Error).message}` }],
      warnings,
      report: `跑前门禁: 拒绝 — YAML 解析失败: ${(e as Error).message}`,
    }
  }
  const gate = gateConfig(cfg, text, defaultDb, { maxL: cfg.constraints.maxL })
  // Strip the internal `severity` tag: which array an issue came from already
  // encodes it, and the tool output schemas declare strict {code, message}
  // items. Leaking severity made every run_fit return fail output validation
  // (the job had already been submitted — a silent "submitted, no jobId").
  errors.push(...plainIssues(gate.errors))
  warnings.push(...plainIssues(gate.warnings))

  // ctpwa 权威层：外部 include / 模型名 / 参数结构只有引擎能定论。
  const deep = args.skipDeep === true ? { ran: false, ok: false, error: '已跳过（skipDeep）' } : deepValidateConfig(configPath)
  if (deep.ran && !deep.ok) {
    errors.push({ code: 'ctpwa-config-invalid', message: `ctpwa 拒绝该配置: ${deep.message ?? deep.status ?? 'DecayInfo 校验失败'}` })
  } else if (!deep.ran) {
    if (gate.resonancesExternal && requireDeep()) {
      errors.push({
        code: 'deep-check-required',
        message:
          `config 的 Resonances 是外部 include（${gate.resonancesIncludePath ?? '?'}），TS 层看不到定义，` +
          `且 PWA_GATE_REQUIRE_DEEP 已开启，但 ctpwa --validate-only 无法运行：${deep.error ?? '未知'}`,
      })
    } else if (gate.resonancesExternal) {
      warnings.push({
        code: 'deep-check-skipped-external',
        message:
          `config 的 Resonances 是外部 include（${gate.resonancesIncludePath ?? '?'}）：TS 层看不到定义，` +
          `共振态级检查（PDG/J^PC/阈值）本次未做，且 ctpwa --validate-only 无法运行（${deep.error ?? '未知'}）——` +
          `本次门禁只保证 YAML 结构与交叉引用。装好 ctpwa 环境（PWA_CTPWA_PYTHON / PWA_LD_LIBRARY_PATH）或设 ` +
          `PWA_GATE_REQUIRE_DEEP=1 可把它变成硬错误`,
      })
    } else {
      warnings.push({
        code: 'deep-check-skipped',
        message: `ctpwa 深度校验未运行（${deep.error ?? '未知'}）——TS 层结构/物理检查已通过，但引擎级问题（模型名、参数结构）未验证`,
      })
    }
  }

  for (const w of deepConstraintWarnings(deep)) warnings.push(w)

  // 同目录漂移：config 或拟合设置变了 → 旧结果不再对应（B1 的核心价值）。
  const drift = checkProvenanceDrift(args.iterDir, text, args.scriptArgs, args.fitScript)
  warnings.push(...drift.drift.map((d) => ({ code: d.code, message: d.message })))

  // B2：git 绑定 + md5 ↔ commit 互验。dirty 说明 HEAD 不是这份配置；blob 比对
  // 还能抓到 dirty 抓不到的"假可复现"——拟合用的 config 从未入库（手写变体）。
  const analysisDir = analysisRootOf(configPath)
  const git = gitProvenance(analysisDir)
  let gitVerified: boolean | undefined
  if (git !== undefined) {
    const rel = relInside(analysisDir, configPath)
    if (rel !== undefined) {
      const blob = blobMd5(analysisDir, rel, git.commit ?? 'HEAD')
      gitVerified = blob !== undefined && blob === gate.configMd5
      if (!gitVerified) {
        warnings.push({
          code: 'git-config-not-committed',
          message:
            `${rel} 不在 git HEAD 里（或与 HEAD 内容不同）——本次结果的配置无法从 commit 复原。` +
            `工具写入的配置会自动提交；手写/外部改动的文件请先提交（或确认被 .gitignore 忽略是有意的）`,
        })
      }
    }
  }

  const ok = errors.length === 0
  let provenance: Provenance | undefined
  let provenanceFile: string | undefined
  if (ok) {
    try {
      provenance = buildProvenance({
        tool: args.tool,
        iterDir: args.iterDir,
        configPath,
        configText: text,
        config: cfg,
        gate,
        ...(args.fitScript !== undefined ? { fitScript: args.fitScript } : {}),
        ...(args.scriptArgs !== undefined ? { scriptArgs: args.scriptArgs } : {}),
        init: args.init ?? initFromScriptArgs(args.scriptArgs),
        ...(git !== undefined ? { git } : {}),
        ...(gitVerified !== undefined ? { gitVerified } : {}),
      })
      provenanceFile = writeProvenance(args.iterDir, provenance)
    } catch (e) {
      warnings.push({ code: 'provenance-write-failed', message: `拟合记录写入失败: ${(e as Error).message}` })
    }
  }

  const report =
    renderGate({ ...gate, ok, errors: errors.map((e) => ({ ...e, severity: 'error' as const })), warnings: warnings.map((w) => ({ ...w, severity: 'warning' as const })) }) +
    (deep.paramNames !== undefined
      ? `\n  ctpwa: ${deep.nAmplitudes ?? '?'} 个振幅, ${deep.nFreeParams ?? '?'} 个自由参数` +
        `\n  参数顺序(前 16): ${deep.paramNames.slice(0, 16).join(', ')}${deep.paramNames.length > 16 ? ' …' : ''}`
      : '')
  return {
    ok,
    configPath,
    gate,
    deep,
    errors,
    warnings,
    ...(provenance !== undefined ? { provenance } : {}),
    ...(provenanceFile !== undefined ? { provenanceFile } : {}),
    report,
  }
}

/** Gate report fields shared by every submitting tool's output schema/render. */
const gateOutputFields = {
  gate: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' as const, required: true },
      report: { type: 'string' as const, required: true },
      errors: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: false, properties: { code: { type: 'string' as const, required: true }, message: { type: 'string' as const, required: true } } } },
      warnings: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: false, properties: { code: { type: 'string' as const, required: true }, message: { type: 'string' as const, required: true } } } },
      configMd5: { type: 'string' as const },
      provenancePath: { type: 'string' as const },
      ctpwa: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ran: { type: 'boolean' as const, required: true },
          ok: { type: 'boolean' as const, required: true },
          nAmplitudes: { type: 'integer' as const },
          nFreeParams: { type: 'integer' as const },
          paramNames: { type: 'array' as const, items: { type: 'string' as const } },
          message: { type: 'string' as const },
        },
      },
    },
  },
} as const

// ---------------------------------------------------------------------------
// P1b：当前状态摘要（runtime context）的运行期状态
// ---------------------------------------------------------------------------

/**
 * 插件"见过"的分析目录——**按 agent(=session) 分开记**。
 *
 * 为什么必须分开：`agent.id === session.id`（dsh-agent 里明确断言），而摘要是**每轮
 * 注入到该 agent 的 prompt** 里的。早先只有一个进程级 root，导致跑分析 B 的会话
 * 会看到分析 A 的"已触碰态索引"（实测 8/8 个 agent 都主动声明"那是另一个分析、
 * 不混用"——但这依赖模型自觉，弱模型会被带偏）。
 */
const rootsByAgent = new Map<string, string>()

/** 无 agent 身份的宿主（单测、工具调用不带 agent 的场景）用这个兜底。 */
let fallbackAnalysisRoot: string | undefined

/** 从工具参数里挑出分析路径（命中任一即算"触达了该分析"）。 */
function pickAnalysisPath(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  for (const key of ['iterationsRoot', 'baseIterDir', 'iterDir', 'configPath', 'baseConfigPath', 'analysisDir']) {
    const v = args[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/** 记下分析目录（写路径经 gitRecord；读路径经 session/event 的工具调用流）。 */
function noteAnalysisRoot(anchorPath: string, agentId?: string): void {
  try {
    const root = analysisRootOf(anchorPath)
    if (!existsSync(root)) return
    if (agentId !== undefined) rootsByAgent.set(agentId, root)
    else fallbackAnalysisRoot = root
  } catch {
    /* 尽力而为 */
  }
}

/** 测试用：清掉"当前分析目录"的记忆。 */
export function __resetActiveAnalysisRoot(): void {
  rootsByAgent.clear()
  fallbackAnalysisRoot = undefined
}

/**
 * 解析要总结的分析目录：优先插件见过的；其次工作目录（= 在分析目录里启动的会话，
 * resume 后无需任何工具调用就有状态）。两者都不像分析目录时返回 undefined。
 */
function resolveDigestRoot(agentId?: string): string | undefined {
  // 只认"本 agent 自己触达过的"，以及无 agent 身份时的兜底——**绝不**借用别的
  // session 记下的 root（那正是跨分析污染的来源）。
  // 有 agent 身份时**只认自己**记下的；全局兜底仅服务"没有 agent 身份"的宿主。
  const remembered = agentId !== undefined ? rootsByAgent.get(agentId) : fallbackAnalysisRoot
  if (
    remembered !== undefined &&
    (existsSync(join(remembered, 'iterations', 'SUMMARY.jsonl')) ||
      existsSync(join(remembered, 'init_config.yml')) ||
      existsSync(join(remembered, 'init_config.orig.yml')))
  ) {
    return remembered
  }
  try {
    const cwd = process.cwd()
    if (
      existsSync(join(cwd, 'iterations')) ||
      existsSync(join(cwd, PWA_GIT_DIRNAME)) ||
      existsSync(join(cwd, 'init_config.yml')) ||
      existsSync(join(cwd, 'init_config.orig.yml'))
    ) {
      return cwd
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * Non-forcing multi-body reminder: enumerate first-level partitions, but let
 * the physics decide which ones are needed (a radiative decay or a data-driven
 * analysis may legitimately need only a subset). Injected every turn as a
 * system reminder when a 4/5-body config exists and is not fully covered.
 */
function multiBodyTopologyNote(root: string): string | undefined {
  try {
    const candidates = ['init_config.yml', 'init_config.orig.yml']
    const path = candidates.map((f) => join(root, f)).find((p) => existsSync(p))
    if (path === undefined) return undefined
    const cfg = parseConfig(readFileSync(path, 'utf8'))
    const data = cfg.raw.get('Data')
    const order = data instanceof Map ? data.get('order') : undefined
    if (!Array.isArray(order)) return undefined
    const finalState = order.filter((x): x is string => typeof x === 'string')
    if (finalState.length < 4) return undefined
    const cov = firstLevelTopologies(cfg, finalState)
    if (cov.present >= cov.total) return undefined
    const side = (s: { particles: string[] }): string =>
      s.particles.length === 1 ? (s.particles[0] ?? '?') : `[${s.particles.join(',')}]`
    const missing = cov.topologies.filter((t) => !t.present)
    const shown = missing
      .slice(0, 6)
      .map((t) => `${t.kind} ${side(t.sides[0])}+${side(t.sides[1])}`)
    const more = missing.length > shown.length ? ` 等 ${missing.length} 个` : ''
    const file = path.endsWith('init_config.yml') ? 'init_config.yml' : 'init_config.orig.yml'
    return [
      '<system-reminder>',
      `多体拓扑提醒（代码生成）：${finalState.length} 体第一级共有 ${cov.total} 种划分（1+3、2+2、…），` +
        `当前 ${file} 覆盖 ${cov.present}/${cov.total}；未覆盖：${shown.join('；')}${more}。`,
      '数据可能不需要全部（例如辐射衰变常只有部分链），但请先枚举并显式说明取舍；' +
        'auto_pwa_config_view / auto_pwa_init_config preview 会列出同一张表。',
      '</system-reminder>',
    ].join('\n')
  } catch {
    return undefined
  }
}

/**
 * sync provider：读日记 + 状态机 + 最近 fit.json，渲染注入文本。
 * **任何异常都退化为空串**——注入是增强，绝不能让组装 prompt 失败。
 */
function stateDigestText(agentId?: string): string {
  try {
    const root = resolveDigestRoot(agentId)
    if (root === undefined) return ''
    const topology = multiBodyTopologyNote(root)
    const records = new IterationLog({ rootDir: join(root, 'iterations') }).readAll()
    if (records.length === 0) return topology ?? ''
    let loopState: DigestLoopState | undefined
    const statePath = join(root, 'iterations', '.loop-state.json')
    if (existsSync(statePath)) {
      try {
        loopState = JSON.parse(readFileSync(statePath, 'utf8')) as DigestLoopState
      } catch {
        loopState = undefined
      }
    }
    // 噪声地板：最近一个有 fit.json 的迭代目录的 per-run NLL 极差（P0 实测：
    // 极差可达 8000，而"显著"判据是 |ΔNLL| ≥ 3 → 不提示就会拿噪声当信号）
    let noise: { iter: number; nRuns: number; spread: number } | undefined
    for (const d of [...listIterations(join(root, 'iterations'))].reverse()) {
      const p = join(d, 'results', 'fit.json')
      if (!existsSync(p)) continue
      const view = parseFitJson(readFileSync(p, 'utf8'))
      const nlls = (view.fit?.runSummaries ?? []).map((r) => r.nll).filter((n): n is number => typeof n === 'number')
      if (nlls.length >= 2) {
        const m = /iter-(\d+)/.exec(d)
        noise = { iter: m === null ? 0 : Number(m[1]), nRuns: nlls.length, spread: Math.max(...nlls) - Math.min(...nlls) }
      }
      break
    }
    const digest = buildStateDigest({
      analysisRoot: root,
      records,
      ...(loopState !== undefined ? { loopState } : {}),
      ...(noise !== undefined ? { noise } : {}),
    })
    // **程序性记忆注入**（默认关闭）：`PWA_REMINDERS=R1|R2` 打开。
    // 依据 §8.5.5：离线测不出净收益且有"压成不作为"的风险 → 默认关、可 A/B。
    const level = reminderLevelFromEnv()
    if (level === undefined) return [topology, digest].filter((x): x is string => x !== undefined && x !== '').join('\n\n')
    const injection = reminderInjection({
      level,
      action: inferAction(loopState?.phase, records[records.length - 1]?.kind),
      ...(engineFingerprint() !== undefined ? { engine: engineFingerprint()! } : {}),
    })
    return [topology, digest, injection === '' ? undefined : injection]
      .filter((x): x is string => x !== undefined && x !== '')
      .join('\n\n')
  } catch {
    return ''
  }
}

export function apply(ctx: Context) {
  // 自注册 skill（npm bundle 安装后零手动配置）：把包内 SKILL.md 作为
  // runtime skill 注册进当前 context 的 skills 层（project > runtime > user，
  // 会遮蔽 ~/.dsh/skills 的同名副本并随插件版本更新）。尽力而为——skills
  // 服务缺席或文件缺失时静默跳过，不影响其他工具。
  const skills = (ctx as { get?: (name: string) => unknown }).get?.('skills') as { register: (skill: unknown) => () => void } | undefined
  if (skills !== undefined) {
    try {
      // Same layout rule as bundledScriptPath: the compiled layout's
      // '../skills' lands on lib/skills/ (absent in published packages), so
      // prefer the package-root skills/ copy.
      // 随包分发的 skill 清单（新增一个 = 在这里加一行 + 建 skills/<dir>/SKILL.md）
      const bundledSkills: { dir: string; name: string; description: string; whenToUse: string }[] = [
        {
          dir: 'auto-pwa-analysis',
          name: 'auto-pwa-analysis',
          description: 'PWA 分波分析作业规则',
          whenToUse: 'Performing partial wave analysis with the auto_pwa_* tools.',
        },
        {
          dir: 'auto-pwa-iter',
          name: 'auto-pwa-iter',
          description: '迭代主循环与拟合质量判断',
          whenToUse:
            'Running the PWA iteration loop: iteration folders, the state machine and same-session goal, local git records, the pre-fit gate, fit-quality judgment.',
        },
        {
          dir: 'auto-pwa-pdg',
          name: 'auto-pwa-pdg',
          description: 'PDG 依据 / 本地登记 / 线形选择',
          whenToUse:
            'Deciding whether a resonance may be added: PDG backing vs local registrations, reference overrides, per-analysis local-states.json, line-shape conventions (advisory), experiment-base vs model-baseline.',
        },
        {
          dir: 'auto-pwa-jpc',
          name: 'auto-pwa-jpc',
          description: 'J^PC / 顶点 / 阈值可达性',
          whenToUse:
            'Checking quantum-number reachability before adding a resonance: two-vertex J^PC intersection, decay-vertex pairJPC gate, C conservation, thresholds, maxL.',
        },
        {
          dir: 'debug-auto-pwa',
          name: 'debug-auto-pwa',
          description: '本地开发与调试 auto-pwa 插件',
          whenToUse:
            'Developing, installing or debugging the auto-pwa plugin itself: local install routes, build freshness, isolated DSH_HOME testing, tool-registration troubleshooting.',
        },
      ]
      for (const bundled of bundledSkills) {
        const candidates = [
          new URL(`../skills/${bundled.dir}/SKILL.md`, import.meta.url).pathname, // plugin/ or lib/plugin/
          new URL(`../../skills/${bundled.dir}/SKILL.md`, import.meta.url).pathname, // lib/plugin/ -> package root
        ]
        const skillPath =
          candidates.find((p) => !p.includes('/lib/skills/') && existsSync(p)) ??
          candidates.find((p) => existsSync(p))
        if (skillPath === undefined) continue
        const content = readFileSync(skillPath, 'utf8')
        const fm = /^---\n([\s\S]*?)\n---/.exec(content)
        const front = fm !== null ? fm[1] : ''
        const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? bundled.name
        const description =
          /^description:\s*(.+)$/m.exec(front)?.[1]?.trim()?.replace(/^['"]|['"]$/g, '') ?? bundled.description
        ctx.effect?.(() =>
          skills.register({
            name,
            description,
            whenToUse: bundled.whenToUse,
            content,
            // source is REQUIRED by SkillSummary — omitting it makes the
            // loader fail with "source must be a string". provider defaults.
            source: 'runtime',
            invocation: { modelInvocable: true, userInvocable: false },
          } as never),
        )
      }
    } catch {
      // skill 注册是增强，绝不阻断插件
    }
  }

  // ---------------------------------------------------------------------
  // P1b：当前状态摘要（runtime context）
  //
  // 把"代码 fold 出的当前状态"注册成 runtime context，每轮自动注入——模型不必
  // （也不能）自己记当前基线/否决清单/未决预测。harness 只在文本变化时新增一条
  // user 消息（dsh-agent-loop:334-349），所以天然去重、resume 不重复。
  //
  // ⚠️ `systemPrompt` 是 **agent 级**服务（由 dsh-agent-loop 按 session 提供），
  // 而 cordis 里**访问未声明 inject 的服务属性会直接抛**
  // （`cannot get property "systemPrompt" without inject`）。这个访问若放在 apply
  // 里，一旦服务当时还没就绪，**整个 auto-pwa entry 都会挂**（28 个工具一起消失，
  // 且是否踩中取决于 apply 顺序——线上曾因此"装了却没工具"）。
  // 因此这里用 in-box 插件的标准写法 `ctx.inject(['systemPrompt'], scope => …)`：
  // 服务就绪时才注册；缺席时插件照常工作（摘要是增强，不是依赖）。
  // ---------------------------------------------------------------------
  const registerDigest = (
    host: { systemPrompt?: { context: (c: { name: string; order: number; text: () => string }) => () => void } },
    agentId?: string,
  ): void => {
    const sp = host.systemPrompt
    if (sp === undefined) return
    // 先注册；`ctx.effect`（若存在）只负责在插件卸载时反注册——不能把注册本身
    // 放进 effect 回调，否则没有 effect 服务的宿主上永远不会注册。
    const unregister = sp.context({ name: 'auto-pwa:state', order: 150, text: () => stateDigestText(agentId) })
    ctx.effect?.(() => unregister)
  }
  // **按 agent 注册**（in-box 插件的标准做法，见 dsh-file-reference-local：text 闭包
  // 捕获该 agent，于是摘要天然按 session 隔离）。宿主不提供事件时才退回插件级。
  const onAgentCreated = (ctx as { on?: (name: string, cb: (arg: unknown) => void) => unknown }).on
  const installForAgent = (agent: unknown): void => {
    const a = agent as { id?: unknown; ctx?: { inject?: (deps: string[], cb: (scope: unknown) => void) => unknown } }
    const id = typeof a?.id === 'string' ? a.id : undefined
    const injectOnAgent = a?.ctx?.inject
    if (typeof injectOnAgent !== 'function') return
    try {
      injectOnAgent.call(a.ctx, ['systemPrompt'], (scope) => registerDigest(scope as never, id))
    } catch {
      /* 注入是增强 */
    }
  }
  try {
    if (typeof onAgentCreated === 'function') {
      // harness 的载荷是 `{ agent, source, signal? }`（dsh-agent 的
      // `ctx.serial(carrier, "agent/created", { agent, source })`），与 in-box 插件
      // （dsh-file-reference-local）的接法一致；直接给 agent 的宿主也兼容。
      onAgentCreated.call(ctx, 'agent/created', (payload: unknown) => {
        installForAgent((payload as { agent?: unknown } | null | undefined)?.agent ?? payload)
      })
      // 插件也可能在 agent 之后才加载 → 补装现存 agent（in-box 同样这么做）
      const agents = (ctx as { agents?: { list?: () => unknown[] } }).agents
      for (const a of agents?.list?.() ?? []) installForAgent(a)
    } else {
      registerDigest(ctx as never) // 假 ctx（单测）：直接尝试，缺席时下面兜住
    }
  } catch {
    // 注入是增强，绝不阻断插件（含"服务未 inject 就访问"的宿主）
  }

  // token-meter: 累计本会话各 session 的 assistant/message usage；
  // auto_pwa_note 的 includeTokens 按轮取差值写进日记。
  // 事件信封是 { type, seq, time, data }，usage 在 data.usage。
  const usage = createUsageTracker()
  ctx.on?.('session/event', (session: unknown, event: unknown) => {
    const sessionId = typeof (session as { id?: unknown } | null | undefined)?.id === 'string'
      ? (session as { id: string }).id
      : '?'
    usage.onSessionEvent(sessionId, event as { type?: string; data?: { usage?: TokenUsageLike } } as never)
    // 按 session 记"触达过的分析目录"：任何带分析路径的工具调用都算（读写都覆盖）。
    const ev = event as { type?: string; data?: { arguments?: unknown } } | null | undefined
    if (ev?.type === 'tool/call') {
      const raw = ev.data?.arguments
      const args = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return undefined } })() : raw
      const picked = pickAnalysisPath(args as Record<string, unknown> | undefined)
      if (picked !== undefined) noteAnalysisRoot(picked, sessionId)
    }
  })

  // ---------------------------------------------------------------------
  // auto_pwa_lookup
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_lookup',
    description: '查 PDG/本地登记表：名称/J^P/质量/宽度/候选；返回出处与建议线形。',
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
                suggestedModel: { type: 'string' },
                modelHint: { type: 'string' },
                decayModes: { type: 'array', items: { type: 'string' } },
                measurements: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      year: { type: 'integer' },
                      publication: { type: 'string' },
                      doi: { type: 'string' },
                      technique: { type: 'string' },
                      value: { type: 'number' },
                      errorPositive: { type: 'number' },
                      statError: { type: 'number' },
                      systError: { type: 'number' },
                      usedInAverage: { type: 'boolean' },
                    },
                  },
                  description: '单实验质量测量（新→旧，最多 8 条）——比 PDG 平均更新的实验结果在这里',
                },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { hits: { id: string; jp: JP; mass: number; width?: number; status?: string; suggestedModel?: string; modelHint?: string; measurements?: { year?: number; publication?: string; value?: number; errorPositive?: number; statError?: number; systError?: number; usedInAverage?: boolean }[] }[]; total: number }) => {
        if (value.hits.length === 0) return text('(无命中)')
        const lines = value.hits.map((h) => {
          const conv = h.suggestedModel !== undefined ? `\n    惯例: ${h.suggestedModel}${h.modelHint !== undefined ? `（${h.modelHint}）` : ''}（仅提醒，不强制）` : ''
          // 出处必须可见：`[PDG]` 才算官方数据，`[本地]` 是分析自定义/未收录
          // （门禁只把 PDG 算作"有依据"，所以模型必须能一眼分辨）。
          const tag = h.status === undefined || h.status === 'pdg' ? '[PDG] ' : '[本地]'
          const base = `${tag}${h.id.padEnd(16)} J^P=${h.jp.j}${h.jp.p > 0 ? '+' : '-'}  m=${h.mass.toFixed(4)} GeV  Γ=${h.width?.toFixed(4) ?? '-'} GeV`
          const ms = (h.measurements ?? []).slice(0, 4).map((m) =>
            `      ${m.year ?? '?'} ${(m.publication ?? '?').slice(0, 28).padEnd(28)} m=${m.value?.toFixed(4) ?? '—'} GeV${m.errorPositive !== undefined ? ` ±${m.errorPositive.toFixed(4)}` : ''}${m.statError !== undefined ? ` (stat ${m.statError.toFixed(4)})` : ''}${m.systError !== undefined ? ` (syst ${m.systError.toFixed(4)})` : ''}${m.usedInAverage ? ' 入平均' : ''}`,
          )
          return ms.length > 0 ? `${base}${conv}\n    单实验测量:\n${ms.join('\n')}` : `${base}${conv}`
        })
        const integrity = dbIntegrity.ok ? '' : `⚠ ${dbIntegrity.warning}\n`
        return text(`${integrity}PDG 命中 ${value.total} 条（[本地] = 本地登记，非 PDG）:\n${lines.join('\n')}`)
      },
    },
    async execute(args: { name?: string; jp?: JP; massRange?: [number, number]; decayTo?: string[] }, exec?: { agent?: { id?: string; sessionId?: string } }) {
      // 本地登记：优先用本 agent 触达过的分析目录（<analysis>/local-states.json）
      const agentId = exec?.agent?.id ?? exec?.agent?.sessionId
      const db = dbWithLocal(defaultDb, resolveDigestRoot(agentId))
      const hits = lookupResonance(db, {
        name: args.name,
        jp: args.jp,
        massRange: args.massRange,
        decayTo: args.decayTo,
      })
      return {
        total: hits.length,
        hits: hits.map((h) => {
          const conv = conventionFor(h.id, h.aliases)
          return {
          id: h.id,
          jp: h.jp,
          mass: h.mass,
          width: h.width ?? null,
          status: h.status,
          ...(conv !== undefined ? { suggestedModel: conv.model, modelHint: conv.why } : {}),
          decayModes: (h.decayModes ?? []).map((m) => m.daughters.join(' -> ')),
          measurements: (h.measurements ?? []).slice(0, 8).map((m) => {
            // Lossless-JSON: undefined values are rejected by the tool
            // framework, so only defined fields are carried.
            const out: Record<string, number | string | boolean> = {}
            if (m.year !== undefined) out.year = m.year
            if (m.publication !== undefined) out.publication = m.publication
            if (m.doi !== undefined) out.doi = m.doi
            if (m.technique !== undefined) out.technique = m.technique
            if (m.value !== undefined) out.value = m.value
            if (m.errorPositive !== undefined) out.errorPositive = m.errorPositive
            if (m.statError !== undefined) out.statError = m.statError
            if (m.systError !== undefined) out.systError = m.systError
            if (m.usedInAverage !== undefined) out.usedInAverage = m.usedInAverage
            return out
          }),
          }
        }),
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_decay_check
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_decay_check',
    description: '运动学可达性：A→R+B 允许的 J^P（maxL 截断）与阈值下候选。',
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
          resonances: c.resonances.map((x) => {
            // `decaysTo` is only set when the caller passed decayTo; an own
            // key holding undefined is rejected by the tool framework's
            // lossless-JSON gate, so the key must be absent, not undefined.
            const entry: { id: string; mass: number; width: number | null; decaysTo?: boolean } = {
              id: x.entry.id,
              mass: x.entry.mass,
              width: x.entry.width ?? null,
            }
            if (x.decaysTo !== undefined) entry.decaysTo = x.decaysTo
            return entry
          }),
        })),
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_jpc_check（两顶点 J^PC 检查）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_jpc_check',
    description: '两顶点 J^PC 检查：逐中间态给出可达 J^PC 与 PDG 候选。',
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
                cStatus: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', description: 'enforced | not-applicable | unknown' },
                    required: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                    reason: { type: 'string' },
                  },
                },
                decaySteps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      daughters: { type: 'array', items: { type: 'string' } },
                      identical: { type: 'boolean', description: '引擎事实：已声明 Constraints.identical（引擎会对称化）' },
                      identicalDerived: { type: 'boolean', description: '物理事实：两个 daughter 同 PDGID（同种粒子）。true 而 identical=false ⇒ 漏声明，引擎不会对称化' },
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
                            thresholdMargin: { oneOf: [{ type: 'number' }, { type: 'null' }], description: 'm_threshold - m_PDG（on-shell 余量）' },
                            decaysTo: { type: 'boolean', description: 'PDG 列出该态衰变到本中间态的末态对' },
                          },
                        },
                      },
                    },
                  },
                },
                cBlocked: { type: 'array', items: { type: 'string' } },
                filteredAboveThreshold: { type: 'integer', description: '因超过 on-shell 阈值而未列出的候选数' },
              },
            },
          },
          spilled: spillOutputSchema,
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        maxL: number
        intermediates: {
          name: string
          chain: string
          production?: { mother?: string; daughter?: string; threshold?: number; allowedJP?: string[]; cRequired?: number | null }
          cStatus?: { status?: string; required?: number | null; reason?: string }
          decaySteps?: { daughters: string[]; identical?: boolean; identicalDerived?: boolean; cDefined?: boolean; sl?: [number, number][]; jpc?: string[] }[]
          allowed?: {
            jpc: string
            sl?: [number, number][]
            candidates?: { id: string; mass: number; cMatch?: string; thresholdMargin?: number | null; decaysTo?: boolean }[]
          }[]
          cBlocked?: string[]
          filteredAboveThreshold?: number
        }[]
        spilled?: { locator: string; bytes: number; retrievalHint: string }
        error?: string
      }) => {
        if (value.error !== undefined) return text(`JPC 检查失败: ${value.error}`)
        const lines = [
          `JPC 检查（maxL=${value.maxL}）候选标记: * = PDG 列出衰变到该末态对, ~ = C 未定义(数据缺口); (…) = on-shell 余量 GeV`,
        ]
        for (const it of value.intermediates) {
          lines.push(`== ${it.name} (chain ${it.chain}) ==`)
          const prod = it.production
          if (prod) {
            lines.push(
              `  产生: ${prod.mother ?? '?'} -> R + ${prod.daughter ?? '?'}, 阈值 ${prod.threshold?.toFixed(4) ?? '?'}, ` +
                `允许 J^P: ${prod.allowedJP?.join(' ') ?? '?'}`,
            )
          }
          const cs = it.cStatus
          if (cs) {
            const tag =
              cs.status === 'enforced'
                ? `C 约束：enforced${cs.required !== undefined && cs.required !== null ? `，C(R)=${cs.required > 0 ? '+' : '-'} 必需` : ''}`
                : cs.status === 'not-applicable'
                  ? 'C 约束：不适用（某端无 C）'
                  : 'C 约束：未知（缺运动学）'
            lines.push(`  ${tag}${cs.reason ? ` — ${cs.reason}` : ''}`)
          }
          for (const st of it.decaySteps ?? []) {
            const flag = st.identical
              ? ' (identical, 已声明)'
              : st.identicalDerived
                ? ' (⚠ 同 PDGID 未声明 identical — 引擎不会对称化)'
                : ''
            lines.push(
              `  衰变: ${st.daughters.join(' + ')}${flag}${st.sl ? ` sl=${JSON.stringify(st.sl)}` : ''} -> J^PC: ${st.jpc?.join(' ') ?? '?'}`,
            )
          }
          for (const a of it.allowed ?? []) {
            const cands = (a.candidates ?? [])
              .slice(0, 10)
              .map((c) => {
                const marks = `${c.decaysTo === true ? '*' : ''}${c.cMatch === 'unknown' ? '~' : ''}`
                const margin =
                  typeof c.thresholdMargin === 'number'
                    ? `(${c.thresholdMargin >= 0 ? '+' : ''}${c.thresholdMargin.toFixed(3)})`
                    : ''
                return `${c.id}${marks}${margin}`
              })
              .join(', ')
            lines.push(`  ✓ ${a.jpc} (sl ${(a.sl ?? []).map((s) => `${s[0]}/${s[1]}`).join(' ')}) 候选: ${cands}${(a.candidates ?? []).length > 10 ? ' …' : ''}`)
          }
          if (typeof it.filteredAboveThreshold === 'number' && it.filteredAboveThreshold > 0) {
            lines.push(`  （另有 ${it.filteredAboveThreshold} 个候选因超过 on-shell 阈值未列出）`)
          }
          const req = it.cStatus?.required
          if ((it.allowed ?? []).length === 0 && (req === 1 || req === -1)) {
            // Cascade intermediate whose decay step has an intermediate
            // daughter: no pair C to inspect, but the production vertex still
            // fixes C(R). Say so instead of showing an empty list.
            lines.push(
              `  （衰变顶点无法解析出分波；该组内共振态的 PDG C 必须为 ${req > 0 ? '+' : '-'}，` +
                `否则 auto_pwa_validate_add 会以 c-violation 拒绝）`,
            )
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
          }
        }
      }
      // The two-vertex analysis lives in the shared core (src/intermediate-jpc.ts)
      // — the same code the write gate (validateResonanceAddition) enforces.
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
        cStatus?: { status: string; required: 1 | -1 | null; reason: string }
        decaySteps?: {
          daughters: string[]
          identical?: boolean
          identicalDerived?: boolean
          cDefined?: boolean
          sl?: [number, number][]
          jpc?: string[]
        }[]
        allowed?: {
          jpc: string
          c: 1 | -1 | null
          sl: [number, number][]
          candidates: { id: string; mass: number; width: number | null; cMatch: string; thresholdMargin: number | null; decaysTo: boolean }[]
        }[]
        cBlocked?: string[]
        filteredAboveThreshold?: number
      }[] = []
      for (const chainName of chains) {
        const chain = cfg.decayChains[chainName]
        for (const intName of Object.keys(chain.intermediates)) {
          const ana = analyzeIntermediateJPC(cfg, defaultDb, intName, { maxL })
          if (ana === undefined) continue
          const kin = cfg.kinematics[intName]
          // Daughters of every decay step of this intermediate, used to flag
          // which candidates the PDG actually lists decaying to this system.
          const decayToSets = ana.decaySteps.map((s) => s.daughters).filter((d) => d.length >= 2)
          let filteredAboveThreshold = 0
          const allowed: {
            jpc: string
            c: 1 | -1 | null
            sl: [number, number][]
            candidates: { id: string; mass: number; width: number | null; cMatch: string; thresholdMargin: number | null; decaysTo: boolean }[]
          }[] = []
          for (const w of ana.allowed) {
            const candidates = lookupResonance(defaultDb, { jp: { j: w.j, p: w.p } })
              .filter((r) => {
                if (w.c === null) return true
                return r.c === w.c || r.c === undefined // undefined C = data gap, flagged
              })
              .filter((r) => {
                // On-shell threshold: a state above m_mother - m_spectator
                // cannot be produced in this channel (validate_add errors on it),
                // so it must not be offered as a candidate here either.
                if (kin === undefined || r.mass <= kin.threshold) return true
                filteredAboveThreshold += 1
                return false
              })
              .map((r) => ({
                id: r.id,
                mass: r.mass,
                width: r.width ?? null,
                cMatch: w.c === null ? 'n/a' : r.c === w.c ? 'yes' : 'unknown',
                thresholdMargin: kin !== undefined ? kin.threshold - r.mass : null,
                decaysTo: decayToSets.some((d) => hasDecayTo(r, d)),
              }))
              // PDG-listed decays first, then by mass ascending.
              .sort((a, b) => (a.decaysTo === b.decaysTo ? a.mass - b.mass : a.decaysTo ? -1 : 1))
            allowed.push({ jpc: w.jpc, c: w.c, sl: w.sl, candidates })
          }
          // Optional fields are omitted rather than set to undefined: the tool
          // framework's lossless-JSON gate rejects own keys holding undefined,
          // which is what emitted `production: undefined` for chain
          // intermediates that have no production vertex.
          const production: {
            mother?: string
            daughter?: string
            threshold?: number
            allowedJP: string[]
            cRequired: 1 | -1 | null
          } | undefined = ana.production
            ? {
                allowedJP: ana.production.allowedJP.map((a) => `${a.j}${a.p > 0 ? '+' : '-'}`),
                cRequired: ana.production.cRequired ?? null,
                ...(ana.production.mother !== undefined ? { mother: ana.production.mother } : {}),
                ...(ana.production.daughter !== undefined ? { daughter: ana.production.daughter } : {}),
                ...(ana.production.threshold !== undefined ? { threshold: ana.production.threshold } : {}),
              }
            : undefined
          intermediates.push({
            name: intName,
            chain: ana.chain,
            ...(production !== undefined ? { production } : {}),
            cStatus: { status: ana.cStatus.status, required: ana.cStatus.required, reason: ana.cStatus.reason },
            decaySteps: ana.decaySteps.map((s) => {
              const step: { daughters: string[]; identical: boolean; identicalDerived: boolean; cDefined: boolean; sl?: [number, number][]; jpc: string[] } = {
                daughters: s.daughters,
                identical: s.identical,
                identicalDerived: s.identicalDerived,
                cDefined: s.cDefined,
                jpc: s.jpc,
              }
              if (s.sl !== null) step.sl = s.sl
              return step
            }),
            allowed,
            cBlocked: ana.cBlocked,
            ...(filteredAboveThreshold > 0 ? { filteredAboveThreshold } : {}),
          })
        }
      }
      const out: { configPath: string; maxL: number; intermediates: unknown[]; error?: string; spilled?: { locator: string; bytes: number; retrievalHint: string } } =
        { configPath: args.configPath, maxL, intermediates }
      // Spill oversized outputs so long autonomous sessions stay lean
      // (model reads the locator on demand instead of carrying the payload).
      const ref = await maybeSpill(ctx, exec, 'auto_pwa_jpc_check', JSON.stringify(out), null)
      return ref === null ? out : { ...out, spilled: ref }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_init_config（从 0 创建 config：结构化提案 → 渲染 → 门禁 → 人工复核）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_init_config',
    description:
      '从 0 起草 init_config.yml（4/5 体先枚举全部一级拓扑；未写划分建议在 topology.excluded 说明）',
    parameters: {
      dir: { type: 'string', required: true, description: '分析目录（绝对路径）；写入 <dir>/<fileName>' },
      fileName: { type: 'string', description: '文件名，默认 init_config.yml' },
      preview: { type: 'boolean', description: 'true = 只构建/校验并返回文本，不写文件（先看再写）' },
      spec: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'InitialConfigSpec：particles/chains/resonances/constraints/data/plot/topology/precision',
        properties: {
          particles: {
            type: 'array',
            required: true,
            description: 'Particles 段。只写 pdgid（J/P/mass 自动取自 PDG）；或显式给 j/p/mass',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: '分析名（config 键，如 Kp/pi01）' },
                pdgid: { type: 'integer', description: '有符号 MC 编号（π⁰=111、K⁺=321、K⁻=−321、p=2212、Λ=3122）' },
                j: { type: 'number' }, p: { type: 'integer' }, mass: { type: 'number' },
                c: { type: 'integer' }, tex: { type: 'string' },
                polarization: {
                  type: 'array',
                  items: { type: 'number' },
                  description: '初态极化 2m 列表（ctpwa polarization:），如 J/ψ 的 [-1, 1]（仅横向）；省略 = 全部 2J+1 态',
                },
              },
            },
          },
          chains: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: '链名，如 decay1' },
                steps: {
                  type: 'array',
                  required: true,
                  description: '所有两体步：产生步（mother 是粒子）+ 级联步（mother 是中间态）',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      mother: { type: 'string', required: true },
                      daughters: { type: 'array', required: true, items: { type: 'string' }, description: '恰好两个' },
                      sl: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '(2S+1, L) 白名单' },
                      pBreak: { type: 'boolean' }, hasBf: { type: 'boolean' }, bfD: { type: 'number' },
                    },
                  },
                },
                intermediates: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true, description: '如 R_KK' },
                      groups: {
                        type: 'array',
                        required: true,
                        description: '[J,P] 组，顺序即振幅块索引（trans 引用它）',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: { j: { type: 'number' }, p: { type: 'integer' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          resonances: {
            type: 'array',
            description: '要挂到中间态 [J,P] 组的共振态（每个都过物理门禁）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                chain: { type: 'string', required: true, description: '中间态名，如 R_KK' },
                jpGroup: { type: 'object', required: true, additionalProperties: false, properties: { j: { type: 'number' }, p: { type: 'integer' } } },
                model: { type: 'string', required: true, enum: ['BWR', 'BW', 'ONE', 'Flatte'] },
                parameters: { type: 'array', required: true, items: { type: 'number' } },
                free: { type: 'array', items: { type: 'integer' } },
                freeRange: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                tex: {
                  oneOf: [
                    { type: 'string' as const },
                    { type: 'array' as const, items: { type: 'string' as const } },
                  ],
                  description: 'LaTeX 标签：字符串，或与 config 一致的数组形式（多段标签如 ["K_{2}", "(1980)"]）；写回统一归一化成数组（不会嵌套）',
                },
                channels: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                reference: { type: 'string' },
              },
            },
          },
          constraints: { type: 'object', additionalProperties: true, description: 'Constraints：maxL / identical / trans / bf_d / has_bf / fix_var / free_var / var_range / var_equal / gauss_constr' },
          data: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              order: { type: 'array', required: true, items: { type: 'string' }, description: '末态粒子顺序（branch 顺序）' },
              data: { type: 'array', required: true, description: "如 ['dat','./data.dat'] 或 ['ROOT',path,'TTree',branch...]" },
              phsp: { type: 'array' },
              phspTruth: { type: 'array' },
              bkg: { type: 'array' },
              bkgWeights: { type: 'array' },
            },
          },
          plot: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                expression: {
                  oneOf: [
                    { type: 'string' as const },
                    { type: 'array' as const, items: { type: 'string' as const } },
                  ],
                  description: '1D 给一个表达式；2D 给两个表达式的数组（ctpwa 读成两个观测），如 ["M2([pip,pim])","M2([pip,pi0])"]',
                },
                bins: { type: 'array', items: { type: 'integer' } },
                ranges: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                display: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          precision: { type: 'string' },
          topology: {
            type: 'object',
            additionalProperties: false,
            description:
              '4/5 体第一级拓扑取舍：未写入 chains 的划分必须在 excluded 中逐条写 kind/particles/reason，否则 preview 警告、写文件被拒',
            properties: {
              excluded: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true, description: '如 "2+2"' },
                    particles: {
                      type: 'array',
                      required: true,
                      items: { type: 'array', items: { type: 'string' } },
                      description: '两个 side 的末态粒子名，如 [["etap","pip"],["pim","pi0"]]',
                    },
                    reason: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          written: { type: 'boolean', required: true },
          initConfigPath: { type: 'string' },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          errors: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          warnings: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          },
          reviewSummary: { type: 'string', required: true },
          configText: { type: 'string' },
          requiresHumanReview: { type: 'boolean', required: true },
          spilled: spillOutputSchema,
        },
      },
      render: (_args, value: {
        ok: boolean
        written: boolean
        initConfigPath?: string
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
        reviewSummary: string
        requiresHumanReview: boolean
        configText?: string
        spilled?: { locator: string; retrievalHint: string }
      }) => {
        const lines = [value.reviewSummary]
        if (value.ok) {
          lines.push(
            '',
            value.written
              ? `已写入 ${value.initConfigPath}（requiresHumanReview=true）——请把上面的摘要给用户确认；通过后 auto_pwa_iter_start(baseConfigPath=${value.initConfigPath})`
              : '（preview 模式，未写文件）',
          )
          // Preview is the "look before you write" path: show the actual YAML.
          // Without this the caller cannot see the compact-form shape (and a
          // flat production step used to slip through to a 0-amplitude file).
          if (value.configText !== undefined) {
            lines.push('', '--- 渲染结果（config.yml）---', value.configText)
          }
        } else {
          lines.push('', '存在 errors：已拒绝写文件，请修正 spec 后重试。')
        }
        if (value.spilled) lines.push(`（完整输出已 spill: ${value.spilled.locator} — ${value.spilled.retrievalHint}）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { dir: string; fileName?: string; preview?: boolean; spec: InitialConfigSpec }, exec) {
      noteAnalysisRoot(args.dir)
      const spec = args.spec
      if (
        spec === null ||
        typeof spec !== 'object' ||
        !Array.isArray(spec.particles) ||
        !Array.isArray(spec.chains) ||
        spec.data === undefined
      ) {
        return {
          ok: false,
          written: false,
          changed: [],
          errors: [{ code: 'invalid-spec', message: 'spec 必须含 particles[]、chains[]、data{}' }],
          warnings: [],
          reviewSummary: 'spec 结构不合法：至少需要 particles[]、chains[]、data{}。',
          requiresHumanReview: true,
        }
      }
      const r = buildInitialConfig(spec, defaultDb, { baseDir: args.dir })
      const initConfigPath = join(args.dir, args.fileName ?? 'init_config.yml')
      // A from-scratch spec that omits a physics-bearing particle field silently
      // changes the model. The canonical case: the user's J/psi has
      // `polarization: [-1, 1]` (2 transverse states) but the rewrite omits it,
      // so ctpwa sums all 2J+1 = 3 states. Warn before overwriting.
      if (r.errors.length === 0 && existsSync(initConfigPath)) {
        try {
          const old = parseConfig(readFileSync(initConfigPath, 'utf8'))
          const oldParticles = old.raw.get('Particles')
          const dropped: string[] = []
          for (const p of spec.particles) {
            const props = oldParticles instanceof Map ? oldParticles.get(p.name) : undefined
            if (!(props instanceof Map)) continue
            for (const key of ['pdgid', 'c', 'polarization', 'tex'] as const) {
              const oldValue = props.get(key)
              if (oldValue === undefined) continue
              const newValue =
                key === 'pdgid' ? p.pdgid : key === 'c' ? p.c : key === 'polarization' ? p.polarization : p.tex
              if (newValue === undefined || (Array.isArray(newValue) && newValue.length === 0)) {
                dropped.push(`Particles.${p.name}.${key}=${JSON.stringify(oldValue)}`)
              }
            }
          }
          if (dropped.length > 0) {
            r.warnings.push({
              code: 'dropped-particle-field',
              message:
                `目标 ${args.fileName ?? 'init_config.yml'} 里已有、但 spec 未提供：${dropped.join(', ')}。` +
                `重写会丢弃这些字段（物理量会变，例如省略 polarization = 全部 2J+1 态）；` +
                `请在 spec 里显式给出，或确认这是有意的。`,
            })
          }
        } catch {
          // Unreadable target: the write path backs it up, so no extra warning.
        }
      }
      const reviewSummary = renderInitReview(spec, r)
      if (r.errors.length > 0 || r.text === undefined) {
        return { ok: false, written: false, initConfigPath, changed: r.changed, errors: r.errors, warnings: r.warnings, reviewSummary, requiresHumanReview: true }
      }
      if (args.preview === true) {
        return { ok: true, written: false, initConfigPath, changed: r.changed, errors: [], warnings: r.warnings, reviewSummary, configText: r.text, requiresHumanReview: true }
      }
      // Atomic write with backup (mirrors auto_pwa_edit_config).
      mkdirSync(args.dir, { recursive: true })
      if (existsSync(initConfigPath)) copyFileSync(initConfigPath, `${initConfigPath}.bak`)
      const tmp = join(args.dir, `.${args.fileName ?? 'init_config.yml'}.tmp-${Date.now().toString(36)}`)
      writeFileSync(tmp, r.text)
      renameSync(tmp, initConfigPath)
      const out = { ok: true, written: true, initConfigPath, changed: r.changed, errors: [], warnings: r.warnings, reviewSummary, requiresHumanReview: true }
      const ref = await maybeSpill(ctx, exec, 'auto_pwa_init_config', JSON.stringify(out), null)
      return ref === null ? out : { ...out, spilled: ref }
    },
  }))


  ctx.tools.register(defineTool({
    name: 'auto_pwa_config_view',
    description: 'config.yml 只读视图：粒子/链/共振态/约束/校验/阈值余量。',
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
          particles: { type: 'array', items: { type: 'object', additionalProperties: true } },
          chains: { type: 'array', items: { type: 'object', additionalProperties: true } },
          resonances: { type: 'array', items: { type: 'object', additionalProperties: true } },
          kinematics: { type: 'array', items: { type: 'object', additionalProperties: true } },
          constraints: { type: 'object', additionalProperties: true },
          topologyCoverage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              finalState: { type: 'array', items: { type: 'string' } },
              topologies: { type: 'array', items: { type: 'object', additionalProperties: true } },
              present: { type: 'integer' },
              total: { type: 'integer' },
            },
          },
          validation: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
                },
              },
              warnings: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
                },
              },
            },
          },
          spilled: spillOutputSchema,
        },
      },
      render: (_args, value: {
        particles?: {
          name: string
          jp: string
          mass: number
          pdgid?: number | null
          pdgName?: string
          selfConjugate?: boolean
          pdgC?: number | null
          antiparticle?: string | null
          pdgUnknown?: boolean
          polarization?: number[] | null
        }[]
        chains?: { name: string; intermediates: string; steps: number }[]
        resonances?: { name: string; jp: string; jpSource?: string; model: string; pdg?: string | null; jpcMatch?: boolean | null; thresholdMargin?: { chain: string; margin: number } | null }[]
        kinematics?: { intermediate: string; threshold: number }[]
        constraints?: { identical?: string[][]; maxL?: number; trans?: number }
        topologyCoverage?: TopologyCoverage
        validation?: { ok: boolean; errors: { code: string; message: string }[]; warnings: { code: string; message: string }[] }
      }) => {
        const lines = [`config 视图: ${value.particles?.length ?? 0} particles, ${value.chains?.length ?? 0} chains, ${value.resonances?.length ?? 0} resonances`]
        for (const p of value.particles ?? []) {
          if (p.pdgid === undefined || p.pdgid === null) continue
          const bits: string[] = [`  ${p.name} [${p.jp}] pdgid=${p.pdgid}`]
          if (p.pdgName !== undefined) bits.push(`= ${p.pdgName}`)
          if (p.pdgUnknown === true) bits.push('⚠ PDG 表中无此 id')
          else {
            if (p.selfConjugate === true) bits.push('自共轭')
            if (typeof p.pdgC === 'number') bits.push(`C=${p.pdgC > 0 ? '+' : '-'}`)
            if (p.antiparticle !== undefined && p.antiparticle !== null) bits.push(`↔ ${p.antiparticle}`)
          }
          if (p.polarization !== undefined && p.polarization !== null && p.polarization.length > 0) {
            bits.push(`polarization=[${p.polarization.join(',')}]`)
          }
          lines.push(bits.join(' '))
        }
        const con = value.constraints
        if (con && Object.keys(con).length > 0) {
          lines.push(`Constraints: maxL=${con.maxL ?? '-'} identical=${JSON.stringify(con.identical ?? [])} trans=${con.trans ?? 0} 条`)
        }
        if (value.topologyCoverage !== undefined) {
          lines.push('', ...renderTopologyCoverage(value.topologyCoverage))
        }
        for (const r of value.resonances ?? []) {
          const m = r.thresholdMargin
          lines.push(
            `  ${r.name} [${r.jp}${r.jpSource === 'group' ? ' 由组决定' : ''}] ${r.model} ${r.pdg ? `PDG=${r.pdg}${r.jpcMatch === false ? ' (JPC 不一致!)' : ''}` : 'PDG 未命中'}${m ? ` 阈值余量 ${m.margin >= 0 ? '+' : ''}${m.margin.toFixed(4)}` : ''}`,
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
      noteAnalysisRoot(args.configPath)
      const cfg = parseConfig(readFileSync(args.configPath, 'utf8'))
      const filter = args.filter ?? 'all'
      const out: Record<string, unknown> = { configPath: args.configPath }
      if (filter === 'all' || filter === 'particles') {
        out.particles = Object.entries(cfg.particles).map(([name, p]) => {
          const item: Record<string, unknown> = {
            name,
            jp: `${p.j}${p.p > 0 ? '+' : '-'}`,
            mass: p.mass,
            c: p.c ?? null,
            pdgid: p.pdgid ?? null,
          }
          // `Particle` does not model `polarization` (checks don't use it), but
          // the view must show it: dropping it silently changes the physics
          // (J/psi: 3 states instead of the 2 transverse ones).
          const rawParticles = cfg.raw.get('Particles')
          const props = rawParticles instanceof Map ? rawParticles.get(name) : undefined
          const pol = props instanceof Map ? props.get('polarization') : undefined
          if (Array.isArray(pol)) item.polarization = pol
          if (p.pdgid !== undefined) {
            const info = getParticleInfo(defaultDb, p.pdgid)
            if (info === undefined) {
              item.pdgUnknown = true
            } else {
              item.pdgName = info.name
              item.selfConjugate = info.selfConjugate
              item.pdgC = cValueOf(info) ?? null
              item.pdgG = info.g ?? null
              item.pdgJ = info.j ?? null
              item.pdgP = info.p ?? null
              const anti = info.selfConjugate ? p.pdgid : info.conjugate
              if (anti !== undefined) {
                item.antiparticlePdgid = anti
                item.antiparticle = getParticleInfo(defaultDb, anti)?.name ?? null
              }
            }
          }
          return item
        })
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
        // First-level combinatorics (1+3 / 2+2 / ...): what the data can
        // support is a physics choice, but an omitted partition should be
        // visible, not silent.
        const dataRaw = cfg.raw.get('Data')
        const orderRaw = dataRaw instanceof Map ? dataRaw.get('order') : undefined
        const finalState = Array.isArray(orderRaw)
          ? orderRaw.filter((x): x is string => typeof x === 'string')
          : []
        if (finalState.length >= 3) {
          try {
            out.topologyCoverage = firstLevelTopologies(cfg, finalState)
          } catch {
            // advisory view only
          }
        }
      }
      if (filter === 'all' || filter === 'resonances') {
        out.resonances = Object.entries(cfg.resonances).map(([name, spec]) => {
          const hit = lookupResonance(defaultDb, { name })[0]
          let thresholdMargin: { chain: string; margin: number } | null = null
          // ctpwa lets a resonance omit J/P: the intermediates [J,P] group then
          // governs, so collect every group the state is attached to (a
          // CP-conjugate state legitimately appears as 3/2+ and 3/2-).
          const groupJps = new Set<string>()
          for (const [cname, chain] of Object.entries(cfg.decayChains)) {
            for (const [intName, int] of Object.entries(chain.intermediates)) {
              if (!int.groups.some((g) => g.names.includes(name))) continue
              for (const g of int.groups) {
                if (g.names.includes(name)) groupJps.add(`${g.jp.j}${g.jp.p > 0 ? '+' : '-'}`)
              }
              const kin = cfg.kinematics[intName]
              // ONE 可以完全不给参数（mass 只是占位）→ 没有质量就算不出阈值余量
              if (kin && Number.isFinite(spec.parameters[0])) {
                thresholdMargin = { chain: cname, margin: kin.threshold - spec.parameters[0] }
              }
            }
          }
          const exJp = explicitJp(spec)
          const jp =
            exJp !== undefined
              ? `${exJp.j}${exJp.p > 0 ? '+' : '-'}`
              : groupJps.size > 0
                ? [...groupJps].join('/')
                : '?'
          return {
            name,
            jp,
            // 'resonance' = J/P written on the entry; 'group' = governed by the
            // intermediates [J,P] (ctpwa's normal, CP-conjugate-safe form).
            jpSource: exJp !== undefined ? 'resonance' : 'group',
            model: spec.model,
            parameters: spec.parameters,
            free: spec.free ?? null,
            reference: spec.reference ?? null,
            pdg: hit
              ? `${hit.status === 'pdg' ? '' : '[本地] '}${hit.id} ` +
                `${hit.jp.j}${hit.jp.p > 0 ? '+' : '-'}${hit.c !== undefined ? (hit.c > 0 ? '+' : '-') : ''} ` +
                `m=${hit.mass.toFixed(3)}`
              : null,
            jpcMatch: hit !== undefined && exJp !== undefined ? hit.jp.j === exJp.j && hit.jp.p === exJp.p : null,
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
        const v = validateConfig(cfg, defaultDb)
        // 2+2 production C: validateConfig keeps the structural layer; the
        // group-pair check lives in config-gate and must also be visible here.
        if (typeof cfg.raw.get('Resonances') !== 'string') {
          for (const e of productionCErrors(cfg, defaultDb)) v.errors.push({ code: e.code, message: e.message })
        }
        out.validation = { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings }
      }
      const ref = await maybeSpill(ctx, exec, 'auto_pwa_config_view', JSON.stringify(out), null)
      return ref === null ? out : { ...out, spilled: ref }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_validate_config（秒级校验：写-验回路，不碰 GPU）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_validate_config',
    description: '跑前门禁：结构/两顶点 J^PC/阈值/PDG 逐项回报；deep=true 走 ctpwa。',
    parameters: {
      configPath: { type: 'string', description: '要校验的配置文件绝对路径（与 yamlText 二选一；deep 需要它）' },
      yamlText: { type: 'string', description: '直接给 YAML 文本（还没落盘时用；此时 deep 自动跳过）' },
      deep: { type: 'boolean', description: '是否跑 ctpwa --validate-only 权威校验（默认：给了 configPath 就跑）' },
      maxL: { type: 'integer', description: '两顶点 J^PC 检查的轨道角动量上限（默认取 Constraints.maxL，否则 4）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          gateReport: { type: 'string', required: true },
          errors: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } } },
          warnings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } } },
          checks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, ran: { type: 'boolean', required: true }, errors: { type: 'integer', required: true }, warnings: { type: 'integer', required: true }, note: { type: 'string' } } } },
          stats: { type: 'object', additionalProperties: true },
          configMd5: { type: 'string' },
          ctpwa: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ran: { type: 'boolean', required: true },
              ok: { type: 'boolean', required: true },
              status: { type: 'string' },
              message: { type: 'string' },
              nAmplitudes: { type: 'integer' },
              nFreeParams: { type: 'integer' },
              paramNames: { type: 'array', items: { type: 'string' } },
              amplitudeNames: { type: 'array', items: { type: 'string' } },
              stderr: { type: 'array', items: { type: 'string' } },
              constraintEffect: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  withConstraints: { type: 'integer' },
                  withoutConstraints: { type: 'integer' },
                  keys: { type: 'array', items: { type: 'string' } },
                  noOp: { type: 'boolean' },
                },
              },
              error: { type: 'string' },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        gateReport: string
        ctpwa?: {
          ran: boolean
          ok: boolean
          status?: string
          message?: string
          nAmplitudes?: number
          nFreeParams?: number
          paramNames?: string[]
          amplitudeNames?: string[]
          stderr?: string[]
          constraintEffect?: { withConstraints: number; withoutConstraints: number; keys: string[]; noOp: boolean }
          error?: string
        }
        error?: string
      }) => {
        const lines = [value.gateReport]
        if (value.error !== undefined) lines.push(`  [error] ${value.error}`)
        const c = value.ctpwa
        if (c !== undefined) {
          lines.push(
            c.ran
              ? `  ctpwa 权威校验: ${c.ok ? '✓ 通过' : `✗ 拒绝 (${c.status ?? '?'})`}${c.message !== undefined ? ` — ${c.message}` : ''}`
              : `  ctpwa 权威校验: 未运行（${c.error ?? '?'}）`,
          )
          if (c.ran && c.ok) {
            lines.push(`  振幅 ${c.nAmplitudes ?? '?'} 个，自由参数 ${c.nFreeParams ?? '?'} 个`)
            if (c.paramNames !== undefined) {
              lines.push('  参数顺序: ' + c.paramNames.join(', '))
            }
            if (c.amplitudeNames !== undefined && c.amplitudeNames.length > 0) {
              lines.push(`  分波(${c.amplitudeNames.length}): ${c.amplitudeNames.slice(0, 20).join(', ')}${c.amplitudeNames.length > 20 ? ' …' : ''}`)
            }
            if (c.constraintEffect !== undefined) {
              const e = c.constraintEffect
              lines.push(
                `  Constraints 效果（nFreeParams）: ${e.withoutConstraints} → ${e.withConstraints}` +
                  `${e.noOp ? ' ⚠ no-op（没有减少自由参数）' : ''} [${e.keys.join('/')}]`,
              )
            }
            if (c.stderr !== undefined && c.stderr.length > 0) {
              lines.push(`  ctpwa stderr: ${c.stderr.slice(0, 5).join(' | ')}${c.stderr.length > 5 ? ` …（共 ${c.stderr.length} 行）` : ''}`)
            }
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath?: string; yamlText?: string; deep?: boolean; maxL?: number }) {
      if (args.configPath !== undefined) noteAnalysisRoot(args.configPath)
      if (args.configPath === undefined && args.yamlText === undefined) {
        return { ok: false, gateReport: '配置校验: 拒绝 — 需要 configPath 或 yamlText 之一', errors: [], warnings: [] }
      }
      const configPath = args.configPath ?? '<yamlText>'
      const text = args.yamlText ?? readFileSync(args.configPath!, 'utf8')
      let cfg: ReturnType<typeof parseConfig>
      try {
        cfg = parseConfig(text)
      } catch (e) {
        return {
          ok: false,
          gateReport: `配置校验（${configPath}）: 拒绝 — YAML 解析失败: ${(e as Error).message}`,
          errors: [{ code: 'yaml-parse', message: (e as Error).message }],
          warnings: [],
        }
      }
      const gate = gateConfig(cfg, text, defaultDb, {
        ...(args.maxL !== undefined ? { maxL: args.maxL } : {}),
      })
      const doDeep = args.deep ?? args.configPath !== undefined
      const deep: DeepValidateResult = doDeep && args.configPath !== undefined
        ? deepValidateConfig(args.configPath)
        : { ran: false, ok: false, error: args.configPath === undefined ? 'yamlText 模式无文件路径：deep 需要真实 configPath（include/相对路径要靠文件位置）' : '已关闭（deep=false）' }
      const errors = [...gate.errors]
      const warnings = [...gate.warnings]
      if (!dbIntegrity.ok && dbIntegrity.warning !== undefined) {
        // 信任锚漂移 → 跑前门禁关于"PDG 依据"的判定不可信，必须让调用方看到。
        warnings.unshift({ code: 'pdg-integrity', message: dbIntegrity.warning, severity: 'warning' as const })
      }
      if (deep.ran && !deep.ok) {
        errors.push({ code: 'ctpwa-config-invalid', message: `ctpwa 拒绝该配置: ${deep.message ?? deep.status ?? 'DecayInfo 校验失败'}`, severity: 'error' })
      } else if (!deep.ran && (args.deep === true || gate.resonancesExternal)) {
        warnings.push({ code: 'deep-check-skipped', message: `ctpwa 深度校验未运行：${deep.error ?? '?'}`, severity: 'warning' })
      }
      for (const w of deepConstraintWarnings(deep)) warnings.push({ ...w, severity: 'warning' as const })
      const ok = errors.length === 0
      return {
        ok,
        gateReport: renderGate({ ...gate, ok, errors, warnings }),
        errors: errors.map(({ code, message }) => ({ code, message })),
        warnings: warnings.map(({ code, message }) => ({ code, message })),
        checks: gate.checks,
        stats: gate.stats,
        configMd5: gate.configMd5,
        ctpwa: {
          ran: deep.ran,
          ok: deep.ok,
          ...(deep.status !== undefined ? { status: deep.status } : {}),
          ...(deep.message !== undefined ? { message: deep.message } : {}),
          ...(deep.nAmplitudes !== undefined ? { nAmplitudes: deep.nAmplitudes } : {}),
          ...(deep.nFreeParams !== undefined ? { nFreeParams: deep.nFreeParams } : {}),
          ...(deep.paramNames !== undefined ? { paramNames: deep.paramNames } : {}),
          ...(deep.amplitudeNames !== undefined ? { amplitudeNames: deep.amplitudeNames } : {}),
          ...(deep.stderr !== undefined ? { stderr: deep.stderr } : {}),
          ...(deep.constraintEffect !== undefined ? { constraintEffect: deep.constraintEffect } : {}),
          ...(deep.error !== undefined ? { error: deep.error } : {}),
        },
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_suggest（决策层：pull 驱动的候选发现）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_suggest',
    description: '按 pull>3σ 质量区 × 可达 J^PC 给出 PDG 候选（含阈值余量）。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径' },
      evaluateJsonPath: { type: 'string', required: true, description: 'evaluate.json 绝对路径（auto_pwa_evaluate 的输出）' },
      decayTo: { type: 'array', items: { type: 'string' }, description: '末态粒子名（如 ["K+","eta"]），命中 PDG 衰变模式的候选会被标记' },
      maxPerIntermediate: { type: 'integer', description: '每个中间态最多候选数（默认 8）' },
      alignWindow: { type: 'number', description: 'pull 区对齐窗口 GeV（默认 0.5）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          configPath: { type: 'string', required: true },
          evaluateJsonPath: { type: 'string', required: true },
          suggestions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                intermediate: { type: 'string', required: true },
                chain: { type: 'string', required: true },
                jpc: { type: 'string', required: true },
                c: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                resonance: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, mass: { type: 'number', required: true }, width: { oneOf: [{ type: 'number' }, { type: 'null' }] } } },
                alignGap: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                targetRegion: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }] },
                threshold: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                margin: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                decaysTo: { type: 'boolean' },
                reason: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        suggestions: {
          intermediate: string
          jpc: string
          resonance: { id: string; mass: number }
          alignGap: number | null
          targetRegion: [number, number] | null
          margin: number | null
          decaysTo: boolean
          reason: string
        }[]
        error?: string
      }) => {
        if (!value.ok) return text(`suggest 失败: ${value.error ?? '未知'}`)
        if (value.suggestions.length === 0) return text('（无候选：没有 pull 区对齐或物理允许的 PDG 共振态）')
        const lines = ['候选建议（按中间态 / 对齐度排序）:']
        let last = ''
        for (const s of value.suggestions) {
          const head = s.intermediate !== last ? `\n[${s.intermediate}] ${s.jpc}:` : ''
          last = s.intermediate
          lines.push(
            `${head} ${s.resonance.id} m=${s.resonance.mass.toFixed(4)}${s.margin !== null ? ` 阈值余量 ${s.margin >= 0 ? '+' : ''}${s.margin.toFixed(4)}` : ''}${s.decaysTo ? ' ★衰变命中' : ''} — ${s.reason}`,
          )
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath: string; evaluateJsonPath: string; decayTo?: string[]; maxPerIntermediate?: number; alignWindow?: number }) {
      try {
        const cfg = parseConfig(readFileSync(args.configPath, 'utf8'))
        const ev = JSON.parse(readFileSync(args.evaluateJsonPath, 'utf8')) as { distributions?: Record<string, unknown> }
        const suggestions = suggestCandidates(cfg, defaultDb, ev as never, {
          decayTo: args.decayTo,
          maxPerIntermediate: args.maxPerIntermediate,
          alignWindow: args.alignWindow,
        })
        return { ok: true, configPath: args.configPath, evaluateJsonPath: args.evaluateJsonPath, suggestions }
      } catch (e) {
        return { ok: false, configPath: args.configPath, evaluateJsonPath: args.evaluateJsonPath, suggestions: [], error: (e as Error).message }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_validate_add
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_validate_add',
    description: '加态只读门禁：PDG 依据/JPC/阈值/顶点/重复/free；首轮默认固定，tune 给范围。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径' },
      proposal: { ...proposalParam, required: true },
      massTolerance: { type: 'number', description: '运动学阈值容差 GeV' },
      decayTo: { type: 'array', items: { type: 'string' }, description: '末态粒子（用于衰变模式 warning）' },
      floatPolicy: {
        type: 'string',
        enum: ['fixed', 'tune'],
        description: 'fixed（默认）= 首轮建议固定 mass/width；tune = 给可选的 free/freeRange（后续调节轮）',
      },
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
          const fs = value.floatSuggestion
          if (fs.free !== undefined && fs.free.length > 0) {
            lines.push(`float 建议: free=${JSON.stringify(fs.free)} range=${JSON.stringify(fs.freeRange ?? [])}`)
            lines.push(`  ${fs.rationale}`)
            // 落地方式必须写出来：改一个**已定义/已挂链**的态（把参数放开、改 free_range）
            // 只能带 proposal.update=true —— 否则会被 duplicate/param-conflict 拦下。
            lines.push(
              '  落地：edit_config 带同样的 proposal 再加 update=true（+free/freeRange）；' +
                '只对**新建**的态才不需要 update。',
            )
          } else {
            const range = fs.freeRange !== undefined && fs.freeRange.length > 0 ? `（可选范围 ${JSON.stringify(fs.freeRange)}）` : ''
            lines.push(`参数建议: 首轮固定，不 float${range}`)
            lines.push(`  ${fs.rationale}`)
            lines.push('  若后续拟合显示质量 pull>2σ 或参数撞 free_range 边界，再用 floatPolicy=tune 取具体 free/freeRange。')
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: {
      configPath: string
      proposal: ResonanceProposal
      massTolerance?: number
      decayTo?: string[]
      floatPolicy?: 'fixed' | 'tune'
    }) {
      const cfg = parseConfig(readFileSync(args.configPath, 'utf8'))
      // 本分析的本地登记（<analysis>/local-states.json）也参与查找，但语义仍是
      // "本地、非 PDG"（只出 warning，不满足 PDG 依据）。
      const result = validateResonanceAddition(dbWithLocal(defaultDb, analysisRootOf(args.configPath)), cfg, args.proposal, {
        massTolerance: args.massTolerance,
        decayTo: args.decayTo,
      })
      if (!dbIntegrity.ok && dbIntegrity.warning !== undefined) {
        // 信任锚漂移时，"PDG 依据"这条检查本身不可信 → 必须让调用方看到。
        result.warnings.unshift({ code: 'pdg-integrity', message: dbIntegrity.warning })
      }
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
        out.floatSuggestion = suggestFree(pdg, args.proposal, {
          threshold: kin.threshold,
          centerOnProposal: args.proposal.reference !== undefined && args.proposal.reference.trim() !== '',
          mode: args.floatPolicy === 'tune' ? 'tune' : 'first-pass',
        })
      }
      return out
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_trans_suggest
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_trans_suggest',
    description: '按同位旋 CG 给 trans 耦合比值，并检查 C 宇称（通用，需给 I/I3）',
    parameters: {
      base: { type: 'string', required: true, description: '基准链名（比值 1）' },
      chains: {
        type: 'array',
        required: true,
        description: '链列表；每条链给出 name + steps（mother, daughters 二元）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            steps: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mother: { type: 'string', required: true },
                  daughters: { type: 'array', required: true, items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      particles: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'name -> {I, I3, C?}；I/I3 必填，C 可选（用于 C 守恒检查）',
      },
      checkC: { type: 'boolean', description: '是否做逐顶点 C 检查（默认 true；缺 C 时只 warning）' },
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
          ratios: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                base: { type: 'string', required: true },
                target: { type: 'string', required: true },
                ratio: { type: 'number', required: true },
                cgBase: { type: 'number', required: true },
                cgTarget: { type: 'number', required: true },
                cStatus: { type: 'string', required: true, enum: ['ok', 'violation', 'unknown'] },
                vertexFactors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      mother: { type: 'string', required: true },
                      daughters: { type: 'array', required: true, items: { type: 'string' } },
                      cg: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
          },
          trans: {
            type: 'object',
            additionalProperties: false,
            properties: {
              names: { type: 'array', required: true, items: { type: 'string' } },
              value: { type: 'array', required: true, items: { type: 'number' } },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`trans 建议: ${value.ok ? '✓' : '✗'}（${value.ratios.length} 条目标链）`]
        for (const e of value.errors) lines.push(`  [error] ${e.code}: ${e.message}`)
        for (const w of value.warnings) lines.push(`  [warn]  ${w.code}: ${w.message}`)
        for (const r of value.ratios) {
          lines.push(
            `  ${r.target}/${r.base} = ${r.ratio.toPrecision(8)}（CG ${r.cgTarget.toPrecision(6)} / ${r.cgBase.toPrecision(6)}, C=${r.cStatus}）`,
          )
        }
        if (value.trans) {
          lines.push('')
          lines.push('可直接放进 Constraints.trans（名字按你的实际链名替换；比值不改）：')
          lines.push(`  - [${value.trans.names.join(', ')}]: [${value.trans.value.map((v: number) => v.toPrecision(8)).join(', ')}]`)
        }
        lines.push('')
        lines.push('说明：比值是同位旋 CG（Condon–Shortley）；C 只逐顶点检查，不参与比值符号。')
        lines.push('若 ctpwa 的振幅对 daughter 顺序/相位约定不同，先按此值拟合，再用 ΔNLL 检查 ±1。')
        return text(lines.join('\n'))
      },
    },
    async execute(args: {
      base: string
      chains: { name: string; steps: { mother: string; daughters: string[] }[] }[]
      particles: Record<string, { I: number; I3: number; C?: 1 | -1 }>
      checkC?: boolean
    }) {
      const chains = args.chains.map((c) => ({
        name: c.name,
        steps: c.steps.map((s) => ({
          mother: s.mother,
          daughters: [s.daughters[0] ?? '', s.daughters[1] ?? ''] as [string, string],
        })),
      }))
      const out = suggestTransRatios({
        base: args.base,
        chains,
        particles: args.particles,
        ...(args.checkC !== undefined ? { checkC: args.checkC } : {}),
      })
      return {
        ok: out.ok,
        errors: out.errors,
        warnings: out.warnings,
        ratios: out.ratios,
        ...(out.trans !== null ? { trans: out.trans } : {}),
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_edit_config
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_edit_config',
    description: '写态/挂链：物理校验→写前总闸→原子写(+.bak)→本地 git 提交。',
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
      // Final gate: the WHOLE resulting config must pass the structural
      // validation (identical groups, trans refs, maxL ...) and the
      // cross-reference check before anything is written to disk.
      const finalV = validateConfig(applied.config, defaultDb)
      const finalXref = crossReferenceErrors(applied.config)
      if (finalV.errors.length > 0 || finalXref.errors.length > 0) {
        return {
          ok: false,
          written: false,
          changed: [],
          errors: [...finalV.errors, ...finalXref.errors],
          warnings: v.warnings,
          configPath,
          resonanceCount: Object.keys(cfg.resonances).length,
        }
      }
      const rendered = dumpConfig(applied.config)
      // Atomic write: freeze the pre-first-edit original, tmp file, rename.
      const backupPath = snapshotOnce(configPath)
      const tmpPath = join(dirname(configPath), `.config.yml.tmp-${Date.now().toString(36)}`)
      writeFileSync(tmpPath, rendered)
      renameSync(tmpPath, configPath)
      const gitRec = gitRecord(configPath, [configPath], `config: ${applied.changed[0] ?? 'edit'}${applied.changed.length > 1 ? ` (+${applied.changed.length - 1})` : ''}`, { 'Pwa-Kind': 'config' })
      return {
        ok: true,
        written: true,
        changed: [...applied.changed, ...(gitRec.changed !== undefined ? [gitRec.changed] : [])],
        errors: [...finalV.errors, ...finalXref.errors],
        warnings: [...v.warnings, ...finalXref.warnings, ...finalV.warnings, ...gitRec.warnings],
        configPath,
        backupPath,
        resonanceCount: Object.keys(applied.config.resonances).length,
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_remove_resonance
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_remove_resonance',
    description: '摘除共振态（显著性剪枝）；[J,P] 组保留以维持 trans 索引。',
    parameters: {
      configPath: { type: 'string', required: true, description: 'config.yml 绝对路径（会被修改）' },
      removals: { ...removalListParam, required: true },
      reason: { type: 'string', description: '删除原因（写入返回，便于迭代日记归因，如 "份额 < 2σ / 撞 free_range 边界"）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          written: { type: 'boolean', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          detached: { type: 'array', required: true, items: { type: 'string' } },
          dropped: { type: 'array', required: true, items: { type: 'string' } },
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
        detached: string[]
        dropped: string[]
        errors: { code: string; message: string }[]
        warnings: { code: string; message: string }[]
        configPath: string
        backupPath?: string
        resonanceCount: number
      }) => {
        if (!value.ok) {
          return text(`拒绝删除（${value.errors.length} errors）:\n${value.errors.map((e) => `  [error] ${e.code}: ${e.message}`).join('\n')}`)
        }
        const lines = [`已删除（写入 ${value.configPath}，备份 ${value.backupPath}）:`, ...value.changed.map((c) => `  ${c}`)]
        if (value.dropped.length > 0) lines.push(`  删除的 Resonances 定义: ${value.dropped.join(', ')}`)
        if (value.warnings.length > 0) lines.push(...value.warnings.slice(0, 6).map((w) => `  [warn] ${w.code}: ${w.message}`))
        if (value.warnings.length > 6) lines.push(`  … 共 ${value.warnings.length} 条 warning`)
        lines.push(`剩余共振态总数: ${value.resonanceCount}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { configPath: string; removals: ResonanceRemoval[]; reason?: string }) {
      const configPath = args.configPath
      const cfg = parseConfig(readFileSync(configPath, 'utf8'))
      const before = Object.keys(cfg.resonances).length
      const detached: string[] = []
      const dropped: string[] = []
      for (const r of args.removals) {
        const dry = validateResonanceRemoval(cfg, r)
        if (!dry.ok) {
          return { ok: false, written: false, changed: [], detached, dropped, errors: dry.errors, warnings: dry.warnings, configPath, resonanceCount: before }
        }
        detached.push(...dry.detached)
        if (dry.definitionDropped) dropped.push(r.name)
        const ap = applyResonanceRemoval(cfg, r)
        if (ap.errors.length > 0) {
          return { ok: false, written: false, changed: [], detached, dropped, errors: ap.errors, warnings: dry.warnings, configPath, resonanceCount: before }
        }
      }
      // Final gate: whole-config structural + cross-reference validation.
      const finalV = validateConfig(cfg, defaultDb)
      const finalXref = crossReferenceErrors(cfg)
      if (finalV.errors.length > 0 || finalXref.errors.length > 0) {
        return {
          ok: false,
          written: false,
          changed: [],
          detached,
          dropped,
          errors: [...finalV.errors, ...finalXref.errors],
          warnings: [...finalV.warnings, ...finalXref.warnings],
          configPath,
          resonanceCount: before,
        }
      }
      const backupPath = snapshotOnce(configPath)
      const tmpPath = join(dirname(configPath), `.config.yml.tmp-${Date.now().toString(36)}`)
      writeFileSync(tmpPath, dumpConfig(cfg))
      renameSync(tmpPath, configPath)
      const gitRec = gitRecord(configPath, [configPath], `config: remove ${args.removals.map((r) => r.name).join(', ')}`, proposalTrailers(undefined, undefined, args.removals))
      return {
        ok: true,
        written: true,
        changed: [...detached, ...(gitRec.changed !== undefined ? [gitRec.changed] : [])],
        detached,
        dropped,
        errors: [],
        warnings: [...finalV.warnings, ...finalXref.warnings, ...gitRec.warnings],
        configPath,
        backupPath,
        resonanceCount: Object.keys(cfg.resonances).length,
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_iter_start
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_iter_start',
    description: '[仅新 baseline] 建 iterations/iter-N/（复制基座 config、软链 fit.py）。',
    parameters: {
      iterationsRoot: { type: 'string', required: true, description: 'iterations/ 目录（如 <分析目录>/iterations）' },
      baseConfigPath: { type: 'string', required: true, description: '本轮基座 config.yml（上一轮的 config 或项目初始 config）' },
      fitScriptPath: { type: 'string', description: 'fit.py 来源（默认插件自带 scripts/aifit.py；可用 PWA_FIT_SCRIPT 覆盖）' },
      plotScriptPath: { type: 'string', description: 'plot.py 来源（默认无；可用 PWA_PLOT_SCRIPT 设置）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iter: { type: 'integer', required: true },
          iterDir: { type: 'string', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { iter: number; iterDir: string; changed: string[]; warnings?: string[]; error?: string }) => {
        const warn = value.warnings ?? []
        return text(
          value.error
            ? `迭代目录创建失败: ${value.error}`
            : `iter-${String(value.iter).padStart(3, '0')}: ${value.iterDir}\n${value.changed.map((c) => '  ' + c).join('\n')}` +
                (warn.length > 0 ? `\n${warn.map((w) => '  [warn] ' + w).join('\n')}` : ''),
        )
      },
    },
    async execute(args: { iterationsRoot: string; baseConfigPath: string; fitScriptPath?: string; plotScriptPath?: string }) {
      try {
        const r = startIteration({
          iterationsRoot: args.iterationsRoot,
          baseConfigPath: args.baseConfigPath,
          fitScriptPath: args.fitScriptPath ?? resolveEnv().fitScript,
          plotScriptPath: args.plotScriptPath ?? resolveEnv().plotScript,
        })
        // B2：新迭代目录（config + note 骨架）立即入库
        const gitRec = gitRecord(r.iterDir, [`${r.iterDir}/config.yml`, `${r.iterDir}/note.md`], `iter-${String(r.iter).padStart(3, '0')}: new iteration from ${args.baseConfigPath}`, { 'Pwa-Kind': 'start', 'Pwa-Iter': r.iter })
        return {
          iter: r.iter,
          iterDir: r.iterDir,
          changed: [...r.changed, ...(gitRec.changed !== undefined ? [gitRec.changed] : [])],
          warnings: [...r.warnings, ...gitRec.warnings.map((w) => w.message)],
        }
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
    description: '写迭代日记（SUMMARY/HTML）并 git 提交；includeTokens 记 token 成本。',
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
      hypothesis: { type: 'string', description: '本轮假设（物理上预期什么被吸收/改变）——与 prediction 配对' },
      prediction: {
        type: 'object',
        additionalProperties: false,
        properties: {
          metric: { type: 'string', required: true, enum: ['maxPull', 'deltaNll', 'regionPull'] },
          region: { type: 'array', items: { type: 'number' } },
          threshold: { type: 'number', required: true },
          direction: { type: 'string', required: true, enum: ['below', 'above'] },
        },
        description: '可验证预测（下轮 loop_next 自动验证）',
      },
      verification: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          actual: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          note: { type: 'string', required: true },
        },
        description: '上一轮预测的验证结果（从 loop_next 的 verification 字段抄录）',
      },
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
          gitCommit: { type: 'string', description: '本地 git 记录的提交（B2；PWA_GIT=off 时无）' },
          gitWarning: { type: 'string', description: 'git 记录失败的原因（不阻塞）' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) =>
        text(
          value.ok
            ? `已记录第 ${value.iter} 轮 → ${value.summaryPath}（共 ${value.records} 轮）` +
              (value.gitCommit !== undefined ? `，git ${value.gitCommit}` : '') +
              (value.gitWarning !== undefined ? `\n  [warn] git 记录未完成: ${value.gitWarning}` : '')
            : `记录失败: ${value.error ?? '未知'}`,
        ),
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
      hypothesis?: string
      prediction?: Prediction
      verification?: VerificationResult
      notes?: string[]
      /** 记入本轮 token 消耗（token-meter：上次记账以来的差值）。 */
      includeTokens?: boolean
    }, exec) {
      const root = iterationsRootOf(args.iterDir)
      const m = /iter-(\d+)/.exec(args.iterDir)
      if (!m) return { ok: false, iter: -1, summaryPath: '', records: 0, error: `iterDir 不含 iter-N: ${args.iterDir}` }
      const log = new IterationLog({ rootDir: root })
      // **严格 delta 硬要求（告警级）**：`added`/`removed` 两类轮次若不写 `+=`/`-=`，
      // 后来的 tried 索引与"是否仍在模型中"就只能靠读散文猜（docs §8.6 缺陷 2）。
      const deltaWarn = strictDeltaWarning(args.kind, args.changes)
      // 规范化 delta 一并落盘：reader 之后**不必再解析散文**（老记录没这个字段，照旧）
      const canonDelta = canonicalDelta(args.changes)
      const noteWarnings = [...(args.warnings ?? []), ...(deltaWarn !== undefined ? [deltaWarn] : [])]
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
        ...(noteWarnings.length > 0 ? { warnings: noteWarnings } : {}),
        ...(canonDelta.length > 0 ? { changesDelta: canonDelta } : {}),
        floatDecision: args.floatDecision,
        conclusion: args.conclusion,
        nextPlan: args.nextPlan,
        evidence: args.evidence,
        hypothesis: args.hypothesis,
        prediction: args.prediction,
        verification: args.verification,
        notes: args.notes,
      }
      // B1：把该目录的拟合记录（config md5 / 态清单 / 初值来源 / runs）一并写进日记，
      // 半年后能复现，也能判断两次拟合是否可比。
      const prov = readProvenance(args.iterDir)
      if (prov !== undefined) record.provenance = provenanceSummary(prov)
      // The real Agent carries `id` (its `sessionId` field does not exist).
      const agentId = exec.agent?.id ?? exec.agent?.sessionId
      if (args.includeTokens === true && agentId !== undefined) {
        const t: TokenTotals = usage.takeDelta(agentId)
        record.tokens = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }
      }
      try {
        log.append(record)
        // B2：结果入库——日记、note、fit.json、provenance 同一提交里，
        // 于是"这轮的结论/NLL"和"当时的配置"永远对得上。
        const iterLabel = `iter-${String(record.iter).padStart(3, '0')}`
        const nllBit = record.nll !== undefined ? ` NLL=${record.nll.toFixed(2)}` : ''
        const dBit = record.deltaNll !== undefined ? ` dNLL=${record.deltaNll >= 0 ? '+' : ''}${record.deltaNll.toFixed(2)}` : ''
        const pdBit = record.hessianPositive === false ? ' [Hessian not PD]' : ''
        // 把"当时实际拟合的配置"和结果放进同一个提交：provenance 里记的
        // configPath 才是真相（可能是 variant.yml，而不是 config.yml）。
        const provForGit = readProvenance(args.iterDir)
        const fittedConfig = provForGit?.configPath ?? `${args.iterDir}/config.yml`
        const gitRec = gitRecord(args.iterDir, [
          log.summaryPath,
          `${args.iterDir}/note.md`,
          `${args.iterDir}/results/fit.json`,
          `${args.iterDir}/results/provenance.json`,
          fittedConfig,
        ], `${iterLabel} result: ${record.title}${nllBit}${dBit}${pdBit}`, {
          'Pwa-Kind': 'result',
          'Pwa-Decision': record.kind,
          'Pwa-Iter': record.iter,
          ...(record.nll !== undefined ? { 'Pwa-NLL': record.nll.toFixed(2) } : {}),
          ...(record.deltaNll !== undefined ? { 'Pwa-Delta-NLL': record.deltaNll.toFixed(2) } : {}),
          ...(record.hessianPositive !== undefined ? { 'Pwa-Hessian-PD': record.hessianPositive } : {}),
          ...(provForGit?.configMd5 !== undefined ? { 'Pwa-Config-Md5': provForGit.configMd5 } : {}),
        })
        return {
          ok: true,
          iter: record.iter,
          summaryPath: log.summaryPath,
          records: log.readAll().length,
          ...(gitRec.commit !== undefined ? { gitCommit: gitRec.commit } : {}),
          ...(gitRec.warnings[0] !== undefined ? { gitWarning: gitRec.warnings[0].message } : {}),
        }
      } catch (e) {
        return { ok: false, iter: record.iter, summaryPath: log.summaryPath, records: 0, error: (e as Error).message }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_git_log（B2：本地 git 记录，只读查看）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_git_log',
    description: '本地 git：log/show/search/status（查某态/参数是哪轮引入）。',
    parameters: {
      anyPath: { type: 'string', description: '分析目录内的任意路径（分析目录、iterations/、迭代目录或 config 文件），用于定位仓库（等价于旧名 path）' },
      path: { type: 'string', description: '[已弃用别名，用 anyPath]' },
      action: { type: 'string', required: true, enum: ['log', 'show', 'search', 'status'] as const, description: 'log=最近提交；show=某提交的 diff；search=pickle 查找文本引入于哪轮；status=仓库状态' },
      rev: { type: 'string', description: 'action=show 用：提交（sha / 标签；默认 HEAD）' },
      needle: { type: 'string', description: 'action=search 用：要查找的文本（如共振态名 X1750）' },
      file: { type: 'string', description: '限定路径（相对分析目录，如 config.yml）；show=只显示该文件，search=只搜该文件' },
      limit: { type: 'integer', description: 'log / search 的条数（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          analysisDir: { type: 'string', required: true },
          initialized: { type: 'boolean', required: true },
          commit: { type: 'string' },
          dirty: { type: 'boolean' },
          untracked: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                short: { type: 'string', required: true },
                date: { type: 'string' },
                subject: { type: 'string', required: true },
                trailers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      key: { type: 'string', required: true },
                      value: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          text: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        action: string
        analysisDir: string
        initialized: boolean
        commit?: string
        dirty?: boolean
        untracked?: number
        entries?: { short: string; date?: string; subject: string; trailers?: { key: string; value: string }[] }[]
        text?: string
        note?: string
        error?: string
      }) => {
        if (!value.ok) return text(`git 记录不可用: ${value.error ?? '未知'}`)
        const head = `本地 git（${value.analysisDir}/.pwa-git）`
        if (!value.initialized) {
          return text(`${head}: 尚未初始化\n  ${value.note ?? '下次工具写 config / note 时自动创建'}`)
        }
        const lines = [`${head}${value.commit !== undefined ? ` @ ${value.commit}` : ''}${value.dirty === true ? ' ⚠️ 有未提交改动' : ''}${typeof value.untracked === 'number' && value.untracked > 0 ? `（未跟踪 ${value.untracked}）` : ''}`]
        if (value.action === 'log' && value.entries !== undefined) {
          if (value.entries.length === 0) lines.push('  （无提交）')
          for (const e of value.entries) {
            lines.push(`  ${e.short} ${e.date ?? ''} ${e.subject}`)
            if (e.trailers !== undefined && e.trailers.length > 0) {
              lines.push(`      ${e.trailers.map((t) => `${t.key}=${t.value}`).join('  ')}`)
            }
          }
        } else if (value.text !== undefined && value.text.trim() !== '') {
          lines.push(value.text.trim())
        } else {
          lines.push('  （无输出）')
        }
        if (value.note !== undefined) lines.push(`  ${value.note}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: {
      anyPath?: string
      path?: string
      action: 'log' | 'show' | 'search' | 'status'
      rev?: string
      needle?: string
      file?: string
      limit?: number
    }) {
      const anchor = args.anyPath ?? args.path
      if (anchor === undefined) {
        return { ok: false, action: args.action, analysisDir: '', initialized: false, error: '需要 anyPath（分析目录内的任意路径）' }
      }
      const analysisDir = analysisRootOf(anchor)
      const base = { action: args.action, analysisDir }
      if (gitDisabled()) return { ok: false, ...base, initialized: false, error: 'PWA_GIT=off：本地 git 记录已关闭' }
      if (!gitAvailable()) return { ok: false, ...base, initialized: false, error: 'git 不可用（PATH 里找不到 git）' }
      const st = repoStatus(analysisDir)
      const statusBits = {
        initialized: st.initialized,
        ...(st.commit !== undefined ? { commit: st.commit } : {}),
        dirty: st.dirty,
        ...(st.untracked !== undefined ? { untracked: st.untracked } : {}),
      }
      if (!st.initialized) {
        return { ok: true, ...base, ...statusBits, note: '该目录还没有 .pwa-git：工具写 config / note 时会自动创建并开始记录' }
      }
      const limit = Math.max(1, Math.min(args.limit ?? 20, 200))
      // `file` may be given relative to the analysis dir OR to `path`'s own
      // directory (iterations/iter-001/config.yml vs config.yml) — accept both.
      const resolveFile = (): string | undefined => {
        if (args.file === undefined) return undefined
        let base = analysisDir
        try {
          base = lstatSync(anchor).isDirectory() ? anchor : dirname(anchor)
        } catch {
          base = analysisDir
        }
        for (const cand of [resolve(base, args.file), resolve(analysisDir, args.file)]) {
          if (existsSync(cand)) {
            const rel = relInside(analysisDir, cand)
            if (rel !== undefined) return rel
          }
        }
        return args.file
      }
      const file = resolveFile()
      if (args.action === 'log') {
        const entries = gitLog(analysisDir, limit).map((e) => ({
          short: e.short,
          ...(e.date !== undefined ? { date: e.date } : {}),
          subject: e.subject,
          ...(e.trailers !== undefined
            ? { trailers: Object.entries(e.trailers).map(([key, value]) => ({ key, value })) }
            : {}),
        }))
        return { ok: true, ...base, ...statusBits, entries }
      }
      if (args.action === 'status') {
        // S0：共存探测——外层仓库是否已经被"污染"，以及信息性的位置提示。
        const coex = repoCoexistence(analysisDir)
        const actionable = coex.issues.filter(
          (i) => i.code === 'pwa-git-tracked-by-enclosing' || i.code === 'gitignore-tracked-by-enclosing',
        )
        const info = coex.issues.filter(
          (i) => i.code === 'analysis-inside-other-repo' || i.code === 'analysis-is-repo-root',
        )
        const note = [
          st.dirty === true
            ? '已跟踪文件与 HEAD 不同：当前 results/ 不能由 HEAD 复现（provenance.git.dirty=true）'
            : '已跟踪文件与 HEAD 一致（未跟踪的新文件不影响已记录 config 的可复现性）',
          ...actionable.map((i) => `⚠️ ${i.message}`),
          ...info.map((i) => `ℹ️ ${i.message}`),
        ].join('\n')
        return { ok: true, ...base, ...statusBits, note }
      }
      if (args.action === 'show') {
        const rev = args.rev ?? 'HEAD'
        const r = gitShow(analysisDir, rev, file)
        return { ok: r.ok, ...base, ...statusBits, ...(r.ok ? { text: r.stdout } : { error: r.error }) }
      }
      // search
      const needle = args.needle ?? ''
      if (needle === '') return { ok: false, ...base, ...statusBits, error: 'action=search 需要 needle' }
      const r = gitSearch(analysisDir, needle, file, limit)
      return {
        ok: r.ok,
        ...base,
        ...statusBits,
        ...(r.ok ? { text: r.stdout.trim() === '' ? `（没有提交引入/删除含 "${needle}" 的行）` : r.stdout } : { error: r.error }),
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_history
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_history',
    description: '读日记并折叠状态；支持 needle/iter/kind/status/limit/asOf。',
    parameters: {
      iterationsRoot: { type: 'string', required: true, description: 'iterations/ 目录' },
      needle: { type: 'string', description: '按键检索：只保留标题/结论/下一步/变更里含该文本的记录（如共振态名 X1750）' },
      iter: { type: 'integer', description: '只取这一轮（如 7 = iter-007）' },
      kind: { type: 'string', description: '只取该决策类型（added/removed/float/converged/other）' },
      status: { type: 'string', enum: ['all', 'rejected', 'verified', 'pending'] as const, description: 'rejected=被回退/否决的轮次；verified=带验证结果；pending=有预测但未验证' },
      limit: { type: 'integer', description: '只返回最近 N 条（默认全部）' },
      asOf: { type: 'integer', description: 'as-of 快照：只看 iter-N 及其之前的记录，并**按该前缀折叠当前状态**（回答“截至 iter-N 时基线是哪轮/现状如何”用；否则要逐轮 iter=0..N 遍历）' },
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
                timestamp: { type: 'string' },
                floatDecision: { type: 'string' },
                notes: { type: 'array', items: { type: 'string' } },
                warnings: { type: 'array', items: { type: 'string' } },
                hypothesis: { type: 'string' },
                prediction: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    metric: { type: 'string', required: true },
                    threshold: { type: 'number', required: true },
                    direction: { type: 'string', required: true },
                    region: { type: 'array', items: { type: 'number' } },
                  },
                },
                verification: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    passed: { type: 'boolean', required: true },
                    actual: { type: 'number' },
                    note: { type: 'string', required: true },
                  },
                },
                tokens: { type: 'object', additionalProperties: false, properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } } },
              },
            },
          },
          nextIter: { type: 'integer', required: true },
          iterDirs: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer', required: true },
          state: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              baseIter: { type: 'integer' },
              rule: { type: 'string' },
              confidence: { type: 'string', required: true },
              naiveMaxIter: { type: 'integer' },
              naiveAgrees: { type: 'boolean', required: true },
              bestNllIter: { type: 'integer' },
              rejected: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    iter: { type: 'integer', required: true },
                    label: { type: 'string', required: true },
                    deltaNll: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value: {
        records: {
          iter: number
          title: string
          kind: string
          nll?: number
          deltaNll?: number
          conclusion?: string
          nextPlan?: string
          tokens?: { input: number; output: number }
          hypothesis?: string
          verification?: { passed: boolean; actual?: number; note: string }
          warnings?: string[]
          notes?: string[]
          floatDecision?: string
        }[]
        nextIter: number
        iterDirs: string[]
        total: number
        state: {
          baseIter?: number
          rule?: string
          confidence: string
          naiveMaxIter?: number
          naiveAgrees: boolean
          bestNllIter?: number
          rejected: { iter: number; label: string; deltaNll?: number }[]
        }
      }) => {
        const pad = (n: number): string => String(n).padStart(3, '0')
        const asOf = (args as { asOf?: number }).asOf
        const head: string[] = [
          `迭代历史（${value.records.length}/${value.total} 轮，下一轮 iter-${pad(value.nextIter)}）` +
            (asOf !== undefined ? ` 〔as-of：只看到 iter-${pad(asOf)} 为止〕` : ''),
        ]
        const s = value.state
        const base = s.baseIter === undefined ? '未知' : `iter-${pad(s.baseIter)}`
        const disagree = s.naiveAgrees ? '' : ` ⚠️ 最后一条记录是 iter-${pad(s.naiveMaxIter ?? -1)}，"取最新一轮"会答错`
        head.push(`  当前状态（代码 fold，非模型记忆）: ΔNLL 比对基线 ${base}（rule=${s.rule ?? 'n/a'}, confidence=${s.confidence}）${disagree}`)
        if (s.bestNllIter !== undefined) head.push(`  目前 NLL 最低的一轮: iter-${pad(s.bestNllIter)}（≠ 比对基线时不要混用）`)
        if (s.rejected.length > 0) {
          head.push(
            `  已否决/回退（${s.rejected.length}）: ${s.rejected
              .map((r) => `iter-${pad(r.iter)} ${r.label}${r.deltaNll === undefined ? '' : ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(1)}`}`)
              .join('；')}`,
          )
        }
        if (value.records.length === 0) return text([...head, '  （无匹配记录）'].join('\n'))
        const lines = value.records.map((r) => {
          const d = r.deltaNll === undefined ? '' : ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(1)}`
          const t = r.tokens ? ` [tokens: ${r.tokens.input}+${r.tokens.output}]` : ''
          const c = r.conclusion ? ` | 结论: ${r.conclusion.slice(0, 120)}` : ''
          const p = r.nextPlan ? ` | 下一步: ${r.nextPlan.slice(0, 120)}` : ''
          const rows = [`iter-${pad(r.iter)} ${r.title}${d}${t}${c}${p}`]
          if (r.hypothesis !== undefined) rows.push(`    ↳ 假设: ${r.hypothesis.slice(0, 140)}`)
          if (r.verification !== undefined) {
            const actual = r.verification.actual === undefined ? 'n/a' : String(r.verification.actual)
            rows.push(`    ↳ 验证: ${r.verification.passed ? '成立' : '不成立'}（actual=${actual}）${r.verification.note.slice(0, 120)}`)
          }
          if (r.floatDecision !== undefined) rows.push(`    ↳ float: ${r.floatDecision.slice(0, 100)}`)
          if (r.warnings !== undefined && r.warnings.length > 0) rows.push(`    ↳ 警告: ${r.warnings.slice(0, 3).join(' / ').slice(0, 160)}`)
          if (r.notes !== undefined && r.notes.length > 0) rows.push(`    ↳ 笔记: ${r.notes.slice(0, 2).join(' / ').slice(0, 140)}`)
          return rows.join('\n')
        })
        return text([...head, ...lines].join('\n'))
      },
    },
    async execute(args: { iterationsRoot: string; needle?: string; iter?: number; kind?: string; status?: string; limit?: number; asOf?: number }) {
      noteAnalysisRoot(args.iterationsRoot)
      const log = new IterationLog({ rootDir: args.iterationsRoot })
      const all = log.readAll()
      // **as-of 快照**：只保留 iter-N 及其之前的记录，折叠/否决/NLL 最低等全部基于该前缀。
      // 这样"截至 iter-N 的状态"一次调用就能答（此前 agent 只能逐轮 iter=0..N 遍历）。
      const view = args.asOf !== undefined ? all.filter((r) => r.iter <= args.asOf!) : all
      // "被否决"的文本信号**只看 title**：title 描述本轮结果，而 conclusion 常在叙述
      // **别的**轮次（实测：iter-009 的结论在讲"iter-010 已证伪 → 回退"），用它会把
      // 好轮次误标成被否。
      const rejectedText = /回退|回滚|被拒|否决|被否|不采纳/
      const isRejected = (r: IterationRecord): boolean => r.kind === 'removed' || rejectedText.test(r.title)
      const matchesStatus = (r: IterationRecord): boolean => {
        switch (args.status) {
          case 'rejected':
            return isRejected(r)
          case 'verified':
            return r.verification !== undefined
          case 'pending':
            return r.prediction !== undefined && r.verification === undefined
          default:
            return true
        }
      }
      const needle = args.needle?.trim()
      let kept = view.filter((r) => {
        if (args.iter !== undefined && r.iter !== args.iter) return false
        if (args.kind !== undefined && r.kind !== args.kind) return false
        if (!matchesStatus(r)) return false
        if (needle !== undefined && needle !== '') {
          const blob = [r.title, r.conclusion ?? '', r.nextPlan ?? '', r.hypothesis ?? '', r.evidence ?? '', ...(r.changes ?? []), ...(r.warnings ?? []), ...(r.notes ?? [])].join(' ')
          if (!blob.includes(needle)) return false
        }
        return true
      })
      if (args.limit !== undefined && args.limit > 0) kept = kept.slice(-args.limit)

      const fold = modelBaselineFold(view)
      const naive = naiveAnswers(view)
      const bestNllIter = view.reduce<number | undefined>((best, r) => {
        if (typeof r.nll !== 'number') return best
        if (best === undefined) return r.iter
        const bestRec = view.find((x) => x.iter === best)
        return typeof bestRec?.nll === 'number' && bestRec.nll <= r.nll ? best : r.iter
      }, undefined)

      const records = kept.map((r) => {
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
          timestamp?: string
          floatDecision?: string
          notes?: string[]
          warnings?: string[]
          hypothesis?: string
          prediction?: IterationRecord['prediction']
          verification?: { passed: boolean; note: string; actual?: number }
          tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
        } = { iter: r.iter, title: r.title, kind: r.kind }
        if (r.nll !== undefined) out.nll = r.nll
        if (r.deltaNll !== undefined) out.deltaNll = r.deltaNll
        if (r.hessianPositive !== undefined) out.hessianPositive = r.hessianPositive
        if (r.changes !== undefined) out.changes = r.changes
        if (r.conclusion !== undefined) out.conclusion = r.conclusion
        if (r.nextPlan !== undefined) out.nextPlan = r.nextPlan
        if (r.evidence !== undefined) out.evidence = r.evidence
        if (r.timestamp !== undefined) out.timestamp = r.timestamp
        if (r.floatDecision !== undefined) out.floatDecision = r.floatDecision
        if (r.notes !== undefined) out.notes = r.notes
        if (r.warnings !== undefined) out.warnings = r.warnings
        if (r.hypothesis !== undefined) out.hypothesis = r.hypothesis
        if (r.prediction !== undefined) out.prediction = r.prediction
        if (r.verification !== undefined) {
          // `actual` 在真实日记里可能是 null（无法判定）——schema 只声明 number，
          // 所以这里**省略**而不是写 null，否则输出校验会失败。
          out.verification = {
            passed: r.verification.passed,
            note: r.verification.note,
            ...(typeof r.verification.actual === 'number' ? { actual: r.verification.actual } : {}),
          }
        }
        if (r.tokens !== undefined) out.tokens = r.tokens
        return out
      })
      const rejected = view
        .filter(isRejected)
        .slice(-8)
        .map((r) => ({
          iter: r.iter,
          label: r.title.slice(0, 60),
          ...(r.deltaNll !== undefined ? { deltaNll: r.deltaNll } : {}),
        }))
      return {
        records,
        nextIter: args.asOf !== undefined ? args.asOf + 1 : log.nextIter(),
        iterDirs: listIterations(args.iterationsRoot),
        total: view.length,
        state: {
          ...(fold.baseIter !== null ? { baseIter: fold.baseIter } : {}),
          ...(fold.rule !== undefined ? { rule: fold.rule } : {}),
          confidence: fold.confidence,
          ...(naive.maxIter !== null ? { naiveMaxIter: naive.maxIter } : {}),
          naiveAgrees: naive.maxIter === fold.baseIter,
          ...(bestNllIter !== undefined ? { bestNllIter } : {}),
          rejected,
        },
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_evaluate
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_evaluate',
    description: '把 weight_best.root 数值化：chi2/ndf、max|pull|、份额、勒让德矩。',
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
                has_background: { type: 'boolean', description: '该分布是否含本底模板 hbkg；true 时 pull=(data-(fit+bkg))/sqrt(fit+bkg)，false 时 pull=(data-fit)/sqrt(fit)' },
                pull_regions_over_3sigma: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                worst_bin: { type: 'object', additionalProperties: false, properties: { center: { type: 'number' }, pull: { type: 'number' } } },
                meta: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string' },
                    particles: { type: 'array', items: { type: 'string' } },
                    intermediate: { type: 'string' },
                    display: { type: 'array', items: { type: 'string' } },
                  },
                  description: 'Plot 段元信息（kind=mass/cosbeta/angle/custom，intermediate=匹配到的中间态）——新 expr 画图格式下分布目录名不再含质量/角度信息，靠它识别',
                },
                moments: {
                  type: 'object',
                  additionalProperties: false,
                  properties: momentProperties,
                  description: '1D 勒让德矩（角分布）：{L: {data, fit, delta}}——数据-拟合矩差指示缺失/多余的 J（自旋 0 介子对需 J>=L/2 才有 M_L）',
                },
                moments2d: {
                  type: 'object',
                  additionalProperties: false,
                  properties: moment2dProperties,
                  description: '2D（质量×cosθ）勒让德矩：每个 L 是逐质量 bin 的数组、无 delta，与 massBins 对齐；诊断看 max|data−fit| 落在哪个 L、哪个质量 bin',
                },
                massBins: { type: 'array', items: nullableNumberParam, description: '2D 矩图的质量 bin 中心（无数据的 bin 为 null）' },
              },
            },
          },
          pngFiles: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
          spilled: spillOutputSchema,
        },
      },
      render: (_args, value: {
        ok: boolean
        error?: string
        worst: { name: string; chi2_ndf?: number; max_abs_pull: number; bins_over_5sigma: number }[]
        distributions?: {
          name: string
          has_background?: boolean
          moments?: Record<string, { data?: number; fit?: number; delta?: number }>
          moments2d?: Record<string, { data: (number | null)[]; fit: (number | null)[] }>
          massBins?: (number | null)[]
        }[]
        evaluateJsonPath: string
        pngFiles?: string[]
        spilled?: { locator: string; retrievalHint: string }
      }) => {
        if (!value.ok) return text(`评估失败: ${value.error ?? '未知错误'}`)
        const lines = ['拟合质量评估（按最差排序）:']
        const withBkg = (value.distributions ?? []).filter((d) => d.has_background === true).length
        lines.push(
          withBkg > 0
            ? `  residual = data-(fit+bkg)，pull=(data-(fit+bkg))/sqrt(fit+bkg)（${withBkg} 个分布含本底）`
            : '  residual = data-fit，pull=(data-fit)/sqrt(fit)（无本底模板）',
        )
        for (const w of value.worst) {
          lines.push(
            `  ${w.name}: chi2/ndf=${w.chi2_ndf ?? '—'}, max|pull|=${w.max_abs_pull}, ` +
              `>5σ bins=${w.bins_over_5sigma}${w.max_abs_pull > 5 ? ' ⚠️严重' : w.max_abs_pull > 3 ? ' ⚠️' : ''}`,
          )
        }
        const moments = (value.distributions ?? []).filter((d) => d.moments !== undefined)
        for (const d of moments) {
          const ms = d.moments!
          const worst = Object.entries(ms)
            .map(([L, v]) => ({ L: Number(L), delta: Math.abs(v?.delta ?? 0) }))
            .sort((a, b) => b.delta - a.delta)[0]
          if (worst !== undefined && worst.delta > 0.02) {
            const v = ms[worst.L]!
            const dlt = v?.delta ?? 0
            lines.push(
              `  矩 M_${worst.L}（${d.name}）: 数据=${v?.data} 拟合=${v?.fit} Δ=${dlt > 0 ? '+' : ''}${dlt} ` +
                `${dlt > 0 ? '—— 数据矩高于拟合：缺该 J 波' : '—— 拟合矩高于数据：该 J 波可能多余'}`,
            )
          }
        }
        // 2D (mass × cosθ) moments: no delta, so the diagnostic is the worst mass
        // bin's |data − fit| for each L — that is where the angular structure is
        // not described well, and which L/bin to look at.
        for (const d of (value.distributions ?? []).filter((x) => x.moments2d !== undefined)) {
          const bins = d.massBins ?? []
          let worst: { L: number; bin: number; delta: number; data: number; fit: number } | undefined
          for (const [L, s] of Object.entries(d.moments2d!)) {
            const n = Math.min(s.data?.length ?? 0, s.fit?.length ?? 0)
            for (let i = 0; i < n; i++) {
              const a = s.data?.[i]
              const b = s.fit?.[i]
              if (typeof a !== 'number' || typeof b !== 'number') continue
              const delta = Math.abs(a - b)
              if (worst === undefined || delta > worst.delta) worst = { L: Number(L), bin: i, delta, data: a, fit: b }
            }
          }
          if (worst !== undefined) {
            const center = bins[worst.bin]
            lines.push(
              `  2D 矩 M_${worst.L}（${d.name}）: max|数据−拟合|=${worst.delta.toPrecision(3)} @ 质量 bin ${worst.bin}` +
                `${typeof center === 'number' ? `（${center.toFixed(3)} GeV）` : ''} ` +
                `数据=${worst.data.toPrecision(3)} 拟合=${worst.fit.toPrecision(3)} —— 该 L 的角结构在这个质量区没被描述好`,
            )
          }
        }
        lines.push(`评估 JSON: ${value.evaluateJsonPath}`)
        if (value.pngFiles && value.pngFiles.length > 0) lines.push(`PNG 图: ${value.pngFiles.length} 张`)
        if (value.spilled) lines.push(`（完整输出已 spill: ${value.spilled.locator} — ${value.spilled.retrievalHint}）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { rootPath: string; outDir?: string }, exec) {
      const script = bundledScriptPath('auto_pwa_evaluate.py')
      const outDir = args.outDir ?? `${dirname(args.rootPath)}/evaluate`
      const py = defaultFitRunnerConfig().python
      // config.yml（若有）传给 evaluate.py 做 Plot 段解析——新 expr 格式的
      // 分布目录名（obs0/...）需要它才知道"这是哪个中间态的什么分布"。
      const configPath = join(dirname(dirname(args.rootPath)), 'config.yml')
      const argv = [script, args.rootPath, outDir]
      if (existsSync(configPath)) argv.push(configPath)
      const r = spawnSync(py, argv, {
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
        has_background?: boolean
        pull_regions_over_3sigma?: number[][]
        worst_bin?: { center?: number; pull?: number }
        meta?: { kind?: string; intermediate?: string; particles?: string[]; display?: string[] }
        moments?: Record<string, { data?: number; fit?: number; delta?: number }>
        moments2d?: Record<string, { data: (number | null)[]; fit: (number | null)[] }>
        massBins?: (number | null)[]
      }[] = []
      for (const [name, d] of Object.entries(ev.distributions ?? {})) {
        if (d === null || typeof d !== 'object') continue
        const item: (typeof distributions)[number] = { name }
        const rec = d as Record<string, unknown>
        for (const k of ['chi2_ndf', 'max_abs_pull', 'bins_over_5sigma', 'bins_over_3sigma', 'pull_regions_over_3sigma', 'worst_bin'] as const) {
          if (typeof rec[k] === 'number' || typeof rec[k] === 'object') (item as Record<string, unknown>)[k] = rec[k]
        }
        if (typeof rec.has_background === 'boolean') item.has_background = rec.has_background
        if (rec.moments !== null && typeof rec.moments === 'object' && !Array.isArray(rec.moments)) {
          // Two shapes arrive under `moments`, and they must NOT share one field:
          //   - 1D angular moments : scalar {data, fit, delta};
          //   - 2D (mass × cosθ)   : per-bin series {data: [], fit: []}, no delta.
          // Feeding the arrays into the scalar schema is exactly what made every
          // evaluate call fail output validation (and silently zeroed the deltas).
          const m = rec.moments as Record<string, unknown>
          const moments: Record<string, { data?: number; fit?: number; delta?: number }> = {}
          const moments2d: Record<string, { data: (number | null)[]; fit: (number | null)[] }> = {}
          const series = (x: unknown): (number | null)[] =>
            Array.isArray(x) ? x.map((e) => (typeof e === 'number' && Number.isFinite(e) ? e : null)) : []
          for (const [L, v] of Object.entries(m)) {
            if (v === null || typeof v !== 'object') continue
            const r = v as Record<string, unknown>
            if (Array.isArray(r.data) || Array.isArray(r.fit)) {
              moments2d[L] = { data: series(r.data), fit: series(r.fit) }
              continue
            }
            const entry: { data?: number; fit?: number; delta?: number } = {}
            if (typeof r.data === 'number') entry.data = r.data
            if (typeof r.fit === 'number') entry.fit = r.fit
            if (typeof r.delta === 'number') entry.delta = r.delta
            moments[L] = entry
          }
          if (Object.keys(moments).length > 0) item.moments = moments
          if (Object.keys(moments2d).length > 0) item.moments2d = moments2d
        }
        if (Array.isArray(rec.massBins)) item.massBins = rec.massBins.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null))
        if (rec.meta !== null && typeof rec.meta === 'object') {
          const m = rec.meta as Record<string, unknown>
          const meta: Record<string, unknown> = {}
          for (const k of ['kind', 'intermediate'] as const) if (typeof m[k] === 'string') meta[k] = m[k]
          if (Array.isArray(m.particles)) meta.particles = m.particles.filter((x): x is string => typeof x === 'string')
          if (Array.isArray(m.display)) meta.display = m.display.filter((x): x is string => typeof x === 'string')
          if (Object.keys(meta).length > 0) item.meta = meta
        }
        distributions.push(item)
      }
      // Map worst_distributions field-by-field as well (the raw Python record
      // may carry extra keys that would fail the same schema check).
      const worst: {
        name: string
        max_abs_pull: number
        chi2_ndf?: number
        bins_over_5sigma: number
      }[] = []
      for (const w of ev.worst_distributions ?? []) {
        if (w === null || typeof w !== 'object') continue
        const rec = w as Record<string, unknown>
        if (typeof rec.name !== 'string' || typeof rec.max_abs_pull !== 'number' || typeof rec.bins_over_5sigma !== 'number') continue
        const item: (typeof worst)[number] = { name: rec.name, max_abs_pull: rec.max_abs_pull, bins_over_5sigma: rec.bins_over_5sigma }
        if (typeof rec.chi2_ndf === 'number') item.chi2_ndf = rec.chi2_ndf
        worst.push(item)
      }
      const pngs = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.png')) : []
      const out = {
        ok: true,
        evaluateJsonPath: jsonPath,
        worst,
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
  // auto_pwa_diagnose（决策层：fit.json 诊断假设）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_diagnose',
    description: '把 fit.json 转成可行动假设（退化解/撞边界/份额<2σ/简并/Hessian）。',
    parameters: {
      iterDir: { type: 'string', required: true, description: '迭代目录（读其 results/fit.json）' },
      configPath: { type: 'string', description: 'config.yml 绝对路径（用于把共振态名映射到链/组，给出删除建议上下文）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          iterDir: { type: 'string', required: true },
          hasFitJson: { type: 'boolean', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true, enum: ['info', 'warn', 'danger'] },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
                suggestion: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        hasFitJson: boolean
        items: { severity: string; code: string; message: string; suggestion?: string }[]
        error?: string
      }) => {
        if (!value.ok) return text(`诊断失败: ${value.error ?? '未知'}`)
        if (!value.hasFitJson) return text('（该迭代没有 results/fit.json —— 拟合可能未完成或失败）')
        if (value.items.length === 0) return text('（无诊断项：拟合干净）')
        const icon = { info: 'ℹ️', warn: '⚠️', danger: '🚨' } as Record<string, string>
        const lines = value.items.map((i) => `${icon[i.severity] ?? '·'} [${i.code}] ${i.message}${i.suggestion ? `\n    建议: ${i.suggestion}` : ''}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { iterDir: string; configPath?: string }) {
      const fitJsonPath = `${args.iterDir}/results/fit.json`
      if (!existsSync(fitJsonPath)) {
        return { ok: true, iterDir: args.iterDir, hasFitJson: false, items: [] }
      }
      try {
        const fitJson = parseFitJson(readFileSync(fitJsonPath, 'utf8'))
        const cfg = args.configPath !== undefined ? parseConfig(readFileSync(args.configPath, 'utf8')) : undefined
        const items = diagnoseFit(fitJson, cfg)
        return { ok: true, iterDir: args.iterDir, hasFitJson: true, items }
      } catch (e) {
        return { ok: false, iterDir: args.iterDir, hasFitJson: true, items: [], error: (e as Error).message }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_root_view（决策层·视力：直接读 weight_best.root 直方图）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_root_view',
    description: '读 weight_best.root 直方图：list 列全部、read 取逐 bin。',
    parameters: {
      rootPath: { type: 'string', required: true, description: 'weight_best.root 绝对路径' },
      mode: { type: 'string', required: true, enum: ['list', 'read'], description: 'list=列全部直方图；read=取指定直方图逐 bin 数据' },
      objects: { type: 'array', items: { type: 'string' }, description: 'read 模式必填：直方图路径（如 "mass0_Kp_Km/h_chain1-R_KK-phi1020"），最多 8 个' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          rootPath: { type: 'string', required: true },
          objects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, bins: { type: 'integer', required: true } } } },
          histograms: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bins: { type: 'integer', required: true },
                range: { type: 'array', items: { type: 'number' } },
                integral: { type: 'number', required: true },
                centers: { type: 'array', items: { type: 'number' } },
                values: { type: 'array', items: { type: 'number' } },
                errors: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          spilled: spillOutputSchema,
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        mode: string
        objects?: { path: string; bins: number }[]
        histograms?: { path: string; bins: number; integral: number; range?: number[] }[]
        spilled?: { locator: string; retrievalHint: string }
        error?: string
      }) => {
        if (!value.ok) return text(`root_view 失败: ${value.error ?? '未知'}`)
        if (value.mode === 'list') {
          const objs = value.objects ?? []
          const dists = new Map<string, string[]>()
          for (const o of objs) {
            const parts = o.path.split('/')
            const dir = parts.length > 1 ? parts[0]! : '(root)'
            const name = parts[parts.length - 1]!
            if (name.startsWith('h_')) dists.set(dir, [...(dists.get(dir) ?? []), name])
          }
          const lines = [`ROOT 直方图 ${objs.length} 个:`]
          for (const [dir, waves] of [...dists.entries()].sort()) {
            lines.push(`  ${dir}: hdata/hfit/hbkg + ${waves.length} 个波谱 ${waves.slice(0, 6).join(', ')}${waves.length > 6 ? ' …' : ''}`)
          }
          return text(lines.join('\n'))
        }
        const hs = value.histograms ?? []
        const lines = [`读取 ${hs.length} 个直方图:`]
        for (const h of hs) {
          const peak = h.path
          const rng = h.range !== undefined ? ` [${h.range[0].toFixed(2)}, ${h.range[1].toFixed(2)}]` : ''
          lines.push(`  ${h.path}: ${h.bins} bins, integral=${h.integral.toFixed(0)}${rng}`)
        }
        if (value.spilled !== undefined) lines.push(`（完整逐 bin 数据已 spill: ${value.spilled.locator} — ${value.spilled.retrievalHint}）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { rootPath: string; mode: 'list' | 'read'; objects?: string[] }, exec) {
      const py = defaultFitRunnerConfig().python
      const script = bundledScriptPath('root_view.py')
      const argv = [script, args.rootPath, args.mode]
      if (args.mode === 'read') {
        if ((args.objects ?? []).length === 0) {
          return { ok: false, mode: args.mode, rootPath: args.rootPath, error: 'read 模式需要 objects' }
        }
        argv.push(...(args.objects ?? []).slice(0, 8))
      }
      const r = spawnSync(py, argv, { encoding: 'utf8', timeout: 60_000, env: { ...process.env } })
      if (r.status !== 0) {
        return { ok: false, mode: args.mode, rootPath: args.rootPath, error: (r.stderr || r.stdout || '').slice(0, 500) }
      }
      try {
        const parsed = JSON.parse(r.stdout) as { mode?: string; objects?: unknown[]; histograms?: unknown[]; error?: string }
        if (parsed.error !== undefined) {
          return { ok: false, mode: args.mode, rootPath: args.rootPath, error: parsed.error }
        }
        const out: { ok: boolean; mode: string; rootPath: string; objects?: unknown[]; histograms?: unknown[] } = {
          ok: true,
          mode: args.mode,
          rootPath: args.rootPath,
        }
        if (args.mode === 'list' && Array.isArray(parsed.objects)) out.objects = parsed.objects
        if (args.mode === 'read' && Array.isArray(parsed.histograms)) out.histograms = parsed.histograms
        const ref = await maybeSpill(ctx, exec, 'auto_pwa_root_view', JSON.stringify(out), null)
        return ref === null ? out : { ...out, spilled: ref }
      } catch (e) {
        return { ok: false, mode: args.mode, rootPath: args.rootPath, error: `解析 root_view 输出失败: ${(e as Error).message}` }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_wave_view（决策层·干涉视力：任意分波组合的分布）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_wave_view',
    description: '任意分波组合的拟合分布（与全波同归一化），可直接比数据。',
    parameters: {
      iterDir: { type: 'string', required: true, description: '迭代目录（须含 config.yml 与 results/fit.json、results/weight_best.root）' },
      waves: { type: 'array', required: true, items: { type: 'string' }, description: '要组合的波名（h_ 名去掉前缀，如 chain1-R_KK-phi1020），最多 6 个' },
      eventWeights: { type: 'boolean', description: 'true 时用逐事件 saved_weight TTree 输出干涉分布（大文件，慎用；默认 false）' },
      interfWaves: { type: 'array', items: { type: 'string' }, description: 'eventWeights=true 时额外直方图化的干涉对波名' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          iterDir: { type: 'string', required: true },
          outRoot: { type: 'string' },
          waves: { type: 'array', items: { type: 'string' } },
          histograms: {
            type: 'object',
            additionalProperties: false,
            description: 'key=hdata/hfit/hbkg/h_<name>：选中组合与各波谱的逐 bin 数据（与全波拟合同归一化）',
          },
          waveDecomp: {
            type: 'object',
            additionalProperties: false,
            description: 'eventWeights=true 时：按质量轴的各波强度与选中波对干涉分布',
          },
          error: { type: 'string' },
          // wave_view spreads the spill envelope into its result too, but its
          // schema never declared `spilled` — any large output failed validation.
          spilled: spillOutputSchema,
        },
      },
      render: (_args, value: {
        ok: boolean
        waves: string[]
        histograms?: Record<string, { integral?: number; bins?: number; range?: number[] }>
        waveDecomp?: { massAxis?: { name?: string; centers?: number[] }; waves?: Record<string, number[]>; pairs?: Record<string, number[]> }
        error?: string
        spilled?: { locator: string; retrievalHint: string }
      }) => {
        if (!value.ok) return text(`wave_view 失败: ${value.error ?? '未知'}`)
        const lines = [`组合波谱: ${value.waves.join(' + ')}`]
        const h = value.histograms ?? {}
        const fit = h['hfit']
        const data = h['hdata']
        if (fit !== undefined && data !== undefined) {
          const ratio = data.integral !== undefined && data.integral > 0 && fit.integral !== undefined ? fit.integral / data.integral : null
          lines.push(`  组合拟合 integral=${fit.integral?.toFixed(0)} vs 数据 ${data.integral?.toFixed(0)}（占比 ${ratio !== null ? (ratio * 100).toFixed(1) : '?'}%）`)
        }
        for (const [k, v] of Object.entries(h)) {
          if (k === 'hdata' || k === 'hfit' || k === 'hbkg') continue
          lines.push(`  ${k}: integral=${v.integral?.toFixed(0)} ${v.range ? `[${v.range[0].toFixed(2)}, ${v.range[1].toFixed(2)}]` : ''}`)
        }
        const d = value.waveDecomp
        if (d !== undefined && d.massAxis !== undefined) {
          const axis = d.massAxis.centers ?? []
          const pairs = Object.entries(d.pairs ?? {})
          lines.push(`  干涉分解（${d.massAxis.name ?? '?'} 轴，${Object.keys(d.waves ?? {}).length} 波 + ${pairs.length} 对）:`)
          for (const [pair, vals] of pairs) {
            if (vals.length === 0) continue
            const maxAbs = Math.max(...vals.map(Math.abs))
            const peakIdx = vals.findIndex((x) => Math.abs(x) === maxAbs)
            const peak = axis[peakIdx] !== undefined ? axis[peakIdx]?.toFixed(3) : '?'
            lines.push(`    ${pair}: 干涉峰 ${maxAbs.toFixed(3)} @ ${peak} GeV`)
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { iterDir: string; waves: string[]; eventWeights?: boolean; interfWaves?: string[] }, exec) {
      const configPath = `${args.iterDir}/config.yml`
      const fitJson = `${args.iterDir}/results/fit.json`
      if (!existsSync(configPath) || !existsSync(fitJson)) {
        return { ok: false, iterDir: args.iterDir, error: `迭代目录缺少 config.yml 或 results/fit.json: ${args.iterDir}` }
      }
      const py = defaultFitRunnerConfig().python
      const script = bundledScriptPath('wave_view.py')
      const outJson = `${args.iterDir}/_wave_view.json`
      const argv = [
        script,
        '--config', configPath,
        '--fit-json', fitJson,
        '--waves', args.waves.join(','),
        '--json', outJson,
      ]
      if (args.eventWeights === true) {
        argv.push('--event-weights')
        if ((args.interfWaves ?? []).length > 0) argv.push('--interf-waves', args.interfWaves!.join(','))
      }
      const r = spawnSync(py, argv, { encoding: 'utf8', timeout: 300_000, env: { ...process.env } })
      if (r.status !== 0) {
        return { ok: false, iterDir: args.iterDir, error: (r.stderr || r.stdout || '').slice(0, 500) }
      }
      try {
        const parsed = JSON.parse(readFileSync(outJson, 'utf8')) as { ok?: boolean; error?: string; outRoot?: string; waves?: string[]; histograms?: unknown; waveDecomp?: unknown }
        const out: { ok: boolean; iterDir: string; outRoot?: string; waves?: string[]; histograms?: unknown; waveDecomp?: unknown; error?: string } = {
          ok: parsed.ok !== false,
          iterDir: args.iterDir,
        }
        if (parsed.error !== undefined) out.ok = false
        if (parsed.outRoot !== undefined) out.outRoot = parsed.outRoot
        if (parsed.waves !== undefined) out.waves = parsed.waves
        if (parsed.histograms !== undefined) out.histograms = parsed.histograms
        if (parsed.waveDecomp !== undefined) out.waveDecomp = parsed.waveDecomp
        if (!out.ok) out.error = parsed.error
        const ref = await maybeSpill(ctx, exec, 'auto_pwa_wave_view', JSON.stringify(out), null)
        return ref === null ? out : { ...out, spilled: ref }
      } catch (e) {
        return { ok: false, iterDir: args.iterDir, error: `解析 wave_view 输出失败: ${(e as Error).message}` }
      } finally {
        try {
          // 临时 JSON 用完即删（迭代目录保持干净）
          const { rmSync } = await import('node:fs')
          rmSync(outJson, { force: true })
        } catch {
          // best-effort
        }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_run_fit（Consumer：经 ctx.pwaFit -> ctx.jobs 提交）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_run_fit',
    description: '[主路径] 提交拟合：门禁→provenance→后台任务（完成自动唤醒；等待时可做其他尝试）。',
    parameters: {
      iterDir: { type: 'string', required: true, description: '迭代目录绝对路径（须含 fit.py；配置默认取 <iterDir>/config.yml）' },
      configPath: { type: 'string', description: '要拟合的配置文件（默认 <iterDir>/config.yml）；变体实验可指向 <dir>/variant_xxx.yml —— 门禁一视同仁' },
      config: { type: 'string', description: '[已弃用别名，用 configPath]' },
      scriptArgs: { type: 'array', items: { type: 'string' }, description: '额外传给 fit.py 的参数（如 ["--runs","1","--max-iter","500"]）；记录进 provenance' },
      timeoutMin: { type: 'integer', description: '超时分钟数（默认无）' },
      timeoutMs: { type: 'integer', description: '[已弃用别名，用 timeoutMin] 超时毫秒' },
      preflight: { type: 'boolean', description: '只做 config gate + 宿主侧 GPU/SLURM 探测，不提交拟合（用于判断 transport）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['running', 'done', 'failed', 'canceled'] },
          logPath: { type: 'string', required: true },
          transport: { type: 'string', enum: ['local', 'slurm'] },
          preflight: {
            type: 'object',
            additionalProperties: false,
            properties: {
              gpu: { type: 'string', required: true },
              slurm: { type: 'boolean', required: true },
              transport: { type: 'string', required: true, enum: ['local', 'slurm'] },
            },
          },
          error: { type: 'string' },
          ...gateOutputFields,
        },
      },
      render: (_args, value: {
        error?: string
        jobId: string
        state: string
        logPath: string
        transport?: string
        preflight?: { gpu: string; slurm: boolean; transport: string }
        gate?: { ok: boolean; report: string }
      }) => text(value.error
        ? `拟合提交失败: ${value.error}\n${value.gate?.report ?? ''}`
        : value.preflight !== undefined
          ? `预检（未提交）: host GPU probe = ${value.preflight.gpu}; SLURM clients = ${value.preflight.slurm ? 'available' : 'missing'}; transport = ${value.preflight.transport}\n` +
            '这是宿主插件进程的探测结果，不是 bash 沙箱的 nvidia-smi/which。\n' +
            `${value.gate?.report ?? ''}`
          : `拟合已提交: job ${value.jobId} (${value.state}, ${value.transport ?? '?'} transport), 日志: ${value.logPath}\n` +
            '拟合完成时 DSH 会自动唤醒本会话（通知里带 job id）——**不要轮询**；收到通知后用 auto_pwa_fit_status 取结果。\n' +
            '等待期间可以继续做其他尝试（不同变体/其他 iterDir/其他分析），但不要对同一 iterDir 重复提交，也不要 bash 跑 fit。\n' +
            '完成后第一件事：auto_pwa_evaluate → auto_pwa_note，再开下一轮；不要连续跑多轮后批量补 note。\n' +
            `${value.gate?.report ?? ''}`),
    },
    async execute(
      args: { iterDir: string; configPath?: string; config?: string; scriptArgs?: string[]; timeoutMin?: number; timeoutMs?: number; preflight?: boolean },
      exec,
    ) {
      // 参数规范化：configPath 是规范名，config 是保留别名；timeoutMin 优先于 timeoutMs。
      const cfgTarget = args.configPath ?? args.config
      const timeoutMin = args.timeoutMin ?? (args.timeoutMs !== undefined ? Math.ceil(args.timeoutMs / 60_000) : undefined)
      // Variant runs: tell the driver which config to read, and gate +
      // provenance-record that same file (not merely <iterDir>/config.yml).
      const scriptArgs = withConfigArg(args.scriptArgs, cfgTarget)
      const gate = gateBeforeFit({
        iterDir: args.iterDir,
        tool: 'auto_pwa_run_fit',
        ...(cfgTarget !== undefined ? { configPath: cfgTarget } : {}),
        fitScript: join(args.iterDir, 'fit.py'),
        ...(scriptArgs !== undefined ? { scriptArgs } : {}),
      })
      if (!gate.ok) {
        return {
          jobId: '',
          state: 'failed' as const,
          logPath: join(args.iterDir, 'fit.log'),
          error: `跑前门禁拒绝（${gate.errors.length} errors）：${gate.errors.map((e) => `${e.code}: ${e.message}`).join(' | ')}`,
          gate: { ok: false, report: gate.report, errors: gate.errors, warnings: gate.warnings, configMd5: gate.gate.configMd5 },
        }
      }
      if (args.preflight === true) {
        const env = resolveEnv()
        const gpu = detectGpuAvailability(env.ctpwaPython, env.ldLibraryPath)
        const slurm = hasSlurmClients()
        const transport = pickTransport(env.ctpwaPython, env.ldLibraryPath)
        return {
          jobId: '',
          state: 'done' as const,
          logPath: join(args.iterDir, 'fit.log'),
          transport,
          preflight: { gpu: gpu ?? 'available', slurm, transport },
          gate: {
            ok: true,
            report: gate.report,
            errors: gate.errors,
            warnings: gate.warnings,
            configMd5: gate.gate.configMd5,
            ...(gate.provenanceFile !== undefined ? { provenancePath: gate.provenanceFile } : {}),
          },
        }
      }
      try {
        const jobId = ctx.pwaFit.submit(
          {
            iterDir: args.iterDir,
            timeoutMin,
            ...(scriptArgs !== undefined ? { scriptArgs } : {}),
          },
          ownerOf(exec),
        )
        const transport = (ctx.pwaFit as { transport?: string }).transport ?? 'local'
        return {
          jobId,
          state: 'running' as const,
          logPath: join(args.iterDir, 'fit.log'),
          transport,
          gate: {
            ok: true,
            report: gate.report,
            errors: gate.errors,
            warnings: gate.warnings,
            configMd5: gate.gate.configMd5,
            ...(gate.provenanceFile !== undefined ? { provenancePath: gate.provenanceFile } : {}),
            ctpwa: {
              ran: gate.deep.ran,
              ok: gate.deep.ok,
              ...(gate.deep.nAmplitudes !== undefined ? { nAmplitudes: gate.deep.nAmplitudes } : {}),
              ...(gate.deep.nFreeParams !== undefined ? { nFreeParams: gate.deep.nFreeParams } : {}),
              ...(gate.deep.paramNames !== undefined ? { paramNames: gate.deep.paramNames } : {}),
              ...(gate.deep.message !== undefined ? { message: gate.deep.message } : {}),
            },
          },
        }
      } catch (e) {
        return {
          jobId: '',
          state: 'failed' as const,
          logPath: join(args.iterDir, 'fit.log'),
          error: (e as Error).message,
          gate: { ok: true, report: gate.report, errors: gate.errors, warnings: gate.warnings, configMd5: gate.gate.configMd5 },
        }
      }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_fit_status
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_fit_status',
    description: '查后台任务：running/done/failed + 日志尾 + results 摘要。',
    parameters: {
      jobId: { type: 'string', required: true, description: 'run_fit 返回的 jobId（ctpwa-N）' },
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
        // An empty tail must not render as a fake "  | " line: ''.trim().split()
        // is [''], which is truthy and printed a bare bar for every running job.
        const tailLines = value.logTail.trim() === '' ? [] : value.logTail.trim().split('\n').slice(-6)
        if (tailLines.length > 0) lines.push(`  日志尾部:\n${tailLines.map((l) => `  | ${l}`).join('\n')}`)
        if (value.state === 'done') lines.push('  下一步：auto_pwa_evaluate → auto_pwa_note，再开下一轮；不要连续跑多轮后批量补 note。')
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
          out.summary = { files }
          if (summary.bestNll !== null) out.summary.bestNll = summary.bestNll
          if (history.lastNll !== null) out.summary.lastNll = history.lastNll
          if (summary.totalRuns !== null) out.summary.totalRuns = summary.totalRuns
          if (summary.positiveDefinite !== null) out.summary.positiveDefinite = summary.positiveDefinite
          const best = fitJson?.fit?.best
          if (best !== undefined) {
            const params = (best.params ?? [])
              .filter((p) => p.kind === 'resonance' || p.kind === 'coupling')
              .map((p) => ({
                name: p.name,
                kind: p.kind,
                ...(p.kind === 'resonance'
                  ? {
                      value: p.value ?? null,
                      error: p.error ?? null,
                      // Same lossless-output invariant as the interference block
                      // above: omit absent keys instead of writing undefined.
                      ...(p.lower !== undefined ? { lower: p.lower } : {}),
                      ...(p.upper !== undefined ? { upper: p.upper } : {}),
                      ...(p.atBoundary !== undefined ? { atBoundary: p.atBoundary } : {}),
                    }
                  : { real: p.real ?? null, imag: p.imag ?? null }),
              }))
            if (params.length > 0) out.summary.params = params
            if (best.fitFractions !== undefined && best.fitFractions !== null) {
              out.summary.fitFractions = best.fitFractions.map((f) => ({ amplitude: f.amplitude, fraction: f.fraction, error: f.error ?? null }))
            }
            if (fitJson?.fit?.warnings !== undefined) out.summary.warnings = fitJson.fit.warnings
            const inter = fitJson?.fit?.interference
            if (inter !== undefined) {
              // Absent optional keys must be OMITTED, never carried as undefined:
              // an own property whose value is undefined is dropped by
              // JSON.stringify, so the result stops being lossless and the
              // harness rejects the WHOLE tool output ("value is not lossless
              // JSON"). fit.json's interference block is either
              // {available,totalIntensity,matrix,fractions,topInterference}
              // or {available,reason} — so one of these two is always absent.
              out.summary.interference = {
                available: inter.available,
                topInterference: (inter.topInterference ?? []).map((t) => ({ pair: [...t.pair], value: t.value })),
                ...(inter.reason !== undefined ? { reason: inter.reason } : {}),
                ...(inter.totalIntensity !== undefined ? { totalIntensity: inter.totalIntensity } : {}),
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

  // ---------------------------------------------------------------------
  // auto_pwa_try_candidates（第二批：并行候选短拟合）
  // ---------------------------------------------------------------------
  // auto_pwa_try_candidates（第二批：并行候选短拟合）
  // ---------------------------------------------------------------------
  // Batch decision helpers (cluster transport): 'one' = each candidate is its
  // own SLURM job tracked as one batch (for long fits); 'script' = one merged
  // script (for short fits); 'off' = per-candidate single submit (local).
  const SLURM_BATCH_SHORT_SEC = 120
  const resolveSlurmBatchMode = (env: NodeJS.ProcessEnv, timeSec?: number): 'one' | 'script' | 'off' => {
    const v = (env.PWA_SLURM_BATCH ?? 'auto').toLowerCase().trim()
    if (v === 'one' || v === 'script') return v
    if (v === 'off') return 'off'
    if (timeSec === undefined) return 'one' // no baseline timing yet -> safe parallel batch
    return timeSec < SLURM_BATCH_SHORT_SEC ? 'script' : 'one'
  }
  const readBaselineTimeSec = (iterDir: string): number | undefined => {
    try {
      const p = join(iterDir, 'results', 'fit.json')
      if (!existsSync(p)) return undefined
      const j = JSON.parse(readFileSync(p, 'utf8')) as { timeSec?: unknown }
      return typeof j.timeSec === 'number' ? j.timeSec : undefined
    } catch {
      return undefined
    }
  }

  ctx.tools.register(defineTool({
    name: 'auto_pwa_try_candidates',
    description: '并行短拟合 2–5 个候选（各建 _trials、--runs 1 --max-iter 500）。',
    parameters: {
      baseIterDir: { type: 'string', required: true, description: '基座迭代目录（其 config.yml 作为所有候选的公共起点）' },
      candidates: {
        type: 'array',
        items: proposalParam,
        description: '要试探的添加候选（每个都会被独立验证；无效的会被跳过并说明原因），最多 5 个',
      },
      removals: {
        type: 'array',
        items: removalParam,
        description: '要试探的删除候选（显著性检查：删掉份额不显著/撞边界的态，看 ΔNLL 是否显著变差），最多 5 个。candidates 与 removals 至少给一个',
      },
      fitScriptPath: { type: 'string', description: 'fit.py 来源（默认插件自带 scripts/aifit.py；可用 PWA_FIT_SCRIPT 覆盖）' },
      shortRuns: { type: 'integer', description: '短拟合运行次数（默认 1）' },
      shortMaxIter: { type: 'integer', description: '短拟合单次最大迭代（默认 500）' },
      timeoutMin: { type: 'integer', description: '每个拟合的超时分钟数（默认无）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          baseIterDir: { type: 'string', required: true },
          jobs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                candidate: { type: 'string', required: true },
                iterDir: { type: 'string', required: true },
                jobId: { type: 'string', required: true },
                changed: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          skipped: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                candidate: { type: 'string', required: true },
                errors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } } },
              },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
          batchMode: { type: 'string', enum: ['one', 'script', 'off'] },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        jobs: { candidate: string; iterDir: string; jobId: string }[]
        skipped: { candidate: string; errors: { code: string; message: string }[] }[]
        warnings?: string[]
        batchMode?: 'one' | 'script' | 'off'
        error?: string
      }) => {
        if (!value.ok) return text(`trial 提交失败: ${value.error ?? '未知'}`)
        const lines: string[] = []
        if (value.jobs.length > 0) {
          const batch = value.batchMode === 'one' ? '（每个候选一个 SLURM 作业，全部完成才唤醒）'
            : value.batchMode === 'script' ? '（多个候选合成一个 SLURM 脚本，顺序跑，一次唤醒）'
              : ''
          lines.push(`已提交 ${value.jobs.length} 个候选短拟合${batch}:`)
          for (const j of value.jobs) lines.push(`  ${j.candidate}: job ${j.jobId} — ${j.iterDir}`)
        }
        for (const s of value.skipped) {
          lines.push(`  ✗ ${s.candidate} 被物理门禁拦截: ${s.errors.map((e) => `${e.code}`).join(', ')}`)
        }
        for (const w of value.warnings ?? []) lines.push(`  [warn] ${w}`)
        if (value.jobs.length === 0) lines.push('（没有可提交的候选）')
        else lines.push('完成后用 auto_pwa_compare 比较 ΔNLL 决定晋级者。')
        return text(lines.join('\n'))
      },
    },
    async execute(args: {
      baseIterDir: string
      candidates?: ResonanceProposal[]
      removals?: ResonanceRemoval[]
      fitScriptPath?: string
      shortRuns?: number
      shortMaxIter?: number
      timeoutMin?: number
    }, exec) {
      const baseConfig = `${args.baseIterDir}/config.yml`
      if (!existsSync(baseConfig)) {
        return { ok: false, baseIterDir: args.baseIterDir, jobs: [], skipped: [], batchMode: 'off', error: `base config not found: ${baseConfig}` }
      }
      const iterationsRoot = iterationsRootOf(args.baseIterDir)
      const env = resolveEnv()
      const fitScriptPath = args.fitScriptPath ?? env.fitScript
      const runs = String(args.shortRuns ?? 1)
      const maxIter = String(args.shortMaxIter ?? 500)
      const jobs: { candidate: string; iterDir: string; jobId: string; changed: string[] }[] = []
      const skipped: { candidate: string; errors: { code: string; message: string }[] }[] = []
      const warnings: string[] = []
      const baseIterName = args.baseIterDir.split(/[\\/]/).pop() ?? 'base'
      const candidateCount = (args.candidates?.length ?? 0) + (args.removals?.length ?? 0)
      if (candidateCount === 0) {
        return { ok: false, baseIterDir: args.baseIterDir, jobs: [], skipped: [], batchMode: 'off', error: 'candidates 与 removals 至少给一个' }
      }
      // Validate + build trial dirs for every candidate first (skipping invalid),
      // so we can decide to batch them under one job after the fact.
      const pending: { candidate: string; iterDir: string; changed: string[] }[] = []
      let idx = 0
      /** Apply one edit to a fresh copy of the base config and materialize a trial dir. */
      const buildTrial = (
        label: string,
        candidateId: string,
        edit: (cfg: ReturnType<typeof parseConfig>) => { errors: { code: string; message: string }[]; changed: string[] },
      ): void => {
        try {
          const cfg = parseConfig(readFileSync(baseConfig, 'utf8'))
          const res = edit(cfg)
          if (res.errors.length > 0) {
            skipped.push({ candidate: candidateId, errors: res.errors })
            return
          }
          const finalV = validateConfig(cfg, defaultDb)
          const finalXref = crossReferenceErrors(cfg)
          if (finalV.errors.length > 0 || finalXref.errors.length > 0) {
            skipped.push({ candidate: candidateId, errors: [...finalV.errors, ...finalXref.errors] })
            return
          }
          const { trialDir, changed, warnings: trialWarnings } = createTrialDir({
            iterationsRoot,
            baseConfigPath: baseConfig,
            label,
            fitScriptPath,
          })
          warnings.push(...trialWarnings)
          const target = `${trialDir}/config.yml`
          snapshotOnce(target)
          const tmp = `${target}.tmp-${Date.now().toString(36)}`
          writeFileSync(tmp, dumpConfig(cfg))
          renameSync(tmp, target)
          pending.push({ candidate: candidateId, iterDir: trialDir, changed: [...changed, ...res.changed] })
        } catch (e) {
          skipped.push({ candidate: candidateId, errors: [{ code: 'trial-failed', message: (e as Error).message }] })
        }
      }
      for (const proposal of args.candidates ?? []) {
        idx += 1
        buildTrial(`${baseIterName}-${idx}-${proposal.name}`, proposal.name, (cfg) => applyRoundEdits(cfg, undefined, proposal))
      }
      for (const removal of args.removals ?? []) {
        idx += 1
        buildTrial(`${baseIterName}-rm${idx}-${removal.name}`, `rm:${removal.name}`, (cfg) => applyRoundEdits(cfg, [removal], undefined))
      }
      // 跑前门禁：每个 trial 的 config 也过同一条闸（TS 结构/物理 + ctpwa
      // --validate-only）。不通过的候选进 skipped，绝不进拟合队列。
      const gatedPending: typeof pending = []
      for (const p of pending) {
        const g = gateBeforeFit({
          iterDir: p.iterDir,
          tool: 'auto_pwa_try_candidates',
          fitScript: fitScriptPath,
          scriptArgs: ['--runs', runs, '--max-iter', maxIter],
        })
        if (!g.ok) {
          skipped.push({ candidate: p.candidate, errors: g.errors })
          continue
        }
        warnings.push(...g.warnings.map((w) => `${p.candidate}: ${w.message}`))
        gatedPending.push(p)
      }
      pending.length = 0
      pending.push(...gatedPending)
      // B2：一批候选一个提交（trial 配置是"哪个候选更好"的比较依据）
      if (pending.length > 0) {
        const gitBatch = gitRecord(
          args.baseIterDir,
          pending.map((p) => `${p.iterDir}/config.yml`),
          `trials(${baseIterName}): ${pending.map((p) => p.candidate).join(', ')}`,
          { 'Pwa-Kind': 'trial', 'Pwa-Resonance': pending.map((p) => p.candidate).join(',') },
        )
        if (gitBatch.changed !== undefined) warnings.push(gitBatch.changed)
        warnings.push(...gitBatch.warnings.map((w) => w.message))
      }
      // Decide batching: only the SLURM transport batches (local stays one DSH
      // job per candidate, the historical behavior).
      const pwaFit = ctx.pwaFit as {
        transport?: string
        submitBatch?: (r: { iterDir: string; iterDirs?: string[]; timeoutMin?: number; scriptArgs?: string[] }, o?: FitOwner) => string
      }
      const batchMode = pwaFit.transport === 'slurm'
        ? resolveSlurmBatchMode(env, readBaselineTimeSec(args.baseIterDir))
        : 'off'
      const countsCandidate = pending.length
      const canBatch = batchMode !== 'off' && countsCandidate > 1 && typeof pwaFit.submitBatch === 'function'
      if (canBatch) {
        const jobId = pwaFit.submitBatch!({
          iterDir: pending[0]!.iterDir,
          iterDirs: pending.map((p) => p.iterDir),
          scriptArgs: ['--runs', runs, '--max-iter', maxIter],
          timeoutMin: args.timeoutMin,
        }, ownerOf(exec))
        for (const p of pending) jobs.push({ candidate: p.candidate, iterDir: p.iterDir, jobId, changed: p.changed })
        return { ok: true, baseIterDir: args.baseIterDir, jobs, skipped, warnings, batchMode }
      }
      // Single-job path: local transport, batch='off', or a single candidate.
      for (const p of pending) {
        const jobId = ctx.pwaFit.submit(
          {
            iterDir: p.iterDir,
            scriptArgs: ['--runs', runs, '--max-iter', maxIter],
            timeoutMin: args.timeoutMin,
          },
          ownerOf(exec),
        )
        jobs.push({ candidate: p.candidate, iterDir: p.iterDir, jobId, changed: p.changed })
      }
      return { ok: true, baseIterDir: args.baseIterDir, jobs, skipped, warnings, batchMode: 'off' }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_compare（第二批：候选显著性比较）
  // ---------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'auto_pwa_compare',
    description: 'ΔNLL 显著性 + AIC/BIC 惩罚 → 晋级裁决。',
    parameters: {
      baseIterDir: { type: 'string', required: true, description: '基座迭代目录（参考 NLL 的来源）' },
      trialDirs: { type: 'array', required: true, items: { type: 'string' }, description: 'auto_pwa_try_candidates 返回的 trial 目录列表' },
      significanceThreshold: { type: 'number', description: '显著 ΔNLL 阈值（默认 3.0）' },
      dataEvents: { type: 'integer', description: '数据事件数（BIC 惩罚项用；缺省则只给 AIC）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          baseNll: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                trialDir: { type: 'string', required: true },
                nll: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                deltaNll: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                deltaK: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                aicDelta: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                bicDelta: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                favoured: { type: 'boolean', required: true },
                hessianPositive: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
                verdict: { type: 'string', required: true, enum: ['significant-improvement', 'not-significant', 'significant-worsening', 'no-result'] },
              },
            },
          },
          recommendation: { type: 'string' },
          threshold: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        baseNll: number | null
        results: { trialDir: string; nll: number | null; deltaNll: number | null; deltaK: number | null; aicDelta: number | null; bicDelta: number | null; favoured: boolean; hessianPositive: boolean | null; verdict: string }[]
        recommendation: string
        threshold: number
        error?: string
      }) => {
        if (!value.ok) return text(`compare 失败: ${value.error ?? '未知'}`)
        const lines = [`基座 NLL = ${value.baseNll?.toFixed(2) ?? '—'}（显著阈值 |ΔNLL| >= ${value.threshold}）`]
        for (const r of value.results) {
          const name = r.trialDir.split(/[\\/]/).pop() ?? r.trialDir
          const d = r.deltaNll === null ? '—' : `${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(2)}`
          const sc = r.aicDelta === null ? '' : ` AICΔ=${r.aicDelta > 0 ? '+' : ''}${r.aicDelta.toFixed(1)}`
          const scb = r.bicDelta === null ? '' : ` BICΔ=${r.bicDelta > 0 ? '+' : ''}${r.bicDelta.toFixed(1)}`
          lines.push(
            `  ${name}: NLL=${r.nll?.toFixed(2) ?? '—'} ΔNLL=${d}${sc}${scb}${r.favoured ? ' ✓' : ''}${r.hessianPositive === false ? ' ⚠️Hessian 不正定' : ''} — ${r.verdict}`,
          )
        }
        lines.push(`推荐: ${value.recommendation}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { baseIterDir: string; trialDirs: string[]; significanceThreshold?: number; dataEvents?: number }) {
      const threshold = args.significanceThreshold ?? 3.0
      const base = summarizeFitDir(args.baseIterDir)
      const baseNll = base.summary.bestNll
      const baseK = freeParamCount(base.fitJson)
      const n = args.dataEvents ?? null
      const results: {
        trialDir: string
        nll: number | null
        deltaNll: number | null
        deltaK: number | null
        aicDelta: number | null
        bicDelta: number | null
        favoured: boolean
        hessianPositive: boolean | null
        verdict: 'significant-improvement' | 'not-significant' | 'significant-worsening' | 'no-result'
      }[] = []
      for (const dir of args.trialDirs) {
        const s = summarizeFitDir(dir)
        const nll = s.summary.bestNll
        const delta = baseNll !== null && nll !== null ? nll - baseNll : null
        let verdict: (typeof results)[number]['verdict'] = 'no-result'
        if (delta !== null) {
          verdict = delta <= -threshold ? 'significant-improvement' : delta >= threshold ? 'significant-worsening' : 'not-significant'
        }
        const mc = compareModels(
          { nll: baseNll, k: baseK },
          { nll, k: freeParamCount(s.fitJson) },
          n,
        )
        results.push({
          trialDir: dir,
          nll,
          deltaNll: delta,
          deltaK: mc.deltaK,
          aicDelta: mc.aicDelta,
          bicDelta: mc.bicDelta,
          favoured: mc.favoured,
          hessianPositive: s.summary.positiveDefinite,
          verdict,
        })
      }
      results.sort((a, b) => {
        const an = a.deltaNll ?? Number.POSITIVE_INFINITY
        const bn = b.deltaNll ?? Number.POSITIVE_INFINITY
        return an - bn
      })
      const best = results.find((r) => r.verdict === 'significant-improvement')
      let recommendation: string
      if (best !== undefined) {
        if (best.bicDelta !== null && best.bicDelta > 0) {
          recommendation = `${best.trialDir.split(/[\\/]/).pop() ?? best.trialDir} ΔNLL 显著但 BIC 劣化（+${best.bicDelta.toFixed(1)}）：复杂度惩罚超过改进，谨慎采纳`
        } else {
          recommendation = `${best.trialDir.split(/[\\/]/).pop() ?? best.trialDir} 显著改进（ΔNLL ${best.deltaNll?.toFixed(2)}${best.aicDelta !== null ? `, AICΔ=${best.aicDelta.toFixed(1)}` : ''}），建议晋级为正式迭代`
        }
      } else {
        // ΔNLL alone is not the verdict. A candidate with FEWER parameters that
        // the complexity penalty favours (ΔAIC/ΔBIC, already computed by
        // model-selection) is worth taking even when ΔNLL is not significant —
        // the line above prints those numbers, so recommending "keep the current
        // model" while they point at the simpler trial contradicted itself.
        const simpler = simplerFavoured(results)
        if (simpler !== undefined) {
          const label = simpler.trialDir.split(/[\\/]/).pop() ?? simpler.trialDir
          const d = simpler.deltaNll !== null ? `${simpler.deltaNll > 0 ? '+' : ''}${simpler.deltaNll.toFixed(2)}` : '—'
          // Kass–Raftery: |ΔBIC| > 6 is strong evidence.
          const strong = simpler.bicDelta !== null && simpler.bicDelta < -6
          recommendation =
            `${label} ΔNLL 不显著（${d}）但复杂度惩罚偏向它（Δk=${simpler.deltaK ?? 0}` +
            `${simpler.aicDelta !== null ? `, AICΔ=${simpler.aicDelta.toFixed(1)}` : ''}` +
            `${simpler.bicDelta !== null ? `, BICΔ=${simpler.bicDelta.toFixed(1)}` : ''}）` +
            `${strong ? '（|BICΔ|>6：强证据）' : ''} → 建议换成更简模型`
        } else {
          recommendation = results.some((r) => r.verdict === 'not-significant')
            ? '所有候选均未达到显著阈值，且复杂度惩罚也不偏向任何候选 —— 保持当前模型或换一批候选'
            : results.some((r) => r.verdict === 'significant-worsening')
              ? '有候选显著变差 —— 不要采纳'
              : '没有可比较的结果（检查 trial 是否完成）'
        }
      }
      return { ok: true, baseNll, results, recommendation, threshold }
    },
  }))

  // ---------------------------------------------------------------------
  // auto_pwa_loop_next / auto_pwa_loop_decide
  // （第三批：循环状态机 —— 显著性 / 停止 / 回滚 / 最终报告）
  // ---------------------------------------------------------------------

  /** Best-effort max|pull| and max per-distribution chi2/ndf from the
   *  iteration's evaluate.json (either `<iter>/evaluate/evaluate.json` or
   *  `<iter>/results/evaluate/evaluate.json`). chi2/ndf ≈ 1 means the pull
   *  distribution is fluctuations around 0 — the "pull 分布" criterion. */
  const readEvaluate = (iterDir: string): { maxPull: number | null; maxChi2Ndf: number | null; pullRegions: [number, number][] } => {
    for (const p of [`${iterDir}/evaluate/evaluate.json`, `${iterDir}/results/evaluate/evaluate.json`]) {
      if (!existsSync(p)) continue
      try {
        const ev = JSON.parse(readFileSync(p, 'utf8'))
        const worst = ev.worst_distributions as { max_abs_pull?: number }[] | undefined
        const pulls = (worst ?? []).map((w) => w.max_abs_pull ?? 0)
        const regions: [number, number][] = []
        const dists = ev.distributions as Record<string, { pull_regions_over_3sigma?: [number, number][]; chi2_ndf?: number | null }> | undefined
        let maxChi2Ndf: number | null = null
        for (const d of Object.values(dists ?? {})) {
          for (const r of d.pull_regions_over_3sigma ?? []) regions.push(r)
          if (typeof d.chi2_ndf === 'number' && d.chi2_ndf !== null && (maxChi2Ndf === null || d.chi2_ndf > maxChi2Ndf)) maxChi2Ndf = d.chi2_ndf
        }
        return { maxPull: pulls.length > 0 ? Math.max(...pulls) : null, maxChi2Ndf, pullRegions: regions }
      } catch {
        return { maxPull: null, maxChi2Ndf: null, pullRegions: [] }
      }
    }
    return { maxPull: null, maxChi2Ndf: null, pullRegions: [] }
  }

  /** Schema-compliant view of a LoopEval (loop tools' output schemas declare
   * a subset; iter/iterDir already exist at the top level). */
  const evalView = (e: LoopEval): { nll: number | null; deltaNll: number | null; maxPull: number | null; maxChi2Ndf: number | null; hessianPositive: boolean | null; verdict: string; pullRegions?: [number, number][] } => ({
    nll: e.nll,
    deltaNll: e.deltaNll,
    maxPull: e.maxPull,
    maxChi2Ndf: e.maxChi2Ndf,
    hessianPositive: e.hessianPositive,
    verdict: e.verdict,
    pullRegions: e.pullRegions,
  })

  /** Evaluate one iteration against the diary + objective (shared by loop tools). */
  const evaluateIteration = (state: LoopState): { evalResult: LoopEval; converged: boolean; reason?: string } => {
    const { summary } = summarizeFitDir(state.currentIterDir)
    const nll = summary.bestNll
    const deltaNll = nll !== null ? (() => {
      const prev = previousDiaryNll(state.iterationsRoot, state.iter)
      return prev !== undefined ? nll - prev : null
    })() : null
    const { maxPull, maxChi2Ndf, pullRegions } = readEvaluate(state.currentIterDir)
    const verdict: LoopEval['verdict'] =
      deltaNll === null ? 'no-data' : deltaNll <= -state.objective.significanceThreshold ? 'significant-improvement' : 'not-significant'
    const evalResult: LoopEval = {
      iter: state.iter,
      iterDir: state.currentIterDir,
      nll,
      deltaNll,
      maxPull,
      maxChi2Ndf,
      hessianPositive: summary.positiveDefinite,
      verdict,
      pullRegions,
    }
    const c = convergenceVerdict(evalResult, state.objective, state.rounds)
    return { evalResult, converged: c.converged, reason: c.reason }
  }

  /** Finalize the loop: diary + FINAL-REPORT.md + phase done. */
  const finalizeLoop = (state: LoopState, reason: string): { reportPath: string } => {
    const { summary } = summarizeFitDir(state.currentIterDir)
    const reportPath = writeFinalReport(state.iterationsRoot, { iter: state.iter, iterDir: state.currentIterDir, nll: summary.bestNll }, reason)
    state.finalized = { bestIter: state.iter, bestNll: summary.bestNll, reason, reportPath }
    state.phase = 'done'
    saveLoopState(state)
    try {
      const log = new IterationLog({ rootDir: state.iterationsRoot })
      log.append({
        iter: state.iter,
        timestamp: new Date().toISOString(),
        title: `收敛：最优拟合达成（iter-${String(state.iter).padStart(3, '0')}）`,
        kind: 'converged',
        configPath: `${state.currentIterDir}/config.yml`,
        iterDir: state.currentIterDir,
        nll: summary.bestNll ?? undefined,
        conclusion: reason,
        nextPlan: '已生成 FINAL-REPORT.md',
      })
    } catch {
      // diary append is best-effort (duplicate iter / missing dir)
    }
    return { reportPath }
  }

  ctx.tools.register(defineTool({
    name: 'auto_pwa_loop_next',
    description: '循环状态机：评估→判收敛（收敛写 FINAL-REPORT）→进入 propose。',
    parameters: {
      iterationsRoot: { type: 'string', description: 'iterations/ 目录（省略时从 baseIterDir 推导）' },
      baseIterDir: { type: 'string', description: '起始基线迭代目录（仅首次/重启时必填；如 .../iterations/iter-004）' },
      objective: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopMaxPull: { type: 'number', description: 'max|pull| 停止阈值（默认 5）' },
          stopMaxChi2Ndf: { type: 'number', description: '逐分布 chi2/ndf 停止阈值（默认 2；≈1 即 pull 分布为 0 附近涨落，>2 判为仍有系统性偏差）' },
          stopDeltaNll: { type: 'number', description: '|ΔNLL| 停止阈值（默认 10）' },
          significanceThreshold: { type: 'number', description: '显著改进阈值（默认 3）' },
          maxRounds: { type: 'integer', description: '轮次预算上限（默认 20）' },
        },
        description: '收敛目标（仅首次调用生效，之后沿用状态里的值）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          phase: { type: 'string', required: true, enum: ['evaluate', 'propose', 'done'] },
          iter: { type: 'integer', required: true },
          iterDir: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          eval: {
            type: 'object',
            additionalProperties: false,
            properties: {
              nll: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              deltaNll: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              maxPull: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              maxChi2Ndf: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '最大逐分布 chi2/ndf（≈1 即 pull 分布为 0 附近涨落）' },
              hessianPositive: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
              verdict: { type: 'string', required: true },
              pullRegions: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'pull>3σ 质量区间（regionPull 预测验证用）' },
            },
          },
          converged: { type: 'boolean', required: true },
          reason: { type: 'string' },
          reportPath: { type: 'string' },
          verification: {
            type: 'object',
            additionalProperties: false,
            properties: {
              passed: { type: 'boolean', required: true },
              actual: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              note: { type: 'string', required: true },
            },
            description: '上一轮预测的验证结果（模型应据此修正假设，并写入 auto_pwa_note）',
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        phase: string
        iter: number
        iterDir: string
        rounds: number
        eval?: { nll: number | null; deltaNll: number | null; maxPull: number | null; maxChi2Ndf: number | null; hessianPositive: boolean | null; verdict: string }
        converged: boolean
        reason?: string
        reportPath?: string
        verification?: { passed: boolean; actual: number | null; note: string }
        error?: string
      }) => {
        if (!value.ok) return text(`loop 失败: ${value.error ?? '未知'}`)
        const lines = [`loop: phase=${value.phase}, iter-${String(value.iter).padStart(3, '0')}（${value.iterDir}）, rounds=${value.rounds}`]
        const e = value.eval
        if (e !== undefined) {
          lines.push(
            `  评估: NLL=${e.nll?.toFixed(2) ?? '—'} ΔNLL=${e.deltaNll === null ? '—' : e.deltaNll.toFixed(2)} max|pull|=${e.maxPull?.toFixed(2) ?? '—'} chi2/ndf=${e.maxChi2Ndf?.toFixed(2) ?? '—'}${e.hessianPositive === false ? ' ⚠️Hessian 不正定' : ''}（${e.verdict}）`,
          )
        }
        if (value.verification !== undefined) {
          lines.push(`  🔍 预测验证: ${value.verification.passed ? '✅ 成立' : '❌ 不成立'} — ${value.verification.note}`)
        }
        if (value.converged) {
          lines.push(`  ✅ 收敛: ${value.reason ?? ''}`)
          if (value.reportPath) lines.push(`  最终报告: ${value.reportPath}`)
        } else if (value.reason !== undefined) {
          lines.push(`  未收敛（${value.reason}）— 用 auto_pwa_suggest/diagnose 决策，然后 auto_pwa_loop_decide 执行`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args: { iterationsRoot?: string; baseIterDir?: string; objective?: Partial<LoopObjective> }) {
      if (args.iterationsRoot !== undefined) noteAnalysisRoot(args.iterationsRoot)
      else if (args.baseIterDir !== undefined) noteAnalysisRoot(args.baseIterDir)
      try {
        let state: LoopState | undefined
        if (args.iterationsRoot !== undefined) state = loadLoopState(args.iterationsRoot)
        if (state === undefined) {
          if (args.baseIterDir === undefined) {
            return { ok: false, phase: 'propose' as const, iter: -1, iterDir: '', rounds: 0, converged: false, error: 'no loop state — pass baseIterDir on the first call to start the loop' }
          }
          const root = args.iterationsRoot ?? iterationsRootOf(args.baseIterDir)
          state = initLoopState(root, args.baseIterDir, args.objective)
        }
        if (state.phase === 'done') {
          return {
            ok: true,
            phase: 'done' as const,
            iter: state.iter,
            iterDir: state.currentIterDir,
            rounds: state.rounds,
            converged: true,
            reason: state.finalized?.reason,
            reportPath: state.finalized?.reportPath,
          }
        }
        const { evalResult, converged, reason } = evaluateIteration(state)
        state.lastEval = evalResult
        // Verify the previous decision's prediction, if one is pending.
        let verification: { passed: boolean; actual: number | null; note: string } | undefined
        if (state.pendingPrediction !== undefined) {
          const pending = state.pendingPrediction
          verification = verifyPrediction(pending.prediction, evalResult)
          // P1c：把验证结果**追加进账本**（此前只有模型手动抄进 note 才留痕）。
          appendVerification(state, {
            iter: pending.iter ?? state.iter,
            ...(pending.hypothesis !== undefined ? { hypothesis: pending.hypothesis } : {}),
            prediction: pending.prediction,
            passed: verification.passed,
            actual: verification.actual,
            note: verification.note,
            verifiedAtIter: state.iter,
            at: new Date().toISOString(),
          })
          state.pendingPrediction = undefined
          saveLoopState(state)
        }
        if (verification !== undefined) {
          return {
            ok: true,
            phase: 'propose' as const,
            iter: state.iter,
            iterDir: state.currentIterDir,
            rounds: state.rounds,
            eval: evalView(evalResult),
            converged: false,
            reason,
            verification,
          }
        }
        if (converged) {
          const { reportPath } = finalizeLoop(state, reason ?? '收敛判据满足')
          return {
            ok: true,
            phase: 'done' as const,
            iter: state.iter,
            iterDir: state.currentIterDir,
            rounds: state.rounds,
            eval: evalView(evalResult),
            converged: true,
            reason,
            reportPath,
          }
        }
        state.phase = 'propose'
        saveLoopState(state)
        return {
          ok: true,
          phase: 'propose' as const,
          iter: state.iter,
          iterDir: state.currentIterDir,
          rounds: state.rounds,
          eval: evalView(evalResult),
          converged: false,
          reason,
        }
      } catch (e) {
        return { ok: false, phase: 'propose' as const, iter: -1, iterDir: '', rounds: 0, converged: false, error: (e as Error).message }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'auto_pwa_loop_decide',
    description: '[可选] 落盘决策：iterate / rollback / converge。',
    parameters: {
      iterationsRoot: { type: 'string', required: true, description: 'iterations/ 目录' },
      action: { type: 'string', required: true, enum: ['iterate', 'rollback', 'converge'], description: '决策动作' },
      proposal: { ...proposalParam, description: 'action=iterate 时要添加的共振态（与 removals 至少给一个）' },
      removals: removalListParam,
      hypothesis: { type: 'string', description: '本决策的物理假设（如 "f2(1270) 吸收 R_KK 1.2-1.35 GeV 的 pull"）——与 prediction 一起构成可检验的预测' },
      prediction: {
        type: 'object',
        additionalProperties: false,
        properties: {
          metric: { type: 'string', required: true, enum: ['maxPull', 'deltaNll', 'regionPull'] },
          region: { type: 'array', items: { type: 'number' }, description: 'regionPull 用：质量窗口 [lo, hi]' },
          threshold: { type: 'number', required: true },
          direction: { type: 'string', required: true, enum: ['below', 'above'] },
        },
        description: '可验证预测（下轮拟合后由 loop_next 自动验证）：如 {metric: maxPull, threshold: 3, direction: below} 表示"加后全局 max|pull| < 3"',
      },
      reason: { type: 'string', description: 'rollback/converge 的原因说明（会写入日记/报告）' },
      fitScriptPath: { type: 'string', description: 'fit.py 来源（默认插件自带 scripts/aifit.py；可用 PWA_FIT_SCRIPT 覆盖）' },
      plotScriptPath: { type: 'string', description: 'plot.py 来源（默认无；可用 PWA_PLOT_SCRIPT 设置）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          iter: { type: 'integer', required: true },
          iterDir: { type: 'string', required: true },
          jobId: { type: 'string' },
          phase: { type: 'string', required: true },
          changed: { type: 'array', items: { type: 'string' } },
          // 回退时把"被撤销的态"直接送回上下文（§8.6 缺陷 1 的最后一环）
          dropped: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          errors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } } },
          reportPath: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        action: string
        iter: number
        iterDir: string
        jobId?: string
        phase: string
        changed?: string[]
        errors?: { code: string; message: string }[]
        reportPath?: string
        error?: string
      }) => {
        if (!value.ok) return text(`loop_decide 失败: ${value.error ?? '未知'}`)
        const lines = [`action=${value.action} → iter-${String(value.iter).padStart(3, '0')}（${value.iterDir}）, phase=${value.phase}`]
        if (value.jobId !== undefined) lines.push(`  拟合已提交: job ${value.jobId}`)
        for (const c of value.changed ?? []) lines.push(`  ${c}`)
        for (const e of value.errors ?? []) lines.push(`  [error] ${e.code}: ${e.message}`)
        if (value.reportPath !== undefined) lines.push(`  最终报告: ${value.reportPath}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args: {
      iterationsRoot: string
      action: 'iterate' | 'rollback' | 'converge'
      proposal?: ResonanceProposal
      removals?: ResonanceRemoval[]
      hypothesis?: string
      prediction?: Prediction
      reason?: string
      fitScriptPath?: string
      plotScriptPath?: string
    }, exec) {
      const state = loadLoopState(args.iterationsRoot)
      if (state === undefined) {
        return { ok: false, action: args.action, iter: -1, iterDir: '', phase: 'none', error: 'no loop state — start with auto_pwa_loop_next' }
      }
      try {
        if (args.action === 'iterate') {
          const removals = args.removals ?? []
          if (args.proposal === undefined && removals.length === 0) {
            return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, error: 'iterate 需要 proposal 或 removals' }
          }
          const baseConfig = `${state.currentIterDir}/config.yml`
          if (!existsSync(baseConfig)) {
            return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, error: `base config not found: ${baseConfig}` }
          }
          const env = resolveEnv()
          const cfg = parseConfig(readFileSync(baseConfig, 'utf8'))
          const pre = applyRoundEdits(cfg, removals, args.proposal)
          if (pre.errors.length > 0) {
            return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, errors: pre.errors, error: 'removals/proposal 未通过物理门禁' }
          }
          const started = startIteration({
            iterationsRoot: state.iterationsRoot,
            baseConfigPath: baseConfig,
            fitScriptPath: args.fitScriptPath ?? env.fitScript,
            plotScriptPath: args.plotScriptPath ?? env.plotScript,
          })
          const newCfg = parseConfig(readFileSync(`${started.iterDir}/config.yml`, 'utf8'))
          const applied = applyRoundEdits(newCfg, removals, args.proposal)
          if (applied.errors.length > 0) {
            return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, errors: applied.errors, error: '应用 removals/proposal 失败' }
          }
          const finalV = validateConfig(newCfg, defaultDb)
          const finalXref = crossReferenceErrors(newCfg)
          if (finalV.errors.length > 0 || finalXref.errors.length > 0) {
            return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, errors: [...finalV.errors, ...finalXref.errors], error: '写前总闸未通过' }
          }
          const target = `${started.iterDir}/config.yml`
          snapshotOnce(target)
          const tmp = `${target}.tmp-${Date.now().toString(36)}`
          writeFileSync(tmp, dumpConfig(newCfg))
          renameSync(tmp, target)
          // B2：配置写入即记录
          const gitRec = gitRecord(started.iterDir, [`${started.iterDir}/config.yml`, `${started.iterDir}/note.md`], `iter-${String(started.iter).padStart(3, '0')}: ${editSummary(args.proposal, removals)}`, proposalTrailers(started.iter, args.proposal, removals))
          // 跑前门禁（与 run_fit / round / iterate 同一条闸）
          const gate = gateBeforeFit({
            iterDir: started.iterDir,
            tool: 'auto_pwa_loop_decide',
            fitScript: args.fitScriptPath ?? env.fitScript,
          })
          if (!gate.ok) {
            return {
              ok: false,
              action: args.action,
              iter: state.iter,
              iterDir: state.currentIterDir,
              phase: state.phase,
              errors: gate.errors,
              error: `跑前门禁拒绝（${gate.errors.length} errors）`,
            }
          }
          const jobId = ctx.pwaFit.submit({ iterDir: started.iterDir }, ownerOf(exec))
          state.baseIterDir = state.currentIterDir
          state.currentIterDir = started.iterDir
          state.iter = started.iter
          state.rounds += 1
          state.phase = 'evaluate'
          if (args.prediction !== undefined) {
            // `iter` 显式记下"作出预测的那一轮"，供 P1c 账本按键（不要靠验证时的 state.iter 猜）
            state.pendingPrediction = { prediction: args.prediction, ...(args.hypothesis !== undefined ? { hypothesis: args.hypothesis } : {}), iter: started.iter }
          } else {
            state.pendingPrediction = undefined
          }
          saveLoopState(state)
          return {
            ok: true,
            action: args.action,
            iter: started.iter,
            iterDir: started.iterDir,
            jobId,
            phase: state.phase,
            changed: [
              ...started.changed,
              ...started.warnings.map((w) => `[warn] ${w}`),
              ...applied.changed,
              ...(gitRec.changed !== undefined ? [gitRec.changed] : []),
              ...[...applied.warnings, ...finalXref.warnings, ...finalV.warnings].map((w) => `[warn] ${w.code}: ${w.message}`),
            ],
            errors: [],
          }
        }
        if (args.action === 'rollback') {
          const prev = previousIterDir(state.iterationsRoot, state.currentIterDir)
          if (prev === undefined) {
            return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, error: '没有更早的迭代可回退' }
          }
          const m = /iter-(\d+)/.exec(prev)
          let dropped: string[] = []
          try {
            const log = new IterationLog({ rootDir: state.iterationsRoot })
            // **回退必须显式写 `-=`**：被撤销轮次里"新增的态"原先**不留任何痕迹**
            // （只写在结论散文里），导致后来的"是否仍在模型中"根本无法从结构化数据判定
            // —— 实测 X2200/X2450/N1440/X2300_2m 都是这样消失的（docs §8.6 缺陷 1）。
            const all = log.readAll()
            dropped = droppedByRollback(all, state.iter)
            const rollbackConclusion =
              args.reason ?? '拟合退化（Hessian 不正定 / 撞边界 / 显著变差），已回退到上一轮'
            const patch = {
              // 回退 = 一轮被否掉的实验（原来是 'other'，会让"已否决/回退"清单漏掉它）
              kind: 'removed' as const,
              ...(dropped.length > 0 ? { changes: dropped.map((n) => `-= ${n}`) } : {}),
              conclusion: rollbackConclusion,
              nextPlan: `回退至 iter-${String(Number(m?.[1] ?? -1)).padStart(3, '0')}`,
            }
            // 该轮已被 note 记过 → **标注**它（append 会因重复 iter 抛错、信息全丢）；
            // 只有从未记录过才新建一条。
            if (log.annotate(state.iter, patch) === undefined) {
              log.append({
                iter: state.iter,
                timestamp: new Date().toISOString(),
                title: `回滚 iter-${String(state.iter).padStart(3, '0')}：${args.reason ?? '拟合退化'}`,
                configPath: `${state.currentIterDir}/config.yml`,
                iterDir: state.currentIterDir,
                ...patch,
              })
            }
          } catch {
            // duplicate-iter guard
          }
          state.baseIterDir = prev
          state.currentIterDir = prev
          state.iter = m !== null ? Number(m[1]) : state.iter - 1
          state.phase = 'propose'
          saveLoopState(state)
          // 把"本次回退撤销了哪些态"直接写进工具结果：模型当轮就能看到，
          // 不必去日记里翻（§8.6 缺陷 1 的最后一环——结构化记录了，也要**送到**上下文里）
          return {
            ok: true,
            action: args.action,
            iter: state.iter,
            iterDir: prev,
            phase: state.phase,
            ...(dropped.length > 0
              ? {
                  dropped,
                  note: `本次回退撤销了 ${dropped.length} 个态（已记进日记为 \`-= 名字\`）：${dropped.join(', ')}`,
                }
              : {}),
          }
        }
        // converge (force finalization)
        const reason = args.reason ?? 'AI 判定收敛'
        const { reportPath } = finalizeLoop(state, reason)
        return { ok: true, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, reportPath }
      } catch (e) {
        return { ok: false, action: args.action, iter: state.iter, iterDir: state.currentIterDir, phase: state.phase, error: (e as Error).message }
      }
    },
  }))
}
