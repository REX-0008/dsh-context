/**
 * The settings face the write layer reads/writes, unified across the harness
 * generations.
 *
 * 0.2.x made the entry's own Config the settings surface: host/config.ts carries
 * our tree under `panel`, marked volatile, and the Loader keeps that field's
 * reference live. The official contract is that a business plugin reads its own
 * Config reference directly (`docs/subsystems/settings.md`: "Business consumers
 * read `.get()` on their own Config references"; `dsh-settings` README: "Business
 * plugins read their Config references directly"). The reference is O(1) and the
 * Loader commits new values into it on a volatile update.
 *
 * The Settings service is NOT a read path here. `settings.describe()` projects
 * every entry's form schema for the management page: it walks the whole profile,
 * serializes each schema, and emits `settings/document-updated`. Calling it per
 * read made the hot path (one `system-prompt/assemble` + `agent/pre-step` per
 * model request) pay that cost. Only the WRITE goes through the service, via
 * `update(ns, patch)`, which is the contract's own write operation.
 *
 * 0.1.x has neither face: it registers a dedicated namespace
 * (`settings.register`) and hands back a live scope.
 * @module @our/context-panel/panel/scope
 */
import type { ContextPanelSettings } from '../types'
import { CONTEXT_PANEL_NS, DEFAULT_SETTINGS } from './settings'

/** The unified read/write face for the context-panel settings. */
export interface PanelScope {
  /** The merged settings (the defaults fill what the stored value omits). */
  get(): ContextPanelSettings
  /** Merge a partial patch into the stored settings. */
  update(patch: Partial<ContextPanelSettings>): Promise<void>
}

/** The scope object the 0.1.x `settings.register` hands back. */
export interface LegacySettingsScope {
  get(): ContextPanelSettings
  update(patch: Partial<ContextPanelSettings>): Promise<void>
}

/** The 0.1.x settings service face. */
export interface LegacySettingsFace {
  register(ns: string, schema: unknown, options?: { base?: unknown; applies?: string }): unknown
}

/** The 0.2.x settings service face, as far as the write path consumes it. */
export interface SettingsFormsFace {
  configure?(presentation: { auto?: boolean }, owner?: unknown): () => void
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/**
 * The volatile reference the Loader commits values into. `get()` returns the
 * current plain value; the Loader swaps it on `loader/volatile-update`.
 */
export interface VolatileRef<T> {
  get(): T
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Deep-merge the patch over the base (objects merge; arrays and scalars replace). */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = asRecord(out[key])
    const incoming = asRecord(value)
    out[key] = current !== undefined && incoming !== undefined ? deepMerge(current, incoming) : value
  }
  return out
}

/** Wrap the 0.1.x registration scope into the unified face. */
export function wrapLegacyScope(scope: LegacySettingsScope): PanelScope {
  return { get: () => scope.get(), update: patch => scope.update(patch) }
}

/**
 * Build the 0.2.x face over the entry's own resolved Config reference.
 *
 * @param ref - the resolved `config.panel` volatile reference (see host/config.ts).
 *              `undefined` on a composition whose schema lacks the field, which
 *              degrades to the defaults.
 * @param settings - the Settings service, used only for the merge WRITE.
 * @param ns - the profile entry id the write addresses (host/cordis.patch.yml's
 *             row id for this plugin).
 * @returns the read/write face; reads never touch the Settings service.
 */
export function createEntryScope(
  ref: VolatileRef<ContextPanelSettings> | undefined,
  settings: SettingsFormsFace,
  ns: string,
): PanelScope {
  const read = (): Record<string, unknown> | undefined => {
    try {
      return asRecord(ref?.get())
    } catch {
      // A Loader that has not committed the field yet leaves the defaults.
      return undefined
    }
  }
  return {
    get: () => deepMerge({ ...DEFAULT_SETTINGS }, read() ?? {}) as unknown as ContextPanelSettings,
    update: async (patch) => {
      await settings.update(ns, { panel: patch })
    },
  }
}

/**
 * The 0.1.x-only namespace name, kept for the register face. On 0.2.x the
 * settings surface is the entry config, so nothing registers this namespace.
 */
export { CONTEXT_PANEL_NS }
