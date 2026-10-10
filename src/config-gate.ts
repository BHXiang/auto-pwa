/**
 * config-gate: the RUN-TIME gate (跑前门禁) that replaced the write-time
 * `config.yml` write guard.
 *
 * Why it exists: the old guard policed *who writes config.yml*. That is the
 * wrong chokepoint — variant configs (any other file name) and external
 * `Resonances: <file>` includes were never covered, while every legitimate
 * systematic test (shape comparison, threshold cut, model swap) was blocked.
 * The gate instead checks the config that is ABOUT TO BE FIT, no matter who
 * wrote it or what it is called.
 *
 * Split of responsibilities (see also auto_pwa_validate_config):
 *   - HARD errors = "this config is malformed or the amplitude is identically
 *     zero": YAML/structure, cross-references, trans block indices, identical
 *     groups, on-shell threshold, two-vertex J^PC reachability + C
 *     conservation, and (deep) `ctpwa --validate-only`.
 *   - WARNINGS = physics judgement / provenance / cost: PDG backing and mass
 *     agreement, explicit J^P vs PDG, unreferenced definitions, duplicate PDG
 *     ids, state and free-parameter budgets. A warning never blocks a fit —
 *     state count, model choice and formula freedom are experimental design,
 *     not config errors (the whole point of moving the gate).
 *
 * The TS layer is deliberately conservative: anything it does not understand
 * (unknown model, external Resonances include) becomes a warning and is
 * deferred to the authoritative `ctpwa --validate-only` deep check.
 *
 * Pure functions over an already-parsed config; no I/O beyond hashing the text
 * the caller passes in.
 */
import { createHash } from 'node:crypto'
import { validateConfig, crossReferenceErrors } from './config-edit.js'
import { analyzeIntermediateJPC } from './intermediate-jpc.js'
import { lookupResonance, normalizeName } from './lookup.js'
import { explicitJp } from './jpc.js'
import { classifyPairPhysics } from './particle-info.js'
import { PARTICLE_MODELS } from './resonance-validate.js'
import type { PwaConfig, ResonanceDb, ValidationIssue } from './types.js'

/** One gate finding. `severity` mirrors the errors/warnings split above. */
export interface GateIssue {
  code: string
  message: string
  severity: 'error' | 'warning'
}

/** What actually ran (so the model can see the gate was not silently skipped). */
export interface GateCheck {
  name: string
  ran: boolean
  errors: number
  warnings: number
  note?: string
}

export interface GateStats {
  resonances: number
  /** (intermediate, [J,P]) groups across all chains. */
  groups: number
  /** Resonances defined in `Resonances:` but referenced by no group. */
  definedUnreferenced: number
  /** Floated resonance parameters declared in the config (`free` entries). */
  freeResonanceParams: number
  /** Data/phsp/bkg sample paths declared in `Data:`. */
  dataSamples: number
}

export interface GateResult {
  ok: boolean
  errors: GateIssue[]
  warnings: GateIssue[]
  checks: GateCheck[]
  stats: GateStats
  /** The `Resonances:` section is an external include (`Resonances: file.yml`):
   * the TS layer cannot see the definitions, so only structure/cross-reference
   * checks ran and the deep ctpwa check is required for a verdict. */
  resonancesExternal: boolean
  resonancesIncludePath?: string
  /** md5 of the exact config text the gate saw (provenance / B1 record). */
  configMd5: string
}

export interface GateOptions {
  /** maxL for the two-vertex J^PC check (default: config Constraints.maxL, else 4). */
  maxL?: number
  /** Soft budget: warn above this many resonances (default 40, env-overridable). */
  maxResonances?: number
  /** Soft budget: warn above this many floated resonance parameters (default 60). */
  maxFreeParams?: number
  /** Skip the two-vertex J^PC / C analysis (structure+xref only). */
  skipPhysics?: boolean
}

