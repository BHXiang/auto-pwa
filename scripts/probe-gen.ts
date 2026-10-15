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
  source: 'fit.json' | 'nll_history.txt' | 'none'
}

/** 旧流水线（无 fit.json）的兜底：从 `nll_history.txt` 的 `# RUN:` 分段取每次 run 的终值。 */
function parseNllHistoryRuns(text: string): number[] {
  const finals: number[] = []
  let current: number | null = null
  for (const line of text.split('\n')) {
    if (/^\s*#\s*RUN\b/.test(line)) {
      if (current !== null) finals.push(current)
      current = null
      continue
    }
    const m = /^\s*\d+\s+([-+0-9.eE]+)\s*$/.exec(line)
    if (m !== null) {
      const v = Number(m[1])
      if (Number.isFinite(v)) current = v
    }
  }
  if (current !== null) finals.push(current)
  return finals
}

function noiseOf(a: Analysis): NoiseRow[] {
  const rows: NoiseRow[] = []
  for (const { iter, dir } of a.iterDirs) {
    const fitPath = join(dir, 'results', 'fit.json')
    const histPath = join(dir, 'results', 'nll_history.txt')
    let nlls: number[] = []
    let bestIsPD: boolean | null = null
    let source: 'fit.json' | 'nll_history.txt' | 'none' = 'none'
    if (existsSync(fitPath)) {
      const view = parseFitJson(readFileSync(fitPath, 'utf8'))
      const summaries = view.fit?.runSummaries ?? []
      nlls = summaries.map((r) => r.nll).filter((n): n is number => typeof n === 'number')
      if (nlls.length > 0) {
        const best = Math.min(...nlls)
        bestIsPD = summaries.find((r) => r.nll === best)?.positiveDefinite ?? null
        source = 'fit.json'
      }
    }
    if (nlls.length === 0 && existsSync(histPath)) {
      nlls = parseNllHistoryRuns(readFileSync(histPath, 'utf8'))
      if (nlls.length > 0) source = 'nll_history.txt'
    }
    if (nlls.length === 0) {
      rows.push({ iter, nRuns: 0, best: null, worst: null, spread: null, bestIsPD: null, source: 'none' })
      continue
    }
    const best = Math.min(...nlls)
    const worst = Math.max(...nlls)
    rows.push({ iter, nRuns: nlls.length, best, worst, spread: worst - best, bestIsPD, source })
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
  // **后见泄漏检测**：某轮记录里提到比自己更晚的轮次（日记事后补写），则"截至该轮"的
  // 快照会被未来信息污染——实测 chicj2KKeta iter-008 写了"回滚 iter-009"，导致
  // k=8 的摘要把第 9 轮的基线当成已知。这类探针必须单列，不能进头条数字。
  // 排除 `nextPlan`：它天然前瞻（"→ iter-006，检验…"是计划，不泄漏未来的**结果**）。
  // 只有带结果性动词的越界引用才算泄漏（实测 chicj2KKeta iter-008 的
  // "f0_2020 测试…不显著，回滚 iter-009" 正是这种）。
  const RESULT_HINT = /回滚|回退|被拒|否决|不显著|已证伪|已晋级|已回滚|已确定|最终模型/
  const mentionsAhead = (rec: IterationRecord): boolean => {
    // **不能按字段排除**：`nextPlan` 也是事后补写的，实测 chicj2KKeta iter-008 的
    // nextPlan 里写着"f0_2020 测试…不显著，回滚 iter-009"——那是**结果**，不是计划。
    const blob = [rec.title, rec.conclusion ?? '', rec.nextPlan ?? '', ...(rec.changes ?? [])].join(' | ')
    for (const m of blob.matchAll(/iter-(\d+)/g)) {
      if (Number(m[1]) <= rec.iter || m.index === undefined) continue
      const w = blob.slice(Math.max(0, m.index - 40), m.index + 40)
      if (RESULT_HINT.test(w)) return true
    }
    return false
  }
  const contaminatedUpTo = new Set<number>()
  {
    let seen = false
    for (const r of a.records) {
      if (mentionsAhead(r)) seen = true
      if (seen) contaminatedUpTo.add(r.iter)
    }
  }
  const push = (p: Probe): void => {
    probes.push(p)
  }

  // ①b round-reference：**本轮自己的 ΔNLL 参照**（= 插件的 previousDiaryNll 语义：
  //     上一条日记记录；它可能没有 NLL → 该轮 ΔNLL 根本算不出来）。
  //     为什么单独一类：试点实测这道题的措辞歧义让 chicj2KKeta 的答案无法解释
  //     （读法 A 命中 5/26、读法 P 命中 9/26，其余属第三种理解）——钉子必须钉死。
  for (const rec of a.records) {
    if (rec.iter === 0) continue
    const prev = a.records.filter((r) => r.iter < rec.iter).pop()
    if (prev === undefined) continue
    const computable = typeof prev.nll === 'number'
    push({
      id: `${a.name}/round-reference/iter-${String(rec.iter).padStart(3, '0')}`,
      analysis: a.name,
      category: 'round-reference',
      question: `第 iter-${String(rec.iter).padStart(3, '0')} 轮的 ΔNLL 是拿**哪一轮的 NLL** 相减得到的？（定义：上一条日记记录；若它没有 NLL，则这一轮算不出 ΔNLL）`,
      answer: computable ? `iter-${String(prev.iter).padStart(3, '0')}` : '无法计算（上一条记录无 NLL）',
      truth: { ...(contaminatedUpTo.has(rec.iter) ? { hindsight: true } : {}), prevIter: prev.iter, prevNll: computable ? prev.nll : null, computable, definition: 'plugin previousDiaryNll' },
      judge: 'code',
      contextUpToIter: rec.iter,
    })
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
      // 题面必须钉死成**纯声明查找**：实测"比对基线"至少有三种口径（声明点名的轮次 /
      // 内容等价的轮次 / "被接受即自身"），同一批 driver 三种都用过 → 原措辞下这题不可解释。
      // 现在只问"日记里最后一次显式声明的基线是哪一轮"，与 fold 的规则抽取一一对应。
      question:
        `截至 iter-${String(rec.iter).padStart(3, '0')} 结束，日记里**最后一次显式声明**的基线是 iter-哪一轮？` +
        '（声明句式如"回退到 iter-N"/"基线仍为 iter-N"/"最终模型定为 iter-N"；不是"本轮自己与谁比"，也不是"NLL 最低的一轮"）',
      answer: `iter-${String(fold.baseIter).padStart(3, '0')}`,
      truth: {
        ...(contaminatedUpTo.has(rec.iter) ? { hindsight: true } : {}),
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
      question:
        `${a.name} 分析里试过 ${tl.name} 吗？结果如何？` +
        '（判定按**最终状态**：当前仍在模型里 = touched；曾加入但已被移除 = added-then-removed；从未加入 = never）',
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
  // 近名陷阱检测：归一化后与"本分析试过的某个名字"相同 → 标 aliasOf。
  // 试点实测（§8.5）：driver 两次运行的差异全部集中在这类名字上（K2*_1430 vs K2_1430），
  // 若不单列，词形混淆会被算进"记忆失败"。
  const norm = (x: string): string => x.toLowerCase().replace(/[*_\s]/g, '')
  const ownByNorm = new Map<string, string>()
  for (const n of own) {
    const k = norm(n)
    if (!ownByNorm.has(k)) ownByNorm.set(k, n)
  }
  for (const name of [...foreignNames].filter((n) => !own.has(n)).sort().slice(0, 12)) {
    const aliasOf = ownByNorm.get(norm(name))
    if (aliasOf !== undefined) {
      // **记法变体**（如 `K2*_1430` vs 日记里的 `K2*(1430)`）：这**不是**"没试过"，
      // 而是同一个态被换了个写法。原先把它当 abstention 会让真值变错——实测由
      // M1 的 driver 指出（"K2*_1430 在日记里以 K2*(1430) 出现过"）。单列一类，
      // 真值取**本体名的判定**，用来测"记法鲁棒性"而不是记忆有无。
      push({
        id: `${a.name}/alias/${name}`,
        analysis: a.name,
        category: 'alias',
        question: `${a.name} 分析里试过 ${name} 吗？（注意：本分析日记用 ${aliasOf} 这种写法）`,
        answer: triedBefore(a.records, aliasOf).verdict,
        truth: { aliasOf, verdict: triedBefore(a.records, aliasOf).verdict, note: '记法变体：真值取本体名的判定' },
        judge: 'code',
      })
      continue
    }
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
    // 引擎变了 → 跨引擎 NLL 不可比（Pwa-Engine 落地后才可能判；老记录两边都缺 → 不报）
    if (p.engine !== undefined && c.engine !== undefined && p.engine !== c.engine) reasons.push('engine-changed')
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
        engine: { prev: p.engine ?? null, cur: c.engine ?? null },
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
    const rows = (noise[a.name] as { rows: NoiseRow[] }).rows
    const s = (noise[a.name] as { summary: { medianSpread: number | null; maxSpread: number | null; withFitJson: number } }).summary
    const fromFit = rows.filter((r) => r.source === 'fit.json').length
    const fromHist = rows.filter((r) => r.source === 'nll_history.txt').length
    console.log(`  ${a.name}: 目录 ${a.iterDirs.length} / 日记 ${a.records.length} / 噪声来源 fit.json=${fromFit} nll_history=${fromHist} / 中位 spread ${s.medianSpread === null ? 'n/a' : s.medianSpread.toFixed(1)} / 最大 ${s.maxSpread === null ? 'n/a' : s.maxSpread.toFixed(1)}`)
  }
  console.log(`噪声 → ${join(outDir, 'noise.json')}`)
  console.log(`fold → ${join(outDir, 'fold-report.json')}`)
}

main()
