import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  parseBatch,
  retireStaleDaemon,
  runCli,
  sessionName,
  socketDir,
  versionIn,
} from '../cli.ts'
import { childGroups, groupAlive } from '../process-group.ts'

/** A stand-in for the CLI: it records each call and answers `--version` and a batch the way the real one does. */
const fakeCli = `#!/bin/sh
printf '%s\\n' "$*" >> "$AB_FAKE_LOG"
if [ "$1" = "--version" ]; then
  echo "agent-browser 0.41.2"
  exit 0
fi
cat > /dev/null
echo '[{"index":0,"success":true,"result":{"title":"Fake"}}]'
`

const batchArgs = (session: string) => [
  '--session',
  session,
  '--json',
  'batch',
  '--bail',
  '--omit-command',
]

/** A process in a group of its own, standing in for a daemon that a session recorded. */
async function daemon() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  await new Promise((resolve) => child.once('spawn', resolve))
  child.unref()
  return child.pid!
}

test('retires a daemon another CLI version started, and the call still runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-browser-daemon-test-'))
  const home = join(root, 'home')
  const bin = join(root, 'agent-browser')
  const log = join(root, 'calls.log')
  const pids = join(root, 'pids')
  const session = sessionName(7, home, join(root, 'project'))
  const dir = socketDir(home)
  const environment = { ULTIMATE_AGENT_BROWSER: bin, AB_FAKE_LOG: log }
  const saved = { ...process.env }
  let stale: number | undefined
  try {
    await mkdir(dir, { recursive: true })
    await mkdir(pids, { recursive: true })
    await writeFile(bin, fakeCli)
    await chmod(bin, 0o755)
    await writeFile(log, '')
    Object.assign(process.env, environment)

    stale = await daemon()
    await writeFile(join(dir, `${session}.pid`), `${stale}\n`)
    await writeFile(join(dir, `${session}.version`), '0.38.2\n')
    assert.ok(groupAlive(stale))

    const note = await retireStaleDaemon(session, {
      home,
      cwd: root,
      pidFile: join(pids, 'call.pid'),
    })
    assert.ok(note, 'a retired daemon is reported, never silently')
    assert.match(note, /0\.38\.2/)
    assert.match(note, /0\.41\.2/)
    assert.match(note, /retired/)
    assert.equal(groupAlive(stale), false, 'the stale daemon is gone')

    // The batch that follows runs on the clean daemon the CLI starts for it.
    const run = await runCli(batchArgs(session), {
      home,
      cwd: root,
      pidFile: join(pids, 'batch.pid'),
      budget: 20_000,
      input: JSON.stringify([['get', 'title']]),
    })
    assert.equal(run.code, 0)
    assert.deepEqual(parseBatch(run.stdout).rows, [
      { index: 0, success: true, result: { title: 'Fake' } },
    ])
    // One attempt: the version is asked once, then the batch.
    const calls = (await readFile(log, 'utf8')).trim().split('\n')
    assert.deepEqual(calls, ['--version', batchArgs(session).join(' ')])
  } finally {
    if (stale !== undefined && groupAlive(stale)) process.kill(-stale, 'SIGKILL')
    process.env = saved
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('leaves a daemon of this version and a session with no daemon alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-browser-daemon-test-'))
  const home = join(root, 'home')
  const bin = join(root, 'agent-browser')
  const log = join(root, 'calls.log')
  const pids = join(root, 'pids')
  const session = sessionName(8, home, join(root, 'project'))
  const dir = socketDir(home)
  const saved = { ...process.env }
  const live: number[] = []
  const options = { home, cwd: root, pidFile: join(pids, 'call.pid') }
  try {
    await mkdir(dir, { recursive: true })
    await mkdir(pids, { recursive: true })
    await writeFile(bin, fakeCli)
    await chmod(bin, 0o755)
    await writeFile(log, '')
    Object.assign(process.env, { ULTIMATE_AGENT_BROWSER: bin, AB_FAKE_LOG: log })

    // No daemon is recorded: nothing to compare, so the binary is not even asked.
    assert.equal(await retireStaleDaemon(session, options), undefined)
    assert.equal((await readFile(log, 'utf8')).trim(), '')

    // A daemon of this very version is kept, and so is a browser and every login in it.
    const current = await daemon()
    live.push(current)
    await writeFile(join(dir, `${session}.pid`), `${current}\n`)
    await writeFile(join(dir, `${session}.version`), '0.41.2\n')
    assert.equal(await retireStaleDaemon(session, options), undefined)
    assert.ok(groupAlive(current))
  } finally {
    for (const pid of live) if (groupAlive(pid)) process.kill(-pid, 'SIGKILL')
    process.env = saved
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('retires a daemon that recorded no version, which only a CLI older than the version file leaves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-browser-daemon-test-'))
  const home = join(root, 'home')
  const bin = join(root, 'agent-browser')
  const log = join(root, 'calls.log')
  const pids = join(root, 'pids')
  const session = sessionName(9, home, join(root, 'project'))
  const dir = socketDir(home)
  const saved = { ...process.env }
  let old: number | undefined
  try {
    await mkdir(dir, { recursive: true })
    await mkdir(pids, { recursive: true })
    await writeFile(bin, fakeCli)
    await chmod(bin, 0o755)
    await writeFile(log, '')
    Object.assign(process.env, { ULTIMATE_AGENT_BROWSER: bin, AB_FAKE_LOG: log })

    old = await daemon()
    await writeFile(join(dir, `${session}.pid`), `${old}\n`)
    const note = await retireStaleDaemon(session, { home, cwd: root, pidFile: join(pids, 'call.pid') })
    assert.ok(note, 'a daemon without a version is reported, never silently')
    assert.match(note, /recorded no version/)
    assert.equal(groupAlive(old), false, 'the stale daemon is gone')
  } finally {
    if (old !== undefined && groupAlive(old)) process.kill(-old, 'SIGKILL')
    process.env = saved
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('finds the groups a daemon’s children lead, which stopping the daemon alone would leave behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-browser-groups-test-'))
  const fixture = join(root, 'spawner.mjs')
  // A child in a group of its own is what a browser started by a daemon is, and what `ps -P` cannot be asked for on
  // macOS, where that option does not exist: the groups are read from the whole process table instead.
  await writeFile(
    fixture,
    `import { spawn } from 'node:child_process'
const child = spawn(process.argv[2], [process.argv[3]], { detached: true, stdio: 'ignore' })
console.log(child.pid)
setInterval(() => {}, 1000)
`,
  )
  const spawner = spawn(process.execPath, [fixture, 'sleep', '60'], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const child = await new Promise<number>((resolve, reject) => {
      let out = ''
      spawner.stdout.setEncoding('utf8')
      spawner.stdout.on('data', (chunk: string) => {
        out += chunk
        const line = out.split('\n')[0]?.trim()
        if (line && /^\d+$/.test(line)) resolve(Number(line))
      })
      spawner.once('error', reject)
    })
    try {
      assert.deepEqual(childGroups(spawner.pid!), [child])
      assert.ok(groupAlive(child))
    } finally {
      process.kill(-child, 'SIGKILL')
    }
  } finally {
    spawner.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('reads the version out of the CLI’s own line', () => {
  assert.equal(versionIn('agent-browser 0.41.2\n'), '0.41.2')
  assert.equal(versionIn('\n  agent-browser 1.2.3-beta.1  \n'), '1.2.3-beta.1')
  assert.equal(versionIn('agent-browser'), undefined)
})
