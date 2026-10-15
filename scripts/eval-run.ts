#!/usr/bin/env tsx
/**
 * P2 实验台（离线半）：把 P0 探针展开成"档位 × 探针"的**实验清单**，并对答案集做
 * **确定性打分**。
 *
 *   # 1) 生成实验清单（每个 arm 的精确注入文本 + 提问 + 作答协议）
 *   npx tsx scripts/eval-run.ts manifest --probes probe-out/probes.jsonl \
 *        --dir /home/whitewash/pwa/chic2ppeta [...] --out probe-out
 *
 *   # 2) 对某次运行的答案打分（答案可由 subagent / 人工 / 真实 harness 产生）
 *   npx tsx scripts/eval-run.ts score --probes probe-out/probes.jsonl \
 *        --answers probe-out/answers.jsonl --out probe-out
 *
 * 为什么要有 manifest：E1b/E2 的对照必须**同起点、同问题、只换记忆档位**；把注入文本
 * 固化下来（而不是每次让 driver 自己拼）才能保证"只翻一个开关"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { touchTimeline } from '../src/memory-fold.js'
import { rejectedNamesOf, scoreAll, type AnswerRecord, type Probe } from '../src/eval-score.js'
import { buildStateDigest } from '../src/state-digest.js'
import { buildReminders, type ActionKind } from '../src/reminder-set.js'
import type { IterationRecord } from '../src/report.js'

/** 记忆档位（§5.2 E2）。M4 是**负对照**：离线没有向量库，用"关键词相似度"
 *  作替代实现（proxy），必须在结论里标明它不是真的 embedding 检索。 */
const ARMS = ['M0', 'M1', 'M2', 'M3', 'M4'] as const
type Arm = (typeof ARMS)[number]

interface ArmContext {
  text: string
  placement: 'head' | 'tail'
  approxTokens: number
  note?: string
}

