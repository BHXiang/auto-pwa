import { describe, expect, it } from 'vitest'
import { apply } from '../plugin/auto-pwa.js'

/** Minimal ctx mock: collects tool definitions instead of registering them. */
function collectDefinitions() {
  const definitions: { name: string; description?: string }[] = []
  const ctx = {
    tools: {
      register: (def: { name: string; description?: string }) => {
        definitions.push(def)
      },
    },
  }
  apply(ctx as never)
  return definitions
}

describe('auto-pwa plugin', () => {
  it('registers the twelve auto_pwa_* tools', () => {
    const defs = collectDefinitions()
    expect(defs.map((d) => d.name)).toEqual([
      'auto_pwa_lookup',
      'auto_pwa_decay_check',
      'auto_pwa_validate_add',
      'auto_pwa_edit_config',
      'auto_pwa_round',
      'auto_pwa_iter_start',
      'auto_pwa_note',
      'auto_pwa_history',
      'auto_pwa_iterate',
      'auto_pwa_evaluate',
      'auto_pwa_run_fit',
      'auto_pwa_fit_status',
    ])
  })

  it('documents every tool for the model', () => {
    for (const d of collectDefinitions()) {
      expect(d.description?.length ?? 0).toBeGreaterThan(20)
    }
  })
})
