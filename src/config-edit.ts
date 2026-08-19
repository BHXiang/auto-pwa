/**
 * auto_pwa_config_edit: parse, validate, edit and re-render the ctpwa config.yml.
 *
 * The config contains YAML "complex keys" (`- [J: 1, P: -1]: [phi1680]`),
 * which js-yaml rejects; we use the `yaml` package with `mapAsMap: true` and
 * keep the whole document as nested Maps (`PwaConfig.raw`). The derived
 * plain-object views (particles/decayChains/resonances/kinematics) are what
 * the model-facing tools consume. Round-tripped output is verified parseable
 * by ctpwa (yaml-cpp): explicit-key syntax `? ... : ...` is standard YAML.
 *
 * Rendered output drops comments (config is a program artifact; tex fields
 * carry the physics labels). Data/Constraints/Plot sections are preserved
 * verbatim in structure.
 */
import { parseDocument, stringify } from 'yaml'
import { normalizeName } from './lookup.js'
import type {
  ChainKinematics,
  ConfigEditResult,
  JP,
  JPGroup,
  Particle,
  PwaConfig,
  ResonanceModel,
  ResonanceProposal,
  ResonanceSpec,
  ValidationIssue,
} from './types.js'
import { RESONANCE_MODELS } from './resonance-validate.js'

/** YAML mappings can have complex (non-string) keys, e.g. `[J: 1, P: -1]`. */
type YamlMap = Map<unknown, unknown>

/** Reserved chain keys that are not decay steps. */
const RESERVED_CHAIN_KEYS = new Set(['decay', 'intermediates', 'legend', 'legends', 'symmetrize'])

/** Accept both yaml Maps and plain objects (applyResonanceAddition inserts plain objects). */
const asMap = (v: unknown): YamlMap | undefined => {
  if (v instanceof Map) return v
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const m: YamlMap = new Map()
    for (const [k, val] of Object.entries(v)) m.set(k, val)
    return m
  }
  return undefined
}
const asArr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined)
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Parse config.yml text into a PwaConfig. Throws on YAML syntax errors.
 * @param text - full config.yml content
 */
export function parseConfig(text: string): PwaConfig {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new Error(`config.yml YAML error: ${doc.errors.map((e) => e.message).join('; ')}`)
  }
  const raw = doc.toJS({ mapAsMap: true }) as YamlMap
  return { raw, ...rebuildViews(raw) }
}

