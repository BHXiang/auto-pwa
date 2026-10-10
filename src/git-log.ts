/**
 * git-log: 本地分波记录（不 push、无远端）。
 *
 * 与 provenance（results/provenance.json 的 md5）互补：md5 只能**发现**配置变过，
 * git 能**还原**任意一轮的原文，并直接回答"哪一轮改了什么"：
 *
 *   git --git-dir=<analysis>/.pwa-git --work-tree=<analysis> log -p -- config.yml
 *   git ... log -S X1750 -- config.yml      # 这个态是哪轮进来的
 *   git ... show iter-007:config.yml        # 取回那一刻的配置
 *
 * 关键取舍：
 *   - **独立 git 目录** `.pwa-git`：不碰 enclosing repo（分析目录常常位于一个
 *     很脏的现有仓库里），不改目录形状，删掉即消失。
 *   - **只跟踪文本**：数据/结果（*.root、*.dat、fit.log…）由 .gitignore 排除，
 *     小体量输入表（interp_*.dat）用否定规则保留 —— 它们进振幅，必须可复现。
 *   - **append-only**：只用 init/add/commit/log/show/diff/tag；绝不 checkout /
 *     reset / clean / add -A。记录是尽力而为，失败一律降级，不阻塞拟合。
 *
 * 环境开关：
 *   PWA_GIT=off        完全关闭记录
 *   PWA_GIT_ROOT=<dir> 强制把仓库根定在这个目录（默认按 `.pwa-git`/`iterations/`
 *                      就近判定）。一个分析目录下有很多 run_* 变体目录时，用它把
 *                      它们统一进一个历史。目录必须已存在。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 独立 git 目录名（放在分析目录内）。 */
export const PWA_GIT_DIRNAME = '.pwa-git'

/** .gitignore 托管块的起止标记（整块可删，重复调用幂等）。 */
const IGNORE_BEGIN = '# >>> auto-pwa managed (本地分波记录；整块可删) >>>'
const IGNORE_END = '# <<< auto-pwa managed <<<'

/**
 * 托管忽略规则。刻意保持小：
 *   - 数据/结果：*.root, *.dat（但保留 interp_*.dat —— Interp 模型的输入表，
 *     是小体积文本，丢了就没法复现线形）, fit.log, *.slurm, slurm-*.out
 *   - 派生视图：*.html（日记页由 SUMMARY.jsonl 渲染）, *.png/*.pdf（图）
 *   - 备份/缓存：*.bak（git 自己就是上一版）, __pycache__, *.pyc
 */
const MANAGED_IGNORE = [
  '.pwa-git/',
  '*.root',
  '*.dat',
  '!interp_*.dat',
  '*.log',
  '*.slurm',
  'slurm-*.out',
  '*.bak',
  '*.html',
  '*.png',
  '*.pdf',
  '*.pyc',
  '__pycache__/',
]

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface GitCommitInfo {
  sha: string
  short: string
  date?: string
  subject: string
}

/** Provenance 里记录的 git 绑定：md5 ↔ commit 互验。 */
export interface GitProvenance {
  /** 记录所用的仓库（分析目录 + .pwa-git）。 */
  repo: string
  /** 当时的 HEAD（短 sha）；无提交时缺省。 */
  commit?: string
  /** **已跟踪文件**相对 HEAD 有改动（true = 结果不可由 HEAD 复现）。
   * 未跟踪的新文件不算 dirty（它们不影响已记录 config 的 md5↔commit 绑定），
   * 需要的场合看 `untracked`。 */
  dirty?: boolean
  /** 未跟踪且未被忽略的文件数（新变体配置等；软信号）。 */
  untracked?: number
}

/** `PWA_GIT=off` 时整个记录链路静默关闭。 */
export function gitDisabled(): boolean {
  const v = process.env.PWA_GIT
  return v !== undefined && /^(off|0|false|no)$/i.test(v.trim())
}

const GIT_TIMEOUT_MS = 30_000

/** Run git with an explicit git-dir/work-tree; never throws. */
function run(analysisDir: string, args: string[], maxBytes = 64 * 1024): GitResult {
  try {
    const r = spawnSync('git', ['--git-dir', join(analysisDir, PWA_GIT_DIRNAME), '--work-tree', analysisDir, ...args], {
      cwd: analysisDir,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 8 * 1024 * 1024,
    })
    if (r.error !== undefined) return { ok: false, stdout: '', stderr: '', error: r.error.message }
    const stdout = (r.stdout ?? '').slice(0, maxBytes)
    const stderr = (r.stderr ?? '').slice(0, maxBytes)
    return { ok: r.status === 0, stdout, stderr, error: r.status === 0 ? undefined : `${stderr.trim() || `exit ${r.status}`}` }
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', error: (e as Error).message }
  }
}

/** git 可执行文件是否存在（缓存一次探测结果）。 */
let gitAvailableCache: boolean | undefined
export function gitAvailable(): boolean {
  if (gitAvailableCache !== undefined) return gitAvailableCache
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    gitAvailableCache = r.status === 0
  } catch {
    gitAvailableCache = false
  }
  return gitAvailableCache
}

