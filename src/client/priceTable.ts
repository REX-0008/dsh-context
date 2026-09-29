/**
 * A hand-maintained price table for cost estimation.
 *
 * Why not the vendor's exact rates: the goal is not "what did this cost" but
 * "which model and which caching pattern is expensive", compared ACROSS models.
 * A rough, maintained baseline answers that, and it does not go stale the way a
 * scraped registry does. Rates are USD per 1M tokens.
 *
 * Model resolution is deliberately FUZZY. One model reaches this code under
 * several spellings — `deepseek-V4.1-Flash`, `deepseek4.1flash`,
 * `deepseek41flash` — and pricing those differently would make one model look
 * like several tiers. So a key holds only the DISTINGUISHING fragment (the
 * version and tier), never the vendor name: the vendor is shared by every
 * spelling and would only dilute the match. Matching is containment on the
 * normalized id, longest key first.
 *
 * Peak/off-peak: the split is kept because it changes the comparison (a peak
 * request costs double), but there is no per-hour banding — the host already
 * folds each request into `peak` or `off`, so this table only carries the
 * multiplier's base rates.
 *
 * Editing: change a number here. Nothing else reads vendor prices.
 * @module @our/context-panel-write/client/priceTable
 */

import type { PriceTriple } from './cost'

/** USD per 1M tokens. `hit` = cache read, `miss` = uncached input, `write` = cache write, `out` = output. */
interface TableRow {
  /** The distinguishing fragment of a model id, normalized for matching. */
  key: string
  row: PriceTriple
}

const ROWS: TableRow[] = [
  // DeepSeek V4.1 family — the tier is what separates the rows.
  { key: '4.1-flash', row: { hit: 0.07, miss: 0.7, write: 0.7, out: 1.4 } },
  { key: '4.1', row: { hit: 0.14, miss: 1.4, write: 1.4, out: 2.8 } },
  // The v4 family, which the harness also spells without the minor version
  // (`deepseek-v4-flash`). Kept as its own row so those sessions price too.
  { key: '4-flash', row: { hit: 0.07, miss: 0.7, write: 0.7, out: 1.4 } },
  { key: '4', row: { hit: 0.14, miss: 1.4, write: 1.4, out: 2.8 } },
  // Older DeepSeek generations, kept so an old session still prices.
  { key: '3.2', row: { hit: 0.028, miss: 0.28, write: 0.28, out: 0.42 } },
  { key: '3.1', row: { hit: 0.07, miss: 0.56, write: 0.56, out: 1.68 } },
  { key: 'r1', row: { hit: 0.14, miss: 0.55, write: 0.55, out: 2.19 } },
  // Other vendors, for the same rough comparison. Their keys are similarly
  // distinguishing-only where the family name is not needed to tell them apart.
  { key: 'glm-5', row: { hit: 0.1, miss: 0.6, write: 0.6, out: 2.2 } },
  { key: 'glm', row: { hit: 0.1, miss: 0.6, write: 0.6, out: 2.2 } },
  { key: 'opus', row: { hit: 1.5, miss: 15, write: 18.75, out: 75 } },
  { key: 'sonnet', row: { hit: 0.3, miss: 3, write: 3.75, out: 15 } },
  { key: 'haiku', row: { hit: 0.1, miss: 1, write: 1.25, out: 5 } },
  { key: 'gpt-5', row: { hit: 0.15, miss: 1.5, write: 1.5, out: 12 } },
  // A later GPT generation with no published rate of its own yet: priced at the
  // same ballpark rather than left as a dash, since a missing row would silently
  // drop the model from every comparison the board makes.
  { key: 'gpt-6', row: { hit: 0.15, miss: 1.5, write: 1.5, out: 12 } },
  { key: 'gemini', row: { hit: 0.1, miss: 0.8, write: 0.8, out: 3.2 } },
  { key: 'kimi', row: { hit: 0.07, miss: 0.6, write: 0.6, out: 2.4 } },
]

/**
 * Fold a model id to the form the table keys are written in: lower case with
 * every separator removed.
 *
 * Dots count as separators, and that is load-bearing: without it `v4.1` and
 * `41` would not collapse to one form, and `deepseek41flash` would fail to
 * match the key `4.1-flash`.
 * @param id - the raw model id.
 * @returns the normalized form.
 */
export function normalizeModel(id: string): string {
  return id.toLowerCase().replace(/[-_.\s]/g, '')
}

/**
 * Resolve a model id to its table row.
 *
 * Containment with the LONGEST key winning, which is what makes the fuzzy
 * spellings resolve to one row while a tier still beats its family (`4.1-flash`
 * over `4.1`). Keys exclude the vendor name so that advantage is not swamped by
 * a prefix every spelling shares.
 * @param model - the model id as the log spells it.
 * @returns the rates, or null when the table has no row for it.
 */
export function tableRateOf(model: string): PriceTriple | null {
  const target = normalizeModel(model)
  if (target === '') return null
  let best: TableRow | null = null
  for (const candidate of ROWS) {
    const key = normalizeModel(candidate.key)
    if (key === '' || !target.includes(key)) continue
    if (best === null || key.length > normalizeModel(best.key).length) best = candidate
  }
  return best === null ? null : best.row
}

/** The keys this table carries, longest first (useful when a model is unpriced). */
export function tableKeys(): string[] {
  return ROWS.map(entry => entry.key).sort((a, b) => normalizeModel(b).length - normalizeModel(a).length)
}

/**
 * The table's rows for display: every key with its rates, in table order.
 *
 * The settings panel lists these so the maintained figures are visible where
 * they are edited, rather than only reachable by reading the source.
 * @returns one entry per row.
 */
export function tableRows(): Array<{ key: string; row: PriceTriple }> {
  return ROWS.map(entry => ({ key: entry.key, row: entry.row }))
}

/**
 * Which of the given model ids the table cannot price.
 *
 * The panel uses this to report gaps when its price list is opened: a model in
 * use with no row silently drops out of every cost comparison, so the gap is
 * worth surfacing where the table is maintained.
 * @param models - the model ids to check (duplicates are collapsed).
 * @returns the distinct ids with no matching row, in first-seen order.
 */
export function unpricedModels(models: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (model === '' || seen.has(model)) continue
    seen.add(model)
    if (tableRateOf(model) === null) out.push(model)
  }
  return out
}
