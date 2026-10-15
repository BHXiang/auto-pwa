import { describe, expect, it } from 'vitest'
import { aggregate, attributionMarkdown, parseMoves, rejectedNamesOf, scoreAll, scoreOne, type AnswerRecord, type Probe } from '../src/eval-score.js'
import type { IterationRecord } from '../src/report.js'

const p = (over: Partial<Probe>): Probe => ({
  id: 'a/current-state/iter-009',
  analysis: 'a',
  category: 'current-state',
  question: 'q',
  answer: 'iter-009',
  truth: { baseIter: 9, naive: { maxIter: 17, lastRecordWithNll: 17, lastTextualMention: 9 }, naiveAgrees: false },
  judge: 'exact',
  ...over,
})

describe('parseMoves', () => {
  it('accepts English, sign form, Chinese verbs and JSON arrays', () => {
    expect([...parseMoves('["add:X2200","remove:N1700"]')].sort()).toEqual(['add:X2200', 'remove:N1700'])
    expect([...parseMoves('add: X2200 和 remove: N1700')].sort()).toEqual(['add:X2200', 'remove:N1700'])
    expect([...parseMoves('+X2200 -N1700')].sort()).toEqual(['add:X2200', 'remove:N1700'])
    expect([...parseMoves('加 X2200，删 N1700')].sort()).toEqual(['add:X2200', 'remove:N1700'])
    expect(parseMoves('不确定').size).toBe(0)
  })
})

describe('scoreOne', () => {
  it('current-state：接受 iter-009 / 009 / 9 三种写法', () => {
    for (const a of ['iter-009', '009', '9', '答案是 iter-9']) {
      expect(scoreOne(p({}), { id: 'x', answer: a }).correct, a).toBe(true)
    }
    expect(scoreOne(p({}), { id: 'x', answer: 'iter-017' }).correct).toBe(false)
  })

  it('tried-before / abstention：三态与"没试过"分开判', () => {
    const tried = p({ id: 'a/tried-before/X', category: 'tried-before', truth: { verdict: 'added-then-removed' } })
    expect(scoreOne(tried, { id: 'x', answer: 'added-then-removed' }).correct).toBe(true)
    expect(scoreOne(tried, { id: 'x', answer: 'touched' }).correct).toBe(false)
    const abst = p({ id: 'a/abstention/f0_2020', category: 'abstention', answer: '没试过', truth: { verdict: 'never' } })
    expect(scoreOne(abst, { id: 'x', answer: '没试过' }).correct).toBe(true)
    // 幻觉出一次尝试 = 错（这正是 abstention 要抓的）
    expect(scoreOne(abst, { id: 'x', answer: '试过，ΔNLL=+3' }).correct).toBe(false)
  })

  it('comparability：按 truth.reasons 判该不该说"不可比"', () => {
    const notComparable = p({ id: 'a/comparability/iter-014', category: 'comparability', answer: '不可比（config-changed）', truth: { reasons: ['config-changed'] } })
    expect(scoreOne(notComparable, { id: 'x', answer: '不可比：配置变了' }).correct).toBe(true)
    expect(scoreOne(notComparable, { id: 'x', answer: '可比' }).correct).toBe(false)
    const comparable = p({ id: 'a/comparability/iter-003', category: 'comparability', answer: '可比', truth: { reasons: [] } })
    expect(scoreOne(comparable, { id: 'x', answer: '可比' }).correct).toBe(true)
  })

  it('next-step：集合重合 + 重复率（落在已否决集里）', () => {
    const ns = p({
      id: 'a/next-step/iter-011',
      category: 'next-step',
      answer: ['add:X2200'],
      truth: { moves: [{ op: 'add', name: 'X2200' }], deltaNll: -10 },
    })
    expect(scoreOne(ns, { id: 'x', answer: '["add:X2200"]' }).correct).toBe(true)
    const partial = scoreOne(ns, { id: 'x', answer: '["add:X2200","add:N1700"]' })
    expect(partial.correct).toBe(false)
    expect(partial.overlap).toBeCloseTo(0.5)
    const rep = scoreOne(ns, { id: 'x', answer: '["add:X2200"]' }, new Set(['X2200']))
    expect(rep.repeated).toBe(true)
  })
})

describe('rejectedNamesOf', () => {
  it('从 removed 轮与"被拒/回退"标题里折出已否决名字', () => {
    const recs: IterationRecord[] = [
      { iter: 11, kind: 'removed', title: 'iter-011：X2450 被数据拒绝', changes: ['R [0-] += X2450'] },
      { iter: 9, kind: 'added', title: 'iter-009：正常轮次', changes: ['R [0-] += X2700'] },
    ]
    const rej = rejectedNamesOf(recs)
    expect(rej.has('X2450')).toBe(true)
    expect(rej.has('X2700')).toBe(false)
  })
})

