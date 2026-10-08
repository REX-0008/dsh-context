/**
 * The price-mapping runtime: keeps the observed local (route, model) pairs and
 * the stored overrides, and feeds both into the price book every consumer reads.
 *
 * How this reaches upstream's pricing without editing it: `cost.ts`
 * `priceFaceOf` looks up the dsh provider id's OWN branch FIRST and treats a
 * hit there as FINAL — an unknown model inside a carried branch prices null and
 * is never guessed past. Feeding the book a branch per local route therefore
 * prices that route's models with no upstream edit; the lookup ladder, the
 * ambiguity refusal, and the period handling all stay as upstream wrote them.
 *
 * Because a carried branch is final, that branch must be COMPLETE for every
 * model the route actually billed: a synthesized entry for one model would
 * otherwise strand its siblings. Each pair therefore resolves in two steps —
 * the mapping (override, else the mechanical family+fold pass), and failing
 * that, upstream's own answer read off the delivered book — and the branch is
 * written only once every observed model of that route has an entry.
 *
 * The RATES are never mutated in place: each pass rebuilds the price table from
 * `pristinePrices` (the book as delivered, kept aside for exactly this), so
 * re-running is idempotent and a route never sees its own synthesized output as
 * input. What the pass does publish is the rebuilt table on the delivered
 * object's `prices` — the one field consumers read.
 * @module @our/context-panel-write/our/client/priceBook
 */

import { priceFaceOf, type ModelBook, type ModelPrices, type PriceTriple } from '../../client/cost'
import { resolveTarget, type PriceMapOverrides, type PriceSource, type PriceTarget } from './priceMap'

/** One billed pair observed in the session list. */
export interface ObservedPair {
  /** The local route key the request envelope carried. */
  provider: string
  /** The local model id the request envelope carried. */
  model: string
}

/** One row of the mapping table, as the settings card renders it. */
export interface PriceMapRow {
  provider: string
  model: string
  /**
   * The mapping target: the stored override, else the mechanical suggestion.
   * Null when neither settled it — which is exactly when a manual pick helps,
   * even if upstream happens to price the row on its own.
   */
  target: PriceTarget | null
  /** The row carries a stored override (the "edited" marker). */
  edited: boolean
  /** Where the effective rate comes from. */
  source: PriceSource
  /** The effective rates, absent when nothing prices the row. */
  rate?: PriceTriple
}

/** The book the store published, and the price table exactly as delivered. */
let delivered: ModelBook | null = null
let pristinePrices: ModelPrices | null = null
let overrides: PriceMapOverrides = {}
let pairs: readonly ObservedPair[] = []
/**
 * The registry's own vendor ids, captured from the delivered book. A route in
 * this set is priced entirely by upstream and is never synthesized — writing
 * there could only shadow a real vendor branch.
 */
let registryVendors: ReadonlySet<string> = new Set()

/** The rate one mapped target carries in the delivered book, or undefined. */
function rateOfTarget(target: PriceTarget): PriceTriple | undefined {
  return pristinePrices?.[target.vendor]?.[target.model]
}

/**
 * The rate one pair prices at: the mapping first, then upstream's own answer.
 *
 * The second step is what keeps this strictly additive — every pair that prices
 * today keeps pricing, and only pairs upstream refused gain a figure.
 */
function rateOfPair(provider: string, model: string): PriceTriple | undefined {
  const resolved = resolveTarget(provider, model, pristinePrices ?? {}, overrides)
  if (resolved !== null) {
    const rate = rateOfTarget(resolved.target)
    if (rate !== undefined) return rate
  }
  // Upstream's own ladder, read off the untouched book (its index is built from
  // the delivered payload and is unaffected by anything written here).
  if (delivered === null || pristinePrices === null) return undefined
  return priceFaceOf({ prices: pristinePrices, index: delivered.index }, provider, model)?.rate
}

/**
 * Rebuild the price table: the delivered one, plus a complete synthesized branch
 * per local route. Idempotent — the pass always starts from the delivered table.
 */
function apply(): void {
  if (delivered === null || pristinePrices === null) return
  const byRoute = new Map<string, Set<string>>()
  for (const pair of pairs) {
    if (pair.provider === '' || pair.model === '' || registryVendors.has(pair.provider)) continue
    const models = byRoute.get(pair.provider) ?? new Set<string>()
    models.add(pair.model)
    byRoute.set(pair.provider, models)
  }
  const merged: ModelPrices = { ...pristinePrices }
  for (const [route, models] of byRoute) {
    const branch: Record<string, PriceTriple> = {}
    for (const model of models) {
      const rate = rateOfPair(route, model)
      if (rate !== undefined) branch[model] = rate
    }
    // An empty branch is left out entirely: a route upstream already prices
    // through its model index must keep that path, not gain a branch that would
    // terminate the lookup with nothing.
    if (Object.keys(branch).length > 0) merged[route] = branch
  }
  delivered.prices = merged
}

/** Adopt the delivered book. Called through the store's own subscription. */
export function noteBook(next: ModelBook): void {
  delivered = next
  pristinePrices = next.prices
  registryVendors = new Set(Object.keys(next.prices))
  apply()
  bump()
}

/**
 * Replace the observed pairs and rebuild.
 *
 * An UNCHANGED pair set is a no-op, for the same reason `setOverrides` guards its
 * map: this is fed from the sessions list, which mutates on every streaming step,
 * so rebuilding unconditionally would recompute the price table and notify every
 * subscriber on each token while the panel is open.
 * @param next - the pairs observed now.
 */
