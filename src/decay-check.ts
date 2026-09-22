/**
 * auto_pwa_decay_check: which intermediate-resonance J^P are allowed for a
 * two-step decay A -> R + B (R then decays to the final states)?
 *
 * Quantum rules for A -> R + B, with L the orbital momentum between R and B:
 *   - Angular momentum: J_A ∈ J_R ⊗ L ⊗ J_B  (triangle rule, L integer >= 0)
 *   - Parity:            P_A = P_R * P_B * (-1)^L
 * Kinematic: a candidate resonance must satisfy m_R <= m_A - m_B (on-shell).
 *
 * Pure function; no I/O.
 */
import { normalizeName } from './lookup.js'
import type {
  AllowedJP,
  Candidate,
  DecayCheckOptions,
  DecayCheckResult,
  Particle,
  ResonanceDb,
} from './types.js'

/** Whether any listed decay mode of `entry` covers all requested daughters. */
export function hasDecayTo(entry: { decayModes?: { daughters: string[] }[] }, daughters: string[]): boolean {
  const wanted = daughters.map(normalizeName)
  return (entry.decayModes ?? []).some((mode) => {
    const have = new Set(mode.daughters.map(normalizeName))
    return wanted.every((d) => have.has(d))
  })
}

/**
 * Enumerate allowed (J_R, P_R) for A -> R + B.
 *
 * J_R lives on the 0.5 grid, not the integer grid: with a half-integer
 * mother or spectator (nucleon resonances, hyperons, ...) the reachable
 * J_R are half-integers. The triangle rule for three angular momenta is
 *   |J_i - J_j| <= J_k <= J_i + J_j   AND   J_i + J_j + J_k integer,
 * so the enumeration is done in doubled spins (twoJ = 2J) to stay exact:
 *   - twoJ'' = 2(L ⊗ J_B) runs over |2L - 2J_B| .. 2L + 2J_B step 2;
 *   - twoJ_R runs over 0 .. 2(J_A + J_B + maxL) step 1 (both integer and
 *     half-integer candidates), kept only when twoJ_R + twoJ'' + twoJ_A
 *     is even (the integer-sum / angular-momentum-coupling condition).
 * Integer-spin inputs therefore still yield exactly the old integer set.
 *
 * @param mother   particle A
 * @param daughter particle B (the non-resonant daughter)
 * @param maxL     maximum orbital momentum to consider. Analyses constrain
 *                 this (e.g. ctpwa `maxL: 3`); J/psi studies rarely need > 4.
 */
export function allowedIntermediateJP(
  mother: Particle,
  daughter: Particle,
  maxL = 4,
): AllowedJP[] {
  const twoJa = Math.round(mother.j * 2)
  const twoJb = Math.round(daughter.j * 2)
  const twoJrMax = twoJa + twoJb + 2 * maxL
  const result: AllowedJP[] = []
  // J_R on the 0.5 grid; parity selects which of them are realized by some L.
  for (let twoJr = 0; twoJr <= twoJrMax; twoJr++) {
    const jr = twoJr / 2
    // Same J_R can carry both parities via different L; collect per parity.
    for (const pr of [1, -1] as const) {
      const Ls: number[] = []
      for (let L = 0; L <= maxL; L++) {
        const twoL = 2 * L
        // J'' = L ⊗ J_B takes values in [|L - jb|, L + jb].
        const twoJppLo = Math.abs(twoL - twoJb)
        const twoJppHi = twoL + twoJb
        const parity = mother.p * daughter.p * (L % 2 === 0 ? 1 : -1)
        if (parity !== pr) continue
        for (let twoJpp = twoJppLo; twoJpp <= twoJppHi; twoJpp += 2) {
          const couples =
            Math.abs(twoJr - twoJpp) <= twoJa &&
            twoJa <= twoJr + twoJpp &&
            (twoJr + twoJpp + twoJa) % 2 === 0
          if (couples) {
            Ls.push(L)
            break
          }
        }
      }
      if (Ls.length > 0) result.push({ jp: { j: jr, p: pr }, L: Ls })
    }
  }
  return result.sort((a, b) => a.jp.j - b.jp.j || a.jp.p - b.jp.p)
}

/**
 * Full decay check: allowed J^P plus table candidates below the mass
 * threshold m_R <= m_A - m_B (plus a small tolerance for off-shell tails).
 *
 * With `decayTo`, candidates whose listed decay modes include the requested
 * daughters sort first and are flagged via `decaysTo`; the filter never
 * excludes an entry (a missing mode is a data gap, not a physics veto).
 */
export function decayCheck(
  mother: Particle,
  daughter: Particle,
  db: ResonanceDb,
  options: DecayCheckOptions = {},
): DecayCheckResult {
  const { maxL = 4, massTolerance = 0, decayTo } = options
  const allowed = allowedIntermediateJP(mother, daughter, maxL)
  const threshold = mother.mass - daughter.mass + massTolerance
  const candidates = allowed.map(({ jp }) => {
    const resonances: Candidate[] = db.resonances
      .filter((r) => r.jp.j === jp.j && r.jp.p === jp.p && r.mass <= threshold)
      .map((entry) => ({
        entry,
        decaysTo: decayTo === undefined ? undefined : hasDecayTo(entry, decayTo),
      }))
    if (decayTo !== undefined) {
      resonances.sort((a, b) => {
        if (a.decaysTo !== b.decaysTo) return a.decaysTo ? -1 : 1
        return a.entry.mass - b.entry.mass
      })
    } else {
      resonances.sort((a, b) => a.entry.mass - b.entry.mass)
    }
    return { jp, resonances }
  })
  return { allowed, candidates }
}
