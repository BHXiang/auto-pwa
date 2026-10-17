/**
 * Loads data/pdg.json as a typed ResonanceDb, and checks it against
 * data/pdg.manifest.json.
 *
 * 为什么要有完整性校验：这张表是**校验门的信任锚**——BWR/BW/Flatte/GS 的
 * "PDG 依据"就是查它。它能被手改（历史上 agent 就往里加过 PDG 没有的态，
 * 如 `K*(2100)`），锚一旦漂移，门禁就形同虚设。所以我们记一个规范化哈希：
 * 内容与 manifest 不符时，lookup / validate 都显式提示"表格未验证"。
 */
import { createHash } from 'node:crypto'
import type { ResonanceDb } from './types.js'
import raw from '../data/pdg.json' with { type: 'json' }
import manifest from '../data/pdg.manifest.json' with { type: 'json' }

/** The shipped resonance table. */
export const defaultDb: ResonanceDb = raw as unknown as ResonanceDb

/** 规范化哈希：对解析后的对象做 JSON.stringify 再 sha256（与格式化无关）。 */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export interface DbIntegrity {
  /** true = 内容与 manifest 一致。 */
  ok: boolean
  /** manifest 里记的期望哈希（缺失说明 manifest 没生成过）。 */
  expected?: string
  actual: string
  /** 给模型看的一句话（ok 时为 undefined）。 */
  warning?: string
}

export const dbIntegrity: DbIntegrity = (() => {
  const actual = canonicalHash(defaultDb)
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
        'PDG 表内容与 manifest 不符（data/pdg.json 被手改过？）：校验门的"PDG 依据"判定不可信，' +
        '请用 `npm run check:pdg` 定位，或 `npm run check:pdg -- --write` 重新生成 manifest 并提交评审。',
    }
  }
  return { ok: true, expected, actual }
})()
