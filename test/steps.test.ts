import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBatch, sessionName, socketDir } from '../cli.ts'
import {
  callBudget,
  callSteps,
  cliResult,
  screenshotFile,
  stepBudget,
  stepCommand,
  stepFailure,
  stepSummary,
  themeApplySource,
  themeInitSource,
  THEME_PARAM,
} from '../commands.ts'
import type { WebStep } from '../steps.ts'

const paths = { home: '/home', cwd: '/work', timeoutMs: 12_000 }
const commands = (step: WebStep, extra = {}) => stepCommand(step, { ...paths, ...extra })

test('maps a browse step to its agent-browser command', () => {
  assert.deepEqual(commands({ open: 'https://example.com' }), ['open', 'https://example.com'])
  assert.deepEqual(commands({ snapshot: {} }), ['snapshot', '-i'])
  assert.deepEqual(commands({ snapshot: { interactive: false, compact: true, depth: 3, scope: '#main' } }), [
    'snapshot',
    '-c',
    '-d',
    '3',
    '-s',
    '#main',
  ])
  assert.deepEqual(commands({ click: '@e3' }), ['click', '@e3'])
  assert.deepEqual(commands({ fill: ['@e4', 'hello world'] }), ['fill', '@e4', 'hello world'])
  assert.deepEqual(commands({ press: 'Enter' }), ['press', 'Enter'])
  assert.deepEqual(
    commands({ find: { by: 'role', value: 'button', action: 'click', name: 'Submit' } }),
    ['find', 'role', 'button', 'click', '--name', 'Submit'],
  )
  assert.deepEqual(commands({ find: { by: 'label', value: 'Email', action: 'fill', text: 'a@b.c', exact: true } }), [
    'find',
    'label',
    'Email',
    'fill',
    'a@b.c',
    '--exact',
  ])
  assert.deepEqual(commands({ eval: 'document.title' }), [
    'eval',
    '-b',
    Buffer.from('document.title').toString('base64'),
  ])
  assert.deepEqual(commands({ screenshot: { path: 'shots/a.png', fullPage: true } }), [
    'screenshot',
    '/work/shots/a.png',
    '--full',
  ])
  // A selector captures that element: the CLI takes it before the path, and a full page would replace it.
  assert.deepEqual(commands({ screenshot: { selector: '#main', path: 'shots/a.png' } }), [
    'screenshot',
    '#main',
    '/work/shots/a.png',
  ])
  assert.deepEqual(commands({ screenshot: { selector: '#main', path: 'a.png', fullPage: true } }), [
    'screenshot',
    '#main',
    '/work/a.png',
  ])
  assert.deepEqual(commands({ viewport: [390, 844] }), ['set', 'viewport', '390', '844'])
  assert.deepEqual(commands({ close: true }), ['close'])
})

test('a url opens first, before the call’s own steps, as the built-in browser tool’s does', () => {
  const steps: WebStep[] = [{ click: '@e1' }, { screenshot: { path: 'a.png' } }]
  assert.deepEqual(callSteps('https://example.com', steps), [
    { open: 'https://example.com' },
    { click: '@e1' },
    { screenshot: { path: 'a.png' } },
  ])
  assert.deepEqual(callSteps(undefined, steps), steps)
  // The steps a caller passed are never mutated by the url being put in front of them.
  assert.notEqual(callSteps(undefined, steps), steps)
})

test('maps every wait mode, each with the step’s own limit', () => {
  assert.deepEqual(commands({ wait: { ms: 500 } }), ['wait', '500'])
  assert.deepEqual(commands({ wait: { selector: '#done', state: 'visible' } }), [
    'wait',
    '#done',
    '--state',
    'visible',
    '--timeout',
    '12000',
  ])
  assert.deepEqual(commands({ wait: { text: 'Saved', timeoutMs: 3000 } }), [
    'wait',
    '--text',
    'Saved',
    '--timeout',
    '3000',
  ])
  assert.equal(commands({ wait: { url: '**/dashboard' } })[1], '--url')
  assert.equal(commands({ wait: { load: 'networkidle' } })[1], '--load')
  assert.deepEqual(commands({ wait: { fn: 'window.ready === true' } }), [
    'wait',
    '--fn',
    'window.ready === true',
    '--timeout',
    '12000',
  ])
})

test('refuses a step that does not say what to do', () => {
  assert.throws(() => commands({ wait: {} }), /exactly one of selector, text, url, load, fn or ms/)
  assert.throws(() => commands({ wait: { text: 'a', url: '**/b' } }), /not several/)
  assert.throws(() => commands({ wait: { ms: 500, timeoutMs: 3000 } }), /takes no timeoutMs/)
  assert.throws(() => commands({ find: { by: 'label', value: 'Email', action: 'fill' } }), /needs text/)
  assert.throws(() => commands({ screenshot: { path: 'shots/a.jpg' } }), /must end in \.png/)
})

