import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SbatchFitRunner,
  findSlurmJobRecord,
  readSlurmJobRegistry,
  recoverSlurmJob,
  findIterationsRoot,
  type SbatchFitRunnerConfig,
} from '../src/fit-runner-sbatch.js'

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
  // sbatch: record argv (unit-separated), echo a real job id (100+counter).
  writeFakeCli('sbatch', `#!/bin/sh
c="\${FAKE_SS_DIR}/count"
n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$c"
printf '%s\\036' "$@" >> "\${FAKE_SS_DIR}/sbatch-calls"
printf '\\n' >> "\${FAKE_SS_DIR}/sbatch-calls"
echo "Submitted batch job $((100+n))"
`)
  // squeue: prints $FAKE_SS_DIR/queue when present (PENDING|Reason|0:12), else nothing.
  writeFakeCli('squeue', `#!/bin/sh
if [ -f "\${FAKE_SS_DIR}/queue" ]; then cat "\${FAKE_SS_DIR}/queue"; fi
exit 0
`)
  // sacct: $FAKE_SS_DIR/acct holds "STATE|EXIT"; emit a real JobID|State|ExitCode row.
  writeFakeCli('sacct', `#!/bin/sh
if [ -f "\${FAKE_SS_DIR}/acct" ]; then
  IFS='|' read -r st ex < "\${FAKE_SS_DIR}/acct"
  echo "101|$st|$ex"
fi
exit 0
`)
  writeFakeCli('scancel', `#!/bin/sh
echo "$@" >> "\${FAKE_SS_DIR}/scancel-calls"
exit 0
`)
}

function makeIterDir(name: string): string {
  const d = join(iterations, 'iterations', name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'config.yml'), 'name: test\n')
  return d
}

function runnerCfg(over: Partial<SbatchFitRunnerConfig> = {}): SbatchFitRunnerConfig {
  return { pollIntervalMs: 5, cliTimeoutMs: 2000, accountingGracePolls: 100, ...over }
}

const countSbatch = (): number => {
  const p = join(ctrl, 'count')
  return existsSync(p) ? Number(readFileSync(p, 'utf8')) : 0
}

/** Recorded sbatch argv, split into calls. */
function sbatchCalls(): string[][] {
  const p = join(ctrl, 'sbatch-calls')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.replace(/\x1e$/, '').split('\x1e'))
}

function scancelCalls(): string[] {
  const p = join(ctrl, 'scancel-calls')
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l !== '') : []
}

