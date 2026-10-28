/**
 * Static trajectory checks for the simplified PWA loop.
 *
 * This is deliberately a **checker**, not an LLM: it consumes a sequence of
 * tool calls (e.g. parsed from a session log) and reports deviations from the
 * canonical path:
 *
 *   create_goal → run_fit (gate + submit) → evaluate/diagnose → note
 *   (loop_next optional; loop_decide optional)
 *
 * It is used by routing-eval tests and can be run against real session logs.
 */

export interface TrajectoryCall {
  name: string
  arguments?: Record<string, unknown>
}

export interface TrajectoryScenario {
  /** The first `run_fit` must come after a `create_goal`. */
  requireGoalBeforeFit?: boolean
  /** Any bash command containing a fit driver invocation is a bypass. */
  forbidBashFit?: boolean
  /** After every `run_fit`, there must be an `evaluate` and a `note` before the next fit. */
  requireEvaluateAndNote?: boolean
  /** `loop_decide` must not be the only driver (i.e. no `run_fit` at all). */
  forbidLoopDecideOnly?: boolean
  /** `run_fit` must be preceded by `run_fit(preflight:true)` when marked. */
  requirePreflightWhenUnknown?: boolean
}

export interface TrajectoryResult {
  ok: boolean
  violations: { code: string; message: string }[]
}

const isBashFit = (c: TrajectoryCall): boolean => {
  if (c.name !== 'bash') return false
  const cmd = String(c.arguments?.command ?? '')
  return /(?:^|[\s;&|])(?:python[0-9.]*\s+)?(?:aifit\.py|fit\.py|pwa_optimizer\.py)\b/.test(cmd)
}

/**
 * Check one trajectory. The checker is conservative: it only reports what the
 * scenario asks for, so the same function can score a clean analysis and a
 * deliberately broken fixture.
 */
export function evaluateTrajectory(calls: TrajectoryCall[], scenario: TrajectoryScenario): TrajectoryResult {
  const violations: { code: string; message: string }[] = []
  const names = calls.map((c) => c.name)
  const firstFit = names.indexOf('auto_pwa_run_fit')
  const firstGoal = names.indexOf('create_goal')

  if (scenario.requireGoalBeforeFit && firstFit >= 0 && (firstGoal < 0 || firstGoal > firstFit)) {
    violations.push({
      code: 'goal-missing-before-fit',
      message: 'the first auto_pwa_run_fit appears before create_goal; long analyses should establish the goal first',
    })
  }

  if (scenario.forbidBashFit) {
    const bad = calls.findIndex(isBashFit)
    if (bad >= 0) {
      violations.push({
        code: 'bash-fit-bypass',
        message: `bash fit driver call at index ${bad}; use auto_pwa_run_fit (gate + transport + provenance) instead`,
      })
    }
  }

  if (scenario.forbidLoopDecideOnly && names.includes('auto_pwa_loop_decide') && !names.includes('auto_pwa_run_fit')) {
    violations.push({
      code: 'loop-decide-only',
      message: 'auto_pwa_loop_decide is used but no auto_pwa_run_fit; loop_decide is optional, run_fit is the fit entry point',
    })
  }

  if (scenario.requirePreflightWhenUnknown && names.includes('auto_pwa_run_fit')) {
    const first = calls[firstFit]
    if (first?.arguments?.preflight !== true) {
      violations.push({
        code: 'preflight-missing',
        message: 'transport is marked unknown but the first run_fit did not use preflight:true',
      })
    }
  }

  if (scenario.requireEvaluateAndNote) {
    for (let i = 0; i < calls.length; i++) {
      if (calls[i]!.name !== 'auto_pwa_run_fit') continue
      const nextFit = calls.findIndex((c, j) => j > i && c.name === 'auto_pwa_run_fit')
      const end = nextFit < 0 ? calls.length : nextFit
      const after = calls.slice(i + 1, end).map((c) => c.name)
      if (!after.includes('auto_pwa_evaluate')) {
        violations.push({ code: 'evaluate-missing', message: `run_fit at index ${i} has no evaluate before the next fit` })
      }
      if (!after.includes('auto_pwa_note')) {
        violations.push({ code: 'note-missing', message: `run_fit at index ${i} has no note before the next fit` })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}
