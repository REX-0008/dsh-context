/**
 * The engine service contract for @our/context-panel (ctx.contextAssembler;
 * inside this package panel-service holds the engine instance directly, and the
 * service is exposed for future internal/external consumers such as memory).
 * @module @our/context-panel/assembler/service
 */
import type { AgentFace as Agent } from '../agent-face'
import type { PresetEntryInfo } from './preset-entries'
import type { PromptModule } from '../types'
import type { InjectionSeen } from './engine'

/** The engine service contract (injected by panel-service and by future memory/other consumers). */
export interface ContextAssemblerService {
  /**
   * Inject the configuration reader: context-panel calls this once it has
   * registered settings, and it returns a snapshot of the current configuration.
   * After it is set, existing agents are re-registered under the new configuration
   * (the fallback for the panel loading after the engine).
   * @param reader - returns the current value of the context-panel settings
   * namespace.
   */
  setConfigReader(reader: () => import('../types').ContextPanelSettings): void
  /**
   * Hand the engine the host context so it can resolve agents on demand
   * (`ctx.agents.get`), instead of relying solely on creation-time tracking.
   * @param ctx - the host plugin context.
   */
  setHostContext(ctx: unknown): void
  /**
   * A new session was created (agent/created): register that agent's modules and
   * tool restrictions from the current configuration and store the registration
   * snapshot.
   * @param agent - the new agent.
   */
  registerForAgent(agent: Agent): void
  /**
   * Apply at the turn boundary (agent/inbox/inserted): only when the activation
   * flag is set does it re-register the modules, re-apply the tool restrictions,
   * and update the snapshot.
   * @param agent - the target agent.
   * @returns whether the update was actually applied.
   */
  applyPending(agent: Agent): boolean
  /**
   * Activate this agent's update (the user clicking update-context, or a
   * compaction summary triggering it automatically).
   * @param sessionId - the agent's session id (= agent.id).
   */
  markPending(sessionId: string): void
  /**
   * Whether the configuration differs from the registration snapshot (there are
   * unapplied changes).
   * @param sessionId - the agent's session id.
   * @returns true when they differ.
   */
  isDirty(sessionId: string): boolean
  /**
   * The current session's merged module view (agent level + conversation-level
   * overrides).
   * @param agent - the target agent.
   * @returns the ordered module list (including disabled entries).
   */
  getModuleView(agent: Agent): PromptModule[]
  /**
   * Read the merged module view by session id (used by panel-service's
   * getSnapshot; an unknown session returns empty).
   * @param sessionId - the agent's session id.
   * @returns the ordered module list (including disabled entries).
   */
  getModuleViewForSession(sessionId: string): PromptModule[]
  /**
   * The current agent preset's entry list (id/name/config), used by the system
   * prompt section to decide a source (a preset can be associated/overridden).
   * @param sessionId - the agent's session id.
   * @returns the preset entries; empty when there is no preset or the session is
   * unknown.
   */
  presetEntriesForSession(sessionId: string): PresetEntryInfo[]
  /**
   * Whether a section is injected by THIS plugin (a "config" section).
   *
   * It decides the write path: our own modules have no separate body — this
   * plugin's persisted module registry IS both the source and the body — so an
   * edit writes that record directly. Every other kind keeps its real text
   * elsewhere and is only adjusted on the way out.
   * @param sessionId - the agent (= session) id.
   * @param name - the section name as the assembly reports it.
   * @returns true when the section comes from this plugin's own modules.
   */
  isOwnModuleForSession(sessionId: string, name: string): boolean
  /**
   * The preset id this conversation runs on — the key naming the preset-level
   * disable list, so a section can be switched off for a preset as a whole.
   * @param sessionId - the agent (= session) id.
   * @returns the preset id, or undefined when the agent has none.
   */
  presetIdForSession(sessionId: string): string | undefined
  /**
   * The union of every section source for one conversation: the live assembly,
   * the waterfall capture, and the prompt registry.
   *
   * The assembly is requested with `{ agent, scope: agent }` — both — because a
   * scope built from the agent's own context resolves only the global layer and
   * omits every agent-scoped section.
   * @param sessionId - the agent (= session) id.
   * @returns the sections; null when the agent or its assembly is unavailable.
   */
  assembleSectionsForSession(sessionId: string): Promise<Array<{ name: string; text: string }> | null>
  /**
   * Park a prune request for the next turn boundary (see the engine's
   * `requestPrune`): nothing happens until then, so the request stays
   * cancellable in the meantime.
   * @param sessionId - the agent (= session) id.
   */
  togglePruneSelection(sessionId: string, seq: number): void
  /**
   * Select or deselect every node of one round at once.
   * @param sessionId - the agent (= session) id.
   * @param seqs - the round's node seqs.
   * @param select - true to select them, false to drop them.
   */
  selectPruneSeqs(sessionId: string, seqs: number[], select: boolean): void
  /**
   * The surface seqs of the runtime-context snapshot nodes for one conversation.
   *
   * The snapshot is ONE user-role node stamped with the system-prompt plugin as
   * its producer; the declared contexts all render into that single node rather
   * than one node each, so pruning it removes them together.
   * @param sessionId - the agent (= session) id.
   * @returns the snapshot node seqs; empty when none is on the surface.
   */
  runtimeContextNodeSeqs(sessionId: string): number[]
  /**
   * Drop a parked prune request.
   * @param sessionId - the agent (= session) id.
   * @returns whether a request was waiting.
   */
  cancelPrune(sessionId: string, seq?: number): boolean
  /**
   * The surface seqs currently selected for pruning, ascending.
   * @param sessionId - the agent (= session) id.
   * @returns the selected seqs; empty when nothing is selected.
   */
  pendingPruneSeqs(sessionId: string): number[]
  /**
   * Whether a prune is waiting to take effect for this conversation.
   * @param sessionId - the agent (= session) id.
   * @returns true while the request is parked.
   */
  hasPendingPrune(sessionId: string): boolean
  /**
   * Injection source kinds observed in this conversation's step batches (the
   * labels the panel offers for suppression).
   * @param sessionId - the agent (= session) id.
   * @returns the observed labels; empty before any turn has run.
   */
  observedInjectionsForSession(sessionId: string): InjectionSeen[]
  /**
   * The declared runtime contexts for one conversation.
   *
   * Contexts are the low-authority, dynamic half of the prompt (sandbox policy,
   * approval policy, subagent delegation): they reach the model as user-role
   * snapshots rather than system text, and they ride the SAME assembly and
   * waterfall as sections.
   * @param sessionId - the agent (= session) id.
   * @returns each context's name, placement order and text; null when the agent
   * or its assembly is unavailable.
   */
  contextsForSession(sessionId: string): Promise<Array<{ name: string; order: number; text: string }> | null>
  /**
   * Section name to its real placement order, read from the prompt registry —
   * includes sections registered before this plugin mounted, which the live
   * observation and the assembled value both miss.
   * @param sessionId - the agent (= session) id.
   * @returns the map; empty when the agent or registry is unavailable.
   */
  registeredOrdersForSession(sessionId: string): Record<string, number>
  /**
   * Write the currently effective module assembly description in place into the
   * user-level preset assembly manifest (the context-assembler row's
   * config.modules in agent.cordis.yml), keeping the sidecar archive (it does not
   * affect the runtime).
   * @param agentId - the agent id.
   */
  syncToPreset(agentId: string): void
  /**
   * Modify in place the skill-filesystem row's config in the agent's preset
   * assembly manifest (customSkillDirs), effective for new sessions (a new
   * generation); the runtime is not touched.
   * @param dirs - customSkillDirs.
   * @param agentId - the agent id.
   */
  editSkillDirs(dirs: string[], agentId: string): void
  /**
   * Modify in place the agent-instructions row's config in the agent's preset
   * assembly manifest (maxBytes / instructionFileCandidates / projectRootMarkers
   * and the like), effective for new sessions (a new generation).
   * @param patch - the agent-instructions config key/values.
   * @param agentId - the agent id.
   */
  editBaselineConfig(patch: Record<string, unknown>, agentId: string): void
  /**
   * Write an edited section's text back into the agent's preset composition.
   *
   * Only preset-injected sections can be written back: their text lives in a
   * file this user owns, whereas a plugin's prompt text lives inside that
   * plugin's package. Line-level edit, so the rest of the composition survives;
   * applies to sessions created after this one.
   * @param name - the section name (its owning entry is resolved from it).
   * @param text - the text to persist.
   * @param agentId - the agent whose preset is written.
   */
  writeSectionBackToPreset(name: string, text: string, agentId: string): void
  /** Dispose: deregister every registered module and tool restriction. */
  dispose(): void
}
