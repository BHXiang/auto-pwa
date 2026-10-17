#!/usr/bin/env node
/**
 * PDG 同步：重新抓官方数据 → 重算 manifest → **差异报告**。
 *
 * 用法：npm run sync:pdg
 * 环境：PYTHON=<ctpwa 的 python>（默认 /home/whitewash/miniconda3/envs/ctpwa/bin/python）
 *
 * 为什么不在工具里"实时查"：裁决必须可复现。同步是**人的动作**：
 * 升级 pdg 包 → 跑一次同步 → 看 diff（新增态 / 平均值变了 / 消失的态）→ 提交 pdg.json + manifest。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pdgPath = join(root, 'data', 'pdg.json')
const nextPath = join(root, 'data', 'pdg.json.next')
const reportPath = join(root, 'data', 'pdg.sync-report.json')
const python = process.env.PYTHON ?? '/home/whitewash/miniconda3/envs/ctpwa/bin/python'

const before = existsSync(pdgPath) ? JSON.parse(readFileSync(pdgPath, 'utf8')) : { resonances: [] }
const beforeMap = new Map(before.resonances.map((r) => [r.id, r]))

const run = spawnSync(python, [join(root, 'scripts', 'fetch_pdg.py')], { encoding: 'utf8' })
process.stdout.write(run.stdout ?? '')
if (run.status !== 0) {
  process.stderr.write(run.stderr ?? '')
  // fetch 只写 .next；非 0 退出意味着它拒绝覆盖现有表（例如有名字没匹配上 PDG）。
  console.error(`sync-pdg: ❌ 已中止（exit ${run.status}），data/pdg.json **未被修改**`)
  process.exit(run.status ?? 1)
}
// 只有 fetch 成功才把 .next 转正（原子替换），避免"半截表"覆盖好数据。
renameSync(nextPath, pdgPath)

const manifest = spawnSync(process.execPath, [join(root, 'scripts', 'check-pdg.mjs'), '--write'], { encoding: 'utf8' })
if (manifest.status !== 0) {
  console.error('sync-pdg: ❌ manifest 生成失败')
  process.exit(1)
}
process.stdout.write(manifest.stdout ?? '')

const after = JSON.parse(readFileSync(pdgPath, 'utf8'))
const afterMap = new Map(after.resonances.map((r) => [r.id, r]))
const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id))
const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id))
const changed = []
for (const [id, a] of afterMap) {
  const b = beforeMap.get(id)
  if (b === undefined) continue
  const mass = b.mass !== a.mass ? { from: b.mass, to: a.mass } : undefined
  const width = b.width !== a.width ? { from: b.width, to: a.width } : undefined
  if (mass !== undefined || width !== undefined) changed.push({ id, ...(mass ? { mass } : {}), ...(width ? { width } : {}) })
}
const report = {
  syncedAt: new Date().toISOString(),
  counts: { before: beforeMap.size, after: afterMap.size },
  added,
  removed,
  changed,
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`sync-pdg: ${beforeMap.size} → ${afterMap.size} 条`)
console.log(`  + 新增 ${added.length}${added.length ? `: ${added.slice(0, 8).join(', ')}` : ''}`)
console.log(`  - 消失 ${removed.length}${removed.length ? `: ${removed.slice(0, 8).join(', ')}` : ''}`)
console.log(`  ~ 数值变化 ${changed.length}${changed.length ? `: ${changed.slice(0, 5).map((c) => c.id).join(', ')}` : ''}`)
console.log(`  报告: ${reportPath}`)
