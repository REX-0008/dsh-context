// The hand-maintained price table (src/client/priceTable.ts): the fuzzy model
// resolution that keeps one model priced as one model however the log spells it,
// the display rows the settings panel lists, and the gap report that names the
// models left out of every comparison.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { normalizeModel, tableFaceOf, tableKeys, tableRateOf, tableRows, unpricedModels } from '../../src/client/priceTable'

describe('normalizeModel', () => {
  test('folds case and every separator, dots included', () => {
    // Dots count as separators, which is what makes `v4.1` and `41` one form.
    assert.equal(normalizeModel('deepseek-V4.1-Flash'), 'deepseekv41flash')
    assert.equal(normalizeModel('deepseek_4.1_flash'), 'deepseek41flash')
    assert.equal(normalizeModel('deepseek 4 1 flash'), 'deepseek41flash')
    assert.equal(normalizeModel(''), '')
  })
})

describe('tableRateOf', () => {
  test('one model prices alike however it is spelled', () => {
    const spellings = ['deepseek-V4.1-Flash', 'deepseek4.1flash', 'deepseek41flash', 'deepseek_v4.1_flash']
    const rates = spellings.map(id => tableRateOf(id))
    for (const rate of rates) assert.deepEqual(rate, rates[0])
    assert.notEqual(rates[0], null)
  })

  test('a specific tier beats its family', () => {
    const flash = tableRateOf('deepseek-v4.1-flash')
    const family = tableRateOf('deepseek-v4.1')
    assert.ok(flash !== null && family !== null)
    assert.notDeepEqual(flash, family, 'the flash tier must not price as the plain family row')
  })

  test('a date- or region-suffixed id still finds its row', () => {
    assert.deepEqual(tableRateOf('deepseek-v4-1-flash-260910'), tableRateOf('deepseek-v4.1-flash'))
    assert.deepEqual(tableRateOf('deepseek-v4.1-flash-sg'), tableRateOf('deepseek-v4.1-flash'))
  })

  test('an id no row covers prices null rather than guessing', () => {
    assert.equal(tableRateOf('mystery-model'), null)
    assert.equal(tableRateOf(''), null)
  })
})

describe('tableFaceOf', () => {
  test('names the matched row key beside its rates', () => {
    const face = tableFaceOf('deepseek-V4.1-Flash')
    assert.ok(face !== null)
    assert.equal(face.mid, '4.1-flash')
    assert.deepEqual(face.rate, tableRateOf('deepseek-V4.1-Flash'))
  })

  test('a model no row covers faces null, blanks included', () => {
    assert.equal(tableFaceOf('mystery-model'), null)
    assert.equal(tableFaceOf(''), null)
  })
})

describe('tableKeys', () => {
  test('lists every key, longest normalized form first', () => {
    const keys = tableKeys()
    const rows = tableRows()
    assert.equal(keys.length, rows.length)
    const lengths = keys.map(key => normalizeModel(key).length)
    for (let i = 1; i < lengths.length; i += 1) assert.ok(lengths[i - 1] >= lengths[i])
  })
})

describe('tableRows', () => {
  test('exposes each key beside its rates, in table order', () => {
    const rows = tableRows()
    assert.ok(rows.length > 0)
    for (const entry of rows) {
      assert.equal(typeof entry.key, 'string')
      assert.ok(entry.key !== '')
      for (const field of ['hit', 'miss', 'write', 'out'] as const) {
        assert.equal(typeof entry.row[field], 'number')
        assert.ok(Number.isFinite(entry.row[field]) && entry.row[field] >= 0)
      }
    }
    // The display rows are the same rows the resolver uses.
    assert.deepEqual(rows[0]?.row, tableRateOf(rows[0]?.key ?? ''))
  })
})

describe('unpricedModels', () => {
  test('reports only the ids no row covers, collapsing duplicates and blanks', () => {
    assert.deepEqual(
      unpricedModels(['deepseek-v4.1-flash', 'mystery-a', '', 'mystery-a', 'mystery-b', 'glm-5.3']),
      ['mystery-a', 'mystery-b'],
    )
  })

  test('an empty list reports nothing missing', () => {
    assert.deepEqual(unpricedModels([]), [])
  })

  test('every id priced reports nothing missing', () => {
    assert.deepEqual(unpricedModels(['deepseek-v4.1-flash', 'claude-sonnet-4']), [])
  })
})
