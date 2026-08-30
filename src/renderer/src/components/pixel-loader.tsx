import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'

/**
 * Pixel-grid loading state: a small grid of cells lit by a travelling shimmer,
 * with the elapsed time alongside.
 *
 * Replaces the spinner. A spinner says only "something is happening"; on a
 * local model a turn can legitimately take a minute of prompt prefill before
 * the first token, and the useful question during that minute is "how long has
 * this been going?". The elapsed counter answers it, and the shimmer gives the
 * grid a direction so a slow turn still reads as progress rather than a freeze.
 *
 * Built here rather than copied: beautifului.dev publishes these components
 * under MIT but does not publish their source — the site renders them from its
 * own bundle, which contains no copy-paste strings. This follows the described
 * behaviour ("pixel-grid loader with shimmer and elapsed time") as an original
 * implementation.
 */

interface PixelLoaderProps {
  /** Wall-clock start of the wait. Defaults to first mount. */
  startedAt?: number
  /** Shown next to the grid, e.g. "Thinking". */
  label?: string
  /** Hide the elapsed counter for short, inline waits. */
  showElapsed?: boolean
  className?: string
}

const COLUMNS = 8
const ROWS = 3
const CELLS = COLUMNS * ROWS
/** How far the shimmer's glow reaches, in columns. */
const FALLOFF = 1.9

/** m:ss up to an hour, then h:mm:ss — a turn that long is worth showing whole. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

export function PixelLoader({
  startedAt,
  label,
  showElapsed = true,
  className,
}: PixelLoaderProps): React.JSX.Element {
  // Pinned on first mount so the counter does not restart when a parent
  // re-renders mid-turn, which is exactly when it re-renders most.
  const startRef = useRef(startedAt ?? Date.now())
  useEffect(() => {
    if (startedAt !== undefined) startRef.current = startedAt
  }, [startedAt])

  const [elapsed, setElapsed] = useState(() => Date.now() - startRef.current)
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    // One timer drives both: the shimmer needs ~12fps to read as motion, and
    // the counter only changes once a second, so a second interval would buy
    // nothing but another wakeup on a machine already busy running a model.
    const tick = setInterval(() => {
      setPhase((current) => (current + 1) % (COLUMNS * 6))
      setElapsed(Date.now() - startRef.current)
    }, 80)
    return () => clearInterval(tick)
  }, [])

  const head = (phase / 6) % COLUMNS

  return (
    <div className={clsx('flex items-center gap-2', className)} role="status" aria-live="polite">
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, 3px)` }}
        aria-hidden="true"
      >
        {Array.from({ length: CELLS }, (_, index) => {
          const column = index % COLUMNS
          const row = Math.floor(index / COLUMNS)
          // Distance measured around the ring so the shimmer wraps without a
          // seam where the last column meets the first.
          const raw = Math.abs(column - head)
          const distance = Math.min(raw, COLUMNS - raw)
          // Middle row leads; outer rows trail slightly, which reads as a wave
          // rather than a column of cells blinking together.
          const rowLag = Math.abs(row - (ROWS - 1) / 2) * 0.55
          const intensity = Math.max(0, 1 - (distance + rowLag) / FALLOFF)
          return (
            <span
              key={index}
              className="h-[3px] w-[3px] rounded-[1px] bg-current transition-opacity duration-150"
              style={{ opacity: 0.18 + intensity * 0.82 }}
            />
          )
        })}
      </div>
      {label && <span className="text-xs">{label}</span>}
      {showElapsed && (
        <span className="font-mono text-[11px] tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
      )}
      <span className="sr-only">
        {label ?? 'Working'}, {Math.floor(elapsed / 1000)} seconds elapsed
      </span>
    </div>
  )
}
