/**
 * Environment-driven configuration for the harness-facing parts of auto-pwa.
 *
 * The pure physics core (src/) is environment-free. This module centralizes
 * every machine-specific path the fit runner and plugin need, overridable
 * through environment variables so the package works on other machines and
 * in CI:
 *
 *   PWA_CTPWA_PYTHON    ctpwa env python (with torch/ctpwa/uproot).
 *                       Default: `python` resolved through PATH — a
 *                       conda-activated ctpwa env needs no explicit path.
 *   PWA_LD_LIBRARY_PATH  libs for importing ctpwa (ROOT/CUDA/torch).
 *                       Default: empty — nothing is injected and the child
 *                       inherits the ambient environment (conda supplies
 *                       its own loader paths when the env is active).
 *   PWA_FIT_SCRIPT      default fit.py source for auto_pwa_iterate/auto_pwa_round.
 *                       Default: the bundled scripts/aifit.py (AI-first
 *                       driver writing results/fit.json + weight_best.root).
 *   PWA_PLOT_SCRIPT     default plot.py source (no bundled plot script; set
 *                       this to your solver's plot.py when plots are needed).
 *   PWA_EVAL_OUT_DIR    directory for auto_pwa_evaluate output packages.
 *                       Default: empty — evaluated under
 *                       `<cwd>/_auto-pwa-eval`.
 *
 * Cluster transport (SLURM) environment:
 *   PWA_FIT_TRANSPORT auto|local|slurm  where a fit runs. auto = local if torch
 *                       sees CUDA, else slurm if the slurm clients are on PATH
 *                       (the "no local GPU but have SLURM -> submit a job" rule).
 *                       Default: auto.
 *   PWA_SLURM_TEMPLATE a100|v100         cluster shape for partition/qos/account/
 *                       gres defaults (Default: a100).
 *   PWA_SLURM_PARTITION/QOS/ACCOUNT/GRES/NTASKS/MEM_PER_CPU/TIME
 *                       per-cluster overrides (fall back to template defaults).
 *   PWA_SLURM_BATCH  auto|one|script|off  candidate exploration batching (see the
 *                       try_candidates tool). auto chooses one vs script from the
 *                       baseline fit's measured timeSec (Default: auto).
 */
export interface AutoPwaEnv {
  ctpwaPython?: string
  ldLibraryPath?: string
  fitScript?: string
  plotScript?: string
  evaluateOutDir?: string
}

/**
 * Portable defaults (no machine-specific paths). `fitScript` points at the
 * plugin's own AI-first fit driver; an empty value means "inherit/unset"
 * for ldLibraryPath/plotScript/evaluateOutDir.
 */
import { existsSync } from 'node:fs'

/** Locate the bundled scripts/aifit.py from source (src/), built lib/, or the
 * published package (top-level scripts/). */
export function bundledAifitPath(): string {
  const fromSource = new URL('../scripts/aifit.py', import.meta.url).pathname // src/config.ts -> scripts/
  const fromLib = new URL('../../scripts/aifit.py', import.meta.url).pathname // lib/src/config.js -> scripts/
  if (existsSync(fromSource)) return fromSource
  if (existsSync(fromLib)) return fromLib
  return fromSource // best-effort; resolveEnv callers surface a clear "not found"
}

export const PWA_DEFAULTS = {
  ctpwaPython: 'python',
  ldLibraryPath: '',
  fitScript: bundledAifitPath(),
  plotScript: '',
  evaluateOutDir: '',
} as const

/** Resolve configuration from the process environment. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): Required<AutoPwaEnv> {
  return {
    ctpwaPython: env.PWA_CTPWA_PYTHON ?? PWA_DEFAULTS.ctpwaPython,
    ldLibraryPath: env.PWA_LD_LIBRARY_PATH ?? PWA_DEFAULTS.ldLibraryPath,
    fitScript: env.PWA_FIT_SCRIPT ?? PWA_DEFAULTS.fitScript,
    plotScript: env.PWA_PLOT_SCRIPT ?? PWA_DEFAULTS.plotScript,
    evaluateOutDir: env.PWA_EVAL_OUT_DIR ?? PWA_DEFAULTS.evaluateOutDir,
  }
}
