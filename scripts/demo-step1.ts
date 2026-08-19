#!/usr/bin/env tsx
/**
 * dsh-pwa step-1 end-to-end demo:
 *   load the real solve2 config -> validate additions -> apply -> render ->
 *   (optional) verify the rendered config parses with ctpwa.
 *
 * Usage:
 *   npm run demo:step1                        # solve2 baseline -> demo-out/iter-001/
 *   npm run demo:step1 -- --out /path/iter-001
 *   npm run demo:step1 -- --ctpwa             # also verify with ctpwa.analysis()
 *
 * The demo never writes into the analysis directory unless --out points there.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseConfig, applyResonanceAddition, dumpConfig, crossReferenceErrors } from '../src/config-edit.js'
import { validateResonanceAddition } from '../src/resonance-validate.js'
import { suggestFree } from '../src/float-policy.js'
import { lookupResonance } from '../src/lookup.js'
import { defaultDb } from '../src/db.js'
import type { ResonanceProposal } from '../src/types.js'

const DEFAULT_CONFIG = '/home/whitewash/pwa/Jpsi2KKeta/solve2/config.yml'
const CTPWA_PY = '/home/whitewash/miniconda3/envs/ctpwa/bin/python'
const TORCH_LIB = '/home/whitewash/miniconda3/envs/ctpwa/lib/python3.12/site-packages/torch/lib'
const LD_LIBRARY_PATH = `/home/whitewash/pkgs/root/lib:/usr/local/cuda-13.2/lib64:${TORCH_LIB}`

const args = process.argv.slice(2)
const cfgPath = arg(args, '--config') ?? DEFAULT_CONFIG
const outDir = resolve(arg(args, '--out') ?? 'demo-out/iter-001')
const ctpwaCheck = args.includes('--ctpwa')

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------------------------------------------------------------------------
const baseText = readFileSync(cfgPath, 'utf8')
const base = parseConfig(baseText)

console.log('=== dsh-pwa step-1 demo ===')
console.log(`[config] ${cfgPath}`)
console.log('  chains:   ', Object.keys(base.decayChains).join(', '))
for (const [name, kin] of Object.entries(base.kinematics)) {
  console.log(
    `  kinematics ${name.padEnd(8)} m_R <= ${kin.threshold.toFixed(4)} GeV  (${kin.mother.j}${kin.mother.p > 0 ? '+' : '-'} -> R + ${kin.daughter.j}${kin.daughter.p > 0 ? '+' : '-'})`,
  )
}
console.log(`  resonances: ${Object.keys(base.resonances).length}`)

const line = (s = '') => console.log(s)

// ---------------------------------------------------------------------------
// Case A: legal addition into an existing group.
// ---------------------------------------------------------------------------
line()
console.log('--- Case A: 添加 rho(1450) 到 R_KK [1-]（已有组）---')
const rho1450: ResonanceProposal = {
  name: 'rho1450',
  chain: 'R_KK',
  jpGroup: { j: 1, p: -1 },
  model: 'BWR',
  parameters: [1.465, 0.4],
  tex: '\\rho(1450)',
}
{
  const pdg = lookupResonance(defaultDb, { name: rho1450.name })[0]
  const v = validateResonanceAddition(defaultDb, base, rho1450, { decayTo: ['K+', 'K-'] })
  const free = suggestFree(pdg, rho1450, { threshold: base.kinematics.R_KK.threshold })
  console.log(`  PDG: ${pdg ? `${pdg.id} ${pdg.jp.j}${pdg.jp.p > 0 ? '+' : '-'} m=${pdg.mass} Γ=${pdg.width}` : 'NOT FOUND'}`)
  console.log(`  validate: ${v.ok ? 'OK' : 'REJECTED'}  (${v.errors.length} errors, ${v.warnings.length} warnings)`)
  for (const e of v.errors) console.log(`    [error] ${e.code}: ${e.message}`)
  for (const w of v.warnings) console.log(`    [warn]  ${w.code}: ${w.message}`)
  console.log(`  float 建议: free=${JSON.stringify(free.free)} range=${JSON.stringify(free.freeRange)}`)
  console.log(`    ${free.rationale}`)
}

// ---------------------------------------------------------------------------
// Case B: new [J,P] group.
// ---------------------------------------------------------------------------
line()
console.log('--- Case B: 添加 f1(1285) 到 R_KK [1+]（新组，自动创建）---')
const f1_1285: ResonanceProposal = {
  name: 'f1_1285',
  chain: 'R_KK',
  jpGroup: { j: 1, p: 1 },
  model: 'BWR',
  parameters: [1.2818, 0.023],
  free: [0],
  freeRange: [[1.26, 1.30]],
  tex: 'f_{1}(1285)',
}
{
  const pdg = lookupResonance(defaultDb, { name: f1_1285.name })[0]
  const v = validateResonanceAddition(defaultDb, base, f1_1285)
  const free = suggestFree(pdg, f1_1285, { threshold: base.kinematics.R_KK.threshold })
  console.log(`  PDG: ${pdg ? `${pdg.id} ${pdg.jp.j}${pdg.jp.p > 0 ? '+' : '-'} m=${pdg.mass} Γ=${pdg.width}` : 'NOT FOUND'}`)
  console.log(`  validate: ${v.ok ? 'OK' : 'REJECTED'}  (${v.errors.length} errors, ${v.warnings.length} warnings)`)
  for (const w of v.warnings) console.log(`    [warn]  ${w.code}: ${w.message}`)
  console.log(`  float 建议(窄共振): ${free.free === undefined ? '固定' : `free=${JSON.stringify(free.free)}`}`)
  console.log(`    ${free.rationale}`)
}

// ---------------------------------------------------------------------------
// Case C: rejections.
// ---------------------------------------------------------------------------
line()
console.log('--- Case C: 非法提议被拒绝（写不进 config）---')
const rejects: [string, ResonanceProposal][] = [
  ['not-on-pdg: X9999 不是 PDG 粒子', { ...rho1450, name: 'X9999' }],
  ['jp-not-allowed: f0(1500) 0+ 在 J/psi->eta+R 链不可达', { name: 'f0_1500', chain: 'R_KK', jpGroup: { j: 0, p: 1 }, model: 'BWR', parameters: [1.505, 0.109] }],
  ['duplicate: phi1020 已在 config', { ...rho1450, name: 'phi1020', parameters: [1.0195, 0.0045] }],
]
for (const [label, p] of rejects) {
  const v = validateResonanceAddition(defaultDb, base, p)
  console.log(`  ${v.ok ? '!! 意外通过' : '拒绝'}  ${label}`)
  for (const e of v.errors) console.log(`    [error] ${e.code}: ${e.message}`)
}

// ---------------------------------------------------------------------------
// Apply both legal additions and render.
// ---------------------------------------------------------------------------
line()
console.log('--- 应用修改并渲染 ---')
const r1 = applyResonanceAddition(base, rho1450)
const edited = applyResonanceAddition(r1.config, f1_1285)
if (r1.errors.length > 0 || edited.errors.length > 0) {
  console.error('apply 失败:', [...r1.errors, ...edited.errors])
  process.exit(1)
}
for (const c of [...r1.changed, ...edited.changed]) console.log('  ' + c)
const xref = crossReferenceErrors(edited.config)
const unref = xref.warnings.filter((w) => w.code === 'unreferenced-resonance')
if (unref.length > 0) {
  console.log(`  [warn] ${unref.length} 个 Resonances 定义了但未被任何 intermediates 引用（solve2 的备用共振态，非本次修改引入）`)
}
for (const w of xref.warnings.filter((w) => w.code !== 'unreferenced-resonance')) {
  console.log(`  [warn] ${w.code}: ${w.message}`)
}

const outYaml = dumpConfig(edited.config)
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'config.yml'), outYaml)
console.log(`\n[输出] ${resolve(outDir, 'config.yml')} (${outYaml.length} bytes)`)

// ---------------------------------------------------------------------------
// Optional ctpwa verification: the rendered config must parse.
// ---------------------------------------------------------------------------
if (ctpwaCheck) {
  line()
  console.log('--- ctpwa 解析验证 ---')
  if (!existsSync(CTPWA_PY)) {
    console.error(`  ctpwa env python 不存在: ${CTPWA_PY}，跳过`)
    process.exit(2)
  }
  const probe = [
    'import ctpwa',
    'try:',
    '    ana = ctpwa.analysis()',
    '    print("ctpwa parsed config OK, amplitudes:", len(ana.getAmplitudeNames()))',
    'except Exception as e:',
    '    print("ctpwa reached:", type(e).__name__, str(e)[:120])',
    '    raise SystemExit(0)', // GPU absence is expected on this host; parse success is what we verify
  ].join('\n')
  const r = spawnSync(CTPWA_PY, ['-c', probe], {
    cwd: outDir,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, LD_LIBRARY_PATH },
  })
  console.log((r.stdout ?? '').trim().split('\n').slice(-3).map((l) => '  ' + l).join('\n'))
  if (r.error) console.error('  spawn error:', r.error.message)
  console.log('  (GPU 缺失导致的报错是预期的——只要出现 "parsed config OK" 或读到数据事件即解析成功)')
}

console.log('\n完成。下一步: auto_pwa_run_fit 传输层。')
void dirname