describe('aggregate：pass^k 与成本', () => {
  const probes = [p({}), p({ id: 'a/current-state/iter-011', truth: { baseIter: 9, naive: { maxIter: 11 }, naiveAgrees: false } })]
  it('k 次全对才算 pass^k；token 入账', () => {
    const answers: AnswerRecord[] = [
      { id: probes[0]!.id, arm: 'M1', run: 0, answer: 'iter-009', tokensIn: 900 },
      { id: probes[0]!.id, arm: 'M1', run: 1, answer: 'iter-009', tokensIn: 900 },
      { id: probes[1]!.id, arm: 'M1', run: 0, answer: 'iter-009', tokensIn: 900 },
      { id: probes[1]!.id, arm: 'M1', run: 1, answer: 'iter-011', tokensIn: 900 },
    ]
    const scores = answers.map((a) => scoreOne(probes.find((x) => x.id === a.id)!, a))
    const [m] = aggregate(scores, answers)
    expect(m!.n).toBe(4)
    expect(m!.accuracy).toBe(0.75)
    expect(m!.passK).toBe(0.5) // 探针 0 两次全对、探针 1 有一次错
    expect(m!.passKValue).toBe(2)
    expect(m!.meanTokensIn).toBe(900)
  })
})

describe('scoreAll：上下界', () => {
  it('真值答案 = 100%；naive"取最新一轮"在 current-state 上很低', () => {
    const probes = [
      p({}),
      p({ id: 'a/current-state/iter-012', truth: { baseIter: 9, naive: { maxIter: 12 }, naiveAgrees: false } }),
      p({ id: 'a/tried-before/X', category: 'tried-before', truth: { verdict: 'never' } }),
    ]
    const truth: AnswerRecord[] = [
      { id: probes[0]!.id, arm: 'truth', answer: 'iter-009' },
      { id: probes[1]!.id, arm: 'truth', answer: 'iter-009' },
      { id: probes[2]!.id, arm: 'truth', answer: 'never' },
    ]
    const naiveAns: AnswerRecord[] = [
      { id: probes[0]!.id, arm: 'naive', answer: 'iter-017' },
      { id: probes[1]!.id, arm: 'naive', answer: 'iter-012' },
      { id: probes[2]!.id, arm: 'naive', answer: 'touched' },
    ]
    const { metrics, markdown } = scoreAll(probes, [...truth, ...naiveAns])
    const truthM = metrics.find((m) => m.arm === 'truth')!
    const naiveM = metrics.find((m) => m.arm === 'naive')!
    expect(truthM.accuracy).toBe(1)
    expect(naiveM.accuracy).toBe(0)
    expect(markdown).toContain('| truth |')
    expect(markdown).toContain('current-state')
  })
})

describe('E4 诊断量：Pass@B / P90R / p_wrong·p_exh / breakdown onset', () => {
  const probes = [p({}), p({ id: 'a/current-state/iter-011', truth: { baseIter: 9, naive: { maxIter: 11 }, naiveAgrees: false } })]

  it('按预算 B 判 Pass@B，并把失败分成 p_wrong 与 p_exh', () => {
    const answers: AnswerRecord[] = [
      { id: probes[0]!.id, arm: 'M2', answer: 'iter-009', memoryCalls: 1 }, // 对，预算内
      { id: probes[1]!.id, arm: 'M2', answer: 'iter-011', memoryCalls: 1 }, // 错，预算内
      { id: probes[1]!.id, arm: 'M2', answer: 'iter-009', memoryCalls: 5 }, // 对，超预算
    ]
    const scores = answers.map((a) => scoreOne(probes.find((x) => x.id === a.id)!, a))
    const [m] = aggregate(scores, answers, { budgetB: 2 })
    expect(m!.budgetB).toBe(2)
    expect(m!.passAtB).toBeCloseTo(1 / 3) // 只有第一条同时满足"对 + 预算内"
    expect(m!.pWrong).toBeCloseTo(1 / 3)
    expect(m!.pExh).toBeCloseTo(1 / 3)
    // 3 个样本 [1,1,5] 的线性插值 P90 = 4.2（不是 max；这正是「看尾部」的含义）
    expect(m!.p90R).toBeCloseTo(4.2)
  })

  it('规模梯：准确率跌破阈值时给出 breakdown onset', () => {
    const answers: AnswerRecord[] = []
    for (const sc of [0, 5, 50, 200]) {
      answers.push({ id: probes[0]!.id, arm: 'M2', scale: sc, answer: sc <= 5 ? 'iter-009' : 'iter-017' })
    }
    const scores = answers.map((a) => scoreOne(probes[0]!, a))
    const [m] = aggregate(scores, answers, { onsetThreshold: 0.7 })
    expect(m!.breakdownOnset).toBe(50)
    expect(m!.byScale!['5']!.accuracy).toBe(1)
    expect(m!.byScale!['200']!.accuracy).toBe(0)
  })

  it('attribution 表带规模梯子表', () => {
    const md = attributionMarkdown([
      {
        arm: 'M2',
        n: 2,
        correct: 1,
        accuracy: 0.5,
        tokensInTotal: 0,
        tokensOutTotal: 0,
        byCategory: {},
        byAnalysis: {},
        byScale: { '0': { n: 1, correct: 1, accuracy: 1 }, '50': { n: 1, correct: 0, accuracy: 0 } },
        breakdownOnset: 50,
      },
    ])
    expect(md).toContain('规模梯')
    expect(md).toContain('Pass@B')
    expect(md).toContain('| M2 | 50 | 1 | 0.0% |')
  })
})

