import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SbatchFitRunner, readSlurmJobRegistry, findIterationsRoot, type SbatchFitRunnerConfig } from '../src/fit-runner-sbatch.js'

const ORIGINAL_PATH = process.env.PATH
let bin: string
let ctrl: string
let iterations: string

/** Fake slurm CLIs, controllable through FAKE_SS_DIR. */
function writeFakeCli(name: string, body: string): void {
  writeFileSync(join(bin, name), body, { mode: 0o755 })
}

function setupFakeSlurm(): void {
  bin = mkdtempSync(join(tmpdir(), 'dsh-pwa-bin-'))
  ctrl = mkdtempSync(join(tmpdir(), 'dsh-pwa-ctrl-'))
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`
  process.env.FAKE_SS_DIR = ctrl
  // sbatch: increment counter, echo the real job id (100+counter).
  writeFakeCli('sbatch', `#!/bin/sh
c="\${FAKE_SS_DIR}/count"
n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$c"
echo "Submitted batch job $((100+n))"
`)
  // squeue: prints RUNNING until a terminal marker exists; prints nothing after.
  writeFakeCli('squeue', `#!/bin/sh
if [ -f "\${FAKE_SS_DIR}/terminal" ]; then exit 0; fi
echo RUNNING
`)
  // sacct: prints the terminal state recorded in $FAKE_SS_DIR/state (default COMPLETED).
  writeFakeCli('sacct', `#!/bin/sh
st=$(cat "\${FAKE_SS_DIR}/state" 2>/dev/null || echo COMPLETED)
echo "$st|0:0"
`)
  writeFakeCli('scancel', '#!/bin/sh\nexit 0\n')
}

function makeIterDir(name: string): string {
  const d = join(iterations, 'iterations', name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'config.yml'), 'name: test\n')
  return d
}

function runnerCfg(): SbatchFitRunnerConfig {
  return {
    python: 'python',
    ldLibraryPath: '',
    template: 'a100',
    cluster: { transport: 'slurm', template: 'a100' },
    fitScript: 'fit.py',
    pollIntervalMs: 8,
    cliTimeoutMs: 2000,
  }
}

beforeEach(() => {
  setupFakeSlurm()
  iterations = mkdtempSync(join(tmpdir(), 'dsh-pwa-iter-'))
  mkdirSync(join(iterations, 'iterations'), { recursive: true })
})

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  delete process.env.FAKE_SS_DIR
  rmSync(bin, { recursive: true, force: true })
  rmSync(ctrl, { recursive: true, force: true })
  rmSync(iterations, { recursive: true, force: true })
})

const countSbatch = (): number => {
  const p = join(ctrl, 'count')
  return existsSync(p) ? Number(readFileSync(p, 'utf8')) : 0
}

describe('SbatchFitRunner', () => {
  it('submits a single fit, writes fit.slurm, and settles done when the job leaves the queue', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-000')
    const status = r.submit(dir, { scriptArgs: ['--runs', '1', '--max-iter', '500'] })
    expect(status.state).toBe('running')
    expect(countSbatch()).toBe(1)
    // The generated slurm script is in the iter dir.
    const script = readFileSync(join(dir, 'fit.slurm'), 'utf8')
    expect(script).toContain('#SBATCH --partition=gpupwa')
    expect(script).toContain(`cd "${dir}"`)
    expect(script).toContain('python fit.py --runs 1 --max-iter 500')
    // The fit is still running (no terminal marker yet) — status, not settled.
    expect(r.status(status.jobId)?.state).toBe('running')
    // Let the job complete.
    writeFileSync(join(ctrl, 'terminal'), '')
    writeFileSync(join(ctrl, 'state'), 'COMPLETED')
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('done')
    expect(done.exitCode).toBe(0)
    // Registry persisted the record for AI state inspection.
    expect(findIterationsRoot(dir)).toBe(join(iterations, 'iterations'))
    const reg = readSlurmJobRegistry(dir)
    expect(reg[status.jobId]?.batch).toBeFalsy()
    expect(reg[status.jobId]?.state).toBe('done')
  })

  it('reports failed with the sacct exit code', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-001')
    const status = r.submit(dir)
    writeFileSync(join(ctrl, 'terminal'), '')
    writeFileSync(join(ctrl, 'state'), 'FAILED')
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('failed')
  })

  it('cancels a running job via scancel', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-002')
    const status = r.submit(dir)
    expect(r.cancel(status.jobId)).toBe(true)
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('canceled')
  })

  it('batch mode=script launches ONE cluster job running all fits sequentially', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const a = makeIterDir('t-1')
    const b = makeIterDir('t-2')
    const status = r.submitBatch([a, b], { mode: 'script', scriptArgs: ['--runs', '1'] })
    expect(status.state).toBe('running')
    expect(countSbatch()).toBe(1)
    // The merged script cd's into each dir.
    const merged = readFileSync(join(a, 'fit.slurm'), 'utf8')
    expect(merged).toContain(`cd "${a}"`)
    expect(merged).toContain(`cd "${b}"`)
    writeFileSync(join(ctrl, 'terminal'), '')
    writeFileSync(join(ctrl, 'state'), 'COMPLETED')
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('done')
    const reg = readSlurmJobRegistry(a)
    expect(reg[status.jobId]?.batch).toBe(true)
  })

  it('batch mode=one launches N cluster jobs and wakes once when all settle', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const a = makeIterDir('t-3')
    const b = makeIterDir('t-4')
    const c = makeIterDir('t-5')
    const status = r.submitBatch([a, b, c], { mode: 'one', scriptArgs: ['--runs', '1'] })
    expect(status.state).toBe('running')
    expect(countSbatch()).toBe(3)
    writeFileSync(join(ctrl, 'terminal'), '')
    writeFileSync(join(ctrl, 'state'), 'COMPLETED')
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('done')
  })

  it('fails fast when sbatch is absent', () => {
    // Point PATH at a dir with no slurm clients.
    const empty = mkdtempSync(join(tmpdir(), 'dsh-pwa-no-bin-'))
    process.env.PATH = empty
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-003')
    expect(() => r.submit(dir)).toThrow(/sbatch/)
    rmSync(empty, { recursive: true, force: true })
  })
})
