import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFitJson, summarizeFitDir, parseOptimizationSummary, parseNllHistoryTail } from '../src/fit-summary.js'

const FIT_JSON = JSON.stringify({
  schemaVersion: '0.1.0',
  status: 'ok',
  config: { valid: true, path: 'config.yml', nAmplitudes: 3, amplitudeNames: ['a0', 'a1', 'a2'] },
  fit: {
    nCouplingFree: 3,
    nResFree: 2,
    runs: 4,
    maxIter: 500,
    timeSec: 12.3,
    runSummaries: [
      { runId: 0, nll: -18620.1, iterations: 300, positiveDefinite: false },
      { runId: 1, nll: -18635.9, iterations: 420, positiveDefinite: true },
      { runId: 2, nll: -18630.4, iterations: 380, positiveDefinite: true },
      { runId: 3, error: 'CUDA error' },
    ],
    best: {
      runId: 1,
      nll: -18635.9,
      positiveDefinite: true,
      params: [
        { name: 'amp0', kind: 'coupling', real: 1.0, imag: 0.0, realError: 0.0, imagError: 0.0 },
        { name: 'phi1020_mass', kind: 'resonance', value: 1.0195, error: 0.0002, lower: 1.01, upper: 1.03, atBoundary: false },
        { name: 'X1750_mass', kind: 'resonance', value: 1.764, error: 0.001, lower: 1.7, upper: 1.77, atBoundary: true },
      ],
      fitFractions: [
        { amplitude: 'a0', fraction: 0.62, error: 0.02 },
        { amplitude: 'a1', fraction: 0.3, error: 0.01 },
        { amplitude: 'a2', fraction: 0.08, error: 0.005 },
      ],
      branchFractions: null,
    },
    warnings: ['X1750_mass 贴住 free_range 上界（撞边界）', 'getFitFractions 不可用'],
    interference: {
      available: true,
      totalIntensity: 7.4,
      matrix: [[2, 1, -0.5], [1, 3, 0.2], [-0.5, 0.2, 1]],
      fractions: [
        { amplitude: 'a0', fraction: 0.2703 },
        { amplitude: 'a1', fraction: 0.4054 },
        { amplitude: 'a2', fraction: 0.1351 },
      ],
      topInterference: [
        { pair: ['a0', 'a1'], value: 0.1351 },
        { pair: ['a0', 'a2'], value: -0.0676 },
      ],
    },
  },
  error: null,
}, null, 2)

describe('parseFitJson', () => {
  it('extracts the structured fit view', () => {
    const v = parseFitJson(FIT_JSON)
    expect(v.status).toBe('ok')
    expect(v.fit?.best?.nll).toBe(-18635.9)
    expect(v.fit?.best?.positiveDefinite).toBe(true)
    expect(v.fit?.best?.params?.length).toBe(3)
    const x = v.fit?.best?.params?.[2]
    expect(x?.atBoundary).toBe(true)
    expect(v.fit?.best?.fitFractions?.[0]).toEqual({ amplitude: 'a0', fraction: 0.62, error: 0.02 })
    expect(v.fit?.warnings).toHaveLength(2)
    expect(v.fit?.runSummaries?.filter((r) => r.nll !== undefined).length).toBe(3)
    // Interference matrix from weight_best.root.
    expect(v.fit?.interference?.available).toBe(true)
    expect(v.fit?.interference?.matrix?.[0]).toEqual([2, 1, -0.5])
    expect(v.fit?.interference?.topInterference?.[0]).toEqual({ pair: ['a0', 'a1'], value: 0.1351 })
    expect(v.fit?.interference?.fractions?.[1]?.fraction).toBeCloseTo(0.4054, 4)
  })

  it('is tolerant of missing fields and error payloads', () => {
    const v = parseFitJson(JSON.stringify({ status: 'config-error', error: { code: 'config-invalid', message: 'x' } }))
    expect(v.status).toBe('config-error')
    expect(v.error?.code).toBe('config-invalid')
    expect(v.fit).toBeUndefined()
    expect(parseFitJson('{"status":"no-gpu"}').fit).toBeUndefined()
  })
})

describe('summarizeFitDir (fit.json preferred)', () => {
  it('prefers fit.json over optimization_summary.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-fitsum-'))
    try {
      const results = join(dir, 'results')
      mkdirSync(results, { recursive: true })
      writeFileSync(join(results, 'fit.json'), FIT_JSON)
      // Legacy text with a DIFFERENT bestNll: must NOT win.
      writeFileSync(join(results, 'optimization_summary.txt'), [
        'PWA优化结果',
        '总运行次数: 2',
        '耦合参数数量: 3',
        '自由共振态参数: 2',
        '最佳NLL: -9999.0',
        '运行结果 (按NLL排序):',
        '1  0  -9999.0  100',
      ].join('\n'))
      writeFileSync(join(results, 'nll_history.txt'), '  999   -18635.9\n')
      const { summary, history, files, fitJson } = summarizeFitDir(dir)
      expect(summary.bestNll).toBe(-18635.9) // from fit.json, not -9999
      expect(summary.totalRuns).toBe(3) // successful runs
      expect(summary.positiveDefinite).toBe(true)
      expect(summary.bestRun).toEqual({ runId: 1, nll: -18635.9, iterations: 420 })
      expect(history.lastNll).toBe(-18635.9)
      expect(files).toContain('fit.json')
      expect(fitJson?.fit?.best?.params?.some((p) => p.atBoundary)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the legacy text parser without fit.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-fitsum2-'))
    try {
      const results = join(dir, 'results')
      mkdirSync(results, { recursive: true })
      writeFileSync(join(results, 'optimization_summary.txt'), [
        'PWA优化结果',
        '总运行次数: 5',
        '耦合参数数量: 4',
        '自由共振态参数: 1',
        '最佳NLL: -12345.6',
        '运行结果 (按NLL排序):',
        '1  3  -12345.6  900',
      ].join('\n'))
      const { summary, fitJson } = summarizeFitDir(dir)
      expect(summary.bestNll).toBe(-12345.6)
      expect(summary.totalRuns).toBe(5)
      expect(summary.bestRun?.runId).toBe(3)
      expect(fitJson).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('legacy text parsers still work', () => {
  it('parses the Chinese-labeled summary', () => {
    const s = parseOptimizationSummary('最佳NLL: -18635.9\n总运行次数: 10\n耦合参数数量: 11\n自由共振态参数: 4\n正定 True')
    expect(s.bestNll).toBe(-18635.9)
    expect(s.totalRuns).toBe(10)
    expect(s.couplingParams).toBe(11)
    expect(s.freeResParams).toBe(4)
    expect(s.positiveDefinite).toBe(true)
  })

  it('parses the NLL history tail', () => {
    const h = parseNllHistoryTail('# RUN: run_0\n    0    -18000.0\n   42    -18623.5\n')
    expect(h.lastNll).toBe(-18623.5)
    expect(h.iterations).toBe(42)
  })
})
