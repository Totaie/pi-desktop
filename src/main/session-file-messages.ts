import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { isWithinSessionRoots } from './pi-paths'

/**
 * Read a session's messages straight off its .jsonl, with no engine running.
 *
 * get_messages goes through the live agent, so a chat whose engine is not up
 * returned nothing and rendered blank: selecting an old chat showed an empty
 * transcript until Pi had spawned and hydrated. The history is already on disk
 * in a format we own — reading it there makes selection free, which is what
 * lets chat switching stop starting engines.
 *
 * Deliberately shaped like the RPC response (`{ success, data: { messages,
 * truncatedFromStart, totalMessageCount } }`) so the renderer's existing parse
 * and truncation-notice path handles both sources with no branch.
 */

/**
 * Newest-N cap, matching the engine's own bound on get_messages: a multi-MB
 * history serialised across IPC freezes the renderer, and it does so whichever
 * side read the file.
 */
const MAX_MESSAGES = 500

export interface SessionFileMessages {
  success: true
  data: {
    messages: unknown[]
    truncatedFromStart: boolean
    totalMessageCount: number
  }
}

export async function readSessionFileMessages(filePath: string): Promise<SessionFileMessages | null> {
  // Same containment rule the rest of the app uses: only files inside a known
  // session store are readable through this, so a renderer-supplied path cannot
  // turn into an arbitrary file read.
  if (!isWithinSessionRoots(filePath)) return null

  const messages: unknown[] = []
  let total = 0

  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        // A half-written trailing line is normal while the agent is mid-write;
        // it is not a reason to fail the whole read.
        continue
      }
      if (!record || typeof record !== 'object') continue
      const entry = record as { type?: unknown; message?: unknown }
      if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue

      total += 1
      messages.push(entry.message)
      // Keep only the newest MAX_MESSAGES without buffering the whole file.
      if (messages.length > MAX_MESSAGES) messages.shift()
    }
    lines.close()
  } catch {
    // Missing or unreadable: the caller falls back to the engine, so a null
    // here costs nothing beyond the pre-existing behaviour.
    return null
  }

  return {
    success: true,
    data: {
      messages,
      truncatedFromStart: total > messages.length,
      totalMessageCount: total,
    },
  }
}
