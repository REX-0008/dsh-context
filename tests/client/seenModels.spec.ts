// seenModels (src/client/seenModels.ts): the model ids read out of the session
// list snapshot, which is what the settings card's price-gap report is built
// from. The snapshot is untrusted wire data, so every hostile shape must yield
// an empty list rather than throwing inside a settings panel.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { seenModelsOf } from '../../src/client/seenModels'

/** One session row carrying folded cost for the given provider → models. */
function row(cost: unknown): unknown {
  return { timeline: { cost } }
}

describe('seenModelsOf', () => {
  test('collects every distinct model across sessions, in first-seen order', () => {
    const snapshot = {
      sessions: [
        row({ 'deepseek-official': { 'deepseek-v4.1-flash': {} } }),
        row({ anthropic: { 'claude-sonnet-4': {}, 'claude-opus-4': {} } }),
        row({ 'deepseek-official': { 'deepseek-v4.1-flash': {} } }),
      ],
    }
    assert.deepEqual(seenModelsOf(snapshot), ['deepseek-v4.1-flash', 'claude-sonnet-4', 'claude-opus-4'])
  })

  test('an absent or non-array sessions field yields nothing', () => {
    assert.deepEqual(seenModelsOf(null), [])
    assert.deepEqual(seenModelsOf(undefined), [])
    assert.deepEqual(seenModelsOf({}), [])
    assert.deepEqual(seenModelsOf({ sessions: 'nope' }), [])
    assert.deepEqual(seenModelsOf({ sessions: {} }), [])
    assert.deepEqual(seenModelsOf('primitive'), [])
  })

  test('a malformed row contributes nothing instead of throwing', () => {
    const snapshot = {
      sessions: [
        null,
        42,
        'text',
        {},
        { timeline: null },
        { timeline: {} },
        { timeline: { cost: null } },
        { timeline: { cost: 'x' } },
        { timeline: { cost: [] } },
        row('not-an-object'),
        row([]),
        row({ provider: null }),
        row({ provider: 'x' }),
        row({ provider: {} }),
        // A model table that is a primitive: the key is still a model id, so it
        // is collected — the row is malformed in its VALUES, not its keys.
        row({ p: { m: 1 } }),
      ],
    }
    assert.deepEqual(seenModelsOf(snapshot), ['m'])
  })

  test('a session whose cost row is unreadable never breaks the readable ones', () => {
    const snapshot = {
      sessions: [
        { timeline: { cost: { ok: { m: {} } } } },
        { timeline: { cost: null } },
        { timeline: { cost: { bad: 'nope' } } },
      ],
    }
    assert.deepEqual(seenModelsOf(snapshot), ['m'])
  })
})
