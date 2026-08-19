/**
 * auto_pwa_lookup: query the resonance table (data/pdg.json).
 * Pure function over ResonanceDb; no I/O.
 */
import type { LookupQuery, ResonanceDb, ResonanceEntry } from './types.js'

/**
 * Normalize a particle name for matching: lowercase, keep alphanumerics only.
 * Electric charge is preserved when attached to the name ("K+" -> "kp",
 * "K-" -> "km"), but dropped after a symbol so "K*+" does not collide with
 * "K+" ("K*+" -> "k", matching plain K). Known limitation: "K*+" and "K*-"
 * both normalize to "k".
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?<=[a-z0-9])[+-]/g, (c) => (c === '+' ? 'p' : 'm'))
    .replace(/[^a-z0-9]/g, '')
}

function matchesName(entry: ResonanceEntry, query: string): boolean {
  const q = normalizeName(query)
  if (normalizeName(entry.id) === q) return true
  return entry.aliases.some((a) => normalizeName(a) === q)
}

function matchesJp(entry: ResonanceEntry, jp: { j: number; p: number }): boolean {
  return entry.jp.j === jp.j && entry.jp.p === jp.p
}

function matchesJpc(entry: ResonanceEntry, jpc: { j: number; p: number; c?: number }): boolean {
  if (entry.jp.j !== jpc.j || entry.jp.p !== jpc.p) return false
  // A C-specific query never matches entries without a defined C.
  return jpc.c === undefined || entry.c === jpc.c
}

function matchesMass(entry: ResonanceEntry, range: [number, number]): boolean {
  return entry.mass >= range[0] && entry.mass <= range[1]
}

function matchesDecayTo(entry: ResonanceEntry, daughters: string[]): boolean {
  const wanted = daughters.map(normalizeName)
  return (entry.decayModes ?? []).some((mode) => {
    const have = new Set(mode.daughters.map(normalizeName))
    return wanted.every((d) => have.has(d))
  })
}

/**
 * Query the resonance table. All non-empty query fields combine with AND.
 * @returns matches sorted by mass ascending.
 */
export function lookupResonance(db: ResonanceDb, query: LookupQuery): ResonanceEntry[] {
  const hits = db.resonances.filter((entry) => {
    if (query.name !== undefined && !matchesName(entry, query.name)) return false
    if (query.jp !== undefined && !matchesJp(entry, query.jp)) return false
    if (query.jpc !== undefined && !matchesJpc(entry, query.jpc)) return false
    if (query.massRange !== undefined && !matchesMass(entry, query.massRange)) return false
    if (query.decayTo !== undefined && !matchesDecayTo(entry, query.decayTo)) return false
    return true
  })
  return hits.sort((a, b) => a.mass - b.mass)
}

/**
 * Charge conjugation of a particle by name (self-conjugate states only).
 * @returns +1/-1, or undefined when the name is unknown or C is not defined.
 */
export function lookupC(db: ResonanceDb, name: string): 1 | -1 | undefined {
  return lookupResonance(db, { name })[0]?.c
}
