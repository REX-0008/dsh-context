// The client settings store (src/client/settings.ts): the preference projection
// plus the model-price mapping accessors the mapping table rides. The scope is a
// plain stand-in, so every case here is deterministic and offline.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings, type SettingsScopeLike } from '../../src/client/settings'

/** A scope stand-in: a mutable value, optional write failure, and a listener set. */
function makeScope(value: unknown, options: { writable?: boolean; failWrites?: boolean } = {}): SettingsScopeLike & {
  sets: { field: string; value: unknown }[]
  push(next: unknown): void
} {
  const listeners = new Set<() => void>()
  const rec = {
    sets: [] as { field: string; value: unknown }[],
    getSnapshot: () => ({ status: 'ready', value, writable: options.writable ?? true }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async set(field: string, next: unknown) {
      rec.sets.push({ field, value: next })
      if (options.failWrites === true) throw new Error('refused')
      value = { ...(value as object), [field]: next }
      for (const listener of listeners) listener()
    },
    push(next: unknown) {
      value = next
      for (const listener of listeners) listener()
    },
  }
  return rec
}

describe('the price-map accessors', () => {
  test('an absent or malformed map reads as empty', () => {
    const settings = createContextSettings()
    assert.deepEqual(settings.priceMap(), {}, 'before any scope attaches')
    const scope = makeScope({})
    settings.attach(scope)
    assert.deepEqual(settings.priceMap(), {}, 'no priceMap field')
    scope.push({ priceMap: 'nope' })
    assert.deepEqual(settings.priceMap(), {}, 'a non-record reads as empty')
    scope.push({ priceMap: [1, 2] })
    assert.deepEqual(settings.priceMap(), {}, 'an array reads as empty')
  })

  test('only well-formed entries survive the read', () => {
    const settings = createContextSettings()
    const scope = makeScope({
      priceMap: {
        good: { vendor: 'zai', model: 'glm-5.2' },
        'no-model': { vendor: 'zai' },
        'wrong-type': { vendor: 1, model: 2 },
        nullish: null,
        'not-object': 'text',
      },
    })
    settings.attach(scope)
    assert.deepEqual(settings.priceMap(), { good: { vendor: 'zai', model: 'glm-5.2' } })
  })

  test('the map keeps ONE identity while the stored value is unchanged', () => {
    // Load-bearing: the settings card hands this object to an effect keyed on its
    // identity. Rebuilding it per read made that effect re-run on every render,
    // and each run notified the pricing store — an unbounded update loop that
    // unmounted the whole card.
    const settings = createContextSettings()
    const scope = makeScope({ priceMap: { k: { vendor: 'zai', model: 'glm-5.2' } } })
    settings.attach(scope)
    const first = settings.priceMap()
    assert.equal(settings.priceMap(), first, 'the same object comes back')
    // A value change (the scope republishing) does rebuild it.
    scope.push({ priceMap: { k: { vendor: 'deepseek', model: 'deepseek-flash' } } })
    const second = settings.priceMap()
    assert.notEqual(second, first, 'a changed value is a new object')
    assert.deepEqual(second, { k: { vendor: 'deepseek', model: 'deepseek-flash' } })
  })

  test('a mapping-only change notifies, so pricing never waits on the settings card', () => {
    // The regression: the runtime adopts the map from this store's notifications,
    // and publish() diffs PREFERENCES only. A scope delivery that changed just the
    // mapping (startup, another tab's write) therefore went unnotified, and every
    // mapped row stayed unpriced until some unrelated preference happened to move.
    const settings = createContextSettings()
    const scope = makeScope({ priceMap: { k: { vendor: 'zai', model: 'glm-5.2' } } })
    settings.attach(scope)
    let calls = 0
    settings.store.subscribe(() => { calls++ })
    // A fresh object with the SAME content is not a change (the Host re-sends one
    // on every section update, and notifying for it would loop the card).
    scope.push({ priceMap: { k: { vendor: 'zai', model: 'glm-5.2' } } })
    assert.equal(calls, 0, 'an unchanged mapping is not a notification')
    scope.push({ priceMap: { k: { vendor: 'deepseek', model: 'deepseek-flash' } } })
    assert.equal(calls, 1, 'a changed mapping notifies exactly once')
    assert.deepEqual(settings.priceMap(), { k: { vendor: 'deepseek', model: 'deepseek-flash' } })
  })

  test('the table\'s own write reaches the runtime immediately, without a scope round-trip', () => {
    const settings = createContextSettings()
    const scope = makeScope({})
    settings.attach(scope)
    let calls = 0
    settings.store.subscribe(() => { calls++ })
    settings.setPriceMap({ k: { vendor: 'zai', model: 'glm-5.2' } })
    assert.equal(calls, 1, 'the optimistic echo announces the mapping')
    assert.deepEqual(settings.priceMap(), { k: { vendor: 'zai', model: 'glm-5.2' } })
  })

  test('a refused write rolls the mapping back and re-announces it', async () => {
    // The runtime must forget a mapping that never persisted, so the rollback
    // announces the restored value rather than leaving the echo in place.
    const settings = createContextSettings()
    const scope = makeScope({ priceMap: { k: { vendor: 'zai', model: 'glm-5.2' } } }, { failWrites: true })
    settings.attach(scope)
    let calls = 0
    settings.store.subscribe(() => { calls++ })
    settings.setPriceMap({ k: { vendor: 'deepseek', model: 'deepseek-flash' } })
    assert.equal(calls, 1, 'the optimistic echo announces first')
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(calls, 2, 'the rollback announces the restored mapping')
    assert.deepEqual(settings.priceMap(), { k: { vendor: 'zai', model: 'glm-5.2' } }, 'back to the scope\'s truth')
  })

  test('a mapping change that also moves a preference notifies once, not twice', () => {
    const settings = createContextSettings()
    const scope = makeScope({})
    settings.attach(scope)
    let calls = 0
    settings.store.subscribe(() => { calls++ })
    scope.push({ defaultGranularity: 'turn', priceMap: { k: { vendor: 'zai', model: 'glm-5.2' } } })
    assert.equal(calls, 1, 'one delivery, one notification')
  })

  test('a write echoes immediately and reaches the scope under its own key', async () => {
    const settings = createContextSettings()
    const scope = makeScope({})
    settings.attach(scope)
    settings.setPriceMap({ k: { vendor: 'deepseek', model: 'deepseek-flash' } })
    assert.deepEqual(settings.priceMap(), { k: { vendor: 'deepseek', model: 'deepseek-flash' } }, 'echoed at once')
    await Promise.resolve()
    assert.deepEqual(scope.sets, [{ field: 'priceMap', value: { k: { vendor: 'deepseek', model: 'deepseek-flash' } } }])
  })

  test('a write with no scope attached only echoes', () => {
    const settings = createContextSettings()
    settings.setPriceMap({ k: { vendor: 'zai', model: 'glm-5.2' } })
    assert.deepEqual(settings.priceMap(), { k: { vendor: 'zai', model: 'glm-5.2' } })
  })

  test('a refused write rolls the echo back to the previous map', async () => {
    const settings = createContextSettings()
    const scope = makeScope({ priceMap: { kept: { vendor: 'zai', model: 'glm-5.2' } } }, { failWrites: true })
    settings.attach(scope)
    assert.deepEqual(Object.keys(settings.priceMap()), ['kept'])
    settings.setPriceMap({ replaced: { vendor: 'deepseek', model: 'deepseek-flash' } })
    assert.deepEqual(Object.keys(settings.priceMap()), ['replaced'], 'optimistic echo')
    // Let the rejected write settle and run its rollback.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    assert.deepEqual(Object.keys(settings.priceMap()), ['kept'], 'rolled back to the scope truth')
  })

  test('a refused write rolls back even when the scope never published a value', async () => {
    // The scope exists but has not published: the rollback runs against no prior
    // value, which must leave an empty map rather than throwing.
    const settings = createContextSettings()
    const scope = makeScope(undefined, { failWrites: true })
    settings.attach(scope)
    settings.setPriceMap({ mine: { vendor: 'zai', model: 'glm-5.2' } })
    assert.deepEqual(Object.keys(settings.priceMap()), ['mine'], 'optimistic echo')
    await new Promise(resolve => { setTimeout(resolve, 0) })
    assert.deepEqual(settings.priceMap(), {}, 'rolled back to nothing')
  })

  test('the scope re-read replaces the echo once it publishes', async () => {
    const settings = createContextSettings()
    const scope = makeScope({})
    settings.attach(scope)
    settings.setPriceMap({ mine: { vendor: 'zai', model: 'glm-5.2' } })
    assert.deepEqual(Object.keys(settings.priceMap()), ['mine'])
    scope.push({ priceMap: { theirs: { vendor: 'deepseek', model: 'deepseek-flash' } } })
    assert.deepEqual(Object.keys(settings.priceMap()), ['theirs'], 'the scope is the truth')
  })
})
