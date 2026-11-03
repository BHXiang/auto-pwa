/**
 * Runtime PDG knowledge source.
 *
 * Default: build the ResonanceDb once per process from the official PDG
 * package's local SQLite through PdgApi (no network).  If the package/helper
 * is unavailable, fall back to the versioned data/pdg.json snapshot.  The
 * snapshot remains the deterministic source for unit tests and offline use.
 *
 * data/pdg.json is still a checksummed trust anchor: it supplies the fallback
 * and the curated aliases/decay annotations used by the API overlay.  Local
 * states are appended separately and never acquire PDG provenance.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ResonanceDb, ResonanceEntry } from './types.js'
import raw from '../data/pdg.json' with { type: 'json' }
import localRaw from '../data/local-states.json' with { type: 'json' }
import manifest from '../data/pdg.manifest.json' with { type: 'json' }

/** Official snapshot, without local states. */
const pdgDb = raw as unknown as ResonanceDb

/** Curated global extensions; these never count as PDG backing. */
export const localStates: ResonanceEntry[] = ((localRaw as unknown as { states?: ResonanceEntry[] }).states ?? []).map((s) => ({
  ...s,
  status: 'local' as const,
}))

/** Canonical, formatting-independent content hash. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export interface DbIntegrity {
  ok: boolean
  expected?: string
  actual: string
  warning?: string
}

/** Integrity of the checked-in snapshot (also used by the API overlay). */
export const dbIntegrity: DbIntegrity = (() => {
  const actual = canonicalHash(pdgDb)
  const expected = (manifest as { canonicalSha256?: string }).canonicalSha256
  if (expected === undefined) {
    return {
      ok: false,
      actual,
      warning: 'PDG 表没有 manifest 校验和（data/pdg.manifest.json 缺失或未生成）：请运行 `npm run check:pdg -- --write`。',
    }
  }
  if (expected !== actual) {
    return {
      ok: false,
      expected,
      actual,
      warning:
        'PDG 快照内容与 manifest 不符：离线回退和策展别名的可信度受影响；' +
        '请用 `npm run check:pdg` 定位，或重新同步并提交评审。',
    }
  }
  return { ok: true, expected, actual }
})()

export interface PdgProviderInfo {
  /** pdg-api = official local PDG API; snapshot = forced/offline; snapshot-fallback = API failed. */
  source: 'pdg-api' | 'snapshot' | 'snapshot-fallback'
  /** Hash of the active official database, before local-state extensions. */
  canonicalSha256: string
  edition?: string
  releaseTimestamp?: string
  sqliteSha256?: string
  sqlitePath?: string
  entries: number
  warning?: string
}

interface ApiPayload {
  db?: ResonanceDb
  meta?: {
    edition?: string
    releaseTimestamp?: string
    sqliteSha256?: string
    sqlitePath?: string
  }
}

function apiHelperPath(): string | undefined {
  const candidates = [
    new URL('../scripts/pdg_api_db.py', import.meta.url).pathname,
    new URL('../../scripts/pdg_api_db.py', import.meta.url).pathname,
  ]
  return candidates.find((p) => !p.includes('/lib/scripts/') && existsSync(p)) ?? candidates.find((p) => existsSync(p))
}

/** One synchronous API build per Node process; no Python process per lookup. */
function loadApi(): { payload?: ApiPayload; warning?: string } {
  const requested = process.env.PWA_PDG_SOURCE?.toLowerCase()
  const deterministicTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test'
  if (requested === 'snapshot' || (requested === undefined && deterministicTest)) return {}
  const helper = apiHelperPath()
  if (helper === undefined) return { warning: '找不到 scripts/pdg_api_db.py' }
  const python = process.env.PWA_PDG_PYTHON ?? process.env.PWA_CTPWA_PYTHON ?? 'python'
  const timeout = Number(process.env.PWA_PDG_API_TIMEOUT_MS ?? 60000)
  const run = spawnSync(python, [helper], {
    encoding: 'utf8',
    timeout: Number.isFinite(timeout) ? timeout : 60000,
    maxBuffer: 128 * 1024 * 1024,
    env: process.env,
  })
  if (run.error !== undefined || run.status !== 0) {
    const stderr = (run.stderr ?? '').trim()
    const detail = run.error?.message ?? (stderr !== '' ? stderr.slice(-500) : `exit ${run.status}`)
    return { warning: `PDG API 初始化失败（${python}）：${detail}` }
  }
  try {
    const payload = JSON.parse(run.stdout) as ApiPayload
    if (!Array.isArray(payload.db?.resonances) || payload.db.resonances.length === 0) {
      return { warning: 'PDG API 返回了空或无效的共振态表' }
    }
    return { payload }
  } catch (e) {
    return { warning: `PDG API 输出解析失败：${(e as Error).message}` }
  }
}

const api = loadApi()
const activeOfficialDb = api.payload?.db ?? pdgDb
const apiUsed = api.payload?.db !== undefined
const source: PdgProviderInfo['source'] = apiUsed
  ? 'pdg-api'
  : api.warning !== undefined
    ? 'snapshot-fallback'
    : 'snapshot'

/** Active runtime table = selected official source ∪ global local states. */
export const defaultDb: ResonanceDb = {
  ...activeOfficialDb,
  resonances: [...activeOfficialDb.resonances, ...localStates],
}

export const pdgProvider: PdgProviderInfo = {
  source,
  canonicalSha256: canonicalHash(activeOfficialDb),
  entries: activeOfficialDb.resonances.length,
  ...(api.payload?.meta?.edition !== undefined ? { edition: api.payload.meta.edition } : {}),
  ...(api.payload?.meta?.releaseTimestamp !== undefined ? { releaseTimestamp: api.payload.meta.releaseTimestamp } : {}),
  ...(api.payload?.meta?.sqliteSha256 !== undefined ? { sqliteSha256: api.payload.meta.sqliteSha256 } : {}),
  ...(api.payload?.meta?.sqlitePath !== undefined ? { sqlitePath: api.payload.meta.sqlitePath } : {}),
  ...(api.warning !== undefined ? { warning: `PDG API 不可用，回退到 pdg.json 快照：${api.warning}` } : {}),
}