/** Re-derive the plain-object views from the raw Map document. */
export function rebuildViews(raw: YamlMap): Pick<PwaConfig, 'particles' | 'decayChains' | 'resonances' | 'kinematics'> {
  const particles: Record<string, Particle> = {}
  const resonances: Record<string, ResonanceSpec> = {}
  const decayChains: PwaConfig['decayChains'] = {}
  const kinematics: Record<string, ChainKinematics> = {}

  // --- Particles ----------------------------------------------------------
  const particlesRaw = asMap(raw.get('Particles')) ?? asMap(raw.get('particles'))
  if (particlesRaw) {
    for (const [name, propsRaw] of particlesRaw) {
      if (typeof name !== 'string') continue
      const props = asMap(propsRaw)
      if (!props) continue
      const j = transJValue(asStr(props.get('J')) ?? asNum(props.get('J')))
      const p = asNum(props.get('P'))
      const mass = asNum(props.get('mass'))
      if (j === undefined || p === undefined || mass === undefined) continue
      particles[name] = { j, p: p === 1 ? 1 : -1, mass }
    }
  }

  // --- Resonances ---------------------------------------------------------
  const resRaw = asMap(raw.get('Resonances')) ?? asMap(raw.get('resonances'))
  if (resRaw) {
    for (const [name, specRaw] of resRaw) {
      if (typeof name !== 'string') continue
      const spec = asMap(specRaw)
      if (!spec) continue
      const j = transJValue(asStr(spec.get('J')) ?? asNum(spec.get('J')))
      const p = asNum(spec.get('P'))
      const model = asStr(spec.get('model'))
      const parameters = asArr(spec.get('parameters'))?.map(asNum) ?? []
      if (j === undefined || p === undefined || model === undefined || parameters.some((x) => x === undefined)) continue
      const resonance: ResonanceSpec = {
        j,
        p: p === 1 ? 1 : -1,
        model: model as ResonanceModel,
        parameters: parameters as number[],
      }
      const free = asArr(spec.get('free'))?.map(asNum).filter((x): x is number => x !== undefined)
      if (free !== undefined) resonance.free = free
      const freeRange = asArr(spec.get('free_range'))
      if (freeRange !== undefined) {
        resonance.freeRange = freeRange
          .map((r) => {
            const row = asArr(r)
            return row && row.length >= 2 ? [asNum(row[0]), asNum(row[1])] : undefined
          })
          .filter((r): r is [number, number] => r !== undefined && r[0] !== undefined && r[1] !== undefined)
      }
      const tex = spec.get('tex')
      if (asStr(tex) !== undefined) resonance.tex = tex as string
      else if (asArr(tex) !== undefined) resonance.tex = tex as string[]
      const channels = asArr(spec.get('channels'))
      if (channels !== undefined) {
        resonance.channels = channels
          .map((c) => {
            const row = asArr(c)
            return row?.map(asNum).filter((x): x is number => x !== undefined)
          })
          .filter((r): r is number[] => r !== undefined)
      }
      resonances[name] = resonance
    }
  }

  // --- DecayChains --------------------------------------------------------
  const chainsRaw = asMap(raw.get('DecayChains')) ?? asMap(raw.get('decay_chains'))
  if (chainsRaw) {
    for (const [chainName, chainRaw] of chainsRaw) {
      if (typeof chainName !== 'string') continue
      const chain = asMap(chainRaw)
      if (!chain) continue
      const intEntries = collectIntermediateEntries(chain, particles)
      const intermediates: Record<string, { groups: JPGroup[] }> = {}
      for (const [intName, groupsRaw] of intEntries) {
        const groups = parseGroupList(groupsRaw)
        intermediates[intName] = { groups }
      }
      decayChains[chainName] = { intermediates }

      // --- kinematics: production steps A -> R + B ------------------------
      for (const { mother, daughters } of chainSteps(chain, intermediates)) {
        const motherParticle = particles[mother]
        if (!motherParticle) continue
        const intermediatesNames = new Set(Object.keys(intermediates))
        const res = daughters.filter((d) => intermediatesNames.has(d))
        const siblings = daughters.filter((d) => !intermediatesNames.has(d))
        if (res.length !== 1 || siblings.length !== 1) continue // 2-body production only
        const sibling = particles[siblings[0]]
        if (!sibling) continue
        const threshold = motherParticle.mass - sibling.mass
        const existing = kinematics[res[0]]
        if (!existing || threshold < existing.threshold) {
          kinematics[res[0]] = { mother: motherParticle, daughter: sibling, threshold }
        }
      }
    }
  }

  return { particles, decayChains, resonances, kinematics }
}

/** Collect (intermediate name, group list) entries from a chain: from the
 * explicit `intermediates:` sub-block, or from top-level spin-chain keys
 * (ctpwa compact format, e.g. example/config.yml and the KsKs solve1 config):
 *   R_Kpeta:
 *     - [J: 3, P: -1]: [K3_1780p]
 */
function collectIntermediateEntries(chain: YamlMap, particles: Record<string, Particle>): [string, unknown][] {
  const intermediatesRaw = asMap(chain.get('intermediates'))
  const entries: [string, unknown][] = []
  if (intermediatesRaw) {
    for (const [intName, groupsRaw] of intermediatesRaw) {
      if (typeof intName === 'string') entries.push([intName, groupsRaw])
    }
    return entries
  }
  for (const [k, v] of chain) {
    if (typeof k !== 'string' || RESERVED_CHAIN_KEYS.has(k)) continue
    if (particles[k] !== undefined) continue // production-step particle key
    const list = asArr(v)
    if (list && list.length > 0 && list.every(isSpinChainGroup)) entries.push([k, list])
  }
  return entries
}

