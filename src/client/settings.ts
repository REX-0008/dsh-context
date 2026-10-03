/**
 * The plugin's user-settings binding (browser half). The Host-served
 * `dsh-context` namespace carries per-user display preferences; the Context
 * tab reads them at mount, and the Plugin configuration card (Settings →
 * Plugins) writes them through the settings scope. Both degrade to the
 * schema defaults when the settings surface is absent (older host) or
 * read-only (remote browser in memory mode).
 *
 * The scope faces are minimally re-typed here (the services.ts discipline):
 * the runtime service comes from the user's harness, and type-only imports
 * of the contract package would still be erased — spelling the consumed
 * members keeps the dependency graph honest.
 */

import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, SettingsField } from '../shared/types'

// The preference vocabulary is declared once in shared/types.ts; re-exported
// here so client-side consumers keep their canonical import path.
export type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, SettingsField } from '../shared/types'

/** The bound settings scope (ctx.settingsScope.bind result), as consumed. */
export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** The ctx.settingsScope binder face, as consumed. */
export interface SettingsScopeBinderFace {
  bind(spec: { namespace: string }): SettingsScopeLike
}

/**
 * The ctx.configForms service face (the Config-form generation's settings
 * transport), as consumed: forms bind per namespace, and `whileServed` keeps
 * a registration alive while the Host serves any of them. The bound form
 * satisfies {@link SettingsScopeLike} (same snapshot/subscribe/set shape).
 */
export interface ConfigFormsFace {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

/** The preference snapshot the card renders and the view reads at mount. */
export interface SettingsState {
  /** Scope sync: loading until the first Host section, unavailable when unserved. */
  status: 'loading' | 'ready' | 'unavailable'
  placement: DefaultPlacement
  granularity: DefaultGranularity
  mode: DefaultTrendMode
  deltaBase: DefaultDeltaBase
  toolSort: DefaultToolSort
  fileSort: DefaultFileSort
  insightsEntry: InsightsEntry
  writable: boolean
}

export interface ContextSettings {
  /** Observable snapshot store, bound onto card props as `useContextSettings`. */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  /**
   * The stored model-price mapping overrides (`settings.priceMap`), read off the
   * same scope snapshot the preferences come from. Empty until the Host serves
   * them, which is also the "every row is mechanical" state.
   */
  priceMap(): Record<string, { vendor: string; model: string }>
  /** Replace the stored overrides wholesale (the table owns the whole map). */
  setPriceMap(next: Record<string, { vendor: string; model: string }>): void
  defaultPlacement(): DefaultPlacement
  defaultGranularity(): DefaultGranularity
  defaultTrendMode(): DefaultTrendMode
  defaultDeltaBase(): DefaultDeltaBase
  defaultToolSort(): DefaultToolSort
  defaultFileSort(): DefaultFileSort
  insightsEntry(): InsightsEntry
  attach(scope: SettingsScopeLike): () => void
  /** Persist one preference choice (local echo, then the fenced scope write). */
  set(field: SettingsField, value: string): void
}

type Prefs = {
  placement?: DefaultPlacement
  granularity?: DefaultGranularity
  mode?: DefaultTrendMode
  deltaBase?: DefaultDeltaBase
  toolSort?: DefaultToolSort
  fileSort?: DefaultFileSort
  insightsEntry?: InsightsEntry
}

function prefsOf(value: unknown): Prefs {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultPlacement === 'all' || v.defaultPlacement === 'tab' || v.defaultPlacement === 'sidebar' ? { placement: v.defaultPlacement } : {}),
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
    ...(v.defaultDeltaBase === 'step' || v.defaultDeltaBase === 'turn' ? { deltaBase: v.defaultDeltaBase } : {}),
    ...(v.defaultToolSort === 'size' || v.defaultToolSort === 'count' || v.defaultToolSort === 'name' ? { toolSort: v.defaultToolSort } : {}),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path' ? { fileSort: v.defaultFileSort } : {}),
    ...(v.insightsEntry === 'show' || v.insightsEntry === 'hide' ? { insightsEntry: v.insightsEntry } : {}),
  }
}

/** The stored overrides in the shape the mapping table consumes. */
type PriceMap = Record<string, { vendor: string; model: string }>

/**
 * Validate a stored `priceMap` into overrides, dropping anything unusable.
 * @param stored - the raw field value.
 * @returns the usable overrides (empty when the field is absent or hostile).
 */
function mapOf(stored: unknown): PriceMap {
  const out: PriceMap = {}
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as { vendor?: unknown; model?: unknown }
    if (typeof entry.vendor !== 'string' || typeof entry.model !== 'string') continue
    out[key] = { vendor: entry.vendor, model: entry.model }
  }
  return out
}

/**
 * A mapping's identity by CONTENT: the Host hands each section update a fresh
 * object, so comparing references would report every read as a change.
 * @param map - the overrides.
 * @returns a comparable signature.
 */
