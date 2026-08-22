/**
 * auto_pwa_iteration_log: the persisted iteration diary.
 *
 * SUMMARY.jsonl (one IterationRecord per line, JSON) is the machine channel:
 * the model reads it via auto_pwa_history at the start of every round and appends
 * its conclusion via auto_pwa_note at the end. The HTML pages (index.html +
 * iter-N/report.html) are re-rendered from the same records for the user.
 *
 * Layout (analysis working dir, NOT the plugin repo):
 *   iterations/
 *     SUMMARY.jsonl        machine-readable diary (append-only)
 *     index.html           user-facing overview (rendered)
 *     iter-000/ ...        per-iteration fit dirs (config.yml, results/, ...)
 *       report.html        user-facing detail page (rendered)
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseConfig, dumpConfig } from './config-edit.js'
import { renderIndex, renderReport, type IterationRecord } from './report.js'

export interface IterationLogOptions {
  /** Directory holding SUMMARY.jsonl + index.html (the `iterations/` dir). */
  rootDir: string
}

export class IterationLog {
  readonly rootDir: string
  readonly summaryPath: string

  constructor(options: IterationLogOptions) {
    this.rootDir = options.rootDir
    this.summaryPath = join(options.rootDir, 'SUMMARY.jsonl')
  }

  /** The next iteration number (max of log records and existing iter dirs + 1). */
  nextIter(): number {
    const fromLog = this.readAll().map((r) => r.iter)
    const fromDirs = listIterations(this.rootDir)
      .map((d) => {
        // Parse the DIR NAME, not the full path: the root may itself contain
        // "iter-<digits>" (e.g. mkdtemp prefixes like dsh-pwa-iter-6kNkyr)
        // and /iter-(\d+)/ on the full path would match the suffix.
        const base = d.split(/[\\/]/).pop() ?? d
        const m = /^iter-(\d+)$/.exec(base)
        return m ? Number(m[1]) : -1
      })
      .filter((n) => n >= 0)
    const all = [...fromLog, ...fromDirs]
    return all.length === 0 ? 0 : Math.max(...all) + 1
  }

  /** Append one record (validates `iter` monotonicity) and re-render HTML. */
  append(record: IterationRecord): IterationRecord {
    mkdirSync(this.rootDir, { recursive: true })
    const existing = this.readAll()
    if (existing.some((r) => r.iter === record.iter)) {
      throw new Error(`iteration ${record.iter} already recorded (duplicate iter)`)
    }
    const line = JSON.stringify(record)
    appendFileSync(this.summaryPath, `${line}\n`)
    this.renderDiary()
    return record
  }

  /** Read all records, sorted by iter ascending. Empty file -> []. */
  readAll(): IterationRecord[] {
    if (!existsSync(this.summaryPath)) return []
    const records: IterationRecord[] = []
    for (const line of readFileSync(this.summaryPath, 'utf8').split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try {
        records.push(JSON.parse(t) as IterationRecord)
      } catch {
        // Skip malformed lines rather than losing the whole diary.
      }
    }
    return records.sort((a, b) => a.iter - b.iter)
  }

