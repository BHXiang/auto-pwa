import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInitialConfig } from '../src/config-init.js'
import { defaultDb } from '../src/db.js'
import { applyResonanceAddition, crossReferenceErrors, dumpConfig, parseConfig, validateConfig } from '../src/config-edit.js'
import type { InitialConfigSpec } from '../src/types.js'

/**
 * auto_pwa_init_config: build a config.yml from scratch.
 *
 * The suite pins the three promises of the design (PLAN-STEP3 Part A):
 *   1. creation goes through the SAME renderer and the SAME gates as editing;
 *   2. nothing is produced while errors remain;
 *   3. a minimal, pdgid-only spec yields a config ctpwa accepts (the real
 *      `aifit --validate-only` check is done outside vitest).
 */

/** J/psi -> eta R_KK (+ K R_Keta), pdgid only. */
const minimal = (): InitialConfigSpec => ({
  particles: [
    { name: 'Jpsi', pdgid: 443 },
    { name: 'eta', pdgid: 221 },
    { name: 'Kp', pdgid: 321 },
    { name: 'Km', pdgid: -321 },
  ],
  chains: [
    {
      name: 'decay1',
      steps: [
        { mother: 'Jpsi', daughters: ['eta', 'R_KK'] },
        { mother: 'R_KK', daughters: ['Kp', 'Km'] },
      ],
      intermediates: [{ name: 'R_KK', groups: [{ j: 1, p: -1 }, { j: 0, p: 1 }] }],
    },
  ],
  resonances: [
    { name: 'phi1020', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.0195, 0.0045] },
  ],
  data: { order: ['Kp', 'Km', 'eta'], data: ['dat', './data.dat'], phsp: ['dat', './phsp.dat'] },
})

describe('buildInitialConfig: pdgid-only particles', () => {
  it('resolves J / P / mass from the PDGID and produces valid text', () => {
    const r = buildInitialConfig(minimal(), defaultDb)
    expect(r.errors).toEqual([])
    expect(r.text).toBeDefined()
    expect(r.config).toBeDefined()
    // J^P and mass came from the table, not from the spec.
    expect(r.config!.particles['Jpsi']).toMatchObject({ j: 1, p: -1, mass: 3.0969, pdgid: 443 })
    expect(r.config!.particles['Kp']).toMatchObject({ j: 0, p: -1, pdgid: 321 })
    expect(r.config!.particles['Km']!.mass).toBeCloseTo(0.493677, 6)
    expect(r.config!.particles['eta']!.mass).toBeCloseTo(0.547862, 6)
  })

  it('renders through dumpConfig and re-parses identically (round-trip)', () => {
    const r = buildInitialConfig(minimal(), defaultDb)
    const again = parseConfig(r.text!)
    expect(again.particles['Kp']!.pdgid).toBe(321)
    expect(again.resonances['phi1020']!.parameters).toEqual([1.0195, 0.0045])
    expect(again.decayChains['decay1']!.intermediates['R_KK']!.groups.map((g) => `${g.jp.j}${g.jp.p > 0 ? '+' : '-'}`)).toEqual(['1-', '0+'])
    expect(again.decayChains['decay1']!.intermediates['R_KK']!.groups[0]!.names).toEqual(['phi1020'])
  })

  it('the written config passes validateConfig + crossReferenceErrors', () => {
    const r = buildInitialConfig(minimal(), defaultDb)
    const cfg = parseConfig(r.text!)
    expect(validateConfig(cfg, defaultDb).errors).toEqual([])
    expect(crossReferenceErrors(cfg).errors).toEqual([])
  })

  it('accepts a tex ARRAY and writes it flat (never nested)', () => {
    // config 的 tex 是多段标签数组（K₁(2100) 这类），spec 也必须能直接给数组：
    // 以前 schema 只收字符串，而 writer 无条件再包一层 → 会写出 tex: [[...]]，
    // 而 ctpwa 只把它当标签读、跑前门禁也不拦 —— 静默坏配置。
    const spec = minimal()
    spec.resonances![0]!.tex = ['\\phi', '(1020)']
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    expect(r.config!.resonances['phi1020']!.tex).toEqual(['\\phi', '(1020)'])
    expect(r.text).not.toMatch(/tex:\s*\n\s*- - /)
  })

  it('keeps the [J,P] group order (trans amplitude-block indices depend on it)', () => {
    const spec = minimal()
    spec.chains[0]!.intermediates = [
      { name: 'R_KK', groups: [{ j: 0, p: 1 }, { j: 1, p: -1 }, { j: 2, p: 1 }] },
    ]
    const r = buildInitialConfig(spec, defaultDb)
    const groups = r.config!.decayChains['decay1']!.intermediates['R_KK']!.groups
    expect(groups.map((g) => `${g.jp.j}${g.jp.p > 0 ? '+' : '-'}`)).toEqual(['0+', '1-', '2+'])
    // trans referencing block index 0 must resolve to the 0+ group
    expect(crossReferenceErrors(parseConfig(r.text!)).errors).toEqual([])
  })

  it('an explicit mass overrides the PDG value for states the PDG does not carry', () => {
    // K(S)0 (310) has no PDG mass -> must be given explicitly.
    const spec = minimal()
    spec.particles = [
      { name: 'Jpsi', pdgid: 443 },
      { name: 'gamma', pdgid: 22, mass: 0.0 },
      { name: 'Ks1', pdgid: 310, mass: 0.497611 },
      { name: 'Ks2', pdgid: 310, mass: 0.497611 },
    ]
    spec.chains = [
      {
        name: 'decay1',
        steps: [
          { mother: 'Jpsi', daughters: ['gamma', 'R_KSKS'] },
          { mother: 'R_KSKS', daughters: ['Ks1', 'Ks2'] },
        ],
        intermediates: [{ name: 'R_KSKS', groups: [{ j: 0, p: 1 }, { j: 2, p: 1 }] }],
      },
    ]
    spec.resonances = [
      { name: 'f0_1500', chain: 'R_KSKS', jpGroup: { j: 0, p: 1 }, model: 'BWR', parameters: [1.5, 0.112] },
    ]
    spec.data = { order: ['Ks1', 'Ks2', 'gamma'], data: ['dat', './data.dat'], phsp: ['dat', './phsp.dat'] }
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    // The K_S K_S identical pair must be flagged: not declared yet.
    expect(r.warnings.map((w) => w.code)).toContain('identical-missing')
  })
})

