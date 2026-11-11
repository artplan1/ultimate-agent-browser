import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { fetchAssets, mapOrigin, sourceFrames } from '../source-frames.ts'

/**
 * esbuild's bundle of `src/lib.ts` and `src/app.ts` and its source map, produced by
 * `esbuild src/app.ts --bundle --sourcemap --format=iife`: real VLQ, two sources, one segment group per line.
 */
const code = [
  '(() => {',
  '  // src/lib.ts',
  '  function boom(name) {',
  '    throw new Error(`kaboom ${name}`);',
  '  }',
  '',
  '  // src/app.ts',
  '  document.querySelector("button")?.addEventListener("click", () => boom("now"));',
  '})();',
  '//# sourceMappingURL=app.js.map',
  '',
].join('\n')

const map = JSON.stringify({
  version: 3,
  sources: ['src/lib.ts', 'src/app.ts'],
  names: [],
  mappings:
    ';;AAAO,WAAS,KAAK,MAAc;AACjC,UAAM,IAAI,MAAM,UAAU,IAAI,EAAE;AAAA,EAClC;;;ACDA,WAAS,cAAc,QAAQ,GAAG,iBAAiB,SAAS,MAAM,KAAK,KAAK,CAAC;',
})

const script = 'http://host/assets/app.js'

test('names the source position of a bundled frame, as dev tools show it', async () => {
  const read = async (url: string) => (url.endsWith('app.js.map') ? map : code)
  assert.equal(
    await sourceFrames(`Error: kaboom now\n    at boom (${script}:4:11)`, read),
    'Error: kaboom now\n    at boom (src/lib.ts:2:9)',
  )
  // The second source of the same map, and a frame without parentheses.
  assert.equal(await sourceFrames(`    at ${script}:8:70`, read), '    at src/app.ts:2:67')
  // Text with no frame at all is returned as it is.
  assert.equal(await sourceFrames('Error: plain', read), 'Error: plain')
})

test('reads a script and its map once, whatever the frames that name it', async () => {
  const reads: string[] = []
  const read = async (url: string) => {
    reads.push(url)
    return url.endsWith('app.js.map') ? map : code
  }
  const text = [`${script}:4:11`, `${script}:8:70`, `${script}:4:11`].join('\n')
  const mapped = await sourceFrames(text, read)
  assert.match(mapped, /src\/lib\.ts:2:9/)
  assert.deepEqual(reads, [script, `${script}.map`])
})

test('leaves a frame alone when its script or map cannot be read, or the map is no map', async () => {
  const unreachable = `    at boom (${script}:4:11)`
  assert.equal(await sourceFrames(unreachable, async () => undefined), unreachable)
  // A SPA fallback serves its HTML shell for a missing map with a 200: the frame stays, and so does every other.
  const html = async (url: string) => (url.endsWith('.map') ? '<!doctype html><html></html>' : code)
  assert.equal(await sourceFrames(unreachable, html), unreachable)
  const truncated = async (url: string) => (url.endsWith('.map') ? '{"sources":[' : code)
  assert.equal(await sourceFrames(unreachable, truncated), unreachable)
})

test('fetches only bundle assets, and asks the page’s own origin for them', async () => {
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(request.url ?? '')
    if (request.url === '/assets/a.js.map') return response.end('{"version":3}')
    response.statusCode = 404
    response.end('no')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const read = fetchAssets(origin)
    assert.equal(await read(`${origin}/assets/a.js.map`), '{"version":3}')
    // A frame can name any host: only its path is used, against the origin the page was served from.
    assert.equal(await read('http://elsewhere.invalid/assets/a.js.map'), '{"version":3}')
    assert.deepEqual(asked, ['/assets/a.js.map', '/assets/a.js.map'])
    // Anything outside /assets/ is never requested, and a 404 reads as no text.
    assert.equal(await read(`${origin}/index.html`), undefined)
    assert.equal(await read(`${origin}/assets/missing.map`), undefined)
    assert.deepEqual(asked, ['/assets/a.js.map', '/assets/a.js.map', '/assets/missing.map'])
    assert.equal(await read('not a url'), undefined)
  } finally {
    await new Promise((close) => server.close(close))
  }
})

test('maps errors only for a page of this host or of this machine', () => {
  const self = 'http://127.0.0.1:4750'
  assert.equal(mapOrigin('http://127.0.0.1:4750/?conversation=42', self), self)
  // A preview, and a project's dev server, are this machine's own: they map too.
  assert.equal(mapOrigin('http://127.0.0.1:4999/', self), 'http://127.0.0.1:4999')
  assert.equal(mapOrigin('http://localhost:5173/', self), 'http://localhost:5173')
  // A site the tool was pointed at keeps its bundle positions, and so does a page with no URL.
  assert.equal(mapOrigin('https://example.com/assets/a.js', self), undefined)
  assert.equal(mapOrigin('about:blank', self), undefined)
  assert.equal(mapOrigin(undefined, self), undefined)
})