/** Particles map from the raw document (used by apply for key disambiguation). */
function parseParticles(raw: YamlMap): Record<string, Particle> {
  const particles: Record<string, Particle> = {}
  const particlesRaw = asMap(raw.get('Particles')) ?? asMap(raw.get('particles'))
  if (!particlesRaw) return particles
  for (const [name, propsRaw] of particlesRaw) {
    if (typeof name !== 'string') continue
    const props = asMap(propsRaw)
    if (!props) continue
    const j = transJValue(asStr(props.get('J')) ?? asNum(props.get('J')))
    const p = asNum(props.get('P'))
    const mass = asNum(props.get('mass'))
    if (j === undefined || p === undefined || mass === undefined) continue
    particles[name] = { j, p: p === 1 ? 1 : -1, mass }
  }
  return particles
}

/** True when a list element is a spin-chain group map (complex JP key -> names). */
function isSpinChainGroup(v: unknown): boolean {
  const m = asMap(v)
  if (!m) return false
  for (const [key] of m) {
    if (decodeJpKey(key)) return true
  }
  return false
}

/** Parse a group list (`[{J,P}: [names], ...]`) into JPGroup[]. */
function parseGroupList(groupsRaw: unknown): JPGroup[] {
  const list = asArr(groupsRaw)
  if (!list) return []
  const groups: JPGroup[] = []
  for (const groupRaw of list) {
    const group = asMap(groupRaw)
    if (!group) continue
    for (const [key, namesRaw] of group) {
      const jp = decodeJpKey(key)
      const names = asArr(namesRaw)?.map(asStr).filter((s): s is string => s !== undefined) ?? []
      // Empty groups are legal: a [J,P] group may exist before any resonance is added.
      if (jp) groups.push({ jp, names })
    }
  }
  return groups
}

/** Enumerate production steps of a chain in either config format. */
function chainSteps(
  chain: YamlMap,
  intermediates: Record<string, unknown>,
): { mother: string; daughters: string[] }[] {
  const steps: { mother: string; daughters: string[] }[] = []
  // Format B: chain.decay = [ {Mother: [d1, d2]}, ... ]
  const decayList = asArr(chain.get('decay'))
  if (decayList) {
    for (const stepRaw of decayList) {
      const step = asMap(stepRaw)
      if (!step) continue
      for (const [mother, daughtersRaw] of step) {
        if (typeof mother !== 'string') continue
        const daughters = asArr(daughtersRaw)?.map(asStr).filter((s): s is string => s !== undefined) ?? []
        if (daughters.length > 0) steps.push({ mother, daughters })
      }
    }
    return steps
  }
  // Format A (solve2 style): chain keys are particle names (values are modes).
  for (const [mother, modesRaw] of chain) {
    if (typeof mother !== 'string') continue
    if (RESERVED_CHAIN_KEYS.has(mother)) continue
    if (asMap(modesRaw)) continue // intermediates sub-block or similar
    const list0 = asArr(modesRaw)
    if (list0 && list0.length > 0 && list0.every(isSpinChainGroup)) continue // compact spin-chain key
    const list = asArr(modesRaw)
    if (!list) continue
    const daughtersList = list.map((m) => asArr(m)?.map(asStr).filter((s): s is string => s !== undefined) ?? [])
    for (const daughters of daughtersList) {
      if (daughters.length > 0 && daughters.some((d) => d in intermediates)) {
        steps.push({ mother, daughters })
      }
    }
  }
  return steps
}

