// The root-scope pair observer (src/our/client/pairObserver.ts). The regression it
// pins: the pairs reached the pricing runtime ONLY from the mapping table, which
// mounts on the settings page — so a session opened with that page closed priced
// every local route as null until someone happened to open it.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { pairsOfSnapshot, sessionsListOf, watchObservedPairs } from '../../src/our/client/pairObserver'
import { priceMapRows, resetPriceBook } from '../../src/our/client/priceBook'
import { rowKey } from '../../src/our/client/priceMap'

/** A session-list snapshot carrying one billed row per entry. */
const snapshotWith = (bills: Record<string, unknown>): unknown => ({
  ids: Object.keys(bills),
  current: Object.keys(bills)[0],
  byId: Object.fromEntries(Object.entries(bills).map(([id, cost]) => [
    id,
    { projectionValues: { contextTimeline: { cost } } },
  ])),
})

/** The outward sessions list face, as the observer consumes it. */
function makeFace(snapshot: unknown): {
  face: { get(name: string): unknown }
  list: { getSnapshot(): unknown; subscribe(l: () => void): () => void }
  push(next: unknown): void
  listeners: Set<() => void>
} {
  const listeners = new Set<() => void>()
  let value = snapshot
  const list = {
    getSnapshot: () => value,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
  }
  return {
    face: { get: (name: string) => (name === 'sessions' ? { list } : undefined) },
    list,
    push: (next: unknown) => { value = next; for (const l of listeners) l() },
    listeners,
  }
}

describe('sessionsListOf', () => {
  test('an absent or malformed service reads as null', () => {
    assert.equal(sessionsListOf({ get: () => undefined }), null)
    assert.equal(sessionsListOf({ get: () => ({}) }), null)
    assert.equal(sessionsListOf({ get: () => ({ list: {} }) }), null)
    assert.equal(sessionsListOf({ get: () => ({ list: { getSnapshot: () => null } }) }), null)
  })

  test('the real face is recognised', () => {
    const { face } = makeFace(snapshotWith({}))
    assert.notEqual(sessionsListOf(face), null)
  })
})

describe('pairsOfSnapshot', () => {
  test('every billed route/model pair is collected, deduplicated', () => {
    const snapshot = snapshotWith({
      a: { dycp: { 'glm-5.3-flash': {} } },
      b: { dycp: { 'glm-5.3-flash': {}, 'glm-5.2': {} } },
    })
    assert.deepEqual(
      pairsOfSnapshot(snapshot).map(p => rowKey(p.provider, p.model)).sort(),
      [rowKey('dycp', 'glm-5.2'), rowKey('dycp', 'glm-5.3-flash')].sort(),
    )
  })

  test('a hostile or empty snapshot yields no pairs rather than throwing', () => {
    assert.deepEqual(pairsOfSnapshot(null), [])
    assert.deepEqual(pairsOfSnapshot('text'), [])
    assert.deepEqual(pairsOfSnapshot({}), [])
    assert.deepEqual(pairsOfSnapshot({ byId: 'nope' }), [])
    assert.deepEqual(pairsOfSnapshot({ byId: { a: null } }), [])
    assert.deepEqual(pairsOfSnapshot({ byId: { a: { projectionValues: { contextTimeline: {} } } } }), [])
  })
})

describe('watchObservedPairs', () => {
  test('an absent service disposes cleanly and feeds nothing', () => {
    const dispose = watchObservedPairs({ get: () => undefined })
    assert.equal(typeof dispose, 'function')
    dispose()
  })

  test('the runtime gets the pairs WITHOUT any settings card mounted', () => {
    // This is the regression: fold the snapshot straight from the root scope and
    // the mapping must already price the row.
    resetPriceBook()
    const { face } = makeFace(snapshotWith({ a: { dycp: { 'glm-5.3-flash': {} } } }))
    const dispose = watchObservedPairs(face)
    const rows = priceMapRows([{ provider: 'dycp', model: 'glm-5.3-flash' }], {})
    assert.equal(rows.length, 1)
    dispose()
  })

  test('a later snapshot update is picked up', () => {
    resetPriceBook()
    const { face, push, listeners } = makeFace(snapshotWith({}))
    const dispose = watchObservedPairs(face)
    assert.equal(listeners.size, 1, 'the observer subscribed')
    push(snapshotWith({ a: { dycp: { 'glm-5.2': {} } } }))
    assert.deepEqual(
      (priceMapRows([{ provider: 'dycp', model: 'glm-5.2' }], {})[0] !== undefined),
      true,
      'the new pair reached the table derivation',
    )
    dispose()
    assert.equal(listeners.size, 0, 'the subscription is gone after dispose')
  })

  test('a throwing snapshot is swallowed, not thrown into the render', () => {
    resetPriceBook()
    const list = {
      getSnapshot: () => { throw new Error('hostile') },
      subscribe: () => () => {},
    }
    assert.doesNotThrow(() => {
      const dispose = watchObservedPairs({ get: () => ({ list }) })
      dispose()
    }, 'a hostile snapshot must not reach the render')
  })
})
