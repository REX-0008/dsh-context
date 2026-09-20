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

/** One assembled system-prompt section (exact section name plus text, order-sorted). */
export interface SystemSectionInfo {
  /** Section name (e.g. harness:identity / deployment:persona / tool:* / our:*). */
  name: string
  /** The resolved text. */
  text: string
}

/** The state route's value. */
export interface PanelState {
  settings: ContextPanelSettings | null
  dirty: boolean
  presetEntries: PresetEntryInfo[]
  systemSections: SystemSectionInfo[] | null
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
  }
}

/** Dispatch one action (updateModule / sync / setToolRestriction / setScope / setAutoSyncPreset / apply / editSkillDirs / editBaseline / clearOverrides / setGlobalSectionEnabled). */
export async function dispatchAction(sessionId: string, action: string, payload?: object): Promise<void> {
  const res = await fetch('/api/context-panel-write/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, sessionId, payload: payload ?? {} }),
  })
  const json = (await res.json()) as { ok?: boolean; error?: string }
  if (json.ok !== true) throw new Error(json.error ?? 'context-panel-write action failed')
}
