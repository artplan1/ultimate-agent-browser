import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { arr, bool, int, obj, opt, str } from '@earendil-works/pi-schema'
import { sweepPidFiles } from './process-group.ts'
import {
  callBudget,
  callSteps,
  mediaCommand,
  screenshotFile,
  stepCommand,
  stepSummary,
  themeApplySource,
  themeInitSource,
} from './commands.ts'
import {
  closeSession,
  parseBatch,
  pidFile,
  recoverDaemon,
  retireStaleDaemon,
  runCli,
  sessionName,
  socketDir,
  stepTimeoutMs,
} from './cli.ts'
import type { BatchResult } from './cli.ts'
import { thumbnail } from './shots.ts'
import { strEnum, webStep } from './steps.ts'

/**
 * The host this extension needs, as a shape rather than an import: the extension is its own repository and depends on
 * no Ultimate checkout, only on the packages Ultimate supplies at runtime.
 */
type Host = {
  home: string
  projectRoot: string
  system(): { process: { url: string } }
  onOpen(callback: () => Promise<void>): void
  onClose(cleanup: () => Promise<void>): void
}

/** One command of a batch under the key its row is read by; `--omit-command` numbers them in this order. */
type Planned = { key: string; command: string[] }

/** The batch's rows by the key of the command that produced them; a command that never ran has none. */
function resultsBy(planned: readonly Planned[], rows: readonly BatchResult[]) {
  const byIndex = new Map(rows.map((row) => [row.index, row]))
  return (key: string) => byIndex.get(planned.findIndex((item) => item.key === key))
}

const field = (row: BatchResult | undefined, key: string) => {
  const value = row?.result?.[key]
  return typeof value === 'string' ? value : undefined
}

/** The first command that failed, named, and why: what stopped a batch. */
function firstFailure(planned: readonly Planned[], rows: readonly BatchResult[]) {
  const failed = rows.find((row) => !row.success)
  if (!failed) return undefined
  return `${planned[failed.index]?.command[0] ?? 'agent-browser'}: ${failed.error ?? 'failed'}`
}

/**
 * Run planned commands as one bounded batch. A call that outlives its budget stops the CLI's group and, when the
 * session's daemon is the wedge, the daemon too, so it fails instead of hanging.
 */
async function runBatch(
  planned: readonly Planned[],
  options: {
    home: string
    session: string
    cwd: string
    pidFile: string
    budget: number
    signal?: AbortSignal
  },
) {
  const run = await runCli(
    ['--session', options.session, '--json', 'batch', '--bail', '--omit-command'],
    {
      home: options.home,
      cwd: options.cwd,
      pidFile: options.pidFile,
      budget: options.budget,
      input: JSON.stringify(planned.map((item) => item.command)),
      signal: options.signal,
    },
  )
  if (run.timedOut) {
    const note = await recoverDaemon(options.session, {
      home: options.home,
      cwd: options.cwd,
      pidFile: options.pidFile,
      signal: options.signal,
    })
    throw new Error(
      `timed out after ${Math.round(options.budget / 1000)}s: agent-browser did not finish; ${note}`,
    )
  }
  if (run.code === 127 && /not found/.test(run.stderr))
    throw new Error(
      `The agent-browser CLI is not installed (npm install -g agent-browser@0.41.2): ${run.stderr.trim()}`,
    )
  const parsed = parseBatch(run.stdout)
  if (parsed.rows.length === 0 && parsed.failure === undefined)
    throw new Error(`agent-browser printed no results: ${run.stderr.trim() || `exit ${run.code}`}`)
  return parsed
}

/** The init script an own-UI open registers: written once per call, so an upgrade replaces it. */
async function themeInitScript(home: string) {
  const file = join(home, 'agent-browser', 'init.js')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, themeInitSource())
  return file
}

/**
 * Remove this home's socket directory once no daemon is recorded in it. A `.pid` left behind belongs to a daemon
 * something still drives, and the directory stays for it.
 */