function readDiary(analysisDir: string): IterationRecord[] {
  const p = join(analysisDir, 'iterations', 'SUMMARY.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as IterationRecord)
    .sort((a, b) => a.iter - b.iter)
}

const approxTokens = (s: string): number => Math.ceil(s.length / 3)

/** 记录 → 一行摘要（M1 用全量、M2+ 用摘要/检索子集）。 */
function line(r: IterationRecord): string {
  const d = typeof r.deltaNll === 'number' ? ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(2)}` : ''
  const n = typeof r.nll === 'number' ? ` NLL=${r.nll.toFixed(2)}` : ''
  return `iter-${String(r.iter).padStart(3, '0')} [${r.kind}] ${r.title}${n}${d}${r.conclusion !== undefined ? ` | 结论: ${r.conclusion.slice(0, 160)}` : ''}`
}

/** 关键词相似度（M4 的 proxy 检索）：问句里的名字 token 出现在记录文本里。 */
function keywordHits(records: IterationRecord[], question: string, limit = 5): IterationRecord[] {
  const names = new Set<string>()
  for (const tl of touchTimeline(records)) if (question.includes(tl.name)) names.add(tl.name)
  const scored = records.map((r) => {
    const blob = `${r.title} ${r.conclusion ?? ''} ${(r.changes ?? []).join(' ')}`
    let score = 0
    for (const n of names) if (blob.includes(n)) score += 1
    return { r, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.iter - a.r.iter)
    .slice(0, limit)
    .map((x) => x.r)
}

/** 构造某档位在某探针处的注入上下文（同起点：只注入 upToIter 之前的记录）。 */
export function buildArmContext(arm: Arm, records: IterationRecord[], question: string, upToIter?: number): ArmContext {
  const seen = records.filter((r) => upToIter === undefined || r.iter <= upToIter)
  if (arm === 'M0') {
    return { text: '', placement: 'head', approxTokens: 0, note: '无历史（只给当前 config/数据）' }
  }
  if (arm === 'M1') {
    const text = seen.map(line).join('\n')
    return { text, placement: 'head', approxTokens: approxTokens(text) }
  }
  if (arm === 'M2') {
    // 代码生成的当前状态摘要（= P1b 的注入内容）+ 已否决清单
    const text = buildStateDigest({ analysisRoot: '(arm-M2)', records: seen })
    return { text, placement: 'head', approxTokens: approxTokens(text) }
  }
  if (arm === 'M3') {
    const digest = buildStateDigest({ analysisRoot: '(arm-M3)', records: seen })
    const keyed = keywordHits(seen, question).map(line).join('\n')
    const text = `${digest}\n按需检索（按键/关键词命中，最多 5 条）:\n${keyed === '' ? '（无命中）' : keyed}`
    return { text, placement: 'head', approxTokens: approxTokens(text) }
  }
  // M4：负对照 —— 关键词相似度 proxy（不是 embedding 检索）
  const digest = buildStateDigest({ analysisRoot: '(arm-M4)', records: seen })
  const hits = keywordHits(seen, question, 8).map(line).join('\n')
  const text = `${digest}\n相似度检索（proxy：关键词重合，非向量）:\n${hits === '' ? '（无命中）' : hits}`
  return { text, placement: 'tail', approxTokens: approxTokens(text), note: '负对照；proxy 实现，结论里必须标注' }
}

/** E1b：注入策略/位置档（P0–P3）。与 M 档的区别是**显式记录 placement**，
 *  用于验证"关键状态放头/尾都比放中间好"（Lost-in-the-Middle 的领域版）。 */
const P_ARMS = ['P0', 'P1', 'P2', 'P3'] as const
type PArm = (typeof P_ARMS)[number]

export function buildPlacementContext(arm: PArm, records: IterationRecord[], question: string, upToIter?: number): ArmContext {
  const seen = records.filter((r) => upToIter === undefined || r.iter <= upToIter)
  if (arm === 'P0') return buildArmContext('M1', records, question, upToIter)
  if (arm === 'P1') return buildArmContext('M2', records, question, upToIter)
  if (arm === 'P2') return buildArmContext('M3', records, question, upToIter)
  const digest = buildArmContext('M2', records, question, upToIter)
  return { ...digest, placement: 'tail', note: 'recency 重锚：同一摘要放上下文末尾' }
}

/** E3：提醒档（R0/R1/R2）。记忆固定在 M2 摘要，只翻提醒这一个开关。 */
const R_LEVELS = ['R0', 'R1', 'R2'] as const

function buildReminderContext(
  level: (typeof R_LEVELS)[number],
  records: IterationRecord[],
  question: string,
  upToIter: number | undefined,
  action: ActionKind,
): ArmContext {
  const digest = buildArmContext('M2', records, question, upToIter)
  const block = buildReminders(level, action)
  const text = [digest.text, block.text].filter((s) => s !== '').join('\n\n')
  return { text, placement: 'head', approxTokens: approxTokens(text), ...(block.ids.length > 0 ? { note: `reminders=${block.ids.join(',')}` } : {}) }
}

/** E4：evidence-preserving 规模梯——保留本题证据，只追加**别的分析**的无关记录。 */
function buildLadderContext(
  arm: Arm,
  records: IterationRecord[],
  question: string,
  upToIter: number | undefined,
  foreign: IterationRecord[],
  scale: number,
): ArmContext {
  const base = buildArmContext(arm, records, question, upToIter)
  const pad = foreign.slice(0, Math.max(0, scale - records.length))
  if (pad.length === 0) return { ...base, note: `scale=${scale}（无关轮次不足，未加满）` }
  const text = `${base.text}\n无关历史（evidence-preserving 追加，${pad.length} 轮；用于测规模退化与串味）:\n${pad.map(line).join('\n')}`
  return { text, placement: 'head', approxTokens: approxTokens(text), note: `scale=${scale}` }
}

/** 取 `--flag value`（缺省时回退，避免 indexOf(-1)+1 把别的参数当值）。 */
function argValue(args: string[], flag: string, fallback: string): string {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback
}

const PROTOCOL = [
  '只输出一行 JSON，不要解释：',
  '{"answer": <你的答案>}',
  'answer 的形态按类别：current-state → "iter-00N"；tried-before → "never"|"touched"|"added-then-removed"；',
  'abstention → "没试过"；repeat → 整数；comparability → "可比"|"不可比（原因）"；next-step → ["add:名字","remove:名字"]。',
].join('\n')

function cmdManifest(args: string[]): void {
  const probesPath = resolve(argValue(args, '--probes', 'probe-out/probes.jsonl'))
  const outDir = resolve(argValue(args, '--out', 'probe-out'))
  const dirs = args.filter((a, i) => !a.startsWith('--') && !['--probes', '--out', '--dir', '--answers', '--scales'].includes(args[i - 1] ?? ''))
  const probes = readFileSync(probesPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Probe)
  const diaries = new Map<string, IterationRecord[]>()
  for (const d of dirs) diaries.set(basename(resolve(d)), readDiary(resolve(d)))

  const lines: string[] = []
  let n = 0
  for (const p of probes) {
    const records = diaries.get(p.analysis) ?? []
    for (const arm of ARMS) {
      const ctx = buildArmContext(arm, records, p.question, p.contextUpToIter)
      lines.push(
        JSON.stringify({
          probeId: p.id,
          battery: 'M',
          arm,
          analysis: p.analysis,
          category: p.category,
          question: p.question,
          context: ctx,
          protocol: PROTOCOL,
        }),
      )
      n += 1
    }
    // E1b：位置档（只翻 placement）
    for (const arm of P_ARMS) {
      lines.push(
        JSON.stringify({
          probeId: p.id,
          battery: 'P',
          arm,
          analysis: p.analysis,
          category: p.category,
          question: p.question,
          context: buildPlacementContext(arm, records, p.question, p.contextUpToIter),
          protocol: PROTOCOL,
        }),
      )
      n += 1
    }
    // E3：提醒档，只对 next-step（"给 pull 区 + 候选，产出提案"）有意义
    if (p.category === 'next-step') {
      const moves = (p.truth.moves as { op: string }[] | undefined) ?? []
      const action: ActionKind = moves.some((m) => m.op === 'remove') ? 'remove' : 'add'
      for (const level of R_LEVELS) {
        lines.push(
          JSON.stringify({
            probeId: p.id,
            battery: 'R',
            arm: level,
            analysis: p.analysis,
            category: p.category,
            question: p.question,
            action,
            context: buildReminderContext(level, records, p.question, p.contextUpToIter, action),
            protocol: PROTOCOL,
          }),
        )
        n += 1
      }
    }
  }
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'manifest.jsonl')
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(`实验清单 ${n} 条（${probes.length} 探针 × ${ARMS.length} 档）→ ${out}`)
  const byArm = new Map<string, number>()
  for (const l of lines) {
    const o = JSON.parse(l) as { arm: string; context: { approxTokens: number } }
    byArm.set(o.arm, (byArm.get(o.arm) ?? 0) + o.context.approxTokens)
  }
  for (const [arm, total] of [...byArm.entries()].sort()) {
    console.log(`  ${arm}: 平均注入 ~${Math.round(total / probes.length)} tokens/条`)
  }
}

/** E4：规模梯清单（evidence-preserving；只加无关历史）。 */
function cmdLadder(args: string[]): void {
  const probesPath = resolve(argValue(args, '--probes', 'probe-out/probes.jsonl'))
  const outDir = resolve(argValue(args, '--out', 'probe-out'))
  const scales = argValue(args, '--scales', '0,5,50,200').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x))
  const dirs = args.filter((a, i) => !a.startsWith('--') && !['--probes', '--out', '--scales'].includes(args[i - 1] ?? ''))
  const probes = readFileSync(probesPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Probe)
    .filter((p) => p.category === 'current-state' || p.category === 'tried-before')
  const diaries = new Map<string, IterationRecord[]>()
  for (const d of dirs) diaries.set(basename(resolve(d)), readDiary(resolve(d)))
  const allForeign = [...diaries.entries()].flatMap(([name, recs]) => recs.map((r) => ({ name, r })))

  const lines: string[] = []
  const cost = new Map<string, number>()
  for (const p of probes) {
    const own = diaries.get(p.analysis) ?? []
    // 无关历史 = 别的分析的记录（确定性顺序），排除本分析的
    const foreign = allForeign.filter((x) => x.name !== p.analysis).map((x) => x.r)
    for (const arm of ['M1', 'M2'] as const) {
      for (const scale of scales) {
        const ctx = buildLadderContext(arm, own, p.question, p.contextUpToIter, foreign, scale)
        lines.push(
          JSON.stringify({ probeId: p.id, battery: 'L', arm, scale, analysis: p.analysis, category: p.category, question: p.question, context: ctx, protocol: PROTOCOL }),
        )
        const k = `${arm}@${scale}`
        cost.set(k, (cost.get(k) ?? 0) + ctx.approxTokens)
      }
    }
  }
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'ladder.jsonl')
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(`规模梯清单 ${lines.length} 条（${probes.length} 探针 × 2 档 × ${scales.length} 规模）→ ${out}`)
  for (const scale of scales) {
    const m1 = cost.get(`M1@${scale}`) ?? 0
    const m2 = cost.get(`M2@${scale}`) ?? 0
    console.log(`  scale=${String(scale).padStart(3)}: M1 平均 ${Math.round(m1 / probes.length)} tokens/条 · M2 ${Math.round(m2 / probes.length)}`)
  }
}

function cmdScore(args: string[]): void {
  const probesPath = resolve(argValue(args, '--probes', 'probe-out/probes.jsonl'))
  const answersPath = resolve(argValue(args, '--answers', 'probe-out/answers.jsonl'))
  const outDir = resolve(argValue(args, '--out', 'probe-out'))
  const dirs = args.filter((a, i) => !a.startsWith('--') && !['--probes', '--answers', '--out', '--dir'].includes(args[i - 1] ?? ''))
  const probes = readFileSync(probesPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Probe)
  const answers = readFileSync(answersPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AnswerRecord)
  const rejected = new Map<string, Set<string>>()
  for (const d of dirs) {
    const abs = resolve(d)
    rejected.set(basename(abs), rejectedNamesOf(readDiary(abs)))
  }
  const { scores, metrics, markdown } = scoreAll(probes, answers, rejected)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'eval-score.json'), JSON.stringify({ metrics, scores }, null, 1) + '\n')
  writeFileSync(join(outDir, 'eval-attribution.md'), markdown)
  console.log(`打分了 ${scores.length}/${answers.length} 条答案`)
  console.log(markdown)
  console.log(`→ ${join(outDir, 'eval-score.json')} / ${join(outDir, 'eval-attribution.md')}`)
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    if (cmd === 'manifest') cmdManifest(rest)
    else if (cmd === 'ladder') cmdLadder(rest)
    else if (cmd === 'score') cmdScore(rest)
    else {
      console.error('用法: npx tsx scripts/eval-run.ts manifest|ladder|score --probes <probes.jsonl> [--answers <answers.jsonl>] [--scales 0,5,50,200] [--out <dir>] <analysisDir>...')
      process.exit(2)
    }
  } catch (e) {
    console.error(`失败: ${(e as Error).message}`)
    process.exit(1)
  }
}

// 只有直接运行时才执行（被 import 时只导出 buildArmContext，便于单测）
if (process.argv[1] !== undefined && /eval-run\.(ts|js)$/.test(process.argv[1])) main()
