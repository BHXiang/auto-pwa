import { describe, expect, it } from 'vitest'
import {
  createUsageTracker,
  maybeSpill,
  configWriteGuard,
  GUARD_WRITE_REASON,
  GUARD_BASH_REASON,
  SPILL_THRESHOLD_BYTES,
} from '../plugin/pwa-utils.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------------------
// token-meter (usage tracker)
// ---------------------------------------------------------------------------

describe('createUsageTracker', () => {
  it('accumulates assistant/message usage per session (envelope: usage at data.usage)', () => {
    const t = createUsageTracker()
    t.onSessionEvent('s1', { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20 } } })
    t.onSessionEvent('s1', { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 30 } } })
    t.onSessionEvent('s2', { type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 3 } } })
    t.onSessionEvent('s1', { type: 'tool/result' }) // no usage: ignored
    // Flat usage (wrong envelope) must NOT accumulate: the real harness event
    // carries usage inside data.
    t.onSessionEvent('s1', { type: 'assistant/message', usage: { inputTokens: 9999, outputTokens: 9999 } } as never)
    expect(t.total('s1')).toEqual({ input: 150, output: 30, cacheRead: 30, cacheWrite: 0 })
    expect(t.total('s2')).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 })
    expect(t.total('nobody')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('takeDelta returns the per-round difference and re-anchors', () => {
    const t = createUsageTracker()
    t.onSessionEvent('s1', { type: 'assistant/message', data: { usage: { inputTokens: 500, outputTokens: 80 } } })
    // Round 1 ends: 500+80.
    expect(t.takeDelta('s1')).toEqual({ input: 500, output: 80, cacheRead: 0, cacheWrite: 0 })
    // Round 2: more usage.
    t.onSessionEvent('s1', { type: 'assistant/message', data: { usage: { inputTokens: 300, outputTokens: 40, cacheWriteTokens: 12 } } })
    expect(t.takeDelta('s1')).toEqual({ input: 300, output: 40, cacheRead: 0, cacheWrite: 12 })
    // No usage since the last note -> zero delta.
    expect(t.takeDelta('s1')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    // Totals still accumulate across rounds.
    expect(t.total('s1')).toEqual({ input: 800, output: 120, cacheRead: 0, cacheWrite: 12 })
  })
})

// ---------------------------------------------------------------------------
// spill
// ---------------------------------------------------------------------------

describe('maybeSpill', () => {
  const smallCtx = (spillStore?: Context['spillStore']): Context =>
    ({ spillStore }) as unknown as Context
  const exec = { agent: { sessionId: 'sess-1' }, rootCallId: 'call-1' }

  it('keeps small outputs inline', async () => {
    const saved: unknown[] = []
    const ctx = smallCtx({ saveText: async (input) => { saved.push(input); return { locator: '/x', bytes: 1, retrievalHint: 'r' } } })
    const out = await maybeSpill(ctx, exec, 't', 'small', { hello: 1 })
    expect(out).toEqual({ hello: 1 })
    expect(saved).toEqual([])
  })

  it('spills oversized outputs and keeps the summary', async () => {
    const big = 'x'.repeat(SPILL_THRESHOLD_BYTES + 1)
    const ctx = smallCtx({
      saveText: async (input) => {
        expect(input.owner.sessionId).toBe('sess-1')
        expect(input.source.toolName).toBe('auto_pwa_evaluate')
        expect(input.source.callId).toBe('call-1')
        expect(input.content).toBe(big)
        return { locator: '/spill/evaluate.txt', bytes: big.length, retrievalHint: 'read or grep it' }
      },
    })
    const out = await maybeSpill(ctx, exec, 'auto_pwa_evaluate', big, { summary: 1 }) as { spilled: true; locator: string; bytes: number; retrievalHint: string; summary: { summary: number } }
    expect(out.spilled).toBe(true)
    expect(out.locator).toBe('/spill/evaluate.txt')
    expect(out.retrievalHint).toContain('read')
    expect(out.summary).toEqual({ summary: 1 })
  })

  it('degrades to inline when spillStore is absent or save fails', async () => {
    const big = 'x'.repeat(SPILL_THRESHOLD_BYTES + 1)
    expect(await maybeSpill(smallCtx(undefined), exec, 't', big, 'fallback')).toBe('fallback')
    expect(await maybeSpill(smallCtx(undefined), exec, 't', 'small', 'fallback')).toBe('fallback')
    const failing = smallCtx({ saveText: async () => { throw new Error('ENOSPC') } })
    expect(await maybeSpill(failing, exec, 't', big, 'fallback')).toBe('fallback')
  })
})

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

describe('configWriteGuard (monotonic deny)', () => {
  const exec = (name: string, args: Record<string, unknown>): ToolExecution =>
    ({ name, arguments: args, signal: new AbortController().signal }) as ToolExecution

  it('denies write/edit of any config.yml/config.yaml', () => {
    expect(configWriteGuard(exec('write', { file_path: '/home/w/pwa/iter-001/config.yml', content: 'x' }))).toBe(GUARD_WRITE_REASON)
    expect(configWriteGuard(exec('edit', { file_path: '/pwa/config.yaml' }))).toBe(GUARD_WRITE_REASON)
    expect(configWriteGuard(exec('write', { file_path: 'config.yml' }))).toBe(GUARD_WRITE_REASON)
  })

  it('denies bash writes via redirect / tee / sed -i', () => {
    expect(configWriteGuard(exec('bash', { command: 'echo "x" > /pwa/config.yml' }))).toBe(GUARD_BASH_REASON)
    expect(configWriteGuard(exec('bash', { command: 'printf "y" >> /pwa/iter/config.yml && ls' }))).toBe(GUARD_BASH_REASON)
    expect(configWriteGuard(exec('bash', { command: 'cat /tmp/new | tee /pwa/config.yml' }))).toBe(GUARD_BASH_REASON)
    expect(configWriteGuard(exec('bash', { command: 'sed -i "s/1/2/" /pwa/config.yml' }))).toBe(GUARD_BASH_REASON)
  })

  it('allows reads, other files, and unrelated commands', () => {
    expect(configWriteGuard(exec('read', { file_path: '/pwa/config.yml', offset: 1 }))).toBeUndefined()
    expect(configWriteGuard(exec('write', { file_path: '/pwa/note.md', content: 'x' }))).toBeUndefined()
    expect(configWriteGuard(exec('bash', { command: 'grep -n "phi" /pwa/config.yml' }))).toBeUndefined()
    expect(configWriteGuard(exec('bash', { command: 'ls /pwa' }))).toBeUndefined()
    expect(configWriteGuard(exec('auto_pwa_edit_config', { configPath: '/pwa/config.yml' }))).toBeUndefined()
  })
})
