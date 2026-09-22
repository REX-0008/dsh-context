/**
 * @our/context-panel shared types (shared by every module inside this plugin; the client half aligns through them too).
 * @module @our/context-panel/types
 */

/**
 * Module registration channel: the authority×dynamism criterion decides the prefix
 * cache's fate (section is expected to stay stable; a changed context supersedes).
 */
export type PromptChannel = 'section' | 'context'

/**
 * The parent source a module overrides (parent = the section the original plugin
 * injected; child = our module, which shadows the parent automatically when the
 * names match).
 */
export interface ModuleSource {
  /** Parent source kind: preset (injected by a preset entry) / global (profile-wide) / none (purely new, no parent). */
  kind: 'preset' | 'global' | 'none'
  /** The preset entry id (when preset: e.g. 'persona'). */
  entryId?: string
  /** The overridden parent section name (= this module's name; only a matching name shadows). */
  sectionName?: string
  /** The parent's original text (read from the preset entry's config; left unset when the preset cannot be found). */
  parentText?: string
}

/** A module patch (the client sends only patches through the settings channel; settings is the single source of module definitions). */
export interface PromptModulePatch {
  /** The injected text. */
  text?: string
  /** Channel: stable high authority → section; dynamic low authority → context. */
  channel?: PromptChannel
  /** Assembly order (section and context are each ordered independently). */
  order?: number
  /** On/off switch. */
  enabled?: boolean
  /** The overridden parent source (dsh does not read it; we write it and read it back for display/comparison and to trace a write-back). */
  source?: ModuleSource
}

/** A resolved module (its final form after the agent-level and conversation-level overrides are merged). */
export interface PromptModule {
  /** Registration name, such as 'our:soul' / 'our:workspace'; when overriding a parent it equals the parent section name. */
  name: string
  /** Channel. */
  channel: PromptChannel
  /** Assembly order. */
  order: number
  /** Whether it is injected. */
  enabled: boolean
  /** The injected text (static text, rendered once from the configuration at registration time). */
  text: string
  /** The overridden parent source (absent for a newly added module). */
  source?: ModuleSource
}

/** The context-panel settings namespace's value (persisted to disk; shared by the engine / panel / preset). */
export interface ContextPanelSettings {
  /** The current edit scope. */
  scope: 'conversation' | 'agent'
  /** The sync-to-preset switch. */
  autoSyncPreset: boolean
  /** The panel's default width (% of window, a software-level UI preference). */
  panelWidth: number
  /** Agent-level module configuration (the source of truth). */
  modules: Record<string, PromptModulePatch>
  /** Conversation-level temporary overrides (one set per conversation). */
  conversationOverrides: Record<string, Record<string, PromptModulePatch>>
  /** Agent-level tool restrictions (by tool name → filter). */
  toolRestrictions: Record<string, { allow?: string[]; deny?: string[] }>
  /**
   * Sections disabled for every conversation under the same PRESET (the
   * "preset off" state): keyed by preset id, then section name is membership.
   *
   * Three levels exist; this pair covers the two the panel owns:
   * - the deployment (profile) level is NOT managed here;
   * - preset level = this field, so every conversation on that preset is affected;
   * - conversation level = {@link conversationDisabledSections}.
   *
   * Disabling a section only stops its TEXT from being sent; it never unloads the
   * plugin that registered it.
   */
  presetDisabledSections?: Record<string, string[]>
  /**
   * Sections disabled for ONE conversation only: keyed by session id, then
   * section name is membership. Takes effect for this conversation alone, so a
   * section can be off here and on in every other conversation.
   */
  conversationDisabledSections?: Record<string, string[]>
  /**
   * Injected messages to suppress at the pre-step boundary, keyed by the
   * message's own `source.kind` (the harness's merge-extensible
   * `MessageSourceMap`, e.g. `agent-instructions`, `skill-catalog`,
   * `time-context`).
   *
   * These injectors do not use `systemPrompt.context()`; they append to the
   * step's message batch, so the only place to act on them is the pre-step
   * waterfall. Suppression FILTERS the batch and never rewrites it, which is
   * what keeps this safe alongside other plugins: a waterfall chains, so another
   * plugin adding content is unaffected, and one rewriting content still applies
   * — only a same-kind contention could conflict, and filtering cannot contend.
   *
   * Conversation-scoped: an injection is per-step input, not part of a preset.
   */
  suppressedInjections?: Record<string, string[]>
  /**
   * RUNTIME CONTEXTS carry the same two decisions as sections, under the same
   * two levels. They are kept in their own maps because a context and a section
   * may share a name without being the same contribution.
   *
   * Contexts are the dynamic, low-authority half of the prompt (sandbox policy,
   * approval policy, subagent delegation), delivered as user-role snapshots.
   */
  presetDisabledContexts?: Record<string, string[]>
  /** Contexts disabled for one conversation only; see {@link conversationDisabledSections}. */
  conversationDisabledContexts?: Record<string, string[]>
  /** Per-agent context text overrides; see {@link sectionOverrides}. */
  contextOverrides?: Record<string, Record<string, string>>
  /**
   * Per-agent section text overrides, keyed by section name: the "plugin"
   * source kind is adjusted here instead of in its own file, so a third-party
   * plugin's prompt can be rewritten without touching that plugin.
   */
  sectionOverrides?: Record<string, Record<string, string>>
  /**
   * Per-agent section weights, keyed by section name. Editing a number
   * re-orders the prompt; sections without a weight keep their position.
   */
  sectionWeights?: Record<string, Record<string, number>>
  /**
   * What an overridden section's original text looked like when it was edited,
   * one backup per section. When the plugin later changes that original, the
   * two differ and the panel offers a comparison.
   */
  sectionOriginals?: Record<string, Record<string, string>>
}

/** Empty configuration (the fallback while settings is not ready). */
export const EMPTY_CONFIG: ContextPanelSettings = {
  scope: 'agent',
  autoSyncPreset: false,
  panelWidth: 720,
  modules: {},
  conversationOverrides: {},
  toolRestrictions: {},
  presetDisabledSections: {},
  conversationDisabledSections: {},
  presetDisabledContexts: {},
  conversationDisabledContexts: {},
  suppressedInjections: {},
  contextOverrides: {},
  sectionOverrides: {},
  sectionWeights: {},
  sectionOriginals: {},
}
