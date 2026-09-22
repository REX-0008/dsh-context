/**
 * The engine itself: the module registry + injection + the "activate → apply at
 * the turn boundary" update model.
 *
 * Responsibilities (following plans/2026-08-19-上下文工程后端部分.md §1.4/§6):
 * - registration snapshot: the digest of each agent's last registered modules/tool
 *   restrictions, which getDirty compares against the current configuration;
 * - activation flag (pending): set by applyChanges() (a user click) or by a
 *   compaction summary (the compaction/summary session event); the re-registration
 *   runs only at a turn boundary (agent/inbox/inserted);
 * - a change does not commit itself: persisting the configuration only makes
 *   getDirty true and triggers no re-registration.
 *
 * Differences from the design document, established against the source:
 * - compaction/summary is a durable session event rather than a live one, so
 *   activation is decided in the projection layer through
 *   ctx.on('session/event') by event type (docs/会话持久化系统调研.md §2.4);
 * - the preset snapshot is written to the user-level
 *   .agent-presets/<agent>/context-modules.json (a sidecar archive file) and does
 *   not overwrite agent.cordis.yml — writing our configuration into
 *   agent.cordis.yml as the design document had it would destroy that preset's
 *   real assembly (the persona/tool rows would be lost).
 * @module @our/context-panel/assembler/engine
 */
import type { AgentFace as Agent } from '../agent-face'
import type {} from '@deepseek-ai/dsh-system-prompt'
// NOTE: `@deepseek-ai/dsh-tools` is deliberately NOT imported, not even as a
// type-only declaration merge: that package depends on `@deepseek-ai/dsh-agent`,
// so reaching it pulls the harness's real `agent/pre-step` signature into the
// program and collides with the narrow shim upstream declares in
// host/stepIdentity.ts (upstream never imports it either — verified). The one
// method used is reached through a structural cast below.
import type { ContextPanelSettings, PromptModule, PromptModulePatch } from '../types'
import { EMPTY_CONFIG } from '../types'
import { presetEntriesOf, type PresetEntryInfo } from './preset-entries'
import { presetEntryForSection } from '../preset/section-entries'

/**
 * The id spellings one session may be addressed by.
 *
 * A session id reaches this layer from several producers (the client's session
 * list, the durable log, an agent's own `id`), and the harness mints some ids
 * as `session-<n>` while others are bare uuids. The agent registry matches by
 * exact string, so a lookup tries the equivalent spellings rather than assuming
 * one.
 * @param sessionId - the id as given.
 * @returns the given id first, then its other equivalent spelling.
 */
export function sessionIdVariants(sessionId: string): string[] {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return sessionId.startsWith('session-') ? [sessionId, bare] : [sessionId, 'session-' + bare]
}
import {
  AGENT_INSTRUCTIONS_ID,
  AGENT_INSTRUCTIONS_NAME,
  CONTEXT_PLUGIN_ID,
  CONTEXT_PLUGIN_NAME,
  SKILL_FS_ID,
  SKILL_FS_NAME,
  syncToPresetFile,
  updatePresetPluginConfig,
  writePresetSnapshot,
} from '../preset/preset-sync'
import type { ContextAssemblerService } from './service'

/** A module's minimal definition engine-side (fallback values; the real definition lives in settings, the single source of truth). */
export interface ModuleDefinition {
  /** Registration name. */
  name: string
  /** Channel: stable high authority → section; dynamic low authority → context (it decides the prefix cache's fate). */
  channel: 'section' | 'context'
  /** Default assembly order. */
  order: number
  /** Default on/off switch. */
  enabled: boolean
  /** Default injected text. */
  text: string
}

/**
 * The fallback defaults for a module's channel/order. The single source of truth
 * for module definitions (text/channel/order/switch) is context-panel's settings
 * namespace (DEFAULT_SETTINGS.modules, editable by the client); the engine only
 * supplies a minimal fallback here for names absent from settings (it injects
 * nothing while settings is empty).
 */
