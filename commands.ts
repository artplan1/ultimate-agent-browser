/**
 * What a `browse` step becomes on the CLI's command line, and what it returned. No package imports: this half is tested
 * with plain node, while `steps.ts` declares the schema it maps.
 */
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { WebStep } from './steps.ts'

/** The url parameter the theme init script reads; one session then serves both themes. */
export const THEME_PARAM = 'ultimate-theme'

/**
 * The PNG's absolute path: `path` against the conversation's cwd, else a new file in the home's screenshots.
 * `hint` says where a page goes in the calling tool, for a model that passed one as `path`.
 */
export function screenshotFile(home: string, cwd: string, path?: string, hint = '') {
  if (path === undefined) return join(home, 'screenshots', `${Date.now()}-${randomUUID()}.png`)
  if (!path.endsWith('.png'))
    throw new Error(
      `path is where the PNG is saved and must end in .png, not ${JSON.stringify(path)}${hint}`,
    )
  return resolve(cwd, path)
}

/**
 * The init script every page of an own-UI open runs before its own scripts: the theme comes from the url's
 * `ultimate-theme` parameter, so one session serves light and dark. Our UI is also detached from the shared durable UI
 * state in an automated browser, so its clicks never move the user's tabs.
 */
export function themeInitSource() {
  return `// Written by the ultimate-agent-browser extension; the CLI replays it into every page it is registered for.
;(() => {
  try {
    const theme = new URL(location.href).searchParams.get(${JSON.stringify(THEME_PARAM)})
    if (theme === 'light' || theme === 'dark') localStorage.setItem('ultimate.theme', theme)
    sessionStorage.setItem('ultimate.detached', '1')
  } catch {
    // A page without storage (about:blank, data:, an error page) is still worth its screenshot.
  }
})()
`
}

/**
 * The JavaScript that applies `theme` to this UI before a capture. An init script alone loses the race: the UI writes
 * its stored preference back on every store change, so the preference is applied to the page right before the shot.
 * A page of another origin is left to the emulated color scheme.
 */
export function themeApplySource(theme: 'light' | 'dark', ownOrigin: string) {
  return `(() => {
  if (location.origin !== ${JSON.stringify(ownOrigin)}) return 'other origin'
  // Never throws: a failed line here must not stop the batch before the shot it prepares.
  try {
    const theme = ${JSON.stringify(theme)}
    localStorage.setItem('ultimate.theme', theme)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#111112' : '#f9fafb')
    return theme
  } catch (error) {
    return 'theme not applied: ' + String(error)
  }
})()`
}

/** The color scheme every page of this call gets, before any page is opened. */
export const mediaCommand = (theme: 'light' | 'dark') => ['set', 'media', theme]

/** The steps one call runs: a `url` opens first, the way the built-in browser tool's url does. */
export function callSteps(url: string | undefined, steps: readonly WebStep[]): WebStep[] {
  return url === undefined ? [...steps] : [{ open: url }, ...steps]
}

/** The budget one step gets: a wait's own limit, else the call's. */
export function stepBudget(step: WebStep, stepMs: number) {
  return 'wait' in step ? (step.wait.ms ?? step.wait.timeoutMs ?? stepMs) : stepMs
}

/**
 * The batch's limit as a whole: every step's budget, plus four steps' worth for launching a daemon, starting Chrome and
 * reading the trailing title, url, console and screenshot. No single command has its own deadline upstream, so this is
 * what keeps a call from hanging.
 */
export function callBudget(steps: readonly WebStep[], stepMs: number) {
  return steps.reduce((sum, step) => sum + stepBudget(step, stepMs), 4 * stepMs)
}

/**
 * The CLI's command line for one step. Throws on a step that does not say what to do. An `open` of this UI's own origin
 * carries the theme parameter and the init script; any other page is opened exactly as asked.
 */
