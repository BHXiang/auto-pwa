/**
 * 本地登记的共振态（**非 PDG**）。
 *
 * 设计（P1）：`data/pdg.json` 只放 PDG 官方事实（由 fetch 脚本生成、有 manifest 校验和）；
 * "分析需要但 PDG 没有"的态放进本地登记表，并在两处生效：
 *   1. `data/local-states.json` —— 跨分析共享的策展表（带 reason，人工提交评审）；
 *   2. `<analysis>/local-states.json` —— **每个分析自己的**追加表（默认没有）。
 *
 * 语义：这些态**不参与"PDG 依据"判定**，门禁只给 `local-not-pdg` warning（不阻塞）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResonanceDb, ResonanceEntry } from './types.js'

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
