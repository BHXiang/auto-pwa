/**
 * Attempt matrix for a multi-body isobar analysis.
 *
 * The matrix is the audit trail of what was *tried*, not just what was kept:
 *   - every first-level topology: included / excluded + reason;
 *   - every intermediate [J,P] group of every included topology: the PDG and
 *     non-resonant candidates that were tested, with NLL / k / AIC / BIC;
 *   - every final component: its deletion significance.
 *
 * This module is deliberately **advisory**.  `matrixCheck` reports what is
 * still missing; it does not refuse a fit or a completion.  The gate lives in
 * the loop/guard layer, added separately.
 *
 * Pure functions; no I/O.
 */
import type { PwaConfig } from './types.js'
import type { FirstLevelTopology, TopologyCoverage } from './topology.js'

export type TopologyStatus = 'included' | 'excluded' | 'pending'
export type RowStatus = 'kept' | 'rejected' | 'skipped' | 'pending'
export type PruneStatus = 'kept' | 'removed' | 'pending'

export interface MatrixTopology {
  /** Stable id derived from the partition, e.g. "2+2:etap+pip|pim+pi0". */
  id: string
  kind: string
  sides: string[][]
  /** The config realizes this partition (a production step matches it). */
  present: boolean
  /** Chain that realizes it, when present. */
  chain?: string
  status: TopologyStatus
  reason?: string
}

export interface MatrixRow {
  /** Topology id, when the caller records it. */
  topology?: string
  chain?: string
  intermediate: string
  /** J^P of the intermediate group, e.g. "0+". */
  jp: string
  candidate: string
  model: string
  fitDir?: string
  nll?: number
  k?: number
  aic?: number
  bic?: number
  deltaNll?: number
  deltaBic?: number
  status: RowStatus
  reason?: string
}

export interface MatrixPrune {
  component: string
  chain?: string
  deltaNll?: number
  deltaBic?: number
  status: PruneStatus
  reason?: string
}

export interface AttemptMatrix {
  version: 1
  finalState: string[]
  topologies: MatrixTopology[]
  rows: MatrixRow[]
  prunes: MatrixPrune[]
}

export interface MatrixStatus {
  topologies: number
  included: number
  excluded: number
  pendingTopologies: number
  rows: number
  kept: number
  rejected: number
  skipped: number
  pendingRows: number
  prunes: number
  removed: number
  pendingPrunes: number
}

export interface MatrixCheck {
  ok: boolean
  missing: string[]
}

/** Stable, human-readable id for a first-level partition. */
export function topologyId(t: FirstLevelTopology): string {
  const side = (s: FirstLevelTopology['sides'][number]): string => s.particles.join('+')
  return `${t.kind}:${side(t.sides[0])}|${side(t.sides[1])}`
}

/** Build the initial matrix: every partition starts pending, realized ones included. */
export function createMatrix(finalState: readonly string[], coverage: TopologyCoverage): AttemptMatrix {
  return {
    version: 1,
    finalState: [...finalState],
    topologies: coverage.topologies.map((t) => ({
      id: topologyId(t),
      kind: t.kind,
      sides: t.sides.map((s) => [...s.particles]),
      present: t.present,
      ...(t.realizedBy !== undefined ? { chain: t.realizedBy.chain } : {}),
      status: t.present ? 'included' : 'pending',
    })),
    rows: [],
    prunes: [],
  }
}

/** Append one candidate row (returns a new matrix). */
export function addRow(matrix: AttemptMatrix, row: MatrixRow): AttemptMatrix {
  return { ...matrix, rows: [...matrix.rows, row] }
}

/** Append one prune row (returns a new matrix). */
export function addPrune(matrix: AttemptMatrix, prune: MatrixPrune): AttemptMatrix {
  return { ...matrix, prunes: [...matrix.prunes, prune] }
}

/** Set one topology's status/reason (returns a new matrix). */
export function setTopologyStatus(
  matrix: AttemptMatrix,
  id: string,
  status: TopologyStatus,
  reason?: string,
): AttemptMatrix {
  return {
    ...matrix,
    topologies: matrix.topologies.map((t) =>
      t.id === id ? { ...t, status, ...(reason !== undefined ? { reason } : {}) } : t,
    ),
  }
}

/** Counts for a compact status line. */
export function matrixStatus(matrix: AttemptMatrix): MatrixStatus {
  return {
    topologies: matrix.topologies.length,
    included: matrix.topologies.filter((t) => t.status === 'included').length,
    excluded: matrix.topologies.filter((t) => t.status === 'excluded').length,
    pendingTopologies: matrix.topologies.filter((t) => t.status === 'pending').length,
    rows: matrix.rows.length,
    kept: matrix.rows.filter((r) => r.status === 'kept').length,
    rejected: matrix.rows.filter((r) => r.status === 'rejected').length,
    skipped: matrix.rows.filter((r) => r.status === 'skipped').length,
    pendingRows: matrix.rows.filter((r) => r.status === 'pending').length,
    prunes: matrix.prunes.length,
    removed: matrix.prunes.filter((p) => p.status === 'removed').length,
    pendingPrunes: matrix.prunes.filter((p) => p.status === 'pending').length,
  }
}

const jpLabel = (g: { jp: { j: number; p: 1 | -1 } }): string => `${g.jp.j}${g.jp.p > 0 ? '+' : '-'}`

