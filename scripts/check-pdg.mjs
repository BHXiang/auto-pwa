#!/usr/bin/env node
/**
 * 校验（或重新生成）data/pdg.manifest.json —— PDG 表的完整性锚。
 *
 * 用法：
 *   npm run check:pdg                 # 校验；哈希/条目数漂移 → 退出码 1
 *   npm run check:pdg -- --write      # 重新生成 manifest（sync 的一部分）
 *   npm run check:pdg -- --strict     # 顺带要求"表内没有非 PDG 条目"
 *
 * 为什么：这张表是校验门的信任锚（BWR/BW/Flatte/GS 的"PDG 依据"就查它）。
 * 它能被手改（历史上 agent 加过 PDG 没有的态），锚漂移后门禁会被自己的数据糊弄。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pdgPath = join(root, 'data', 'pdg.json')
const manifestPath = join(root, 'data', 'pdg.manifest.json')
const raw = readFileSync(pdgPath, 'utf8')
const db = JSON.parse(raw)
const rows = db.resonances ?? []
const canonical = createHash('sha256').update(JSON.stringify(db)).digest('hex')
const counts = {
  total: rows.length,
  pdg: rows.filter((r) => r.status === 'pdg').length,
  seed: rows.filter((r) => r.status !== 'pdg').length,
}
const argv = process.argv.slice(2)

if (argv.includes('--write')) {
  const manifest = {
    schemaVersion: '1.0.0',
    pdgFile: 'pdg.json',
    canonicalSha256: canonical,
    fileSha256: createHash('sha256').update(raw).digest('hex'),
    generatedAt: new Date().toISOString(),
    source: db.source ?? 'pdg',
    counts,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`check-pdg: ✅ 已写入 manifest（${counts.total} 条：pdg=${counts.pdg}，本地=${counts.seed}）`)
  process.exit(0)
}

if (!existsSync(manifestPath)) {
  console.error('check-pdg: ❌ data/pdg.manifest.json 缺失 → 运行 `npm run check:pdg -- --write`')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const problems = []
if (manifest.canonicalSha256 !== canonical) {
  problems.push(`内容哈希漂移（manifest ${String(manifest.canonicalSha256).slice(0, 12)}… ≠ 实际 ${canonical.slice(0, 12)}…）`)
}
if (manifest.counts?.total !== counts.total) problems.push(`条目数 ${manifest.counts?.total} → ${counts.total}`)
const seeds = rows.filter((r) => r.status !== 'pdg').map((r) => r.id)
if (seeds.length > 0) {
  const line = `表内仍有 ${seeds.length} 条非 PDG 条目：${seeds.join(', ')}`
  if (argv.includes('--strict')) problems.push(line)
  else console.log(`check-pdg: ⚠ ${line}（用 --strict 可让它变成错误；P1 会把它们拆到本地登记表）`)
}
if (problems.length > 0) {
  console.error(`check-pdg: ❌ ${problems.join('；')}`)
  console.error('  若确认是合法更新：`npm run check:pdg -- --write` 后提交 data/pdg.manifest.json 供评审。')
  process.exit(1)
}
console.log(`check-pdg: ✅ 一致（${counts.total} 条，PDG ${counts.pdg}）`)