describe('buildInitialConfig: physics gates are enforced', () => {
  it('rejects f2(1270) in R_KK [2+] for J/psi -> eta R_KK (C conservation)', () => {
    const spec = minimal()
    // The [2+] group must be declared for the gate to reach the C check
    // (otherwise the structural check rejects it first as unknown-jp-group).
    spec.chains[0]!.intermediates = [
      { name: 'R_KK', groups: [{ j: 1, p: -1 }, { j: 0, p: 1 }, { j: 2, p: 1 }] },
    ]
    spec.resonances = [
      { name: 'phi1020', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.0195, 0.0045] },
      { name: 'f2_1270', chain: 'R_KK', jpGroup: { j: 2, p: 1 }, model: 'BWR', parameters: [1.275, 0.185] },
    ]
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.text).toBeUndefined()
    expect(r.errors.map((e) => e.code)).toContain('c-violation')
  })

  it('rejects a resonance that is not on the PDG table', () => {
    const spec = minimal()
    spec.resonances = [
      { name: 'made_up_resonance', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.5, 0.1] },
    ]
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.text).toBeUndefined()
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('rejects a mass above the kinematic threshold', () => {
    // R_KK threshold = m_Jpsi - m_eta = 2.549 GeV; psi(3770) (1--) sits above it.
    const spec = minimal()
    spec.resonances = [
      { name: 'psi(3770)', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [3.7737, 0.0272] },
    ]
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.text).toBeUndefined()
    expect(r.errors.map((e) => e.code)).toContain('above-threshold')
  })
})