export const FALLBACK_CHANNEL: 'section' | 'context' = 'section'

/** One agent's registration state. */
interface RegisteredAgent {
  /** Module name → registration disposer. */
  disposers: Map<string, () => void>
  /** Tool restriction disposers (returned by restrict). */
  toolRestrictionsDisposers: Array<() => void>
  /** The global section-switch waterfall disposer (registered once per agent). */
  waterfallDisposer?: () => void
  /** The registration snapshot digest (the configuration as last registered). */
  snapshotDigest: string
  /** Activation flag: set by a user click / a compaction trigger, consumed at the turn boundary. */
  pending: boolean
}

/** Configuration → a deterministic digest (used to compare registration snapshots). */
function digestOf(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Stack patches in order: a later patch overrides an earlier one (agent level →
 * conversation level). source is passed through (the overridden parent source).
 */
function applyPatches(def: ModuleDefinition, ...patches: Array<PromptModulePatch | undefined>): PromptModule {
  let channel = def.channel
  let order = def.order
  let enabled = def.enabled
  let text = def.text
  let source: PromptModulePatch['source']
  for (const p of patches) {
    if (p === undefined) continue
    if (p.channel !== undefined) channel = p.channel
    if (p.order !== undefined) order = p.order
    if (p.enabled !== undefined) enabled = p.enabled
    if (p.text !== undefined) text = p.text
    if (p.source !== undefined) source = p.source
  }
  return { name: def.name, channel, order, enabled, text, ...(source === undefined ? {} : { source }) }
}

/** Compile the panel's tool restriction table (by tool name) into the single filter tools.restrict accepts. */
function compileRestrictions(restrictions: Record<string, { allow?: string[]; deny?: string[] }>): { allow?: string[]; deny?: string[] } {
  const allow = new Set<string>()
  const deny = new Set<string>()
  for (const [tool, filter] of Object.entries(restrictions)) {
    if (filter === undefined) continue
    if (filter.deny?.length !== undefined && filter.deny.length > 0) {
      for (const name of filter.deny) deny.add(name)
    } else if (filter.allow?.length !== undefined && filter.allow.length > 0) {
      for (const name of filter.allow) allow.add(name)
    } else if (filter.deny === undefined && filter.allow === undefined) {
      // an empty filter is meaningless (tools.restrict throws); treat it as "keep this tool" → it produces no restriction
      continue
    }
  }
  return {
    ...(allow.size > 0 ? { allow: [...allow] } : {}),
    ...(deny.size > 0 ? { deny: [...deny] } : {}),
  }
}

/** The engine implementation. */
export class ContextAssemblerEngine implements ContextAssemblerService {
  private configReader: () => ContextPanelSettings = () => EMPTY_CONFIG
  private readonly registered = new Map<string, RegisteredAgent>()
  private readonly agentBySession = new Map<string, Agent>()
  /**
   * Reads one session projection value for an agent. Injected by the wiring,
   * which owns the sessionProjections registry; defaulting to "no value" keeps
   * the engine usable standalone (the panel then simply shows no preset origin).
   */
  private projectionReader: (agent: Agent, key: string) => unknown = () => undefined
  /**
   * The last UNFILTERED section list seen by this agent's assemble waterfall.
   * The panel reads it so a disabled section still appears (greyed) and can be
   * switched back on; the delivered assembly alone cannot show what was removed.
   */
  private readonly lastSections = new Map<string, Array<{ name: string; text: string }>>()

  /** @inheritdoc */
  setProjectionReader(reader: (agent: Agent, key: string) => unknown): void {
    this.projectionReader = reader
  }

  /** @inheritdoc */
  setConfigReader(reader: () => ContextPanelSettings): void {
    this.configReader = reader
    // the panel loads after the engine: already-registered agents are re-registered under the new configuration
    for (const agent of this.agentBySession.values()) this.registerForAgent(agent)
  }

  /** Read the current configuration (falling back to the empty configuration while the panel is not loaded). */
  private getConfig(): ContextPanelSettings {
    try {
      return this.configReader()
    } catch {
      return EMPTY_CONFIG
    }
  }

  /** Merge the agent-level and conversation-level overrides and sort by order (settings is the single source of module definitions). */
  private mergedModules(sessionId: string): PromptModule[] {
    const config = this.getConfig()
    const overrides = config.conversationOverrides[sessionId] ?? {}
    const names = new Set<string>([...Object.keys(config.modules), ...Object.keys(overrides)])
    const modules: PromptModule[] = []
    for (const name of names) {
      const def: ModuleDefinition = { name, channel: FALLBACK_CHANNEL, order: 0, enabled: true, text: '' }
      modules.push(applyPatches(def, config.modules[name], overrides[name]))
    }
    return modules.sort((a, b) => a.order - b.order)
  }

  /**
   * Resolve a live agent by its id.
   *
   * Read on demand rather than only tracked from `agent/created`: the registry
   * is the authoritative source, and a panel opened for an agent that was
   * created before this plugin mounted (or whose creation event this plugin
   * never received) still resolves. Falls back to whatever the creation event
   * already recorded.
   * @param sessionId - the agent (= session) id.
   * @returns the agent, or undefined when none is live under that id.
   */
  private agentFor(sessionId: string): Agent | undefined {
    const tracked = this.agentBySession.get(sessionId)
    if (tracked !== undefined) return tracked
    try {
      // Reached through ctx.get, NOT the property proxy: `agents` is not in
      // this plugin's declared injections, and an undeclared service is invisible
      // to the property proxy (dsh convention: optional services use ctx.get).
      const host = this.hostCtx as { get?: (name: string, strict?: boolean) => unknown } | undefined
      const agents = host?.get?.('agents', false) as { get(id: string): Agent | undefined } | undefined
      // The registry keys agents by their EXACT session id, and an id reaches
      // the panel in either spelling (`session-<uuid>` or a bare uuid,
      // depending on how the session was created). Trying the equivalent
      // spellings is what makes a lookup succeed whichever spelling the caller
      // holds; without it a live session resolves to nothing and the list falls
      // back to the static table — which is why the visible count varied.
      for (const candidate of sessionIdVariants(sessionId)) {
        const found = agents?.get(candidate)
        if (found !== undefined) {
          this.agentBySession.set(sessionId, found)
          return found
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * The host context, kept so agents can be resolved on demand (see `agentFor`).
   * Set by the wiring; absent in a standalone engine, which then relies on
   * `registerForAgent` alone.
   */
  private hostCtx: unknown

  /** @inheritdoc */
  setHostContext(ctx: unknown): void {
    this.hostCtx = ctx
  }

  /** @inheritdoc */
  registerForAgent(agent: Agent): void {
    this.agentBySession.set(agent.id, agent)
    const entry = this.registered.get(agent.id)
    if (entry === undefined) {
      this.registered.set(agent.id, { disposers: new Map(), toolRestrictionsDisposers: [], snapshotDigest: '', pending: false })
    }
    const current = this.registered.get(agent.id)!
    // The assemble waterfall is where "read → intercept → rewrite → send" happens
    // (packages/core/system-prompt: the waterfall hands every listener the
    // sectioned assembly, and the returned value is what the loop renders).
    // Registered once per agent; the config is read live so edits apply without
    // re-registering.
    if (current.waterfallDisposer === undefined) {
      current.waterfallDisposer = agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const transformed = await next()
        // Record the UNFILTERED section list first: the panel must be able to
        // list a disabled section (greyed out) and let the user re-enable it,
        // so the pre-filter view is the one worth keeping.
        this.lastSections.set(agent.id, transformed.sections.map(s => ({ name: s.name, text: s.text })))
        return this.rewriteSections(agent.id, transformed, this.presetIdFor(agent))
      })
    }
    this.reregister(agent, current)
  }

  /**
 * Deregister the old registrations, re-register the modules and tool restrictions
 * from the current configuration, and update the snapshot.
 */
  private reregister(agent: Agent, entry: RegisteredAgent): void {
    for (const dispose of entry.disposers.values()) {
      try { dispose() } catch { /* a failed deregistration does not block the re-registration */ }
    }
    entry.disposers.clear()
    for (const dispose of entry.toolRestrictionsDisposers) {
      try { dispose() } catch { /* as above */ }
    }
    entry.toolRestrictionsDisposers = []

    const modules = this.mergedModules(agent.id)
    for (const module of modules) {
      if (!module.enabled) continue
      const disposer = module.channel === 'section'
        ? agent.ctx.systemPrompt.section({ name: module.name, order: module.order, text: module.text })
        : agent.ctx.systemPrompt.context({ name: module.name, order: module.order, text: module.text })
      entry.disposers.set(module.name, disposer)
    }

    const config = this.getConfig()
    const compiled = compileRestrictions(config.toolRestrictions)
    if (compiled.allow !== undefined || compiled.deny !== undefined) {
      try {
        // Structural access: see the import note above (no dsh-tools types).
      const tools = (agent.ctx as unknown as {
        tools: { restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void }
      }).tools
      entry.toolRestrictionsDisposers = [tools.restrict(compiled)]
      } catch { /* an invalid restriction (an empty filter / an unknown tool) makes tools throw, and the prior state is kept silently */ }
    }

    entry.snapshotDigest = digestOf({
      modules: modules.filter(m => m.enabled),
      toolRestrictions: config.toolRestrictions,
    })
  }

  /** @inheritdoc */
  applyPending(agent: Agent): boolean {
    const entry = this.registered.get(agent.id)
    if (entry === undefined || !entry.pending) return false
    entry.pending = false
    this.reregister(agent, entry)
    return true
  }

  /** @inheritdoc */
  markPending(sessionId: string): void {
    const entry = this.registered.get(sessionId)
    if (entry !== undefined) entry.pending = true
  }

  /** @inheritdoc */
  isDirty(sessionId: string): boolean {
    const entry = this.registered.get(sessionId)
    if (entry === undefined) return false
    const config = this.getConfig()
    const current = digestOf({
      modules: this.mergedModules(sessionId).filter(m => m.enabled),
      toolRestrictions: config.toolRestrictions,
    })
    return current !== entry.snapshotDigest
  }

  /** @inheritdoc */
  getModuleView(agent: Agent): PromptModule[] {
    return this.mergedModules(agent.id)
  }

  /** @inheritdoc */
  getModuleViewForSession(sessionId: string): PromptModule[] {
    return this.agentFor(sessionId) === undefined ? [] : this.mergedModules(sessionId)
  }

  /**
   * The assembly context for one agent: `agent` AND `scope` set together.
   *
   * Both are required, and setting only `scope` from the agent's own context is
   * the mistake this guards against: `scopeOf(agent.ctx)` yields only the
   * agent's node key, so the assembly resolves the global layer and silently
   * omits every agent-scoped section (this plugin's own modules, and each tool's
   * guidance). Passing the agent as the scope is what the harness's own loop
   * does — see `assembleContextFor` in `@deepseek-ai/dsh-agent`, whose contract
   * is "agent and scope set together, so agent-scoped prompt and tool
   * contributions cannot be silently omitted".
   *
   * The behavior is mirrored rather than imported: upstream's plugin never
   * imports that package, because its declarations collide with the narrow
   * structural types this layer uses.
   * @param agent - the agent the assembly is for.
   * @returns the context to pass to `assemble()`.
   */
  private assembleContext(agent: Agent): { agent: Agent; scope: Agent } {
    return { agent, scope: agent }
  }

  /**
   * The agent's preset id, or undefined when it runs without one.
   * @param agent - the agent to read.
   * @returns the preset id, when the agentPreset projection carries one.
   */
  private presetIdFor(agent: Agent): string | undefined {
    try {
      const value = this.projectionReader(agent, 'agentPreset')
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** @inheritdoc */
  isOwnModuleForSession(sessionId: string, name: string): boolean {
    return this.getModuleViewForSession(sessionId).some(module => module.name === name)
  }

  /** @inheritdoc */
  presetIdForSession(sessionId: string): string | undefined {
    const agent = this.agentFor(sessionId)
    return agent === undefined ? undefined : this.presetIdFor(agent)
  }

  /** @inheritdoc */
  presetEntriesForSession(sessionId: string): PresetEntryInfo[] {
    const agent = this.agentFor(sessionId)
    return agent === undefined ? [] : presetEntriesOf(agent, this.projectionReader)
  }

  /**
   * Every section registered for one agent's scope, read straight from the
   * prompt registry — including sections registered BEFORE this plugin mounted.
   *
   * This is the forward path the assembled value cannot give: `assemble()`
   * reports only name+text, while the registry still holds each registration's
   * own argument (which carries its placement order). The registry's layer
   * tables are read defensively: the shape is verified before use, and an
   * unrecognized shape degrades to "not available" rather than throwing.
   * @param agent - the agent whose scope is read.
   * @returns section name to placement order, or undefined when unreadable.
   */
  private registrySections(agent: Agent): Map<string, number> | undefined {
    try {
      const prompt = (agent.ctx as unknown as { systemPrompt?: { layers?: unknown } }).systemPrompt
      // `layers.merge(scope, pick)` is the registry's own effective-view read:
      // it applies the scope chain (nearest scope wins a name) exactly as
      // assembly does, so the orders read here are the effective ones.
      const layers = prompt?.layers as {
        merge?: (scope: unknown, pick: (layer: unknown) => unknown) => Map<string, { order?: unknown }>
      } | undefined
      const merge = layers?.merge
      if (typeof merge !== 'function') return undefined
      const effective = merge.call(
        layers,
        // The agent itself is the scope key, matching assembly (see
        // `assembleContext`); the agent's own context node would resolve the
        // global layer only and report a fraction of the registered sections.
        agent,
        (layer: unknown) => (layer as { sections?: unknown })?.sections,
      )
      if (!(effective instanceof Map)) return undefined
      const out = new Map<string, number>()
      for (const [name, section] of effective) {
        const order = (section as { order?: unknown } | undefined)?.order
        if (typeof name === 'string' && typeof order === 'number') out.set(name, order)
      }
      return out.size > 0 ? out : undefined
    } catch {
      return undefined
    }
  }

  /** @inheritdoc */
  registeredOrdersForSession(sessionId: string): Record<string, number> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return {}
    const registry = this.registrySections(agent)
    return registry === undefined ? {} : Object.fromEntries(registry)
  }

  /** @inheritdoc */
  async assembleSectionsForSession(sessionId: string): Promise<Array<{ name: string; text: string }> | null> {
    // The UNFILTERED list captured by the assemble waterfall is the real
    // assembly the loop built (and it includes sections this layer is currently
    // suppressing, which the panel must still show). It only exists once a turn
    // has assembled, so the service is asked directly otherwise — which is also
    // why the agent is resolved on demand rather than tracked from an event.
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return null
    // Ask the prompt service for THIS agent's own assembly, and use the captured
    // waterfall list only to fill gaps it cannot cover.
    //
    // The registry is asked first on purpose: a captured list belongs to
    // whichever assembly last ran for that agent, and a narrower assembly (a
    // sub-agent's, or one built for a single step) returns a shorter list. Those
    // few rows then stood in for the agent's whole prompt, which is why the
    // panel showed a fraction of the sections. The capture still matters for
    // sections this layer currently suppresses (they are absent from the filtered
    // view), so it is merged in rather than dropped.
    let assemblySections: Array<{ name: string; text: string }> | undefined
    try {
      const assembly = await agent.ctx.systemPrompt.assemble(this.assembleContext(agent))
      assemblySections = assembly.sections.map((section) => ({ name: section.name, text: section.text }))
    } catch {
      assemblySections = undefined
    }
    let captured: Array<{ name: string; text: string }> | undefined
    for (const candidate of sessionIdVariants(sessionId)) {
      const hit = this.lastSections.get(candidate)
      if (hit !== undefined && hit.length > 0) { captured = hit; break }
    }
    // Union every source that knows a section, so the list is as complete as the
    // running prompt allows:
    //  1. the live assembly — authoritative membership and text for this agent;
    //  2. the waterfall capture — sections this layer is currently suppressing,
    //     which the assembly (post-filter) no longer contains;
    //  3. the prompt registry — every registration for the scope, including ones
    //     that render empty right now (their text is absent, so they list with
    //     an empty body rather than being dropped silently).
    const byName = new Map<string, { name: string; text: string }>()
    const registry = this.registrySections(agent)
    if (registry !== undefined) {
      for (const name of registry.keys()) byName.set(name, { name, text: '' })
    }
    for (const section of captured ?? []) byName.set(section.name, section)
    for (const section of assemblySections ?? []) byName.set(section.name, section)
    if (byName.size === 0) return assemblySections ?? captured ?? null
    // Order by the registry's own placement where known (it applies the scope
    // chain exactly as assembly does), then by the assembly's order for anything
    // the registry could not report.
    const assembled = new Map((assemblySections ?? []).map((section, index) => [section.name, index]))
    return [...byName.values()].sort((a, b) => {
      const oa = registry?.get(a.name)
      const ob = registry?.get(b.name)
      if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob
      if (oa !== undefined && ob === undefined) return -1
      if (oa === undefined && ob !== undefined) return 1
      return (assembled.get(a.name) ?? Number.MAX_SAFE_INTEGER)
        - (assembled.get(b.name) ?? Number.MAX_SAFE_INTEGER)
    })
  }

  /**
   * Apply this layer's decisions to one assembly: drop disabled sections,
   * substitute edited text, and re-order by the configured weights.
   *
   * The other two source kinds need no prompt rewrite — our own modules are
   * registered by this plugin (so their text is already ours) and preset text
   * is written back to the preset file — which is why only "plugin" sections
   * end up needing an override here.
   * @param agentId - the agent whose config applies.
   * @param assembly - the assembly produced by upstream listeners.
   * @param presetId - the agent's preset, naming the preset-level disable list.
   * @returns the assembly to send onward.
   */
  private rewriteSections<T extends { sections: Array<{ name: string; text: string }> }>(
    agentId: string,
    assembly: T,
    presetId?: string,
  ): T {
    const config = this.getConfig()
    // Two disable levels apply here (the deployment level is not ours to
    // manage): a conversation-level list scoped to this agent, and a
    // preset-level list shared by every conversation on that preset.
    const disabled = new Set([
      ...(config.conversationDisabledSections?.[agentId] ?? []),
      ...(presetId === undefined ? [] : (config.presetDisabledSections?.[presetId] ?? [])),
    ])
    const overrides = config.sectionOverrides?.[agentId] ?? {}
    const weights = config.sectionWeights?.[agentId] ?? {}
    if (disabled.size === 0 && Object.keys(overrides).length === 0 && Object.keys(weights).length === 0) return assembly
    const sections = assembly.sections
      .filter(section => !disabled.has(section.name))
      .map(section => {
        const override = overrides[section.name]
        return override === undefined ? section : { ...section, text: override }
      })
    // Re-order ONLY the weighted sections: they are sorted by their weight and
    // placed at the positions the weighted members already occupied, so an
    // untouched section never drifts (a plain sort would push every unweighted
    // section to one end and silently rewrite the prompt).
    const weighted = sections.filter(section => weights[section.name] !== undefined)
    if (weighted.length > 1) {
      const ordered = [...weighted].sort((a, b) => (weights[a.name] as number) - (weights[b.name] as number))
      let next = 0
      for (let i = 0; i < sections.length; i += 1) {
        if (weights[sections[i].name] === undefined) continue
        sections[i] = ordered[next]
        next += 1
      }
    }
    return { ...assembly, sections }
  }

  /**
   * Write an edited section's text back into the agent's preset composition.
   *
   * Only preset-injected sections can be written back: the text lives in a file
   * this user owns (`.agent-presets/<id>/agent.cordis.yml`), whereas a plugin's
   * prompt text lives inside that plugin's own package. The edit is line-level,
   * so the rest of the composition survives, and it takes effect for the next
   * session (the preset composes sessions, not turns).
   * @param name - the section name (its owning entry is resolved by section name).
   * @param text - the text to persist.
   * @param agentId - the agent whose preset is written.
   */
  writeSectionBackToPreset(name: string, text: string, agentId: string): void {
    // A section belongs to a preset ENTRY (its id) plus that entry's package
    // name; the mapping is declared by the preset plugins themselves.
    const entry = presetEntryForSection(name)
    if (entry === undefined) return
    try {
      // The plugin's OWN config key (persona reads `prefix`/`suffix`), never a
      // generic `text`: a key the plugin does not read writes nothing.
      updatePresetPluginConfig(agentId, entry.id, entry.name, { [entry.textKey]: text }, [
        'Written back by context-panel-write from the Context tab.',
        'Takes effect for sessions created after this one.',
      ])
    } catch {
      // A preset whose file is absent or read-only stays untouched: the local
      // edit still applies to the outgoing prompt, so nothing is lost.
    }
  }

  /** @inheritdoc */
  syncToPreset(agentId: string): void {
    try {
      const modules = this.mergedModules(agentId)
      // write in place into the assembly manifest (this plugin's row config.modules)
      syncToPresetFile(agentId, modules)
      // record: the sidecar plain-JSON snapshot (the earlier implementation's redundant archive)
      writePresetSnapshot(agentId, modules)
    } catch { /* a failed preset write does not affect the runtime */ }
  }

  /** @inheritdoc */
  editSkillDirs(dirs: string[], agentId: string): void {
    try {
      updatePresetPluginConfig(
        agentId,
        SKILL_FS_ID,
        SKILL_FS_NAME,
        { customSkillDirs: dirs, includeDefaultRoots: true },
        ['skill-filesystem 设置（由上下文面板写入；新会话生效）'],
      )
    } catch { /* a failed preset write does not affect the runtime */ }
  }

  /** @inheritdoc */
  editBaselineConfig(patch: Record<string, unknown>, agentId: string): void {
    try {
      updatePresetPluginConfig(
        agentId,
        AGENT_INSTRUCTIONS_ID,
        AGENT_INSTRUCTIONS_NAME,
        patch,
        ['agent-instructions 设置（由上下文面板写入；新会话生效）'],
      )
    } catch { /* a failed preset write does not affect the runtime */ }
  }

  /** @inheritdoc */
  dispose(): void {
    for (const entry of this.registered.values()) {
      for (const dispose of entry.disposers.values()) { try { dispose() } catch { /* ignore */ } }
      for (const dispose of entry.toolRestrictionsDisposers) { try { dispose() } catch { /* ignore */ } }
      if (entry.waterfallDisposer !== undefined) { try { entry.waterfallDisposer() } catch { /* ignore */ } }
    }
    this.registered.clear()
    this.agentBySession.clear()
  }
}