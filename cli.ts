import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  childGroups,
  identify,
  readPidFile,
  readText,
  runGroup,
  stopGroup,
} from './process-group.ts'

/** One command's limit unless the call passes timeoutMs; a wait step's own budget can raise it. */
export const stepTimeoutMs = 30_000
/** How long the daemon probe after a timeout may take. */
const probeTimeoutMs = 5_000
/** How long asking the binary its own version may take: it prints one line and starts no daemon. */
const versionTimeoutMs = 10_000
/** Output the CLI may print before a call gives up on it: a snapshot of a huge app is hundreds of kilobytes, not megabytes. */
const outputLimit = 8_000_000

/** The CLI to run; ULTIMATE_AGENT_BROWSER pins another path than the installed one. */
const binary = () => process.env.ULTIMATE_AGENT_BROWSER ?? 'agent-browser'

/**
 * The session one conversation drives. The same conversation id exists in other projects and in a preview of this one,
 * which would otherwise share a browser: the home and the project tell them apart. Both are stable across restarts, so
 * a session outlives one.
 */
export function sessionName(conversationId: number, home: string, projectRoot: string) {
  const tag = createHash('sha256').update(`${home}\0${projectRoot}`).digest('hex').slice(0, 8)
  return `ultimate-${conversationId}-${tag}`
}

/**
 * The CLI's socket directory for this home. A unix socket's path is limited to 104 bytes and the CLI's default is under
 * the home, which a preview's temporary home already overflows; /tmp keeps it short for every home. Home decides the
 * name, so two Ultimates never share a daemon directory.
 */
export const socketDir = (home: string) =>
  join('/tmp', `ultimate-ab-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`)

/** The pid file a session's daemon records, next to its socket. */
const daemonPidFile = (home: string, session: string) =>
  join(socketDir(home), `${session}.pid`)

/** A recorded pid, or undefined: a missing or unreadable file is no recorded pid. */
const recordedPid = (path: string) => readPidFile(path).catch(() => undefined)

export type CliRun = { code: number; stdout: string; stderr: string; timedOut: boolean }

/**
 * Run the CLI as its own recorded process group, with `input` on its stdin, for at most `budget` ms. The group is
 * killed when the budget or `signal` ends the call: agent-browser has no per-command deadline upstream, so this is what
 * keeps a wedged daemon from hanging the tool.
 */
export async function runCli(
  args: string[],
  options: {
    home: string
    cwd: string
    pidFile: string
    budget: number
    input?: string
    signal?: AbortSignal
  },
): Promise<CliRun> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.budget)
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  let stdout = ''
  let stderr = ''
  try {
    const code = await runGroup(binary(), args, {
      cwd: options.cwd,
      pidFile: options.pidFile,
      signal,
      grace: 1000,
      env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir(options.home) },
      ...(options.input === undefined ? {} : { input: options.input }),
      onOutput(text, stream) {
        const sofar = stream === 'stdout' ? stdout : stderr
        if (sofar.length + text.length > outputLimit) return
        if (stream === 'stdout') stdout += text
        else stderr += text
      },
    })
    return { code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** One command's row of `batch --json`. */
export type BatchResult = {
  index: number
  success: boolean
  error?: string
  result?: Record<string, unknown>
}

const excerpt = (text: string) => (text.length > 400 ? `${text.slice(0, 400)}…` : text)

/**
 * The rows of `batch --json`, oldest first. `failure` is a batch the CLI refused before running anything, such as an
 * invalid argument; malformed output throws, naming what came instead.
 */
export function parseBatch(stdout: string): { rows: BatchResult[]; failure?: string } {
  const text = stdout.trim()
  if (!text) throw new Error('agent-browser printed nothing')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A warning before the array (an outdated Chrome, an ignored setting): the JSON starts at the bracket.
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end < start)
      throw new Error(`agent-browser's output is not JSON: ${excerpt(text)}`)
    try {
      value = JSON.parse(text.slice(start, end + 1))
    } catch {
      throw new Error(`agent-browser's output is not JSON: ${excerpt(text)}`)
    }
  }
  if (!Array.isArray(value)) {
    const failure = (value as { error?: unknown } | null)?.error
    if (typeof failure === 'string') return { rows: [], failure }
    throw new Error(`agent-browser's output is not a batch: ${excerpt(text)}`)
  }
  const rows = value.map((row: unknown, position) => {
    const { index, success, error, result } = (row ?? {}) as {
      index?: unknown
      success?: unknown
      error?: unknown
      result?: unknown
    }
    if (typeof success !== 'boolean')
      throw new Error(
        `agent-browser's output has no outcome at ${position}: ${excerpt(JSON.stringify(row))}`,
      )
    return {
      index: typeof index === 'number' && Number.isSafeInteger(index) ? index : position,
      success,
      ...(typeof error === 'string' && error ? { error } : {}),
      ...(result !== null && typeof result === 'object'
        ? { result: result as Record<string, unknown> }
        : {}),
    }
  })
  return { rows }
}

/** What stopping a session's recorded daemon came to: the browser groups that went with it, or why it stayed. */
type DaemonStop = { browsers: number } | { problem: string }

/**
 * Stop the daemon a session recorded, and the browser it started. A daemon's Chrome runs in groups of its own, so
 * stopping the daemon alone would leave a headless browser behind under a new parent: its groups are read first, then
 * both are stopped, each verified by the pid and start time recorded for it. Undefined when no daemon is recorded.
 */
