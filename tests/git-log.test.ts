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
  PWA_GIT_DIRNAME,
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
