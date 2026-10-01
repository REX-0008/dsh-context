// The price-mapping runtime (src/our/client/priceBook.ts): how the mapping
// reaches a delivered book, and the two properties that make it safe to mount —
// it never regresses a pair upstream already priced, and it never rewrites a
// real registry vendor's branch.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { priceFaceOf, type ModelBook, type PriceTriple } from '../../src/client/cost'
import { priceIndexOf } from '../../src/client/cost'
import {
  effectiveRate,
  currentOverrides,
  noteBook,
  noteObservedPairs,
  priceMapRows,
  priceMapStore,
  rateForTarget,
  resetPriceBook,
  setOverrides,
  vendorBranches,
} from '../../src/our/client/priceBook'
import { rowKey } from '../../src/our/client/priceMap'

const R = (miss: number, out: number, hit = miss / 10, write = 0): PriceTriple => ({ hit, miss, write, out })

/** A book in the delivered shape: vendors, a model index, and its branches. */
function bookOf(prices: Record<string, Record<string, PriceTriple>>, npmOf: Record<string, string | null> = {}): ModelBook {
  return { prices, index: priceIndexOf(prices, npmOf) }
}

describe('augmentation', () => {
  test('a mapped pair prices through the route, leaving the vendor branch alone', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    const face = priceFaceOf(book, 'dycp', 'glm-5.3-flash')
    assert.equal(face?.rate.miss, 0.15)
    assert.equal(face?.pid, 'dycp', 'the synthesized branch carries the rate')
    assert.deepEqual(book.prices.zai, { 'glm-5.3-flash': R(0.15, 0.5) }, 'the vendor branch is untouched')
  })

  test('a route already priced upstream keeps its figure when the mapping cannot resolve', () => {
    resetPriceBook()
    // A unique-carrier model id: upstream's index prices it with no mapping.
    const book = bookOf({ volcengine: { 'deepseek-v4-flash-ga-260731': R(0.4453, 1.3359) } })
    const before = priceFaceOf(book, 'dycp', 'deepseek-v4-flash-ga-260731')
    assert.equal(before?.rate.miss, 0.4453)
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'deepseek-v4-flash-ga-260731' }])
    const after = priceFaceOf(book, 'dycp', 'deepseek-v4-flash-ga-260731')
    assert.equal(after?.rate.miss, before?.rate.miss, 'no regression')
  })

  test('a route upstream cannot price gains nothing rather than a guess', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'mystery-model' }])
    assert.equal(priceFaceOf(book, 'dycp', 'mystery-model'), null)
    assert.equal(Object.hasOwn(book.prices, 'dycp'), false, 'an empty branch is not written')
  })

  test('a real registry vendor branch is never shadowed', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'zai', model: 'glm-5.3-flash' }])
    assert.deepEqual(book.prices.zai, { 'glm-5.3-flash': R(0.15, 0.5) })
  })

  test('one route missing a model leaves the route un-branched, so siblings still price', () => {
    resetPriceBook()
    // Two models on one route; only the first maps. Writing a branch holding just
    // the first would strand the second (a carried branch is final upstream).
    const book = bookOf({
      zai: { 'glm-5.3-flash': R(0.15, 0.5) },
      volcengine: { 'deepseek-v4-flash-ga-260731': R(0.4453, 1.3359) },
    })
    noteBook(book)
    noteObservedPairs([
      { provider: 'dycp', model: 'glm-5.3-flash' },
      { provider: 'dycp', model: 'deepseek-v4-flash-ga-260731' },
    ])
    const mapped = priceFaceOf(book, 'dycp', 'glm-5.3-flash')
    const fallback = priceFaceOf(book, 'dycp', 'deepseek-v4-flash-ga-260731')
    assert.equal(mapped?.rate.miss, 0.15)
    assert.equal(fallback?.rate.miss, 0.4453, 'the sibling keeps upstream pricing')
  })

  test('re-running is idempotent and never feeds synthesized output back in', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    const first = JSON.stringify(book.prices)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    assert.equal(JSON.stringify(book.prices), first)
  })
})

