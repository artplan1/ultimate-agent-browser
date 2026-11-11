import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImage,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { cn, defineWebExtension, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { parseOutput } from './output.ts'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

type Step = Record<string, unknown>

/** The steps a call ran, in the order its output numbers them: a `url` opens before its own steps. */
function stepsOf(call: ToolCallView) {
  const steps = Array.isArray(call.args.steps) ? (call.args.steps as Step[]) : []
  const url = text(call.args.url)
  return url ? [{ open: url }, ...steps] : steps
}

/** The page a call is about: its `url`, the first `open` step's, else this UI. */
function target(call: ToolCallView) {
  return stepsOf(call).map((step) => text(step.open)).find(Boolean) || 'this UI'
}

function Errors({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null
  return (
    <ToolSection label={`${errors.length} error${errors.length === 1 ? '' : 's'} while loading`}>
      {errors.map((error, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Loading errors are log lines and may repeat.
        <div className="break-words whitespace-pre-wrap text-error" key={index}>
          {error}
        </div>
      ))}
    </ToolSection>
  )
}

/** The screenshot as a thumbnail that opens full size, beside the page title and the PNG's path. */
function Shot({ call, parsed }: { call: ToolCallView; parsed: ReturnType<typeof parseOutput> }) {
  const image = call.images[0]
  if (!image && !parsed.title && !parsed.png) return null
  return (
    <ToolSection className="flex gap-3">
      {image && <ToolImage alt={parsed.title ?? 'Screenshot'} className="shrink-0" image={image} />}
      <div className="flex min-w-0 flex-col gap-0.5 text-[11.5px]">
        {parsed.title !== undefined && (
          <span className="truncate text-foreground/90" title={parsed.title}>
            {parsed.title || 'untitled'}
          </span>
        )}
        {parsed.png && (
          <span className="truncate text-muted-foreground/70" title={parsed.png}>
            {parsed.png}
          </span>
        )}
      </div>
    </ToolSection>
  )
}

/** A step's action and its argument: the first field that is not a modifier. */
function describe(step: Step) {
  const entries = Object.entries(step).filter(
    ([key]) => !['timeoutMs', 'fullPage', 'state'].includes(key),
  )
  const [action, value] = entries[0] ?? ['?', '']
  if (action === 'snapshot' && value && typeof value === 'object') return { action, shown: '' }
  const shown = Array.isArray(value)
    ? value.map((item) => JSON.stringify(item)).join(' ← ')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
  return { action, shown }
}

/** The steps: an outcome each, ✓, ✗ with the error, or the value a step returned. */
function Steps({
  steps,
  parsed,
  status,
}: {
  steps: readonly Step[]
  parsed: ReturnType<typeof parseOutput>
  status: ToolCallView['status']
}) {
  if (steps.length === 0) return null
  const finished = status === 'done' || status === 'error'
  return (
    <ToolSection label="Steps">
      {steps.map((step, index) => {
        const number = index + 1
        const outcome = finished ? parsed.steps.get(number) : undefined
        const state = !outcome ? 'skipped' : outcome.startsWith('OK') ? 'ok' : 'failed'
        const { action, shown } = describe(step)
        const value = outcome?.startsWith('OK ') ? outcome.slice(3) : undefined
        return (
          // oxlint-disable-next-line react/no-array-index-key -- Steps and outcomes are addressed by position.
          <div className="flex min-w-0 items-start gap-2 leading-[1.7]" key={index}>
            <span
              className={cn(
                'w-3 shrink-0 text-center',
                state === 'ok'
                  ? 'text-success'
                  : state === 'failed'
                    ? 'text-error'
                    : 'text-muted-foreground/50',
              )}
            >
              {state === 'ok' ? '✓' : state === 'failed' ? '✗' : '·'}
            </span>
            <span className="w-14 shrink-0 text-foreground/90">{action}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-muted-foreground" title={shown}>
                {shown}
              </span>
              {value && (
                <span className="block truncate text-foreground/80" title={value}>
                  → {value}
                </span>
              )}
              {state === 'failed' && outcome && (
                <span className="block break-words text-error">{outcome}</span>
              )}
            </span>
          </div>
        )
      })}
    </ToolSection>
  )
}

function Browse({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const parsed = parseOutput(call.output)
  const steps = stepsOf(call)
  const failed = call.status === 'error'
  const theme = text(call.args.theme)
  const viewport = steps
    .map((step) => (Array.isArray(step.viewport) ? (step.viewport as number[]) : undefined))
    .filter(Boolean)
    .at(-1)
  return (
    <Tool defaultOpen>
      <ToolHeader
        meta={
          <>
            {parsed.errors.length > 0 && (
              <span className="text-error">
                {parsed.errors.length} error{parsed.errors.length === 1 ? '' : 's'}
              </span>
            )}
            <span>
              {steps.length} step{steps.length === 1 ? '' : 's'}
            </span>
            {viewport && <span>{`${viewport[0]}×${viewport[1]}`}</span>}
            {theme && <span>{theme}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="browser"
        state={call.status}
        title={parsed.title || target(call)}
      />
      <ToolContent>
        <Steps parsed={parsed} status={call.status} steps={steps} />
        <Shot call={call} parsed={parsed} />
        <Errors errors={parsed.errors} />
        {failed && (
          <ToolOutput isError output={[...parsed.other, ...parsed.steps.values()].join('\n')} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { browser: Browse } })
