/**
 * slurm-template — render SLURM submission scripts for the two known cluster
 * shapes (A100 / V100). Pure string rendering, no I/O; the transport layer
 * (fit-runner-sbatch) writes the result to `<iterDir>/fit.slurm` and runs
 * `sbatch`.
 *
 * Both templates run the fit in the FOREGROUND (`python -u fit.py`), identical
 * to the local runner — a backgrounded fit (`&`) would let the SLURM job
 * complete before the fit does, breaking the "wait for the job, then wake the
 * AI" contract (the DSH background job's `done` resolves on SLURM completion).
 *
 * Partition/qos/account/gres are template defaults but every field can be
 * overridden through PWA_SLURM_* environment variables (see config.ts).
 */

/** The two known cluster template kinds. */
export type SlurmTemplateKind = 'a100' | 'v100'

/** Per-kind SLURM defaults (partition + qos + account + gres). */
export interface SlurmTemplateDefaults {
  partition: string
  qos: string
  account: string
  gres: string
}

/** Defaults matching the user's two cluster scripts. */
export const SLURM_TEMPLATE_DEFAULTS: Record<SlurmTemplateKind, SlurmTemplateDefaults> = {
  a100: { partition: 'gpupwa', qos: 'pwadedicate', account: 'gpupwa', gres: 'gpu:a100:2' },
  v100: { partition: 'gpu', qos: 'pwanormal', account: 'gpupwa', gres: 'gpu:v100:2' },
}

/** Resolve a template kind from PWA_SLURM_TEMPLATE (default 'a100'). */
export function resolveSlurmTemplateKind(env: NodeJS.ProcessEnv = process.env): SlurmTemplateKind {
  const v = (env.PWA_SLURM_TEMPLATE ?? 'a100').toLowerCase().trim()
  return v === 'v100' ? 'v100' : 'a100'
}

/** Everything needed to render one submission script. */
export interface SlurmRenderOptions {
  /** Template kind; selects the partition/qos/account/gres defaults. */
  kind: SlurmTemplateKind
  /** Overrides (falls back to the template default when unset). */
  partition?: string
  qos?: string
  account?: string
  gres?: string
  ntasks?: number
  memPerCpu?: number
  /** Optional SLURM time limit (e.g. '4:00:00'). Omit for none. */
  timeLimit?: string
  /** #SBATCH --job-name. */
  jobName: string
  /** #SBATCH --output path (typically `<iterDir>/fit.log`). */
  output: string
  /** ctpwa env python (absolute path recommended — shared filesystem). */
  python: string
  /** Extra loader paths for importing ctpwa (ROOT/CUDA/torch); '' = inherit. */
  ldLibraryPath: string
  /** Fit entry script name relative to the submit dir (default 'fit.py'). */
  fitScript?: string
  /** Extra args appended after the fit script (e.g. --runs 1 --max-iter 500). */
  scriptArgs?: string[]
  /** Extra commands to inject at the top of the job body. */
  preamble?: string[]
  /** Absolute working directory the job must cd into before running the fit
   * (the iteration dir; ctpwa reads config.yml from cwd). Defaults to
   * $SLURM_SUBMIT_DIR when omitted. */
  cwd?: string
}

/** Body command to run one fit in a submit dir. */
function fitCommand(opts: SlurmRenderOptions): string {
  const py = [opts.python, opts.fitScript ?? 'fit.py', ...(opts.scriptArgs ?? [])]
  return py.join(' ')
}

/**
 * Render a single-fit submission script. The job cd's to the submit dir so
 * ctpwa reads `config.yml` from the iteration directory (aifit.py's cwd
 * contract) and writes `results/` back there.
 */