function signatureOf(map: PriceMap): string {
  return Object.keys(map).sort().map(key => `${key}=${map[key].vendor}/${map[key].model}`).join('\u0000')
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', writable: false }
  let scope: SettingsScopeLike | undefined
  /** The last raw scope value: the price mapping and other non-preference fields read off it. */
  let raw: Record<string, unknown> | undefined
  /**
   * The price map, cached against the stored value it was derived from.
   *
   * Load-bearing: the mapping table syncs this map into the pricing runtime from
   * an effect keyed on its identity. Rebuilding the object on every read gave the
   * effect a new identity on every render, and each run notified the runtime,
   * which re-rendered the card — an unbounded update loop that took the whole
   * settings card down.
   */
  let priceMapCache: { source: unknown; value: PriceMap } | undefined
  /** The last mapping's content signature (see the sync note below). */
  let priceSignature: string | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SettingsState): boolean => {
    if (next.status === state.status && next.placement === state.placement && next.granularity === state.granularity
      && next.mode === state.mode && next.deltaBase === state.deltaBase && next.toolSort === state.toolSort
      && next.fileSort === state.fileSort && next.insightsEntry === state.insightsEntry && next.writable === state.writable) return false
    state = next
    for (const listener of listeners) listener()
    return true
  }
  // Republish from the bound scope's current snapshot; the attach sync and
  // the failed-write rollback share this one read. Returns the scope's valid
  // placement and insights entry, if it carries them.
  const sync = (bound: SettingsScopeLike): { placement?: DefaultPlacement; insightsEntry?: InsightsEntry } => {
    const snap = bound.getSnapshot()
    const prefs = prefsOf(snap.value)
    // Fail open: a config problem must never leave an entry hidden. A valid
    // value wins; one the plugin cannot understand degrades to the field's
    // default; a section without the field (older Host half) keeps the
    // current state.
    const nextRaw = snap.value !== null && typeof snap.value === 'object'
      ? snap.value as Record<string, unknown>
      : undefined
    // The pricing runtime reads the MAPPING, which the preference diff below does
    // not compare, so a mapping-only change would go unnotified: every mapped row
    // would stay unpriced until some unrelated preference moved. Track the
    // mapping's content (the Host re-sends a fresh object each time) and notify
    // when publish did not — this is what adopts the stored mapping at startup,
    // so pricing no longer depends on the settings card being open.
    const signature = signatureOf(mapOf(nextRaw?.priceMap))
    const mapChanged = signature !== priceSignature
    priceSignature = signature
    raw = nextRaw
    // Whether the preference diff already notified (see the mapping note below).
    const notified = publish({
      status: snap.status === 'ready' || snap.status === 'unavailable' ? snap.status : 'loading',
      placement: prefs.placement ?? (raw?.defaultPlacement === undefined ? state.placement : 'all'),
      granularity: prefs.granularity ?? state.granularity,
      mode: prefs.mode ?? state.mode,
      deltaBase: prefs.deltaBase ?? state.deltaBase,
      toolSort: prefs.toolSort ?? state.toolSort,
      fileSort: prefs.fileSort ?? state.fileSort,
      insightsEntry: prefs.insightsEntry ?? (raw?.insightsEntry === undefined ? state.insightsEntry : 'show'),
      writable: snap.writable,
    })
    // The price mapping reads `raw`, not the preference fields publish() diffs,
    // so a mapping-only change would otherwise go unnotified: the pricing runtime
    // would keep the map it read before this scope was first bound, leaving every
    // mapped row unpriced until something else moved. Notify exactly when publish
    // did not — never twice for one change. This is what adopts the stored mapping
    // at startup, so pricing no longer depends on the settings card being open.
    if (mapChanged && !notified) for (const listener of listeners) listener()
    return { placement: prefs.placement, insightsEntry: prefs.insightsEntry }
  }
  return {
    store: {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    priceMap() {
      const stored: unknown = raw?.priceMap
      if (priceMapCache !== undefined && priceMapCache.source === stored) return priceMapCache.value
      const value = mapOf(stored)
      priceMapCache = { source: stored, value }
      return value
    },
    setPriceMap(next) {
      // Optimistic echo, then the fenced scope write — the same shape the
      // preference setter uses, so a refused write recovers through the scope's
      // own re-read rather than leaving the table showing a value that never
      // persisted. The echo writes the whole field, so the rollback restores the
      // previous field value (absent means "no overrides", not "keep the echo").
      const before: unknown = raw?.priceMap
      const base: Record<string, unknown> = raw ?? {}
      raw = { ...base, priceMap: next }
      // Announce the new mapping directly: publish() diffs preferences only, so
      // the table's own write would otherwise never reach the pricing runtime.
      priceSignature = signatureOf(mapOf(next))
      for (const listener of listeners) listener()
      const bound = scope
      if (bound === undefined) return
      void bound.set('priceMap', next).catch(() => {
        // Roll the echo back to the scope's truth and re-announce: the runtime
        // must forget a mapping that never persisted.
        raw = before === undefined ? { ...base } : { ...base, priceMap: before }
        priceSignature = signatureOf(mapOf(before))
        for (const listener of listeners) listener()
      })
    },
    defaultPlacement: () => state.placement,
    defaultGranularity: () => state.granularity,
    defaultTrendMode: () => state.mode,
    defaultDeltaBase: () => state.deltaBase,
    defaultToolSort: () => state.toolSort,
    defaultFileSort: () => state.fileSort,
    insightsEntry: () => state.insightsEntry,
    attach(bound) {
      scope = bound
      sync(bound)
      return bound.subscribe(() => { sync(bound) })
    },
    set(field, value) {
      publish({ ...state, ...prefsOf({ [field]: value }) })
      // The scope write settles asynchronously and its promise REJECTS on a
      // transport failure (dsh keeps only its internal queue tail fulfilled)
      // — never let it float unhandled. Roll the optimistic echo back to the
      // scope's truth; a refused (non-2xx) write needs nothing here, the
      // scope's own recovery re-reads the Host and republishes via subscribe.
      const bound = scope
      if (bound === undefined) return
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        // A visibility gate that failed to persist must not keep an entry
        // hidden on an unpersisted echo: with no valid value in the scope's
        // truth, degrade each gate to its default.
        if (field === 'defaultPlacement' && truth.placement === undefined) {
          publish({ ...state, placement: 'all' })
        }
        if (field === 'insightsEntry' && truth.insightsEntry === undefined) {
          publish({ ...state, insightsEntry: 'show' })
        }
      })
    },
  }
}
