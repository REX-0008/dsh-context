// The price mapping's pure core (src/our/client/priceMap.ts): row identity,
// model-id folding, the family-to-vendor decision, and the override/mechanical
// precedence. Rates live in the caller's book, so every case here is
// deterministic and offline.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  mechanicalTarget,
  normalizeModelId,
  resolveTarget,
  rowKey,
  splitRowKey,
  vendorForModel,
  type PriceMapOverrides,
} from '../../src/our/client/priceMap'

/** A vendor map in the shape the book exposes (ids only; rates are the book's). */
const VENDORS = {
  zai: { 'glm-5.3-flash': {}, 'glm-5.2': {}, 'glm-5.3': {} },
  deepseek: { 'deepseek-flash': {}, 'deepseek-v4-flash': {}, 'deepseek-v4-pro': {} },
  volcengine: { 'glm-5-3-flash-260828': {}, 'deepseek-v4-flash-ga-260731': {}, 'doubao-seed-2-1-pro-260628': {} },
  'tencent-tokenhub': { 'hy4-preview': {} },
}

describe('row identity', () => {
  test('a key round-trips through its own separator', () => {
    const key = rowKey('dycp', 'glm-5.3-flash')
    assert.deepEqual(splitRowKey(key), { provider: 'dycp', model: 'glm-5.3-flash' })
  })

  test('a key without the separator yields the provider and an empty model', () => {
    assert.deepEqual(splitRowKey('dycp'), { provider: 'dycp', model: '' })
  })

  test('the pair distinguishes two routes billing one model', () => {
    assert.notEqual(rowKey('dycp', 'm'), rowKey('workbuddy', 'm'))
  })
})

describe('normalizeModelId', () => {
  test('separator runs collapse, so dotted and dashed spellings meet', () => {
    assert.equal(normalizeModelId('glm-5.3-flash'), 'glm-5-3-flash')
    assert.equal(normalizeModelId('glm-5_3 flash'), 'glm-5-3-flash')
    assert.equal(normalizeModelId('GLM-5.3-Flash'), 'glm-5-3-flash')
  })

  test('a trailing release stamp drops', () => {
    assert.equal(normalizeModelId('glm-5-3-flash-260828'), 'glm-5-3-flash')
    assert.equal(normalizeModelId('glm-5-2-260617'), 'glm-5-2')
    assert.equal(normalizeModelId('deepseek-v4-flash-ga-260731'), 'deepseek-4-flash-ga')
  })

  test('a bare v version prefix unwraps', () => {
    assert.equal(normalizeModelId('deepseek-v4.1-flash'), 'deepseek-4-1-flash')
    assert.equal(normalizeModelId('deepseek-v4-1-flash-260910'), 'deepseek-4-1-flash')
  })
})

describe('vendorForModel', () => {
  test('each family names its vendor', () => {
    assert.equal(vendorForModel('glm-5.3-flash'), 'zai')
    assert.equal(vendorForModel('chatglm-4'), 'zai')
    assert.equal(vendorForModel('deepseek-v4.1-flash'), 'deepseek')
    assert.equal(vendorForModel('doubao-seed-2-1-pro'), 'volcengine')
    assert.equal(vendorForModel('hy4-preview'), 'tencent-tokenhub')
    assert.equal(vendorForModel('hunyuan-large'), 'tencent-tokenhub')
    assert.equal(vendorForModel('kimi-k3'), 'moonshotai')
    assert.equal(vendorForModel('minimax-m3'), 'minimax')
    assert.equal(vendorForModel('claude-sonnet-4-5'), 'anthropic')
    assert.equal(vendorForModel('gpt-5.4'), 'openai')
    assert.equal(vendorForModel('o3-mini'), 'openai')
    assert.equal(vendorForModel('gemini-3-pro'), 'google')
    assert.equal(vendorForModel('qwen-max'), 'alibaba')
    assert.equal(vendorForModel('grok-4'), 'xai')
  })

  test('an unknown family resolves to no vendor', () => {
    assert.equal(vendorForModel('some-local-model'), undefined)
  })
})

