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
  /** The panel's default width (% of window, a software-level UI preference). */
  panelWidth: number
  /** The module set: ONE definition per name, the single source of truth. */
  modules: Record<string, PromptModulePatch>
  /** Tool restrictions (by tool name → filter). */
  toolRestrictions: Record<string, { allow?: string[]; deny?: string[] }>
  /**
   * Sections disabled for a preset (the "preset off" state): keyed by preset id,
   * then section name is membership. Enablement is the ONE thing that keeps a
   * level — content is global, and a preset decides what its conversations send.
   *
   * Disabling a section only stops its TEXT from being sent; it never unloads the
   * plugin that registered it. A deployment (profile) level exists but is NOT
   * managed here.
   */
  presetDisabledSections?: Record<string, string[]>
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
   * Conversation-scoped on purpose, and the ONE place that stays so: an
   * injection is per-step input rather than prompt content, so it has no preset
   * to belong to.
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
  /** GLOBAL context text overrides, by context name; see {@link sectionOverrides}. */
  contextOverrides?: Record<string, string>
  /**
   * Section text overrides, keyed by section name: the "plugin" source kind is
   * adjusted here instead of in its own file, so a third-party plugin's prompt
   * can be rewritten without touching that plugin.
   *
   * GLOBAL: a section's text is prompt content, and content has no level — the
   * same text is delivered to every conversation. A per-conversation copy was the
   * complexity this model deliberately dropped.
   */
  sectionOverrides?: Record<string, string>
  /**
   * Section weights, keyed by section name. Editing a number re-orders the
   * prompt; sections without a weight keep their position. Global for the same
   * reason as {@link sectionOverrides}.
   */
  sectionWeights?: Record<string, number>
  /**
   * What an overridden section's original text looked like when it was edited,
   * one backup per section. When the plugin later changes that original, the two
   * differ and the panel offers a comparison.
   */
  sectionOriginals?: Record<string, string>
}

/** Empty configuration (the fallback while settings is not ready). */
export const EMPTY_CONFIG: ContextPanelSettings = {
  panelWidth: 720,
  modules: {},
  toolRestrictions: {},
  presetDisabledSections: {},
  presetDisabledContexts: {},
  suppressedInjections: {},
  contextOverrides: {},
  sectionOverrides: {},
  sectionWeights: {},
  sectionOriginals: {},
}
