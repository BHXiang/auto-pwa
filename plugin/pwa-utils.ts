/**
 * pwa-utils：跨插件文件共享的 DSH 集成小件（纯函数/可注入，独立可测）：
 *   - createUsageTracker：按 session 累计 assistant/message 的 TokenUsage，
 *     供 auto_pwa_note 每轮记账（token-meter 的轻量落地：轮间差值写进日记）；
 *   - maybeSpill：大输出进 ctx.spillStore（模型按需 read/grep 取回），
 *     不可用时静默回退内联——spill 是尽力而为，从不丢结果；
 *   - configWriteGuard：config.yml 直接写门禁（单调 deny 兜底硬规则）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------------------
// token-meter：按 session 累计用量
// ---------------------------------------------------------------------------

/** 与 @deepseek-ai/dsh-llm TokenUsage 结构一致（事件载荷，避免额外依赖）。 */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 累计（自会话开始）与单轮（上次记账以来）的 token 汇总。 */
export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const zeroTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export function addTokens(total: TokenTotals, usage: TokenUsageLike): TokenTotals {
  return {
    input: total.input + usage.inputTokens,
    output: total.output + usage.outputTokens,
    cacheRead: total.cacheRead + (usage.cacheReadTokens ?? 0),
    cacheWrite: total.cacheWrite + (usage.cacheWriteTokens ?? 0),
  }
}

/** 每 session 的累计用量（tracker 内部状态）。 */
export interface UsageTracker {
  /** 累计（会话开始至今）。 */
  total(sessionId: string): TokenTotals
  /** 自上次 takeDelta 以来的增量（记账并重置锚点）。 */
  takeDelta(sessionId: string): TokenTotals
  /** 处理一条 session 事件（assistant/message 携带 usage 时累计）。 */
  onSessionEvent(sessionId: string, event: SessionEventLike): void
}

/**
 * DSH session 事件信封的瘦子集：持久化日志的形状是
 * `{ type, seq, time, data }`，`assistant/message` 的用量位于 `data.usage`
 * （见 harness core/session 的 SessionEvent / SessionEventMap）。
 */
export interface SessionEventLike {
  type?: string
  data?: { usage?: TokenUsageLike }
}

/**
 * 每 session 用量累计器。`onSessionEvent` 由 ctx.on('session/event', ...)
 * 接线；`takeDelta` 供 auto_pwa_note 每轮调用（差值 = 本轮 token 消耗）。
 */
export function createUsageTracker(): UsageTracker {
  const totals = new Map<string, TokenTotals>()
  const anchors = new Map<string, TokenTotals>()
  return {
    total(sessionId: string): TokenTotals {
      return totals.get(sessionId) ?? zeroTokens()
    },
    takeDelta(sessionId: string): TokenTotals {
      const now = totals.get(sessionId) ?? zeroTokens()
      const anchor = anchors.get(sessionId) ?? zeroTokens()
      anchors.set(sessionId, now)
      return {
        input: now.input - anchor.input,
        output: now.output - anchor.output,
        cacheRead: now.cacheRead - anchor.cacheRead,
        cacheWrite: now.cacheWrite - anchor.cacheWrite,
      }
    },
    onSessionEvent(sessionId: string, event: SessionEventLike): void {
      if (event?.type !== 'assistant/message') return
      const usage = event.data?.usage
      if (usage === undefined) return
      totals.set(sessionId, addTokens(totals.get(sessionId) ?? zeroTokens(), usage))
    },
  }
}

// ---------------------------------------------------------------------------
// spill：大输出进 spill 存储
// ---------------------------------------------------------------------------

/** 输出序列化超过该字节数时尝试 spill（16 KiB）。 */
export const SPILL_THRESHOLD_BYTES = 16 * 1024

export interface SpillResult {
  spilled: true
  locator: string
  bytes: number
  retrievalHint: string
  /** 内联保留的精简摘要（仍符合工具 schema）。 */
  summary: unknown
}

/**
 * 序列化输出超过阈值且 spillStore 可用时，把完整文本存入 spill 存储并
 * 返回 locator + 精简摘要；否则原样返回 fallback（never throws）。
 */
export async function maybeSpill(
  ctx: Context,
  exec: { agent?: { sessionId?: string }; rootCallId?: string },
  toolName: string,
  content: string,
  fallback: unknown,
): Promise<SpillResult | unknown> {
  if (content.length <= SPILL_THRESHOLD_BYTES || ctx.spillStore === undefined || exec.agent?.sessionId === undefined) {
    return fallback
  }
  try {
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: exec.agent.sessionId },
      source: { toolName, callId: exec.rootCallId ?? 'unknown', label: 'result' },
      suggestedName: `${toolName}.txt`,
      content,
    })
    return { spilled: true, locator: ref.locator, bytes: ref.bytes, retrievalHint: ref.retrievalHint, summary: fallback }
  } catch {
    // Spill is best-effort: keep the inline result on any storage failure.
    return fallback
  }
}

// ---------------------------------------------------------------------------
// guard：config.yml 直接写门禁（单调 deny 兜底）
// ---------------------------------------------------------------------------

/** 命中 config.yml/config.yaml 的路径（basename 判定，任意目录）。 */
export const CONFIG_FILE_RE = /(^|[\\/])config\.ya?ml$/i

export const GUARD_WRITE_REASON =
  'config.yml 只能由 auto_pwa_edit_config 修改（先物理校验 → 结构化改 → 原子写）；pwa-guard 拦下了直接写。'
export const GUARD_BASH_REASON =
  'pwa-guard 拦下：bash 里直接写 config.yml 会绕过物理门禁，必须走 auto_pwa_edit_config。'

/**
 * 单调 deny 守卫：write/edit 直接写 config.yml、或 bash 对 config.yml 的
 * 显式写操作（重定向/tee/sed -i）一律拒绝；其余放行（guard 只能 deny，
 * 不能 force-allow）。返回 undefined 表示放行。
 */
export function configWriteGuard(exec: ToolExecution): string | undefined {
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  if ((exec.name === 'write' || exec.name === 'edit') && typeof args.file_path === 'string') {
    if (CONFIG_FILE_RE.test(args.file_path)) return GUARD_WRITE_REASON
  }
  if (exec.name === 'bash' && typeof args.command === 'string') {
    const cmd = args.command
    // Explicit write operators targeting a config.yml path: `>`/`>>`
    // redirection, `tee`, and in-place `sed -i`.
    if (/(?:>>?|tee)\s*[^;&|\n]{0,160}config\.ya?ml|sed\s+-i\s*[^;&|\n]{0,160}config\.ya?ml/i.test(cmd)) {
      return GUARD_BASH_REASON
    }
  }
  return undefined
}
