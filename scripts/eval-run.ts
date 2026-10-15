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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { touchTimeline } from '../src/memory-fold.js'
import { rejectedNamesOf, scoreAll, type AnswerRecord, type Probe } from '../src/eval-score.js'
import { buildStateDigest } from '../src/state-digest.js'
import { buildReminders, type ActionKind } from '../src/reminder-set.js'
import type { IterationRecord } from '../src/report.js'

/** 记忆档位（§5.2 E2）。M4 是**负对照**：离线没有向量库，用"关键词相似度"
 *  作替代实现（proxy），必须在结论里标明它不是真的 embedding 检索。 */
const ARMS = ['M0', 'M1', 'M2', 'M2b', 'M3', 'M4'] as const
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

/**
 * 记录 → 文本（M1 用**完整**记录、M3/M4 用检索子集）。
 *
 * ⚠️ 曾经这里把 `conclusion` 截到 160 字、且**丢掉 `nextPlan`** → 让 "M1 = 日记全文"
 * 这个档只剩 ~1.4k tokens/题（全量日记是 4.7–6.9k），而基线声明/折叠规则恰恰写在
 * 被截掉的部分里——这是**控制变量错误**（driver 也指出了"材料被截断"）。
 * 现在输出完整字段；M1 的注入成本随之回到"全量日记"的真实量级。
 */