  /** Re-render index.html and each iter-N/report.html from the records. */
  renderDiary(): void {
    const records = this.readAll()
    writeFileSync(join(this.rootDir, 'index.html'), renderIndex(records))
    for (const r of records) {
      const dir = join(this.rootDir, `iter-${String(r.iter).padStart(3, '0')}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'report.html'), renderReport(r))
    }
  }
}

/**
 * Create the next iteration directory:
 *   iterations/iter-N/  config.yml (copied from base), fit.py/plot.py
 *   (symlinked from a solver dir), note.md skeleton.
 * Returns the new iterDir and the records to date.
 */
export function startIteration(options: {
  iterationsRoot: string
  baseConfigPath: string
  fitScriptPath?: string
  plotScriptPath?: string
}): { iterDir: string; iter: number; changed: string[]; warnings: string[] } {
  const log = new IterationLog({ rootDir: options.iterationsRoot })
  const iter = log.nextIter()
  const iterDir = join(options.iterationsRoot, `iter-${String(iter).padStart(3, '0')}`)
  mkdirSync(iterDir, { recursive: true })
  const changed: string[] = []
  const warnings: string[] = []

  if (!existsSync(options.baseConfigPath)) {
    throw new Error(`base config not found: ${options.baseConfigPath}`)
  }
  const target = join(iterDir, 'config.yml')
  copyFileSync(options.baseConfigPath, target)
  // Data paths in the base config are usually relative to the base config's
  // own directory (e.g. solve1's "../root/..."): from the iteration dir they
  // would resolve wrongly, so absolutize them against the base dir.
  const pathStat = absolutizeDataPaths(target, dirname(options.baseConfigPath))
  changed.push(`config.yml <- ${options.baseConfigPath} (Data 路径已绝对化)` + (options.baseConfigPath === target ? '' : ''))
  if (pathStat.found > pathStat.rewritten) {
    warnings.push(
      `Data 路径绝对化：${pathStat.rewritten}/${pathStat.found} 行匹配（${pathStat.found - pathStat.rewritten} 行未匹配，` +
        `相对路径可能仍指向错误位置）— 请检查 config.yml 的 data/phsp/bkg 行格式`,
    )
  }

  // Canonical names inside the iteration dir (fit.py/plot.py): the fit runner
  // invokes `python fit.py`, so the source file's basename (e.g. aifit.py)
  // must not leak into the link name.
  for (const [script, field, linkName] of [
    [options.fitScriptPath, 'fitScriptPath', 'fit.py'],
    [options.plotScriptPath, 'plotScriptPath', 'plot.py'],
  ] as const) {
    if (!script) continue
    if (!existsSync(script)) {
      throw new Error(`${field} not found: ${script}`)
    }
    const link = join(iterDir, linkName)
    try {
      symlinkSync(script, link)
      changed.push(`${linkName} -> ${script}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }

  writeFileSync(join(iterDir, 'note.md'), `# iter-${String(iter).padStart(3, '0')}\n\n（本轮决策记录）\n`)
  changed.push(`note.md 骨架`)
  return { iterDir, iter, changed, warnings }
}

/** Discover existing iteration dirs under an iterations root. */
export function listIterations(iterationsRoot: string): string[] {
  if (!existsSync(iterationsRoot)) return []
  return readdirSync(iterationsRoot)
    .filter((n) => /^iter-\d{3,}$/.test(n))
    .sort()
    .map((n) => join(iterationsRoot, n))
}

/** Trial (short parallel candidate fit) dirs live under `_trials/`, outside
 * the iter-N sequence so they never pollute the main iteration numbering. */
export function trialsRootOf(iterationsRoot: string): string {
  return join(iterationsRoot, '_trials')
}

/** Discover existing trial dirs (sorted by name). */
export function listTrials(iterationsRoot: string): string[] {
  const root = trialsRootOf(iterationsRoot)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((n) => n.startsWith('trial-'))
    .sort()
    .map((n) => join(root, n))
}

/**
 * Create one trial dir for a candidate experiment: copies the base config
 * (with Data paths absolutized), symlinks the fit script as fit.py.
 * Trial dirs are NOT part of the iter-N sequence.
 */
export function createTrialDir(options: {
  iterationsRoot: string
  baseConfigPath: string
  label: string
  fitScriptPath?: string
}): { trialDir: string; changed: string[]; warnings: string[] } {
  const root = trialsRootOf(options.iterationsRoot)
  mkdirSync(root, { recursive: true })
  const trialDir = join(root, `trial-${options.label.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
  if (!existsSync(options.baseConfigPath)) {
    throw new Error(`base config not found: ${options.baseConfigPath}`)
  }
  const changed: string[] = []
  const warnings: string[] = []
  const target = join(trialDir, 'config.yml')
  mkdirSync(trialDir, { recursive: true })
  copyFileSync(options.baseConfigPath, target)
  const pathStat = absolutizeDataPaths(target, dirname(options.baseConfigPath))
  changed.push(`config.yml <- ${options.baseConfigPath} (Data 路径已绝对化)`)
  if (pathStat.found > pathStat.rewritten) {
    warnings.push(
      `Data 路径绝对化：${pathStat.rewritten}/${pathStat.found} 行匹配 — 相对路径可能仍指向错误位置`,
    )
  }
  if (options.fitScriptPath !== undefined) {
    if (!existsSync(options.fitScriptPath)) {
      throw new Error(`fitScriptPath not found: ${options.fitScriptPath}`)
    }
    try {
      symlinkSync(options.fitScriptPath, join(trialDir, 'fit.py'))
      changed.push(`fit.py -> ${options.fitScriptPath}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  return { trialDir, changed, warnings }
}

/** Infer the iterations root from an iterDir (parent dir). */
export function iterationsRootOf(iterDir: string): string {
  return dirname(iterDir)
}

/**
 * Rewrite the Data section of a config.yml so every relative path is resolved
 * against `baseDir` (the directory the config originally lived in) and made
 * absolute. ctpwa reads config paths relative to its cwd, so iteration dirs
 * need absolute paths to stay correct.
 *
 * Text-level replacement (comments preserved): matches lines like
 *   data: [dat, "../root/cut_data.root"]
 *   phsp: [ROOT, "../root/cut_phsp.root", "OmegaKsKs", ...]
 *
 * @returns how many data/phsp/bkg lines were found and how many rewritten
 * (a found > rewritten mismatch means the config uses an unsupported layout
 * and relative paths may silently stay wrong).
 */
export function absolutizeDataPaths(configPath: string, baseDir: string): { found: number; rewritten: number } {
  const text = readFileSync(configPath, 'utf8')
  const found = (text.match(/^\s*(?:data|phsp|bkg|bkg_weights)\s*:/gm) ?? []).length
  let rewritten = 0
  const out = text.replace(
    /(^\s*(?:data|phsp|bkg|bkg_weights)\s*:\s*\[\s*(?:dat|ROOT)\s*,\s*")([^"]+)("\s*)/gm,
    (m, pre: string, p: string, post: string) => {
      if (isAbsolute(p)) return m
      rewritten += 1
      return pre + resolve(baseDir, p) + post
    },
  )
  if (out !== text) writeFileSync(configPath, out)
  return { found, rewritten }
}
