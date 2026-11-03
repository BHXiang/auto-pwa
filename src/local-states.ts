/**
 * 本地登记的共振态（**非 PDG**）。
 *
 * 设计（P1）：`data/pdg.json` 只放 PDG 官方事实（由 fetch 脚本生成、有 manifest 校验和）；
 * "分析需要但 PDG 没有"的态放进本地登记表，并在两处生效：
 *   1. `data/local-states.json` —— 跨分析共享的策展表；默认 `states: []`，
 *      只保留格式示例，避免一个项目的试探态污染其他分析；
 *   2. `<analysis>/local-states.json` —— **每个分析自己的**追加表，是新态的默认位置。
 *
 * 语义：这些态**不参与"PDG 依据"判定**，门禁只给 `local-not-pdg` warning（不阻塞）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResonanceDb, ResonanceEntry } from './types.js'
import { localStates } from './db.js'

interface LocalStateFile {
  schemaVersion?: string
  note?: string
  states?: Omit<ResonanceEntry, 'status'>[]
}

/** 读 `<analysisRoot>/local-states.json`（不存在/损坏时返回空，绝不抛）。 */
export function localStatesFor(analysisRoot: string | undefined): ResonanceEntry[] {
  if (analysisRoot === undefined) return []
  const path = join(analysisRoot, 'local-states.json')
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LocalStateFile
    return (parsed.states ?? []).map((s) => ({ ...s, status: 'local' as const }))
  } catch {
    return []
  }
}

/** 把某分析的本地登记并入 db（无追加时原样返回，避免多余分配）。 */
export function dbWithLocal(base: ResonanceDb, analysisRoot?: string): ResonanceDb {
  const extra = localStatesFor(analysisRoot)
  if (extra.length === 0) return base
  return { ...base, resonances: [...base.resonances, ...extra] }
}

export interface LocalStateAudit {
  /** Reviewed cross-analysis registry, hashed by content. */
  global: { states: string[]; canonicalSha256: string }
  /** The current analysis's own extension, when present. */
  analysis?: { path: string; sha256: string; states: string[] }
}

/**
 * Record which non-PDG extensions were visible to a fit.  A work-specific state
 * belongs in <analysis>/local-states.json; the global file is reserved for
 * reviewed states deliberately shared across analyses.
 */
export function auditLocalStates(analysisRoot?: string): LocalStateAudit {
  const global = {
    states: localStates.map((s) => s.id),
    canonicalSha256: createHash('sha256').update(JSON.stringify(localStates)).digest('hex'),
  }
  if (analysisRoot === undefined) return { global }
  const path = join(analysisRoot, 'local-states.json')
  if (!existsSync(path)) return { global }
  const text = readFileSync(path, 'utf8')
  return {
    global,
    analysis: {
      path,
      sha256: createHash('sha256').update(text).digest('hex'),
      states: localStatesFor(analysisRoot).map((s) => s.id),
    },
  }
}