describe('overrides', () => {
  test('an override redirects a mechanically-resolved row', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5), 'glm-5.2': R(1.4, 4.4) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    setOverrides({ [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } })
    assert.equal(priceFaceOf(book, 'dycp', 'glm-5.3-flash')?.rate.miss, 1.4)
  })

  test('an override resolves a row the mechanical pass cannot', () => {
    resetPriceBook()
    const book = bookOf({ deepseek: { 'deepseek-flash': R(0.15, 0.6) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'deepseek-v4-1-flash-260910' }])
    assert.equal(priceFaceOf(book, 'dycp', 'deepseek-v4-1-flash-260910'), null)
    setOverrides({ [rowKey('dycp', 'deepseek-v4-1-flash-260910')]: { vendor: 'deepseek', model: 'deepseek-flash' } })
    assert.equal(priceFaceOf(book, 'dycp', 'deepseek-v4-1-flash-260910')?.rate.miss, 0.15)
  })

  test('an override naming a model the vendor lacks writes nothing', () => {
    resetPriceBook()
    const book = bookOf({ deepseek: { 'deepseek-flash': R(0.15, 0.6) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'mystery' }])
    setOverrides({ [rowKey('dycp', 'mystery')]: { vendor: 'deepseek', model: 'nope' } })
    assert.equal(priceFaceOf(book, 'dycp', 'mystery'), null)
  })

  test('clearing an override returns the row to the mechanical pass', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5), 'glm-5.2': R(1.4, 4.4) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    setOverrides({ [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } })
    setOverrides({})
    assert.equal(priceFaceOf(book, 'dycp', 'glm-5.3-flash')?.rate.miss, 0.15)
  })
})

describe('the override write', () => {
  test('an equal map is a no-op, so a caller pushing every render cannot spin the store', () => {
    resetPriceBook()
    noteBook(bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } }))
    let notifications = 0
    const stop = priceMapStore.subscribe(() => { notifications += 1 })
    setOverrides({ [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } })
    const afterFirst = notifications
    assert.ok(afterFirst > 0, 'a real change notifies')
    // A freshly built but EQUAL map: the seat rebuilds one on every render.
    setOverrides({ [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } })
    assert.equal(notifications, afterFirst, 'an equal map does not notify again')
    stop()
  })

  test('a changed, added, or removed row does notify', () => {
    resetPriceBook()
    noteBook(bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5), 'glm-5.2': R(1.4, 4.4) } }))
    const one = { [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } }
    const other = { [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.3-flash' } }
    setOverrides(one)
    let notifications = 0
    const stop = priceMapStore.subscribe(() => { notifications += 1 })
    setOverrides(other)
    assert.equal(notifications, 1, 'a changed target notifies')
    setOverrides({ ...other, [rowKey('x', 'y')]: { vendor: 'zai', model: 'glm-5.2' } })
    assert.equal(notifications, 2, 'an added row notifies')
    setOverrides(other)
    assert.equal(notifications, 3, 'a removed row notifies')
    stop()
  })

  test('the explicit read agrees with the map in force', () => {
    resetPriceBook()
    noteBook(bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5), 'glm-5.2': R(1.4, 4.4) } }))
    const explicit = { [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } }
    setOverrides(explicit)
    assert.deepEqual(currentOverrides(), explicit)
    const rows = priceMapRows([{ provider: 'dycp', model: 'glm-5.3-flash' }], explicit)
    assert.equal(rows[0].source, 'override')
    assert.equal(rows[0].rate?.miss, 1.4)
  })
})

