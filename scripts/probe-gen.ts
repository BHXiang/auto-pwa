#!/usr/bin/env tsx
/**
 * P0：把真实分析目录固化成**可代码判分**的探针集，并标定拟合噪声。
 *
 * 零功能改动：**只读**分析目录；产物写到 `probe-out/`（已在 .gitignore 里）。
 *
 *   npx tsx scripts/probe-gen.ts [--out probe-out] <analysisDir> [...]
 *
 * 产物：
 *   probes.jsonl        一行一个探针（question / answer / truth / judge）
 *   noise.json          每个迭代的 per-run NLL 离散度 + 每个分析的小结
 *   fold-report.json    modelBaselineFold 的步骤/实验基座/naive 对照与分歧
 *
 * 设计要点（对应 docs/memory-system-design-and-eval.md §5.1/§5.6）：
 *   - 真值**全部由代码复算**（fold / 触碰时间线 / provenance 比对），不用 LLM 打分；
 *   - `abstention` 探针用的是"**别的分析试过、本分析从没试过**"的名字——顺带就是
 *     跨项目污染（串味）的对照；
 *   - 覆盖缺口显式记入 `truth.coverage`（例如 `重建 X` 是散文形态、严格模式不算触碰）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { modelBaselineFold, naiveAnswers, touchTimeline, triedBefore } from '../src/memory-fold.js'
import { parseFitJson } from '../src/fit-summary.js'
import { readProvenance } from '../src/provenance.js'
import type { IterationRecord } from '../src/report.js'

type Category = 'current-state' | 'tried-before' | 'repeat' | 'abstention' | 'next-step' | 'comparability'

interface Probe {
  id: string
  analysis: string
  category: Category
  question: string
  answer: string | number | string[] | null
  truth: Record<string, unknown>
  judge: 'exact' | 'code'
  contextUpToIter?: number
}

interface Analysis {
  name: string
  dir: string
  records: IterationRecord[]
  iterDirs: { iter: number; dir: string }[]
}

/** 读 SUMMARY.jsonl（坏行跳过——实测有 6 条记录 nll=null，不是错）。 */
function readDiary(analysisDir: string): IterationRecord[] {
  const p = join(analysisDir, 'iterations', 'SUMMARY.jsonl')
  if (!existsSync(p)) return []
  const out: IterationRecord[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      out.push(JSON.parse(t) as IterationRecord)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.sort((a, b) => a.iter - b.iter)
}

function listIterDirs(analysisDir: string): { iter: number; dir: string }[] {
  const root = join(analysisDir, 'iterations')
  if (!existsSync(root)) return []
  const out: { iter: number; dir: string }[] = []
  for (const name of readdirSync(root)) {
    const m = /^iter-(\d+)$/.exec(name)
    if (m !== null) out.push({ iter: Number(m[1]), dir: join(root, name) })
  }
  return out.sort((a, b) => a.iter - b.iter)
}

function loadAnalysis(dir: string): Analysis {
  const abs = resolve(dir)
  return { name: basename(abs), dir: abs, records: readDiary(abs), iterDirs: listIterDirs(abs) }
}

// ---------------------------------------------------------------------------
// 噪声：per-run NLL 离散度（"先标定噪声，否则一切结论不成立"）
// ---------------------------------------------------------------------------

interface NoiseRow {
  iter: number
  nRuns: number
  best: number | null
  worst: number | null
  spread: number | null
  bestIsPD: boolean | null
  source: 'fit.json' | 'none'
}

function noiseOf(a: Analysis): NoiseRow[] {
  const rows: NoiseRow[] = []
  for (const { iter, dir } of a.iterDirs) {
    const fitPath = join(dir, 'results', 'fit.json')
    if (!existsSync(fitPath)) {
      rows.push({ iter, nRuns: 0, best: null, worst: null, spread: null, bestIsPD: null, source: 'none' })
      continue
    }
    const view = parseFitJson(readFileSync(fitPath, 'utf8'))
    const summaries = view.fit?.runSummaries ?? []
    const nlls = summaries.map((r) => r.nll).filter((n): n is number => typeof n === 'number')
    if (nlls.length === 0) {
      rows.push({ iter, nRuns: 0, best: null, worst: null, spread: null, bestIsPD: null, source: 'none' })
      continue
    }
    const best = Math.min(...nlls)
    const worst = Math.max(...nlls)
    const bestRun = summaries.find((r) => r.nll === best)
    rows.push({
      iter,
      nRuns: nlls.length,
      best,
      worst,
      spread: worst - best,
      bestIsPD: bestRun?.positiveDefinite ?? null,
      source: 'fit.json',
    })
  }
  return rows
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? ((s[mid - 1]! + s[mid]!) / 2) : s[mid]!
}

// ---------------------------------------------------------------------------
// 探针生成
// ---------------------------------------------------------------------------

function probesFor(a: Analysis, foreignNames: Set<string>): { probes: Probe[]; fold: ReturnType<typeof modelBaselineFold> } {
  const probes: Probe[] = []
  const push = (p: Probe): void => {
    probes.push(p)
  }

  // ① current-state：第 k 轮结束时的**比对基线**（真值 = fold）。
  //    注意语义：fold 答的是"ΔNLL 的参照基线"，不是"当前最优模型"。后者用
  //    `bestNllIter`（argmin NLL，纯代码可判）单独给出——两者在 chicj2KKeta 里
  //    分别是 14 与 16，必须分开问，否则会把一个歧义当成一个答案。
  const bestNllIter = a.records.reduce<number | null>((best, r) => {
    if (typeof r.nll !== 'number') return best
    if (best === null) return r.iter
    const bestRec = a.records.find((x) => x.iter === best)
    return typeof bestRec?.nll === 'number' && bestRec.nll <= r.nll ? best : r.iter
  }, null)
  for (const rec of a.records) {
    const fold = modelBaselineFold(a.records, rec.iter)
    if (fold.confidence === 'none' || fold.baseIter === null) continue
    const naive = naiveAnswers(a.records, rec.iter)
    const bestSoFar = a.records.reduce<number | null>((best, r) => {
      if (r.iter > rec.iter || typeof r.nll !== 'number') return best
      if (best === null) return r.iter
      const bestRec = a.records.find((x) => x.iter === best)
      return typeof bestRec?.nll === 'number' && bestRec.nll <= r.nll ? best : r.iter
    }, null)
    push({
      id: `${a.name}/current-state/iter-${String(rec.iter).padStart(3, '0')}`,
      analysis: a.name,
      category: 'current-state',
      question: `截至 iter-${String(rec.iter).padStart(3, '0')} 结束，ΔNLL 的**比对基线**是哪一轮？（不是"当前最优模型"）`,
      answer: `iter-${String(fold.baseIter).padStart(3, '0')}`,
      truth: {
        baseIter: fold.baseIter,
        rule: fold.rule,
        confidence: fold.confidence,
        steps: fold.steps.length,
        /** 另一个语义："当前最优模型"= 到目前为止 NLL 最小的一轮（纯代码可判）。 */
        bestNllIter: bestSoFar,
        naive: { maxIter: naive.maxIter, lastRecordWithNll: naive.lastRecordWithNll, lastTextualMention: naive.lastTextualMention },
        naiveAgrees: naive.maxIter === fold.baseIter,
      },
      judge: 'exact',
      contextUpToIter: rec.iter,
    })
  }
  void bestNllIter

  // ② tried-before / repeat / abstention：名字层面（严格模式：只认 += / -=）
  const timeline = touchTimeline(a.records)
  const foldAll = modelBaselineFold(a.records)
  for (const tl of timeline) {
    const t = triedBefore(a.records, tl.name)
    push({
      id: `${a.name}/tried-before/${tl.name}`,
      analysis: a.name,
      category: 'tried-before',
      question: `${a.name} 分析里试过 ${tl.name} 吗？结果如何？`,
      answer: t.verdict,
      truth: { verdict: t.verdict, iters: tl.events.map((e) => e.iter), ops: tl.events.map((e) => `${e.op}@${e.iter}`) },
      judge: 'code',
    })
    if (tl.newlyAt.length >= 2) {
      push({
        id: `${a.name}/repeat/${tl.name}`,
        analysis: a.name,
        category: 'repeat',
        question: `${tl.name} 在 ${a.name} 里一共被"新触碰"过几轮？`,
        answer: tl.newlyAt.length,
        truth: { newlyAt: tl.newlyAt, definition: '集合增量：相对上一轮新增才算一次（避免每轮重述全栈导致虚高）' },
        judge: 'exact',
      })
    }
  }
  // abstention：本分析从没碰过、但别的分析碰过的名字（同时是串味对照）。
  // 每个分析**限量**取前 12 个，避免"从没试过"类问题淹没其它类别。
  const own = new Set(timeline.map((t) => t.name))
  for (const name of [...foreignNames].filter((n) => !own.has(n)).sort().slice(0, 12)) {
    push({
      id: `${a.name}/abstention/${name}`,
      analysis: a.name,
      category: 'abstention',
      question: `${a.name} 分析里试过 ${name} 吗？`,
      answer: '没试过',
      truth: { verdict: 'never', note: '该名字出现在别的分析里 —— 正确行为是答"本分析没试过"，不是照搬' },
      judge: 'code',
    })
  }

  // ③ next-step（E2 回放题）：真值 = 该轮**实际新动的东西** + 实际 ΔNLL。
  //    只取"本轮新触碰"的名字（集合增量）——chic2ppeta 的 changes 每轮重述全栈，
  //    若按"本轮出现过的所有事件"会把整栈当成本轮动作。
  for (const rec of a.records) {
    if (rec.kind !== 'added' && rec.kind !== 'removed') continue
    const moves: { op: string; name: string }[] = []
    for (const tl of timeline) {
      if (!tl.newlyAt.includes(rec.iter)) continue
      for (const e of tl.events) if (e.iter === rec.iter && e.source === 'delta') moves.push({ op: e.op, name: e.name })
    }
    if (moves.length === 0) continue
    const prev = [...a.records].filter((r) => r.iter < rec.iter && typeof r.nll === 'number').pop()
    const deltaNll = typeof rec.nll === 'number' && prev !== undefined && typeof prev.nll === 'number' ? rec.nll - prev.nll : null
    push({
      id: `${a.name}/next-step/iter-${String(rec.iter).padStart(3, '0')}`,
      analysis: a.name,
      category: 'next-step',
      question: `第 iter-${String(rec.iter).padStart(3, '0')} 轮该动什么？`,
      answer: moves.map((m) => `${m.op}:${m.name}`),
      truth: { moves, deltaNll, nll: rec.nll ?? null, kind: rec.kind, definition: 'moves = 本轮新触碰（集合增量，delta 来源）' },
      judge: 'code',
      contextUpToIter: rec.iter - 1,
    })
  }

  // ④ comparability：连续两轮都留下 provenance.json 时，比对"能不能直接比 ΔNLL"
  for (let i = 1; i < a.iterDirs.length; i++) {
    const prevDir = a.iterDirs[i - 1]!.dir
    const cur = a.iterDirs[i]!
    const p = readProvenance(prevDir)
    const c = readProvenance(cur.dir)
    if (p === undefined || c === undefined) continue
    const reasons: string[] = []
    if (p.configMd5 !== c.configMd5) reasons.push('config-changed')
    if ((p.scriptArgs ?? []).join(' ') !== (c.scriptArgs ?? []).join(' ')) reasons.push('run-settings-changed')
    if (p.init.source !== c.init.source || p.init.seed !== c.init.seed) reasons.push('init-source-changed')
    push({
      id: `${a.name}/comparability/iter-${String(cur.iter).padStart(3, '0')}`,
      analysis: a.name,
      category: 'comparability',
      question: `iter-${String(cur.iter).padStart(3, '0')} 的最佳 NLL 能与上一轮直接比 ΔNLL 吗？`,
      answer: reasons.length === 0 ? '可比' : `不可比（${reasons.join(',')}）`,
      truth: {
        reasons,
        prev: { iter: a.iterDirs[i - 1]!.iter, md5: p.configMd5, args: p.scriptArgs ?? [], init: p.init.source, seed: p.init.seed ?? null },
        cur: { iter: cur.iter, md5: c.configMd5, args: c.scriptArgs ?? [], init: c.init.source, seed: c.init.seed ?? null },
        engine: 'unknown —— provenance 尚无 engine 字段（S1 已能写 Pwa-Engine，待回填）',
      },
      judge: 'code',
    })
  }

  return { probes, fold: foldAll }
}

// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2)
  const outIdx = argv.indexOf('--out')
  const outDir = resolve(outIdx >= 0 ? (argv[outIdx + 1] ?? 'probe-out') : 'probe-out')
  const dirs = argv.filter((a, i) => a !== '--out' && i !== outIdx + 1 && !a.startsWith('--'))
  if (dirs.length === 0) {
    console.error('用法: npx tsx scripts/probe-gen.ts [--out probe-out] <analysisDir> [...]')
    process.exit(2)
    return
  }

  const analyses = dirs.map(loadAnalysis)
  const allNames = new Set<string>()
  for (const a of analyses) for (const tl of touchTimeline(a.records)) allNames.add(tl.name)

  const probes: Probe[] = []
  const foldReport: Record<string, unknown> = {}
  const noise: Record<string, unknown> = {}
  for (const a of analyses) {
    const own = new Set(touchTimeline(a.records).map((t) => t.name))
    const foreign = new Set([...allNames].filter((n) => !own.has(n)))
    const { probes: ps, fold } = probesFor(a, foreign)
    probes.push(...ps)
    foldReport[a.name] = {
      baseIter: fold.baseIter,
      rule: fold.rule,
      confidence: fold.confidence,
      steps: fold.steps,
      experimentBases: fold.experimentBases,
      pendingEdits: fold.pendingEdits,
      naive: naiveAnswers(a.records),
      records: a.records.length,
      iterDirs: a.iterDirs.length,
    }
    const rows = noiseOf(a)
    const spreads = rows.map((r) => r.spread).filter((s): s is number => typeof s === 'number')
    noise[a.name] = {
      rows,
      summary: {
        iterDirs: a.iterDirs.length,
        withFitJson: rows.filter((r) => r.source === 'fit.json').length,
        medianSpread: median(spreads),
        maxSpread: spreads.length > 0 ? Math.max(...spreads) : null,
        note: 'spread = 同一次拟合内 10 个随机初值的 NLL 极差；ΔNLL 小于它的量级时不可信',
      },
    }
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'probes.jsonl'), probes.map((p) => JSON.stringify(p)).join('\n') + '\n')
  writeFileSync(join(outDir, 'noise.json'), JSON.stringify(noise, null, 1) + '\n')
  writeFileSync(join(outDir, 'fold-report.json'), JSON.stringify(foldReport, null, 1) + '\n')

  const byCat: Record<string, number> = {}
  for (const p of probes) byCat[p.category] = (byCat[p.category] ?? 0) + 1
  console.log(`探针 ${probes.length} 条 → ${join(outDir, 'probes.jsonl')}`)
  console.log(`  分类: ${Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const a of analyses) {
    const s = (noise[a.name] as { summary: { medianSpread: number | null; maxSpread: number | null; withFitJson: number } }).summary
    console.log(`  ${a.name}: 目录 ${a.iterDirs.length} / 日记 ${a.records.length} / 有 fit.json 的轮次 ${s.withFitJson} / 噪声中位 spread ${s.medianSpread === null ? 'n/a' : s.medianSpread.toFixed(1)} / 最大 ${s.maxSpread === null ? 'n/a' : s.maxSpread.toFixed(1)}`)
  }
  console.log(`噪声 → ${join(outDir, 'noise.json')}`)
  console.log(`fold → ${join(outDir, 'fold-report.json')}`)
}

main()
