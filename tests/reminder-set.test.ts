import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { REMINDERS, buildReminders } from '../src/reminder-set.js'

describe('reminder-set（E3 档位）', () => {
  it('R0 空 / R1 全量 / R2 只挑相关动作', () => {
    expect(buildReminders('R0').ids).toEqual([])
    expect(buildReminders('R1').ids).toHaveLength(REMINDERS.length)
    const add = buildReminders('R2', 'add')
    const remove = buildReminders('R2', 'remove')
    // R2 ⊂ R1 且按动作变化
    expect(add.ids.length).toBeGreaterThan(0)
    expect(add.ids.length).toBeLessThan(REMINDERS.length)
    expect(add.ids.every((id) => REMINDERS.some((r) => r.id === id))).toBe(true)
    expect(remove.ids).not.toEqual(add.ids)
    // 删态不会看到"新态先 float 质量"这类无关提醒
    expect(remove.ids).not.toContain('new-res-float')
    expect(remove.ids).toContain('group-index-stable')
    // any 类提醒在两档都在
    for (const r of REMINDERS.filter((x) => x.triggers.includes('any'))) {
      expect(add.ids).toContain(r.id)
      expect(remove.ids).toContain(r.id)
    }
  })

  it('R1 比 R2 显著更长（"常驻 vs 按需"的 token 差异必须真实存在）', () => {
    const r1 = buildReminders('R1')
    const r2 = buildReminders('R2', 'remove')
    expect(r1.approxTokens).toBeGreaterThan(r2.approxTokens * 1.5)
  })

  it('带上引擎版本（规则会过期，必须有版本可依）', () => {
    expect(buildReminders('R1', 'any', 'ctpwa@abc1234').text).toContain('ctpwa@abc1234')
    expect(buildReminders('R1').text).not.toContain('引擎 ctpwa@')
  })

  it('漂移守卫：每条提醒的 skillRef 都能在 SKILL.md 里找到', () => {
    const skill = readFileSync(new URL('../skills/auto-pwa-analysis/SKILL.md', import.meta.url), 'utf8')
    for (const r of REMINDERS) {
      expect(skill.includes(r.skillRef), `${r.id} → ${r.skillRef} 在 SKILL.md 里找不到（章节被改名/删除了？）`).toBe(true)
    }
  })

  it('每条提醒都得短（控制 token：单条 ≤ 70 字）', () => {
    for (const r of REMINDERS) expect(r.text.length, r.id).toBeLessThanOrEqual(70)
  })
})
