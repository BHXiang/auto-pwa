import { describe, expect, it } from 'vitest'
import { evaluateTrajectory, type TrajectoryCall } from '../src/trajectory-eval.js'

const call = (name: string, args?: Record<string, unknown>): TrajectoryCall => ({ name, ...(args ? { arguments: args } : {}) })

describe('trajectory-eval (routing checks)', () => {
  it('accepts the canonical goal → fit → evaluate/note → loop_next path', () => {
    const calls = [
      call('create_goal'),
      call('auto_pwa_config_view'),
      call('auto_pwa_run_fit', { iterDir: '/pwa/iter-000' }),
      call('auto_pwa_evaluate'),
      call('auto_pwa_diagnose'),
      call('auto_pwa_note'),
      call('auto_pwa_loop_next'),
    ]
    const r = evaluateTrajectory(calls, {
      requireGoalBeforeFit: true,
      forbidBashFit: true,
      requireEvaluateAndNote: true,
    })
    expect(r.ok).toBe(true)
  })

  it('flags a fit before create_goal', () => {
    const r = evaluateTrajectory(
      [call('auto_pwa_run_fit'), call('auto_pwa_evaluate'), call('auto_pwa_note'), call('create_goal')],
      { requireGoalBeforeFit: true },
    )
    expect(r.violations.map((v) => v.code)).toContain('goal-missing-before-fit')
  })

  it('flags a bash fit bypass and a missing evaluate/note', () => {
    const r = evaluateTrajectory(
      [
        call('create_goal'),
        call('auto_pwa_run_fit'),
        call('bash', { command: 'cd iter-000 && python fit.py' }),
        call('auto_pwa_run_fit'),
      ],
      { forbidBashFit: true, requireEvaluateAndNote: true },
    )
    const codes = r.violations.map((v) => v.code)
    expect(codes).toContain('bash-fit-bypass')
    expect(codes.filter((c) => c === 'evaluate-missing')).toHaveLength(2)
    expect(codes.filter((c) => c === 'note-missing')).toHaveLength(2)
  })

  it('flags a missing preflight when transport is unknown', () => {
    const p = evaluateTrajectory(
      [call('create_goal'), call('auto_pwa_run_fit')],
      { requirePreflightWhenUnknown: true },
    )
    expect(p.violations.map((v) => v.code)).toContain('preflight-missing')
  })
})