export function stepCommand(
  step: WebStep,
  options: {
    home: string
    cwd: string
    timeoutMs: number
    base?: string
    initScript?: string
    theme?: 'light' | 'dark'
  },
): string[] {
  if ('open' in step) {
    if (options.base === undefined || options.initScript === undefined)
      return ['open', step.open]
    const url = new URL(step.open, options.base)
    if (url.origin !== new URL(options.base).origin) return ['open', step.open]
    if (options.theme) url.searchParams.set(THEME_PARAM, options.theme)
    return ['open', url.href, '--init-script', options.initScript]
  }
  if ('snapshot' in step) {
    const { interactive, compact, depth, scope } = step.snapshot
    return [
      'snapshot',
      ...(interactive === false ? [] : ['-i']),
      ...(compact ? ['-c'] : []),
      ...(depth === undefined ? [] : ['-d', String(depth)]),
      ...(scope === undefined ? [] : ['-s', scope]),
    ]
  }
  if ('click' in step) return ['click', step.click]
  if ('fill' in step) return ['fill', step.fill[0], step.fill[1]]
  if ('press' in step) return ['press', step.press]
  if ('find' in step) {
    const { by, value, action, text, name, exact } = step.find
    if (text === undefined && ['fill', 'type', 'press', 'select'].includes(action))
      throw new Error(`A find step with action ${action} needs text`)
    return [
      'find',
      by,
      value,
      action,
      ...(text === undefined ? [] : [text]),
      ...(name === undefined ? [] : ['--name', name]),
      ...(exact ? ['--exact'] : []),
    ]
  }
  if ('wait' in step) {
    const { selector, state, text, url, load, fn, ms, timeoutMs } = step.wait
    const modes = [selector, text, url, load, fn, ms].filter((mode) => mode !== undefined)
    if (modes.length !== 1)
      throw new Error(
        `A wait step takes exactly one of selector, text, url, load, fn or ms, not ${modes.length === 0 ? 'none of them' : 'several'}`,
      )
    if (ms !== undefined) return ['wait', String(ms)]
    const limit = ['--timeout', String(timeoutMs ?? options.timeoutMs)]
    if (selector !== undefined)
      return ['wait', selector, ...(state === undefined ? [] : ['--state', state]), ...limit]
    if (text !== undefined) return ['wait', '--text', text, ...limit]
    if (url !== undefined) return ['wait', '--url', url, ...limit]
    if (load !== undefined) return ['wait', '--load', load, ...limit]
    return ['wait', '--fn', fn!, ...limit]
  }
  if ('eval' in step) return ['eval', '-b', Buffer.from(step.eval).toString('base64')]
  if ('screenshot' in step)
    return [
      'screenshot',
      screenshotFile(options.home, options.cwd, step.screenshot.path),
      ...(step.screenshot.fullPage ? ['--full'] : []),
    ]
  if ('viewport' in step)
    return ['set', 'viewport', String(step.viewport[0]), String(step.viewport[1])]
  return ['close']
}

/** What one step returned, as the value its step line shows after `OK`. */
export function stepSummary(step: WebStep, result: Record<string, unknown> = {}): string {
  if ('open' in step) return JSON.stringify(result.title ?? step.open)
  if ('snapshot' in step) {
    const refs = Object.keys(result.refs ?? {}).length
    return `${refs} ref${refs === 1 ? '' : 's'}`
  }
  if ('click' in step) return `clicked ${step.click}`
  if ('fill' in step) return `filled ${step.fill[0]}`
  if ('press' in step) return `pressed ${step.press}`
  if ('find' in step) return `${step.find.action} ${step.find.name ?? step.find.value}`
  if ('wait' in step) {
    const { selector, text, url, load, fn, ms } = step.wait
    const what = selector ?? text ?? url ?? load ?? fn
    return ms === undefined ? `waited for ${what}` : `waited ${ms} ms`
  }
  if ('eval' in step) return JSON.stringify(result.result) ?? 'undefined'
  if ('screenshot' in step) return typeof result.path === 'string' ? result.path : ''
  if ('viewport' in step) return `${step.viewport[0]}×${step.viewport[1]}`
  return 'closed'
}
