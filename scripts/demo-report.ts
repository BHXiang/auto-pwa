#!/usr/bin/env tsx
/**
 * Generate a sample iteration diary as HTML pages.
 *   npm run demo:report [-- --out demo-out/iterations]
 *
 * iter-000 NLL is the REAL value from solve2 results/optimization_summary.txt;
 * later rounds are illustrative.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderIndex, renderReport, type IterationRecord } from '../src/report.js'

const outDir = resolve(process.argv[2] === '--out' ? process.argv[3] ?? 'demo-out/iterations' : 'demo-out/iterations')

const records: IterationRecord[] = [
  {
    iter: 0,
    timestamp: '2026-08-18T20:00:00+08:00',
    title: '基线：solve2 现有模型（R_KK [1-,3-] + R_Keta [1-,2+,3-,4+]）',
    kind: 'other',
    configPath: '/home/whitewash/pwa/Jpsi2KKeta/solve2/config.yml',
    nll: -18623.529538,
    hessianPositive: true,
    notes: [
      '基线拟合完成：10 次随机初值，最佳 NLL = -18623.53（run 6，792 迭代）。',
      'Hessian **正定**，参数误差可信。',
      '- R_KK [1-] 组已有 6 个成员（phi1020, omega1420, phi1680, X1750, omega2220, rho1900）。',
      '下一步：数据谱在 1.45 GeV 附近有结构，考虑添加 rho(1450)。',
    ],
  },
  {
    iter: 1,
    timestamp: '2026-08-18T21:30:00+08:00',
    title: '添加 rho(1450) 到 R_KK [1-]（宽态，float 质量+宽度）',
    kind: 'added',
    configPath: 'iter-001/config.yml',
    iterDir: 'iterations/iter-001',
    nll: -18635.9,
    deltaNll: -12.4,
    hessianPositive: true,
    changes: ['decay1.R_KK [1-] += rho1450', 'Resonances.rho1450 = BWR [1.465,0.4] free=[0,1]'],
    warnings: ['crowded-group: [1-] of R_KK already has 6 members — overfit risk, prefer replace over add'],
    floatDecision: 'free=[0,1], range=[[1.265,1.665],[0.2,0.6]]（PDG 宽度 0.4 GeV 为宽态，质量+宽度都放开）',
    notes: [
      'validate: 0 errors，1 warning（组已拥挤）。',
      'ΔNLL = -12.4 → √(2×12.4) ≈ 5.0σ，**显著**，保留。',
      'rho(1450) 拟合质量 1.44 GeV 贴下限，下一轮关注是否撞边界。',
    ],
  },
  {
    iter: 2,
    timestamp: '2026-08-18T22:10:00+08:00',
    title: '添加 f1(1285) 到 R_KK [1+]（新组，窄共振固定参数）',
    kind: 'added',
    configPath: 'iter-002/config.yml',
    iterDir: 'iterations/iter-002',
    nll: -18639.1,
    deltaNll: -3.2,
    hessianPositive: false,
    changes: ['decay1.R_KK new [1+] group += f1_1285', 'Resonances.f1_1285 = BWR [1.2818,0.023]'],
    warnings: ['no-listed-mode: PDG lists no K+ K- decay mode for f1(1285) — data gap, not a veto'],
    floatDecision: '固定（窄共振 f1(1285)，Γ=23 MeV，PDG 测定良好）',
    notes: [
      'ΔNLL = -3.2 → √(2×3.2) ≈ 2.5σ，**不显著**（< 4.5σ）。',
      'Hessian 不正定，参数误差不可信。',
      '结论：f1(1285) 未被数据支持，下一轮**移除**并重新拟合。',
    ],
  },
]

mkdirSync(resolve(outDir, 'iter-000'), { recursive: true })
mkdirSync(resolve(outDir, 'iter-001'), { recursive: true })
mkdirSync(resolve(outDir, 'iter-002'), { recursive: true })
writeFileSync(resolve(outDir, 'index.html'), renderIndex(records))
for (const r of records) {
  const dir = resolve(outDir, `iter-${String(r.iter).padStart(3, '0')}`)
  writeFileSync(resolve(dir, 'report.html'), renderReport(r))
}
console.log(`written: ${outDir}/index.html + ${records.length} report pages`)
