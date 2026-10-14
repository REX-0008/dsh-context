/** The plugin's user-settings binding (browser half): the Host-served `dsh-context` namespace carries per-user
 * display preferences, degrading to the schema defaults wherever that surface is absent or read-only. */

import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, FleetTab, InsightsEntry, SettingsField } from '../shared/types'

export type { DefaultDeltaBase, DefaultFileSort, DefaultToolSort, SettingsField } from '../shared/types'

/** The bound settings form (`ctx.configForms.get`), as consumed. */
export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/**
 * The 0.1.x `ctx.settingsScope` binder, as consumed (OUR INSERT: upstream dropped
 * this generation, while this fork still declares the 0.1.x releases supported —
 * see docs/compatibility.md). The bound scope satisfies {@link SettingsScopeLike}.
 */
export interface SettingsScopeBinderFace {
  bind(spec: { namespace: string }): SettingsScopeLike
}

/** The `ctx.configForms` service face, as consumed; the bound form satisfies {@link SettingsScopeLike}
 *  (same snapshot/subscribe/set shape). */
export interface ConfigFormsFace {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

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
  durationCurve: DefaultDurationCurve
  fleetTab: FleetTab
  promptPrefix: string
  promptSuffix: string
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
  defaultDurationCurve(): DefaultDurationCurve
  fleetTab(): FleetTab
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
  durationCurve?: DefaultDurationCurve
  fleetTab?: FleetTab
  promptPrefix?: string
  promptSuffix?: string
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
    ...(v.defaultDurationCurve === 'show' || v.defaultDurationCurve === 'hide' ? { durationCurve: v.defaultDurationCurve } : {}),
    ...(v.fleetTab === 'show' || v.fleetTab === 'hide' ? { fleetTab: v.fleetTab } : {}),
    ...(typeof v.promptPrefix === 'string' ? { promptPrefix: v.promptPrefix } : {}),
    ...(typeof v.promptSuffix === 'string' ? { promptSuffix: v.promptSuffix } : {}),
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
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', fleetTab: 'show', promptPrefix: '', promptSuffix: '', writable: false }
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
  /**
   * Every field is a scalar, so a shallow compare is the store's identity check — and a new preference
   * joins it without editing a growing chain of `&&`s.
   */
  const unchanged = (a: SettingsState, b: SettingsState): boolean =>
    (Object.keys(b) as (keyof SettingsState)[]).every(key => a[key] === b[key])
  /**
   * Publish a new state.
   *
   * Returns whether it actually notified, because the price mapping is not one of
   * the fields compared here (see the sync note below): the caller has to know
   * whether this already carried the mapping to its subscribers.
   * @param next - the state to publish.
   * @returns true when listeners were notified.
   */
  const publish = (next: SettingsState): boolean => {
    if (unchanged(state, next)) return false
    state = next
    for (const listener of listeners) listener()
    return true
  }
  const sync = (bound: SettingsScopeLike): { placement?: DefaultPlacement; insightsEntry?: InsightsEntry; fleetTab?: FleetTab } => {
    const snap = bound.getSnapshot()
    // Bounded catch (the compatibility.md parser gate): a value that throws on property access
    // keeps the current state instead of throwing into the mirror's fan-out.
    let prefs: Prefs = {}
    let nextRaw: Record<string, unknown> | undefined
    try {
      prefs = prefsOf(snap.value)
      nextRaw = snap.value !== null && typeof snap.value === 'object' ? snap.value as Record<string, unknown> : undefined
    } catch { /* hostile value */ }
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
      durationCurve: prefs.durationCurve ?? (raw?.defaultDurationCurve === undefined ? state.durationCurve : 'show'),
      fleetTab: prefs.fleetTab ?? (raw?.fleetTab === undefined ? state.fleetTab : 'show'),
      promptPrefix: prefs.promptPrefix ?? (raw?.promptPrefix === undefined ? state.promptPrefix : ''),
      promptSuffix: prefs.promptSuffix ?? (raw?.promptSuffix === undefined ? state.promptSuffix : ''),
      writable: snap.writable,
    })
    if (mapChanged && !notified) for (const listener of listeners) listener()
    return { placement: prefs.placement, insightsEntry: prefs.insightsEntry, fleetTab: prefs.fleetTab }
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
    defaultDurationCurve: () => state.durationCurve,
    fleetTab: () => state.fleetTab,
    attach(bound) {
      scope = bound
      sync(bound)
      const unsubscribe = bound.subscribe(() => { sync(bound) })
      return () => {
        unsubscribe()
        // A set() after disposal must not write into a dead form.
        if (scope === bound) scope = undefined
      }
    },
    set(field, value) {
      publish({ ...state, ...prefsOf({ [field]: value }) })
      // The scope write's promise REJECTS on a transport failure (dsh keeps only its queue tail fulfilled),
      // so never let it float: roll the optimistic echo back to the scope's truth; a refused write recovers via subscribe.
      const bound = scope
      if (bound === undefined) return
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        // A gate whose write was refused must not stay hidden on an unpersisted echo: it degrades to the
        // default, while a scope that DOES carry a readable value keeps that truth (the sync above already did).
        const refused: Partial<SettingsState> = {}
        if (field === 'defaultPlacement' && truth.placement === undefined) refused.placement = 'all'
        else if (field === 'insightsEntry' && truth.insightsEntry === undefined) refused.insightsEntry = 'show'
        else if (field === 'fleetTab' && truth.fleetTab === undefined) refused.fleetTab = 'show'
        if (Object.keys(refused).length > 0) publish({ ...state, ...refused })
      })
    },
  }
}