describe('buildInitialConfig: structural errors', () => {
  const expectError = (mutate: (s: InitialConfigSpec) => void, code: string): void => {
    const s = minimal()
    mutate(s)
    const r = buildInitialConfig(s, defaultDb)
    expect(r.text).toBeUndefined()
    expect(r.errors.map((e) => e.code)).toContain(code)
  }

  it('duplicate particle name', () => {
    expectError((s) => s.particles.push({ name: 'Kp', pdgid: 321 }), 'duplicate-particle')
  })

  it('unknown daughter', () => {
    expectError((s) => {
      s.chains[0]!.steps.push({ mother: 'R_KK', daughters: ['Kp', 'nope'] })
    }, 'unknown-daughter')
  })

  it('unknown step mother', () => {
    expectError((s) => {
      s.chains[0]!.steps.push({ mother: 'nope', daughters: ['Kp', 'Km'] })
    }, 'unknown-mother')
  })

  it('unknown resonance chain', () => {
    expectError((s) => {
      s.resonances = [{ name: 'phi1020', chain: 'R_nope', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.0195, 0.0045] }]
    }, 'unknown-chain')
  })

  it('resonance attached to an undeclared [J,P] group', () => {
    expectError((s) => {
      s.resonances = [{ name: 'phi1020', chain: 'R_KK', jpGroup: { j: 3, p: -1 }, model: 'BWR', parameters: [1.0195, 0.0045] }]
    }, 'unknown-jp-group')
  })

  it('Data.order referencing an unknown particle', () => {
    expectError((s) => {
      s.data.order = ['Kp', 'Km', 'nope']
    }, 'data-order-unknown')
  })

  it('a particle with neither pdgid nor mass', () => {
    expectError((s) => {
      s.particles.push({ name: 'X', j: 0, p: -1 })
    }, 'missing-mass')
  })

  it('an unknown pdgid is a warning, not a hard failure, when fields are explicit', () => {
    const s = minimal()
    s.particles.push({ name: 'custom', pdgid: 999999, j: 0, p: -1, mass: 0.5 })
    const r = buildInitialConfig(s, defaultDb)
    expect(r.warnings.map((w) => w.code)).toContain('pdgid-unknown')
  })
})

describe('buildInitialConfig: create == edit', () => {
  it('resonance blocks are byte-identical to applyResonanceAddition', () => {
    const r = buildInitialConfig(minimal(), defaultDb)
    // Same spec attached to a hand-built config that already has the group.
    const base = parseConfig(`Particles:
  Jpsi: {J: 1, P: -1, mass: 3.0969, pdgid: 443}
  eta: {J: 0, P: -1, mass: 0.547862, pdgid: 221}
  Kp: {J: 0, P: -1, mass: 0.493677, pdgid: 321}
  Km: {J: 0, P: -1, mass: 0.493677, pdgid: -321}
DecayChains:
  decay1:
    Jpsi: [[eta, R_KK]]
    R_KK: [Kp, Km]
    intermediates:
      R_KK:
        - [J: 1, P: -1]: []
        - [J: 0, P: 1]: []
Resonances: {}
`)
    const applied = applyResonanceAddition(base, {
      name: 'phi1020',
      chain: 'R_KK',
      jpGroup: { j: 1, p: -1 },
      model: 'BWR',
      parameters: [1.0195, 0.0045],
    })
    expect(applied.errors).toEqual([])
    expect(JSON.stringify(r.config!.resonances['phi1020'])).toBe(JSON.stringify(applied.config.resonances['phi1020']))
    const g = applied.config.decayChains['decay1']!.intermediates['R_KK']!.groups[0]!
    expect(g.names).toEqual(['phi1020'])
  })
})