/** 测试用：清掉 gitAvailable 的缓存。 */
export function resetGitProbe(): void {
  gitAvailableCache = undefined
}

/**
 * 从任意文件/目录向上找分析根：优先已有 `.pwa-git`，其次含 `iterations/` 的目录
 * （插件的迭代约定），最多 8 层；都没有时退回起点所在目录。
 */
export function analysisRootOf(startPath: string): string {
  // Explicit override wins (one history for many run dirs).
  const forced = process.env.PWA_GIT_ROOT
  if (forced !== undefined && forced.trim() !== '' && existsSync(forced)) return resolve(forced)
  let dir: string
  try {
    dir = lstatSync(startPath).isDirectory() ? resolve(startPath) : resolve(dirname(startPath))
  } catch {
    dir = resolve(dirname(startPath))
  }
  const fallback = dir
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, PWA_GIT_DIRNAME))) return dir
    if (existsSync(join(dir, 'iterations'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return fallback
}

/** 初始化独立仓库（幂等）并补齐本地提交身份。 */
export function ensureRepo(analysisDir: string): GitResult {
  const dir = join(analysisDir, PWA_GIT_DIRNAME)
  if (existsSync(join(dir, 'HEAD'))) return { ok: true, stdout: '', stderr: '' }
  const init = run(analysisDir, ['init', '--quiet', '--initial-branch=main'])
  if (!init.ok) return init
  // 提交身份：全局已配则不动；否则补本地身份，避免 commit 因缺身份失败。
  for (const [key, value] of [['user.name', 'auto-pwa'], ['user.email', 'auto-pwa@localhost']] as const) {
    const probe = run(analysisDir, ['config', key])
    if (!probe.ok || probe.stdout.trim() === '') run(analysisDir, ['config', key, value])
  }
  return { ok: true, stdout: '', stderr: '' }
}

/**
 * 幂等写入托管 .gitignore 块（保留既有内容；嵌套 .gitignore 对 enclosing repo
 * 同样生效，顺带减少分析目录在别人仓库里的状态噪声）。
 */
export function writeGitignore(analysisDir: string): { path: string; changed: boolean; error?: string } {
  const path = join(analysisDir, '.gitignore')
  const block = [IGNORE_BEGIN, ...MANAGED_IGNORE, IGNORE_END].join('\n')
  let existing = ''
  try {
    if (existsSync(path)) existing = readFileSync(path, 'utf8')
  } catch (e) {
    return { path, changed: false, error: (e as Error).message }
  }
  const start = existing.indexOf(IGNORE_BEGIN)
  const end = existing.indexOf(IGNORE_END)
  let next: string
  if (start >= 0 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + IGNORE_END.length)
  } else {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    next = existing + sep + (existing === '' ? '' : '\n') + block + '\n'
  }
  if (next === existing) return { path, changed: false }
  try {
    writeFileSync(path, next)
    return { path, changed: true }
  } catch (e) {
    return { path, changed: false, error: (e as Error).message }
  }
}

/** 提交清单：相对/绝对路径均可，会自动过滤出分析目录内的普通文件（跳过符号链接）。 */
export interface CommitResult {
  committed: boolean
  sha?: string
  /** 未提交时的原因：disabled / unavailable / outside / no-files / nothing-to-commit / ignored-by-gitignore */
  reason?: string
  error?: string
}

export function commitPaths(analysisDir: string, paths: string[], message: string): CommitResult {
  if (gitDisabled()) return { committed: false, reason: 'disabled' }
  if (!gitAvailable()) return { committed: false, reason: 'unavailable' }
  const rels: string[] = []
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(analysisDir, p)
    const rel = relative(analysisDir, abs)
    if (rel === '' || rel.startsWith('..')) continue
    try {
      const st = lstatSync(abs)
      if (st.isSymbolicLink() || st.isDirectory()) continue // 链接（fit.py/plot.py）与目录不入库
    } catch {
      continue // 不存在
    }
    rels.push(rel)
  }
  if (rels.length === 0) return { committed: false, reason: 'no-files' }
  const repo = ensureRepo(analysisDir)
  if (!repo.ok) return { committed: false, reason: 'unavailable', error: repo.error }
  writeGitignore(analysisDir)
  // .gitignore 本身也入库：它是记录的一部分（决定哪些文本进历史）。
  if (!rels.includes('.gitignore')) rels.push('.gitignore')

  const add = run(analysisDir, ['add', '--', ...rels])
  if (!add.ok && /ignored by one of your \.gitignore/i.test(add.stderr)) {
    // A path matched an ignore rule: add each individually and keep what works.
    for (const rel of rels) run(analysisDir, ['add', '--', rel])
  } else if (!add.ok) {
    return { committed: false, reason: 'ignored-by-gitignore', error: add.error }
  }
  const staged = run(analysisDir, ['diff', '--cached', '--quiet', '--exit-code'])
  if (staged.ok) return { committed: false, reason: 'nothing-to-commit' }
  const commit = run(analysisDir, ['commit', '--quiet', '-m', message])
  if (!commit.ok) return { committed: false, reason: 'commit-failed', error: commit.error }
  const head = run(analysisDir, ['rev-parse', '--short', 'HEAD'])
  return { committed: true, ...(head.ok ? { sha: head.stdout.trim() } : {}) }
}

