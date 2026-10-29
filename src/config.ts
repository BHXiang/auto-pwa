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
 *   PWA_FIT_SCRIPT      default fit.py source for auto_pwa_run_fit/iter_start.
 *                       Default: the bundled scripts/aifit.py (AI-first
 *                       driver writing results/fit.json + weight_best.root).
 *   PWA_PLOT_SCRIPT     default plot.py source (no bundled plot script; set
 *                       this to your solver's plot.py when plots are needed).
 *   PWA_EVAL_OUT_DIR    directory for auto_pwa_evaluate output packages.
 *                       Default: empty — evaluated under
 *                       `<cwd>/_auto-pwa-eval`.
 *
 * Execution target (where a fit runs) — chosen per call, see src/fit-target.ts:
 *   PWA_FIT_TARGET auto|cpu|gpu|slurm   deployment default when `target` is
 *                       omitted. auto = gpu if the HOST probe sees CUDA, else
 *                       cpu; on a login node (slurm clients, no GPU) auto
 *                       refuses to guess and asks for an explicit target.
 *   PWA_FIT_TRANSPORT  [deprecated] local~auto, slurm~target=slurm.
 *   (no PWA_SLURM_PARTITION/QOS/GRES/TEMPLATE: partition, qos, gres and the
 *    ctpwa environment live in `<iterDir>/job.sh` — one bundled template with
 *    per-line explanations; the AI edits it, the plugin only runs `sbatch`.)
 *   PWA_SLURM_SCANCEL_ON_CANCEL  set 1 to scancel the cluster job when the DSH
 *                       job is cancelled. Default: detach (a harness restart
 *                       must not kill a running fit).
 *   PWA_SLURM_BATCH  auto|one|off        candidate exploration batching (see the
 *                       try_candidates tool); one SLURM job per candidate, all
 *                       from the same job.sh, one wake (Default: auto).
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
 * published package (top-level scripts/).
 *
 * Both `src/config.ts` (`../scripts`) and `lib/src/config.js` (`../../scripts`)
 * resolve to the PACKAGE ROOT `scripts/`; the compiled layout's `../scripts`
 * lands on `lib/scripts/`, a duplicate that some published tarballs carry.
 * That duplicate is stale, so it must never shadow the real script: prefer
 * any candidate outside `lib/`. */
export function bundledAifitPath(): string {
  const candidates = [
    new URL('../scripts/aifit.py', import.meta.url).pathname, // source: root scripts/
    new URL('../../scripts/aifit.py', import.meta.url).pathname, // lib/src/: root scripts/
  ]
  return (
    candidates.find((p) => !p.includes('/lib/scripts/') && existsSync(p)) ??
    candidates.find((p) => existsSync(p)) ??
    candidates[0]!
  )
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
