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
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from 'yaml'
import { normalizeName } from './lookup.js'
import { explicitJp, jpLabel } from './jpc.js'
import { parameterStructureError } from './resonance-validate.js'
import {
  cValueOf,
  deriveIdenticalGroups,
  getParticleInfo,
  isIdenticalByPdgid,
} from './particle-info.js'
import type {
  ChainKinematics,
  ConfigEditResult,
  DecayStep,
  JP,
  JPGroup,
  Particle,
  PwaConfig,
  PwaConstraints,
  ResonanceDb,
  ResonanceModel,
  ResonanceProposal,
  ResonanceRemoval,
  ResonanceSpec,
  RemovalValidation,
  ValidationIssue,
} from './types.js'

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
 * Documents kept next to their plain-Map view, so a write-back can render from
 * the AST instead of re-serializing the Map.
 *
 * `parseConfig` hands the editing tools a plain `Map` tree (`raw`) which they
 * mutate in place; `stringify(raw)` is what dropped every comment and rewrote
 * compact `- [J: 1, P: -1]: [...]` groups into `? - J: 1` explicit keys. Holding
 * the parsed `Document` here lets `dumpConfig` reconcile that Document with the
 * mutated Map — untouched YAML keeps its comments, key style and flow
 * collections.
 */
const PARSED_DOCS = new WeakMap<object, Document>()

/** Normalize Map/array/scalar trees for structural comparison. */
function plainValue(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [key, val] of value) out[String(plainValue(key))] = plainValue(val)
    return out
  }
  if (Array.isArray(value)) return value.map(plainValue)
  return value
}

/**
 * Structural equality of two config values.
 *
 * YAML nodes serialize through `toJSON`, so this compares parsed AST nodes and
 * plain Maps/arrays/scalars with one rule — which is what lets the reconciler
 * match a Map key that is itself an array of maps (the `[J, P]` group keys).
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(plainValue(a)) === JSON.stringify(plainValue(b))
  } catch {
    return false
  }
}

/**
 * Whether a plain value maps onto a YAML scalar (not a collection). */
function isScalarValue(value: unknown): boolean {
  return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)
}

/**
 * Canonical text of a MAP KEY, so the two representations of one key compare
 * equal.
 *
 * A ctpwa `[J, P]` group key parses two ways: the AST keeps the flow seq
 * `[J: 1, P: -1]`, while `toJS({mapAsMap:true})` (and `encodeJpKey`) produce the
 * single Map `{J: 1, P: -1}`. Without flattening the seq-of-single-entry-maps
 * form, every group key mismatches, gets re-created, and takes its comments and
 * `[J: 1, P: -1]` style with it.
 *
 * Kept separate from {@link sameValue} (which compares VALUES): merging
 * single-entry maps would be wrong for an arbitrary `options` payload.
 */
function keyForm(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (isScalar(v)) return v.value
    if (isMap(v)) {
      const out: Record<string, unknown> = {}
      for (const item of (v as unknown as { items: { key?: unknown; value?: unknown }[] }).items) {
        out[String(canon(item.key))] = canon(item.value)
      }
      return out
    }
    if (isSeq(v)) return (v as unknown as { items: unknown[] }).items.map(canon)
    if (v instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of v) out[String(canon(k))] = canon(val)
      return out
    }
    if (Array.isArray(v)) return v.map(canon)
    return v
  }
  const flat = (x: unknown): unknown => {
    if (
      Array.isArray(x) &&
      x.length > 0 &&
      x.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e) && Object.keys(e as object).length === 1)
    ) {
      return Object.assign({}, ...(x as object[]))
    }
    return x
  }
  return JSON.stringify(flat(canon(value)))
}

/**
 * Reconcile one AST node with the mutated plain value, in place.
 *
 * Existing map pairs are matched by structurally equal key, so their comments,
 * key style and value formatting survive; new entries are appended and removed
 * ones disappear. Scalar nodes are updated in place (keeping quote style) when
 * the value stays scalar.
 */
function syncNode(node: unknown, value: unknown, doc: Document): unknown {
  if (isMap(node) && value instanceof Map) {
    const map = node as unknown as { items: { key?: unknown; value?: unknown }[] }
    const remaining = [...map.items]
    const pairs: { key?: unknown; value?: unknown }[] = []
    for (const [key, val] of value) {
      const at = remaining.findIndex((pair) => keyForm(pair.key) === keyForm(key))
      const pair =
        at >= 0
          ? remaining.splice(at, 1)[0]!
          : (doc.createPair(key, val) as unknown as { key?: unknown; value?: unknown })
      pair.value = syncNode(pair.value, val, doc)
      pairs.push(pair)
    }
    map.items = pairs
    return node
  }
  if (isSeq(node) && Array.isArray(value)) {
    const seq = node as unknown as { items: unknown[] }
    seq.items = value.map((item, i) => syncNode(seq.items[i], item, doc) ?? doc.createNode(item))
    return node
  }
  if (isScalar(node) && isScalarValue(value)) {
    ;(node as { value: unknown }).value = value
    return node
  }
  return doc.createNode(value)
}

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
  PARSED_DOCS.set(raw, doc)
  return { raw, ...rebuildViews(raw) }
}