describe('buildInitialConfig: constraints / data / plot survive', () => {
  it('writes trans / identical / maxL and reads them back', () => {
    const spec = minimal()
    spec.chains[0]!.steps = [
      { mother: 'Jpsi', daughters: ['eta', 'R_KK'] },
      { mother: 'Jpsi', daughters: ['Kp', 'R_Keta'] },
      { mother: 'Jpsi', daughters: ['Km', 'R_Keta'] },
      { mother: 'R_KK', daughters: ['Kp', 'Km'] },
      { mother: 'R_Keta', daughters: ['Km', 'eta'] },
      { mother: 'R_Keta', daughters: ['Kp', 'eta'] },
    ]
    spec.chains[0]!.intermediates = [
      { name: 'R_KK', groups: [{ j: 1, p: -1 }] },
      { name: 'R_Keta', groups: [{ j: 1, p: -1 }] },
    ]
    spec.resonances = [
      { name: 'phi1020', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.0195, 0.0045] },
      { name: 'K1_1410', chain: 'R_Keta', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.403, 0.174] },
    ]
    spec.constraints = { maxL: 4, trans: [{ names: ['R_Keta_0', 'R_Keta_1'], value: [-1] }] }
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    const cfg = parseConfig(r.text!)
    expect(cfg.constraints.maxL).toBe(4)
    expect(cfg.constraints.trans).toEqual([{ names: ['R_Keta_0', 'R_Keta_1'], value: [-1] }])
  })

  it('writes Data samples and the Plot block', () => {
    const spec = minimal()
    spec.data = {
      order: ['Kp', 'Km', 'eta'],
      data: ['dat', './data.dat'],
      phsp: ['dat', './phsp.dat'],
      bkg: ['dat', './bkg.dat'],
    }
    spec.plot = [{ name: 'm_KK', expression: 'M([Kp,Km])', bins: [100], ranges: [[1.0, 2.6]] }]
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    const cfg = parseConfig(r.text!)
    const dataRaw = cfg.raw.get('Data') as Map<unknown, unknown>
    expect(dataRaw.get('bkg')).toEqual(['dat', './bkg.dat'])
    expect(Array.isArray(cfg.raw.get('Plot'))).toBe(true)
    // dumpConfig round-trip keeps the Plot entry
    expect(dumpConfig(cfg)).toContain('M([Kp,Km])')
  })

  it('empty [J,P] groups are legal (resonances added later)', () => {
    const spec = minimal()
    spec.resonances = []
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    const groups = r.config!.decayChains['decay1']!.intermediates['R_KK']!.groups
    expect(groups.map((g) => g.names)).toEqual([[], []])
  })
})

