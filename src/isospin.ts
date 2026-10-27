/**
 * General isospin / C-parity helper for `Constraints.trans`.
 *
 * ctpwa has spin–orbit CG coefficients but **no isospin**; the relative
 * couplings of charge-related chains must be supplied through `trans`.
 * This module computes the isospin Clebsch–Gordan product for an arbitrary
 * two-body decay tree. It is reaction-agnostic: callers provide I, I3 (and
 * optionally C) for every state; nothing here is specific to J/psi -> eta' 3pi.
 *
 * The CG convention is Condon–Shortley (the standard one used by ctpwa's
 * spin CG). Daughter ordering is the order in the supplied `steps`; if the
 * config orders daughters differently, the caller must pass that order.
 */

export interface IsoParticle {
  /** Total isospin I (integer or half-integer). */
  I: number
  /** Third component I3 (integer or half-integer). */
  I3: number
  /** C parity, when defined (self-conjugate neutral state). */
  C?: 1 | -1
}

export interface TransStep {
  mother: string
  daughters: [string, string]
}

export interface TransChain {
  name: string
  steps: TransStep[]
}

export interface TransVertexFactor {
  mother: string
  daughters: [string, string]
  cg: number
}

export interface TransRatio {
  base: string
  target: string
  /** target coupling / base coupling = CG(target) / CG(base). */
  ratio: number
  cgBase: number
  cgTarget: number
  /** C consistency of every vertex with supplied C values. */
  cStatus: 'ok' | 'violation' | 'unknown'
  vertexFactors: TransVertexFactor[]
}

export interface TransSuggestion {
  ok: boolean
  errors: { code: string; message: string }[]
  warnings: { code: string; message: string }[]
  ratios: TransRatio[]
  /** Ready-to-paste ctpwa Constraints.trans entry. */
  trans: { names: string[]; value: number[] } | null
}

const EPS = 1e-9

function isHalfInteger(x: number): boolean {
  return Math.abs(x * 2 - Math.round(x * 2)) < EPS
}

function factorial(n: number): number {
  const r = Math.round(n)
  if (Math.abs(n - r) > EPS || r < 0) return Number.NaN
  let out = 1
  for (let i = 2; i <= r; i++) out *= i
  return out
}

/**
 * SU(2) Clebsch–Gordan coefficient <j1 m1; j2 m2 | J M> (Condon–Shortley).
 * Returns 0 for forbidden combinations.
 */
export function clebschGordan(j1: number, m1: number, j2: number, m2: number, J: number, M: number): number {
  if (![j1, m1, j2, m2, J, M].every((x) => Number.isFinite(x))) return 0
  if (![j1, j2, J].every((x) => x >= 0 && isHalfInteger(x))) return 0
  if (!isHalfInteger(m1) || !isHalfInteger(m2) || !isHalfInteger(M)) return 0
  if (Math.abs(M - (m1 + m2)) > EPS) return 0
  if (Math.abs(m1) > j1 + EPS || Math.abs(m2) > j2 + EPS || Math.abs(M) > J + EPS) return 0
  if (J < Math.abs(j1 - j2) - EPS || J > j1 + j2 + EPS) return 0

  const a = j1 + j2 - J
  const b = j1 - j2 + J
  const c = -j1 + j2 + J
  if (a < -EPS || b < -EPS || c < -EPS) return 0

  const prefactor =
    (2 * J + 1) *
    factorial(a) *
    factorial(b) *
    factorial(c) /
    factorial(j1 + j2 + J + 1)
  const weight =
    factorial(j1 + m1) *
    factorial(j1 - m1) *
    factorial(j2 + m2) *
    factorial(j2 - m2) *
    factorial(J + M) *
    factorial(J - M)
  if (!Number.isFinite(prefactor) || !Number.isFinite(weight) || prefactor < 0 || weight < 0) return 0

  const kMin = Math.max(0, Math.ceil(j2 - J - m1 - EPS), Math.ceil(j1 - J + m2 - EPS))
  const kMax = Math.min(Math.floor(a + EPS), Math.floor(j1 - m1 + EPS), Math.floor(j2 + m2 + EPS))
  let sum = 0
  for (let k = kMin; k <= kMax; k++) {
    const den =
      factorial(k) *
      factorial(a - k) *
      factorial(j1 - m1 - k) *
      factorial(j2 + m2 - k) *
      factorial(J - j2 + m1 + k) *
      factorial(J - j1 - m2 + k)
    if (!Number.isFinite(den) || den === 0) continue
    sum += ((k % 2 === 0 ? 1 : -1) * 1) / den
  }
  if (!Number.isFinite(sum)) return 0
  const value = Math.sqrt(prefactor * weight) * sum
  return Math.abs(value) < 1e-12 ? 0 : value
}

function isoOf(particles: Record<string, IsoParticle>, name: string): IsoParticle | undefined {
  return particles[name]
}

/** Product of isospin CG coefficients over all decay vertices of one chain. */
export function chainIsospinFactor(
  chain: TransChain,
  particles: Record<string, IsoParticle>,
): { factor: number; vertices: TransVertexFactor[] } | undefined {
  let factor = 1
  const vertices: TransVertexFactor[] = []
  for (const step of chain.steps) {
    const mother = isoOf(particles, step.mother)
    const d1 = isoOf(particles, step.daughters[0])
    const d2 = isoOf(particles, step.daughters[1])
    if (mother === undefined || d1 === undefined || d2 === undefined) return undefined
    const cg = clebschGordan(d1.I, d1.I3, d2.I, d2.I3, mother.I, mother.I3)
    factor *= cg
    vertices.push({ mother: step.mother, daughters: step.daughters, cg })
  }
  return { factor, vertices }
}

