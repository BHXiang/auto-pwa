import { describe, expect, it } from 'vitest'
import { modelBaselineFold, naiveAnswers, parseTouchEvents, touchTimeline, triedBefore } from '../src/memory-fold.js'
import type { IterationRecord } from '../src/report.js'

/** 真实日记片段（chic2ppeta）——模型基线是 iter-009，但"基座 iter-016" 出现在 iter-017 的结论里。 */
const CHIC2PPETA: IterationRecord[] = [
  { iter: 1, kind: 'added', title: 'iter-001 基线构建', conclusion: 'iter-000 是退化基线；NLL=-1206.6' },
  {
    iter: 9,
    kind: 'added',
    title: 'iter-009：再加有效 0-+ 成分 X(2700)',
    conclusion: 'iter-010（加 N(1675)/N(1680) 5/2 态）已证伪：NLL 退到 -1561 → 回退基线到 iter-009',
    nll: -1759.42,
  },
  { iter: 11, kind: 'removed', title: 'iter-011：第三个 0-+ 成分 X(2450) 被数据拒绝', conclusion: '回退 iter-009', changes: ['R_ppbar [0-] += X2450 (BW 2.45/0.15)'], nll: -1432.39 },
  { iter: 12, kind: 'removed', title: 'iter-012：加 N(1440) 被拒', conclusion: '基线仍 iter-009', nll: -1686.28 },
  {
    iter: 13,
    kind: 'removed',
    title: 'iter-013：有效 2-+ 成分被强拒',
    conclusion: 'iter-009 仍为最佳基线',
    nextPlan: '末轮尝试：以 iter-006 为基座、按 iter-009 找到的解收紧两个有效 0-+ 成分的 free_range',
    nll: -1322.58,
  },
  {
    iter: 14,
    kind: 'float',
    title: 'iter-014：收紧有效 0-+ 区间',
    changes: [
      '以 iter-006 为基座重建 X2200 (free range 2.13-2.35 / 0.10-0.45, init 2.23/0.28)',
      '以 iter-006 为基座重建 X2700 (free range 2.62-2.86 / 0.02-0.20, init 2.76/0.06)',
    ],
    nll: -1761.74,
  },
  { iter: 15, kind: 'removed', title: 'iter-015：中间区间被拒 → 最终模型定为 iter-009', changes: ['以 iter-006 为基座重建 X2200（区间 2.15-2.32）'], nll: -1427.25 },
  {
    iter: 16,
    kind: 'removed',
    title: 'iter-016',
    changes: ['R_peta/R_pbareta [0.5-]/[0.5+] += N1535w（N(1535) 的质量/宽度浮动副本，独立耦合）'],
    nll: undefined,
  },
  {
    iter: 17,
    kind: 'removed',
    title: 'iter-017：显著性删减测试',
    conclusion: '(2) 单删 ΔNLL 表（基座 iter-016，NLL=−1708.61）：N1700 −97.0；把 N1700/N2120 从 iter-009 基座再删一次，ΔNLL 反号',
    changes: ['chain1.R_peta [1.5-] -= N1700（建议回退）', 'chain1.R_peta [0.5-] -= N1535w'],
    nll: -1722.5,
  },
]

/** 真实日记片段（KsKs）：连续三轮"回退到 iter-004 再挂下一个"，且"回退 iter-008 的实验"是撤销、不是目标。 */
const KSK: IterationRecord[] = [
  { iter: 4, kind: 'added', title: 'iter-004', nll: -1239.42 },
  { iter: 7, kind: 'added', title: 'iter-007 基座 = iter-004 config', conclusion: '删除 K3*_1780', changes: ['基座回退 iter-004（移除 chain2/chain3 [3-] K3*_1780）'], nll: -1239.416593 },
  {
    iter: 8,
    kind: 'added',
    title: 'iter-008',
    conclusion: '决策：回退到 iter-004 基座，改挂 K2^*_1980 [2⁺]',
    changes: ['基座 iter-004（回退 iter-007 的 K1_1650 实验）'],
    nll: -1239.416593,
  },
  { iter: 9, kind: 'added', title: 'iter-009', changes: ['基座 iter-004（回退 iter-008 的 K2*_1980 实验）'], nll: -1239.416593 },
  { iter: 10, kind: 'added', title: 'iter-010', changes: ['基座 iter-009（K2*_1430 保留但份额近零）'], nll: -1248.076461 },
  { iter: 11, kind: 'added', title: 'iter-011', changes: ['基座 iter-010（保留 NR1_Komega）'], nll: -1274.748797 },
]

