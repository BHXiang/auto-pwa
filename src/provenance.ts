/**
 * provenance: the B1 record — "this fit used exactly WHAT?".
 *
 * Written next to the fit results (`<iterDir>/results/provenance.json`) at
 * submit time, read back by auto_pwa_note (so the diary carries it) and by the
 * run gate (which then warns when the same directory is re-fitted with a
 * different config or different run settings).
 *
 * Why it exists: once the write guard stops policing config.yml, the safety net
 * is no longer "you may not change it" but "a change cannot go unnoticed".
 * Four facts are enough to reproduce or to invalidate a comparison:
 *   1. md5 of the config actually fitted (plus the external Resonances include,
 *      when `Resonances: <file>` is used);
 *   2. which states are in it (names / models / parameters / free);
 *   3. where the initial values came from (random seed vs warm start) and how
 *      the fit was driven (fit.py + its md5 + scriptArgs, i.e. runs/max-iter);
 *   4. the data/phsp/background samples.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PwaConfig } from './types.js'
import { md5, type GateResult, type GateStats } from './config-gate.js'
import type { GitProvenance } from './git-log.js'

export const PROVENANCE_SCHEMA_VERSION = 1

export interface ProvenanceResonance {
  name: string
  model: string
  parameters: number[]
  free?: number[]
  freeRange?: [number, number][]
  options?: Record<string, unknown>
  reference?: string
}

export interface ProvenanceInclude {
  /** Include path exactly as written in the config. */
  path: string
  /** Absolute-ish resolution against the config dir (when the file exists). */
  resolved?: string
  md5?: string
}

/** Where the initial values came from. `random` = seed-driven cold start;
 * `warm` = continued from a previous convergence (name-aligned). */
export interface ProvenanceInit {
  source: 'random' | 'warm' | 'unknown'
  seed?: number
  /** For warm starts: the fit.json the parameters came from. */
  from?: string
  note?: string
}

export interface Provenance {
  schemaVersion: number
  tool: string
  recordedAt: string
  iterDir: string
  configPath: string
  configMd5: string
  resonancesInclude?: ProvenanceInclude
  fitScript?: string
  fitScriptMd5?: string
  scriptArgs?: string[]
  init: ProvenanceInit
  /** 本地 git 绑定（B2）：md5 ↔ commit 互验，dirty = 结果不可由 HEAD 复现。 */
  git?: GitProvenance
  /** 本次拟合的 config 是否真的能在 HEAD 里复原（md5 比对 blob）。
   * false = 假可复现（配置从未提交，或提交后又改过）；undefined = 无 git 记录。 */
  gitVerified?: boolean
  groups: { chain: string; intermediate: string; jp: string; names: string[] }[]
  resonances: ProvenanceResonance[]
  data: Record<string, unknown>
  stats: GateStats
  /** Gate verdict at submit time (errors are never submitted; warnings kept). */
  gate: { ok: boolean; errors: string[]; warnings: string[] }
}

/** Strip `undefined` recursively — the tool framework's lossless-JSON gate
 * rejects own keys holding undefined, and provenance round-trips through it. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = prune(v)
    }
    return out
  }
  return value
}

/** Absolute-or-config-relative resolution for a `Resonances: <file>` include. */
function resolveInclude(configPath: string, include: string): string {
  return include.startsWith('/') ? include : join(dirname(configPath), include)
}

export interface BuildProvenanceOptions {
  tool: string
  iterDir: string
  configPath: string
  configText: string
  config: PwaConfig
  gate: GateResult
  fitScript?: string
  scriptArgs?: string[]
  /** Where the initial values come from; default 'unknown' (driver decides). */
  init?: ProvenanceInit
  /** Include file content, when the caller already read it (for its md5). */
  includeText?: string
  /** Local git binding (see GitProvenance); computed by the caller at gate time. */
  git?: GitProvenance
  /** Whether `git show HEAD:<config>` reproduces configMd5 (blob comparison). */
  gitVerified?: boolean
  now?: Date
}