/** C consistency of every vertex; null if any C is not supplied. */
export function chainCCheck(
  chain: TransChain,
  particles: Record<string, IsoParticle>,
): 'ok' | 'violation' | 'unknown' {
  let unknown = false
  for (const step of chain.steps) {
    const mother = particles[step.mother]
    const d1 = particles[step.daughters[0]]
    const d2 = particles[step.daughters[1]]
    if (mother?.C === undefined || d1?.C === undefined || d2?.C === undefined) {
      unknown = true
      continue
    }
    if (mother.C !== d1.C * d2.C) return 'violation'
  }
  return unknown ? 'unknown' : 'ok'
}

/**
 * Generic trans suggestion.
 *
 * `ratio = CG(target) / CG(base)`; this is the relative coupling implied by
 * isospin. C is checked vertex-by-vertex when all C values are supplied; a
 * C violation is an error (the relation is not physical). The tool does not
 * know about a specific reaction or chain naming.
 */
export function suggestTransRatios(input: {
  base: string
  chains: TransChain[]
  particles: Record<string, IsoParticle>
  checkC?: boolean
}): TransSuggestion {
  const errors: { code: string; message: string }[] = []
  const warnings: { code: string; message: string }[] = []
  const baseChain = input.chains.find((c) => c.name === input.base)
  if (baseChain === undefined) {
    return {
      ok: false,
      errors: [{ code: 'unknown-base', message: `base chain "${input.base}" is not in chains` }],
      warnings,
      ratios: [],
      trans: null,
    }
  }
  if (input.chains.length < 2) {
    errors.push({ code: 'no-targets', message: 'need at least one target chain besides the base' })
  }
  const missing = new Set<string>()
  for (const c of input.chains) {
    for (const s of c.steps) {
      for (const n of [s.mother, ...s.daughters]) {
        if (input.particles[n] === undefined) missing.add(n)
      }
      if (s.daughters[0] === s.daughters[1]) {
        warnings.push({
          code: 'identical-daughters',
          message: `${c.name}: ${s.mother} -> ${s.daughters.join('+')} has identical daughters; CG alone may need an extra symmetry factor/ordering sign — verify with ΔNLL`,
        })
      }
    }
  }
  if (missing.size > 0) {
    errors.push({
      code: 'missing-isospin',
      message: `missing I/I3 (and optional C) for: ${[...missing].join(', ')} — supply them in particles; no reaction-specific table is assumed`,
    })
  }
  for (const [name, p] of Object.entries(input.particles)) {
    if (!Number.isFinite(p.I) || !Number.isFinite(p.I3) || p.I < 0 || Math.abs(p.I3) > p.I + EPS) {
      errors.push({ code: 'bad-isospin', message: `particles.${name}: need I >= |I3| (got I=${p.I}, I3=${p.I3})` })
    }
    if (!isHalfInteger(p.I) || !isHalfInteger(p.I3)) {
      errors.push({ code: 'bad-isospin', message: `particles.${name}: I and I3 must be integer/half-integer` })
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings, ratios: [], trans: null }

  const baseFactor = chainIsospinFactor(baseChain, input.particles)
  if (baseFactor === undefined) {
    errors.push({ code: 'unknown-factor', message: `could not compute CG for base "${input.base}"` })
    return { ok: false, errors, warnings, ratios: [], trans: null }
  }
  if (Math.abs(baseFactor.factor) < 1e-12) {
    errors.push({ code: 'base-forbidden', message: `base chain "${input.base}" has CG = 0 (forbidden by isospin)` })
    return { ok: false, errors, warnings, ratios: [], trans: null }
  }

  const ratios: TransRatio[] = []
  const targets: { name: string; ratio: number }[] = []
  for (const chain of input.chains) {
    if (chain.name === input.base) continue
    const f = chainIsospinFactor(chain, input.particles)
    if (f === undefined) {
      errors.push({ code: 'unknown-factor', message: `could not compute CG for "${chain.name}"` })
      continue
    }
    const ratio = f.factor / baseFactor.factor
    if (!Number.isFinite(ratio)) {
      errors.push({ code: 'bad-ratio', message: `non-finite ratio for "${chain.name}"` })
      continue
    }
    const cStatus = input.checkC === false ? 'unknown' : chainCCheck(chain, input.particles)
    if (cStatus === 'violation') {
      errors.push({ code: 'c-violation', message: `${chain.name} violates C at a vertex with supplied C values` })
    }
    if (cStatus === 'unknown') {
      warnings.push({
        code: 'c-unknown',
        message: `${chain.name}: not all C values supplied — isospin ratio computed, C compatibility not checked`,
      })
    }
    ratios.push({
      base: input.base,
      target: chain.name,
      ratio,
      cgBase: baseFactor.factor,
      cgTarget: f.factor,
      cStatus,
      vertexFactors: f.vertices,
    })
    targets.push({ name: chain.name, ratio })
  }
  if (ratios.length === 0) errors.push({ code: 'no-ratios', message: 'no usable target chains' })
  const trans = ratios.length > 0 ? { names: [input.base, ...targets.map((t) => t.name)], value: targets.map((t) => t.ratio) } : null
  return { ok: errors.length === 0, errors, warnings, ratios, trans }
}
