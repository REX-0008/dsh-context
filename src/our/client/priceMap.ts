/**
 * The model-price mapping: which registry vendor and model id a locally billed
 * (provider, model) pair should price from.
 *
 * Why it exists: a local route is a GATEWAY, not a vendor. This deployment's
 * routes are named by their own keys (`dycp`, `workbuddy`, `trae`) and none of
 * them is a models.dev provider id, so upstream's provider-rename seam finds no
 * branch and the model-side index refuses on ambiguity (28 vendors sell
 * `glm-5.3-flash` at different rates). A gateway also resells SEVERAL vendors
 * through one key, so one provider rename cannot express it, and vendor model
 * spellings differ per route (`glm-5.3-flash` vs `glm-5-3-flash-260828`).
 *
 * The mapping answers it per (route, model) pair instead: look past the route
 * and price the MODEL at its own vendor. Mechanical first — the family of the
 * model id names the vendor, and a normalized id match names the model — with a
 * stored manual override per row for whatever the mechanical pass cannot settle.
 *
 * Never invents a number: a row with no resolved target has no rate, and the
 * cost cells keep their dash (`estimateSessionCost` prices only what it can).
 * @module @our/context-panel-write/our/client/priceMap
 */

/** The registry vendor + its model id one local pair prices from. */
export interface PriceTarget {
  /** The models.dev provider id (e.g. `zai`, `deepseek`, `volcengine`). */
  vendor: string
  /** The model id as that vendor's branch spells it. */
  model: string
}

/**
 * Where a row's price actually comes from.
 * - `override`: the row was edited by hand;
 * - `mapped`: the mechanical family+fold pass resolved it;
 * - `upstream`: no mapping resolved, but upstream's own ladder prices it
 *   (a unique-carrier model id, or a route that IS a registry vendor) — the row
 *   still shows those rates, because that is what the estimate uses;
 * - `none`: nothing prices it, and a manual pick is the way to fix it.
 */
export type PriceSource = 'override' | 'mapped' | 'upstream' | 'none'

/** Manual overrides, keyed by {@link rowKey}. */
export type PriceMapOverrides = Record<string, PriceTarget>

/** The separator inside a row key: neither a provider key nor a model id holds it. */
const KEY_SEP = '\u0000'

/**
 * The row key: the local route plus the local model id.
 *
 * This pair IS the identity the fold bills under (`state.cost[provider][model]`),
 * so it is stable across sessions and needs no extra bookkeeping.
 * @param provider - the local route key as the request envelope spelled it.
 * @param model - the local model id as the request envelope spelled it.
 * @returns the lookup key.
 */
export function rowKey(provider: string, model: string): string {
  return provider + KEY_SEP + model
}

/** Split a {@link rowKey} back into its route and model parts. */
export function splitRowKey(key: string): { provider: string; model: string } {
  const at = key.indexOf(KEY_SEP)
  return at === -1 ? { provider: key, model: '' } : { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/**
 * Fold a model id to its comparison form: lower case, every separator run
 * collapsed to `-`, a trailing release stamp dropped, and a bare `v` version
 * prefix unwrapped.
 *
 * Load-bearing cases: `glm-5.3-flash` and `glm-5-3-flash-260828` both fold to
 * `glm-5-3-flash`; `deepseek-v4.1-flash` and `deepseek-v4-1-flash-260910` both
 * fold to `deepseek-4-1-flash`. Folding is only ever used to find a SUGGESTED
 * target — a wrong suggestion costs a manual pick, never a wrong rate.
 * @param id - the raw model id.
 * @returns the folded form.
 */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-_.\s]+/g, '-')
    .replace(/-\d{6,8}$/, '')
    .replace(/-v(\d)/g, '-$1')
}

/**
 * The registry vendor a model family belongs to.
 *
 * The route is deliberately not consulted: the same model reaches this code
 * through several gateway keys, and pricing it by its own vendor is what makes
 * the figures comparable. Ordered longest-family-first where one prefix nests
 * inside another.
 */
