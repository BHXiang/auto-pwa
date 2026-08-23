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
  DecayStep,
  JP,
  JPGroup,
  Particle,
  PwaConfig,
  PwaConstraints,
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
export function rebuildViews(
  raw: YamlMap,
): Pick<PwaConfig, 'particles' | 'decayChains' | 'resonances' | 'kinematics' | 'constraints'> {
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
      const reference = spec.get('reference')
      if (asStr(reference) !== undefined) resonance.reference = reference as string
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
      decayChains[chainName] = {
        intermediates,
        steps: parseChainSteps(chain),
      }

      // --- kinematics: production steps A -> R + B ------------------------
      for (const step of decayChains[chainName].steps) {
        const intermediatesNames = new Set(Object.keys(intermediates))
        let motherParticle = particles[step.mother]
        if (!motherParticle) {
          // Cascade topologies: the mother is itself an intermediate
          // (e.g. psip -> gamma + R_chic1, then R_chic1 -> eta + R_KK).
          // Resolve its J^P from the group and its mass from the group's
          // first resonance's config spec (chic1: parameters [3.51]).
          const intGroups = intermediates[step.mother]?.groups
          const resName = intGroups?.[0]?.names?.[0]
          const spec = resName !== undefined ? resonances[resName] : undefined
          if (intGroups !== undefined && spec !== undefined) {
            motherParticle = { j: intGroups[0]!.jp.j, p: intGroups[0]!.jp.p, mass: spec.parameters[0] }
          }
        }
        if (!motherParticle) continue
        const res = step.daughters.filter((d) => intermediatesNames.has(d))
        const siblings = step.daughters.filter((d) => !intermediatesNames.has(d))
        if (res.length !== 1 || siblings.length !== 1) continue // 2-body production only
        const sibling = particles[siblings[0]]
        if (!sibling) continue
        const threshold = motherParticle.mass - sibling.mass
        const existing = kinematics[res[0]]
        if (!existing || threshold < existing.threshold) {
          kinematics[res[0]] = {
            mother: motherParticle,
            daughter: sibling,
            threshold,
            motherName: step.mother,
            daughterName: siblings[0],
          }
        }
      }
    }
  }

  return { particles, decayChains, resonances, kinematics, constraints: parseConstraints(raw) }
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

/**
 * Enumerate the decay steps of a chain in either config format, including
 * per-step opts (`sl` whitelist, `p_break`, `has_bf`, `bf_d`):
 *
 *   Format B: chain.decay = [ {Mother: [d1, d2, {opts}]}, ... ]
 *   Format A (solve2 style): particle/intermediate keys whose value is
 *     - a single mode [d1, d2(, {opts})], or
 *     - a list of modes [[d1, d2(, {opts})], ...]
 *   (spin-chain group keys `R: [{J,P}: [...]]` are NOT steps.)
 */
function parseChainSteps(chain: YamlMap): DecayStep[] {
  const steps: DecayStep[] = []

  // Format B: explicit `decay:` list.
  const decayList = asArr(chain.get('decay'))
  if (decayList) {
    for (const stepRaw of decayList) {
      const step = asMap(stepRaw)
      if (!step) continue
      for (const [mother, daughtersRaw] of step) {
        if (typeof mother !== 'string') continue
        for (const { d1, d2, opts } of parseDaughterModes(daughtersRaw)) {
          steps.push({ mother, daughters: [d1, d2], ...stepOpts(opts) })
        }
      }
    }
    return steps
  }

  // Format A: particle/intermediate keys with mode values.
  for (const [mother, modesRaw] of chain) {
    if (typeof mother !== 'string') continue
    if (RESERVED_CHAIN_KEYS.has(mother)) continue
    if (asMap(modesRaw)) continue // intermediates sub-block or similar
    const list0 = asArr(modesRaw)
    if (!list0 || list0.length === 0) continue
    if (isSpinChainGroup(list0[0])) continue // spin-chain group key (not a step)
    for (const { d1, d2, opts } of parseDaughterModes(modesRaw)) {
      steps.push({ mother, daughters: [d1, d2], ...stepOpts(opts) })
    }
  }
  return steps
}

/** One parsed daughter list: [d1, d2(, {opts})] or a list of such modes. */
function parseDaughterModes(raw: unknown): { d1: string; d2: string; opts: Map<unknown, unknown> }[] {
  const list = asArr(raw)
  if (!list) return []
  const parseMode = (mode: unknown): { d1: string; d2: string; opts: Map<unknown, unknown> } | undefined => {
    const row = asArr(mode)
    if (!row || row.length < 2) return undefined
    const d1 = asStr(row[0])
    const d2 = asStr(row[1])
    if (d1 === undefined || d2 === undefined) return undefined
    const opts = asMap(row[2]) ?? new Map()
    return { d1, d2, opts }
  }
  const out: { d1: string; d2: string; opts: Map<unknown, unknown> }[] = []
  if (asStr(list[0]) !== undefined) {
    const m = parseMode(list)
    if (m) out.push(m)
  } else {
    for (const mode of list) {
      const m = parseMode(mode)
      if (m) out.push(m)
    }
  }
  return out
}