/** md5 of a text payload (provenance records; never of a path). */
export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/**
 * Detect the external-include spelling of the Resonances section
 * (`Resonances: Resonances.yml`), which ctpwa supports and the TS parser does
 * not resolve. Returns the include path as written, or undefined.
 */
export function resonancesIncludeOf(raw: Map<unknown, unknown>): string | undefined {
  const v = raw.get('Resonances') ?? raw.get('resonances')
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

const err = (code: string, message: string): GateIssue => ({ code, message, severity: 'error' })
const warn = (code: string, message: string): GateIssue => ({ code, message, severity: 'warning' })

/** Re-tag a core ValidationIssue list with a gate severity. */
const asIssues = (list: ValidationIssue[], severity: 'error' | 'warning'): GateIssue[] =>
  list.map((i) => ({ code: i.code, message: i.message, severity }))

const jpLabel = (jp: { j: number; p: 1 | -1 }): string => `${jp.j}${jp.p > 0 ? '+' : '-'}`

/** Every (chain, intermediate, group) occurrence in the config. */
function groupOccurrences(
  config: PwaConfig,
): { chain: string; intermediate: string; jp: { j: number; p: 1 | -1 }; names: string[] }[] {
  const out: { chain: string; intermediate: string; jp: { j: number; p: 1 | -1 }; names: string[] }[] = []
  for (const [chain, spec] of Object.entries(config.decayChains)) {
    for (const [intermediate, int] of Object.entries(spec.intermediates)) {
      for (const g of int.groups) out.push({ chain, intermediate, jp: g.jp, names: g.names })
    }
  }
  return out
}

/**
 * Gate a parsed config. `text` is the exact config.yml content (hashed for the
 * provenance record); the caller is responsible for having read include files
 * if it wants resonance-level checks (otherwise pass `resonancesExternal` via
 * the parsed config — this function detects it from `config.raw`).
 */
export function gateConfig(
  config: PwaConfig,
  text: string,
  db?: ResonanceDb,
  options: GateOptions = {},
): GateResult {
  const errors: GateIssue[] = []
  const warnings: GateIssue[] = []
  const checks: GateCheck[] = []
  const push = (
    check: { name: string; ran: boolean; note?: string },
    next: { errors: GateIssue[]; warnings: GateIssue[] },
  ): void => {
    errors.push(...next.errors)
    warnings.push(...next.warnings)
    checks.push({ ...check, errors: next.errors.length, warnings: next.warnings.length })
  }

  const includePath = resonancesIncludeOf(config.raw)
  const resonancesExternal = includePath !== undefined

  // --- 1. structural ------------------------------------------------------
  const structural = validateConfig(config, db)
  push({ name: 'structure', ran: true }, {
    errors: asIssues(structural.errors, 'error'),
    warnings: asIssues(structural.warnings, 'warning'),
  })
  if (resonancesExternal) {
    // parseConfig cannot resolve `Resonances: <file>`, so `config.resonances`
    // is empty and every group reference would look undefined. Suppress the
    // resulting false positives — the deep ctpwa check owns this config.
    const drop = new Set(['undefined-resonance'])
    const keep = errors.filter((e) => !drop.has(e.code))
    errors.length = 0
    errors.push(...keep)
    warnings.push(
      warn(
        'resonances-external',
        `Resonances 段是外部文件（${includePath}）：TS 层看不到定义，共振态级检查（PDG/J^PC/阈值）已跳过，` +
          `必须靠 ctpwa --validate-only（deep 检查）定论`,
      ),
    )
  }

  // --- 2. cross-references ------------------------------------------------
  const xref = crossReferenceErrors(config)
  const xrefErrors = resonancesExternal
    ? xref.errors.filter((e) => !/not defined|no Resonances/i.test(e.message))
    : xref.errors
  push({ name: 'cross-reference', ran: true }, {
    errors: asIssues(xrefErrors, 'error'),
    warnings: asIssues(xref.warnings, 'warning'),
  })

  const occ = groupOccurrences(config)
  const referenced = new Set(occ.flatMap((o) => o.names))
  const definedUnreferenced = Object.keys(config.resonances).filter((n) => !referenced.has(n))

  // --- 3. two-vertex J^PC / C (per unique intermediate) -------------------
  const maxL = options.maxL ?? config.constraints.maxL ?? 4
  if (options.skipPhysics !== true && !resonancesExternal && db !== undefined) {
    const physErrors: GateIssue[] = []
    const physWarnings: GateIssue[] = []
    const seen = new Set<string>()
    for (const o of occ) {
      if (seen.has(o.intermediate)) continue
      seen.add(o.intermediate)
      const ana = analyzeIntermediateJPC(config, db, o.intermediate, { maxL })
      if (ana === undefined) continue
      const label = jpLabel(o.jp)
      const groupNames = occ.filter((x) => x.intermediate === o.intermediate).map((x) => x.names).flat()
      // Rule 10: the group's J^P must be realizable at the decay vertex.
      if (ana.jpUnion.length > 0 && !ana.jpUnion.includes(label)) {
        physErrors.push(
          err(
            'decay-vertex-forbidden',
            `${o.intermediate} [${label}]（链 ${o.chain}）在衰变顶点不可实现（R -> ` +
              `${ana.decaySteps.map((s) => s.daughters.join('+')).join(' | ')}）：允许 J^PC = ${ana.jpUnion.join(', ')} ` +
              `— 该分波振幅恒为零（ctpwa zero-SL）`,
          ),
        )
      }
      // Rule 11: C(A) = C(R)*C(B) at the production vertex.
      const required = ana.production?.cRequired ?? null
      if (required !== null) {
        for (const step of ana.decaySteps) {
          const c = step.cOf[label]
          if (c !== undefined && c !== 'x' && c !== required) {
            physErrors.push(
              err(
                'c-violation',
                `${o.intermediate} [${label}]（链 ${o.chain}）违反 C 守恒：产生顶点要求 C(R)=${required > 0 ? '+' : '-'}，` +
                  `但 ${step.daughters.join('+')} 的该分波 C=${c > 0 ? '+' : '-'} — 该波不可能存在`,
              ),
            )
          }
        }
      }
      // Rule 12: same-species daughters must be declared identical.
      for (const step of ana.decaySteps) {
        if (step.identical || (!step.identicalDerived && step.daughters[0] !== step.daughters[1])) continue
        physWarnings.push(
          warn(
            'identical-not-declared',
            `${o.intermediate} -> ${step.daughters.join(' + ')} 是同种粒子但未声明 Constraints.identical — ` +
              `ctpwa 不会做 Bose/Fermi 对称化（振幅错误）；请声明 identical: [${JSON.stringify(step.daughters)}]`,
          ),
        )
      }
      if (groupNames.length >= 6) {
        physWarnings.push(
          warn(
            'crowded-group',
            `${o.intermediate} [${label}] 已有 ${groupNames.length} 个成员 — 过拟合风险，考虑替换而非继续加`,
          ),
        )
      }
    }
    push({ name: 'two-vertex-jpc', ran: true, note: `maxL=${maxL}` }, { errors: physErrors, warnings: physWarnings })
  } else {
    checks.push({
      name: 'two-vertex-jpc',
      ran: false,
      errors: 0,
      warnings: 0,
      note: resonancesExternal ? 'Resonances 为外部 include：交给 ctpwa --validate-only' : 'db 不可用或已跳过',
    })
  }

  // --- 3b. identical-particle symmetrization (4/5-body shapes) ------------
  if (options.skipPhysics !== true && !resonancesExternal && db !== undefined) {
    const symWarnings: GateIssue[] = []
    // ctpwa only ever SKIPS a chain's `symmetrize` key (Config.cu 822/860/1320):
    // it performs no symmetrization at all. Writing it therefore looks like it
    // does something and silently does nothing.
    for (const [chainName, chain] of Object.entries(config.decayChains)) {
      if (chain.symmetrize === true) {
        symWarnings.push(
          warn(
            'symmetrize-ignored',
            `${chainName} 里的 \`symmetrize\` 被 ctpwa 忽略（引擎只跳过该键，不做任何对称化）—— ` +
              `全同粒子请用 Constraints.identical（顶点级），交换拓扑要写成独立链`,
          ),
        )
      }
    }
    // Identical daughters spread over DIFFERENT steps: the vertex-level rule
    // compares only one step's two daughters, and there is no automatic
    // cross-step symmetrization (that is why 4/5-body analyses write the
    // exchanged topology as its own chain, tied through Constraints.trans).
    // Stay quiet when the config already ties chains that way — otherwise this
    // fires on exactly the configs that handle it correctly.
    const tiesChains = (config.constraints.trans ?? []).some((t) => (t.names ?? []).length > 1)
    if (!tiesChains) {
      const refOf = (name: string): { name?: string; pdgid?: number; c?: 1 | -1 } => {
        const p = config.particles[name]
        return p !== undefined ? { ...p, name } : { name }
      }
      for (const [chainName, chain] of Object.entries(config.decayChains)) {
        const mothers = new Set(chain.steps.map((s) => s.mother))
        const finalState = chain.steps.flatMap((s) => s.daughters.filter((d) => !mothers.has(d)))
        const seen = new Set<string>()
        for (let i = 0; i < finalState.length; i++) {
          for (let j = i + 1; j < finalState.length; j++) {
            const a = finalState[i]!
            const b = finalState[j]!
            if (chain.steps.some((s) => s.daughters.includes(a) && s.daughters.includes(b))) continue
            if (!classifyPairPhysics(db, refOf(a), refOf(b)).identical) continue
            const key = `${a}|${b}`
            if (seen.has(key)) continue
            seen.add(key)
            symWarnings.push(
              warn(
                'identical-cross-step',
                `${chainName}: ${a} 与 ${b} 是同种粒子但分处不同衰变步 — ctpwa 的全同选择定则只作用于` +
                  `"同一步的两个 daughter"，跨步没有自动对称化（\`symmetrize\` 也被忽略）。` +
                  `请把交换拓扑写成独立链并用 Constraints.trans 绑定耦合（本提示只在未检测到 trans 约束时出现）`,
              ),
            )
          }
        }
      }
    }
    push({ name: 'identical-symmetry', ran: true }, { errors: [], warnings: symWarnings })
  } else {
    checks.push({
      name: 'identical-symmetry',
      ran: false,
      errors: 0,
      warnings: 0,
      note: resonancesExternal ? 'Resonances 为外部 include：交给 ctpwa --validate-only' : 'db 不可用或已跳过',
    })
  }

  // --- 3c. `sl` / `ls` wave-filter order ----------------------------------
  // ctpwa parses the two key names with DIFFERENT orders (Config.cu
  // parseSLFilter): `sl: [S, L]` vs the TFPWA alias `ls: [L, S]`, S being the
  // PHYSICAL spin. A wrong order only ever admits or drops waves SILENTLY, so
  // echo back what was written and what it was interpreted as (and flag the
  // L-first alias, which is the easy one to get backwards).
  {
    const slWarnings: GateIssue[] = []
    for (const [chainName, chain] of Object.entries(config.decayChains)) {
      for (const step of chain.steps) {
        if (step.sl === undefined) continue
        const label = `${chainName}: ${step.mother} -> ${step.daughters.join(' + ')}`
        const echo = step.sl
          .map(([mult, l]) => `S=${(mult - 1) / 2}, L=${l}（内部 (2S+1, L)=(${mult}, ${l})）`)
          .join('; ')
        if (step.slKey === 'ls') {
          slWarnings.push(
            warn(
              'sl-order',
              `${label} 用了 \`ls\` 别名 —— 它的顺序是 **(L, S)**（L 在前，TFPWA 记法），` +
                `而 \`sl\` 是 (S, L)（S 是物理自旋）。当前解释为: ${echo}。` +
                `若本意是 (S, L)，请改用 \`sl\``,
            ),
          )
        } else {
          slWarnings.push(
            warn(
              'sl-echo',
              `${label} 的 \`sl\` 白名单按 (S, L) 解释（S 为物理自旋）→ ${echo}`,
            ),
          )
        }
      }
    }
    push({ name: 'sl-order', ran: true }, { errors: [], warnings: slWarnings })
  }

  // --- 4. per-resonance PDG / threshold / mass (WARNINGS only) ------------
  if (!resonancesExternal && db !== undefined) {
    const pdgErrors: GateIssue[] = [] // reserved: hard physics errors, currently none
    const pdgWarnings: GateIssue[] = []
    const byPdgId = new Map<string, string[]>()
    for (const [name, spec] of Object.entries(config.resonances)) {
      if (!referenced.has(name)) continue // unreferenced: covered by xref warnings
      const hit = lookupResonance(db, { name })[0]
      const hasReference = spec.reference !== undefined && spec.reference.trim() !== ''
      const isParticleModel = PARTICLE_MODELS.includes(spec.model)
      if (isParticleModel) {
        if (hit === undefined) {
          pdgWarnings.push(
            warn(
              'not-on-pdg',
              hasReference
                ? `${name} 不在 PDG 表中（reference="${spec.reference}"）—— 已按出处处之，请确认引用正确`
                : `${name}（model ${spec.model}）不在 PDG 表中且没有 reference —— 若这是已发表的新态，请补 reference；` +
                  `若是分析自定义名，请改用 ONE（相空间项）或确认名字拼写。门禁不拦（这是出处问题，不是配置错误）`,
            ),
          )
        } else {
          if (hit.id !== undefined) {
            const key = hit.id
            byPdgId.set(key, [...(byPdgId.get(key) ?? []), name])
          }
          const ex = explicitJp(spec)
          if (ex !== undefined && (ex.j !== hit.jp.j || ex.p !== hit.jp.p) && !hasReference) {
            pdgWarnings.push(
              warn(
                'jpc-pdg-deviation',
                `${name} 在 config 里显式写了 J^P=${jpLabel(ex)}，PDG 是 ${jpLabel(hit.jp)}（若是有意的 CP 共轭/重新指定，请补 reference 说明）`,
              ),
            )
          }
          const width = spec.parameters[1]
          if (!hasReference && hit.width !== undefined && width !== undefined && hit.width > 0) {
            const ref = Math.max(hit.width, 0.05)
            if (Math.abs(width - hit.width) > 0.5 * ref) {
              pdgWarnings.push(
                warn(
                  'width-deviation',
                  `${name} 宽度 ${width.toFixed(3)} GeV 与 PDG ${hit.width.toFixed(3)} GeV 相差 >50%（分析自行调宽可以接受，但请知晓）`,
                ),
              )
            }
          }
        }
      }
      // On-shell threshold per group the state is attached to (hard error:
      // a state above m_mother - m_spectator cannot be produced on shell).
      if (Number.isFinite(spec.parameters[0])) {
        for (const o of occ) {
          if (!o.names.includes(name)) continue
          const kin = config.kinematics[o.intermediate]
          if (kin === undefined) continue
          if (spec.parameters[0] > kin.threshold) {
            pdgErrors.push(
              err(
                'above-threshold',
                `${name}: m = ${spec.parameters[0].toFixed(4)} GeV 超过 ${o.intermediate} 的产生阈值 ` +
                  `${kin.threshold.toFixed(4)} GeV（m_R <= m_mother - m_spectator）`,
              ),
            )
          }
        }
      }
    }
    for (const [id, names] of byPdgId) {
      if (names.length > 1) {
        pdgWarnings.push(
          warn(
            'duplicate-pdg-id',
            `PDG ${id} 被 ${names.length} 个不同名字定义：${names.join(', ')} —— 同一个态两个名字会互相打架，请合并`,
          ),
        )
      }
    }
    push({ name: 'pdg-threshold', ran: true }, { errors: pdgErrors, warnings: pdgWarnings })
  } else {
    checks.push({ name: 'pdg-threshold', ran: false, errors: 0, warnings: 0, note: resonancesExternal ? 'external include' : 'db 不可用' })
  }

  // --- 5. soft budget (never blocks) --------------------------------------
  const maxResonances = options.maxResonances ?? 40
  const maxFreeParams = options.maxFreeParams ?? 60
  let freeResonanceParams = 0
  for (const spec of Object.values(config.resonances)) {
    const free = spec.free ?? []
    freeResonanceParams += free.includes(-1) ? spec.parameters.length : free.filter((i) => i >= 0).length
  }
  const resonanceCount = Object.keys(config.resonances).length
  const budgetWarnings: GateIssue[] = []
  if (resonanceCount > maxResonances) {
    budgetWarnings.push(
      warn('budget-resonances', `共振态定义 ${resonanceCount} 个 > 软阈值 ${maxResonances} —— 过拟合/简并风险，确认这是有意的`),
    )
  }
  if (freeResonanceParams > maxFreeParams) {
    budgetWarnings.push(
      warn('budget-free-params', `放开的共振态参数 ${freeResonanceParams} 个 > 软阈值 ${maxFreeParams} —— 确认数据能约束得住`),
    )
  }
  push({ name: 'budget', ran: true }, { errors: [], warnings: budgetWarnings })

  // --- provenance stats ---------------------------------------------------
  const dataRaw = (config.raw.get('Data') ?? config.raw.get('data')) as Map<unknown, unknown> | undefined
  const dataSamples = ['data', 'phsp', 'phsp_truth', 'bkg', 'bkg_weights'].filter((k) => dataRaw?.get(k) !== undefined).length

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    stats: {
      resonances: resonanceCount,
      groups: occ.length,
      definedUnreferenced: definedUnreferenced.length,
      freeResonanceParams,
      dataSamples,
    },
    resonancesExternal,
    ...(includePath !== undefined ? { resonancesIncludePath: includePath } : {}),
    configMd5: md5(text),
  }
}