describe('mechanicalTarget', () => {
  test('a folded id match names the model', () => {
    assert.deepEqual(mechanicalTarget('glm-5.3-flash', VENDORS), { vendor: 'zai', model: 'glm-5.3-flash' })
    assert.deepEqual(mechanicalTarget('glm-5-2-260617', VENDORS), { vendor: 'zai', model: 'glm-5.2' })
    assert.deepEqual(mechanicalTarget('hy4-preview', VENDORS), { vendor: 'tencent-tokenhub', model: 'hy4-preview' })
  })

  test('an unknown family or absent vendor resolves to nothing', () => {
    assert.equal(mechanicalTarget('mystery-model', VENDORS), null)
    assert.equal(mechanicalTarget('kimi-k3', VENDORS), null)
  })

  test('a vendor with no branch resolves to nothing', () => {
    assert.equal(mechanicalTarget('glm-5.3-flash', {}), null)
  })

  test('an ambiguous fold refuses rather than picking by row order', () => {
    const both = { zai: { 'glm-5.2': {}, 'glm-5-2': {} } }
    assert.equal(mechanicalTarget('glm-5.2', both), null)
  })

  test('a repeated spelling is one candidate, not an ambiguity', () => {
    const same = { zai: { 'glm-5.2': {} } }
    assert.deepEqual(mechanicalTarget('glm-5-2-260617', same), { vendor: 'zai', model: 'glm-5.2' })
  })

  test('a preferred aggregator wins over the model\'s own family', () => {
    // opencode-go is tried first: its ids are spelled the way these gateways bill.
    const vendors = { 'opencode-go': { 'glm-5.3-flash': {} }, zai: { 'glm-5.3-flash': {} } }
    assert.deepEqual(mechanicalTarget('glm-5.3-flash', vendors), { vendor: 'opencode-go', model: 'glm-5.3-flash' })
  })

  test('the family answers when the aggregator cannot settle the id', () => {
    const vendors = { 'opencode-go': { 'glm-5.2': {} }, zai: { 'glm-5.3-flash': {} } }
    assert.deepEqual(mechanicalTarget('glm-5.3-flash', vendors), { vendor: 'zai', model: 'glm-5.3-flash' })
  })

  test('an aggregator with an ambiguous fold falls through to the family', () => {
    const vendors = { 'opencode-go': { 'glm-5.3-flash': {}, 'glm-5-3-flash': {} }, zai: { 'glm-5.3-flash': {} } }
    assert.deepEqual(mechanicalTarget('glm-5-3-flash', vendors), { vendor: 'zai', model: 'glm-5.3-flash' })
  })

  test('with neither an aggregator nor a family, nothing is guessed', () => {
    assert.equal(mechanicalTarget('mystery-model', { 'opencode-go': { 'glm-5.2': {} } }), null)
  })
})

describe('resolveTarget', () => {
  test('the mechanical pass answers when no override exists', () => {
    const resolved = resolveTarget('dycp', 'glm-5.3-flash', VENDORS, undefined)
    assert.deepEqual(resolved, { target: { vendor: 'zai', model: 'glm-5.3-flash' }, edited: false })
  })

  test('a stored override wins and marks the row edited', () => {
    const overrides: PriceMapOverrides = { [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } }
    const resolved = resolveTarget('dycp', 'glm-5.3-flash', VENDORS, overrides)
    assert.deepEqual(resolved, { target: { vendor: 'zai', model: 'glm-5.2' }, edited: true })
  })

  test('an override on an unresolvable row still answers, marked edited', () => {
    const overrides: PriceMapOverrides = { [rowKey('dycp', 'mystery')]: { vendor: 'zai', model: 'glm-5.2' } }
    assert.deepEqual(resolveTarget('dycp', 'mystery', VENDORS, overrides), {
      target: { vendor: 'zai', model: 'glm-5.2' },
      edited: true,
    })
  })

  test('a half-filled override falls through to the mechanical pass', () => {
    const overrides: PriceMapOverrides = { [rowKey('dycp', 'glm-5.3-flash')]: { vendor: '', model: '' } }
    const resolved = resolveTarget('dycp', 'glm-5.3-flash', VENDORS, overrides)
    assert.deepEqual(resolved, { target: { vendor: 'zai', model: 'glm-5.3-flash' }, edited: false })
  })

  test('an override on another row leaves this one mechanical', () => {
    const overrides: PriceMapOverrides = { [rowKey('workbuddy', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } }
    const resolved = resolveTarget('dycp', 'glm-5.3-flash', VENDORS, overrides)
    assert.equal(resolved?.edited, false)
  })

  test('nothing resolves without a mapping or an override', () => {
    assert.equal(resolveTarget('dycp', 'mystery', VENDORS, undefined), null)
  })
})
