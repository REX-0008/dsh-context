/**
 * Browser to host channel for our write layer.
 *
 * Routes live on the fork's own prefix (`/api/context-panel-write/*`); the
 * harness settings RPC only exposes a whitelist of namespaces, so a plugin's
 * own namespace is unreachable from the browser and a plugin-owned route is
 * the supported alternative.
 * @module @our/context-panel-write/our/client/panel-api
 */
import type { ContextPanelSettings } from '../types'

/** One preset entry (source attribution: presets may be linked or overridden). */
export interface PresetEntryInfo {
  /** Preset entry id (the `- id:` in the preset file). */
  id: string
  /** Package name. */
  name: string
  /** Entry config (the parent text may live in `config.text`). */
  config?: unknown
}

/**
 * Where a section comes from, which decides how an edit is applied.
 * - `config`: one of our own modules — edited in our settings, effective at once;
 * - `preset`: injected by a preset (agent recipe) — written back to the preset file, next session;
 * - `plugin`: a plugin's (or the harness's own) section — adjusted on the way out, its file untouched.
 */
export type SectionKind = 'config' | 'preset' | 'plugin'

/** One assembled system-prompt section, decorated for the panel. */
export interface SystemSectionInfo {
  /** Section name (e.g. harness:identity / deployment:persona / tool:* / our:*). */
  name: string
  /** The resolved text: the edited one when an edit exists, otherwise the original. */
  text: string
  /** Where this section comes from. */
  kind: SectionKind
  /** False when the user has switched this section off (it stays listed, greyed). */
  enabled: boolean
  /** True when the text has been edited by the user. */
  edited: boolean
  /** True when the plugin's original has changed since the edit (offers a comparison). */
  originalChanged: boolean
  /** The plugin's current text; present only while `originalChanged` (for the comparison). */
  originalText?: string
  /** User-set ordering weight, when one exists (overrides `order` in the delivered prompt). */
  weight?: number
  /** The section's real placement order, when known. */
  order?: number
  /** The package that registers this section, when resolvable. */
  plugin?: string
  /**
   * Where `order`/`plugin` came from: observed live at registration, filled
   * from the generated table, or unknown.
   */
  originFrom: 'observed' | 'table' | 'none'
  /**
   * The generated table disagrees with the live order — the table is stale and
   * needs regenerating. The panel flags this instead of showing a stale number.
   */
  staleTable: boolean
  /**
   * Which level switched this section off: this conversation alone, or the
   * preset (every conversation running it). Absent while it is enabled.
   */
  disabledAt?: 'conversation' | 'preset'
}

/** The state route's value. */
export interface PanelState {
  settings: ContextPanelSettings | null
  dirty: boolean
  presetEntries: PresetEntryInfo[]
  systemSections: SystemSectionInfo[] | null
  /** Which dsh version the fallback table was generated from. */
  knownSectionsSource?: string
  /** The preset this conversation runs on (labels the preset-level state). */
  presetId?: string
  /**
   * The surface seqs currently selected for pruning (ascending). The panel marks
   * those rows; the range it will send is their closed span.
   */
  pruneSeqs?: number[]
  /** The declared runtime contexts (the dynamic, low-authority half of the prompt). */
  contexts?: SystemSectionInfo[] | null
  /**
   * WHO can inject: the switchable producers, the always-present ones first.
   */
  injectors?: Array<{ label: string; note?: string }>
  /**
   * WHAT was actually injected into this conversation, per producer. Reports
   * content rather than capability, so it is empty until a turn has run.
   */
  injected?: Array<{ label: string; text: string; count: number }>
  /** Injection labels suppressed in this conversation. */
  suppressedInjections?: string[]
  /** The surface seqs of the runtime-context snapshot nodes. */
  contextSnapshotSeqs?: number[]
}

/** Read the panel state (settings, dirty flag, preset entries, per-section assembly). */
export async function fetchState(sessionId: string): Promise<PanelState> {
  const res = await fetch(`/api/context-panel-write/state?sessionId=${encodeURIComponent(sessionId)}`)
  const json = (await res.json()) as { ok?: boolean; value?: PanelState; error?: string }
  if (json.ok !== true) throw new Error(json.error ?? 'context-panel-write state fetch failed')
  return {
    settings: json.value?.settings ?? null,
    dirty: json.value?.dirty ?? false,
    presetEntries: json.value?.presetEntries ?? [],
    systemSections: json.value?.systemSections ?? null,
    knownSectionsSource: json.value?.knownSectionsSource,
    presetId: json.value?.presetId,
    pruneSeqs: json.value?.pruneSeqs ?? [],
    contexts: json.value?.contexts ?? null,
    injectors: json.value?.injectors ?? [],
    injected: json.value?.injected ?? [],
    suppressedInjections: json.value?.suppressedInjections ?? [],
    contextSnapshotSeqs: json.value?.contextSnapshotSeqs ?? [],
  }
}

/**
 * Dispatch one action (updateModule / sync / setToolRestriction / setScope / setAutoSyncPreset /
 * apply / editSkillDirs / editBaseline / clearOverrides / setGlobalSectionEnabled).
 */
export async function dispatchAction(sessionId: string, action: string, payload?: object): Promise<void> {
  const res = await fetch('/api/context-panel-write/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, sessionId, payload: payload ?? {} }),
  })
  const json = (await res.json()) as { ok?: boolean; error?: string }
  if (json.ok !== true) throw new Error(json.error ?? 'context-panel-write action failed')
}
