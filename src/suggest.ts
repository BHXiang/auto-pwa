/**
 * auto_pwa_suggest: pull-driven candidate discovery (decision support).
 *
 * Turns the numeric evaluation package (evaluate.json) into a ranked list of
 * PDG resonances worth trying: for every intermediate, the allowed J^PC set
 * (shared analyzeIntermediateJPC) is intersected with the mass regions where
 * the fit shows pull > 3σ; PDG candidates whose mass sits inside/near those
 * regions are ranked by alignment distance.
 *
 * Pure functions; no I/O (callers pass parsed config + evaluate data).
 */
import { analyzeIntermediateJPC } from './intermediate-jpc.js'
import { lookupResonance } from './lookup.js'
import type { PwaConfig, ResonanceDb } from './types.js'

export interface EvaluateDistribution {
  /** Distribution key (e.g. "mass_R_KK"); entries inside `distributions`
   * are keyed by name, so the field is optional on the value. */
  name?: string
  max_abs_pull?: number | null
  pull_regions_over_3sigma?: [number, number][] | null
  worst_bin?: { center?: number; pull?: number } | null
  range?: [number, number] | null
}

export interface EvaluateData {
  distributions?: Record<string, EvaluateDistribution>
}

export interface CandidateSuggestion {
  intermediate: string
  chain: string
  jpc: string
  c: 1 | -1 | null
  resonance: { id: string; mass: number; width: number | null }
  /** |mass - region center| in GeV; null when no region was aligned. */
  alignGap: number | null
  /** The pull region this candidate aligns to, if any. */
  targetRegion: [number, number] | null
  /** Threshold m_R <= m_mother - m_daughter (production). */
  threshold: number | null
  /** threshold - mass (negative = would exceed). */
  margin: number | null
  /** PDG lists a decay mode hitting the requested final state. */
  decaysTo: boolean
  reason: string
}

export interface SuggestOptions {
  /** Orbital-momentum cap; default config Constraints.maxL, else 4. */
  maxL?: number
  /** Final-state particles to flag (decay-mode hits). */
  decayTo?: string[]
  /** Max candidates per intermediate; default 8. */
  maxPerIntermediate?: number
  /** Alignment window around a pull region; default 0.5 GeV. */
  alignWindow?: number
}

/** Mass distributions whose name embeds `intName` (e.g. "mass_R_KK"). */
function massDistributionsFor(evaluate: EvaluateData, intName: string): EvaluateDistribution[] {
  const out: EvaluateDistribution[] = []
  for (const [name, d] of Object.entries(evaluate.distributions ?? {})) {
    if (!/mass/i.test(name)) continue
    // Match "mass_R_KK" / "massR_KK" style suffixes, case-insensitively.
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    const int = intName.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (int.length > 0 && norm.endsWith(int)) {
      const { name: _ignored, ...rest } = d
      out.push({ name, ...rest })
    }  }
  return out
}

/**
 * Build ranked candidate suggestions per intermediate from the pull regions.
 * Candidates are PDG resonances whose J^P matches an allowed wave of the
 * intermediate; alignment = distance from the pull-region center.
 */
export function suggestCandidates(
  config: PwaConfig,
  db: ResonanceDb,
  evaluate: EvaluateData,
  options: SuggestOptions = {},
): CandidateSuggestion[] {
  const maxL = options.maxL ?? config.constraints?.maxL ?? 4
  const maxPer = options.maxPerIntermediate ?? 8
  const window = options.alignWindow ?? 0.5
  const out: CandidateSuggestion[] = []

  for (const [chainName, chain] of Object.entries(config.decayChains)) {
    for (const intName of Object.keys(chain.intermediates)) {
      const ana = analyzeIntermediateJPC(config, db, intName, { maxL })
      if (ana === undefined || ana.allowed.length === 0) continue
      const kin = config.kinematics[intName]
      const threshold = kin?.threshold ?? null
      // Collect pull regions from every mass distribution of this intermediate.
      const regions: [number, number][] = []
      for (const d of massDistributionsFor(evaluate, intName)) {
        for (const r of d.pull_regions_over_3sigma ?? []) regions.push(r)
      }
      // One entry per PDG resonance (dedup by id across J^PC waves).
      const seen = new Set<string>()
      const candidates: CandidateSuggestion[] = []
      for (const w of ana.allowed) {
        const hits = lookupResonance(db, { jp: { j: w.j, p: w.p } })
          .filter((r) => {
            if (w.c === null) return true
            return r.c === w.c || r.c === undefined
          })
          .filter((r) => threshold === null || r.mass <= threshold + 0.05) // near/under threshold
        for (const r of hits) {
          if (seen.has(r.id)) continue
          seen.add(r.id)
          // Align to the pull region with the closest center.
          let best: { gap: number; region: [number, number] } | null = null
          for (const reg of regions) {
            const center = (reg[0] + reg[1]) / 2
            const gap = Math.abs(r.mass - center)
            if (best === null || gap < best.gap) best = { gap, region: reg }
          }
          const inWindow = best !== null && best.gap <= window
          if (best !== null && !inWindow) best = null // outside the window: not pull-driven
          const decaysTo = options.decayTo !== undefined && options.decayTo.length > 0
            ? (r.decayModes ?? []).some((m) => options.decayTo!.every((d) => m.daughters.some((x) => x.toLowerCase() === d.toLowerCase())))
            : false
          candidates.push({
            intermediate: intName,
            chain: chainName,
            jpc: w.jpc,
            c: w.c,
            resonance: { id: r.id, mass: r.mass, width: r.width ?? null },
            alignGap: best?.gap ?? null,
            targetRegion: best?.region ?? null,
            threshold,
            margin: threshold !== null ? threshold - r.mass : null,
            decaysTo,
            reason: best !== null
              ? `质量 ${r.mass.toFixed(3)} 落在 pull 区 [${best.region[0].toFixed(3)}, ${best.region[1].toFixed(3)}]（偏差 ${best.gap.toFixed(3)} GeV）`
              : `无 pull 区对齐，物理允许候选（阈值余量 ${(threshold !== null ? threshold - r.mass : 0).toFixed(3)} GeV）`,
          })
        }
      }
      // Rank: pull-aligned first (by gap), then by margin (physically closest
      // under threshold).
      candidates.sort((a, b) => {
        const aAligned = a.alignGap !== null ? 0 : 1
        const bAligned = b.alignGap !== null ? 0 : 1
        if (aAligned !== bAligned) return aAligned - bAligned
        if (a.alignGap !== null && b.alignGap !== null && a.alignGap !== b.alignGap) return a.alignGap - b.alignGap
        return (b.margin ?? -1) - (a.margin ?? -1)
      })
      out.push(...candidates.slice(0, maxPer))
    }
  }
  return out
}
