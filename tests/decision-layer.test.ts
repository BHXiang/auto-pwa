import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeIntermediateJPC } from '../src/intermediate-jpc.js'
import { suggestCandidates, type EvaluateData } from '../src/suggest.js'
import { diagnoseFit } from '../src/diagnose.js'
import { convergenceVerdict, initLoopState, loadLoopState, writeFinalReport, DEFAULT_OBJECTIVE } from '../src/loop-state.js'
import { IterationLog } from '../src/iteration-log.js'
import { defaultDb } from '../src/db.js'
import { parseConfig } from '../src/config-edit.js'
import type { FitJsonView } from '../src/fit-summary.js'

const CONFIG = `Particles:
  Jpsi:
    J: 1
    P: -1
    mass: 3.0969
  eta:
    J: 0
    P: -1
    mass: 0.5478
  Kp:
    J: 0
    P: -1
    mass: 0.4937
  Km:
    J: 0
    P: -1
    mass: 0.4937

DecayChains:
  decay1:
    Jpsi:
      - [eta, R_KK]
      - [Kp, R_Keta]
    R_KK: [Kp, Km]
    R_Keta: [Kp, eta]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: [phi1020]
      R_Keta:
        - [J: 1, P: -1]: [K1_1410]
        - [J: 2, P: 1]: [K2_1430]

Constraints:
  maxL: 3
  trans:
    - [R_Keta_0, R_Keta_1]: -1

Resonances:
  phi1020:
    J: 1
    P: -1
    model: BWR
    parameters: [1.0195, 0.0045]
  K1_1410:
    J: 1
    P: -1
    model: BWR
    parameters: [1.403, 0.174]
  K2_1430:
    J: 2
    P: 1
    model: BWR
    parameters: [1.425, 0.098]
`

const cfg = () => parseConfig(CONFIG)

describe('analyzeIntermediateJPC (shared view/gate analysis)', () => {
  it('R_KK (Kp+Km) at maxL=3: allowed {1--, 3--}, C-blocks 2++', () => {
    const ana = analyzeIntermediateJPC(cfg(), defaultDb, 'R_KK')!
    expect(ana.chain).toBe('decay1')
    expect(ana.jpUnion).toContain('2+')
    expect(ana.allowed.map((w) => w.jpc)).toEqual(['1--', '3--'])
    expect(ana.cBlocked).toEqual(['2++'])
    expect(ana.production?.cRequired).toBe(-1) // C(J/psi) * C(eta) = (-1)(+1)
  })

  it('unknown intermediate -> undefined', () => {
    expect(analyzeIntermediateJPC(cfg(), defaultDb, 'nope')).toBeUndefined()
  })
})

describe('suggestCandidates (pull-driven discovery)', () => {
  const evaluate: EvaluateData = {
    distributions: {
      mass_R_KK: { max_abs_pull: 4.2, pull_regions_over_3sigma: [[1.2, 1.35]], worst_bin: { center: 1.27, pull: 4.2 } },
      cosbeta_R_KK: { max_abs_pull: 1.1, pull_regions_over_3sigma: [] },
    },
  }

  it('ranks pull-aligned candidates for allowed J^PC only', () => {
    const out = suggestCandidates(cfg(), defaultDb, evaluate)
    expect(out.length).toBeGreaterThan(0)
    // Every suggestion must sit in an allowed J^PC of its intermediate.
    const rkk = out.filter((s) => s.intermediate === 'R_KK')
    expect(rkk.length).toBeGreaterThan(0)
    for (const s of rkk) {
      expect(['1--', '3--']).toContain(s.jpc)
      expect(s.resonance.mass).toBeLessThanOrEqual(s.threshold! + 0.05)
    }
    // The top R_KK candidate aligns to the pull region.
    const top = rkk[0]!
    expect(top.alignGap).not.toBeNull()
    expect(top.targetRegion).toEqual([1.2, 1.35])
    expect(top.reason).toContain('pull 区')
  })

  it('candidates survive without pull regions (physics-only listing)', () => {
    const out = suggestCandidates(cfg(), defaultDb, { distributions: {} })
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((s) => s.alignGap === null)).toBe(true)
  })
})

