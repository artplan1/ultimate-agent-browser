Drive a real Chrome through the [agent-browser](https://www.npmjs.com/package/agent-browser) CLI, from one browser
that stays open per conversation. An Ultimate extension: it provides the `browser` tool and its card, and depends on no
Ultimate checkout.

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
`viewport`, `close` — so a habit carries over; what it adds is that `@e1`-style refs from a snapshot stay usable in the
next call until the page changes.

There is no separate `screenshot` tool here: a screenshot is a **step** inside `browser`, with the `viewport` step
setting the size and the call's `theme` setting the color scheme. One tool is the whole extension.

### Which browser to reach for

| | built-in `browser` + `screenshot` | this extension |
| --- | --- | --- |
| browser between calls | a fresh isolated page per call | one session per conversation: cookies, tabs and logins persist |
| what a step addresses | a Playwright locator: CSS, or `text=`/`role=` syntax | an accessibility-tree ref (`@e1`) from `snapshot`, a CSS selector, or `find` by role, label, text, placeholder, testid, alt or title |
| snapshot of the page | — | `snapshot`: the tree with refs, `scope`/`depth`/`compact` |
| one element | `screenshot`'s `selector` | the `screenshot` step's `selector` |
| full page | `screenshot`'s `fullPage` | the `screenshot` step's `fullPage` |
| viewport | `screenshot`'s `width`/`height`, per shot | the `viewport` step, for the session |
| waiting | `wait: <ms>` or `wait: <selector>` | `wait` for a selector (with `state`), text, url glob, `load` (`networkidle`), a JS predicate or ms |
| several steps | one at a time, each reported as it runs | one batch, stopping at the first failure |
| drive Ultimate itself | `send`/`until` on any Ultimate page, and `?conversation=` as a fresh page per call | a page's own URL only; no `send` or `until` |
| console and page errors | returned, frames named by their source map | returned, frames named by their source map for a page of this host or of this machine |
| tools it adds | `browser` and `screenshot` | `browser` only |

Neither has a step for tabs and windows, network inspection, file upload, cookies and storage, PDF and video, device
emulation, or frames and dialogs: those are the agent-browser CLI's own commands, which this extension does not expose.

Switch per project in `settings.json`: `"extensions": { "disable": ["browser"] }` for this one, `["agent-browser"]`
for the built-in (see [Settings](#settings)).

An agent definition that lists its tools explicitly keeps only those: Ultimate's own `@ultimate` does, so it never sees
any browser tool until a project adds one with an overlay (`.ultimate/agents/ultimate.md` with `addTools: [browser]`).
Coordinators, workers and branches inherit the host's tools and need nothing.

## Install

Requires [Ultimate](https://github.com/HazAT/ultimate), Node 26+, and the `agent-browser` CLI on the Ultimate server's
PATH (`npm install -g agent-browser@0.41.2`, or `ULTIMATE_AGENT_BROWSER` naming another binary). macOS and Linux only:
it runs the CLI under `/bin/sh` and reads the process table with `/bin/ps`.

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
`wait` (exactly one of `selector` with `state`, `text`, `url`, `load`, `fn` or `ms`, plus `timeoutMs`; `load` is
`load`, `domcontentloaded` or `networkidle`), `eval`, `screenshot` (`path`, `selector`, `fullPage`), `viewport`
`[width, height]`, and `close` (ends the session, logins included).

**Every step is an object, and `snapshot` and `wait` describe *how*, so each takes an object even when it is empty.**
This is where habits from Ultimate's built-in `browser` tool break: `{"snapshot": true}` and `{"wait": {"load": true}}`
are rejected (`expected object, got boolean` / `expected string, got boolean`). The forms are:

```json
{ "snapshot": {} }
{ "snapshot": { "scope": "#main", "depth": 3, "compact": true, "interactive": false } }
{ "wait": { "load": "networkidle" } }
{ "wait": { "selector": "#done", "state": "visible", "timeoutMs": 20000 } }
```

**A page that mounts after load.** `{ "snapshot": {} }` straight after `open` can legitimately return 0 refs: a
Next-style app hydrates after the page's `load` event, so the accessibility tree is still empty. Wait for the network to
settle before the first snapshot:

```json
{ "steps": [{ "wait": { "load": "networkidle" } }, { "snapshot": {} }] }
```

A call returns the page title and URL, a line per step with what it returned, the PNG's path, the console and page
errors the call provoked, and the last snapshot's tree for the refs it refers to. It ends with a screenshot unless
`screenshot: false` or a `close` step leaves no page to capture; `path` names where that PNG goes (it must end in `.png`
and resolves against the conversation's cwd; without it the PNG goes to `$ULTIMATE_HOME/screenshots`). A `screenshot`
step with a `selector` captures that one element, and `fullPage` does not apply to it.

Errors keep their stack, and on a page of this host or of this machine (a preview, a project's dev server) every frame
is named by the source position its script's source map gives (`web/src/app/a.tsx:56:25`), as dev tools show it. A site
the tool was pointed at keeps the bundle positions of its frames: an error's text can name any URL, so only this host's
own assets are ever read for a map.

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

**Upgrading the CLI.** A session's daemon is a process of its own, and the CLI reuses it after the binary is upgraded: a
daemon started by 0.38.2 answers 0.41.2's `batch --omit-command` with `Unknown command: --omit-command`, so every call
of that session fails and `close` is the only way out. So before each batch the extension compares the version a
session's daemon recorded (`<socket dir>/<session>.version`) with the binary's own (`agent-browser --version`) and, when
they differ, stops that daemon with its browser first — one attempt, no retries — and says what happened in the result
as a `Note: …` line. The steps then run in a fresh browser, and logins from the old one are gone. A daemon that recorded
no version was started by a CLI older than that file, so it is just as stale and is retired the same way; a daemon whose
version cannot be compared (the binary does not answer `--version`) is left alone.

**Who closes the browser.** A daemon and its Chrome are not children of Ultimate: they outlive a call, a page reload and
a stopped preview. So the extension ends them itself.

- A `close` step ends the session. A call that closes a browser appends no reads of its own (no title, url, console or
  final screenshot): each of those would open a fresh browser to answer. Then the CLI's daemon exits with it.
- When the host closes, every session this host drove is closed the same way, under the same budget.
- A daemon that does not answer, or that `close` left running, is stopped by the pid it recorded, together with the
  process groups its Chrome runs in: a browser started by a daemon has groups of its own, so stopping the daemon alone
  would leave a headless Chrome behind under a new parent.
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

`check` parses every module. `test` covers the step-to-command mapping (including this UI's theme, init script, the
`url` that opens first and a screenshot of one element), the budget arithmetic, batch parsing, session naming and
socket paths, screenshots' paths, source maps of stack frames and the origins they are read from, the card's reading of
a result, retiring a daemon another CLI version started, and local installation. Neither type-checks nor builds the web
facet: a real `browser` call and the rendered card must be checked on a running host.

## License and attribution

MIT; see [LICENSE](LICENSE). `process-group.ts` and `source-frames.ts` are adapted from Ultimate's `lib/`. This is an
independent extension, not an Ultimate product.