/** Decode an intermediates group key: `[{J:1},{P:-1}]` (or a JP flow map). */
export function decodeJpKey(key: unknown): JP | undefined {
  const seq = asArr(key)
  if (seq) {
    let j: number | undefined
    let p: 1 | -1 | undefined
    for (const el of seq) {
      const m = asMap(el)
      if (!m) continue
      const jv = asStr(m.get('J')) ?? asNum(m.get('J'))
      const pv = asNum(m.get('P'))
      if (jv !== undefined && j === undefined) j = transJValue(jv)
      if (pv !== undefined && p === undefined) p = pv === 1 ? 1 : -1
    }
    return j !== undefined && p !== undefined ? { j, p } : undefined
  }
  const m = asMap(key)
  if (m) {
    const jv = asStr(m.get('J')) ?? asNum(m.get('J'))
    const pv = asNum(m.get('P'))
    const j = jv === undefined ? undefined : transJValue(jv)
    return j !== undefined && pv !== undefined ? { j, p: pv === 1 ? 1 : -1 } : undefined
  }
  return undefined
}

/** Encode a JP into the explicit-key form ctpwa expects: [{J: j}, {P: p}]. */
export function encodeJpKey(jp: JP): unknown[] {
  return [{ J: jp.j }, { P: jp.p }]
}

/** Parse spin: "3/2" or "1.5" or 1 -> 1.5 / 1. */
function transJValue(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'number') return v
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v)
  if (m) return Number(m[1]) / Number(m[2])
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Apply a resonance addition to the config (mutates `config.raw` and rebuilds
 * the views). Structural errors (unknown chain/group, bad parameters, free
 * structure, duplicate) are returned without modifying the config. Physics
 * checks (PDG/JPC/threshold) belong to validateResonanceAddition and must run
 * first.
 */
