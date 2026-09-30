/**
 * Session-cost estimate — prices the host-folded cumulative billed-token totals
 * (SessionCostUsage) from THIS PLUGIN'S OWN price table (client/priceTable.ts).
 *
 * The figure is a COMPARISON BASELINE, not an invoice: the table is
 * hand-maintained with rough rates, and model ids resolve fuzzily, so two
 * spellings of one model price alike and different models or caching patterns
 * can be ranked against each other. Rates are USD per 1M tokens; the CNY display
 * converts at the fixed 1 CNY = 0.15 USD.
 *
 * Peak/off-peak is kept — a peak request costs double, which matters when
 * comparing — but there is no per-hour banding: the host already folds each
 * request into a `peak` or `off` bucket, so this layer only applies the
 * multiplier. The table lists off-peak rates, so only DeepSeek's `peak`
 * buckets price at double.
 */

import type { SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider } from '../shared/providers'
import { asRecord, numOf } from './services'
import { tableFaceOf } from './priceTable'

/** The display currencies the stats board ships; the locale picks one. */
export type CostCurrency = 'usd' | 'cny'

/** 1 CNY = 0.15 USD — the fixed CNY-display conversion rate. */
const USD_PER_CNY = 0.15

/** DeepSeek's peak rates are twice the off-peak rates (the official list). */
const PEAK_FACTOR = 2

/**
 * Per-1M-token rates (USD): cache-hit input, cache-miss input, cache
 * write, output (reasoning included).
 */
export interface PriceTriple { hit: number; miss: number; write: number; out: number }

/**
 * A provider → model → rates book.
 *
 * Kept only as the shape several call sites still thread through; the price
 * SOURCE is the hand-maintained table (client/priceTable.ts), and the pricing
 * functions below ignore this argument.
 */
export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** The delivered book (one modelPrices snap). See {@link ModelPrices}: vestigial. */
export interface ModelBook { prices: ModelPrices }

/**
 * One billed model's price: the matched table row's key (`mid` — the face
 * the stats board's tooltip prints) and its rates.
 */
export interface PriceFace { mid: string; rate: PriceTriple }

/** A USD amount in the display currency (CNY divides the fixed rate). */
export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/**
 * The table's face for one billed model: the matched row key and its rates,
 * or null when the table has no row for it.
 *
 * `book` and `provider` are NOT consulted: the table keys on the model id
 * alone, because the same model reaches this code through several provider ids
 * (an account gateway, a direct endpoint) and pricing those differently would
 * make one model look like several. Matching is the fuzzy containment in
 * `tableFaceOf`.
 * @param book - ignored; the table is the single price source.
 * @param provider - ignored; see above.
 * @param model - the model id to price.
 * @returns the face, or null when the table cannot price it.
 */
export function priceFaceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceFace | null {
  void book
  void provider
  return tableFaceOf(model)
}

/** {@link priceFaceOf} without the face. */
export function priceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceTriple | null {
  return priceFaceOf(book, provider, model)?.rate ?? null
}

/**
 * Price the session's cumulative billed-token totals. Cache reads bill at
 * the hit rate, uncached input at the miss rate, cache writes at the write
 * rate, output (reasoning included) at the out rate; `peak` buckets price
 * at twice the table rate for DeepSeek (the table lists off-peak rates —
 * the Host splits the period-based list at fold time).
 * Null when nothing was priced (no usage folded, or no model the table
 * prices), so the cell can show a dash.
 */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): number | null {
  if (usage === null || usage === undefined || book === null || book === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    // The doubled peak period is DeepSeek's alone (shared/providers): the
    // table lists its off-peak rates, so only the peak bucket multiplies —
    // every other provider bills every bucket at table price.
    const deepseek = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const rate = priceOf(book, provider, model)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        const price = (numOf(bucket.cacheRead) * rate.hit + numOf(bucket.uncached) * rate.miss
          + numOf(bucket.cacheWrite) * rate.write + numOf(bucket.output) * rate.out) / 1e6
        total += deepseek && period === 'peak' ? price * PEAK_FACTOR : price
        any = true
      }
    }
  }
  return any ? toCurrency(total, currency) : null
}

/**
 * Accumulate one usage's buckets into `out`, summing per (provider, model,
 * period). Hostile branches skip (the same re-proving the estimator applies
 * — the merge is a boundary too); true when any bucket record merged, even
 * an all-zero one (the estimator prices it as $0, never a dash).
 */
function mergeInto(out: SessionCostUsage, usage: SessionCostUsage | null | undefined): boolean {
  if (usage === null || usage === undefined) return false
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null || Array.isArray(models)) continue
    const branch = out[provider] ?? (out[provider] = {})
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const target = branch[model] ?? (branch[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        const prev = target[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        target[period] = {
          uncached: prev.uncached + numOf(bucket.uncached),
          cacheRead: prev.cacheRead + numOf(bucket.cacheRead),
          cacheWrite: prev.cacheWrite + numOf(bucket.cacheWrite),
          output: prev.output + numOf(bucket.output),
        }
        any = true
      }
    }
  }
  return any
}

/**
 * Deep-merge session-cost usages into one — the stats board's total-cost
 * scope (the current agent's usage plus every subagent session's) and the
 * subagent fold's accumulation. Null when NO side carried a bucket record,
 * so the caller keeps its dash.
 */
export function mergeCostUsage(...usages: (SessionCostUsage | null | undefined)[]): SessionCostUsage | null {
  const out: SessionCostUsage = {}
  let any = false
  for (const usage of usages) {
    if (mergeInto(out, usage)) any = true
  }
  return any ? out : null
}

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** Price-list figure: always two decimals (the tooltip's `¥ XX.XX` rate format). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + amount.toFixed(2)
}