describe('判定类联合准确率（防"永远说没试过"刷分）', () => {
  it('abstention 满分 + tried-before 零分 → 联合只有一半', () => {
    const probes = [
      p({ id: 'a/tried-before/X', category: 'tried-before', truth: { verdict: 'touched' } }),
      p({ id: 'a/abstention/Y', category: 'abstention', answer: '没试过', truth: { verdict: 'never' } }),
    ]
    const answers: AnswerRecord[] = [
      { id: 'a/tried-before/X', arm: 'M0', answer: 'never' }, // 零记忆的保守默认 → 错
      { id: 'a/abstention/Y', arm: 'M0', answer: '没试过' }, // 恰好是 abstention 的真值 → 对
    ]
    const scores = answers.map((a) => scoreOne(probes.find((x) => x.id === a.id)!, a))
    const [m] = aggregate(scores, answers)
    expect(m!.byCategory['abstention']!.correct / m!.byCategory['abstention']!.n).toBe(1)
    expect(m!.byCategory['tried-before']!.correct / m!.byCategory['tried-before']!.n).toBe(0)
    expect(m!.verdictAccuracy).toBeCloseTo(0.5)
    expect(m!.verdictN).toBe(2)
  })
})

describe('round-reference（"本轮与哪一轮比"，插件 previousDiaryNll 语义）', () => {
  it('可算时比对轮次；上一条无 NLL 时必须答"无法计算"', () => {
    const computable = p({
      id: 'a/round-reference/iter-014',
      category: 'round-reference',
      answer: 'iter-013',
      truth: { prevIter: 13, prevNll: -3944.9, computable: true },
    })
    expect(scoreOne(computable, { id: 'x', answer: 'iter-013' }).correct).toBe(true)
    expect(scoreOne(computable, { id: 'x', answer: '上一轮 iter-014' }).correct).toBe(false)

    const notComputable = p({
      id: 'a/round-reference/iter-006',
      category: 'round-reference',
      answer: '无法计算（上一条记录无 NLL）',
      truth: { prevIter: 5, prevNll: null, computable: false },
    })
    expect(scoreOne(notComputable, { id: 'x', answer: '无法计算（上一条记录无 NLL）' }).correct).toBe(true)
    // 编一个轮次 = 错（这正是"ΔNLL 其实算不出来"要被抓住的地方）
    expect(scoreOne(notComputable, { id: 'x', answer: 'iter-005' }).correct).toBe(false)
  })
})

describe('近名陷阱单列（词形混淆不混进记忆失败）', () => {
  it('alias 组与 clean 组分开统计', () => {
    const probes = [
      p({ id: 'a/abstention/K2*_1430', category: 'abstention', answer: '没试过', truth: { verdict: 'never', aliasOf: 'K2_1430' } }),
      p({ id: 'a/abstention/f0_2020', category: 'abstention', answer: '没试过', truth: { verdict: 'never' } }),
    ]
    const answers: AnswerRecord[] = [
      { id: 'a/abstention/K2*_1430', arm: 'M2', answer: '试过（K2_1430）' }, // 被近名骗了
      { id: 'a/abstention/f0_2020', arm: 'M2', answer: '没试过' }, // 干净题答对
    ]
    const scores = answers.map((a) => scoreOne(probes.find((x) => x.id === a.id)!, a))
    const [m] = aggregate(scores, answers)
    expect(m!.byAlias!.alias).toEqual({ n: 1, correct: 0 })
    expect(m!.byAlias!.clean).toEqual({ n: 1, correct: 1 })
    expect(attributionMarkdown([m!])).toContain('近名陷阱')
  })
})

describe('记法变体（alias）类：真值是本体名的判定，不是"没试过"', () => {
  it('K2*_1430 在日记里以 K2_1430 出现 → 真值 touched', () => {
    const probe = p({
      id: 'a/alias/K2*_1430',
      category: 'alias',
      answer: 'touched',
      truth: { aliasOf: 'K2_1430', verdict: 'touched', note: '记法变体' },
    })
    expect(scoreOne(probe, { id: 'x', answer: 'touched' }).correct).toBe(true)
    // 按"没试过"作答 = 错（这正是修掉的那个真值 bug）
    expect(scoreOne(probe, { id: 'x', answer: '没试过' }).correct).toBe(false)
  })
})
