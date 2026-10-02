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
import type { PanelScope } from './scope'
import type { ContextAssemblerService } from '../assembler/service'
import type { PromptModulePatch } from '../types'
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
    autoSyncPreset: boolean
    dirty: boolean
  }
  /**
   * Patch one module's definition. One definition per name, so there is no level
   * to pick; `target` is kept for the action payload's shape only.
   * @param target - unused; the settings' module map is the only destination.
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
  getScope: () => PanelScope,
  engine: ContextAssemblerService,
): ContextPanelService {
  return {
    getSnapshot(sessionId) {
      const value = getScope().get()
      const modules = engine.getModuleViewForSession(sessionId) as Array<{ name: string; channel: 'section' | 'context'; order: number; enabled: boolean; text: string }>
      return {
        modules,
        autoSyncPreset: value.autoSyncPreset,
        dirty: engine.isDirty(sessionId),
      }
    },
    /**
     * Patch one module's definition. There is ONE definition per name, so the
     * target is always the settings' module map — the per-conversation copy this
     * used to branch into is gone.
     */
    async updateModule(_target, name, patch, sessionId) {
      const scope = getScope()
      const value = scope.get()
      const modules: Record<string, PromptModulePatch> = { ...value.modules }
      modules[name] = mergePatch(modules[name], patch)
      await scope.update({ modules })
      if (value.autoSyncPreset) engine.syncToPreset(sessionId)
    },
    async setToolRestriction(name, filter) {
      const scope = getScope()
      const restrictions: Record<string, { allow?: string[]; deny?: string[] }> = { ...scope.get().toolRestrictions }
      const { [name]: _removed, ...rest } = restrictions
      const updated = filter.allow === undefined && filter.deny === undefined
        ? rest
        : { ...restrictions, [name]: filter }
      await scope.update({ toolRestrictions: updated })
    },
    getDirty(sessionId) {
      return engine.isDirty(sessionId)
    },
    applyChanges(sessionId) {
      engine.markPending(sessionId)
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

