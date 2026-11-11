import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOutput } from '../output.ts'

test('reads the title, the url and the screenshot out of a result', () => {
  const parsed = parseOutput(
    [
      'Title: Ultimate',
      'URL: http://127.0.0.1:4750/?conversation=42',
      'PNG: /home/screenshots/a.png',
      'Step 1: OK "Ultimate"',
      'Step 2: OK 2 refs',
      'Step 3: failed to click @e9',
      '',
      'Snapshot (step 2, 2 refs):',
      '- button [@e1] Submit',
    ].join('\n'),
  )
  assert.equal(parsed.title, 'Ultimate')
  assert.equal(parsed.url, 'http://127.0.0.1:4750/?conversation=42')
  assert.equal(parsed.png, '/home/screenshots/a.png')
  assert.deepEqual([...parsed.steps], [
    [1, 'OK "Ultimate"'],
    [2, 'OK 2 refs'],
    [3, 'failed to click @e9'],
  ])
  // The snapshot is not a step and not an error: the card shows it with the output, not on its own.
  assert.deepEqual(parsed.other, ['Snapshot (step 2, 2 refs):', '- button [@e1] Submit'])
  assert.deepEqual(parsed.errors, [])
})

test('keeps an error’s stack frames with it, mapped or not', () => {
  const parsed = parseOutput(
    [
      'Step 1: OK',
      'Page error: Error: kaboom',
      '    at boom (/repo/web/src/app/a.tsx:12:5)',
      '    at /repo/web/src/lib/b.ts:3:1',
      'Console error: bad thing Error: inner',
      '    at http://127.0.0.1:4750/assets/index-x.js:1:1759',
    ].join('\n'),
  )
  assert.deepEqual(parsed.errors, [
    'Page error: Error: kaboom\n    at boom (/repo/web/src/app/a.tsx:12:5)\n    at /repo/web/src/lib/b.ts:3:1',
    'Console error: bad thing Error: inner\n    at http://127.0.0.1:4750/assets/index-x.js:1:1759',
  ])
  // Frames never reach the rest of the output, and neither do the prefixed lines they follow.
  assert.deepEqual(parsed.other, [])
})
