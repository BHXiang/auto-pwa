import { describe, expect, it } from 'vitest'
import { renderIndex, renderReport, renderNotes, type IterationRecord } from '../src/report.js'

const record: IterationRecord = {
  iter: 1,
  timestamp: '2026-08-18T21:30:00+08:00',
  title: '添加 rho(1450) 到 R_KK [1-]',
  kind: 'added',
  configPath: 'iter-001/config.yml',
  iterDir: 'iterations/iter-001',
  nll: -18635.9,
  deltaNll: -12.4,
  hessianPositive: true,
  changes: ['decay1.R_KK [1-] += rho1450', 'Resonances.rho1450 = BWR [1.465,0.4] free=[0,1]'],
  warnings: ['crowded-group: [1-] already has 6 members'],
  floatDecision: 'free=[0,1]',
  notes: ['validate: 0 errors', 'ΔNLL = -12.4 → **5.0σ**，显著'],
}

describe('report rendering', () => {
  it('index page lists one row per iteration sorted by iter', () => {
    const html = renderIndex([record, { ...record, iter: 0, title: '基线' }])
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('分波迭代日记')
    // row order: iter 0 first
    expect(html.indexOf('>0</td>')).toBeLessThan(html.indexOf('>1</td>'))
    expect(html).toContain('iter-001/report.html')
  })

  it('report page escapes model text and renders markdown subset', () => {
    const html = renderReport(record)
    expect(html).toContain('第 1 轮 · 加共振态')
    expect(html).toContain('<strong>5.0σ</strong>') // bold markdown
    const hostile: IterationRecord = { ...record, title: '<script>alert(1)</script>' }
    const hostileHtml = renderReport(hostile)
    expect(hostileHtml).not.toContain('<script>alert(1)</script>')
    expect(hostileHtml).toContain('&lt;script&gt;')
  })

  it('renders notes with lists and code blocks', () => {
    const html = renderNotes(['- item one', '- item two', '```', 'nll = -18635.9', '```', 'plain text'])
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>item one</li>')
    expect(html).toContain('<pre>nll = -18635.9</pre>')
    expect(html).toContain('<p>plain text</p>')
  })

  it('ΔNLL coloring: improvement green, worsening red', () => {
    const good = renderReport({ ...record, deltaNll: -12.4 })
    expect(good).toContain('delta good')
    const bad = renderReport({ ...record, deltaNll: 5.1 })
    expect(bad).toContain('delta bad')
  })
})