/** 真实日记片段（chicj2KKeta）：iter-014 是新基线（引擎升级后复拟合）。 */
const CHICJ2KKETA: IterationRecord[] = [
  { iter: 2, kind: 'added', title: 'iter-002', nll: -3493.19 },
  { iter: 3, kind: 'other', title: '回滚 iter-003', conclusion: '回滚到 iter-002', nll: undefined },
  { iter: 5, kind: 'other', title: '回滚 iter-005', conclusion: '回退至 iter-004', nll: undefined },
  { iter: 9, kind: 'other', title: '回滚 iter-009', conclusion: '回退至 iter-008', nll: undefined },
  {
    iter: 14,
    kind: 'other',
    title: '引擎基线复拟合',
    conclusion: '新旧引擎 NLL 不可直接对比',
    nextPlan: '以 iter-014 为新基线裁决 6 个 ONE 试探',
    nll: -3884.565813,
  },
  { iter: 16, kind: 'added', title: 'ONE 试探晋级', conclusion: '相对新基线 iter-014(-3884.57) ΔNLL=-67~-70', nll: undefined },
]

describe('parseTouchEvents', () => {
  it('extracts += / -= names and ignores definition-only lines', () => {
    const evs = parseTouchEvents({
      iter: 6,
      kind: 'added',
      changes: ['chain2.R_Ks2omega new [3-] group += K3*_1780', 'Resonances.K3*_1780 = BWR [1.779,0.161] free=[0]'],
    })
    expect(evs.map((e) => `${e.op}:${e.name}`)).toEqual(['add:K3*_1780'])
    expect(evs[0]!.source).toBe('delta')
  })

  it('marks prose removals as low-confidence (source=prose)', () => {
    const evs = parseTouchEvents({ iter: 7, kind: 'added', changes: ['基座回退 iter-004（移除 chain2/chain3 [3-] K3*_1780）'] })
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ op: 'remove', name: 'K3*_1780', source: 'prose' })
  })
})

describe('touchTimeline（集合增量语义）', () => {
  it('does not inflate counts when every round restates the whole stack', () => {
    const recs: IterationRecord[] = [1, 2, 3, 4].map((n) => ({
      iter: n,
      kind: 'added' as const,
      title: `iter-00${n}`,
      changes: ['R_ppbar [0-] += X1835', ...(n >= 2 ? ['R_ppbar [0-] += NR_ppbar_0'] : [])],
    }))
    const tl = touchTimeline(recs)
    expect(tl.find((t) => t.name === 'X1835')!.newlyAt).toEqual([1])
    expect(tl.find((t) => t.name === 'NR_ppbar_0')!.newlyAt).toEqual([2])
  })
})

describe('triedBefore', () => {
  it('distinguishes never / touched / added-then-removed（严格模式 = 只认 delta）', () => {
    expect(triedBefore(CHIC2PPETA, 'f0_2020').verdict).toBe('never')
    // 严格模式：`重建 X2700` 是散文形态（没有 +=），按 delta-only 语义不算触碰。
    // 这个覆盖缺口必须显式记录，而不是假装能抽出来：
    expect(triedBefore(CHIC2PPETA, 'X2700').verdict).toBe('never')
    expect(triedBefore(CHIC2PPETA, 'X2700', { includeProse: true }).verdict).toBe('touched')
    expect(triedBefore(CHIC2PPETA, 'X2450').verdict).toBe('touched')
    expect(triedBefore(CHIC2PPETA, 'N1535w').verdict).toBe('added-then-removed')
  })
})

