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
  // The real DSH Agent exposes `id`; the old `{ sessionId }` shape (from the
  // wrong vendored stub) silently disabled spilling. Both are covered.
  const exec = { agent: { id: 'sess-1' }, rootCallId: 'call-1' }
  const legacyExec = { agent: { sessionId: 'sess-legacy' }, rootCallId: 'call-1' }

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

  it('still spills for a legacy-shaped agent and tolerates a missing exec', async () => {
    const big = 'x'.repeat(SPILL_THRESHOLD_BYTES + 1)
    const saved: { owner?: { sessionId?: string } }[] = []
    const ctx = smallCtx({ saveText: async (input) => { saved.push(input as { owner?: { sessionId?: string } }); return { locator: '/x', bytes: 1, retrievalHint: 'r' } } })
    const out = (await maybeSpill(ctx, legacyExec, 't', big, { s: 1 })) as { spilled?: boolean }
    expect(out.spilled).toBe(true)
    expect(saved[0]?.owner?.sessionId).toBe('sess-legacy')
    // No execution context at all: keep inline instead of throwing.
    expect(await maybeSpill(ctx, undefined, 't', big, 'fallback')).toBe('fallback')
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

describe('configWriteGuard (monotonic deny: init_config.yml only)', () => {
  const exec = (name: string, args: Record<string, unknown>): ToolExecution =>
    ({ name, arguments: args, signal: new AbortController().signal }) as ToolExecution

  it('ALLOWS write/edit of config.yml (run-time gate replaced the write gate)', () => {
    expect(configWriteGuard(exec('write', { file_path: '/home/w/pwa/iter-001/config.yml', content: 'x' }))).toBeUndefined()
    expect(configWriteGuard(exec('edit', { file_path: '/pwa/config.yaml' }))).toBeUndefined()
    expect(configWriteGuard(exec('write', { file_path: 'config.yml' }))).toBeUndefined()
    // Variant configs were always outside the old guard; they stay free.
    expect(configWriteGuard(exec('write', { file_path: '/pwa/variant_broad.yml', content: 'x' }))).toBeUndefined()
  })

  it('allows bash writes to config.yml (validated at fit time, not write time)', () => {
    expect(configWriteGuard(exec('bash', { command: 'echo "x" > /pwa/config.yml' }))).toBeUndefined()
    expect(configWriteGuard(exec('bash', { command: 'sed -i "s/1/2/" /pwa/iter/config.yml' }))).toBeUndefined()
  })

  it('still denies init_config.yml (the from-scratch path must go through the tool)', () => {
    expect(configWriteGuard(exec('write', { file_path: '/pwa/init_config.yml', content: 'x' }))).toBe(GUARD_WRITE_REASON)
    expect(configWriteGuard(exec('edit', { file_path: '/pwa/init_config.yaml' }))).toBe(GUARD_WRITE_REASON)
    expect(configWriteGuard(exec('bash', { command: 'echo "x" > /pwa/init_config.yml' }))).toBe(GUARD_BASH_REASON)
    expect(configWriteGuard(exec('bash', { command: 'sed -i "s/a/b/" /pwa/init_config.yml' }))).toBe(GUARD_BASH_REASON)
    expect(configWriteGuard(exec('bash', { command: 'printf "y" >> /pwa/iter/init_config.yml && ls' }))).toBe(GUARD_BASH_REASON)
    expect(configWriteGuard(exec('bash', { command: 'cat /tmp/new | tee /pwa/init_config.yml' }))).toBe(GUARD_BASH_REASON)
  })

  it('allows reads, other files, and unrelated commands', () => {
    expect(configWriteGuard(exec('read', { file_path: '/pwa/config.yml', offset: 1 }))).toBeUndefined()
    expect(configWriteGuard(exec('write', { file_path: '/pwa/note.md', content: 'x' }))).toBeUndefined()
    expect(configWriteGuard(exec('write', { file_path: '/pwa/my_config_notes.yml', content: 'x' }))).toBeUndefined()
    expect(configWriteGuard(exec('bash', { command: 'grep -n "phi" /pwa/config.yml' }))).toBeUndefined()
    expect(configWriteGuard(exec('bash', { command: 'ls /pwa' }))).toBeUndefined()
    expect(configWriteGuard(exec('auto_pwa_edit_config', { configPath: '/pwa/config.yml' }))).toBeUndefined()
    expect(configWriteGuard(exec('auto_pwa_init_config', { dir: '/pwa' }))).toBeUndefined()
  })
})
