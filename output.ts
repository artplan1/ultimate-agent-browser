/** A call's result text, as the card reads it: what the steps, the screenshot and the errors say. */
export type ParsedOutput = {
  title?: string
  url?: string
  png?: string
  /** One entry per console and page error, each with the stack frames the result indented under it. */
  errors: string[]
  /** Outcomes by the step's number: `OK …`, or why it failed. */
  steps: Map<number, string>
  /** Lines the card does not render of their own accord: a note, a retired daemon, the snapshot's tree. */
  other: string[]
}

/**
 * `Title: …`, `URL: …`, `PNG: …`, then outcomes (`Step n: OK …`, a failed `Step n: …`, `Console error: …`), and after
 * them the errors with their frames (`    at …`), which belong to the error above them.
 */
export function parseOutput(output: string): ParsedOutput {
  const lines = output.split('\n').filter(Boolean)
  const value = (prefix: string) =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length)
  const errors: string[] = []
  const steps = new Map<number, string>()
  const other: string[] = []
  for (const line of lines) {
    const step = /^Step (\d+): (.*)$/.exec(line)
    if (step) steps.set(Number(step[1]), step[2])
    else if (/^(Console|Page) error: /.test(line)) errors.push(line)
    else if (errors.length > 0 && /^ {4}at /.test(line)) errors[errors.length - 1] += `\n${line}`
    else if (!/^(Title|URL|PNG): /.test(line)) other.push(line)
  }
  return { title: value('Title: '), url: value('URL: '), png: value('PNG: '), errors, steps, other }
}