describe('introspection', () => {
  test('rows report the mapping, the edited flag, and the effective source', () => {
    resetPriceBook()
    const book = bookOf({
      zai: { 'glm-5.3-flash': R(0.15, 0.5) },
      volcengine: { 'deepseek-v4-flash-ga-260731': R(0.4453, 1.3359) },
    })
    noteBook(book)
    const observed = [
      { provider: 'dycp', model: 'glm-5.3-flash' },
      { provider: 'dycp', model: 'deepseek-v4-flash-ga-260731' },
      { provider: 'dycp', model: 'mystery' },
    ]
    noteObservedPairs(observed)
    const rows = priceMapRows(observed)
    assert.deepEqual(
      rows.map(r => [r.source, r.edited, r.target?.vendor ?? null, r.rate?.miss ?? null]),
      [
        ['mapped', false, 'zai', 0.15],
        ['upstream', false, null, 0.4453],
        ['none', false, null, null],
      ],
    )
  })

  test('an edited row reports the override source', () => {
    resetPriceBook()
    const book = bookOf({ deepseek: { 'deepseek-flash': R(0.15, 0.6) } })
    noteBook(book)
    const observed = [{ provider: 'dycp', model: 'mystery' }]
    noteObservedPairs(observed)
    setOverrides({ [rowKey('dycp', 'mystery')]: { vendor: 'deepseek', model: 'deepseek-flash' } })
    const [row] = priceMapRows(observed)
    assert.equal(row.source, 'override')
    assert.equal(row.edited, true)
    assert.equal(row.rate?.miss, 0.15)
  })

  test('vendorBranches exposes the registry vendors, not the synthesized routes', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    assert.deepEqual(Object.keys(vendorBranches()), ['zai'])
  })

  test('rateForTarget reads a candidate out of the delivered book', () => {
    resetPriceBook()
    noteBook(bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } }))
    assert.equal(rateForTarget({ vendor: 'zai', model: 'glm-5.3-flash' })?.miss, 0.15)
    assert.equal(rateForTarget({ vendor: 'zai', model: 'absent' }), undefined)
  })

  test('effectiveRate answers before any book is adopted', () => {
    resetPriceBook()
    assert.equal(effectiveRate('dycp', 'glm-5.3-flash'), undefined)
  })

  test('pairs alone synthesize nothing; the book has to land first', () => {
    resetPriceBook()
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    assert.equal(Object.hasOwn(book.prices, 'dycp'), false, 'no branch before a book is adopted')
    noteBook(book)
    assert.equal(priceFaceOf(book, 'dycp', 'glm-5.3-flash')?.pid, 'dycp')
  })

  test('a unique carrier is priced by upstream alone, before any mapping', () => {
    resetPriceBook()
    // One vendor carrying the id resolves through upstream's own index, which is
    // why the mapping is only ever needed for the AMBIGUOUS ids.
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    const face = priceFaceOf(book, 'dycp', 'glm-5.3-flash')
    assert.equal(face?.pid, 'zai', 'resolved cross-vendor by the model index')
    assert.equal(face?.rate.miss, 0.15)
  })

  test('the mapping is what prices an id several vendors share', () => {
    resetPriceBook()
    // Two vendors carrying one id at different rates: upstream refuses (ambiguous),
    // the mapping names the vendor and settles it.
    const book = bookOf({
      zai: { 'glm-5.3-flash': R(0.15, 0.5) },
      crof: { 'glm-5.3-flash': R(0.07, 0.22) },
    })
    assert.equal(priceFaceOf(book, 'dycp', 'glm-5.3-flash'), null, 'upstream refuses the ambiguity')
    noteBook(book)
    noteObservedPairs([{ provider: 'dycp', model: 'glm-5.3-flash' }])
    assert.equal(priceFaceOf(book, 'dycp', 'glm-5.3-flash')?.rate.miss, 0.15, 'the family map picks zai')
  })

  test('an empty provider or model key is skipped', () => {
    resetPriceBook()
    const book = bookOf({ zai: { 'glm-5.3-flash': R(0.15, 0.5) } })
    noteBook(book)
    noteObservedPairs([{ provider: '', model: 'glm-5.3-flash' }, { provider: 'dycp', model: '' }])
    assert.equal(Object.hasOwn(book.prices, ''), false)
    assert.equal(Object.hasOwn(book.prices, 'dycp'), false)
  })
})