/**
 * Render a gate result as a compact, actionable text block (used by the tools'
 * render functions so the model always sees WHY a run was refused).
 */
export function renderGate(result: GateResult, label = '跑前门禁'): string {
  const lines: string[] = [
    `${label}: ${result.ok ? '通过' : `拒绝（${result.errors.length} errors）`}` +
      ` — 共振态 ${result.stats.resonances}，组 ${result.stats.groups}，放开参数 ${result.stats.freeResonanceParams}` +
      `，定义未引用 ${result.stats.definedUnreferenced}` +
      (result.resonancesExternal ? `，Resonances 外部 include=${result.resonancesIncludePath ?? '?'}` : ''),
  ]
  for (const c of result.checks) {
    lines.push(`  [${c.ran ? '✓' : '—'}] ${c.name}${c.note !== undefined ? ` (${c.note})` : ''}${c.errors > 0 ? ` ${c.errors} error` : ''}${c.warnings > 0 ? ` ${c.warnings} warn` : ''}`)
  }
  for (const e of result.errors) lines.push(`  [error] ${e.code}: ${e.message}`)
  for (const w of result.warnings.slice(0, 8)) lines.push(`  [warn]  ${w.code}: ${w.message}`)
  if (result.warnings.length > 8) lines.push(`  … 共 ${result.warnings.length} 条 warning`)
  lines.push(`  config md5: ${result.configMd5}`)
  return lines.join('\n')
}