test('opens this UI with its theme and the init script, and any other page exactly as asked', () => {
  const base = 'http://127.0.0.1:4750'
  const own = commands({ open: '/' }, { base, initScript: '/home/agent-browser/init.js', theme: 'dark' })
  assert.deepEqual(own, [
    'open',
    `${base}/?${THEME_PARAM}=dark`,
    '--init-script',
    '/home/agent-browser/init.js',
  ])
  const conversation = commands(
    { open: '/?conversation=42' },
    { base, initScript: '/home/agent-browser/init.js', theme: 'light' },
  )
  assert.equal(conversation[1], `${base}/?conversation=42&${THEME_PARAM}=light`)
  // Without a theme the page keeps the theme it stores; the init script still detaches it from the shared UI state.
  assert.equal(
    commands({ open: '/' }, { base, initScript: '/home/agent-browser/init.js' })[1],
    `${base}/`,
  )
  assert.deepEqual(
    commands({ open: 'https://example.com' }, { base, initScript: '/home/agent-browser/init.js', theme: 'dark' }),
    ['open', 'https://example.com'],
  )
  // A session may also start on a page that is still being served on another port.
  assert.deepEqual(
    commands({ open: 'http://127.0.0.1:4999/' }, { base, initScript: '/home/agent-browser/init.js' }),
    ['open', 'http://127.0.0.1:4999/'],
  )
})

