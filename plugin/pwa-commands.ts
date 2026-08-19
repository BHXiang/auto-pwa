/**
 * pwa-commands：/pwa-status 斜杠命令（用户旁路观察面，不占模型消息）。
 *
 *   /pwa-status                  -> 本会话后台拟合任务摘要
 *   /pwa-status <iterationsRoot> -> + 迭代日记最近 5 轮（NLL/ΔNLL/结论）
 *
 * 数据全部来自 ctx.jobs（运行时真实状态）与迭代日记文件，handler 直接
 * 渲染，不经过模型——即点即看。
 */
import { Context } from '@deepseek-ai/cordis'
import { IterationLog } from '../src/iteration-log.js'

export const name = 'pwa-commands'
export const inject = ['commands']

export function apply(ctx: Context): void {
  ctx.commands?.register({
    name: 'pwa-status',
    description: 'PWA 迭代进度：后台拟合任务 + 迭代日记摘要（/pwa-status <iterationsRoot> 看日记）',
    input: { hint: '[<iterationsRoot>]' },
    handler: (invocation) => {
      const lines: string[] = ['PWA 进度:']
      // 1) live background jobs visible to this agent.
      try {
        const jobs = (ctx.jobs as { list?: (caller: unknown) => { id: string; kind: string; label: string; status: string; detail?: string }[] } | undefined)
          ?.list?.(invocation.agent as never) ?? []
        if (jobs.length === 0) {
          lines.push('  后台任务: 无')
        } else {
          lines.push(`  后台任务: ${jobs.length} 个`)
          for (const j of jobs) {
            lines.push(`    ${j.id} [${j.kind}] ${j.status}${j.detail !== undefined ? ` (${j.detail})` : ''} — ${j.label}`)
          }
        }
      } catch {
        lines.push('  后台任务: （不可用）')
      }
      // 2) iteration diary summary (needs the iterations root as input).
      const root = invocation.rawInput.trim()
      if (root.length > 0) {
        try {
          const log = new IterationLog({ rootDir: root })
          const records = log.readAll().slice(-5)
          if (records.length === 0) {
            lines.push('  迭代日记: 空')
          } else {
            lines.push(`  迭代日记: 最近 ${records.length} 轮（下一轮 iter-${String(log.nextIter()).padStart(3, '0')}）`)
            for (const r of records) {
              const d = r.deltaNll === undefined ? '' : ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(1)}`
              const n = r.nll === undefined ? '' : ` NLL=${r.nll.toFixed(1)}`
              const c = r.conclusion ? ` | ${r.conclusion.split('\n')[0].slice(0, 100)}` : ''
              lines.push(`    iter-${String(r.iter).padStart(3, '0')} ${r.title}${n}${d}${c}`)
            }
          }
        } catch (e) {
          lines.push(`  迭代日记: 读取失败 ${(e as Error).message}`)
        }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