function line(r: IterationRecord): string {
  const d = typeof r.deltaNll === 'number' ? ` ΔNLL=${r.deltaNll > 0 ? '+' : ''}${r.deltaNll.toFixed(2)}` : ''
  const n = typeof r.nll === 'number' ? ` NLL=${r.nll.toFixed(2)}` : ''
  const parts = [`iter-${String(r.iter).padStart(3, '0')} [${r.kind}] ${r.title}${n}${d}`]
  if (r.conclusion !== undefined && r.conclusion.trim() !== '') parts.push(`结论: ${r.conclusion}`)
  if (r.nextPlan !== undefined && r.nextPlan.trim() !== '') parts.push(`计划: ${r.nextPlan}`)
  if (r.changes !== undefined && r.changes.length > 0) parts.push(`变更: ${r.changes.join('；')}`)
  return parts.join(' | ')
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
    // 历史档位：摘要**不含** tried 索引（产品默认现已开启，见 state-digest 注释），
    // 这样 M2/M2b 才是"只差索引"的单变量对照。
    const text = buildStateDigest({ analysisRoot: '(arm-M2)', records: seen, includeTriedIndex: false })
    return { text, placement: 'head', approxTokens: approxTokens(text), note: '摘要（无 tried 索引）' }
  }
  if (arm === 'M2b') {
    // M2 + 名字级 tried 索引（试点实测 M2 在 tried-before 上只有 ~12/35，见 §8.5）
    const text = buildStateDigest({ analysisRoot: '(arm-M2b)', records: seen, includeTriedIndex: true })
    return { text, placement: 'head', approxTokens: approxTokens(text), note: 'M2 + tried 索引' }
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
  // P1/P3 用**当前产品内容**（M2b：摘要 + tried 索引），只翻"放头/放尾"这一个开关；
  // 放在 M2（无索引）上测位置会把两个变量混在一起。
  if (arm === 'P1') return { ...buildArmContext('M2b', records, question, upToIter), placement: 'head' }
  if (arm === 'P2') return { ...buildArmContext('M3', records, question, upToIter), placement: 'head' }
  const digest = buildArmContext('M2b', records, question, upToIter)
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

/**
 * merge：把 driver 产出的 `<arm>-<analysis>.json`（JSON 数组 [{id, answer}]）合并成
 * 评分器要的答案集，并从 manifest 里取该 (探针, 档位) 的**注入成本**作为 tokensIn。
 *
 * 为什么要单独一步：driver 可以是 subagent / 人工 / 真实 harness，产物只需满足
 * "每个 id 一个 answer" 这一条契约；成本与档位元数据统一由 manifest 提供。
 */
function cmdMerge(args: string[]): void {
  const answersDir = resolve(argValue(args, '--answers', 'probe-out/answers'))
  const manifestPath = resolve(argValue(args, '--manifest', 'probe-out/manifest.jsonl'))
  const outPath = resolve(argValue(args, '--out', 'probe-out/answers.jsonl'))
  const battery = argValue(args, '--battery', 'M')
  // `--run <n>`：同一批材料跑多次时用不同 run 号，**不要互相覆盖**（pass^k 需要它）。
  // 约定：driver 把答案写成 `<档位>-<分析>[-run<k>].json`，这里按文件数给 run 或不覆盖。
  const run = Number(argValue(args, '--run', '0'))
  const manifest = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { battery: string; arm: string; probeId: string; context: { approxTokens: number } })
  const cost = new Map<string, number>()
  const valid = new Set<string>()
  for (const m of manifest) {
    if (m.battery !== battery) continue
    cost.set(`${m.arm}|${m.probeId}`, m.context.approxTokens)
    valid.add(`${m.arm}|${m.probeId}`)
  }
  const out: string[] = []
  let answered = 0
  const seen = new Set<string>()
  for (const file of readdirSync(answersDir)) {
    const m = /^([A-Za-z0-9]+)-(.+?)(?:-run(\d+))?\.json$/.exec(file)
    if (m === null) continue
    const arm = m[1]!
    // 文件名里的 -run<k> 优先（k 次重复互不覆盖）；否则用 --run
    const fileRun = m[3] !== undefined ? Number(m[3]) : run
    const items = JSON.parse(readFileSync(join(answersDir, file), 'utf8')) as { id: string; answer: unknown }[]
    for (const it of items) {
      const key = `${arm}|${it.id}`
      if (!valid.has(key)) {
        console.warn(`  ⚠️ 未知 (档位,探针) 组合，已忽略：${key}`)
        continue
      }
      seen.add(key)
      answered += 1
      out.push(JSON.stringify({ id: it.id, arm, run: fileRun, answer: it.answer, tokensIn: cost.get(key) ?? 0 }))
    }
  }
  const missing = [...valid].filter((k) => !seen.has(k))
  mkdirSync(resolve(outPath, '..'), { recursive: true })
  writeFileSync(outPath, out.join('\n') + '\n')
  console.log(`合并 ${answered} 条答案 → ${outPath}`)
  if (missing.length > 0) {
    console.log(`  ⚠️ 未作答 ${missing.length} 条（按"未答 = 错"计入分母，不隐藏）`)
    for (const k of missing.slice(0, 8)) console.log(`     - ${k}`)
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
    // 用**产品内容**（M2b）对全量日记：规模梯要回答的是"上下文变长时，
    // 产品注入的方案还稳不稳"，不是"某个历史档位稳不稳"。
    for (const arm of ['M1', 'M2b'] as const) {
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
  // **过期派生文件告警**：实测踩过一次——probe-gen 改了真值/题面之后，用旧的
  // probes-clean.jsonl 打分，得出"结论不受影响"的错误判断。派生文件必须晚于母文件。
  const master = resolve('probe-out/probes.jsonl')
  if (probesPath !== master && existsSync(master) && existsSync(probesPath)) {
    const dt = statSync(master).mtimeMs - statSync(probesPath).mtimeMs
    if (dt > 0) {
      console.warn(
        `  ⚠️ 探针文件可能过期：${probesPath.split('/').pop()} 比 probes.jsonl 旧 ${(dt / 1000).toFixed(0)} 秒` +
          ` —— 真值/题面改动后请重新派生，否则会用旧真值打分`,
      )
    }
  }
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
    else if (cmd === 'merge') cmdMerge(rest)
    else if (cmd === 'score') cmdScore(rest)
    else {
      console.error('用法: npx tsx scripts/eval-run.ts manifest|ladder|merge|score --probes <probes.jsonl> [--answers <answers.jsonl>] [--scales 0,5,50,200] [--out <dir>] <analysisDir>...')
      process.exit(2)
    }
  } catch (e) {
    console.error(`失败: ${(e as Error).message}`)
    process.exit(1)
  }
}

// 只有直接运行时才执行（被 import 时只导出 buildArmContext，便于单测）
if (process.argv[1] !== undefined && /eval-run\.(ts|js)$/.test(process.argv[1])) main()
