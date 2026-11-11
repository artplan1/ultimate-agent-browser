/**
 * Source maps for the frames in an error's stack: `http://host/assets/web-x.js:1:1759` becomes the source position its
 * script's map names (`/repo/web/src/app/a.tsx:56:25`), as dev tools show it. Adapted from Ultimate's
 * `lib/source-frames.ts` (MIT); this extension decodes the map itself, so it keeps depending on no package.
 */

/**
 * `text` with every bundled frame (`http://host/assets/web-x.js:1:1759`) replaced by the source position its script's
 * source map names (`/repo/extensions/a/web.tsx:56:25`), as dev tools show it. `read` reads a URL, or gives
 * undefined; frames without a map stay as they are.
 */
export async function sourceFrames(
  text: string,
  read: (url: string) => Promise<string | undefined>,
  maps = new Map<string, Promise<SourceMap | undefined>>(),
) {
  const load = (script: string) => {
    let map = maps.get(script)
    if (!map) {
      map = read(script).then(async (code) => {
        const url = code && /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)?.[1]
        const json = url && (await read(new URL(url, script).href))
        return json === undefined ? undefined : decodeMap(json)
      })
      maps.set(script, map)
    }
    return map
  }
  const found = [...text.matchAll(frame)]
  const resolved = await Promise.all(
    found.map(async ([, script, line, column]) => {
      const map = await load(script)
      // A frame's column is 1-based, a map's is not.
      const position = map && originalPositionFor(map, Number(line), Number(column) - 1)
      return position && `${position.source}:${position.line}:${position.column + 1}`
    }),
  )
  let at = 0
  return found
    .map((match, index) => {
      const before = text.slice(at, match.index)
      at = match.index + match[0].length
      return before + (resolved[index] ?? match[0])
    })
    .join('')
    .concat(text.slice(at))
}

/**
 * A `read` for `sourceFrames` that fetches only `origin`'s bundle assets. Error text comes from a page, which can name
 * any URL, so a frame's `/assets/…` path is requested from `origin` and its host is ignored: a page served through
 * `localhost`, Tailscale or another alias still maps, and nothing else is ever fetched. A malformed or slow request
 * reads as no text, and the frame stays as it is.
 */
export function fetchAssets(origin: string) {
  return async (url: string) => {
    try {
      const target = new URL(url)
      if (!target.pathname.startsWith('/assets/')) return undefined
      const response = await fetch(new URL(target.pathname + target.search, origin), {
        signal: AbortSignal.timeout(5000),
      })
      return response.ok ? await response.text() : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * The origin whose source maps may be read for a page, or undefined when the page is not ours. Only this host's own UI
 * and this machine's loopback (a preview, the dev server of a project) are read: a site the tool was pointed at keeps
 * the bundle positions of its errors, and its errors can name any URL.
 */
export function mapOrigin(page: string | undefined, self: string) {
  try {
    if (page === undefined) return undefined
    const url = new URL(page)
    if (url.origin === new URL(self).origin) return url.origin
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.origin : undefined
  } catch {
    // No page (about:blank) or a URL no page can have.
    return undefined
  }
}

/** `http://…/a.js:1:2` in a stack frame: the script's URL, line and column. */
const frame = /(https?:\/\/[^\s()]+?\.m?js):(\d+):(\d+)/g

/** The base64 alphabet a mapping's numbers are written in. */
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const digits = new Map([...alphabet].map((char, value) => [char, value]))

/** One source map, decoded: `sources` as a position names them, and per generated line its segments. */
type SourceMap = {
  sources: string[]
  /** Per generated line, a `[column, source, line, column]` quadruple per segment, in column order. */
  lines: number[][]
}

/** The numbers one mapping segment encodes: base64 VLQ, each a delta from the same field of the segment before it. */
function segmentValues(segment: string) {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = digits.get(char)
    if (digit === undefined) throw new Error(`A source map's mapping is not base64 VLQ: ${segment}`)
    // Bits below 32 are the value, bit 32 says another digit follows; the lowest bit of the value is its sign.
    value += (digit & 31) * 2 ** shift
    if (digit & 32) {
      shift += 5
      continue
    }
    const magnitude = Math.floor(value / 2)
    values.push(value % 2 === 1 ? -magnitude : magnitude)
    value = 0
    shift = 0
  }
  return values
}

/**
 * A source map's text, decoded, or undefined when it is not one: a SPA fallback can serve HTML as the map with a 200,
 * and caching that rejection would drop every frame of the script.
 */
function decodeMap(text: string): SourceMap | undefined {
  let value: { mappings?: unknown; sources?: unknown; sourceRoot?: unknown }
  try {
    value = JSON.parse(text) as typeof value
  } catch {
    return undefined
  }
  const { mappings, sources, sourceRoot } = value
  if (typeof mappings !== 'string' || !Array.isArray(sources)) return undefined
  const root = typeof sourceRoot === 'string' ? sourceRoot : ''
  // A sourceRoot prefixes a source that is relative; a bundled source that is already absolute is left as it is.
  const resolve = (source: string) =>
    !root || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(source)
      ? source
      : `${root.replace(/\/+$/, '')}/${source}`
  const lines: number[][] = []
  let source = 0
  let line = 0
  let column = 0
  for (const group of mappings.split(';')) {
    const segments: number[] = []
    let generated = 0
    for (const segment of group.split(',')) {
      if (!segment) continue
      const fields = segmentValues(segment)
      generated += fields[0]
      // A segment of one number only advances the generated column: it maps nothing.
      if (fields.length === 1) {
        segments.push(generated, -1, 0, 0)
        continue
      }
      source += fields[1]
      line += fields[2]
      column += fields[3]
      segments.push(generated, source, line, column)
    }
    lines.push(segments)
  }
  return {
    sources: sources.map((item) => (typeof item === 'string' ? resolve(item) : '')),
    lines,
  }
}

/** Where generated `line` (1-based) at `column` (0-based) came from, when the map says. */
function originalPositionFor(map: SourceMap, line: number, column: number) {
  const segments = map.lines[line - 1]
  if (!segments) return undefined
  // The last segment that starts at or before the column is the one it came from.
  let found: number[] | undefined
  for (let at = 0; at + 3 < segments.length; at += 4) {
    if (segments[at] > column) break
    found = segments.slice(at, at + 4)
  }
  if (!found || found[1] < 0) return undefined
  const source = map.sources[found[1]]
  return source === undefined ? undefined : { source, line: found[2] + 1, column: found[3] }
}