export function renderSlurmSubmission(opts: SlurmRenderOptions): string {
  const d = SLURM_TEMPLATE_DEFAULTS[opts.kind]
  const partition = opts.partition ?? d.partition
  const qos = opts.qos ?? d.qos
  const account = opts.account ?? d.account
  const gres = opts.gres ?? d.gres
  const ntasks = opts.ntasks ?? 1
  const memPerCpu = opts.memPerCpu ?? 50000

  const lines: string[] = ['#!/bin/bash']
  lines.push(`#SBATCH --partition=${partition}`)
  lines.push(`#SBATCH --qos=${qos}`)
  lines.push(`#SBATCH --account=${account}`)
  lines.push(`#SBATCH --job-name=${opts.jobName}`)
  lines.push(`#SBATCH --output=${opts.output}`)
  lines.push(`#SBATCH --ntasks=${ntasks}`)
  lines.push(`#SBATCH --mem-per-cpu=${memPerCpu}`)
  lines.push(`#SBATCH --gres=${gres}`)
  if (opts.timeLimit !== undefined && opts.timeLimit.length > 0) {
    lines.push(`#SBATCH --time=${opts.timeLimit}`)
  }
  lines.push('')
  lines.push('# 提交目录 = 迭代目录（aifit.py 从 cwd 读 config.yml 并写 results/）')
  lines.push(opts.cwd !== undefined ? `cd "${opts.cwd}"` : 'cd "$SLURM_SUBMIT_DIR"')
  for (const p of opts.preamble ?? []) lines.push(p)
  lines.push('echo "开始时间: $(date)"')
  lines.push('srun -l hostname')
  if (opts.ldLibraryPath !== '') {
    lines.push(`export LD_LIBRARY_PATH="${opts.ldLibraryPath}${opts.ldLibraryPath.length > 0 ? ':$LD_LIBRARY_PATH' : ''}"`)
  }
  lines.push(fitCommand(opts))
  lines.push('echo "结束时间: $(date)"')
  return lines.join('\n') + '\n'
}

/**
 * Render a batch submission script that runs several iteration fits in one
 * SLURM job, one after another (for short fits: one wake, one cluster slot).
 * Each fit runs in its own submit dir with its own scriptArgs.
 */
export interface BatchCmd {
  iterDir: string
  python: string
  ldLibraryPath: string
  fitScript?: string
  scriptArgs?: string[]
}

export function renderSlurmBatchSubmission(opts: Omit<SlurmRenderOptions, 'output' | 'python' | 'ldLibraryPath' | 'fitScript' | 'scriptArgs'> & {
  output: string
  commands: BatchCmd[]
}): string {
  const d = SLURM_TEMPLATE_DEFAULTS[opts.kind]
  const partition = opts.partition ?? d.partition
  const qos = opts.qos ?? d.qos
  const account = opts.account ?? d.account
  const gres = opts.gres ?? d.gres
  const ntasks = opts.ntasks ?? 1
  const memPerCpu = opts.memPerCpu ?? 50000

  const lines: string[] = ['#!/bin/bash']
  lines.push(`#SBATCH --partition=${partition}`)
  lines.push(`#SBATCH --qos=${qos}`)
  lines.push(`#SBATCH --account=${account}`)
  lines.push(`#SBATCH --job-name=${opts.jobName}`)
  lines.push(`#SBATCH --output=${opts.output}`)
  lines.push(`#SBATCH --ntasks=${ntasks}`)
  lines.push(`#SBATCH --mem-per-cpu=${memPerCpu}`)
  lines.push(`#SBATCH --gres=${gres}`)
  if (opts.timeLimit !== undefined && opts.timeLimit.length > 0) {
    lines.push(`#SBATCH --time=${opts.timeLimit}`)
  }
  lines.push('')
  lines.push('# 批量拟合：多个候选在一个 SLURM 作业里顺序跑（短拟合 -> 一次唤醒）')
  let i = 0
  for (const cmd of opts.commands) {
    i += 1
    lines.push(`echo "===== fit ${i}/${opts.commands.length}: ${cmd.iterDir} @ $(date) ====="`)
    lines.push(`cd "${cmd.iterDir}"`)
    if (cmd.ldLibraryPath !== '') {
      lines.push(`export LD_LIBRARY_PATH="${cmd.ldLibraryPath}:$LD_LIBRARY_PATH"`)
    }
    lines.push([cmd.python, cmd.fitScript ?? 'fit.py', ...(cmd.scriptArgs ?? [])].join(' '))
  }
  lines.push('echo "===== batch done @ $(date) ====="')
  return lines.join('\n') + '\n'
}
