/**
 * The `contextPanelWrite` service: the panel's host-side backend.
 *
 * The client reaches it through this plugin's own routes
 * (`/api/context-panel-write/{state,action}`). It holds the engine instance
 * directly (a same-package import) and is one of the two in-process readers and
 * writers of the settings namespace that is the single source of configuration.
 *
 * editSkillDirs / editBaselineConfig: delegate to the engine to **modify in place**
 * the agent's preset assembly manifest (the matching plugin row's config in
 * .agent-presets/<agent>/agent.cordis.yml), effective for new sessions (a new
 * generation).
 * @module @our/context-panel/panel-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ContextAssemblerService } from '../assembler/service'
import type { ContextPanelSettings, PromptModulePatch } from '../types'
import { mergePatch } from './settings'

/** The ctx.contextPanel public contract. */
export interface ContextPanelService {
  /**
   * The current session's module view plus the scope / sync state and dirty flag.
   * @param sessionId - the target session id.
   * @returns the merged module list (including disabled ones) and the panel's
   * metadata.
   */
  getSnapshot(sessionId: string): {
    modules: Array<{ name: string; channel: 'section' | 'context'; order: number; enabled: boolean; text: string }>
    scope: 'conversation' | 'agent'
    autoSyncPreset: boolean
    dirty: boolean
  }
  /**
   * Write a module patch at the given scope (conversation → the conversation
   * override; agent → the source of truth).
   * @param target - the level to write to.
   * @param name - the module name.
   * @param patch - the patch.
   * @param sessionId - the session id.
   */
  updateModule(target: 'conversation' | 'agent', name: string, patch: PromptModulePatch, sessionId: string): Promise<void>
  /**
   * Copy the conversation-level overrides over the agent level in full and clear
   * this conversation's overrides (called after the client's confirmation dialog).
   * @param sessionId - the session id.
   */
  syncConversationToAgent(sessionId: string): Promise<void>
  /**
   * Set one tool's restriction (disabled → { deny:[name] }; enabled → delete it).
   * @param name - the tool name.
   * @param filter - the restriction; an empty filter clears that tool's restriction.
   */
  setToolRestriction(name: string, filter: { allow?: string[]; deny?: string[] }): Promise<void>
  /**
   * Whether the current session has unapplied changes (config digest ≠ registration
   * snapshot digest).
   * @param sessionId - the session id.
   */
  getDirty(sessionId: string): boolean
  /**
   * Activate an update (pending = true; the re-registration runs at the next turn
   * boundary).
   * @param sessionId - the session id.
   */
  applyChanges(sessionId: string): void
  /** Switch the edit scope (conversation → agent discards the conversation overrides; the client confirms first). */
  setScope(scope: 'conversation' | 'agent'): Promise<void>
  /** Toggle the auto-sync-to-preset switch. */
  setAutoSyncPreset(b: boolean): Promise<void>
  /**
   * Record the skill directory settings (modify in place the skill-filesystem row's
   * config in the agent's preset; effective for a new generation).
   * @param dirs - customSkillDirs.
   * @param sessionId - the session id.
   */
  editSkillDirs(dirs: string[], sessionId: string): void
  /**
   * Record the baseline settings (modify in place the agent-instructions row's
   * config in the agent's preset; effective for a new generation).
   * @param patch - the agent-instructions config key/values.
   * @param sessionId - the session id.
   */
  editBaselineConfig(patch: Record<string, unknown>, sessionId: string): void
}

/**
 * Build the ctx.contextPanel service (it holds the engine instance directly, a
 * same-package import).
 * @param ctx - the plugin root context.
 * @param getScope - returns the settings namespace scope (reads/writes the
 * configuration).
 * @param engine - the engine instance.
 * @returns the service implementation.
 */
export function createPanelService(
  ctx: Context,
  getScope: () => SettingsScope<ContextPanelSettings>,
  engine: ContextAssemblerService,
): ContextPanelService {
  return {
    getSnapshot(sessionId) {
      const value = getScope().get()
      const modules = engine.getModuleViewForSession(sessionId) as Array<{ name: string; channel: 'section' | 'context'; order: number; enabled: boolean; text: string }>
      return {
        modules,
        scope: value.scope,
        autoSyncPreset: value.autoSyncPreset,
        dirty: engine.isDirty(sessionId),
      }
    },
    async updateModule(target, name, patch, sessionId) {
      const scope = getScope()
      const value = scope.get()
      if (target === 'conversation') {
        const overrides: Record<string, Record<string, PromptModulePatch>> = { ...(value.conversationOverrides ?? {}) }
        const sessionOverrides: Record<string, PromptModulePatch> = { ...(overrides[sessionId] ?? {}) }
        sessionOverrides[name] = mergePatch(sessionOverrides[name], patch)
        overrides[sessionId] = sessionOverrides
        await scope.update({ conversationOverrides: overrides })
      } else {
        const modules: Record<string, PromptModulePatch> = { ...(value.modules ?? {}) }
        modules[name] = mergePatch(modules[name], patch)
        await scope.update({ modules })
        if (value.autoSyncPreset) engine.syncToPreset(sessionId)
      }
    },
    async syncConversationToAgent(sessionId) {
      const scope = getScope()
      const value = scope.get()
      const sessionOverrides = value.conversationOverrides?.[sessionId] ?? {}
      const modules: Record<string, PromptModulePatch> = { ...(value.modules ?? {}) }
      for (const [name, patch] of Object.entries(sessionOverrides)) {
        modules[name] = mergePatch(modules[name], patch)
      }
      const rest: Record<string, Record<string, PromptModulePatch>> = { ...(value.conversationOverrides ?? {}) }
      delete rest[sessionId]
      await scope.update({ modules, conversationOverrides: rest })
      if (value.autoSyncPreset) engine.syncToPreset(sessionId)
    },
    async setToolRestriction(name, filter) {
      const scope = getScope()
      const restrictions: Record<string, { allow?: string[]; deny?: string[] }> = { ...(scope.get().toolRestrictions ?? {}) }
      if (filter.allow === undefined && filter.deny === undefined) {
        delete restrictions[name]
      } else {
        restrictions[name] = filter
      }
      await scope.update({ toolRestrictions: restrictions })
    },
    getDirty(sessionId) {
      return engine.isDirty(sessionId)
    },
    applyChanges(sessionId) {
      engine.markPending(sessionId)
    },
    async setScope(scope) {
      await getScope().update({ scope })
    },
    async setAutoSyncPreset(b) {
      await getScope().update({ autoSyncPreset: b })
    },
    editSkillDirs(dirs, sessionId) {
      // modify in place the skill-filesystem row's config in the agent's preset (implemented by the engine; effective for a new generation)
      engine.editSkillDirs(dirs, sessionId)
    },
    editBaselineConfig(patch, sessionId) {
      // modify in place the agent-instructions row's config in the agent's preset
      // (implemented by the engine; effective for a new generation)
      engine.editBaselineConfig(patch, sessionId)
    },
  }
}