export function noteObservedPairs(next: readonly ObservedPair[]): void {
  if (samePairs(pairs, next)) return
  pairs = next
  apply()
  bump()
}

/**
 * Whether two pair lists name the same (provider, model) set. ORDER is ignored:
 * the fold walks a snapshot's rows, whose order carries no meaning here, and a
 * reordered list would otherwise count as a change.
 * @param a - the current pairs.
 * @param b - the incoming pairs.
 * @returns whether they are the same set.
 */
function samePairs(a: readonly ObservedPair[], b: readonly ObservedPair[]): boolean {
  if (a.length !== b.length) return false
  const seen = new Set(a.map(p => p.provider + '\u0000' + p.model))
  for (const pair of b) if (!seen.has(pair.provider + '\u0000' + pair.model)) return false
  return true
}

/** Whether two override maps are equivalent (they are small: one row per pair). */
function sameOverrides(a: PriceMapOverrides, b: PriceMapOverrides): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    // Equal counts do not prove equal keys, and one side can come off the wire.
    if (!Object.hasOwn(b, key)) return false
    const left = a[key]
    const right = b[key]
    if (left.vendor !== right.vendor || left.model !== right.model) return false
  }
  return true
}

/**
 * Replace the mapping overrides and rebuild.
 *
 * An EQUAL map is a no-op. The table pushes what it renders, and rebuilding on
 * an equal map notified every subscriber for nothing — the shape that once grew
 * into an unbounded render loop and took the settings card down with it.
 */
export function setOverrides(next: PriceMapOverrides): void {
  if (sameOverrides(overrides, next)) return
  overrides = next
  apply()
  bump()
}

/** The overrides currently in force (the settings write reads this back). */
export function currentOverrides(): PriceMapOverrides {
  return overrides
}

/** The registry's real vendor branches, for the table's dropdowns. */
export function vendorBranches(): ModelPrices {
  return pristinePrices ?? {}
}

/**
 * Build the table's rows: one per observed pair, decorated with what it resolves
 * to and the rates it prices at.
 *
 * The overrides are a PARAMETER rather than read off this module's own state:
 * the caller's render must see the same map it is about to write back, and the
 * module-level copy is only settled by the sync effect, which runs after it.
 * @param observed - the pairs to render (the session list's billed keys).
 * @param current - the overrides to resolve against (the caller's own map).
 * @returns the rows in the order given.
 */
export function priceMapRows(observed: readonly ObservedPair[], current: PriceMapOverrides): PriceMapRow[] {
  return observed.map((pair) => {
    const resolved = resolveTarget(pair.provider, pair.model, vendorBranches(), current)
    const target = resolved?.target ?? null
    const edited = resolved?.edited ?? false
    const mapped = target === null ? undefined : rateOfTarget(target)
    if (mapped !== undefined) {
      return {
        provider: pair.provider,
        model: pair.model,
        target,
        edited,
        source: edited ? 'override' : 'mapped',
        rate: mapped,
      }
    }
    // An edited row stays marked as such even when its target cannot be priced
    // (a stale pick, or a book that has not landed): the origin is the user's
    // decision, and saying "unmatched" would hide that it was set by hand.
    if (edited) {
      return { provider: pair.provider, model: pair.model, target, edited, source: 'override' }
    }
    // No mapping landed: report whatever upstream charges for this pair, so the
    // table shows the figure the estimate actually uses rather than a blank.
    const upstream = effectiveRate(pair.provider, pair.model)
    return {
      provider: pair.provider,
      model: pair.model,
      target,
      edited,
      source: upstream === undefined ? 'none' : 'upstream',
      ...(upstream === undefined ? {} : { rate: upstream }),
    }
  })
}

/** The rate a pair prices at on the delivered book, travelling upstream's ladder. */
export function effectiveRate(provider: string, model: string): PriceTriple | undefined {
  return rateOfPair(provider, model)
}

/** The rate a candidate target would price at (the table's price column). */
export function rateForTarget(target: PriceTarget): PriceTriple | undefined {
  return rateOfTarget(target)
}

// ---- the render read --------------------------------------------------------

/**
 * The observable the settings card binds: a bare revision counter.
 *
 * The card needs to re-render when the book lands (its rows and dropdown options
 * are derived from it). Following the framework's rule that only the inject
 * hooks compartment carries bare observables, this is a plain source the renderer
 * binds — no subscription machinery in the component itself.
 */
const listeners = new Set<() => void>()
let revision = 0

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** The hook seat's source: identity-stable snapshot, notified on every change. */
export const priceMapStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot: (): number => revision,
}

/** The registry's vendor ids with their display names, for the vendor dropdown. */
export function vendorChoices(): Array<{ id: string; name: string }> {
  return Object.keys(vendorBranches()).sort().map(id => ({ id, name: id }))
}

/** One vendor's model ids (the model dropdown's options for a chosen vendor). */
export function modelChoices(vendor: string): string[] {
  const branches = vendorBranches()
  return Object.hasOwn(branches, vendor) ? Object.keys(branches[vendor]).sort() : []
}

/** Test isolation: forget the book, the pairs, and the overrides. */
export function resetPriceBook(): void {
  delivered = null
  pristinePrices = null
  overrides = {}
  pairs = []
  registryVendors = new Set()
}