/** Terminal marker: squeue stops reporting, sacct reports the state. */
function finishJob(state = 'COMPLETED', exitCode = '0:0'): void {
  rmSync(join(ctrl, 'queue'), { force: true })
  writeFileSync(join(ctrl, 'acct'), `${state}|${exitCode}\n`)
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

describe('SbatchFitRunner (AI-authored job.sh)', () => {
  it('installs job.sh and submits it with --chdir=<iterDir> plus the fit args', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-000')
    const status = r.submit(dir, { scriptArgs: ['--runs', '1', '--max-iter', '500'] })
    expect(status.state).toBe('running')
    expect(countSbatch()).toBe(1)
    // The AI-owned script is installed into the iteration dir...
    const script = join(dir, 'job.sh')
    expect(existsSync(script)).toBe(true)
    expect(readFileSync(script, 'utf8')).toContain('#SBATCH --partition=gpu')
    // ...and submitted verbatim: --chdir + script path + fit args, no generated fit.slurm.
    const [call] = sbatchCalls()
    expect(call).toEqual(['--chdir=' + dir, script, '--runs', '1', '--max-iter', '500'])
    expect(existsSync(join(dir, 'fit.slurm'))).toBe(false)
    // Still running (no queue row, no accounting row yet) — the old code lied "done" here.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(r.status(status.jobId)?.state).toBe('running')
    finishJob()
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('done')
    expect(done.exitCode).toBe(0)
    expect(done.sbatchId).toBe('101')
    const reg = readSlurmJobRegistry(dir)
    expect(reg[status.jobId]?.state).toBe('done')
    expect(reg[status.jobId]?.scriptPath).toBe(script)
  })

  it('uses an explicit jobScript path as-is (no template install)', () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-custom')
    const custom = join(dir, 'my_job.sh')
    writeFileSync(custom, '#!/bin/bash\n#SBATCH --gres=gpu:v100:2\n')
    r.submit(dir, { jobScript: 'my_job.sh' })
    expect(sbatchCalls()[0]?.[1]).toBe(custom)
    expect(readFileSync(custom, 'utf8')).toContain('gpu:v100:2')
  })

  it('reports PENDING (with reason) while the job waits, instead of pretending to run', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-pending')
    const status = r.submit(dir)
    writeFileSync(join(ctrl, 'queue'), 'PENDING|Resources|0:42\n')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(r.progress(status.jobId)).toContain('PENDING')
    expect(r.progress(status.jobId)).toContain('Resources')
    expect(r.status(status.jobId)?.state).toBe('running')
    finishJob()
    expect((await r.settled(status.jobId)).state).toBe('done')
  })

  it('cancel DETACHES by default: the cluster job keeps running, no scancel', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-detach')
    const status = r.submit(dir)
    expect(r.cancel(status.jobId)).toBe(true)
    const done = await r.settled(status.jobId)
    expect(done.state).toBe('canceled')
    expect(scancelCalls()).toEqual([])
    const reg = readSlurmJobRegistry(dir)
    expect(reg[status.jobId]?.detached).toBe(true)
  })

  it('scancelOnCancel restores the old kill-the-cluster-job behavior', async () => {
    const r = new SbatchFitRunner(runnerCfg({ scancelOnCancel: true }))
    const dir = makeIterDir('iter-scancel')
    const status = r.submit(dir)
    r.cancel(status.jobId)
    expect(scancelCalls()).toEqual(['101'])
    expect((await r.settled(status.jobId)).state).toBe('canceled')
  })

  it('treats a missing sacct row as "not yet known", not as success', async () => {
    const r = new SbatchFitRunner(runnerCfg({ accountingGracePolls: 2 }))
    const dir = makeIterDir('iter-lag')
    const status = r.submit(dir)
    // squeue gone + sacct silent forever -> eventually failed, never done.
    const res = await r.settled(status.jobId)
    expect(res.state).toBe('failed')
    expect(res.logTail).toContain('sacct')
  })

  it('batch mode launches one job per trial dir from the same script and wakes once', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const a = makeIterDir('t-1')
    const b = makeIterDir('t-2')
    const c = makeIterDir('t-3')
    const status = r.submitBatch([a, b, c], { scriptArgs: ['--runs', '1'] })
    expect(status.state).toBe('running')
    expect(countSbatch()).toBe(3)
    const calls = sbatchCalls()
    expect(calls.map((x) => x[0])).toEqual([`--chdir=${a}`, `--chdir=${b}`, `--chdir=${c}`])
    // One shared script (the first dir's job.sh), submitted for every trial.
    expect(new Set(calls.map((x) => x[1])).size).toBe(1)
    finishJob()
    expect((await r.settled(status.jobId)).state).toBe('done')
    const reg = readSlurmJobRegistry(a)
    expect(reg[status.jobId]?.batch).toBe(true)
  })

  it('recovers a job from .slurm-jobs.json + sacct after a restart', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-recover')
    const status = r.submit(dir)
    const root = findIterationsRoot(dir)
    expect(findSlurmJobRecord(root, status.jobId)?.sbatchId).toBe('101')
    finishJob('FAILED', '2:0')
    // A fresh process (restart): no in-memory job, only the registry + slurm.
    const recovered = recoverSlurmJob(root, status.jobId)
    expect(recovered?.state).toBe('failed')
    expect(recovered?.exitCode).toBe(2)
    expect(recoverSlurmJob(root, '999999')).toBeUndefined()
  })

  it('recovery re-queries a DETACHED job instead of trusting the canceled record', async () => {
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-detach-recover')
    const status = r.submit(dir)
    r.cancel(status.jobId) // detach: registry says canceled, cluster job keeps running
    await r.settled(status.jobId)
    const root = findIterationsRoot(dir)
    // The cluster job is still in the queue -> recovery must say "running".
    writeFileSync(join(ctrl, 'queue'), 'RUNNING|None|0:05\n')
    const live = recoverSlurmJob(root, status.jobId)
    expect(live?.state).toBe('running')
    expect(live?.queue?.state).toBe('RUNNING')
    // Once it leaves the queue, sacct's terminal state wins.
    finishJob('COMPLETED')
    expect(recoverSlurmJob(root, status.jobId)?.state).toBe('done')
  })

  it('fails fast when sbatch is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-pwa-no-bin-'))
    process.env.PATH = empty
    const r = new SbatchFitRunner(runnerCfg())
    const dir = makeIterDir('iter-no-slurm')
    expect(() => r.submit(dir)).toThrow(/sbatch/)
    rmSync(empty, { recursive: true, force: true })
  })
})
