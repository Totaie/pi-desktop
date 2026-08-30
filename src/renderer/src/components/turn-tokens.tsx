import type { DisplayMessage } from '../message-parsing'

/**
 * Token cost of one turn, shown in its header beside the model and price.
 *
 * A turn, not a message: the prompt and every tool call it made share one
 * prefill, so splitting the number across bubbles would attribute a shared cost
 * to whichever happened to render first. On a local model the price is always
 * $0.0000, which makes the token count the only figure in that header that
 * carries information.
 */

interface TurnTokensProps {
  tokens: DisplayMessage['tokens']
}

/**
 * Total across a collapsed run of turns, for the group's shared header.
 *
 * Returns undefined when nothing in the run reported usage, so a group of old
 * messages shows no badge rather than a confident zero.
 */
export function sumTurnTokens(messages: DisplayMessage[]): DisplayMessage['tokens'] {
  let seen = false
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const message of messages) {
    const t = message.tokens
    if (!t) continue
    seen = true
    sum.input += t.input ?? 0
    sum.output += t.output ?? 0
    sum.cacheRead += t.cacheRead ?? 0
    sum.cacheWrite += t.cacheWrite ?? 0
    sum.total += t.total ?? (t.input ?? 0) + (t.output ?? 0)
  }
  return seen ? sum : undefined
}

/** 1234 -> "1.2k". Exact below 1000, where the digits still mean something. */
function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const thousands = value / 1000
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
  }
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function TurnTokens({ tokens }: TurnTokensProps): React.JSX.Element | null {
  if (!tokens) return null

  const { input, output, cacheRead, cacheWrite, total } = tokens
  const headline = total ?? (input ?? 0) + (output ?? 0)
  if (!headline) return null

  // The breakdown goes in the tooltip rather than the header: in/out/cached is
  // four numbers where the row already carries three, and the split only
  // matters when you are already asking why the total looks wrong.
  const detail = [
    input !== undefined ? `${input.toLocaleString()} in` : null,
    output !== undefined ? `${output.toLocaleString()} out` : null,
    cacheRead ? `${cacheRead.toLocaleString()} cached` : null,
    cacheWrite ? `${cacheWrite.toLocaleString()} written to cache` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <span className="text-ghost">·</span>
      <span
        className="tabular-nums"
        title={detail ? `${headline.toLocaleString()} tokens — ${detail}` : `${headline.toLocaleString()} tokens`}
      >
        {compact(headline)} tok
      </span>
    </>
  )
}