describe('modelBaselineFold', () => {
  it('folds chic2ppeta to iter-009 while two naive heuristics answer 17', () => {
    const fold = modelBaselineFold(CHIC2PPETA)
    expect(fold.baseIter).toBe(9)
    expect(fold.confidence).toBe('high')
    expect(fold.rule).toBe('final-model')
    // "以 iter-006 为基座" 是实验基座，不是模型基线
    expect(fold.experimentBases).toContainEqual({ iter: 14, baseIter: 6 })
    expect(fold.experimentBases).toContainEqual({ iter: 15, baseIter: 6 })
    // 关键：两个 naive 启发式都会答错
    const naive = naiveAnswers(CHIC2PPETA)
    expect(naive.maxIter).toBe(17)
    expect(naive.lastRecordWithNll).toBe(17)
    expect(fold.baseIter).toBe(9)
  })

  it('handles the KsKs "回退 iter-008 的实验" trap（撤销 ≠ 目标）', () => {
    const fold = modelBaselineFold(KSK)
    expect(fold.baseIter).toBe(10)
    expect(fold.steps.map((s) => `${s.iter}:${s.rule}->${s.baseIter}`)).toEqual([
      '7:rollback-base-first->4',
      '8:rollback-target->4',
      '9:base-of-change->4',
      '10:base-of-change->9',
      '11:base-of-change->10',
    ])
  })

  it('picks up "以 iter-014 为新基线" in chicj2KKeta', () => {
    const fold = modelBaselineFold(CHICJ2KKETA)
    expect(fold.baseIter).toBe(14)
    expect(fold.confidence).toBe('high')
  })

  it('is the right tool for "state at step k" probes (untilIter)', () => {
    expect(modelBaselineFold(CHIC2PPETA, 8).baseIter).toBeNull()
    expect(modelBaselineFold(CHIC2PPETA, 8).confidence).toBe('none')
    expect(modelBaselineFold(CHIC2PPETA, 9).baseIter).toBe(9)
    expect(modelBaselineFold(CHIC2PPETA, 12).baseIter).toBe(9)
    // 基线之后出现的触碰事件是"当前模型 = base + pendingEdits"的候选
    const fold = modelBaselineFold(CHIC2PPETA, 17)
    expect(fold.pendingEdits.some((e) => e.name === 'N1535w' && !e.advisory)).toBe(true)
    expect(fold.pendingEdits.some((e) => e.name === 'N1700' && e.advisory)).toBe(true)
  })
})

describe('因果守卫：丢掉"未来引用"', () => {
  it('记录里引用比自己更晚的 iter 时必须忽略（实测 chicj2KKeta iter-008 写了"回滚 iter-009"）', () => {
    const recs: IterationRecord[] = [
      { iter: 5, kind: 'other', title: '回滚 iter-005', conclusion: '回退至 iter-004', nll: undefined },
      {
        iter: 8,
        kind: 'added',
        title: 'iter-008：继续压 mKK 高能区',
        conclusion: 'f0_2020 测试中 ΔNLL -2.7 不显著，回滚 iter-009）与 Kη 中段',
        nll: -3702.67,
      },
    ]
    const fold = modelBaselineFold(recs)
    // 若不做守卫会得到 9（时间上不可能：第 8 轮不可能以第 9 轮为基线）
    expect(fold.baseIter).toBe(4)
    expect(fold.forwardRefs).toContainEqual({ iter: 8, ref: 9, rule: 'rollback-bare' })
    // 分轮：第 8 轮时应仍是 iter-004
    expect(modelBaselineFold(recs, 8).baseIter).toBe(4)
  })
})
