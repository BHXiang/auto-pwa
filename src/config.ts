/**
 * Environment-driven configuration for the harness-facing parts of auto-pwa.
 *
 * The pure physics core (src/) is environment-free. This module centralizes
 * every machine-specific path the fit runner and plugin need, overridable
 * through environment variables so the package works on other machines and
 * in CI:
 *
 *   PWA_CTPWA_PYTHON   ctpwa env python (with torch/ctpwa/uproot)
 *   PWA_LD_LIBRARY_PATH  libs for importing ctpwa (ROOT/CUDA/torch)
 *   PWA_FIT_SCRIPT     default fit.py source for auto_pwa_iterate/auto_pwa_round
 *   PWA_PLOT_SCRIPT    default plot.py source
 *   PWA_EVAL_OUT_DIR   directory for auto_pwa_evaluate output packages
 */
export interface AutoPwaEnv {
  ctpwaPython?: string
  ldLibraryPath?: string
  fitScript?: string
  plotScript?: string
  evaluateOutDir?: string
}

/** Locally verified defaults (the original developer's machine). */
export const PWA_DEFAULTS = {
  ctpwaPython: '/home/whitewash/miniconda3/envs/ctpwa/bin/python',
  torchLib: '/home/whitewash/miniconda3/envs/ctpwa/lib/python3.12/site-packages/torch/lib',
  ldLibraryPath: '/usr/local/cuda-13.2/lib64:/home/whitewash/miniconda3/envs/ctpwa/lib/python3.12/site-packages/torch/lib:/home/whitewash/pkgs/root/lib',
  fitScript: '/home/whitewash/pwa/Jpsi2KKeta/solve2/fit.py',
  plotScript: '/home/whitewash/pwa/Jpsi2KKeta/solve2/plot.py',
  evaluateOutDir: '/home/whitewash/pwa/_auto-pwa-eval',
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
