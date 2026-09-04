import { useEffect, useRef } from 'react'
import { MarkdownRenderer } from './markdown-renderer'
import { toolLabel } from '../message-grouping'
import { toolCallIconFor } from './tool-call-icon'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { Brain, Loader2 } from 'lucide-react'
import { PixelLoader } from './pixel-loader'
import { clsx } from 'clsx'

/**
 * How close to the bottom counts as "still following" when the reader stops
 * scrolling. Generous, because the tail keeps moving underneath them.
 */
const THINKING_TAIL_THRESHOLD_PX = 24

interface StreamingBubbleProps {
  content: string
  thinking: string
  toolCalls: Map<
    string,
    {
      name: string
      args: string
      result?: string
      isExecuting: boolean
      isError?: boolean
      startedAt?: number
      durationMs?: number
    }
  >
}

/**
 * What the wait is, and roughly how long it has left.
 *
 * The estimate is the machine's own measured prefill rate (see prefillRate in
 * the store), not a constant — this box has run at both 28 and 1,437 tokens/sec
 * depending on what else held the GPU, so any hardcoded number would be wrong
 * most of the time. With no measurement yet it says the size and no ETA rather
 * than inventing one.
 */
function describeWait(
  piStatus: string,
  startupPhase: string | null,
  promptTokens: number | null,
  prefillRate: number | null
): string {
  if (piStatus === 'starting') return startupPhase ? `Starting the agent — ${startupPhase}` : 'Starting the agent'
  if (piStatus !== 'running') return 'Waiting for the agent'
  if (!promptTokens) return 'Waiting for response'
  const size = `${Math.round(promptTokens / 1000)}k tokens`
  if (!prefillRate) return `Reading ${size} of context`
  const seconds = Math.round(promptTokens / prefillRate)
  if (seconds < 5) return `Reading ${size} of context`
  const eta = seconds >= 60 ? `~${Math.round(seconds / 60)} min` : `~${seconds}s`
  return `Reading ${size} of context — ${eta}`
}

export function StreamingBubble({ content, thinking, toolCalls }: StreamingBubbleProps): React.JSX.Element {
  const thinkingEnabled = useAppStore(
    (state) => state.settingsDraft.showThinking ?? state.settings?.showThinking ?? DEFAULT_SETTINGS.showThinking
  )
  const thinkingScrollRef = useRef<HTMLDivElement>(null)

  // What this wait actually is. Context size comes from the last completed
  // turn, which is the closest thing to the current prompt's size that exists
  // before the model has answered.
  const piStatus = useAppStore((state) => state.piStatus)
  const startupPhase = useAppStore((state) => state.piStartupPhase)
  const promptTokens = useAppStore((state) => state.sessionStats?.contextUsage?.tokens ?? null)
  const prefillRate = useAppStore((state) => state.prefillRate)
  const waitLabel = describeWait(piStatus, startupPhase, promptTokens, prefillRate)

  // Whether the thinking pane should keep following its tail. Sticky INTENT,
  // remembered across renders — not re-derived from scroll position on every
  // chunk.
  //
  // The old check measured "am I within 48px of the bottom?" after each chunk
  // had already been appended. While thinking streams fast the tail moves
  // further every frame, so a small scroll-up left the reader inside that 48px
  // window and the next chunk snapped them straight back down: scrolling up to
  // re-read was impossible unless you outran the model. Intent is set by the
  // reader (scrolling away turns following off, returning to the bottom turns
  // it back on) and nothing else may revoke it.
  const followThinking = useRef(true)

  const onThinkingScroll = (): void => {
    const el = thinkingScrollRef.current
    if (!el) return
    followThinking.current = el.scrollHeight - el.clientHeight - el.scrollTop <= THINKING_TAIL_THRESHOLD_PX
  }

  useEffect(() => {
    const el = thinkingScrollRef.current
    if (!el || !followThinking.current) return
    el.scrollTop = el.scrollHeight
  }, [thinking])

  return (
    <div className="mb-4 animate-fade-in">
      {/* No model avatar. There is only ever one assistant in a chat, so a
          picture next to every one of its turns identifies nothing and costs a
          column of width on every line. */}
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          {thinking && thinkingEnabled && (
            <div className="thinking-hover mb-2 min-w-0">
              <div className="flex h-7 items-center gap-1.5 text-sm text-dim">
                <Brain size={12} className="shrink-0" />
                <PixelLoader label="Thinking" className="text-special" />
              </div>
              <div
                ref={thinkingScrollRef}
                onScroll={onThinkingScroll}
                className="max-h-36 min-w-0 overflow-x-hidden overflow-y-auto"
              >
                <div className="markdown-body font-sans italic text-sm text-muted break-words [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {thinking}
                </div>
              </div>
            </div>
          )}

          {toolCalls.size > 0 && (
            <div className="mb-2 space-y-1">
              {Array.from(toolCalls.entries()).map(([id, tc]) => {
                const Icon = toolCallIconFor(tc.name)
                return (
                  <div
                    key={id}
                    className={clsx(
                      'flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                      tc.isExecuting
                        ? 'border-warning-bg bg-warning-bg text-warning'
                        : tc.isError
                          ? 'border-error-bg bg-surface/50 text-muted'
                          : 'border-border bg-surface/50 text-muted'
                    )}
                  >
                    {tc.isExecuting ? (
                      <Loader2 size={12} className="shrink-0 animate-spin" />
                    ) : (
                      <Icon size={12} className="shrink-0" />
                    )}
                    <span className="min-w-0 truncate font-jetbrains">{toolLabel(tc.name)}</span>
                    <span
                      className={clsx(
                        'ml-auto shrink-0 text-xs capitalize',
                        tc.isExecuting && 'text-warning animate-pulse',
                        !tc.isExecuting && tc.isError && 'text-error',
                        !tc.isExecuting && !tc.isError && 'text-success'
                      )}
                    >
                      {tc.isExecuting ? 'running' : tc.isError ? 'error' : 'done'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {content && (
            // streaming-md places the caret ::after the last markdown block so it
            // sits at the end of the current chunk (not on a line below it).
            <div className="markdown-body streaming-md min-w-0 text-sm break-words [overflow-wrap:anywhere]">
              <MarkdownRenderer content={content} />
            </div>
          )}

          {!content && !thinking && toolCalls.size === 0 && (
            // The longest wait in the app: on a local model this is prompt
            // prefill, which can run for a minute before the first token. The
            // elapsed counter is the whole reason this is not a spinner — and
            // the label says which wait it is, because "starting the engine"
            // and "reading 24k tokens of context" feel identical from here and
            // have completely different fixes.
            <div className="flex h-7 items-center text-sm text-dim">
              <PixelLoader label={waitLabel} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