export function applyResonanceAddition(config: PwaConfig, proposal: ResonanceProposal): ConfigEditResult {
  const errors: ValidationIssue[] = []
  const changed: string[] = []

  // --- structural checks --------------------------------------------------
  const chainsRaw = asMap(config.raw.get('DecayChains')) ?? asMap(config.raw.get('decay_chains'))
  if (!chainsRaw) {
    errors.push({ code: 'unknown-chain', message: 'config has no DecayChains section' })
    return { config, changed, errors }
  }
  // The proposal's `chain` is an intermediate name (e.g. R_KK), which may live
  // in one or more decay chains; find every group list that references it.
  const groupLists: { chainName: string; list: unknown[] }[] = []
  for (const [chainName, chainRaw] of chainsRaw) {
    if (typeof chainName !== 'string') continue
    const chain = asMap(chainRaw)
    if (!chain) continue
    const entries = collectIntermediateEntries(chain, parseParticles(config.raw))
    const hit = entries.find(([name]) => name === proposal.chain)
    const list = hit ? asArr(hit[1]) : undefined
    if (list) groupLists.push({ chainName, list })
  }
  if (groupLists.length === 0) {
    errors.push({ code: 'unknown-chain', message: `no intermediates block defines "${proposal.chain}"` })
    return { config, changed, errors }
  }
  if (!RESONANCE_MODELS.includes(proposal.model)) {
    errors.push({ code: 'invalid-model', message: `model "${proposal.model}" not supported` })
    return { config, changed, errors }
  }
  const existingGroup_ = groupLists
    .flatMap(({ list }) => list)
    .some((g) => {
      const m = asMap(g)
      if (!m) return false
      for (const [key, namesRaw] of m) {
        const jp = decodeJpKey(key)
        if (jp && jp.j === proposal.jpGroup.j && jp.p === proposal.jpGroup.p) {
          return (asArr(namesRaw) ?? []).includes(proposal.name)
        }
      }
      return false
    })
  if (existingGroup_) {
    errors.push({ code: 'duplicate', message: `"${proposal.name}" is already in ${proposal.chain} [${proposal.jpGroup.j}${proposal.jpGroup.p > 0 ? '+' : '-'}]` })
    return { config, changed, errors }
  }
  const alreadyDefined = config.resonances[proposal.name] !== undefined
  if (!alreadyDefined && Object.keys(config.resonances).some((n) => normalizeName(n) === normalizeName(proposal.name))) {
    errors.push({ code: 'duplicate', message: `"${proposal.name}" duplicates existing resonance "${dupName(config, proposal.name)}"` })
    return { config, changed, errors }
  }
  if (alreadyDefined) {
    const ex = config.resonances[proposal.name]
    if (ex.j !== proposal.jpGroup.j || ex.p !== proposal.jpGroup.p) {
      errors.push({ code: 'jpc-conflict', message: `"${proposal.name}" is defined as ${ex.j}${ex.p > 0 ? '+' : '-'}; attach under that J^P` })
      return { config, changed, errors }
    }
    if (ex.parameters.length !== proposal.parameters.length || ex.parameters.some((v, i) => Math.abs(v - proposal.parameters[i]) > 1e-6)) {
      errors.push({ code: 'param-conflict', message: `"${proposal.name}" is defined with ${JSON.stringify(ex.parameters)}` })
      return { config, changed, errors }
    }
  }
  if (!Number.isFinite(proposal.parameters[0]) || proposal.parameters[0] <= 0) {
    errors.push({ code: 'invalid-parameters', message: 'parameters[0] (mass) must be a positive number' })
    return { config, changed, errors }
  }
  const arityOk =
    (proposal.model === 'BWR' && proposal.parameters.length >= 2) ||
    (proposal.model === 'BW' && proposal.parameters.length >= 2) ||
    (proposal.model === 'ONE' && proposal.parameters.length === 1) ||
    (proposal.model === 'Flatte' && proposal.parameters.length >= 2 && !!proposal.channels)
  if (!arityOk) {
    errors.push({
      code: 'invalid-parameters',
      message: `parameter structure invalid for ${proposal.model} (BWR/BW: >=2, ONE: exactly 1, Flatte: >=2 + channels)`,
    })
    return { config, changed, errors }
  }
  const free = proposal.free ?? []
  if (free.some((f) => !(f === -1 || (Number.isInteger(f) && f >= 0 && f < proposal.parameters.length)))) {
    errors.push({ code: 'invalid-free', message: `free ${JSON.stringify(free)} invalid for ${proposal.parameters.length} parameters` })
    return { config, changed, errors }
  }
  const freeAll = free.includes(-1)
  if (proposal.freeRange !== undefined && proposal.freeRange.length !== 0 && proposal.freeRange.length !== (freeAll ? proposal.parameters.length : free.length)) {
    errors.push({ code: 'invalid-free', message: 'free_range length must equal free length' })
    return { config, changed, errors }
  }

  // --- apply: intermediates group names (every chain defining the intermediate)
  let applied = 0
  for (const { chainName, list } of groupLists) {
    const groupRaw = list.find((g) => {
      const m = asMap(g)
      if (!m) return false
      for (const [key] of m) {
        const jp = decodeJpKey(key)
        if (jp && jp.j === proposal.jpGroup.j && jp.p === proposal.jpGroup.p) return true
      }
      return false
    })
    if (!groupRaw) {
      // New [J,P] group: append it to the FIRST defining chain only. Appending
      // keeps the existing group order (and therefore amplitude indexing used
      // by Constraints.trans) untouched.
      if (applied === 0) {
        const newGroup: YamlMap = new Map()
        newGroup.set(encodeJpKey(proposal.jpGroup), [proposal.name])
        list.push(newGroup)
        applied++
        changed.push(
          `${chainName}.${proposal.chain} new [${proposal.jpGroup.j}${proposal.jpGroup.p > 0 ? '+' : '-'}] group += ${proposal.name}`,
        )
      }
      continue
    }
    const groupMap = asMap(groupRaw)
    if (!groupMap) continue
    for (const [key, namesRaw] of groupMap) {
      const jp = decodeJpKey(key)
      if (jp && jp.j === proposal.jpGroup.j && jp.p === proposal.jpGroup.p) {
        const names = asArr(namesRaw) ?? []
        names.push(proposal.name)
        groupMap.set(key, names)
        applied++
        changed.push(`${chainName}.${proposal.chain} [${jp.j}${jp.p > 0 ? '+' : '-'}] += ${proposal.name}`)
        break
      }
    }
  }
  if (applied === 0) {
    // Unreachable: groupMissing was false, so a group exists somewhere.
    errors.push({ code: 'unknown-jp-group', message: `group [${proposal.jpGroup.j}${proposal.jpGroup.p > 0 ? '+' : '-'}] not found in raw config` })
    return { config, changed, errors }
  }

  // --- apply: Resonances section ------------------------------------------
  if (!alreadyDefined) {
    const resRaw = asMap(config.raw.get('Resonances')) ?? asMap(config.raw.get('resonances'))
    if (!resRaw) {
      errors.push({ code: 'invalid-config', message: 'config has no Resonances section' })
      return { config, changed, errors }
    }
    const spec: Record<string, unknown> = {
      J: proposal.jpGroup.j,
      P: proposal.jpGroup.p,
      model: proposal.model,
      parameters: proposal.parameters,
    }
    if (proposal.free !== undefined && proposal.free.length > 0) spec.free = proposal.free
    if (proposal.freeRange !== undefined && proposal.freeRange.length > 0) {
      spec.free_range = proposal.freeRange.map(([lo, hi]) => [lo, hi])
    }
    if (proposal.channels !== undefined) spec.channels = proposal.channels
    spec.tex = [proposal.tex ?? `\\mathrm{${proposal.name}}`]
    resRaw.set(proposal.name, spec)
    changed.push(`Resonances.${proposal.name} = ${proposal.model} ${JSON.stringify(proposal.parameters)}${proposal.free ? ` free=${JSON.stringify(proposal.free)}` : ''}`)
  } else {
    changed.push(`Resonances.${proposal.name}（已定义，仅挂链）`)
  }

  // --- rebuild views and cross-reference ----------------------------------
  Object.assign(config, rebuildViews(config.raw))
  const xref = crossReferenceErrors(config)
  if (xref.errors.length > 0) {
    // Should not happen: the edit only adds a defined resonance. Guard anyway.
    errors.push(...xref.errors)
    return { config, changed, errors }
  }
  return { config, changed, errors }
}