describe('diagnoseFit (fit.json hypotheses)', () => {
  const fit: FitJsonView = {
    status: 'ok',
    fit: {
      runs: 5,
      maxIter: 500,
      best: {
        nll: 100.5,
        positiveDefinite: false,
        params: [{ name: 'phi1680', kind: 'resonance', value: 1.68, lower: 1.6, upper: 1.7, atBoundary: true }],
        fitFractions: [{ amplitude: 'R_KK_1-_phi1680', fraction: 0.02, error: 0.03 }],
      },
      interference: { available: false, reason: 'uninitialized memory' },
    },
  }

  it('flags boundary params, insignificant amplitudes and indefinite Hessian', () => {
    const items = diagnoseFit(fit, cfg())
    const codes = items.map((i) => i.code)
    expect(codes).toContain('hessian-indefinite')
    expect(codes).toContain('param-at-boundary')
    expect(codes).toContain('insignificant-amplitude')
    expect(codes).toContain('interference-unavailable')
  })

  it('clean fit -> no danger items', () => {
    const clean: FitJsonView = {
      status: 'ok',
      fit: {
        runs: 3,
        maxIter: 1000,
        best: { nll: 50.0, positiveDefinite: true, params: [], fitFractions: [] },
      },
    }
    const items = diagnoseFit(clean)
    expect(items.some((i) => i.severity === 'danger')).toBe(false)
  })

  it('flags strongly correlated parameter pairs (degeneracy) from the correlation matrix', () => {
    const fit: FitJsonView = {
      status: 'ok',
      fit: {
        runs: 3,
        maxIter: 1000,
        best: {
          nll: 50.0,
          positiveDefinite: true,
          params: [],
          correlation: {
            names: ['Re(g1)', 'Im(g1)', 'phi1020_mass', 'X1750_width'],
            matrix: [
              [1, 0.1, 0.9, 0.2],
              [0.1, 1, 0.3, -0.85],
              [0.9, 0.3, 1, 0.4],
              [0.2, -0.85, 0.4, 1],
            ],
          },
        },
      },
    }
    const items = diagnoseFit(fit)
    const corrItems = items.filter((i) => i.code === 'parameter-correlation')
    expect(corrItems.length).toBe(2)
    // Sorted by |ρ| descending.
    expect(corrItems[0]!.message).toContain('Re(g1) ↔ phi1020_mass')
    expect(corrItems[0]!.message).toContain('ρ=+0.90')
    expect(corrItems[1]!.message).toContain('Im(g1) ↔ X1750_width')
    expect(corrItems[1]!.message).toContain('ρ=-0.85')
  })

  it('ignores weak correlations below the threshold', () => {
    const fit: FitJsonView = {
      status: 'ok',
      fit: {
        runs: 1,
        maxIter: 500,
        best: {
          nll: 50.0,
          positiveDefinite: true,
          params: [],
          correlation: {
            names: ['a', 'b'],
            matrix: [
              [1, 0.4],
              [0.4, 1],
            ],
          },
        },
      },
    }
    const items = diagnoseFit(fit)
    expect(items.some((i) => i.code === 'parameter-correlation')).toBe(false)
  })
})

describe('loop-state (convergence / persistence / report)', () => {
  it('convergenceVerdict: pulls + significance + budget', () => {
    expect(convergenceVerdict({ nll: 10, deltaNll: -0.5, maxPull: 2 }, DEFAULT_OBJECTIVE, 1).converged).toBe(true)
    expect(convergenceVerdict({ nll: 10, deltaNll: -5, maxPull: 2 }, DEFAULT_OBJECTIVE, 1).converged).toBe(false) // significant gain left
    expect(convergenceVerdict({ nll: 10, deltaNll: -0.5, maxPull: 7 }, DEFAULT_OBJECTIVE, 1).converged).toBe(false) // pulls remain
    expect(convergenceVerdict({ nll: 10, deltaNll: -0.5, maxPull: 2 }, DEFAULT_OBJECTIVE, 20).converged).toBe(true) // budget exhausted
    // First evaluation without a previous round: cannot judge convergence yet.
    expect(convergenceVerdict({ nll: 10, deltaNll: null, maxPull: 2 }, DEFAULT_OBJECTIVE, 1).converged).toBe(false)
  })

  it('init -> save -> load -> final report roundtrip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-loop-'))
    try {
      const iterationsRoot = join(dir, 'iterations')
      mkdirSync(iterationsRoot, { recursive: true })
      const iterDir = join(iterationsRoot, 'iter-000')
      mkdirSync(join(iterDir, 'results'), { recursive: true })
      writeFileSync(join(iterDir, 'config.yml'), 'base')
      writeFileSync(join(iterDir, 'results', 'fit.json'), JSON.stringify({ status: 'ok', fit: { best: { nll: 99.5, positiveDefinite: true } } }))

      const state = initLoopState(iterationsRoot, iterDir, { maxRounds: 5 })
      expect(state.phase).toBe('evaluate')
      const loaded = loadLoopState(iterationsRoot)!
      expect(loaded.iter).toBe(0)
      expect(loaded.objective.maxRounds).toBe(5)

      // Diary needs at least one record for a useful report; append one.
      new IterationLog({ rootDir: iterationsRoot }).append({
        iter: 0,
        timestamp: new Date().toISOString(),
        title: '基线',
        kind: 'other',
        configPath: join(iterDir, 'config.yml'),
        iterDir,
        nll: 99.5,
        conclusion: 'baseline',
      })

      const reportPath = writeFinalReport(iterationsRoot, { iter: 0, iterDir, nll: 99.5 }, '测试收敛')
      expect(existsSync(reportPath)).toBe(true)
      expect(readFileSync(reportPath, 'utf8')).toContain('PWA 自动迭代最终报告')
      expect(readFileSync(reportPath, 'utf8')).toContain('iter-000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
