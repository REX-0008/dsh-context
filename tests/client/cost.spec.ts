// Session-cost estimate (src/client/cost.ts): the fuzzy lookup against THIS
// PLUGIN's own price table (client/priceTable.ts), the USD→CNY conversion at the
// fixed 1 CNY = 0.15 USD, the null degradations, the numOf coercion of garbage
// bucket fields, the money/rate formatting, and the deep merge behind the stats
// board's family-scope cost cells.
//
// The provider argument and the registry book are retained in the signatures but
// no longer affect a price: the table keys on the model id alone, so one model
// prices the same however the log spells its provider.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSessionCost, formatCost, formatPriceRate, mergeCostUsage, peakOf, priceOf, toCurrency } from '../../src/client/cost'
import { normalizeModel, tableRateOf } from '../../src/client/priceTable'
import type { ModelPrices } from '../../src/client/cost'
import type { CostBucketTotals } from '../../src/shared/types'

const M = 1_000_000

/** The table's own rows for the models these cases use. */
const FLASH41 = { hit: 0.07, miss: 0.7, write: 0.7, out: 1.4 }
const V41 = { hit: 0.14, miss: 1.4, write: 1.4, out: 2.8 }
const V32 = { hit: 0.028, miss: 0.28, write: 0.28, out: 0.42 }
const SONNET = { hit: 0.3, miss: 3, write: 3.75, out: 15 }

/** A book is still accepted (and ignored) so the call sites stay covered. */
const BOOK: ModelPrices = {}

function bucket(cacheRead: number, uncached: number, cacheWrite: number, output: number): CostBucketTotals {
  return { cacheRead, uncached, cacheWrite, output }
}

