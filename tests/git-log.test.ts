import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analysisRootOf,
  commitPaths,
  ensureRepo,
  gitDisabled,
  gitLog,
  gitProvenance,
  gitSearch,
  gitShow,
  engineFingerprint,
  engineFromPython,
  engineFromRepo,
  findRepoRoot,
  PWA_GIT_DIRNAME,
  repoCoexistence,
  repoStatus,
  resetGitProbe,
  writeGitignore,
} from '../src/git-log.js'

/** Run git in a plain (ambient) repo without the plugin's git-dir flags. */
const ambient = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

let root: string
let analysis: string

beforeEach(() => {
  resetGitProbe()
  delete process.env.PWA_GIT
  root = mkdtempSync(join(tmpdir(), 'dsh-pwa-git-'))
  analysis = join(root, 'analysis')
  mkdirSync(join(analysis, 'iterations', 'iter-000'), { recursive: true })
  writeFileSync(join(analysis, 'config.yml'), 'Particles: {}\n')
  writeFileSync(join(analysis, 'iterations', 'iter-000', 'config.yml'), 'Particles: {}\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PWA_GIT
})

describe('git-log (local record, never pushes)', () => {
  it('initialises an independent git dir and leaves the enclosing repo untouched', () => {
    // Ambient repo around the analysis dir, with its own commit.
    ambient(root, 'init', '--quiet')
    ambient(root, 'config', 'user.email', 'outer@localhost')
    ambient(root, 'config', 'user.name', 'outer')
    writeFileSync(join(root, 'outer.txt'), 'x\n')
    ambient(root, 'add', 'outer.txt')
    ambient(root, 'commit', '--quiet', '-m', 'outer commit')
    const outerBefore = ambient(root, 'rev-parse', 'HEAD')

    expect(ensureRepo(analysis).ok).toBe(true)
    expect(existsSync(join(analysis, PWA_GIT_DIRNAME, 'HEAD'))).toBe(true)

    const res = commitPaths(analysis, ['config.yml', 'iterations/iter-000/config.yml'], 'iter-000 init')
    expect(res.committed).toBe(true)
    expect(res.sha).toMatch(/^[0-9a-f]{7,}$/)

    // The outer repo has the same HEAD and only sees the nested dir as untracked.
    expect(ambient(root, 'rev-parse', 'HEAD')).toBe(outerBefore)
    const outerStatus = ambient(root, 'status', '--porcelain')
    expect(outerStatus).not.toMatch(/config\.yml/)
    expect(outerStatus).toMatch(/\?\? analysis\//)
  })

  it('records, lists and shows history for the analysis dir', () => {
    expect(commitPaths(analysis, ['config.yml'], 'iter-001 add phi1680 -> R_KK [1-]').committed).toBe(true)
    writeFileSync(join(analysis, 'config.yml'), 'Particles: {}\nResonances: {phi1680: {}}\n')
    expect(commitPaths(analysis, ['config.yml'], 'iter-002 result NLL=-18685.8').committed).toBe(true)

    const log = gitLog(analysis, 10)
    expect(log).toHaveLength(2)
    expect(log[0]!.subject).toContain('iter-002 result')
    expect(log[1]!.subject).toContain('iter-001 add')

    const patch = gitShow(analysis, log[0]!.sha, 'config.yml')
    expect(patch.ok).toBe(true)
    expect(patch.stdout).toContain('phi1680')

    const search = gitSearch(analysis, 'phi1680', 'config.yml')
    expect(search.ok).toBe(true)
    expect(search.stdout).toContain(log[0]!.sha)
  })

  it('reports nothing-to-commit for an unchanged tree and dirty status after an edit', () => {
    commitPaths(analysis, ['config.yml'], 'first')
    expect(commitPaths(analysis, ['config.yml'], 'again')).toEqual({ committed: false, reason: 'nothing-to-commit' })
    expect(repoStatus(analysis).dirty).toBe(false)
    writeFileSync(join(analysis, 'config.yml'), 'Particles: {changed: 1}\n')
    expect(repoStatus(analysis).dirty).toBe(true)
    expect(gitProvenance(analysis)).toMatchObject({ dirty: true })
  })

  it('keeps small Interp input tables but ignores bulk data (managed .gitignore)', () => {
    writeGitignore(analysis)
    const ignore = readFileSync(join(analysis, '.gitignore'), 'utf8')
    expect(ignore).toContain('* .dat'.replace(' ', ''))
    expect(ignore).toContain('!interp_*.dat')
    // Idempotent: a second call leaves the file byte-identical.
    const before = readFileSync(join(analysis, '.gitignore'), 'utf8')
    expect(writeGitignore(analysis).changed).toBe(false)
    expect(readFileSync(join(analysis, '.gitignore'), 'utf8')).toBe(before)
    // Existing user rules survive the managed block.
    writeFileSync(join(analysis, '.gitignore'), 'my-local-rule\n')
    expect(writeGitignore(analysis).changed).toBe(true)
    expect(readFileSync(join(analysis, '.gitignore'), 'utf8')).toMatch(/^my-local-rule\n/)

    writeFileSync(join(analysis, 'data.dat'), 'bulk\n')
    writeFileSync(join(analysis, 'interp_Keta_broad.dat'), '1 2 3\n')
    const res = commitPaths(analysis, ['config.yml', 'data.dat', 'interp_Keta_broad.dat'], 'inputs')
    expect(res.committed).toBe(true)
    const tracked = execFileSync(
      'git',
      ['--git-dir', join(analysis, PWA_GIT_DIRNAME), '--work-tree', analysis, 'ls-files'],
      { encoding: 'utf8' },
    )
    expect(tracked).toContain('interp_Keta_broad.dat')
    expect(tracked).not.toContain('data.dat')
  })

  it('skips symlinked driver scripts (fit.py) and paths outside the analysis dir', () => {
    symlinkSync('/usr/bin/true', join(analysis, 'iterations', 'iter-000', 'fit.py'))
    writeFileSync(join(root, 'outside.yml'), 'x\n')
    const res = commitPaths(analysis, ['iterations/iter-000/fit.py', '../outside.yml', 'iterations/iter-000/config.yml'], 'iter')
    expect(res.committed).toBe(true)
    const tracked = execFileSync(
      'git',
      ['--git-dir', join(analysis, PWA_GIT_DIRNAME), '--work-tree', analysis, 'ls-files'],
      { encoding: 'utf8' },
    )
    expect(tracked).not.toContain('fit.py')
    expect(tracked).not.toContain('outside.yml')
    expect(tracked).toContain('iterations/iter-000/config.yml')
  })

  it('finds the analysis root by walking up to iterations/ or .pwa-git', () => {
    expect(analysisRootOf(join(analysis, 'iterations', 'iter-000', 'config.yml'))).toBe(analysis)
    expect(analysisRootOf(join(analysis, 'iterations'))).toBe(analysis)
    // A directory with no marker falls back to its own directory.
    const lone = join(root, 'lone')
    mkdirSync(lone, { recursive: true })
    expect(analysisRootOf(join(lone, 'config.yml'))).toBe(lone)
  })

  it('honours PWA_GIT_ROOT so several run dirs share one history', () => {
    // Two sibling run dirs (the ~/Works/<analysis>/run_* layout): without the
    // override each would get its own repo; with it they share one history.
    const runA = join(root, 'run_A')
    const runB = join(root, 'run_B')
    mkdirSync(runA, { recursive: true })
    mkdirSync(runB, { recursive: true })
    writeFileSync(join(runA, 'config.yml'), 'a\n')
    writeFileSync(join(runB, 'config.yml'), 'b\n')

    process.env.PWA_GIT_ROOT = root
    try {
      expect(analysisRootOf(join(runA, 'config.yml'))).toBe(root)
      expect(commitPaths(root, [join(runA, 'config.yml')], 'run_A config').committed).toBe(true)
      expect(commitPaths(root, [join(runB, 'config.yml')], 'run_B config').committed).toBe(true)
      expect(existsSync(join(root, PWA_GIT_DIRNAME, 'HEAD'))).toBe(true)
      expect(gitLog(root, 5).map((e) => e.subject)).toEqual(['run_B config', 'run_A config'])
    } finally {
      delete process.env.PWA_GIT_ROOT
    }
    // Without the override the walk lands on the nearest analysis dir again.
    expect(analysisRootOf(join(analysis, 'iterations', 'iter-000', 'config.yml'))).toBe(analysis)
  })

  it('is a silent no-op when PWA_GIT=off', () => {
    process.env.PWA_GIT = 'off'
    expect(gitDisabled()).toBe(true)
    expect(commitPaths(analysis, ['config.yml'], 'x')).toEqual({ committed: false, reason: 'disabled' })
    expect(existsSync(join(analysis, PWA_GIT_DIRNAME))).toBe(false)
    expect(gitProvenance(analysis)).toBeUndefined()
    expect(gitLog(analysis, 5)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// S0：与已有 git 共存（只读探测；不改动外层仓库）
// ---------------------------------------------------------------------------
describe('git coexistence probe (S0)', () => {
  it('reports an enclosing repo and leaves it untouched', () => {
    ambient(root, 'init', '--quiet')
    ambient(root, 'config', 'user.email', 'outer@localhost')
    ambient(root, 'config', 'user.name', 'outer')
    writeFileSync(join(root, 'outer.txt'), 'x\n')
    ambient(root, 'add', 'outer.txt')
    ambient(root, 'commit', '--quiet', '-m', 'outer commit')
    const before = ambient(root, 'rev-parse', 'HEAD')

    const coex = repoCoexistence(analysis)
    expect(coex.enclosingRepo).toBeDefined()
    expect(coex.isRepoRoot).toBe(false)
    expect(coex.trackedPwaGit).toBe(0)
    const codes = coex.issues.map((i) => i.code)
    expect(codes).toContain('analysis-inside-other-repo')
    // 给的是"一行解决"的建议（写外层 .gitignore），不是要求重建目录
    expect(coex.issues.find((i) => i.code === 'analysis-inside-other-repo')!.message).toContain('.gitignore')
    // 探测是只读的
    expect(ambient(root, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('reports the analysis dir being its own repo root', () => {
    ambient(analysis, 'init', '--quiet')
    const coex = repoCoexistence(analysis)
    expect(coex.isRepoRoot).toBe(true)
    expect(coex.issues.map((i) => i.code)).toContain('analysis-is-repo-root')
  })

  it('flags a .pwa-git already tracked by the enclosing repo, with a fix command', () => {
    // 复刻 region_big 的真实路径：外层在托管 .gitignore 生效**之前**就把
    // .pwa-git 内部文件提交了进去 —— ignore 对已跟踪文件无效，会持续变脏。
    ambient(root, 'init', '--quiet')
    ambient(root, 'config', 'user.email', 'outer@localhost')
    ambient(root, 'config', 'user.name', 'outer')
    expect(ensureRepo(analysis).ok).toBe(true)
    ambient(root, 'add', `analysis/${PWA_GIT_DIRNAME}/HEAD`)
    ambient(root, 'commit', '--quiet', '-m', 'outer: accidentally committed nested git')

    const coex = repoCoexistence(analysis)
    expect(coex.trackedPwaGit).toBeGreaterThan(0)
    const issue = coex.issues.find((i) => i.code === 'pwa-git-tracked-by-enclosing')
    expect(issue).toBeDefined()
    expect(issue!.message).toContain(`rm -r --cached ${PWA_GIT_DIRNAME}`)
  })

  it('warns once (not on every commit) when the enclosing repo tracks our .gitignore', () => {
    ambient(root, 'init', '--quiet')
    ambient(root, 'config', 'user.email', 'outer@localhost')
    ambient(root, 'config', 'user.name', 'outer')
    writeFileSync(join(analysis, '.gitignore'), '# user rules\n')
    ambient(root, 'add', 'analysis/.gitignore')
    ambient(root, 'commit', '--quiet', '-m', 'outer: track analysis .gitignore')

    const first = commitPaths(analysis, ['config.yml'], 'first')
    expect(first.committed).toBe(true)
    expect((first.warnings ?? []).map((w) => w.code)).toContain('gitignore-tracked-by-enclosing')

    // 同一问题不重复报（避免每次工具返回都刷同一句话）
    writeFileSync(join(analysis, 'config.yml'), 'Particles: {a: 1}\n')
    const second = commitPaths(analysis, ['config.yml'], 'second')
    expect(second.committed).toBe(true)
    expect(second.warnings ?? []).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// S1：结构化提交标注（trailer）
// ---------------------------------------------------------------------------
describe('commit trailers (S1)', () => {
  it('round-trips structured trailers, always carries Pwa-Engine, drops malformed keys', () => {
    process.env.PWA_ENGINE = 'test@deadbee' // 固定引擎：不依赖本机 ctpwa 是否可探测
    resetGitProbe()
    try {
      expect(commitPaths(analysis, ['config.yml'], 'iter-000 plain').committed).toBe(true)
      writeFileSync(join(analysis, 'config.yml'), 'Particles: {a: 1}\n')
      expect(
        commitPaths(analysis, ['config.yml'], 'iter-007 result', {
          'Pwa-Kind': 'result',
          'Pwa-Iter': 7,
          'Pwa-NLL': (-18685.8).toFixed(2),
          'Pwa-Hessian-PD': true,
          'pwa-lowercase': 'dropped', // 前缀不合规
          'Pwa-Bad Key': 'dropped', // 键名非法（含空格）
          'Pwa-Multi': 'a\nb', // 多行值压成一行
        }).committed,
      ).toBe(true)

      const [head, plain] = gitLog(analysis, 5)
      expect(head!.subject).toBe('iter-007 result')
      expect(head!.trailers).toMatchObject({
        'Pwa-Kind': 'result',
        'Pwa-Iter': '7',
        'Pwa-NLL': '-18685.80',
        'Pwa-Hessian-PD': 'true',
        'Pwa-Engine': 'test@deadbee',
      })
      expect(head!.trailers!['Pwa-Multi']).toBe('a b')
      expect(head!.trailers!['pwa-lowercase']).toBeUndefined()
      expect(Object.keys(head!.trailers!).some((k) => k.includes(' '))).toBe(false)
      // 没有任何决策字段的提交也带引擎兜底（来源单一：commitPaths 内部）
      expect(plain!.subject).toBe('iter-000 plain')
      expect(plain!.trailers).toEqual({ 'Pwa-Engine': 'test@deadbee' })
      // 调用方显式给引擎 → 覆盖默认值
      writeFileSync(join(analysis, 'config.yml'), 'Particles: {b: 2}\n')
      commitPaths(analysis, ['config.yml'], 'iter-008', { 'Pwa-Engine': 'override@0000000' })
      expect(gitLog(analysis, 1)[0]!.trailers!['Pwa-Engine']).toBe('override@0000000')
    } finally {
      delete process.env.PWA_ENGINE
      resetGitProbe()
    }
  })
})

// ---------------------------------------------------------------------------
// 引擎指纹（Pwa-Engine 的数据源）
// ---------------------------------------------------------------------------
describe('engineFingerprint（自动探测，宁缺毋滥）', () => {
  const git = (dir: string, ...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  }
  const initRepo = (dir: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    git(dir, 'init', '--quiet')
    git(dir, 'config', 'user.email', 'e@localhost')
    git(dir, 'config', 'user.name', 'e')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '--quiet', '-m', 'init')
  }

  it('从仓库给出 <name>@<sha>，工作区脏时加 +dirty', () => {
    const repo = join(root, 'ctpwa')
    initRepo(repo)
    expect(engineFromRepo(repo)).toMatch(/^ctpwa@[0-9a-f]{7,8}$/)
    writeFileSync(join(repo, 'a.txt'), 'changed\n') // 已跟踪文件被改 → 引擎不再是那个 commit
    expect(engineFromRepo(repo)).toMatch(/^ctpwa@[0-9a-f]{7,8}\+dirty$/)
  })

  it('优先级：PWA_ENGINE > PWA_CTPWA_REPO > 自动探测；探测失败就不编造', () => {
    const repo = join(root, 'ctpwa')
    initRepo(repo)
    process.env.PWA_CTPWA_REPO = repo
    resetGitProbe()
    expect(engineFingerprint()).toMatch(/^ctpwa@[0-9a-f]{7,8}$/)
    process.env.PWA_ENGINE = 'explicit@deadbee'
    resetGitProbe()
    expect(engineFingerprint()).toBe('explicit@deadbee')
    delete process.env.PWA_ENGINE
    delete process.env.PWA_CTPWA_REPO
    resetGitProbe()
    // 探测失败 = undefined（宁缺毋滥：编一个版本号比没有更糟）
    expect(engineFromPython('/bin/false')).toBeUndefined()
    expect(engineFromPython(join(root, 'no-such-python'))).toBeUndefined()
  })

  it('findRepoRoot 向上找 .git（最多 6 层）', () => {
    const repo = join(root, 'eng')
    const deep = join(repo, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    git(repo, 'init', '--quiet')
    expect(findRepoRoot(deep)).toBe(repo)
    expect(findRepoRoot(join(root, 'elsewhere'))).toBeUndefined()
  })
})
