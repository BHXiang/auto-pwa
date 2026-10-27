/**
 * First-level topology coverage for multi-body isobar analyses.
 *
 * ctpwa's amplitude is two-body per vertex, so an n-body final state must be
 * organized as a cascade. The *first* decay of the production particle is
 * two-body:
 *
 *   A -> B1 + B2,   with each Bi either a final-state particle or an
 *                   intermediate R_i containing the rest of its side.
 *
 * For J/psi -> eta' pi+ pi- pi0 (n = 4) that is:
 *
 *   1+3 : eta' + R(pi+pi-pi0), pi+ + R(eta'pi-pi0), ...
 *   2+2 : R(eta'pi+) + R(pi-pi0), ...
 *
 * For n = 5 it is 1+4 and 2+3; for n = 6 also 3+3. Not every partition is
 * physically enhanced, and the data may not support all of them — but a
 * multi-body model is incomplete until each one has been considered and
 * either included or explicitly rejected. This module makes the partition
 * list and the config's coverage visible to the tools/skills.
 *
 * Pure functions; no I/O.
 */
import type { PwaConfig } from './types.js'

/** A side of a first-level partition: one particle, or an intermediate that
 * contains several final-state particles. */
export interface TopologySide {
  /** Final-state particle names on this side, in Data.order order. */
  particles: string[]
  /** Intermediate realizing a multi-particle side (absent for a single
   * particle). */
  intermediate?: string
}

export interface TopologyRealization {
  chain: string
  mother: string
  daughters: [string, string]
}

export interface FirstLevelTopology {
  /** "1+3", "2+2", ... */
  kind: string
  sides: [TopologySide, TopologySide]
  /** True when some production step realizes this partition. */
  present: boolean
  realizedBy?: TopologyRealization
}

export interface TopologyCoverage {
  finalState: string[]
  topologies: FirstLevelTopology[]
  present: number
  total: number
}

/** Structural subset of PwaConfig used here (also satisfied by test fixtures). */
export interface TopologyConfig {
  particles: Record<string, unknown>
  decayChains: Record<
    string,
    {
      steps: { mother: string; daughters: readonly [string, string] }[]
      intermediates: Record<string, unknown>
    }
  >
}

/** All k-element index combinations of 0..n-1. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = []
  const pick = (start: number, cur: number[]): void => {
    if (cur.length === k) {
      out.push([...cur])
      return
    }
    for (let i = start; i < n; i++) {
      cur.push(i)
      pick(i + 1, cur)
      cur.pop()
    }
  }
  pick(0, [])
  return out
}

/**
 * Enumerate every first-level partition of `finalState` and mark the ones a
 * config actually realizes.
 *
 * A side with one particle matches a production daughter of that name; a side
 * with several particles matches an intermediate whose recursive final-state
 * content is exactly that set. The production mother must not itself be an
 * intermediate (cascade steps are not first-level).
 */
export function firstLevelTopologies(
  config: TopologyConfig,
  finalState: readonly string[],
): TopologyCoverage {
  const names = [...finalState]
  const finalSet = new Set(names)
  const contentCache = new Map<string, Set<string>>()

  const isIntermediate = (chain: TopologyConfig['decayChains'][string], name: string): boolean =>
    chain.intermediates[name] !== undefined

  /** Recursive final-state content of a daughter (particle or intermediate). */
  const contentOf = (
    chainName: string,
    chain: TopologyConfig['decayChains'][string],
    name: string,
    seen: Set<string>,
  ): Set<string> => {
    const key = `${chainName}\u0000${name}`
    const cached = contentCache.get(key)
    if (cached !== undefined) return cached
    if (!isIntermediate(chain, name)) {
      const one = new Set([name])
      contentCache.set(key, one)
      return one
    }
    if (seen.has(name)) return new Set()
    seen.add(name)
    const out = new Set<string>()
    for (const step of chain.steps) {
      if (step.mother !== name) continue
      for (const d of step.daughters) {
        for (const x of contentOf(chainName, chain, d, seen)) out.add(x)
      }
    }
    seen.delete(name)
    contentCache.set(key, out)
    return out
  }

  interface Production {
    chain: string
    mother: string
    daughters: [string, string]
    isIntermediate: [boolean, boolean]
    content: [Set<string>, Set<string>]
  }
  const productions: Production[] = []
  for (const [chainName, chain] of Object.entries(config.decayChains)) {
    for (const step of chain.steps) {
      if (isIntermediate(chain, step.mother)) continue
      if (finalSet.has(step.mother)) continue
      const daughters = [step.daughters[0], step.daughters[1]] as [string, string]
      productions.push({
        chain: chainName,
        mother: step.mother,
        daughters,
        isIntermediate: [isIntermediate(chain, daughters[0]), isIntermediate(chain, daughters[1])],
        content: [
          contentOf(chainName, chain, daughters[0], new Set()),
          contentOf(chainName, chain, daughters[1], new Set()),
        ],
      })
    }
  }

  const sameSet = (a: Set<string>, b: readonly string[]): boolean =>
    a.size === b.length && b.every((x) => a.has(x))

  const sideMatches = (side: TopologySide, prod: Production, i: 0 | 1): boolean => {
    if (!sameSet(prod.content[i], side.particles)) return false
    return side.particles.length === 1 ? prod.isIntermediate[i] === false : prod.isIntermediate[i] === true
  }

  const all: FirstLevelTopology[] = []
  const n = names.length
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    const total = n - k
    for (const combo of combinations(n, k)) {
      const comboSet = new Set(combo)
      const comp = names.map((_, i) => i).filter((i) => !comboSet.has(i))
      // Equal-size partition pairs are generated twice (side A/B swapped).
      if (k === total && combo[0]! > comp[0]!) continue
      const sideNames: [string[], string[]] = [combo.map((i) => names[i]!), comp.map((i) => names[i]!)]
      const sides: [TopologySide, TopologySide] = [
        { particles: sideNames[0]! },
        { particles: sideNames[1]! },
      ]
      let realizedBy: TopologyRealization | undefined
      for (const prod of productions) {
        const direct = sideMatches(sides[0], prod, 0) && sideMatches(sides[1], prod, 1)
        const swapped = !direct && sideMatches(sides[0], prod, 1) && sideMatches(sides[1], prod, 0)
        if (!direct && !swapped) continue
        const i0: 0 | 1 = direct ? 0 : 1
        const i1: 0 | 1 = direct ? 1 : 0
        if (sides[0].particles.length > 1) sides[0].intermediate = prod.daughters[i0]
        if (sides[1].particles.length > 1) sides[1].intermediate = prod.daughters[i1]
        realizedBy = { chain: prod.chain, mother: prod.mother, daughters: prod.daughters }
        break
      }
      all.push({ kind: `${k}+${total}`, sides, present: realizedBy !== undefined, ...(realizedBy !== undefined ? { realizedBy } : {}) })
    }
  }
  return {
    finalState: names,
    topologies: all,
    present: all.filter((t) => t.present).length,
    total: all.length,
  }
}

/** Convenience for a full PwaConfig (Data.order supplies the final state). */
export function topologyCoverageOf(config: PwaConfig, finalState: readonly string[]): TopologyCoverage {
  return firstLevelTopologies(config, finalState)
}
