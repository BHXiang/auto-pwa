import { describe, expect, it } from 'vitest'
import { buildStateDigest } from '../src/state-digest.js'
import type { IterationRecord } from '../src/report.js'

const RECS: IterationRecord[] = [
  { iter: 9, kind: 'added', title: 'iter-009：再加有效 0-+ 成分 X(2700)', conclusion: 'iter-010 已证伪 → 回退基线到 iter-009', nll: -1759.42, nextPlan: '试 X2200' },
  { iter: 11, kind: 'removed', title: 'iter-011：X(2450) 被数据拒绝', nll: -1432.39, deltaNll: 327.03 },
  { iter: 17, kind: 'removed', title: 'iter-017：显著性删减测试', nll: -1722.5, deltaNll: -13.9, nextPlan: '给 N1700/N2120 找依据' },
]

describe('buildStateDigest', () => {
  it('returns empty string with no records（"不注入"必须是合法结果）', () => {
    expect(buildStateDigest({ analysisRoot: '/x', records: [] })).toBe('')
  })

  it('folds the comparison baseline and warns when "latest round" would answer differently', () => {
    const txt = buildStateDigest({ analysisRoot: '/pwa/chic2ppeta', records: RECS })
    expect(txt).toContain('<system-reminder>')
    expect(txt).toContain('分析目录: /pwa/chic2ppeta')
    expect(txt).toContain('ΔNLL 比对基线: iter-009')
    // 关键：点出 naive 会答错（实测 28/31 个 round）
    expect(txt).toContain('取最新一轮')
    expect(txt).toContain('iter-017')
    // 最后带 NLL 的记录与"最新一轮"不是一回事
    expect(txt).toContain('最后带 NLL **字段**的记录: iter-017')
    expect(txt).toContain('已否决/回退')
    expect(txt).toContain('上轮计划: 给 N1700/N2120 找依据')
  })

  it('carries the noise floor warning and the best-NLL round', () => {
    const txt = buildStateDigest({
      analysisRoot: '/x',
      records: RECS,
      noise: { iter: 17, nRuns: 10, spread: 8123 },
    })
    expect(txt).toContain('噪声地板')
    expect(txt).toContain('8123')
    expect(txt).toContain('不可信')
    // NLL 最低的一轮 = iter-009（-1759.42 < -1722.5）
    expect(txt).toContain('NLL 最低的一轮: iter-009')
  })

  it('flags a NLL that only exists in the conclusion text（实测 chicj2KKeta iter-016）', () => {
    const txt = buildStateDigest({
      analysisRoot: '/x',
      records: [
        { iter: 14, kind: 'other', title: '引擎基线复拟合', nll: -3884.57 },
        { iter: 16, kind: 'added', title: 'ONE 试探晋级', conclusion: '最佳 NLL=-3954.88，ΔNLL=-67~-70，显著且稳健复现' },
      ],
    })
    expect(txt).toContain('最后带 NLL **字段**的记录: iter-014')
    expect(txt).toContain('只在结论文本里（-3954.88）')
    expect(txt).toContain('建议 auto_pwa_note 写结构化 nll')
  })

  it('reports an unknown baseline instead of inventing one', () => {
    const txt = buildStateDigest({ analysisRoot: '/x', records: [{ iter: 3, kind: 'added', title: '加 K1_1410', nll: -120 }] })
    expect(txt).toContain('ΔNLL 比对基线: 未知')
    expect(txt).not.toContain('取最新一轮')
  })

  it('shows the pending prediction and loop phase when available', () => {
    const txt = buildStateDigest({
      analysisRoot: '/x',
      records: RECS,
      loopState: { phase: 'propose', iter: 17, pendingPrediction: { hypothesis: 'X2200 吸收 0-+ 区' } },
    })
    expect(txt).toContain('未决预测: X2200 吸收 0-+ 区')
    expect(txt).toContain('循环阶段: propose（iter-017）')
  })
})