function close(actual: number | null, expected: number, message?: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`)
}

describe('toCurrency', () => {
  test('USD passes through; CNY divides the fixed 0.15 rate', () => {
    assert.equal(toCurrency(1.2, 'usd'), 1.2)
    close(toCurrency(1.2, 'cny'), 8)
    close(toCurrency(0.3, 'cny'), 2)
  })
})

describe('normalizeModel', () => {
  test('folds case and every separator, dots included', () => {
    // Dots go too, which is what makes `v4.1` and `41` the same form.
    assert.equal(normalizeModel('deepseek-V4.1-Flash'), 'deepseekv41flash')
    assert.equal(normalizeModel('deepseek4.1flash'), 'deepseek41flash')
    assert.equal(normalizeModel('deepseek_41_flash'), 'deepseek41flash')
    assert.equal(normalizeModel('deepseek 41 flash'), 'deepseek41flash')
  })
})

describe('tableRateOf', () => {
  test('the same model prices alike however it is spelled', () => {
    // The spellings the running harness actually emits for one model.
    for (const id of ['deepseek-V4.1-Flash', 'deepseek4.1flash', 'deepseek41flash', 'deepseek_v4.1_flash']) {
      assert.deepEqual(tableRateOf(id), FLASH41, id + ' must price as the flash tier')
    }
  })

  test('a tier beats its family: flash is not priced as plain v4.1', () => {
    assert.deepEqual(tableRateOf('deepseek-v4.1-flash'), FLASH41)
    assert.deepEqual(tableRateOf('deepseek-v4.1'), V41)
    assert.notDeepEqual(tableRateOf('deepseek-v4.1-flash'), tableRateOf('deepseek-v4.1'))
  })

  test('older generations still price, so an old session is not a dash', () => {
    assert.deepEqual(tableRateOf('deepseek-v3.2'), V32)
  })

  test('other vendors price too, for cross-model comparison', () => {
    assert.deepEqual(tableRateOf('claude-sonnet-4'), SONNET)
  })

  test('a model the table does not carry prices null rather than guessing', () => {
    assert.equal(tableRateOf('mystery-model'), null)
    assert.equal(tableRateOf(''), null)
  })
})

describe('priceOf', () => {
  test('prices from the table and ignores the provider and the book', () => {
    assert.deepEqual(priceOf(BOOK, 'deepseek-official', 'deepseek-v4.1-flash'), FLASH41)
    // One model, several provider spellings — one price.
    assert.deepEqual(priceOf(BOOK, 'anything-at-all', 'deepseek41flash'), FLASH41)
  })

  test('an unknown model prices null even when a book is supplied', () => {
    assert.equal(priceOf(BOOK, 'deepseek', 'mystery'), null)
  })

  test('the book argument no longer gates the price', () => {
    // A null book used to price nothing; the table is the source now.
    assert.deepEqual(priceOf(null, 'deepseek-official', 'deepseek-v4.1-flash'), FLASH41)
    assert.deepEqual(priceOf(undefined, '', 'deepseek-v4.1-flash'), FLASH41)
  })
})

describe('estimateSessionCost', () => {
  test('null usage or an absent book argument prices to null', () => {
    assert.equal(estimateSessionCost(null, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, BOOK, 'cny'), null)
    assert.equal(estimateSessionCost({}, null, 'usd'), null)
  })

  test('usage without any priced model returns null', () => {
    assert.equal(estimateSessionCost({}, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost({ 'deepseek-official': { unknown: { peak: bucket(0, M, 0, 0) } } }, BOOK, 'usd'), null)
  })

  test('prices every period bucket at its own rate (hit / miss / write / out)', () => {
    // v4.1 off-peak: 1M of each bucket at its rate; sonnet peak doubles.
    const usage = {
      'deepseek-official': { 'deepseek-v4.1': { off: bucket(M, M, M, M) } },
      'anthropic': { 'claude-sonnet-4': { off: bucket(0, M, 0, 0) } },
    }
    close(estimateSessionCost(usage, BOOK, 'usd'), (0.14 + 1.4 + 1.4 + 2.8) + 3)
  })

  test('peak buckets price at twice the table rate for DeepSeek only', () => {
    const split = { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) }
    // flash miss 0.7 -> peak 1.4, off 0.7
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4.1-flash': split } }, BOOK, 'usd'), 1.4 + 0.7)
    // A non-DeepSeek provider bills both buckets flat: no doubling.
    close(
      estimateSessionCost({ anthropic: { 'claude-sonnet-4': split } }, BOOK, 'usd'),
      3 + 3,
      'a non-DeepSeek provider bills a peak bucket at the table rate, never doubled',
    )
  })

  test('a missing model is skipped while priced ones still sum', () => {
    const usage = { anthropic: { 'claude-sonnet-4': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK, 'usd'), 3)
  })

  test('the CNY currency converts the USD total at 1 CNY = 0.15 USD', () => {
    // 1M off-peak flash miss = $0.7 -> ¥0.7/0.15
    const usage = { 'deepseek-official': { 'deepseek-v4.1-flash': { off: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK, 'cny'), 0.7 / 0.15)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4.1-flash': { peak: garbage } } }, BOOK, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    // peak flash: 1M cacheRead at 0.07 + 0.5M write at 0.7, all doubled
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4.1-flash': { peak: mixed } } }, BOOK, 'usd'), 2 * (0.07 + 0.5 * 0.7))
  })

  test('hostile provider branches, periods, and buckets are skipped, not fatal', () => {
    const usage = {
      junk: 'x',
      anthropic: { broken: null, 'claude-sonnet-4': { peak: 'junk', off: bucket(0, M, 0, 0) } },
      'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(0, M, 0, 0) } },
    } as unknown as { [provider: string]: Record<string, Record<string, CostBucketTotals>> }
    close(estimateSessionCost(usage, BOOK, 'usd'), 1.4 + 3)
  })
})

describe('mergeCostUsage', () => {
  test('sums every bucket across usages, keyed by provider, model, and period', () => {
    const merged = mergeCostUsage(
      { 'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(M, 0, 0, 0) } } },
      {
        'deepseek-official': {
          'deepseek-v4.1-flash': { peak: bucket(2 * M, 0, 0, 0), off: bucket(0, M, 0, 0) },
          'deepseek-v4.1': { peak: bucket(0, 0, 0, M) },
        },
        'anthropic': { 'claude-sonnet-4': { peak: bucket(0, 3 * M, 0, 0) } },
      },
    )
    assert.deepEqual(merged, {
      'deepseek-official': {
        'deepseek-v4.1-flash': { peak: bucket(3 * M, 0, 0, 0), off: bucket(0, M, 0, 0) },
        'deepseek-v4.1': { peak: bucket(0, 0, 0, M) },
      },
      'anthropic': { 'claude-sonnet-4': { peak: bucket(0, 3 * M, 0, 0) } },
    })
  })

  test('the merged estimate equals the sum of the sides priced apart', () => {
    const a = { 'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(M, M, 0, 0) } } }
    const b = { 'anthropic': { 'claude-sonnet-4': { peak: bucket(0, 2 * M, 0, 0) } } }
    const total = estimateSessionCost(mergeCostUsage(a, b), BOOK, 'usd')
    close(total ?? 0, (estimateSessionCost(a, BOOK, 'usd') ?? 0) + (estimateSessionCost(b, BOOK, 'usd') ?? 0))
  })

  test('null and absent sides drop out; nothing usable merges to null', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(M, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(null, usage, undefined), usage)
    assert.equal(mergeCostUsage(null, undefined, null), null)
    assert.equal(mergeCostUsage(), null)
  })

  test('a bucket that merged with only zeros still counts (the estimator prices $0, not a dash)', () => {
    const zero = { 'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(0, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(zero), zero)
    assert.equal(estimateSessionCost(mergeCostUsage(zero), BOOK, 'usd'), 0)
  })

  test('hostile branches are skipped, not fatal, and the inputs never mutate', () => {
    const a = { 'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(M, 0, 0, 0) } } }
    const hostile = {
      junk: 5,
      arr: [{ peak: bucket(M, 0, 0, 0) }],
      // A hostile sibling branch of the SAME provider as the good one, so the
      // merge must keep the good model under its own provider key.
      'deepseek-official': { broken: null, 'deepseek-v4.1': { peak: 'junk', off: bucket(0, M, 0, 0) } },
    } as unknown as Record<string, never>
    const merged = mergeCostUsage(a, hostile)
    assert.deepEqual(merged, {
      'deepseek-official': {
        'deepseek-v4.1-flash': { peak: bucket(M, 0, 0, 0) },
        'deepseek-v4.1': { off: bucket(0, M, 0, 0) },
      },
    })
    assert.deepEqual(a, { 'deepseek-official': { 'deepseek-v4.1-flash': { peak: bucket(M, 0, 0, 0) } } }, 'the source usage stays untouched')
  })
})

describe('peakOf', () => {
  test('doubles every rate component so a peak figure can be shown beside the base', () => {
    assert.deepEqual(peakOf(FLASH41), { hit: 0.14, miss: 1.4, write: 1.4, out: 2.8 })
  })
})

describe('formatCost', () => {
  test('amounts of at least 1 use fixed two-decimal notation', () => {
    assert.equal(formatCost(3.456, 'usd'), '$3.46')
    assert.equal(formatCost(1, 'usd'), '$1.00')
  })

  test('amounts below 1 use two-significant-digit precision', () => {
    assert.equal(formatCost(0.014, 'usd'), '$0.014')
    assert.equal(formatCost(0.5, 'usd'), '$0.50')
  })

  test('the CNY currency uses the yen symbol', () => {
    assert.equal(formatCost(12.3, 'cny'), '¥12.30')
    assert.equal(formatCost(0.66, 'cny'), '¥0.66')
  })
})

describe('formatPriceRate', () => {
  test('trims trailing zeros from a fixed-notation figure', () => {
    assert.equal(formatPriceRate(3.0, 'cny'), '¥3')
    assert.equal(formatPriceRate(4.5, 'cny'), '¥4.5')
  })

  test('trims trailing zeros from a precision-notation figure', () => {
    assert.equal(formatPriceRate(0.007, 'usd'), '$0.007')
    assert.equal(formatPriceRate(0.1, 'usd'), '$0.1')
  })

  test('strips the dot left behind when every decimal was a zero', () => {
    assert.equal(formatPriceRate(9.0, 'cny'), '¥9')
    assert.equal(formatPriceRate(1.5, 'cny'), '¥1.5')
  })
})