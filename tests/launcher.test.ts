import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