/**
 * Report what the matrix does not yet cover.  Advisory only.
 *
 * Covered means:
 *   - every topology has status included/excluded, and an excluded one has a
 *     reason;
 *   - every [J,P] group of every intermediate in every included chain has at
 *     least one row (a `skipped` row with a reason counts as covered);
 *   - every final resonance has a prune row (kept or removed);
 *   - no row/prune is left `pending`, and skipped rows carry a reason.
 */
export function matrixCheck(matrix: AttemptMatrix, config: PwaConfig): MatrixCheck {
  const missing: string[] = []
  for (const t of matrix.topologies) {
    if (t.status === 'pending') missing.push(`topology ${t.id}: status pending`)
    if (t.status === 'excluded' && (t.reason === undefined || t.reason.trim() === '')) {
      missing.push(`topology ${t.id}: excluded without reason`)
    }
  }
  for (const t of matrix.topologies) {
    if (t.status !== 'included') continue
    const chainName = t.chain
    if (chainName === undefined) {
      missing.push(`topology ${t.id}: included but no chain is recorded (pass topology/reason)`)
      continue
    }
    const chain = config.decayChains[chainName]
    if (chain === undefined) {
      missing.push(`topology ${t.id}: chain ${chainName} not in config`)
      continue
    }
    for (const [intName, int] of Object.entries(chain.intermediates)) {
      for (const g of int.groups) {
        const jp = jpLabel(g)
        const has = matrix.rows.some(
          (r) => r.intermediate === intName && r.jp === jp && (r.status === 'kept' || r.status === 'rejected' || r.status === 'skipped'),
        )
        if (!has) missing.push(`topology ${t.id}: no candidate row for ${intName} [${jp}]`)
      }
    }
  }
  for (const name of Object.keys(config.resonances)) {
    const has = matrix.prunes.some((p) => p.component === name && p.status !== 'pending')
    if (!has) missing.push(`component ${name}: no prune row`)
  }
  for (const r of matrix.rows) {
    if (r.status === 'pending') missing.push(`row ${r.intermediate} [${r.jp}] ${r.candidate}: status pending`)
    if (r.status === 'skipped' && (r.reason === undefined || r.reason.trim() === '')) {
      missing.push(`row ${r.intermediate} [${r.jp}] ${r.candidate}: skipped without reason`)
    }
    if ((r.status === 'kept' || r.status === 'rejected') && r.nll === undefined && r.deltaNll === undefined) {
      missing.push(`row ${r.intermediate} [${r.jp}] ${r.candidate}: kept/rejected without nll/deltaNll`)
    }
  }
  for (const p of matrix.prunes) {
    if (p.status === 'pending') missing.push(`prune ${p.component}: status pending`)
    if (p.status !== 'pending' && p.deltaNll === undefined && p.deltaBic === undefined && p.reason === undefined) {
      missing.push(`prune ${p.component}: no deltaNll/deltaBic/reason`)
    }
  }
  return { ok: missing.length === 0, missing }
}

const fmt = (v: number | undefined, digits = 2): string => (v === undefined ? '—' : v.toFixed(digits))

/** Markdown view, for FINAL-ATTEMPT-MATRIX.md and the check output. */
export function renderMatrixMarkdown(matrix: AttemptMatrix, check?: MatrixCheck): string {
  const lines: string[] = []
  lines.push('# Attempt matrix', '')
  lines.push(`Final state: ${matrix.finalState.join(' ')}`, '')
  lines.push('## First-level topologies', '')
  lines.push('| id | kind | sides | present | status | reason |')
  lines.push('|---|---|---|---|---|---|')
  for (const t of matrix.topologies) {
    lines.push(
      `| ${t.id} | ${t.kind} | ${t.sides.map((s) => s.join('+')).join(' | ')} | ${t.present ? 'yes' : 'no'} | ${t.status} | ${t.reason ?? ''} |`,
    )
  }
  lines.push('', '## Candidate rows', '')
  lines.push('| topology | chain | intermediate | [J,P] | candidate | model | NLL | k | AIC | BIC | ΔNLL | ΔBIC | status | reason |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of matrix.rows) {
    lines.push(
      `| ${r.topology ?? ''} | ${r.chain ?? ''} | ${r.intermediate} | ${r.jp} | ${r.candidate} | ${r.model} | ${fmt(r.nll)} | ${r.k ?? ''} | ${fmt(r.aic)} | ${fmt(r.bic)} | ${fmt(r.deltaNll)} | ${fmt(r.deltaBic)} | ${r.status} | ${r.reason ?? ''} |`,
    )
  }
  lines.push('', '## Prune rows', '')
  lines.push('| component | chain | ΔNLL | ΔBIC | status | reason |')
  lines.push('|---|---|---|---|---|---|')
  for (const p of matrix.prunes) {
    lines.push(`| ${p.component} | ${p.chain ?? ''} | ${fmt(p.deltaNll)} | ${fmt(p.deltaBic)} | ${p.status} | ${p.reason ?? ''} |`)
  }
  if (check !== undefined) {
    lines.push('', '## Check', '')
    lines.push(check.ok ? 'All rows covered (advisory).' : 'Missing:')
    for (const m of check.missing) lines.push(`- ${m}`)
  }
  lines.push('')
  return lines.join('\n')
}
