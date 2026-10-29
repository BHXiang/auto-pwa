/**
 * slurm-template — where a submission script comes from, and how it is
 * submitted.
 *
 * Design (changed 2026-10, from a real cluster run): the plugin does NOT
 * synthesize `#SBATCH` directives. The AI owns `<iterDir>/job.sh`: it either
 * lets the plugin install the single bundled template
 * (`scripts/slurm-job.sh`, V100 defaults + an A100 swap table) or writes its
 * own. The runner then submits it verbatim:
 *
 *     sbatch --chdir=<iterDir> <job.sh> [fit.py args...]
 *
 * Why:
 *   - partition/qos/gres and the ctpwa environment (conda env bin/lib,
 *     CUDA_HOME, LD_LIBRARY_PATH) are cluster facts that already live in the
 *     user's own scripts (`solve2/job_a100.sh`, `job_v100.sh`). Baking them
 *     into the plugin meant changing a GPU count required a HARNESS RESTART,
 *     and the old `gpu:a100:2` default once sat in the queue for an hour while
 *     the user's scripts asked for 1 GPU.
 *   - `conda activate` is unreliable on compute nodes; the template points
 *     straight at `<env>/bin` and `<env>/lib` instead.
 *   - ONE template, explained line by line: the AI only edits the three
 *     starred resource lines when it wants A100 instead of V100.
 *
 * Convention (the bundled template follows it):
 *   - the working directory is set by `--chdir`, so the script must NOT `cd`
 *     and must NOT hardcode an iteration path (that is what lets one job.sh
 *     serve `_trials/<candidate>/` too);
 *   - extra arguments after the script are forwarded to fit.py (`"$@"`), so
 *     `--runs/--max-iter/--config` keep working;
 *   - the log must land in `<iterDir>/fit.log` (the runner tails it).
 */
import { chmodSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Filename installed into an iteration directory. */
export const JOB_SCRIPT_NAME = 'job.sh'

/**
 * `jobScript` keywords that mean "install the bundled template".
 * `v100`/`a100` are kept as aliases for older calls (and for an AI that
 * naturally asks for a card type); they install the SAME file — the template
 * explains how to switch to A100 in three lines.
 */
export const JOB_TEMPLATE_ALIASES: readonly string[] = ['auto', 'v100', 'a100']

/** True when a `jobScript` argument names the bundled template, not a path. */
export function isJobTemplateAlias(value: string): boolean {
  return JOB_TEMPLATE_ALIASES.includes(value)
}

/**
 * Locate the bundled `scripts/slurm-job.sh` from source (`src/`), built
 * `lib/`, or the published package — same candidate discipline as
 * `bundledAifitPath()`: `lib/scripts/` is a stale duplicate in some tarballs
 * and must never shadow the package-root copy.
 */
export function bundledJobTemplatePath(): string {
  const candidates = [
    new URL('../scripts/slurm-job.sh', import.meta.url).pathname, // source: root scripts/
    new URL('../../scripts/slurm-job.sh', import.meta.url).pathname, // lib/src/: root scripts/
  ]
  return (
    candidates.find((p) => !p.includes('/lib/scripts/') && existsSync(p)) ??
    candidates.find((p) => existsSync(p)) ??
    candidates[0]!
  )
}

/** Result of deciding which submission script an iteration will use. */
export interface ResolvedJobScript {
  /** Absolute path of the script handed to `sbatch`. */
  path: string
  /** True when the bundled template was copied into the iteration directory. */
  installed: boolean
}

/** Options for resolving the submission script of one iteration. */
export interface ResolveJobScriptOptions {
  /** Iteration directory that will be the job's working directory. */
  iterDir: string
  /** `"auto"`/`"v100"`/`"a100"` (install the template), a path, or undefined. */
  jobScript?: string
  /** When false, never write into the iteration directory (validation only). */
  install?: boolean
}

/**
 * Decide which SLURM script to submit for one iteration.
 *
 * Resolution order:
 *   1. `jobScript: "auto"|"v100"|"a100"` -> install `scripts/slurm-job.sh` as
 *      `<iterDir>/job.sh` (an existing job.sh is kept: it may be customized).
 *   2. `jobScript: "<path>"` -> use it (relative paths resolve against iterDir).
 *   3. omitted -> `<iterDir>/job.sh` if present, else install the template
 *      (so a fresh iteration never depends on the AI getting the environment
 *      block right by hand).
 *
 * Throws with an actionable message when an explicit path does not exist.
 */
export function resolveJobScript(opts: ResolveJobScriptOptions): ResolvedJobScript {
  const install = opts.install !== false
  const target = join(opts.iterDir, JOB_SCRIPT_NAME)
  const spec = opts.jobScript?.trim()

  if (spec !== undefined && spec !== '' && !isJobTemplateAlias(spec)) {
    const path = isAbsolute(spec) ? spec : join(opts.iterDir, spec)
    if (!existsSync(path)) {
      throw new Error(
        `jobScript 不存在: ${path}\n` +
          `写一个提交脚本（可先复制插件模板）再提交：\n` +
          `  cp "${bundledJobTemplatePath()}" "${target}"\n` +
          `或者直接传 jobScript: "auto"，插件会把模板装成 ${target}。`,
      )
    }
    if (statSync(path).isDirectory()) throw new Error(`jobScript 是目录，不是脚本: ${path}`)
    return { path, installed: false }
  }

  if (existsSync(target)) return { path: target, installed: false }
  if (!install) return { path: target, installed: false }
  return installTemplate(opts.iterDir, target, true)
}

function installTemplate(iterDir: string, target: string, install: boolean): ResolvedJobScript {
  if (existsSync(target)) return { path: target, installed: false }
  if (!install) return { path: target, installed: false }
  const source = bundledJobTemplatePath()
  if (!existsSync(source)) {
    throw new Error(
      `找不到内置 SLURM 模板 ${source}；请自己写 ${target}（${iterDir} 会被 --chdir 设为工作目录，` +
        `脚本里不要写 cd，日志写到 fit.log，参数透传给 fit.py）。`,
    )
  }
  copyFileSync(source, target)
  try {
    chmodSync(target, 0o755)
  } catch {
    // Best effort; sbatch can read a non-executable script.
  }
  return { path: target, installed: true }
}

/** Short human hint describing how to obtain a job script (error/help text). */
export function jobScriptHint(): string {
  return (
    `jobScript: "auto"（省略也行）会把内置模板装成 <iterDir>/job.sh —— 模板默认 V100，` +
    `换 A100 只需改 Part 1 里带 ★ 的 3 行；也可以自己写 <iterDir>/job.sh（模板: ${bundledJobTemplatePath()}）`
  )
}