test('writes the theme into the url, the shot’s own origin, and nothing else', () => {
  const init = themeInitSource()
  assert.match(init, /new URL\(location\.href\)\.searchParams\.get\("ultimate-theme"\)/)
  assert.match(init, /localStorage\.setItem\('ultimate\.theme', theme\)/)
  assert.match(init, /sessionStorage\.setItem\('ultimate\.detached', '1'\)/)
  // A page with no storage (about:blank, an error page) must not stop the page's own scripts.
  assert.match(init, /try \{[\s\S]*\} catch \{/)

  const apply = themeApplySource('dark', 'http://127.0.0.1:4750')
  assert.match(apply, /location\.origin !== "http:\/\/127\.0\.0\.1:4750"/)
  assert.match(apply, /const theme = "dark"/)
  assert.match(apply, /classList\.toggle\('dark', theme === 'dark'\)/)
  // An eval that throws would stop the batch before the screenshot it prepares.
  assert.match(apply, /catch \(error\)/)
})

test('budgets one step by its wait and a call by its steps plus the launch’s slack', () => {
  assert.equal(stepBudget({ click: '@e1' }, 1000), 1000)
  assert.equal(stepBudget({ wait: { ms: 5000 } }, 1000), 5000)
  assert.equal(stepBudget({ wait: { text: 'a', timeoutMs: 7000 } }, 1000), 7000)
  assert.equal(stepBudget({ wait: { text: 'a' } }, 1000), 1000)
  assert.equal(callBudget([{ click: '@e1' }, { wait: { ms: 5000 } }], 1000), 1000 + 5000 + 4000)
})

test('reads a batch’s rows in order, by position when the CLI prints no index', () => {
  const { rows } = parseBatch(
    JSON.stringify([
      { index: 0, success: true, error: null, result: { title: 'A', url: 'https://a/' } },
      { index: 1, success: false, error: 'Element not found: @e9', result: null },
      { success: true, result: { title: 'B' } },
    ]),
  )
  assert.deepEqual(rows, [
    { index: 0, success: true, result: { title: 'A', url: 'https://a/' } },
    { index: 1, success: false, error: 'Element not found: @e9' },
    { index: 2, success: true, result: { title: 'B' } },
  ])
})

test('reads a warning before the array and a batch the CLI refused', () => {
  assert.deepEqual(
    parseBatch('⚠ ignoring a setting\n[{"index":0,"success":true,"result":{"path":"/a.png"}}]').rows,
    [{ index: 0, success: true, result: { path: '/a.png' } }],
  )
  assert.deepEqual(parseBatch(JSON.stringify({ success: false, error: 'Invalid JSON input: EOF' })), {
    rows: [],
    failure: 'Invalid JSON input: EOF',
  })
})

test('refuses output that is not a batch, naming what came instead', () => {
  assert.throws(() => parseBatch(''), /printed nothing/)
  assert.throws(() => parseBatch('not json at all'), /output is not JSON: not json at all/)
  assert.throws(() => parseBatch('{"some":"object"}'), /is not a batch/)
  assert.throws(() => parseBatch('[{"result":{}}]'), /has no outcome at 0/)
})

test('runs any agent-browser command as a raw step, and refuses the flags the tool owns', () => {
  // The command is its own argv: the batch adds this call's --session, --json and budget, nothing else.
  assert.deepEqual(commands({ cli: ['network', 'requests'] }), ['network', 'requests'])
  assert.deepEqual(commands({ cli: ['upload', '#file', 'shots/a.pdf'] }), [
    'upload',
    '#file',
    'shots/a.pdf',
  ])
  assert.deepEqual(commands({ cli: ['cookies', 'get'] }), ['cookies', 'get'])
  for (const flag of ['--session', '--namespace', '--executable-path', '--json']) {
    assert.throws(() => commands({ cli: ['tab', 'list', flag] }), new RegExp(`may not pass ${flag}:`))
    assert.throws(() => commands({ cli: [flag, 'tab', 'list'] }), /may not pass/)
    assert.throws(() => commands({ cli: ['open', 'https://a/', `${flag}=x`] }), /may not pass/)
  }
  assert.throws(() => commands({ cli: [] }), /takes an agent-browser command and its arguments/)
})

test('shows a raw step’s answer under its line and names the command when it fails', () => {
  assert.equal(stepSummary({ cli: ['network', 'requests'] }, { requests: [] }), '')
  // The launch bookkeeping every batch row carries is noise next to the command's own answer.
  assert.equal(
    cliResult({ lifecycle: { launched: true, reused: false }, cookies: [{ name: 'a' }] }),
    JSON.stringify({ cookies: [{ name: 'a' }] }, null, 2),
  )
  assert.equal(cliResult({ lifecycle: { launched: true } }), undefined)
  assert.equal(cliResult(undefined), undefined)
  assert.equal(cliResult({ closed: true, saveStatus: 'not_attempted' }) !== undefined, true)

  assert.equal(
    stepFailure({ cli: ['network', 'requests'] }, 'Unknown command: network'),
    'network requests failed: Unknown command: network',
  )
  assert.equal(stepFailure({ cli: ['tab', 'list'] }), 'tab list failed: failed')
  // A step of its own keeps the CLI's words alone, as its action names it.
  assert.equal(stepFailure({ click: '@e9' }, 'Element not found: @e9'), 'Element not found: @e9')
})

test('summarises what a step returned', () => {
  assert.equal(stepSummary({ open: 'https://a/' }, { title: 'A' }), '"A"')
  assert.equal(stepSummary({ snapshot: {} }, { refs: { e1: {}, e2: {} } }), '2 refs')
  assert.equal(stepSummary({ snapshot: {} }, { refs: {} }), '0 refs')
  assert.equal(stepSummary({ eval: 'x' }, { result: 42 }), '42')
  assert.equal(stepSummary({ eval: 'x' }, {}), 'undefined')
  assert.equal(stepSummary({ wait: { text: 'Saved' } }), 'waited for Saved')
  assert.equal(stepSummary({ wait: { ms: 1500 } }), 'waited 1500 ms')
  assert.equal(stepSummary({ close: true }), 'closed')
})

test('saves a PNG where it was asked to, and never over a name that is not one', () => {
  assert.equal(screenshotFile('/home', '/work', 'shots/a.png'), '/work/shots/a.png')
  assert.match(screenshotFile('/home', '/work'), /^\/home\/screenshots\/\d+-[0-9a-f-]+\.png$/)
  assert.throws(() => screenshotFile('/home', '/work', '/a.jpg'), /must end in \.png/)
})

test('gives every conversation of every project and home its own session', () => {
  const session = sessionName(7, '/h', '/p')
  assert.match(session, /^ultimate-7-[0-9a-f]{8}$/)
  assert.equal(sessionName(7, '/h', '/p'), session)
  assert.notEqual(sessionName(8, '/h', '/p'), session)
  assert.notEqual(sessionName(7, '/h2', '/p'), session)
  assert.notEqual(sessionName(7, '/h', '/p2'), session)
})

test('keeps the socket path short, whatever the home', () => {
  // A unix socket's path is limited to 104 bytes, and a preview's temporary home plus a session name overflows it.
  const socket = (home: string) => `${socketDir(home)}/${sessionName(25763, home, '/Users/a/p')}.sock`
  const preview = '/var/folders/p1/g9nqcw5j4073fkzq3jrq4zcr0000gn/T/ultimate-instance-ciBh65/user'
  assert.ok(socket(preview).length < 104)
  assert.match(socket('/Users/a'), /^\/tmp\/ultimate-ab-[0-9a-f]{8}\//)
  assert.notEqual(socketDir(preview), socketDir('/tmp/another-home'))
})
