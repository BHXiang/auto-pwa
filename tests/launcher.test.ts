import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BIN = join(process.cwd(), 'bin/auto-pwa.js')
const VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string

let home: string

const runBin = (bin: string, args: string[], env: Record<string, string> = {}) => {
  const e = { ...process.env, ...env }
  if (!('DSH_PWA_PROFILE' in env)) delete e.DSH_PWA_PROFILE
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

const makeProfileCopy = (profile: string): string => {
  const dir = join(home, 'profiles', profile, 'node_modules', 'auto-pwa', 'bin')
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, 'auto-pwa.js')
  cpSync(BIN, copy)
  writeFileSync(join(dir, '..', 'package.json'), JSON.stringify({ name: 'auto-pwa', version: VERSION }))
  return copy
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'auto-pwa-launcher-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('auto-pwa launcher (bin/auto-pwa.js)', () => {
  it('--version 打印包版本', () => {
    const r = runBin(BIN, ['--version'], { DSH_HOME: home })
    expect(r.status).toBe(0)
    expect(r.out.trim()).toBe(VERSION)
  })

  it('首次运行（profile 副本不存在）：计划 plugin add 后委托', () => {
    const r = runBin(BIN, ['--dry-run'], { DSH_HOME: home })
    expect(r.status).toBe(0)
    expect(r.out).toContain(`dsh plugin --profile web add auto-pwa@${VERSION}`)
    expect(r.out).toContain(join('profiles', 'web', 'node_modules', 'auto-pwa', 'bin', 'auto-pwa.js'))
  })

  it('profile 副本已存在：跳过安装，直接委托', () => {
    makeProfileCopy('web')
    const r = runBin(BIN, ['--dry-run'], { DSH_HOME: home })
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('plugin --profile')
  })

  it('--upgrade 强制重装 latest', () => {
    makeProfileCopy('web')
    const r = runBin(BIN, ['--dry-run', '--upgrade'], { DSH_HOME: home })
    expect(r.out).toContain('dsh plugin --profile web add auto-pwa@latest')
  })

  it('-p headless 切换目标 profile', () => {
    const r = runBin(BIN, ['--dry-run', '-p', 'headless'], { DSH_HOME: home })
    expect(r.out).toContain('dsh plugin --profile headless add')
    expect(r.out).toContain(join('profiles', 'headless'))
  })

  it('DSH_PWA_PROFILE 环境变量生效', () => {
    const r = runBin(BIN, ['--dry-run'], { DSH_HOME: home, DSH_PWA_PROFILE: 'headless' })
    expect(r.out).toContain('--profile headless')
  })

  it('profile 内副本：不装不委托，直接 boot dsh --profile <name>（名字取自路径）', () => {
    const copy = makeProfileCopy('pwa')
    const r = runBin(copy, ['--dry-run'], { DSH_HOME: home })
    expect(r.status).toBe(0)
    expect(r.out).toContain('dsh --profile pwa')
    expect(r.out).not.toContain('plugin --profile')
  })

  it('转发参数到达 boot 命令', () => {
    const copy = makeProfileCopy('web')
    const r = runBin(copy, ['--dry-run', '--', '--resume', 'abc123'], { DSH_HOME: home })
    expect(r.out).toContain('dsh --profile web --resume abc123')
  })

  it('link: 挂载的 profile：-p <name> 不会被悄悄改成 web', () => {
    // 复刻 `dsh plugin --profile dsh-tui add link:<源码目录>`：profiles/<name>/... 是指向
    // 源码目录的软链，于是副本的 realpath 指回源码，**路径反推不出 profile 名**。
    // 此时父进程必须用 DSH_PWA_DELEGATED_PROFILE 把 profile 传下去，否则副本会退回默认
    // web（甚至自我委托）—— 目标 profile 就悄悄错了。
    const src = join(home, 'src')
    mkdirSync(join(src, 'bin'), { recursive: true })
    cpSync(BIN, join(src, 'bin', 'auto-pwa.js'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'auto-pwa', version: VERSION }))
    const nm = join(home, 'profiles', 'dsh-tui', 'node_modules')
    mkdirSync(nm, { recursive: true })
    symlinkSync(src, join(nm, 'auto-pwa'), 'dir')

    // 用一个假 dsh 记录它收到的参数（真实启动路径，端到端）。
    const shimDir = join(home, 'shim')
    mkdirSync(shimDir, { recursive: true })
    const rec = join(home, 'dsh-argv.txt')
    writeFileSync(join(shimDir, 'dsh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${rec}'\nexit 0\n`, { mode: 0o755 })

    const r = runBin(BIN, ['-p', 'dsh-tui', '完成此文件夹分波'], {
      DSH_HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    })
    expect(r.status).toBe(0)
    const argv = readFileSync(rec, 'utf8')
    expect(argv).toContain('--profile')
    expect(argv).toContain('dsh-tui')
    expect(argv).not.toContain('web')
    expect(argv).toContain('完成此文件夹分波')
  })
})
