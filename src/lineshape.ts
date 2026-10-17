/**
 * 线形模型的**惯例**（advisory only）。
 *
 * 设计原则（用户明确要求）：**只提醒、不强制**。同一个共振态在不同过程里可以有
 * 不同的线形（阈值位置、附近耦合道、拟合稳定性都会改变选择），所以这里只提供
 * "常见做法 + 理由 + 需要哪些额外字段"，由人或模型决定是否采纳；门禁永远不因此报错。
 *
 * 证据来源：`data/lineshape-usage-stats.json`（扫各分析 config.yml 得到的实际用法）。
 */
import conventionsJson from '../data/lineshape-conventions.json' with { type: 'json' }
import { normalizeName } from './lookup.js'

export interface LineshapeConvention {
  /** 电荷无关的 PDG id 前缀，如 "rho(770)"、"f(0)(980)"。 */
  id: string
  aliases?: string[]
  /** 惯例线形（BWR/BW/GS/Flatte/ONE/Interp/Custom 之一）。 */
  model: string
  /** 为什么这是惯例（给模型看的解释）。 */
  why: string
  /** 该线形需要额外提供的字段（如 Flatte 的 channels）。 */
  needs?: string[]
}

const CONVENTIONS: LineshapeConvention[] = (conventionsJson as { conventions: LineshapeConvention[] }).conventions

/** 某条目的规范 id 是否命中某惯例（前缀匹配电荷变体 + 别名规范化相等）。 */
function matches(conv: LineshapeConvention, entryId: string, entryAliases: readonly string[]): boolean {
  const id = entryId.trim()
  if (id.startsWith(conv.id)) return true
  const names = [id, ...entryAliases].map(normalizeName)
  return [conv.id, ...(conv.aliases ?? [])].map(normalizeName).some((n) => names.includes(n))
}

/** 查一个条目的线形惯例（按 PDG id / 别名）。 */
export function conventionFor(entryId: string, entryAliases: readonly string[] = []): LineshapeConvention | undefined {
  return CONVENTIONS.find((c) => matches(c, entryId, entryAliases))
}

/** 全部惯例（给文档/测试用）。 */
export function allConventions(): readonly LineshapeConvention[] {
  return CONVENTIONS
}

/** 给模型看的一句话提醒（偏离时用；**不阻塞**）。 */
export function conventionHint(conv: LineshapeConvention): string {
  const needs = conv.needs !== undefined && conv.needs.length > 0 ? `；该线形还需要 ${conv.needs.join('/')}` : ''
  return `惯例是用 ${conv.model}（${conv.why}）${needs}。这只是提醒：不同过程形状可以不同，按物理判断决定即可。`
}
