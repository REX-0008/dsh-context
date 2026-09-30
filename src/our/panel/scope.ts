/**
 * The settings face the write layer reads/writes, unified across the harness
 * generations.
 *
 * 0.1.x registers a dedicated namespace (`settings.register`) and hands back a
 * live scope; 0.2.x removed that face — the entry's `Config` schema IS the
 * settings surface now (host/config.ts carries our tree under `panel`, marked
 * volatile), served through `describe`/`update`. Both faces reduce to the two
 * operations this layer needs: a synchronous read of the merged settings and
 * an asynchronous merge write.
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

/** The 0.2.x settings service face (profile-entry config forms). */
export interface SettingsFormsFace {
  configure?(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): unknown
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
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
 * Build the 0.2.x face over the profile-entry settings service: our tree is
 * read from the entry's live config projection and written as a merge patch
 * under the same `panel` key host/config.ts declares.
 */
export function createProfileScope(settings: SettingsFormsFace): PanelScope {
  // Locate the descriptor that carries our tree: the entry named after our
  // namespace when the profile keeps the 0.1.x name, else the unique entry
  // whose form declares our keys (the `panel` carrier).
  const findOurRow = (): { ns: string; panel: Record<string, unknown> | undefined } | undefined => {
    const rows = settings.describe()
    if (!Array.isArray(rows)) return undefined
    for (const raw of rows) {
      const row = asRecord(raw)
      if (row === undefined || typeof row.ns !== 'string') continue
      if (row.ns !== CONTEXT_PANEL_NS && !row.ns.includes('context-panel-write')) continue
      return { ns: row.ns, panel: asRecord(asRecord(row.value)?.panel) }
    }
    for (const raw of rows) {
      const row = asRecord(raw)
      if (row === undefined) continue
      const form = JSON.stringify(row.schema ?? '')
      if (!form.includes('"panel"') || !form.includes('"conversationOverrides"')) continue
      return { ns: typeof row.ns === 'string' ? row.ns : CONTEXT_PANEL_NS, panel: asRecord(asRecord(row.value)?.panel) }
    }
    return undefined
  }
  return {
    get: () => {
      const row = findOurRow()
      if (row === undefined || row.panel === undefined) return { ...DEFAULT_SETTINGS }
      return deepMerge({ ...DEFAULT_SETTINGS }, row.panel) as unknown as ContextPanelSettings
    },
    update: async (patch) => {
      const row = findOurRow()
      if (row === undefined) throw new Error('the context-panel settings entry is not configurable on this harness')
      await settings.update(row.ns, { panel: patch })
    },
  }
}