describe('buildInitialConfig: auto-generated Plot', () => {
  const plotEntries = (text: string): { name?: string; expression?: string; bins?: number[]; ranges?: number[][] }[] => {
    const cfg = parseConfig(text)
    const plot = cfg.raw.get('Plot')
    if (!Array.isArray(plot)) return []
    return plot.map((m) => {
      const map = m as Map<unknown, unknown>
      return {
        name: map.get('name') as string | undefined,
        expression: map.get('expression') as string | undefined,
        bins: map.get('bins') as number[] | undefined,
        ranges: map.get('ranges') as number[][] | undefined,
      }
    })
  }

  it('generates a mass spectrum + decay-angle distribution per intermediate step', () => {
    const r = buildInitialConfig(minimal(), defaultDb)
    expect(r.errors).toEqual([])
    const plot = plotEntries(r.text!)
    expect(plot.map((p) => p.name)).toEqual(['m_R_KK', 'cosbeta_R_KK'])
    expect(plot[0]!.expression).toBe('M([Kp,Km])')
    expect(plot[1]!.expression).toBe('CosAngle([Kp], [Kp,Km])')
    // mass window = [m(Kp)+m(Km), m(Jpsi)-m(eta)]
    expect(plot[0]!.ranges![0]![0]).toBeCloseTo(0.493677 * 2, 4)
    expect(plot[0]!.ranges![0]![1]).toBeCloseTo(3.0969 - 0.547862, 4)
    expect(plot[1]!.ranges).toEqual([[-1, 1]])
    expect(r.changed.some((c) => c.includes('Plot: 自动生成'))).toBe(true)
  })

  it('an explicit plot list wins over the auto generation', () => {
    const spec = minimal()
    spec.plot = [{ name: 'my_plot', expression: 'M([Kp,Km])', bins: [25], ranges: [[1, 2]] }]
    const r = buildInitialConfig(spec, defaultDb)
    const plot = plotEntries(r.text!)
    expect(plot).toHaveLength(1)
    expect(plot[0]!.name).toBe('my_plot')
    expect(plot[0]!.bins).toEqual([25])
  })

  it('plot: [] explicitly opts out (no Plot block)', () => {
    const spec = minimal()
    spec.plot = []
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    expect(parseConfig(r.text!).raw.get('Plot')).toBeUndefined()
  })

  it('multiple decay modes of one intermediate get distinct names', () => {
    const spec = minimal()
    spec.chains[0]!.steps = [
      { mother: 'Jpsi', daughters: ['eta', 'R_KK'] },
      { mother: 'Jpsi', daughters: ['Kp', 'R_Keta'] },
      { mother: 'R_KK', daughters: ['Kp', 'Km'] },
      { mother: 'R_Keta', daughters: ['Km', 'eta'] },
      { mother: 'R_Keta', daughters: ['Kp', 'eta'] },
    ]
    spec.chains[0]!.intermediates = [
      { name: 'R_KK', groups: [{ j: 1, p: -1 }] },
      { name: 'R_Keta', groups: [{ j: 1, p: -1 }] },
    ]
    spec.resonances = [
      { name: 'phi1020', chain: 'R_KK', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.0195, 0.0045] },
      { name: 'K1_1410', chain: 'R_Keta', jpGroup: { j: 1, p: -1 }, model: 'BWR', parameters: [1.403, 0.174] },
    ]
    const r = buildInitialConfig(spec, defaultDb)
    const names = plotEntries(r.text!).map((p) => p.name)
    expect(names).toContain('m_R_Keta_0')
    expect(names).toContain('m_R_Keta_1')
    expect(new Set(names).size).toBe(names.length)
    // Several production modes may live under ONE chain label: ctpwa expands
    // the mode list into its own internal chains. Splitting into decay1/decay2
    // is organizational, not a tool requirement.
    const cfg = parseConfig(r.text!)
    expect(Object.keys(cfg.decayChains)).toEqual(['decay1'])
    const rawChains = cfg.raw.get('DecayChains') as Map<unknown, unknown>
    const chain = rawChains.get('decay1') as Map<unknown, unknown>
    expect(chain.get('Jpsi')).toEqual([
      ['eta', 'R_KK'],
      ['Kp', 'R_Keta'],
    ])
  })

  it('does not auto-plot a cascade step whose daughter is an intermediate', () => {
    // ctpwa plot expressions resolve names against FINAL-STATE particles; an
    // expression such as M([Kp,R_Keta]) is skipped at fill time.
    const spec = minimal()
    spec.chains[0]!.steps = [
      { mother: 'Jpsi', daughters: ['eta', 'R_KK'] },
      { mother: 'R_KK', daughters: ['Kp', 'R_Keta'] },
      { mother: 'R_Keta', daughters: ['Km', 'eta'] },
    ]
    spec.chains[0]!.intermediates = [
      { name: 'R_KK', groups: [{ j: 1, p: -1 }] },
      { name: 'R_Keta', groups: [{ j: 1, p: -1 }] },
    ]
    spec.resonances = []
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    const plot = plotEntries(r.text!)
    expect(plot.map((p) => p.name)).toEqual(['m_R_Keta', 'cosbeta_R_Keta'])
    expect(plot.some((p) => p.expression!.includes('R_Keta'))).toBe(false)
  })
})

describe('buildInitialConfig: compact ctpwa form and polarization', () => {
  it('writes a single production mode as a mode list (Jpsi: [[eta, R_KK]])', () => {
    // ctpwa's compact-format detector requires kv.second[0].IsSequence() for
    // the production key. A flat pair parses "valid" but yields 0 amplitudes.
    const r = buildInitialConfig(minimal(), defaultDb)
    expect(r.errors).toEqual([])
    const chains = parseConfig(r.text!).raw.get('DecayChains') as Map<unknown, unknown>
    const chain = chains.get('decay1') as Map<unknown, unknown>
    expect(chain.get('Jpsi')).toEqual([['eta', 'R_KK']])
    expect(chain.get('R_KK')).toEqual([['Kp', 'Km']])
  })

  it('carries polarization through to the Particles block', () => {
    const spec = minimal()
    spec.particles[0]!.polarization = [-1, 1]
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    const particles = parseConfig(r.text!).raw.get('Particles') as Map<unknown, unknown>
    const jpsi = particles.get('Jpsi') as Map<unknown, unknown>
    expect(jpsi.get('polarization')).toEqual([-1, 1])
  })
})

