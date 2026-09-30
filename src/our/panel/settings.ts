/**
 * The context-panel settings namespace: schema + defaults + registration.
 *
 * Difference from the design document: this uses settings.register directly
 * (rather than installSettingsSection) — installSettingsSection exposes reads
 * only (setSource/onChange), while this plugin needs scope.update() for its
 * write paths (updateModule/syncConversationToAgent), and the scope that register
 * returns provides get/watch/update together.
 * @module @our/context-panel/settings
 */
import z from '@deepseek-ai/schemastery'
import type { ContextPanelSettings, PromptModulePatch } from '../types'
import { SEED_MODULES } from '../preset/seeds'

/** Our own namespace, distinct from upstream dsh-context's. */
export const CONTEXT_PANEL_NS = 'context-panel-write'

/** Module patch schema (every field optional; source stays a loose object so it can be extended). */
const PatchSchema = z.object({
  text: z.string(),
  channel: z.union([z.const('section'), z.const('context')]),
  order: z.number(),
  enabled: z.boolean(),
  source: z.any(),
})

/**
 * Default configuration (the single source of module definitions is
 * preset/seeds.ts; the client can edit it in the panel).
 * Ranges: section avoids harness(-100)/persona(0)/tool guidance(100-199); context
 * has its own range.
 */
export const DEFAULT_SETTINGS: ContextPanelSettings = {
  scope: 'agent',
  autoSyncPreset: false,
  panelWidth: 720,
  modules: { ...SEED_MODULES },
  conversationOverrides: {},
  toolRestrictions: {},
  presetDisabledSections: {},
  conversationDisabledSections: {},
  presetDisabledContexts: {},
  conversationDisabledContexts: {},
  contextOverrides: {},
  suppressedInjections: {},
}


/** The field set both carriers share. */
const FIELDS = {
  scope: z.union([z.const('conversation'), z.const('agent')]),
  autoSyncPreset: z.boolean(),
  panelWidth: z.number(),
  modules: z.dict(PatchSchema),
  conversationOverrides: z.dict(z.dict(PatchSchema)),
  toolRestrictions: z.dict(z.object({ allow: z.array(z.string()), deny: z.array(z.string()) })),
  presetDisabledSections: z.dict(z.array(z.string())),
  conversationDisabledSections: z.dict(z.array(z.string())),
  presetDisabledContexts: z.dict(z.array(z.string())),
  conversationDisabledContexts: z.dict(z.array(z.string())),
  contextOverrides: z.dict(z.dict(z.string())),
  suppressedInjections: z.dict(z.array(z.string())),
  sectionOverrides: z.dict(z.dict(z.string())),
  sectionWeights: z.dict(z.dict(z.number())),
  sectionOriginals: z.dict(z.dict(z.string())),
}

/** Namespace schema (schemastery primitives: z.dict replaces zod's z.record; fields are optional by default). */
export const CONTEXT_PANEL_SCHEMA: z<ContextPanelSettings> = z.object(FIELDS)

/**
 * The entry-config carrier for harness 0.2+ (host/config.ts nests it under
 * `panel` and marks it volatile). A separate ROOT node: the volatile mark
 * mutates the node it is applied to, and the registration schema above must
 * keep resolving namespace values as plain data on the 0.1.x lines.
 */
export const CONTEXT_PANEL_ENTRY_SCHEMA: z<ContextPanelSettings> = z.object(FIELDS)


/** Merge two patches (the latter overrides the former; undefined fields are ignored). */
export function mergePatch(...patches: Array<PromptModulePatch | undefined>): PromptModulePatch {
  const out: PromptModulePatch = {}
  for (const p of patches) {
    if (p === undefined) continue
    if (p.text !== undefined) out.text = p.text
    if (p.channel !== undefined) out.channel = p.channel
    if (p.order !== undefined) out.order = p.order
    if (p.enabled !== undefined) out.enabled = p.enabled
    if (p.source !== undefined) out.source = p.source
  }
  return out
}