/** Re-derive the plain-object views from the raw Map document. */
export function rebuildViews(
  raw: YamlMap,
): Pick<PwaConfig, 'particles' | 'decayChains' | 'resonances' | 'kinematics' | 'constraints' | 'stepIssues'> {
  const particles: Record<string, Particle> = {}
  const resonances: Record<string, ResonanceSpec> = {}
  const decayChains: PwaConfig['decayChains'] = {}
  const kinematics: Record<string, ChainKinematics> = {}
  /** Defects the chain reader could not represent (see PwaConfig.stepIssues). */
  const stepIssues: ValidationIssue[] = []

  // --- Particles ----------------------------------------------------------
  // Single parser: parseParticles also reads the optional `pdgid`/`c`
  // extensions (the engine ignores them; the symmetry checks use them).
  for (const [name, particle] of Object.entries(parseParticles(raw))) {
    particles[name] = particle
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
      // J/P are OPTIONAL (ctpwa parseResonances): when absent the [J,P] of the
      // intermediates group governs. Dropping such entries would (a) hide
      // CP-conjugate resonances (same state, opposite parity in two chains)
      // from the views and (b) make the write gate redefine/clobber them.
      if (model === undefined || parameters.some((x) => x === undefined)) continue
      const resonance: ResonanceSpec = {
        model: model as ResonanceModel,
        parameters: parameters as number[],
      }
      if (j !== undefined) resonance.j = j
      if (p !== undefined) resonance.p = p === 1 ? 1 : -1
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
      // Model-specific payload (Interp table / Custom DSL): kept as a plain
      // object so views and the run gate can see it (the engine owns the
      // semantics; the plugin only checks the mapping shape).
      const opts = spec.get('options')
      if (opts instanceof Map) {
        resonance.options = Object.fromEntries(
          [...opts.entries()].filter(([k]) => typeof k === 'string'),
        ) as Record<string, unknown>
      } else if (typeof opts === 'object' && opts !== null && !Array.isArray(opts)) {
        resonance.options = opts as Record<string, unknown>
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
        steps: parseChainSteps(chain, stepIssues),
        // Carried through so the gate can report that ctpwa ignores this key.
        ...(chain.has('symmetrize') ? { symmetrize: true as const } : {}),
      }

      // --- kinematics: production steps A -> R + B ------------------------
      /**
       * J/P/mass of an intermediate, resolved from its first group and that
       * group's first resonance spec — the same convention the cascade-mother
       * lookup below uses (chic1: parameters [3.51]). Parameter-less models
       * (Interp/Custom) carry no mass and resolve to undefined.
       */
      const intermediateParticle = (name: string): Particle | undefined => {
        const groups = intermediates[name]?.groups
        const first = groups?.[0]
        const resName = first?.names?.[0]
        const spec = resName !== undefined ? resonances[resName] : undefined
        const mass = spec?.parameters[0]
        if (first === undefined || mass === undefined) return undefined
        return { j: first.jp.j, p: first.jp.p, mass }
      }

      for (const step of decayChains[chainName].steps) {
        const intermediatesNames = new Set(Object.keys(intermediates))
        let motherParticle = particles[step.mother] ?? intermediateParticle(step.mother)
        if (!motherParticle) continue
        const res = step.daughters.filter((d) => intermediatesNames.has(d))
        const siblings = step.daughters.filter((d) => !intermediatesNames.has(d))
        // ctpwa's production vertex is two-body. Two shapes exist:
        //   A -> R + B    : the sibling is a plain particle;
        //   A -> R1 + R2  : BOTH daughters are intermediates — the usual
        //                   four-body topology (e.g. J/psi -> R1 + R2).
        // The second shape used to be skipped (`res.length !== 1`), which left
        // `kinematics` incomplete and, through it, silently disabled the
        // two-vertex C check for those intermediates (intermediate-jpc reads
        // its production row from here). Each side's threshold uses the OTHER
        // side's mass, resolved from that side's group.
        const against: { self: string; name: string; particle: Particle }[] = []
        if (res.length === 1 && siblings.length === 1) {
          const sibling = particles[siblings[0]!]
          if (sibling !== undefined) against.push({ self: res[0]!, name: siblings[0]!, particle: sibling })
        } else if (res.length === 2 && siblings.length === 0) {
          const [a, b] = res as [string, string]
          const pa = intermediateParticle(a)
          const pb = intermediateParticle(b)
          if (pa !== undefined && pb !== undefined) {
            against.push({ self: a, name: b, particle: pb }, { self: b, name: a, particle: pa })
          }
        }
        for (const { self, name, particle } of against) {
          const threshold = motherParticle.mass - particle.mass
          const existing = kinematics[self]
          if (!existing || threshold < existing.threshold) {
            kinematics[self] = {
              mother: motherParticle,
              daughter: particle,
              threshold,
              motherName: step.mother,
              daughterName: name,
            }
          }
        }
      }
    }
  }

  return { particles, decayChains, resonances, kinematics, constraints: parseConstraints(raw), stepIssues }
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
    const particle: Particle = { j, p: p === 1 ? 1 : -1, mass }
    // `pdgid` is our extension: the signed Monte-Carlo ID (K+ = 321). ctpwa's
    // ConfigParser::parseParticles ignores unknown keys, so the engine is
    // unaffected; the tooling uses it for symmetry checks.
    const pdgid = asNum(props.get('pdgid') ?? props.get('PDGID') ?? props.get('pdgId'))
    if (pdgid !== undefined) particle.pdgid = pdgid
    const c = asNum(props.get('c') ?? props.get('C'))
    if (c === 1 || c === -1) particle.c = c
    particles[name] = particle
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
function parseChainSteps(chain: YamlMap, issues: ValidationIssue[]): DecayStep[] {
  const steps: DecayStep[] = []

  // Format B: explicit `decay:` list.
  const decayList = asArr(chain.get('decay'))
  if (decayList) {
    for (const stepRaw of decayList) {
      const step = asMap(stepRaw)
      if (!step) continue
      for (const [mother, daughtersRaw] of step) {
        if (typeof mother !== 'string') continue
        for (const { d1, d2, opts } of parseDaughterModes(daughtersRaw, mother, issues)) {
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
    for (const { d1, d2, opts } of parseDaughterModes(modesRaw, mother, issues)) {
      steps.push({ mother, daughters: [d1, d2], ...stepOpts(opts) })
    }
  }
  return steps
}

/**
 * One parsed daughter list: `[d1, d2(, {opts})]` or a list of such modes.
 *
 * ctpwa's amplitude is two-body PER VERTEX (`Amp2BD`), so a third entry can only
 * be the per-step opts map — never another daughter. This used to read `[a, b, c]`
 * as `a -> b` (treating the stray `c` as an empty opts map), silently dropping
 * `c` and fitting a WRONG amplitude with no error anywhere; the same went for a
 * mode it could not parse at all. Such modes are now reported through `issues`
 * (which `validateConfig` turns into blocking errors) instead of being dropped.
 */
function parseDaughterModes(
  raw: unknown,
  mother: string,
  issues: ValidationIssue[],
): { d1: string; d2: string; opts: Map<unknown, unknown> }[] {
  const list = asArr(raw)
  if (!list) return []
  const show = (row: unknown[]): string =>
    row.map((x) => asStr(x) ?? (asMap(x) !== undefined ? '{opts}' : JSON.stringify(x) ?? '?')).join(', ')
  const parseMode = (mode: unknown): { d1: string; d2: string; opts: Map<unknown, unknown> } | undefined => {
    const row = asArr(mode)
    if (!row) return undefined
    const opts = row.length > 2 ? asMap(row[2]) : undefined
    if (row.length > 3 || (row.length === 3 && opts === undefined)) {
      issues.push({
        code: 'step-not-two-body',
        message:
          `"${mother} -> [${show(row)}]" 不是二体步：ctpwa 的振幅逐顶点二体（Amp2BD），` +
          `三体及以上中间态必须拆成二体级联（例如 η→3π 写成 η→ρπ 等子共振近似，或改成两级链）。` +
          `该步已被忽略 —— 继续拟合会得到错误的振幅`,
      })
      return undefined
    }
    if (row.length < 2) {
      issues.push({
        code: 'step-malformed',
        message:
          `"${mother}" 的衰变模式 [${show(row)}] 元素不足（需要 [d1, d2] 或 [d1, d2, {opts}]）—— 该步已被忽略`,
      })
      return undefined
    }
    const d1 = asStr(row[0])
    const d2 = asStr(row[1])
    if (d1 === undefined || d2 === undefined) {
      issues.push({
        code: 'step-malformed',
        message: `"${mother}" 的衰变模式 [${show(row)}] 末态名不是字符串 —— 该步已被忽略`,
      })
      return undefined
    }
    return { d1, d2, opts: opts ?? new Map() }
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
function stepOpts(opts: Map<unknown, unknown>): Pick<DecayStep, 'sl' | 'slKey' | 'pBreak' | 'hasBf' | 'bfD'> {
  const out: Pick<DecayStep, 'sl' | 'slKey' | 'pBreak' | 'hasBf' | 'bfD'> = {}
  // Wave whitelist, mirroring ctpwa ConfigParser::parseSLFilter exactly:
  //   sl: [S, L] / [[S, L], ...]   (S first)
  //   ls: [L, S] / [[L, S], ...]   (L first, TFPWA ls_list order)
  // S is the PHYSICAL total spin (integer OR half-integer: a baryon step has
  // S = 1/2, 3/2, ...), converted to ctpwa's internal {2S+1, L} notation that
  // Amp2BD::ComSL / jpc.enumerateSL use. Accepting only even/odd 2S+1 here
  // would silently drop every fermion step.
  const lsRaw = opts.get('ls')
  const slRaw = opts.get('sl')
  const raw = lsRaw !== undefined ? lsRaw : slRaw
  const lsFirst = lsRaw !== undefined
  if (raw !== undefined) {
    const list = asArr(raw)
    if (list) {
      const rows: [number, number][] = []
      const pushRow = (r: unknown): void => {
        const row = asArr(r)
        if (row && row.length >= 2) {
          const a = asNum(row[0])
          const b = asNum(row[1])
          if (a !== undefined && b !== undefined) {
            const sPhys = lsFirst ? b : a
            const l = lsFirst ? a : b
            rows.push([Math.round(2 * sPhys + 1), l])
          }
        }
      }
      if (asNum(list[0]) !== undefined) pushRow(list) // flat [S, L] / [L, S]
      else for (const r of list) pushRow(r) // nested
      if (rows.length > 0) {
        out.sl = rows
        // 记住是哪个键给的：`ls` 是 (L, S) 的 TFPWA 记法，写错顺序只会静默放进/丢掉波，
        // 所以门禁要能回显"你写的是哪个键、被解释成了什么"。
        out.slKey = lsFirst ? 'ls' : 'sl'
      }
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
  // Model names are open-ended on purpose: a KNOWN model has checked arity,
  // an unknown one is a warning (see resonance-validate) and ctpwa decides.
  // Only a missing/blank model is a structural error.
  if (typeof proposal.model !== 'string' || proposal.model.trim() === '') {
    errors.push({ code: 'invalid-model', message: `model must be a non-empty string, got ${JSON.stringify(proposal.model)}` })
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
    if (proposal.update !== true) {
      errors.push({ code: 'duplicate', message: `"${proposal.name}" is already in ${proposal.chain} [${proposal.jpGroup.j}${proposal.jpGroup.p > 0 ? '+' : '-'}]` })
      return { config, changed, errors }
    }
    // update: true on an already-attached state — the "float this one" case.
    // Membership is a no-op (the group loop below skips a name already listed)
    // and the definition is replaced further down.
  }
  const alreadyDefined = config.resonances[proposal.name] !== undefined
  if (!alreadyDefined && Object.keys(config.resonances).some((n) => normalizeName(n) === normalizeName(proposal.name))) {
    errors.push({ code: 'duplicate', message: `"${proposal.name}" duplicates existing resonance "${dupName(config, proposal.name)}"` })
    return { config, changed, errors }
  }
  if (alreadyDefined) {
    const ex = config.resonances[proposal.name]!
    const exJp = explicitJp(ex)
    // Only an EXPLICIT resonance-level J/P can conflict: with none written the
    // group's [J,P] governs, so the same state may legitimately be attached to
    // opposite-parity groups (CP-conjugate chains).
    if (exJp !== undefined && (exJp.j !== proposal.jpGroup.j || exJp.p !== proposal.jpGroup.p)) {
      errors.push({ code: 'jpc-conflict', message: `"${proposal.name}" is defined as ${jpLabel(exJp)}; attach under that J^P` })
      return { config, changed, errors }
    }
    // Differing parameters are a conflict only for a plain ATTACH: with
    // update: true the proposal replaces the definition (see the apply block).
    if (
      proposal.update !== true &&
      (ex.parameters.length !== proposal.parameters.length ||
        ex.parameters.some((v, i) => Math.abs(v - proposal.parameters[i]) > 1e-6))
    ) {
      errors.push({
        code: 'param-conflict',
        message:
          `"${proposal.name}" is defined with ${JSON.stringify(ex.parameters)} — ` +
          `pass exactly those parameters to attach it, or set update: true to redefine it`,
      })
      return { config, changed, errors }
    }
  }
  // ONE 的 mass 只是占位（ctpwa Bf 的 q0 取固定参考，占位值不进入振幅）→ 可省略；
  // Interp/Custom 的载荷在 options；未知模型交给跑前门禁的 ctpwa 校验。
  // 与 validateResonanceAddition 共用同一个结构检查（不会漂移）。
  const structErr = parameterStructureError(
    proposal.model,
    proposal.parameters,
    proposal.channels !== undefined,
  )
  if (structErr !== undefined) {
    errors.push(structErr)
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
        if (names.includes(proposal.name)) {
          // Already listed (update: true on an attached state) — pushing again
          // would list the same resonance twice in the group.
          applied++
          break
        }
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
  // `update: true` re-enters this block for an already-defined resonance: the
  // proposal REPLACES the definition instead of being ignored (which is what
  // used to happen — the parameters were dropped with no way to change them).
  const redefining = alreadyDefined && proposal.update === true
  if (!alreadyDefined || redefining) {
    const resRaw = asMap(config.raw.get('Resonances')) ?? asMap(config.raw.get('resonances'))
    if (!resRaw) {
      errors.push({ code: 'invalid-config', message: 'config has no Resonances section' })
      return { config, changed, errors }
    }
    const spec: Record<string, unknown> = {
      // No J/P here on purpose: ctpwa takes the quantum numbers from the
      // intermediates [J,P] group. Stamping them would break the CP-conjugate
      // case (same state added to a +P and a −P group) and contradicts the
      // engine's own convention.
      model: proposal.model,
      parameters: proposal.parameters,
    }
    if (proposal.free !== undefined && proposal.free.length > 0) spec.free = proposal.free
    if (proposal.freeRange !== undefined && proposal.freeRange.length > 0) {
      spec.free_range = proposal.freeRange.map(([lo, hi]) => [lo, hi])
    }
    if (proposal.channels !== undefined) spec.channels = proposal.channels
    // Model-specific payload (Interp/Custom/…): passed through verbatim — the
    // engine owns the semantics, the plugin only guarantees the mapping shape
    // and the run gate's ctpwa --validate-only is the verdict.
    if (proposal.options !== undefined && Object.keys(proposal.options).length > 0) {
      spec.options = proposal.options
    }
    if (proposal.reference !== undefined && proposal.reference.trim() !== '') {
      spec.reference = proposal.reference.trim()
    }
    // The config stores tex as an ARRAY (multi-segment labels like K_{2},(1980)),
    // while a proposal may pass either form — normalize here, never nest.
    spec.tex = Array.isArray(proposal.tex) ? proposal.tex : [proposal.tex ?? `\\mathrm{${proposal.name}}`]
    let dropped: string[] = []
    if (redefining) {
      // Keys the proposal surface never owns survive a redefinition: an explicit
      // resonance-level J/P is written by hand (the [J,P] group governs by
      // default), so silently deleting it would change the physics.
      const before = asMap(resRaw.get(proposal.name))
      for (const key of ['J', 'P']) {
        if (before?.has(key)) spec[key] = before.get(key)
      }
      dropped = [...(before?.keys() ?? [])].filter(
        (k): k is string => typeof k === 'string' && !(k in spec) && k !== 'J' && k !== 'P',
      )
    }
    resRaw.set(proposal.name, spec)
    changed.push(
      `Resonances.${proposal.name} = ${proposal.model} ${JSON.stringify(proposal.parameters)}` +
        `${proposal.free ? ` free=${JSON.stringify(proposal.free)}` : ''}` +
        `${proposal.options !== undefined ? ` options=${JSON.stringify(proposal.options)}` : ''}` +
        `${proposal.reference ? ` reference="${proposal.reference}"` : ''}` +
        `${redefining ? '（redefined）' : ''}` +
        `${dropped.length > 0 ? ` — 丢弃了未在 proposal 中给出的键: ${dropped.join(', ')}` : ''}`,
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

// ---------------------------------------------------------------------------
// Resonance removal
// ---------------------------------------------------------------------------

/** Every (chain, intermediate, [J,P] group) holding `removal.name` in scope. */
function removalTargets(
  config: PwaConfig,
  removal: ResonanceRemoval,
): { chainName: string; intName: string; jp: JP }[] {
  const out: { chainName: string; intName: string; jp: JP }[] = []
  for (const [chainName, chain] of Object.entries(config.decayChains)) {
    for (const [intName, int] of Object.entries(chain.intermediates)) {
      if (removal.chain !== undefined && removal.chain !== intName) continue
      for (const g of int.groups) {
        if (removal.jpGroup !== undefined && (g.jp.j !== removal.jpGroup.j || g.jp.p !== removal.jpGroup.p)) continue
        if (g.names.includes(removal.name)) out.push({ chainName, intName, jp: g.jp })
      }
    }
  }
  return out
}

/** Total number of group occurrences of `name` across the whole config. */
function referenceCount(config: PwaConfig, name: string): number {
  let n = 0
  for (const chain of Object.values(config.decayChains)) {
    for (const int of Object.values(chain.intermediates)) {
      for (const g of int.groups) if (g.names.includes(name)) n++
    }
  }
  return n
}

/**
 * Dry-run a resonance removal against the config. Errors block the edit.
 *
 * Name-level detachment never renumbers [J,P] groups (a group emptied by the
 * removal is KEPT), so `Constraints.trans` block indices stay valid. The
 * `Resonances.<name>` definition is dropped only when no group references it
 * any more (unless `dropDefinition: false`).
 */
export function validateResonanceRemoval(config: PwaConfig, removal: ResonanceRemoval): RemovalValidation {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const name = removal.name
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push({ code: 'invalid-name', message: 'removal.name must be a non-empty resonance name' })
    return { ok: false, errors, warnings, detached: [], definitionDropped: false }
  }
  const defined = config.resonances[name] !== undefined
  const targets = removalTargets(config, removal)
  const scoped = removal.chain !== undefined || removal.jpGroup !== undefined
  const total = referenceCount(config, name)

  if (targets.length === 0 && !defined) {
    errors.push({
      code: 'not-found',
      message: `"${name}" is neither defined in Resonances nor attached to any intermediate group`,
    })
  } else if (targets.length === 0 && defined && scoped) {
    errors.push({
      code: 'not-in-scope',
      message: `"${name}" is defined but not attached to the requested ${removal.chain ?? ''}${removal.jpGroup !== undefined ? ` [${jpLabel(removal.jpGroup)}]` : ''} scope — nothing to detach (drop the scope to delete the definition instead)`,
    })
  } else if (targets.length === 0 && defined) {
    warnings.push({
      code: 'detach-nothing',
      message: `"${name}" is defined but not attached to any group — only the Resonances definition will be removed`,
    })
  }

  const detached = targets.map((t) => `${t.chainName}.${t.intName} [${jpLabel(t.jp)}]`)
  const remaining = total - targets.length
  const wantDrop = removal.dropDefinition !== false
  const definitionDropped = wantDrop && remaining === 0 && defined
  if (!wantDrop && remaining === 0 && defined) {
    warnings.push({
      code: 'definition-kept',
      message: `dropDefinition=false: the Resonances.${name} definition is kept even though no group references it`,
    })
  }

  // Emptying a group is legal (the group stays, indices preserved) but it is
  // a real model change the caller should notice.
  for (const t of targets) {
    const g = config.decayChains[t.chainName]?.intermediates[t.intName]?.groups.find(
      (x) => x.jp.j === t.jp.j && x.jp.p === t.jp.p,
    )
    if (g !== undefined && g.names.length === 1) {
      warnings.push({
        code: 'group-emptied',
        message: `${t.chainName}.${t.intName} [${jpLabel(t.jp)}] becomes empty; the group is kept so Constraints.trans block indices stay valid`,
      })
    }
  }
  // No resonance left in an intermediate => those chains contribute nothing.
  for (const t of targets) {
    const int = config.decayChains[t.chainName]?.intermediates[t.intName]
    if (int !== undefined && int.groups.every((g) => g.names.every((n) => n === name))) {
      warnings.push({
        code: 'intermediate-empty',
        message: `${t.chainName}.${t.intName} has no resonance left after this removal — the chain contributes no amplitude`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings, detached, definitionDropped }
}

/**
 * Apply a resonance removal (mutates `config.raw` and rebuilds the views).
 * Structural/physics errors are returned without modifying the config.
 */
export function applyResonanceRemoval(config: PwaConfig, removal: ResonanceRemoval): ConfigEditResult {
  const changed: string[] = []
  const dry = validateResonanceRemoval(config, removal)
  if (!dry.ok) return { config, changed, errors: dry.errors }

  const chainsRaw = asMap(config.raw.get('DecayChains')) ?? asMap(config.raw.get('decay_chains'))
  if (chainsRaw) {
    const particles = parseParticles(config.raw)
    for (const [chainName, chainRaw] of chainsRaw) {
      if (typeof chainName !== 'string') continue
      const chain = asMap(chainRaw)
      if (!chain) continue
      // Explicit `intermediates:` sub-block, or top-level spin-chain keys.
      const entries = collectIntermediateEntries(chain, particles)
      for (const [intName, groupsRaw] of entries) {
        if (removal.chain !== undefined && removal.chain !== intName) continue
        const list = asArr(groupsRaw)
        if (!list) continue
        for (const groupRaw of list) {
          const groupMap = asMap(groupRaw)
          if (!groupMap) continue
          for (const [key, namesRaw] of groupMap) {
            const jp = decodeJpKey(key)
            if (!jp) continue
            if (removal.jpGroup !== undefined && (jp.j !== removal.jpGroup.j || jp.p !== removal.jpGroup.p)) continue
            const names = asArr(namesRaw)
            if (!names || !names.includes(removal.name)) continue
            // Name-level splice: the group (and its index) survives even when
            // it becomes empty.
            groupMap.set(key, names.filter((n) => n !== removal.name))
            changed.push(`${chainName}.${intName} [${jpLabel(jp)}] -= ${removal.name}`)
          }
        }
      }
    }
  }

  if (dry.definitionDropped) {
    const resRaw = asMap(config.raw.get('Resonances')) ?? asMap(config.raw.get('resonances'))
    resRaw?.delete(removal.name)
    changed.push(`Resonances.${removal.name} 删除（已无 [J,P] 组引用）`)
  }

  Object.assign(config, rebuildViews(config.raw))
  const xref = crossReferenceErrors(config)
  if (xref.errors.length > 0) {
    return { config, changed, errors: xref.errors }
  }
  return { config, changed, errors: [] }
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

/** First line of every rendered config — kept stable for downstream tooling. */
const CONFIG_HEADER = '# config.yml — regenerated by dsh-pwa (auto_pwa_config_edit)'

/**
 * Render the config back to YAML text (parseable by ctpwa/yaml-cpp).
 *
 * Prefers the parsed Document (see {@link PARSED_DOCS}) so comments and compact
 * flow collections survive an edit — but only when the result is PROVABLY
 * faithful: the rendered text is re-parsed and compared against `config.raw`,
 * and any mismatch (an AST update that missed a mutation) falls back to the
 * lossy `stringify` dump. A missed reconciliation must never write a config
 * that differs from the model the tools just validated.
 */
export function dumpConfig(config: PwaConfig): string {
  const doc = PARSED_DOCS.get(config.raw)
  if (doc !== undefined) {
    try {
      syncNode(doc.contents, config.raw, doc)
      const rendered = `${CONFIG_HEADER}\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}`
      const back = parseDocument(rendered).toJS({ mapAsMap: true })
      if (sameValue(back, config.raw)) return rendered
    } catch {
      // Fall through: the lossy dump is always faithful to `raw`.
    }
  }
  return `${CONFIG_HEADER}\n${stringify(config.raw, { lineWidth: 0 })}`
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
export function validateConfig(
  config: PwaConfig,
  db?: ResonanceDb,
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const { constraints } = config

  // Parse-time defects first: a step the reader could not represent (a
  // three-body step, a malformed mode) means the model is NOT what the file
  // says, so nothing downstream — least of all a fit — may run on it.
  errors.push(...(config.stepIssues ?? []))

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
    // A trans reference may be either form ctpwa accepts
    // (Parameters.cu buildWithTrans):
    //   - a bare intermediate name ("R_pbareta") — substring/instance match,
    //     the usual charge-conjugation coupling constraint; or
    //   - "<intermediate>_<blockIndex>" — explicit amplitude-block index.
    const isIntermediate = (n: string): boolean =>
      Object.values(config.decayChains).some((c) => c.intermediates[n] !== undefined)
    for (const name of t.names) {
      if (isIntermediate(name)) continue
      const m = /^(.+)_(\d+)$/.exec(name)
      if (!m) {
        errors.push({
          code: 'trans-bad-name',
          message: `trans references "${name}" — expected an intermediate name (e.g. R_Keta) or <intermediate>_<groupIndex> (e.g. R_Keta_0)`,
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
      } else {
        // Amplitude blocks = [J,P] groups × production channels: cascade
        // chains expand one group into one block per production step
        // (e.g. R_Keta produced via both chic1→Kp+R_Keta and
        // chic1→Km+R_Keta → indices 0..1, as fit.json's per-channel
        // coupling names confirm).
        const nGroups = found.intermediates[intName].groups.length
        const nChannels = Math.max(
          Object.values(config.decayChains)
            .flatMap((c) => c.steps)
            .filter((s) => s.daughters.includes(intName)).length,
          1,
        )
        const nBlocks = nGroups * nChannels
        if (idx >= nBlocks) {
          errors.push({
            code: 'trans-group-index',
            message: `trans references "${name}" but ${intName} has only ${nBlocks} amplitude block(s) (${nGroups} [J,P] group(s) × ${nChannels} production channel(s), indices 0..${nBlocks - 1})`,
          })
        }
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
    // Resolve a daughter's spin: a Particles entry, or (for a cascade) the
    // J of the first [J,P] group of the intermediate in this chain.
    const spinOf = (name: string): number | undefined => {
      const p = config.particles[name]
      if (p !== undefined) return p.j
      return chain.intermediates[name]?.groups?.[0]?.jp.j
    }
    for (const step of chain.steps) {
      for (const [s, l] of step.sl ?? []) {
        // Internal representation is {2S+1, L} (ctpwa Amp2BD::ComSL):
        // 2S+1 is a POSITIVE INTEGER for both integer and half-integer S
        // (S=0 -> 1, S=1/2 -> 2, S=1 -> 3); requiring odd 2S+1 would reject
        // every fermion (baryon) decay step.
        if (!Number.isInteger(s) || s < 1) {
          errors.push({
            code: 'sl-invalid-multiplicity',
            message: `step ${step.mother} -> ${step.daughters.join(' + ')}: sl multiplicity 2S+1 = ${s} must be a positive integer (S integer or half-integer)`,
          })
        } else if (step.daughters.length >= 2) {
          const j1 = spinOf(step.daughters[0]!)
          const j2 = spinOf(step.daughters[1]!)
          if (j1 !== undefined && j2 !== undefined) {
            const twoJ1 = Math.round(j1 * 2)
            const twoJ2 = Math.round(j2 * 2)
            const lo = Math.abs(twoJ1 - twoJ2) + 1
            const hi = twoJ1 + twoJ2 + 1
            if (s < lo || s > hi || (s - lo) % 2 !== 0) {
              errors.push({
                code: 'sl-spin-mismatch',
                message: `step ${step.mother} -> ${step.daughters.join(' + ')}: 2S+1 = ${s} is not realizable for J(${step.daughters[0]}) = ${j1} and J(${step.daughters[1]}) = ${j2} (2S+1 in {${Array.from({ length: (hi - lo) / 2 + 1 }, (_, i) => lo + 2 * i).join(', ')}})`,
              })
            }
          }
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

  // ---- PDGID-driven checks (only when the particle table is available) ----
  // `Particles.<name>.pdgid` is our extension; ctpwa ignores the key. It turns
  // the symmetry questions (identical / conjugate / self-conjugate / C) from
  // name heuristics into data. These are all WARNINGS: a wrong PDGID or a
  // missing identical declaration is a physics defect, not a parse failure,
  // and must not brick an otherwise loadable config.
  if (db !== undefined) {
    const identicalGroups = constraints.identical ?? []
    const declaredTogether = (a: string, b: string): boolean =>
      identicalGroups.some((g) => g.includes(a) && g.includes(b))
    const derivedGroups = deriveIdenticalGroups(config, db)

    for (const [name, p] of Object.entries(config.particles)) {
      if (p.pdgid === undefined) continue
      const info = getParticleInfo(db, p.pdgid)
      if (info === undefined) {
        warnings.push({
          code: 'pdgid-unknown',
          message: `Particles.${name}.pdgid = ${p.pdgid} is not in the PDG particle table — check the id (or drop the field to fall back to name-based checks)`,
        })
        continue
      }
      const cDisp = cValueOf(info)
      if (info.j !== undefined && info.j !== p.j) {
        warnings.push({
          code: 'pdgid-j-mismatch',
          message: `Particles.${name}: J = ${p.j} but PDGID ${p.pdgid} (${info.name}) has J = ${info.j}`,
        })
      }
      if (info.p !== undefined && info.p !== p.p) {
        warnings.push({
          code: 'pdgid-p-mismatch',
          message: `Particles.${name}: P = ${p.p > 0 ? '+' : '-'} but PDGID ${p.pdgid} (${info.name}) has P = ${info.p > 0 ? '+' : '-'}`,
        })
      }
      if (cDisp === undefined && p.c !== undefined) {
        warnings.push({
          code: 'pdgid-c-not-eigenstate',
          message: `Particles.${name}: an explicit C = ${p.c > 0 ? '+' : '-'} is set but PDGID ${p.pdgid} (${info.name}) is not a C eigenstate — the C will be ignored by the symmetry checks`,
        })
      }
    }

    // Identical-particle derivation: any two daughters of one two-body step
    // that carry the same PDGID must sit in one Constraints.identical group,
    // or the engine silently skips the Bose/Fermi symmetrisation.
    for (const chain of Object.values(config.decayChains)) {
      for (const step of chain.steps) {
        const [n1, n2] = step.daughters
        if (n1 === undefined || n2 === undefined) continue
        if (n1 === n2) {
          if (!declaredTogether(n1, n2)) {
            warnings.push({
              code: 'identical-not-declared',
              message: `step ${step.mother} -> ${n1} + ${n2} uses the same particle twice but "${n1}" is not in a Constraints.identical group — ctpwa will NOT symmetrise`,
            })
          }
          continue
        }
        const p1 = config.particles[n1]
        const p2 = config.particles[n2]
        if (p1?.pdgid === undefined || p2?.pdgid === undefined) continue
        if (!isIdenticalByPdgid(db, p1, p2)) continue
        if (declaredTogether(n1, n2)) continue
        const merged = derivedGroups.find((g) => g.includes(n1) && g.includes(n2))
        const suggested = JSON.stringify(merged ?? [n1, n2])
        warnings.push({
          code: 'identical-missing',
          message:
            `step ${step.mother} -> ${n1} + ${n2}: both have PDGID ${p1.pdgid} ` +
            `(${getParticleInfo(db, p1.pdgid)?.name}) — identical particles — but they are not in one ` +
            `Constraints.identical group, so ctpwa will NOT apply the Bose/Fermi selection rule; ` +
            `add Constraints.identical: [${suggested}]`,
        })
      }
    }

    // A declared identical group whose members carry different PDGIDs is a
    // wrong declaration (e.g. K0 vs K~0, which are a conjugate pair).
    for (const group of identicalGroups) {
      const pdgids = new Set<number>()
      for (const member of group) {
        const p = config.particles[member]
        if (p?.pdgid !== undefined && getParticleInfo(db, p.pdgid) !== undefined) {
          pdgids.add(p.pdgid)
        }
      }
      if (pdgids.size > 1) {
        warnings.push({
          code: 'identical-pdgid-mismatch',
          message: `Constraints.identical group ${JSON.stringify(group)} mixes different PDGIDs (${[...pdgids].join(', ')}) — these are not the same particle; check the declaration`,
        })
      }
    }
  }

  return { errors, warnings }
}