async function stopDaemon(
  session: string,
  options: { home: string; cwd: string; pidFile: string },
): Promise<DaemonStop | undefined> {
  // An unreadable pid file is no recorded daemon: nothing to stop, and the next call launches one.
  const pid = await recordedPid(daemonPidFile(options.home, session))
  if (pid === undefined) return undefined
  const browsers = childGroups(pid)
  const stop = async (group: number) => {
    const file = `${options.pidFile}.stop-${group}`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${group}\n`)
    await writeFile(`${file}.start`, `${identify(group)}\n`)
    await stopGroup(group, { pidFile: file, grace: 1000 })
  }
  try {
    await stop(pid)
    for (const group of browsers) await stop(group)
  } catch (error) {
    return { problem: String(error) }
  }
  return { browsers: browsers.length }
}

/** A daemon stop, worded for a message that already says why the daemon is going. */
function stopped(stop: DaemonStop | undefined) {
  if (stop === undefined) return 'no daemon was recorded, so the next call starts one'
  if ('problem' in stop) return `stopping its daemon failed: ${stop.problem}`
  return `its daemon was stopped with ${stop.browsers} browser group(s): the next call opens a fresh browser, and a login in the old one is gone`
}

/**
 * A call that outlived its budget may have hit a wedged daemon, which 0.41.2 cannot time out. A daemon that still
 * answers was only slow and is left alone; one that does not is stopped with the browser it started, so the next call
 * starts a fresh one instead of hanging again. Returns what to tell the caller.
 */
export async function recoverDaemon(
  session: string,
  options: { home: string; cwd: string; pidFile: string; signal?: AbortSignal },
) {
  const probe = await runCli(['--session', session, '--json', 'session', 'info'], {
    ...options,
    pidFile: `${options.pidFile}.probe`,
    budget: probeTimeoutMs,
  }).catch((error: unknown) => ({ timedOut: true, code: 1, stdout: '', stderr: String(error) }))
  if (!probe.timedOut && probe.code === 0) return 'the session still answered, so it was only slow'
  return stopped(await stopDaemon(session, options))
}

/**
 * End one session's browser. The CLI's `close` stops the page and its Chrome; a daemon that does not answer, or that
 * `close` left running, is stopped with the pid it recorded. Returns what happened.
 */
export async function closeSession(
  session: string,
  options: { home: string; cwd: string; pidFile: string; budget?: number },
) {
  const run = await runCli(['--session', session, 'close'], {
    ...options,
    budget: options.budget ?? 10_000,
  }).catch(() => ({ code: 1, stdout: '', stderr: '', timedOut: true }))
  const recorded = await recordedPid(daemonPidFile(options.home, session))
  if (!run.timedOut && run.code === 0 && recorded === undefined) return 'closed'
  return `closed: ${stopped(await stopDaemon(session, options))}`
}

/** The version in the CLI's own `agent-browser 0.41.2` line. */
export function versionIn(output: string) {
  return /\b\d+\.\d+\.\d+[-\w.]*/.exec(output)?.[0]
}

/**
 * Retire a daemon that another CLI version started, before a batch reaches it. An upgrade leaves the old daemon running
 * and the CLI reuses it, so every batch then fails with `Unknown command: --omit-command`: the daemon knows the commands
 * of the version that started it, not this binary's. So when the version the session recorded differs from the
 * binary's, the daemon is stopped with the browser it started, and the batch launches a clean one. One attempt: a stop
 * that fails is reported, never retried. Returns the note to show the caller, or undefined when there was nothing to
 * retire.
 */
export async function retireStaleDaemon(
  session: string,
  options: { home: string; cwd: string; pidFile: string; signal?: AbortSignal },
): Promise<string | undefined> {
  const dir = socketDir(options.home)
  // A daemon records nothing here without a pid file: no daemon is running, and the batch starts one.
  const pid = await recordedPid(daemonPidFile(options.home, session))
  if (pid === undefined) return undefined
  const recorded = await readText(join(dir, `${session}.version`))
  const binary = await runCli(['--version'], {
    ...options,
    pidFile: `${options.pidFile}.version`,
    budget: versionTimeoutMs,
  })
    .then((run) => (run.code === 0 ? versionIn(run.stdout) : undefined))
    .catch(() => undefined)
  // Nothing to compare against: the daemon is left alone.
  if (binary === undefined || recorded === binary) return undefined
  // Every CLI that writes a version file writes it when its daemon starts: one that recorded none is older than this
  // binary, so it is just as stale as one whose version differs.
  const stop = await stopDaemon(session, options)
  const versions = recorded
    ? `the session's daemon was started by agent-browser ${recorded} and this binary is ${binary}`
    : `the session's daemon recorded no version, so it was started by an agent-browser older than this binary's ${binary}`
  if (stop === undefined) return `Note: ${versions}; it was gone already, so the steps start a fresh one.`
  if ('problem' in stop)
    return `Note: ${versions}, and stopping the stale daemon failed (${stop.problem}): a step may fail with an unknown-command error.`
  return `Note: ${versions}, so the daemon and its browser were retired first: the steps run in a fresh browser, and a login from before is gone.`
}

/** A pid file of one call, in the directory the extension sweeps on open. */
export const pidFile = (directory: string) => join(directory, `${process.pid}-${randomUUID()}.pid`)
