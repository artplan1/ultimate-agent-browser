Drive a real Chrome through the [agent-browser](https://www.npmjs.com/package/agent-browser) CLI, from one browser
that stays open per conversation. An Ultimate extension: it provides the `browser` tool and its card, and depends on no
Ultimate checkout. Install the CLI once: `npm install -g agent-browser@0.41.2` (it ships its own Chrome).

## One `browser` tool per project

This extension **replaces** Ultimate's built-in `browser`, which owns the same tool name: a project enables exactly one
of the two.

- Where the built-in is disabled — `"extensions": { "disable": ["browser"] }` — this extension's `browser` is the one an
  agent gets.
- Where this extension is disabled, the built-in works exactly as before. Both enabled at once is a broken layout: two
  extensions of the same layer exporting one tool name make the host refuse the later one, with its whole facet.
- Ultimate itself keeps the built-in: only it knows `window.ultimate`, `send` and `until` (submit a prompt without the
  composer, wait on Ultimate's own state), and `?conversation=` as a fresh page per call.

The name is the tool name an agent already knows, and this extension takes the same shape — `url`, steps, `screenshot`,
`viewport`, `close` — so a habit carries over. What it adds is a browser that stays open: cookies, tabs and logins
survive between calls, so sign in once and keep working, and `@e1`-style refs from a snapshot stay usable in the next
call until the page changes.

There is no separate `screenshot` tool here: a screenshot is a **step** inside `browser`
(`{"screenshot": {"path": "shot.png"}}`), with the `viewport` step setting the size and the call's `theme` setting the
color scheme. One tool is the whole extension.

## Install

Requires [Ultimate](https://github.com/HazAT/ultimate), Node 26+, and the `agent-browser` CLI on the Ultimate server's
PATH (`npm install -g agent-browser@0.41.2`, or `ULTIMATE_AGENT_BROWSER` naming another binary). Not verified on
Windows: process-group cancellation assumes a Unix-like host.

```bash
git clone <this repository> ultimate-agent-browser
cd ultimate-agent-browser
npm run check
npm test
npm run install:local
```

No `npm install` is needed: Ultimate supplies the runtime Pi packages and the web SDK. `install:local` creates
`~/.ultimate/extensions/agent-browser` as a symlink to this checkout, is repeatable for the same checkout, and refuses to
replace an existing extension. The same link by hand is `ln -s "$PWD" ~/.ultimate/extensions/agent-browser`. Keep the
checkout at its installed path. A reload of the extension, like any of its files changing, is a reload of the host's
facet; a host restart is never needed to see a new extension, only for core changes.

For one project instead, place or symlink this folder at `<project>/.ultimate/extensions/agent-browser/` and disable the
built-in there. A project's same-named folder overrides the global one entirely. This extension adds no agent overlay:
`browser` is simply one more tool.

## Using `browser`

One call is a batch of steps, run in order in the conversation's browser, stopping at the first failure. `url` loads a
page before the steps; a relative one resolves against this UI. The loop is the one agent-browser documents: load a page,
`snapshot` it for an accessibility tree with `@e1`-style refs, then `click`, `fill` or `press` a ref. Refs stay valid
while the elements do, so snapshot again after navigating.

Steps: `open`, `snapshot` (`interactive` by default, plus `scope`, `depth`, `compact`), `click`, `fill` `[ref, text]`,
`press`, `find` (`by`/`value`/`action`, optional `text`, `name`, `exact` — a semantic locator when there is no ref),
`wait` (exactly one of `selector`, `text`, `url`, `load`, `fn` or `ms`), `eval`, `screenshot` (`path`, `fullPage`),
`viewport` `[width, height]`, and `close` (ends the session, logins included).

A call returns the page title and URL, a line per step with what it returned, the PNG's path, the console and page
errors the call provoked, and the last snapshot's tree for the refs it refers to. It ends with a screenshot unless
`screenshot: false`; `path` names where that PNG goes (it must end in `.png` and resolves against the conversation's
cwd; without it the PNG goes to `$ULTIMATE_HOME/screenshots`).

A UI at phone width, in both themes:

```json
{
  "url": "/",
  "theme": "dark",
  "screenshot": false,
  "steps": [
    { "viewport": [390, 844] },
    { "wait": { "load": "networkidle", "timeoutMs": 20000 } },
    { "screenshot": { "path": "phone-dark.png" } }
  ]
}
```

The viewport belongs to the session, not to the call: a call that must capture at a size sets it, or it captures at the
size an earlier call left. `theme` emulates the color scheme for other pages; for a page on this host's own origin it
sets the UI's own theme instead — its stored `ultimate.theme` and `dark` class — through an init script and again right
before the shot, because the UI writes its stored preference back on every change. Such a page is detached from the
shared durable UI state, so its clicks never move the user's tabs.

Nothing can hang. agent-browser 0.41.2 has no per-command deadline, so each call runs the CLI as its own process group
(`process-group.ts`) with a budget of one `timeoutMs` (30 s by default) per step plus four for launching a daemon and
Chrome, and a wait step's own limit for its wait. A call that outlives it is stopped. When the session's daemon is the
wedge, a short `session info` probe decides: one that answers was only slow and is left alone; one that does not is
stopped with the browser it started, so the next call starts a fresh one instead of hanging again. Runs record their pid
files under `$ULTIMATE_HOME/agent-browser`, which the extension sweeps on open.

The daemon's socket directory is `/tmp/ultimate-ab-<8 hex of the home>`: a unix socket's path is limited to 104 bytes and
the CLI's default under the home overflows it in a preview, whose home is a long temporary path. The home decides the
name, so two Ultimates never share a directory, and a directory still holding a daemon's pid file is never removed.

**Who closes the browser.** A daemon and its Chrome are not children of Ultimate: they outlive a call, a page reload and
a stopped preview. So the extension ends them itself.

- A `close` step ends the session. A call that closes a browser appends no reads of its own (no title, url, console or
  final screenshot): each of those would open a fresh browser to answer. Then the CLI's daemon exits with it.
- When the host closes, every session this host drove is closed the same way, under the same budget.
- A daemon that does not answer, or that `close` left running, is stopped by the pid it recorded, and so are the process
  groups its Chrome runs in — a browser started by a daemon has groups of its own, and stopping the daemon alone would
  leave a headless Chrome behind under a new parent. That fallback is what a wedged daemon gets.
- Its socket directory is removed once no daemon is recorded in it.

A host restart — or a reload of this extension, which the host runs on each of its files changing — therefore ends the
sessions and their logins; within one host's lifetime, cookies and logins persist between calls. A daemon that nothing
drives any more also shuts itself down after an hour idle (the CLI's own timeout).

## Settings

Enabled by default as a user extension; `"extensions": { "disable": ["agent-browser"] }` turns it off, live. Disable the
built-in `browser` wherever this one is on.

## Checks

From this directory:

```bash
npm run check
npm test
```

`check` parses every module. `test` covers the step-to-command mapping (including this UI's theme, init script and the
`url` that opens first), the budget arithmetic, batch parsing, session naming and socket paths, screenshots' paths, and
local installation. Neither type-checks the web SDK nor starts a browser: a real `browser` call and the rendered card
must be checked on a running host.

## License and attribution

MIT; see [LICENSE](LICENSE). `process-group.ts` is adapted from Ultimate's `lib/process-group.ts`. This is an independent
extension, not an Ultimate product.