/** Per-step opts -> DecayStep fields (ctpwa Config.cu parsing, sl flat or nested). */
function stepOpts(opts: Map<unknown, unknown>): Pick<DecayStep, 'sl' | 'pBreak' | 'hasBf' | 'bfD'> {
  const out: Pick<DecayStep, 'sl' | 'pBreak' | 'hasBf' | 'bfD'> = {}
  const slRaw = opts.get('sl')
  if (slRaw !== undefined) {
    const list = asArr(slRaw)
    if (list) {
      const rows: [number, number][] = []
      const pushRow = (r: unknown): void => {
        const row = asArr(r)
        if (row && row.length >= 2) {
          const s = asNum(row[0])
          const l = asNum(row[1])
          if (s !== undefined && l !== undefined) rows.push([s, l])
        }
      }
      if (asNum(list[0]) !== undefined) pushRow(list) // flat [S, L]
      else for (const r of list) pushRow(r) // nested [[S, L], ...]
      if (rows.length > 0) out.sl = rows
    }
  }
  const pBreak = opts.get('p_break')
  if (typeof pBreak === 'boolean') out.pBreak = pBreak
  const hasBf = opts.get('has_bf')
  if (typeof hasBf === 'boolean') out.hasBf = hasBf
  else {
    const pair = asArr(hasBf)?.map((v) => (typeof v === 'boolean' ? v : undefined))
    if (pair && pair.length >= 2 && pair[0] !== undefined && pair[1] !== undefined) {
      out.hasBf = [pair[0], pair[1]]
    }
  }
  const bfD = opts.get('bf_d')
  if (asNum(bfD) !== undefined) out.bfD = bfD as number
  else if (asArr(bfD)) {
    const pair = asArr(bfD)?.map(asNum)
    if (pair && pair.length >= 2 && pair[0] !== undefined && pair[1] !== undefined) {
      out.bfD = [pair[0], pair[1]]
    }
  }
  return out
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
    if (proposal.reference !== undefined && proposal.reference.trim() !== '') {
      spec.reference = proposal.reference.trim()
    }
    spec.tex = [proposal.tex ?? `\\mathrm{${proposal.name}}`]
    resRaw.set(proposal.name, spec)
    changed.push(
      `Resonances.${proposal.name} = ${proposal.model} ${JSON.stringify(proposal.parameters)}` +
        `${proposal.free ? ` free=${JSON.stringify(proposal.free)}` : ''}` +
        `${proposal.reference ? ` reference="${proposal.reference}"` : ''}`,
    )
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

// ---------------------------------------------------------------------------
// Constraints section + validateConfig
// ---------------------------------------------------------------------------

/** Parse the `Constraints` section into the PwaConstraints view. */
export function parseConstraints(raw: YamlMap): PwaConstraints {
  const conRaw = asMap(raw.get('Constraints')) ?? asMap(raw.get('constraints'))
  if (!conRaw) return {}
  const out: PwaConstraints = {}

  const identicalRaw = asArr(conRaw.get('identical'))
  if (identicalRaw) {
    const groups: string[][] = []
    for (const g of identicalRaw) {
      const names = asArr(g)?.map(asStr).filter((s): s is string => s !== undefined)
      if (names && names.length > 0) groups.push(names)
    }
    if (groups.length > 0) out.identical = groups
  }

  const transRaw = asArr(conRaw.get('trans'))
  if (transRaw) {
    const trans: { names: string[]; value: number[] }[] = []
    for (const entryRaw of transRaw) {
      const entry = asMap(entryRaw)
      if (!entry) continue
      for (const [namesRaw, valueRaw] of entry) {
        const names = asArr(namesRaw)?.map(asStr).filter((s): s is string => s !== undefined)
        if (!names || names.length === 0) continue
        const value: number[] = []
        const pushNums = (v: unknown): void => {
          const n = asNum(v)
          if (n !== undefined) {
            value.push(n)
            return
          }
          for (const el of asArr(v) ?? []) pushNums(el)
        }
        pushNums(valueRaw)
        trans.push({ names, value })
      }
    }
    if (trans.length > 0) out.trans = trans
  }

  const maxL = asNum(conRaw.get('maxL'))
  if (maxL !== undefined) out.maxL = maxL
  const bfD = asNum(conRaw.get('bf_d'))
  if (bfD !== undefined) out.bfD = bfD
  const hasBf = conRaw.get('has_bf')
  if (typeof hasBf === 'boolean') out.hasBf = hasBf

  const fixVarRaw = asMap(conRaw.get('fix_var'))
  if (fixVarRaw) {
    const fixVar: Record<string, number> = {}
    for (const [k, v] of fixVarRaw) {
      const n = asNum(v)
      if (typeof k === 'string' && n !== undefined) fixVar[k] = n
    }
    if (Object.keys(fixVar).length > 0) out.fixVar = fixVar
  }
  const freeVarRaw = asArr(conRaw.get('free_var'))
  if (freeVarRaw) {
    const names = freeVarRaw.map(asStr).filter((s): s is string => s !== undefined)
    if (names.length > 0) out.freeVar = names
  }
  const varRangeRaw = asMap(conRaw.get('var_range'))
  if (varRangeRaw) {
    const varRange: Record<string, [number, number]> = {}
    for (const [k, v] of varRangeRaw) {
      const row = asArr(v)
      const lo = row ? asNum(row[0]) : undefined
      const hi = row ? asNum(row[1]) : undefined
      if (typeof k === 'string' && lo !== undefined && hi !== undefined) varRange[k] = [lo, hi]
    }
    if (Object.keys(varRange).length > 0) out.varRange = varRange
  }
  const varEqualRaw = asArr(conRaw.get('var_equal'))
  if (varEqualRaw) {
    const groups: string[][] = []
    for (const g of varEqualRaw) {
      const names = asArr(g)?.map(asStr).filter((s): s is string => s !== undefined)
      if (names && names.length > 0) groups.push(names)
    }
    if (groups.length > 0) out.varEqual = groups
  }
  const gaussRaw = asMap(conRaw.get('gauss_constr'))
  if (gaussRaw) {
    const gaussConstr: Record<string, number> = {}
    for (const [k, v] of gaussRaw) {
      const n = asNum(v)
      if (typeof k === 'string' && n !== undefined) gaussConstr[k] = n
    }
    if (Object.keys(gaussConstr).length > 0) out.gaussConstr = gaussConstr
  }

  return out
}

/**
 * Structural validation of a whole config (auto_pwa_config_view gate):
 *   - Constraints.identical groups: members exist in Particles, same spin;
 *   - Constraints.trans references <intermediate>_<groupIndex> that exist;
 *   - Constraints.maxL is a positive integer;
 *   - Data.order entries exist in Particles;
 *   - per-step sl whitelist entries are legal (2S+1, L).
 * Errors indicate the config is structurally broken; warnings are hygiene.
 */
export function validateConfig(config: PwaConfig): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const { constraints } = config

  for (const group of constraints.identical ?? []) {
    if (group.length < 2) {
      errors.push({
        code: 'identical-group-too-small',
        message: `Constraints.identical group ${JSON.stringify(group)} has fewer than 2 members — ctpwa needs >= 2 to symmetrize`,
      })
      continue
    }
    const spins = new Set<number>()
    for (const name of group) {
      const p = config.particles[name]
      if (!p) {
        errors.push({
          code: 'identical-unknown-particle',
          message: `identical group member "${name}" is not in the Particles section`,
        })
      } else {
        spins.add(p.j)
      }
    }
    if (spins.size > 1) {
      errors.push({
        code: 'identical-spin-mismatch',
        message: `identical group ${JSON.stringify(group)} mixes different spins ${[...spins].join(', ')} — identical particles must share one spin`,
      })
    }
  }

  for (const t of constraints.trans ?? []) {
    for (const name of t.names) {
      const m = /^(.+)_(\d+)$/.exec(name)
      if (!m) {
        errors.push({
          code: 'trans-bad-name',
          message: `trans references "${name}" — expected <intermediate>_<groupIndex> (e.g. R_Keta_0)`,
        })
        continue
      }
      const intName = m[1]
      const idx = Number(m[2])
      const found = Object.values(config.decayChains).find((c) => c.intermediates[intName])
      if (!found) {
        errors.push({
          code: 'trans-unknown-intermediate',
          message: `trans references "${name}" but no intermediate "${intName}" is defined in any chain`,
        })
      } else if (idx >= found.intermediates[intName].groups.length) {
        errors.push({
          code: 'trans-group-index',
          message: `trans references "${name}" but ${intName} has only ${found.intermediates[intName].groups.length} [J,P] group(s) (indices 0..${found.intermediates[intName].groups.length - 1})`,
        })
      }
    }
  }

  if (constraints.maxL !== undefined && (!Number.isInteger(constraints.maxL) || constraints.maxL <= 0)) {
    errors.push({ code: 'maxl-invalid', message: `Constraints.maxL must be a positive integer, got ${constraints.maxL}` })
  }

  const dataRaw = asMap(config.raw.get('Data')) ?? asMap(config.raw.get('data'))
  const order = asArr(dataRaw?.get('order'))?.map(asStr).filter((s): s is string => s !== undefined) ?? []
  for (const o of order) {
    if (config.particles[o] === undefined) {
      errors.push({ code: 'data-order-unknown', message: `Data.order lists "${o}" but no such particle is in the Particles section` })
    }
  }

  for (const chain of Object.values(config.decayChains)) {
    for (const step of chain.steps) {
      for (const [s, l] of step.sl ?? []) {
        if (!Number.isInteger(s) || s < 1 || s % 2 !== 1) {
          errors.push({
            code: 'sl-invalid-multiplicity',
            message: `step ${step.mother} -> ${step.daughters.join(' + ')}: sl multiplicity ${s} must be 2S+1 (odd positive integer)`,
          })
        }
        if (!Number.isInteger(l) || l < 0) {
          errors.push({
            code: 'sl-invalid-l',
            message: `step ${step.mother} -> ${step.daughters.join(' + ')}: sl L = ${l} must be a non-negative integer`,
          })
        }
      }
    }
  }

  return { errors, warnings }
}
