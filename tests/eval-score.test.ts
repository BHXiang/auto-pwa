import { describe, expect, it } from 'vitest'
import { aggregate, parseMoves, rejectedNamesOf, scoreAll, scoreOne, type AnswerRecord, type Probe } from '../src/eval-score.js'
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
