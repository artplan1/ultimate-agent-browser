import {
  arr,
  bool,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Annotations,
  type Schema,
  type Static,
} from '@earendil-works/pi-schema'

/**
 * One of the given strings, declared with `type: 'string'`. pi-schema's `oneOf()` emits a bare `{ enum }`, which is
 * valid JSON Schema, but Moonshot (Kimi) rejects the whole request with "type is not defined".
 */
export function strEnum<const V extends readonly string[]>(
  values: V,
  options?: Annotations<V[number]>,
): Schema<V[number]> {
  return { ...oneOf(values, options), type: 'string' }
}

const findBy = strEnum(
  ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last'],
  {
    description:
      'How to find the element when there is no snapshot ref. `first` and `last` take a CSS selector.',
  },
)
const findAction = strEnum([
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'hover',
  'focus',
  'check',
  'uncheck',
  'select',
])
const waitState = strEnum(['visible', 'hidden', 'attached', 'detached'])
const loadState = strEnum(['load', 'domcontentloaded', 'networkidle'])

/** One step of a `browse` call, as the tool offers it. */
export const webStep = union([
  obj({
    open: str({
      description:
        'Page to load: https://, http://, file://, data:, or a host that gets https://. A relative URL resolves against this UI.',
    }),
  }),
  obj({
    snapshot: obj({
      interactive: opt(bool({ description: 'Only elements you can act on; default true.' })),
      compact: opt(bool({ description: 'Drop empty structural nodes.' })),
      depth: opt(int({ minimum: 1, description: 'Limit the tree to this depth.' })),
      scope: opt(str({ description: 'CSS selector to snapshot one part of the page.' })),
    }),
  }),
  obj({
    click: str({ description: 'Ref from the last snapshot, such as @e3, or a CSS selector.' }),
  }),
  obj({
    fill: arr(str(), { minItems: 2, maxItems: 2, description: '[ref or selector, text]' }),
  }),
  obj({ press: str({ description: 'Key at the focus: Enter, Tab, Control+a.' }) }),
  obj({
    find: obj({
      by: findBy,
      value: str(),
      action: findAction,
      text: opt(str({ description: 'What fill, type, press or select types or picks.' })),
      name: opt(str({ description: 'Accessible name to match for `role`, such as "Submit".' })),
      exact: opt(bool({ description: 'Match text exactly.' })),
    }),
  }),
  obj({
    wait: obj({
      selector: opt(str()),
      state: opt(waitState),
      text: opt(str()),
      url: opt(str({ description: 'Glob, such as **/dashboard.' })),
      load: opt(loadState),
      fn: opt(str({ description: 'JavaScript expression that becomes true.' })),
      ms: opt(int({ minimum: 0, description: 'Wait this long.' })),
      timeoutMs: opt(
        int({ minimum: 1, description: 'Give up after this long; default timeoutMs.' }),
      ),
    }),
  }),
  obj({ eval: str({ description: 'JavaScript in the page; its value is returned.' }) }),
  obj({
    screenshot: obj({
      path: opt(
        str({
          description:
            'Where to save the PNG, relative to your cwd; default: a new file in the home.',
        }),
      ),
      fullPage: opt(bool()),
    }),
  }),
  obj({
    viewport: arr(int({ minimum: 1 }), {
      minItems: 2,
      maxItems: 2,
      description: '[width, height]',
    }),
  }),
  obj({
    close: lit(true, { description: 'Close the browser and drop its state, logins included.' }),
  }),
])

export type WebStep = Static<typeof webStep>
