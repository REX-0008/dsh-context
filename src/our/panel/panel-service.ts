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
import { modulesFileOf } from './data-dir'
import type { ModulesStore, StoreStatus } from './modules-store'

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
  /**
   * Patch one module's definition. Synchronous by design: the file write is, and
   * a caller that awaited a Promise would be waiting on nothing.
   * @param target - unused; the definitions file is the only destination.
   * @param name - the module name.
   * @param patch - the fields to set.
   * @param sessionId - the session id, for the optional preset mirror.
   */
  updateModule(target: 'conversation' | 'agent', name: string, patch: PromptModulePatch): void
  /**
   * The definitions file: where it is and how the last read of it went.
   * @returns the path and status.
   */
  modulesFile(): { path: string; status: StoreStatus }
  /**
   * Drop one module's definition. The set IS the settings' module map, so a
   * removal is a key removal.
   * @param name - the module name.
   */
  /**
   * Remove one definition (the panel confirms before dispatching this).
   * @param name - the module name.
   */
  removeModule(name: string): void
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
  store: ModulesStore,
): ContextPanelService {
  return {
    getSnapshot(sessionId) {
      const modules = engine.getModuleViewForSession(sessionId) as Array<{ name: string; channel: 'section' | 'context'; order: number; enabled: boolean; text: string }>
      return {
        modules,
        dirty: engine.isDirty(sessionId),
        modulesFile: store.status(),
      }
    },
    /** The definitions file's path and last-read state, for the panel's report. */
    modulesFile() {
      return { path: modulesFileOf(ctx), status: store.status() }
    },
    /**
     * Patch one module's definition. There is ONE definition per name and it lives
     * in the profile's file; the settings map and the per-conversation copy this
     * used to branch into are both gone.
     */
    updateModule(_target, name, patch) {
      store.seedIfAbsent()
      store.upsert(name, patch)
    },
    /**
     * Drop one module's definition.
     *
     * Nothing re-adds it: the seeds only fill the DEFAULT document, and a stored
     * one replaces that default wholesale — so a deleted seed stays deleted, and
     * an upgrade's new seed does not resurrect it.
     */
    removeModule(name) {
      store.remove(name)
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

/**
 * Build the ctx.contextPanel service.
 *
 * The module store is INJECTED rather than opened here: the engine reads the same
 * definitions, and two stores over one file would mean two caches — a write
 * through one would be invisible to the other until its mtime check ran, which is
 * exactly the lag this migration exists to remove.
 * @param ctx - the plugin root context (the definitions file's path).
 * @param getScope - returns the settings scope (everything but the definitions).
 * @param engine - the engine instance.
 * @param store - the process's single module store.
 * @returns the service implementation.
 */
