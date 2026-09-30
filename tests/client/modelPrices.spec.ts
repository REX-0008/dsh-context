// The model-price book (src/client/modelPrices.ts): the hand-maintained table
// delivered in the book shape the pricing call sites thread through — no
// fetch, no store, no failure state.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { useModelPrices } from '../../src/client/modelPrices'
import { tableRows } from '../../src/client/priceTable'

describe('useModelPrices', () => {
  test('delivers the table book, identity-stable and never failed', () => {
    const snap = useModelPrices()
    assert.equal(snap.failed, false)
    assert.equal(useModelPrices(), snap, 'the snapshot is identity-stable for the whole page')
    // The book mirrors the table rows under one neutral branch.
    const branch = snap.book.prices.table
    assert.ok(branch !== undefined)
    const rows = tableRows()
    assert.deepEqual(Object.keys(branch).sort(), rows.map(r => r.key).sort())
    for (const { key, row } of rows) assert.deepEqual(branch[key], row)
  })
})