describe('buildInitialConfig: Data file check (baseDir)', () => {
  it('warns for missing data/phsp files and accepts existing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-pwa-data-'))
    try {
      writeFileSync(join(dir, 'data.dat'), 'x')
      const spec = minimal()
      spec.data = { order: ['Kp', 'Km', 'eta'], data: ['dat', './data.dat'], phsp: ['dat', './phsp.dat'] }
      const r = buildInitialConfig(spec, defaultDb, { baseDir: dir })
      const codes = r.warnings.map((w) => w.code)
      expect(codes).toContain('data-file-missing')
      expect(r.warnings.find((w) => w.code === 'data-file-missing')!.message).toContain('phsp.dat')
      expect(r.warnings.find((w) => w.code === 'data-file-missing')!.message).not.toContain('data.dat')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a malformed sample list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-pwa-data-'))
    try {
      const spec = minimal()
      spec.data = { order: ['Kp', 'Km', 'eta'], data: ['dat'], phsp: ['dat', './phsp.dat'] }
      const r = buildInitialConfig(spec, defaultDb, { baseDir: dir })
      expect(r.warnings.map((w) => w.code)).toContain('data-sample-malformed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no file check without baseDir (buildInitialConfig stays I/O-free by default)', () => {
    const r = buildInitialConfig(minimal(), defaultDb)
    expect(r.warnings.map((w) => w.code)).not.toContain('data-file-missing')
  })
})

describe('buildInitialConfig: 4-body first-level topology gate', () => {
  /** J/psi -> eta' pi+ pi- pi0 with only ONE of the seven first-level partitions. */
  const partial = (): InitialConfigSpec => ({
    particles: [
      { name: 'Jpsi', pdgid: 443 },
      { name: 'etap', pdgid: 331 },
      { name: 'pip', pdgid: 211 },
      { name: 'pim', pdgid: -211 },
      { name: 'pi0', pdgid: 111 },
    ],
    chains: [
      {
        name: 'decay1',
        steps: [
          { mother: 'Jpsi', daughters: ['etap', 'R_3pi'] },
          { mother: 'R_3pi', daughters: ['pi0', 'R_pipi'] },
          { mother: 'R_pipi', daughters: ['pip', 'pim'] },
        ],
        intermediates: [
          { name: 'R_3pi', groups: [{ j: 1, p: -1 }] },
          { name: 'R_pipi', groups: [{ j: 1, p: -1 }] },
        ],
      },
    ],
    resonances: [],
    data: { order: ['etap', 'pip', 'pim', 'pi0'], data: ['dat', './data.dat'] },
  })

  const missingExclusions = (): { kind: string; particles: string[][]; reason: string }[] => [
    { kind: '1+3', particles: [['pip'], ['etap', 'pim', 'pi0']], reason: 'test' },
    { kind: '1+3', particles: [['pim'], ['etap', 'pip', 'pi0']], reason: 'test' },
    { kind: '1+3', particles: [['pi0'], ['etap', 'pip', 'pim']], reason: 'test' },
    { kind: '2+2', particles: [['etap', 'pip'], ['pim', 'pi0']], reason: 'test' },
    { kind: '2+2', particles: [['etap', 'pim'], ['pip', 'pi0']], reason: 'test' },
    { kind: '2+2', particles: [['etap', 'pi0'], ['pip', 'pim']], reason: 'test' },
  ]

  it('preview warns but stays non-blocking', () => {
    const r = buildInitialConfig(partial(), defaultDb)
    expect(r.errors).toEqual([])
    const w = r.warnings.find((x) => x.code === 'topology-incomplete')!
    expect(w).toBeDefined()
    expect(w.message).toContain('2+2')
    expect(w.message).toContain('topology.excluded')
  })

  it('write path also stays advisory (no hard block)', () => {
    const r = buildInitialConfig(partial(), defaultDb)
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).toContain('topology-incomplete')
    expect(r.warnings.find((w) => w.code === 'topology-incomplete')!.message).toContain('2+2')
    expect(r.text).toBeDefined()
  })

  it('accepts an incomplete model when every missing partition is explicitly excluded', () => {
    const spec = partial()
    spec.topology = { excluded: missingExclusions() }
    const r = buildInitialConfig(spec, defaultDb)
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).toContain('topology-excluded')
    expect(r.text).toBeDefined()
  })
})
