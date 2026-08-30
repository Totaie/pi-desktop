import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sumTurnTokens } from './turn-tokens'
import type { DisplayMessage } from '../message-parsing'

function turn(tokens: DisplayMessage['tokens']): DisplayMessage {
  return { id: 'm', role: 'assistant', content: '', timestamp: 0, tokens }
}

test('a run with no reported usage sums to nothing, not to zero', () => {
  // The distinction the UI depends on: undefined renders no badge, whereas a
  // zero would claim a turn was free. Old sessions and aborted turns carry no
  // usage at all, and they are common.
  assert.equal(sumTurnTokens([]), undefined)
  assert.equal(sumTurnTokens([turn(undefined), turn(undefined)]), undefined)
})

test('a run sums every reported field across its turns', () => {
  const total = sumTurnTokens([
    turn({ input: 100, output: 20, cacheRead: 5, total: 120 }),
    turn({ input: 300, output: 40, cacheWrite: 7, total: 340 }),
  ])
  assert.deepEqual(total, { input: 400, output: 60, cacheRead: 5, cacheWrite: 7, total: 460 })
})

test('turns without usage do not drag a run down to nothing', () => {
  const total = sumTurnTokens([turn(undefined), turn({ input: 10, output: 5, total: 15 }), turn(undefined)])
  assert.equal(total?.total, 15, 'the one turn that reported still counts')
})

test('a missing total is derived from input plus output', () => {
  // Engines that report the split but no total must not read as a free turn.
  const total = sumTurnTokens([turn({ input: 70, output: 30 })])
  assert.equal(total?.total, 100)
})
