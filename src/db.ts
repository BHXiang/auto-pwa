/**
 * Loads data/pdg.json as a typed ResonanceDb.
 * The seed table ships with the package; fetch_pdg.py regenerates it from an
 * authoritative source and flips each entry's status to "pdg".
 */
import type { ResonanceDb } from './types.js'
import raw from '../data/pdg.json' with { type: 'json' }

/** The shipped resonance table. */
export const defaultDb: ResonanceDb = raw as unknown as ResonanceDb