/**
 * Cross-reference check: every name referenced in an intermediates group must
 * be defined in the Resonances section (ctpwa silently skips undefined ones,
 * which silently changes the fit — we refuse instead).
 */
export function crossReferenceErrors(config: PwaConfig): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = []
  const referenced = new Set<string>()
  for (const chain of Object.values(config.decayChains)) {
    for (const int of Object.values(chain.intermediates)) {
      for (const group of int.groups) {
        for (const name of group.names) {
          referenced.add(name)
          if (config.resonances[name] === undefined) {
            errors.push({
              code: 'undefined-resonance',
              message: `intermediates reference "${name}" but no Resonances.${name} is defined (ctpwa would silently skip it)`,
            })
          }
        }
      }
    }
  }
  const warnings: ValidationIssue[] = []
  for (const name of Object.keys(config.resonances)) {
    if (!referenced.has(name)) {
      warnings.push({
        code: 'unreferenced-resonance',
        message: `Resonances.${name} is defined but never referenced by any intermediates group`,
      })
    }
  }
  return { errors, warnings }
}

/** Find the existing key that normalizes to the same name. */
function dupName(config: { resonances: Record<string, unknown> }, name: string): string {
  return Object.keys(config.resonances).find((n) => normalizeName(n) === normalizeName(name)) ?? name
}

/** Render the config back to YAML text (parseable by ctpwa/yaml-cpp). */
export function dumpConfig(config: PwaConfig): string {
  return `# config.yml — regenerated by dsh-pwa (auto_pwa_config_edit)\n${stringify(config.raw, { lineWidth: 0 })}`
}