async function pruneSocketDir(home: string) {
  const dir = socketDir(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (names.some((name) => name.endsWith('.pid'))) return
  await rm(dir, { recursive: true, force: true })
}

export default function agentBrowserExtension(host: Host) {
  /** Running calls record their process groups here, so a host that died mid-call stops them on its next open. */
  const pids = join(host.home, 'agent-browser')
  /** The sessions this host drove: the browsers it ends when it closes. */
  const sessions = new Set<string>()
  host.onOpen(async () => {
    await sweepPidFiles(pids, (name) => name.startsWith(`${process.pid}-`))
  })
  // A daemon and the Chrome it started are not children of this process and outlive it: on the way out, every session
  // this host drove is closed, or its daemon stopped by the pid it recorded, so nothing keeps a worktree busy.
  host.onClose(async () => {
    const closing = [...sessions]
    sessions.clear()
    const problems: string[] = []
    for (const session of closing) {
      try {
        await closeSession(session, {
          home: host.home,
          cwd: host.projectRoot,
          pidFile: pidFile(pids),
        })
      } catch (error) {
        problems.push(`${session}: ${String(error)}`)
      }
    }
    await pruneSocketDir(host.home)
    if (problems.length)
      throw new Error(`agent-browser could not close every session: ${problems.join('; ')}`)
  })
  return defineExtension({
    name: 'agent-browser',
    tools: [
      defineTool({
        name: 'browser',
        description: [
          'Drive a real Chrome through the agent-browser CLI, in a browser that stays open between calls of this conversation: `url` or an `open` step loads a page, `snapshot` returns its accessibility tree with @e1-style refs, and `click`, `fill` and `press` act on those refs. Cookies, tabs and logins persist from one call to the next, so sign in once and keep working; `close` ends the session and its logins.',
          'Every step is an object, and `snapshot` and `wait` describe how, so each takes an object, never a boolean: `{"snapshot": {}}` snapshots the page, with optional `interactive`, `compact`, `depth` and `scope`, and `{"wait": {"load": "networkidle"}}` waits for a load event, with exactly one of `selector`, `text`, `url`, `load`, `fn` or `ms` per wait; `load` is `load`, `domcontentloaded` or `networkidle`, so `{"snapshot": true}` and `{"wait": {"load": true}}` are rejected.',
          'Screenshots are a step, not a tool of their own: a `screenshot` step saves a PNG at a `viewport` you set, with `theme` for one UI and other pages alike; a final screenshot is returned unless `screenshot: false`.',
          'Steps run in order in one batch and stop at the first failure; each times out after 30 s (timeoutMs). Refs stay valid until the page changes, so snapshot again after navigating; an app that mounts after load (Next-style) can return 0 refs to a snapshot straight after `open`, so wait for `networkidle` before the first snapshot.',
        ].join(' '),
        // Two calls must not drive one session at once: a round of them is one browser script.
        executionMode: 'sequential',
        parameters: obj({
          url: opt(
            str({
              description:
                'Page to load first, before the steps; a relative URL resolves against this UI. The same as an `open` step at the start.',
            }),
          ),
          steps: arr(webStep, { description: 'What to do, in order, in the session’s browser.' }),
          path: opt(
            str({
              description:
                'Where the final screenshot is saved, relative to your cwd; default: a new file in the home.',
            }),
          ),
          screenshot: opt(
            bool({ description: 'Screenshot the page after the last step; default true.' }),
          ),
          theme: opt(
            strEnum(['light', 'dark'], {
              description:
                'Color scheme for this call: emulated for other pages, and this UI’s own theme for a page on this host. Set it before a screenshot step that must show a theme.',
            }),
          ),
          timeoutMs: opt(int({ minimum: 1, description: 'Limit for one step; default 30000.' })),
        }),
        async execute(args, api, context) {
          const cwd = api.env?.cwd ?? host.projectRoot
          const stepMs = args.timeoutMs ?? stepTimeoutMs
          const session = sessionName(api.conversationId, host.home, host.projectRoot)
          const outcomes: string[] = []
          const errors: string[] = []
          try {
            sessions.add(session)
            const base = host.system().process.url
            const steps = callSteps(args.url, args.steps)
            const capture =
              args.screenshot === false ? undefined : screenshotFile(host.home, cwd, args.path)
            const initScript = steps.some((step) => 'open' in step)
              ? await themeInitScript(host.home)
              : undefined
            const stated = steps.some((step) => 'close' in step)
            const planned: Planned[] = []
            const plan = (key: string, command: string[]) => planned.push({ key, command })
            const stepOptions = {
              home: host.home,
              cwd,
              timeoutMs: stepMs,
              base,
              ...(initScript === undefined ? {} : { initScript }),
              ...(args.theme === undefined ? {} : { theme: args.theme }),
            }
            // The theme applies right before a shot: this UI writes its stored preference back on every change.
            const applyTheme = (key: string, theme: 'light' | 'dark') =>
              plan(
                key,
                stepCommand({ eval: themeApplySource(theme, new URL(base).origin) }, stepOptions),
              )
            // This call's console and page errors only: the session keeps them otherwise.
            plan('console-clear', ['console', '--clear'])
            plan('errors-clear', ['errors', '--clear'])
            if (args.theme) plan('media', mediaCommand(args.theme))
            for (const [index, step] of steps.entries()) {
              if (args.theme && 'screenshot' in step) applyTheme(`theme ${index}`, args.theme)
              plan(`step ${index}`, stepCommand(step, stepOptions))
            }
            if (capture && !stated) {
              if (args.theme) applyTheme('capture-theme', args.theme)
              plan('capture', stepCommand({ screenshot: { path: capture } }, stepOptions))
            }
            // A closed browser has no page to read: the CLI would open a fresh one to answer these.
            if (!stated) {
              plan('title', ['get', 'title'])
              plan('url', ['get', 'url'])
              plan('console', ['console'])
              plan('errors', ['errors'])
            }
            for (const item of planned)
              if (item.command[0] === 'screenshot')
                await mkdir(dirname(item.command[1]), { recursive: true })
            api.output(`agent-browser ${session}: ${steps.length} step(s)\n`)
            // A daemon from another CLI version cannot run these steps at all: retire it before the batch reaches it.
            const retired = await retireStaleDaemon(session, {
              home: host.home,
              cwd,
              pidFile: pidFile(pids),
              signal: context.abortSignal,
            })
            const { rows, failure } = await runBatch(planned, {
              home: host.home,
              session,
              cwd,
              pidFile: pidFile(pids),
              budget: callBudget(steps, stepMs),
              signal: context.abortSignal,
            })
            const result = resultsBy(planned, rows)
            let snapshot: string | undefined
            let opened: { title?: string; url?: string } = {}
            let stepError: string | undefined
            for (const [position, step] of steps.entries()) {
              const row = result(`step ${position}`)
              if (!row) break
              if (!row.success) {
                stepError = row.error ?? 'failed'
                outcomes.push(`Step ${position + 1}: ${stepError}`)
                break
              }
              outcomes.push(`Step ${position + 1}: OK ${stepSummary(step, row.result)}`)
              if ('open' in step) opened = { title: field(row, 'title'), url: field(row, 'url') }
              if ('snapshot' in step && typeof row.result?.snapshot === 'string') {
                const count = Object.keys((row.result.refs ?? {}) as Record<string, unknown>).length
                snapshot = [
                  `Snapshot (step ${position + 1}, ${count} ref${count === 1 ? '' : 's'}):`,
                  row.result.snapshot,
                ].join('\n')
              }
            }
            for (const message of (result('console')?.result?.messages ?? []) as {
              type?: string
              text?: string
            }[])
              if (message.type === 'error' && typeof message.text === 'string')
                errors.push(`Console error: ${message.text.split('\n')[0]}`)
            for (const error of (result('errors')?.result?.errors ?? []) as { text?: string }[]) {
              const line = error.text?.split('\n')[0]
              if (line) errors.push(`Page error: ${line.replace(/^Uncaught /, '')}`)
            }
            // Not a step's failure: nothing ran, and the CLI says why. A retired daemon says why the versions differ.
            if (outcomes.length === 0)
              throw new Error(
                [
                  `agent-browser did not run the steps: ${failure ?? firstFailure(planned, rows) ?? 'no step ran'}`,
                  ...(retired ? [retired] : []),
                ].join('\n'),
              )
            const title = field(result('title'), 'title') ?? opened.title
            const url = field(result('url'), 'url') ?? opened.url
            const captured = args.screenshot === false ? undefined : result('capture')
            const shotPath =
              captured?.success && capture
                ? capture
                : steps
                    .map((step, index) =>
                      'screenshot' in step ? result(`step ${index}`) : undefined,
                    )
                    .filter((row) => row?.success && typeof row.result?.path === 'string')
                    .at(-1)?.result?.path
            const picture =
              typeof shotPath === 'string'
                ? await thumbnail(shotPath).catch(
                    // A PNG that cannot be read leaves the steps and title: no image, never no answer.
                    () => undefined,
                  )
                : undefined
            const output = [
              ...(title ? [`Title: ${title}`] : []),
              ...(url ? [`URL: ${url}`] : []),
              ...(retired ? [retired] : []),
              ...outcomes,
              ...(picture ? [`PNG: ${picture.file}`] : []),
              ...errors,
              ...(snapshot ? ['', snapshot] : []),
            ].join('\n')
            context.abortSignal?.throwIfAborted()
            return {
              ...(stepError ? { isError: true } : {}),
              output: [
                ...(picture?.note ? [{ type: 'text' as const, text: picture.note }] : []),
                ...(picture?.image ? [picture.image] : []),
                { type: 'text' as const, text: output },
              ],
            }
          } catch (error) {
            return {
              isError: true,
              output: [
                { type: 'text' as const, text: [...outcomes, ...errors, String(error)].join('\n') },
              ],
            }
          }
        },
      }),
    ],
  })
}
