import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync as mkdirSyncSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin/pwa-commands.js'
import { IterationLog } from '../src/iteration-log.js'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionLike } from '@deepseek-ai/cordis'

describe('pwa-commands (/pwa-status)', () => {
  function ctxWith(parts: { jobs?: { list?: () => { id: string; kind: string; label: string; status: string; detail?: string }[] }; commands?: CommandDefinitionLike[] }) {
    const registrations: CommandDefinitionLike[] = []
    const ctx = {
      commands: {
        register: (def: CommandDefinitionLike) => {
          registrations.push(def)
          return () => {}
        },
      },
      jobs: parts.jobs,
    } as unknown as Context
    apply(ctx)
    return { registrations, ctx }
  }

  it('registers the pwa-status command', () => {
    const { registrations } = ctxWith({})
    expect(registrations.map((r) => r.name)).toEqual(['pwa-status'])
  })

  it('renders live jobs and the iteration diary summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-cmd-'))
    try {
      const log = new IterationLog({ rootDir: root })
      log.append({ iter: 0, title: '基线', kind: 'other', nll: -18623.5, conclusion: '基线可接受', nextPlan: '加 rho(1450)' })
      log.append({ iter: 1, title: '加 rho(1450)', kind: 'added', nll: -18635.9, deltaNll: -12.4, conclusion: '显著改善' })
      const { registrations } = ctxWith({
        jobs: {
          list: () => [
            { id: 'ctpwa-2', kind: 'ctpwa', label: 'ctpwa fit /pwa/iter-002', status: 'running' },
            { id: 'ctpwa-1', kind: 'ctpwa', label: 'ctpwa fit /pwa/iter-001', status: 'completed', detail: 'exit code: 0' },
          ],
        },
      })
      const result = registrations[0]!.handler({
        agent: { sessionId: 'sess-1' },
        rawInput: root,
        signal: new AbortController().signal,
      }) as { kind: 'success'; text?: string }
      expect(result.kind).toBe('success')
      expect(result.text).toContain('ctpwa-2')
      expect(result.text).toContain('completed')
      expect(result.text).toContain('iter-001 加 rho(1450)')
      expect(result.text).toContain('ΔNLL=-12.4')
      expect(result.text).toContain('下一轮 iter-002')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades gracefully without jobs or a valid root', () => {
    const { registrations } = ctxWith({})
    const r1 = registrations[0]!.handler({ agent: { sessionId: 's' }, rawInput: '', signal: new AbortController().signal }) as { kind: 'success'; text: string }
    expect(r1.text).toContain('后台任务: 无')
    // A nonexistent root is an empty diary, not an error.
    const r2 = registrations[0]!.handler({ agent: { sessionId: 's' }, rawInput: '/nonexistent/root', signal: new AbortController().signal }) as { kind: 'success'; text: string }
    expect(r2.text).toContain('迭代日记: 空')
    // An unreadable diary (SUMMARY.jsonl as a directory) surfaces as a failure line.
    const broken = mkdtempSync(join(tmpdir(), 'dsh-pwa-cmd-broken-'))
    try {
      mkdirSyncSync(join(broken, 'SUMMARY.jsonl'))
      const r3 = registrations[0]!.handler({ agent: { sessionId: 's' }, rawInput: broken, signal: new AbortController().signal }) as { kind: 'success'; text: string }
      expect(r3.text).toContain('读取失败')
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})