/** Build the provenance record for one fit submission. */
export function buildProvenance(options: BuildProvenanceOptions): Provenance {
  const { config, gate } = options
  const groups: Provenance['groups'] = []
  for (const [chain, spec] of Object.entries(config.decayChains)) {
    for (const [intermediate, int] of Object.entries(spec.intermediates)) {
      for (const g of int.groups) {
        groups.push({
          chain,
          intermediate,
          jp: `${g.jp.j}${g.jp.p > 0 ? '+' : '-'}`,
          names: [...g.names],
        })
      }
    }
  }
  const resonances: ProvenanceResonance[] = Object.entries(config.resonances).map(([name, spec]) => ({
    name,
    model: spec.model,
    parameters: [...spec.parameters],
    ...(spec.free !== undefined ? { free: [...spec.free] } : {}),
    ...(spec.freeRange !== undefined ? { freeRange: spec.freeRange.map((r) => [r[0], r[1]] as [number, number]) } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
    ...(spec.reference !== undefined ? { reference: spec.reference } : {}),
  }))

  // Data section: keep the sample metadata (paths) verbatim.
  const dataRaw = (config.raw.get('Data') ?? config.raw.get('data')) as Map<unknown, unknown> | undefined
  const data: Record<string, unknown> = {}
  for (const key of ['order', 'data', 'phsp', 'phsp_truth', 'bkg', 'bkg_weights']) {
    const v = dataRaw?.get(key)
    if (v !== undefined) data[key] = v instanceof Map ? Object.fromEntries(v.entries()) : v
  }

  const includePath = gate.resonancesIncludePath
  const include: ProvenanceInclude | undefined = includePath !== undefined
    ? {
        path: includePath,
        ...(existsSync(resolveInclude(options.configPath, includePath)) ? { resolved: resolveInclude(options.configPath, includePath) } : {}),
        ...(options.includeText !== undefined ? { md5: md5(options.includeText) } : {}),
      }
    : undefined

  const fitScriptMd5 = options.fitScript !== undefined && existsSync(options.fitScript)
    ? md5(readFileSync(options.fitScript, 'utf8'))
    : undefined

  return prune({
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    tool: options.tool,
    recordedAt: (options.now ?? new Date()).toISOString(),
    iterDir: options.iterDir,
    configPath: options.configPath,
    configMd5: gate.configMd5,
    ...(include !== undefined ? { resonancesInclude: include } : {}),
    ...(options.fitScript !== undefined ? { fitScript: options.fitScript } : {}),
    ...(fitScriptMd5 !== undefined ? { fitScriptMd5 } : {}),
    ...(options.scriptArgs !== undefined ? { scriptArgs: options.scriptArgs } : {}),
    init: options.init ?? { source: 'unknown' },
    ...(options.git !== undefined ? { git: options.git } : {}),
    ...(options.gitVerified !== undefined ? { gitVerified: options.gitVerified } : {}),
    groups,
    resonances,
    data,
    stats: gate.stats,
    gate: {
      ok: gate.ok,
      errors: gate.errors.map((e) => `${e.code}: ${e.message}`),
      warnings: gate.warnings.map((w) => `${w.code}: ${w.message}`),
    },
  }) as Provenance
}

/** `<iterDir>/results/provenance.json` — next to fit.json / weight_best.root. */
export function provenancePath(iterDir: string): string {
  return join(iterDir, 'results', 'provenance.json')
}

/** Write the record atomically-ish (mkdir + write). Returns the path. */
export function writeProvenance(iterDir: string, provenance: Provenance): string {
  const path = provenancePath(iterDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(prune(provenance), null, 2)}\n`)
  return path
}

/** Read the record back; undefined when absent or unparseable. */
export function readProvenance(iterDir: string): Provenance | undefined {
  const path = provenancePath(iterDir)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Provenance
  } catch {
    return undefined
  }
}

/**
 * Derive where the initial values come from, from the fit driver arguments.
 * `--warm <fit.json>` (a convergence continued by name alignment) wins over
 * `--seed N`; a driver started with neither still uses its own default seed,
 * which is recorded as `random` with an explicit note.
 */
export function initFromScriptArgs(scriptArgs: string[] | undefined): ProvenanceInit {
  const args = scriptArgs ?? []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const warmMatch = /^--(?:warm|init-from|resume-from)(?:=(.+))?$/.exec(a)
    if (warmMatch !== null) {
      const from = warmMatch[1] ?? args[i + 1]
      return { source: 'warm', ...(from !== undefined ? { from } : {}) }
    }
    if (a === '--seed' || a.startsWith('--seed=')) {
      const raw = a.startsWith('--seed=') ? a.slice('--seed='.length) : args[i + 1]
      const seed = raw !== undefined && raw !== '' ? Number(raw) : undefined
      return { source: 'random', ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}), note: '显式 --seed' }
    }
  }
  // The note must not imply a flag the driver lacks: aifit's CLI is
  // --runs/--max-iter/--seed/--optimizer/--no-polish/--vmax/--amp-*, with no
  // --warm yet (the earlier wording sent a reader looking for a warm start that
  // cannot be requested). This record still understands --warm/--init-from, so
  // implementing it in the driver needs no change here.
  return {
    source: 'random',
    note:
      '未指定 --seed：用驱动默认种子（aifit 默认 seed=42）。' +
      'aifit 目前没有 --warm 热启动选项（provenance 已能记录 --warm/--init-from，等驱动实现）',
  }
}

/** The subset of a record carried into the iteration diary (report.ts). */
export function provenanceSummary(p: Provenance): {
  configMd5?: string
  recordedAt?: string
  resonancesInclude?: { path: string; resolved?: string; md5?: string }
  fitScript?: string
  fitScriptMd5?: string
  scriptArgs?: string[]
  init?: { source?: string; seed?: number; from?: string; note?: string }
  git?: GitProvenance
  gitVerified?: boolean
  resonances?: { name: string; model: string; parameters: number[]; free?: number[] }[]
  stats?: Record<string, unknown>
} {
  return {
    configMd5: p.configMd5,
    recordedAt: p.recordedAt,
    ...(p.resonancesInclude !== undefined ? { resonancesInclude: p.resonancesInclude } : {}),
    ...(p.fitScript !== undefined ? { fitScript: p.fitScript } : {}),
    ...(p.fitScriptMd5 !== undefined ? { fitScriptMd5: p.fitScriptMd5 } : {}),
    ...(p.scriptArgs !== undefined ? { scriptArgs: p.scriptArgs } : {}),
    ...(p.init !== undefined ? { init: p.init } : {}),
    ...(p.git !== undefined ? { git: p.git } : {}),
    ...(p.gitVerified !== undefined ? { gitVerified: p.gitVerified } : {}),
    resonances: p.resonances.map((r) => ({
      name: r.name,
      model: r.model,
      parameters: r.parameters,
      ...(r.free !== undefined ? { free: r.free } : {}),
    })),
    stats: p.stats as unknown as Record<string, unknown>,
  }
}

export interface ProvenanceDrift {
  code: string
  message: string
  severity: 'warning'
}

/**
 * Compare the config/settings about to be fitted against the previous record
 * of the SAME directory. Any drift means the existing results/ no longer
 * describe this config — exactly the class of mistake the B1 record exists to
 * catch (and, for run settings, the reason two NLLs must not be compared).
 */
export function checkProvenanceDrift(
  iterDir: string,
  configText: string,
  scriptArgs?: string[],
  fitScript?: string,
): { previous?: Provenance; drift: ProvenanceDrift[] } {
  const previous = readProvenance(iterDir)
  if (previous === undefined) return { drift: [] }
  const drift: ProvenanceDrift[] = []
  const nowMd5 = md5(configText)
  if (previous.configMd5 !== undefined && previous.configMd5 !== nowMd5) {
    drift.push({
      code: 'config-changed-since-record',
      severity: 'warning',
      message:
        `该目录已有拟合记录（${previous.recordedAt}），但 config.yml 已改变（md5 ${previous.configMd5} -> ${nowMd5}）——` +
        `旧 results/ 与新配置不对应，不要拿旧 NLL 与新结果比较；需要重跑`,
    })
  }
  const prevArgs = (previous.scriptArgs ?? []).join(' ')
  const nowArgs = (scriptArgs ?? []).join(' ')
  if (previous.scriptArgs !== undefined && prevArgs !== nowArgs) {
    drift.push({
      code: 'run-settings-changed',
      severity: 'warning',
      message:
        `拟合设置与上次记录不同（scriptArgs "${prevArgs}" -> "${nowArgs}"）——` +
        `两次拟合条件不同，ΔNLL 不可直接比较（C2：只有同起点、只改一个东西才算）`,
    })
  }
  if (previous.fitScript !== undefined && fitScript !== undefined && previous.fitScript !== fitScript) {
    drift.push({
      code: 'fit-script-changed',
      severity: 'warning',
      message: `fit.py 与上次记录不同（${previous.fitScript} -> ${fitScript}）——确认这是有意的`,
    })
  }
  return { previous, drift }
}
