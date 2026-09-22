#!/usr/bin/env node
/**
 * auto-pwa — 双态启动器（delegating launcher，模式借自 dsh-tui 的 bin/dsh-tui.js）。
 *
 * 同一个文件按"自己住在哪"决定角色：
 *
 *   全局副本（npm i -g 得到的 `auto-pwa` 命令）→ 瘦壳：
 *     1. 探测 dsh CLI 与 pnpm（dsh plugin 会把安装转发给 pnpm）；
 *     2. 找 $DSH_HOME/profiles/<profile>/node_modules/auto-pwa/bin/auto-pwa.js：
 *        可读 → 原样转发 argv 委托它执行（完整逻辑永远来自 profile 副本，
 *        版本随 --upgrade 前进，全局启动器滞后问题从结构上消失）；
 *        不可读（首次运行）→ 自举
 *        `dsh plugin --profile <profile> add auto-pwa@<本包版本>`，成功后委托；
 *     3. `--upgrade` 时先 `add auto-pwa@latest` 再委托。
 *
 *   profile 内副本（被委托执行）→ 完整启动逻辑：
 *     `dsh --profile <profile> [args...]`，退出码透传。
 *     profile 名从自身 realpath 解析（profiles/<name>/node_modules/auto-pwa），
 *     因此 link: 开发挂载与 --profile 自定义名都自然正确。
 *
 * 本文件必须保持零依赖（只用 node builtins）——全局安装时它是唯一入口。
 *
 * 环境变量：
 *   DSH_HOME         dsh 家目录（默认 ~/.dsh）
 *   DSH_PWA_PROFILE  目标 profile（默认 web；headless 用户设 headless）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'auto-pwa'
const DEFAULT_PROFILE = 'web'

const here = dirname(fileURLToPath(import.meta.url))
const ownDir = dirname(here) // 包根（bin/ 的上一级）

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

const ownVersion = readJson(join(ownDir, 'package.json'))?.version ?? 'latest'

// ---------- 参数解析 ----------
// 启动器自己的 flag 在这里吃掉；其余原样转发给 dsh。
const argv = process.argv.slice(2)
let profile = process.env.DSH_PWA_PROFILE || DEFAULT_PROFILE
let dryRun = false
let upgrade = false
const forwarded = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dry-run') dryRun = true
  else if (a === '--upgrade') upgrade = true
  else if (a === '--profile' || a === '-p') profile = argv[++i] ?? profile
  else if (a === '--version' || a === '-V') {
    console.log(ownVersion)
    process.exit(0)
  } else if (a === '--help' || a === '-h') {
    console.log(`auto-pwa — DeepSeek Harness 分波分析插件启动器

用法:
  auto-pwa [选项] [dsh 参数...]

选项:
  --profile, -p <name>  目标 profile（默认 ${DEFAULT_PROFILE}，或 $DSH_PWA_PROFILE）
  --upgrade             先把 profile 内的 auto-pwa 升级到 latest，再启动
  --dry-run             只打印将执行的命令，不执行
  --version, -V         打印启动器版本
  --help, -h            本帮助

示例:
  auto-pwa                              装进 web profile（首次）并启动 Web GUI
  auto-pwa -- --resume <session>        恢复会话（-- 后的参数原样转发给 dsh）
  auto-pwa -p headless "完成此文件夹分波"  headless profile 一次性任务

首次运行等价于手动执行:
  dsh plugin --profile <profile> add auto-pwa
之后每次启动等价于:
  dsh --profile <profile> [args...]
`)
    process.exit(0)
  } else if (a === '--') {
    forwarded.push(...argv.slice(i + 1))
    break
  } else forwarded.push(a)
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')

// ---------- 角色判定 ----------
// realpath 折叠 junction/link：link: 开发挂载会指回源码目录，按 launcher 处理
// 之外的唯一情况——真实住在 profiles/<name>/node_modules/auto-pwa 里——才是
// profile 副本。profile 名从路径解析，自定义 --profile 名也正确。
let realOwn = ownDir
try {
  realOwn = realpathSync(ownDir)
} catch {
  /* keep ownDir */
}
const roleMatch = /[/\\]profiles[/\\]([^/\\]+)[/\\]node_modules[/\\]auto-pwa$/.exec(realOwn)
const runningInsideProfile = roleMatch !== null
if (runningInsideProfile) profile = roleMatch[1]

// ---------- 进程工具 ----------
const shellOpt = process.platform === 'win32' ? { shell: true } : {}

const which = (cmd) => {
  const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', encoding: 'utf8', ...shellOpt })
  return r.error === undefined && r.status === 0
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...shellOpt })
  if (r.error) {
    console.error(`[auto-pwa] 启动失败: ${r.error.message}`)
    process.exit(1)
  }
  process.exit(r.status ?? 0)
}

const plan = (steps) => {
  for (const s of steps) console.log(`  $ ${s}`)
}

// ---------- profile 副本：直接 boot ----------
if (runningInsideProfile) {
  const boot = ['dsh', ['--profile', profile, ...forwarded]]
  if (dryRun) {
    console.log('[auto-pwa] dry-run（profile 副本，直接启动）:')
    plan([boot.flat().join(' ')])
    process.exit(0)
  }
  run(boot[0], boot[1])
}

// ---------- 全局副本：委托或自举 ----------
const profileCopy = join(profilesDir, profile, 'node_modules', PACKAGE, 'bin', 'auto-pwa.js')
const needInstall = upgrade || !existsSync(profileCopy)
const installSpec = upgrade ? `${PACKAGE}@latest` : `${PACKAGE}@${ownVersion}`

const steps = []
if (needInstall) steps.push(['dsh', ['plugin', '--profile', profile, 'add', installSpec]])
steps.push([process.execPath, [profileCopy, ...forwarded]]) // 委托 profile 副本

if (dryRun) {
  console.log(`[auto-pwa] dry-run（全局启动器 → profile "${profile}"）:`)
  console.log(`  dsh: ${which('dsh') ? 'found' : 'NOT FOUND'}  pnpm: ${which('pnpm') ? 'found' : 'NOT FOUND'}`)
  console.log(`  profile 副本: ${existsSync(profileCopy) ? profileCopy : '(尚不存在，需先安装)'}`)
  plan(steps.map(([c, a]) => [c, ...a].join(' ')))
  process.exit(0)
}

if (!which('dsh')) {
  console.error('[auto-pwa] 未检测到 dsh CLI。请先安装官方客户端：\n  npm install -g @deepseek-ai/dsh')
  process.exit(1)
}
if (needInstall && !which('pnpm')) {
  console.error('[auto-pwa] 首次安装需要 pnpm（dsh plugin 会把安装转发给它）：\n  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）')
  process.exit(1)
}

if (needInstall) {
  console.log(`[auto-pwa] ${upgrade ? '升级' : '首次运行，正在初始化'} ${profile} profile（${installSpec}）…`)
  const r = spawnSync('dsh', ['plugin', '--profile', profile, 'add', installSpec], { stdio: 'inherit', ...shellOpt })
  if (r.error || r.status !== 0) {
    console.error(`[auto-pwa] 插件安装失败。可稍后手工重试：\n  dsh plugin --profile ${profile} add ${installSpec}`)
    process.exit(r.status ?? 1)
  }
  if (!existsSync(profileCopy)) {
    console.error(`[auto-pwa] 安装报告成功但 profile 内仍读不到插件包：\n  ${profileCopy}`)
    process.exit(1)
  }
}

// 委托 profile 副本（完整逻辑永远来自它）
run(process.execPath, [profileCopy, ...forwarded])