const FAMILY_VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^deepseek/, 'deepseek'],
  [/^(glm|chatglm)/, 'zai'],
  [/^(doubao|seed)/, 'volcengine'],
  [/^(hy\d|hunyuan)/, 'tencent-tokenhub'],
  [/^kimi|^moonshot/, 'moonshotai'],
  [/^minimax/, 'minimax'],
  [/^claude/, 'anthropic'],
  [/^(gpt-|o[134](-|$)|chatgpt)/, 'openai'],
  [/^gemini/, 'google'],
  [/^qwen/, 'alibaba'],
  [/^grok/, 'xai'],
]

/**
 * The vendor a model id belongs to, by its family prefix.
 * @param model - the local model id.
 * @returns the registry vendor id, or undefined when no family claims it.
 */
export function vendorForModel(model: string): string | undefined {
  const lower = model.toLowerCase()
  return FAMILY_VENDORS.find(([pattern]) => pattern.test(lower))?.[1]
}

/** One vendor branch, as far as runtime can prove it (the book is wire data). */
type VendorBranch = Record<string, unknown>

function branchOf(vendors: Record<string, VendorBranch | undefined>, vendor: string): VendorBranch | undefined {
  return vendors[vendor]
}

/**
 * The vendors tried BEFORE a model id's own family, in order.
 *
 * `opencode-go` (OpenCode Go) is a curated aggregator whose model ids are spelled
 * the way these gateways bill them — `deepseek-v4.1-flash` with the dot,
 * `glm-5.3-flash` — where the vendor's own branch often is not. It is a pricing
 * SOURCE, not a claim about who served the request: the rates are the list's.
 */
const PREFERRED_VENDORS: readonly string[] = ['opencode-go']

/** The id inside one vendor's branch whose folded spelling equals the wanted one. */
function modelInBranch(
  vendors: Record<string, VendorBranch | undefined>,
  vendor: string,
  wanted: string,
): string | null {
  const branch = branchOf(vendors, vendor)
  if (branch === undefined) return null
  let found: string | null = null
  for (const id of Object.keys(branch)) {
    if (normalizeModelId(id) !== wanted) continue
    if (found !== null && found !== id) return null
    found = id
  }
  return found
}

/**
 * The mechanical target for one local pair: a preferred aggregator first, then
 * the family's vendor, each supplying the model whose folded id equals the local
 * one's.
 *
 * A fold can be ambiguous (two ids in one vendor collapse together); that vendor
 * then settles nothing and the next is tried rather than letting row order pick
 * a rate.
 * @param model - the local model id.
 * @param vendors - the registry vendors with their model ids.
 * @returns the suggestion, or null when the mechanical pass cannot settle it.
 */
export function mechanicalTarget(
  model: string,
  vendors: Record<string, VendorBranch | undefined>,
): PriceTarget | null {
  const wanted = normalizeModelId(model)
  const family = vendorForModel(model)
  // A vendor that cannot settle the id (absent branch, ambiguous fold) is skipped
  // for the next; nothing is guessed when all of them refuse.
  for (const vendor of [...PREFERRED_VENDORS, ...(family === undefined ? [] : [family])]) {
    const found = modelInBranch(vendors, vendor, wanted)
    if (found !== null) return { vendor, model: found }
  }
  return null
}

/**
 * The target one row prices from: the stored override when it has one, else the
 * mechanical suggestion.
 *
 * The override wins unconditionally — that is the whole point of editing a row,
 * and it is also what keeps an edited row out of later mechanical passes
 * (existence of the override IS the "edited" marker; no separate dirty flag).
 * @param provider - the local route key.
 * @param model - the local model id.
 * @param vendors - the registry vendors with their model ids.
 * @param overrides - the stored per-row overrides.
 * @returns the target, or null when the row has neither.
 */
export function resolveTarget(
  provider: string,
  model: string,
  vendors: Record<string, VendorBranch | undefined>,
  overrides: PriceMapOverrides | undefined,
): { target: PriceTarget; edited: boolean } | null {
  const stored = overrides?.[rowKey(provider, model)]
  if (stored !== undefined && stored.vendor !== '' && stored.model !== '') {
    return { target: stored, edited: true }
  }
  const mechanical = mechanicalTarget(model, vendors)
  return mechanical === null ? null : { target: mechanical, edited: false }
}
