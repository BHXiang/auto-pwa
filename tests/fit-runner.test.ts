import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { LocalFitRunner, detectGpuAvailability } from '../src/fit-runner.js'

/**
 * The runner spawns `cfg.python fit.py` with cwd=iterDir and LD_LIBRARY_PATH
 * injected. We stub `python` with the system node so tests exercise the real
 * spawn/log/exit/status/cancel machinery without ctpwa or a GPU.
 */
function makeIterDir(script = `console.log('fit ran'); process.exit(0)`): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-fit-'))
  writeFileSync(join(dir, 'fit.py'), script)
  return dir
}

function runner() {
  return new LocalFitRunner({ python: process.execPath, ldLibraryPath: '/lib:/usr/lib', gpuProbe: false })
}

describe('LocalFitRunner', () => {
  it('runs the fit script in the iteration dir and reports done with log', async () => {
    const runner_ = runner()
    const dir = makeIterDir(`console.log('DATA_EVENT 42'); require('node:fs').mkdirSync('results',{recursive:true}); require('node:fs').writeFileSync('results/ok.txt','1'); process.exit(0)`)
    const status = runner_.submit(dir, { timeoutMs: 30_000 })
    expect(status.state).toBe('running')
    const done = await runner_.await(status.jobId, 50)
    expect(done.state).toBe('done')
    expect(done.exitCode).toBe(0)
    expect(readFileSync(join(dir, 'results/ok.txt'), 'utf8')).toBe('1')
    expect(done.logTail).toContain('DATA_EVENT 42')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports failed with exit code and stderr in the log', async () => {
    const runner_ = runner()
    const dir = makeIterDir(`console.error('BOOM'); process.exit(3)`)
    const status = runner_.submit(dir)
    const done = await runner_.await(status.jobId, 50)
    expect(done.state).toBe('failed')
    expect(done.exitCode).toBe(3)
    expect(done.logTail).toContain('BOOM')
    rmSync(dir, { recursive: true, force: true })
  })

  it('device=cpu skips the CUDA probe and exports CTPWA_DEVICE=cpu', async () => {
    // No gpuProbe:false here — the probe would fail (node is not torch), so a
    // passing run proves device=cpu bypasses it.
    const runner_ = new LocalFitRunner({ python: process.execPath, ldLibraryPath: '' })
    const dir = makeIterDir(`console.log('DEV=' + process.env.CTPWA_DEVICE + '/' + process.env.PWA_FIT_DEVICE); process.exit(0)`)
    const status = runner_.submit(dir, { device: 'cpu' })
    const done = await runner_.await(status.jobId, 50)
    expect(done.state).toBe('done')
    expect(done.logTail).toContain('DEV=cpu/cpu')
    rmSync(dir, { recursive: true, force: true })
  })

  it('device=gpu forces CTPWA_DEVICE=cuda on the child', async () => {
    const runner_ = new LocalFitRunner({ python: process.execPath, ldLibraryPath: '', gpuProbe: false })
    const dir = makeIterDir(`console.log('DEV=' + process.env.CTPWA_DEVICE + '/' + process.env.PWA_FIT_DEVICE); process.exit(0)`)
    const done = await runner_.await(runner_.submit(dir, { device: 'gpu' }).jobId, 50)
    expect(done.logTail).toContain('DEV=cuda/cuda')
    rmSync(dir, { recursive: true, force: true })
  })

  it('command runs an arbitrary AI-authored script in the iter dir (runScript)', async () => {
    const runner_ = new LocalFitRunner({ python: process.execPath, ldLibraryPath: '/lib:/usr/lib' })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-script-'))
    const script = join(dir, 'run.sh')
    writeFileSync(script, `#!/bin/sh\necho "RUNSH cwd=$(pwd) args=$*"\nexit 0\n`, { mode: 0o755 })
    const done = await runner_.await(
      runner_.submit(dir, { command: { file: '/bin/sh', args: [script, '--runs', '1'] } }).jobId,
      50,
    )
    expect(done.state).toBe('done')
    expect(done.logTail).toContain('RUNSH')
    expect(done.logTail).toContain('args=--runs 1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('command: missing runScript fails fast', () => {
    const runner_ = new LocalFitRunner({ python: process.execPath, ldLibraryPath: '' })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-noscript-'))
    expect(() => runner_.submit(dir, { command: { file: join(dir, 'nope.sh'), args: [] } })).toThrow(/runScript not found/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws when the fit script is missing', () => {
    const runner_ = runner()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-empty-'))
    expect(() => runner_.submit(dir)).toThrow(/fit script not found/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('cancels a running job (long-running script)', async () => {
    const runner_ = runner()
    const dir = makeIterDir(`setInterval(() => {}, 1000)`)
    const status = runner_.submit(dir)
    expect(runner_.cancel(status.jobId)).toBe(true)
    const done = await runner_.await(status.jobId, 50)
    expect(done.state).toBe('canceled')
    expect(runner_.cancel(status.jobId)).toBe(false) // already finished
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies the timeout', async () => {
    const runner_ = runner()
    const dir = makeIterDir(`setInterval(() => {}, 1000)`)
    const status = runner_.submit(dir, { timeoutMs: 200 })
    const done = await runner_.await(status.jobId, 50)
    expect(done.state).toBe('canceled')
    expect(done.error).toMatch(/timed out/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('detectGpuAvailability reports usable when torch sees a GPU', () => {
    // Fake python that prints True: simulate a GPU-capable host.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-gpu-'))
    const fake = join(dir, 'fake-python')
    writeFileSync(fake, `#!/bin/sh\necho True\n`, { mode: 0o755 })
    expect(detectGpuAvailability(fake, '')).toBeUndefined()
    // Fake python that prints False: unusable.
    const fakeNo = join(dir, 'fake-python-no')
    writeFileSync(fakeNo, `#!/bin/sh\necho False\n`, { mode: 0o755 })
    expect(detectGpuAvailability(fakeNo, '')).toMatch(/no CUDA device/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('aifit CLI surface', () => {
  // 驱动能力必须能被 scriptArgs 触发：--warm 是"按名字对齐续跑"，provenance 侧
  // （initFromScriptArgs）早就认识它，这里守住 CLI 真的暴露了这个开关。
  const AIFIT = join(process.cwd(), 'scripts/aifit.py')

  it('declares --warm in the argparse definition (hermetic)', () => {
    // 这条不依赖本机 python：aifit 是模块级 `import torch`，而 CI runner 上只有
    // python3、没有 torch —— 让 --help 在 CI 上跑会直接崩（v0.3.3 首次发布即因此失败）。
    const src = readFileSync(AIFIT, 'utf8')
    expect(src).toMatch(/add_argument\(\s*["']--warm["']/)
    expect(src).toContain('def warm_start_params')
  })

  // 端到端检查只在 python 环境真能 import torch/numpy 时跑。
  const pythonUsable = spawnSync('python3', ['-c', 'import torch, numpy']).status === 0
  it.skipIf(!pythonUsable)('advertises --warm in --help', () => {
    const r = spawnSync('python3', [AIFIT, '--help'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--warm')
    expect(r.stdout).toContain('按参数名对齐')
  })
})