/** 仓库状态：是否已初始化、HEAD、工作区是否脏（相对 .gitignore 后的跟踪面）。 */
export function repoStatus(
  analysisDir: string,
): { initialized: boolean; commit?: string; dirty: boolean; untracked?: number; error?: string } {
  if (!gitAvailable() || !existsSync(join(analysisDir, PWA_GIT_DIRNAME, 'HEAD'))) {
    return { initialized: false, dirty: false, untracked: 0 }
  }
  // dirty 只看已跟踪文件：那才是"记录的这份 config 已不是 HEAD 的内容"。
  const tracked = run(analysisDir, ['status', '--porcelain', '--untracked-files=no'])
  const all = run(analysisDir, ['status', '--porcelain'])
  const head = run(analysisDir, ['rev-parse', '--short', 'HEAD'])
  const untracked = all.ok ? all.stdout.split('\n').filter((l) => l.startsWith('?? ')).length : undefined
  return {
    initialized: true,
    ...(head.ok ? { commit: head.stdout.trim() } : {}),
    dirty: tracked.ok ? tracked.stdout.trim() !== '' : false,
    ...(untracked !== undefined ? { untracked } : {}),
    ...(tracked.ok ? {} : { error: tracked.error }),
  }
}

/** git 绑定（写进 provenance）。 */
export function gitProvenance(analysisDir: string): GitProvenance | undefined {
  if (gitDisabled() || !gitAvailable()) return undefined
  const st = repoStatus(analysisDir)
  if (!st.initialized) return undefined
  return {
    repo: `${analysisDir}/${PWA_GIT_DIRNAME}`,
    ...(st.commit !== undefined ? { commit: st.commit } : {}),
    dirty: st.dirty,
    ...(st.untracked !== undefined ? { untracked: st.untracked } : {}),
  }
}

/** 最近 N 条提交（新→旧）。 */
export function gitLog(analysisDir: string, limit = 20): GitCommitInfo[] {
  if (!gitAvailable()) return []
  const r = run(analysisDir, ['log', `-n${Math.max(1, Math.min(limit, 200))}`, '--date=short', '--format=%h%x09%ad%x09%s'])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [short, date, ...rest] = line.split('\t')
      return { sha: short ?? '', short: short ?? '', ...(date !== undefined ? { date } : {}), subject: rest.join('\t') }
    })
}

/** `git show` 的文本（默认带 stat，限长）。 */
export function gitShow(analysisDir: string, rev: string, path?: string, maxBytes = 32 * 1024): GitResult {
  const args = ['show', '--stat', '--patch', '--no-color', rev]
  if (path !== undefined) args.push('--', path)
  return run(analysisDir, args, maxBytes)
}

/** pickaxe：哪次提交引入/删除了包含 needle 的行（默认看 config.yml）。 */
export function gitSearch(analysisDir: string, needle: string, path?: string, limit = 20): GitResult {
  const args = ['log', `-n${Math.max(1, Math.min(limit, 200))}`, '--oneline', `-S${needle}`]
  if (path !== undefined) args.push('--', path)
  return run(analysisDir, args)
}

/** 打标签（里程碑；同名标签已存在时返回失败，调用方降级即可）。 */
export function gitTag(analysisDir: string, name: string, message: string): GitResult {
  if (!gitAvailable()) return { ok: false, stdout: '', stderr: '', error: 'git unavailable' }
  return run(analysisDir, ['tag', '-a', name, '-m', message])
}

/**
 * `HEAD:<relPath>` 内容的 md5，或 undefined（不在 HEAD / git 不可用）。
 *
 * 用来做 md5 ↔ commit 互验：provenance 里记的 configMd5 必须能从
 * `git show <commit>:<relPath>` 复原。**拟合用的配置不在 HEAD 里**（手写的新
 * 变体从未提交）是最隐蔽的"假可复现"——dirty 标记抓不到它，这个检查能。
 */
export function blobMd5(analysisDir: string, relPath: string, rev = 'HEAD'): string | undefined {
  if (!gitAvailable()) return undefined
  try {
    const r = spawnSync(
      'git',
      ['--git-dir', join(analysisDir, PWA_GIT_DIRNAME), '--work-tree', analysisDir, 'cat-file', 'blob', `${rev}:${relPath}`],
      { cwd: analysisDir, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 },
    )
    if (r.status !== 0 || r.stdout === null) return undefined
    return createHash('md5').update(r.stdout).digest('hex')
  } catch {
    return undefined
  }
}

/** 相对路径（分析目录内），用于 git 路径参数；目录外返回 undefined。 */
export function relInside(analysisDir: string, p: string): string | undefined {
  const rel = relative(analysisDir, isAbsolute(p) ? p : resolve(analysisDir, p))
  return rel === '' || rel.startsWith('..') ? undefined : rel
}
