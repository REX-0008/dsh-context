/**
 * The engine itself: the module registry + injection + the "activate → apply at
 * the turn boundary" update model.
 *
 * Responsibilities (following plans/ §1.4/§6):
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
import { injectorLabel } from '../known-injectors'

/** One injection source observed in a step batch, with what it injected. */
export interface InjectionSeen {
  /** The label the list and the filter share (see `injectorLabel`). */
  label: string
  /** The text this source injected, trimmed for display; empty when it had none. */
  text: string
  /** How many messages this source contributed to the batch. */
  count: number
}

/**
 * One message's readable text, for the injection listing.
 * @param message - a step-batch message of unknown shape.
 * @returns the concatenated text blocks, or an empty string.
 */
function messageTextOf(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n').trim()
}

/** What happened to a parked prune when its boundary arrived. */
export interface PruneOutcome {
  ok: boolean
  /**
   * Why it did not run: no compaction engine, the agent was busy (the selection
   * stays parked for the next quiet boundary), or the attempt failed.
   */
  reason?: 'unavailable' | 'busy' | 'failed'
  /** The surface seqs actually pruned, when it ran. */
  pruned?: number[]
  /** The failure text, for the log and the panel. */
  detail?: string
}

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
  SKILL_FS_ID,
  SKILL_FS_NAME,
  updatePresetPluginConfig,
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
  /** Tool restriction disposers (returned by restrict). */
  toolRestrictionsDisposers: Array<() => void>
  /** The global section-switch waterfall disposer (registered once per agent). */
  waterfallDisposer?: () => void
  /** The pre-step listener that suppresses requested injections, once installed. */
  preStepDisposer?: () => void
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
  for (const filter of Object.values(restrictions)) {
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
  /** Conversations with a prune requested but not yet applied (see `requestPrune`). */
  private readonly pendingPrunes = new Map<string, Set<number>>()
  /** Injection source kinds observed in each agent's step batches. */
  private readonly injectionKinds = new Map<string, InjectionSeen[]>()

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

  /**
   * The module set, sorted by order. The definitions file is the source (the
   * settings value is composed over at the config reader): there is ONE definition
   * per name and no per-conversation copy, so this needs no session to resolve.
   * @returns every module the definitions declare.
   */
  private mergedModules(): PromptModule[] {
    const config = this.getConfig()
    const modules: PromptModule[] = []
    for (const name of Object.keys(config.modules)) {
      const def: ModuleDefinition = { name, channel: FALLBACK_CHANNEL, order: 0, enabled: true, text: '' }
      modules.push(applyPatches(def, config.modules[name]))
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
          // Register it, do not merely remember it: the listeners (the assemble
          // waterfall and the pre-step injection pass) are what make this layer
          // work, and an agent resolved on demand — one created before this
          // plugin mounted, which is every agent after a restart — would
          // otherwise be tracked with no listeners at all.
          this.registerForAgent(found)
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
    let entry = this.registered.get(agent.id)
    if (entry === undefined) {
      entry = { toolRestrictionsDisposers: [], snapshotDigest: '', pending: false }
      this.registered.set(agent.id, entry)
    }
    const current = entry
    // The assemble waterfall is where "read → intercept → rewrite → send" happens
    // (packages/core/system-prompt: the waterfall hands every listener the
    // sectioned assembly, and the returned value is what the loop renders).
    // Registered once per agent; the config is read live so edits apply without
    // re-registering.
    // Injection suppression rides the pre-step waterfall. Injectors that append
    // to the step batch (agent-instructions, skill-catalog, time-context, …) are
    // not registered in the prompt registry, so this is the only place they can
    // be acted on. FILTERING only: the batch is passed on otherwise untouched, so
    // another plugin's additions are unaffected and its rewrites still apply.
    if (current.preStepDisposer === undefined) {
      current.preStepDisposer = agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        // Same posture as the assemble waterfall: recording and suppression are
        // ours to lose, and a step that cannot run is not. Any failure here
        // leaves the batch exactly as the other producers built it.
        try {
        // Record what actually injected into this batch, so the panel can show the
        // CONTENT as well as the producer, and so a producer the static list does
        // not know still becomes suppressible. Labelled the same way the list and
        // the filter are (see `injectorLabel`), or the three would not meet.
          const seen = new Map<string, InjectionSeen>()
          for (const message of decision.messages ?? []) {
            const label = injectorLabel((message as { source?: unknown }).source)
            if (label === undefined) continue
            const existing = seen.get(label)
            const text = messageTextOf(message)
            if (existing === undefined) {
              seen.set(label, { label, text, count: 1 })
            } else {
              existing.count += 1
              // Keep the first non-empty text: a label that injected prose is more
              // informative than one that injected only a notice.
              if (existing.text === '' && text !== '') existing.text = text
            }
          }
          if (seen.size > 0) this.injectionKinds.set(agent.id, [...seen.values()])
          const suppressed = this.getConfig().suppressedInjections?.[agent.id]
          if (suppressed === undefined || suppressed.length === 0) return decision
          const blocked = new Set(suppressed)
          const admitted = decision.messages ?? []
          const messages = admitted.filter((message) => {
            const label = injectorLabel((message as { source?: unknown }).source)
            return label === undefined || !blocked.has(label)
          })
          return messages.length === admitted.length ? decision : { ...decision, messages }
        } catch {
          return decision
        }
      })
    }
    if (current.waterfallDisposer === undefined) {
      current.waterfallDisposer = agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const transformed = await next()
        // EVERY failure below degrades to "this layer did not apply", never to a
        // failed assembly. This listener runs on every request, so an unguarded
        // throw here would take the whole system prompt down for every
        // conversation — a far worse outcome than a section override or weight
        // that quietly stops applying until the bug is fixed.
        try {
          // Record the UNFILTERED section list first: the panel must be able to
          // list a disabled section (greyed out) and let the user re-enable it,
          // so the pre-filter view is the one worth keeping.
          this.lastSections.set(agent.id, transformed.sections.map(s => ({ name: s.name, text: s.text })))
          return this.rewriteSections(agent.id, transformed, this.presetIdFor(agent))
        } catch {
          return transformed
        }
      })
    }
    this.reregister(agent, current)
  }

  /**
 * Deregister the old registrations, re-register the modules and tool restrictions
 * from the current configuration, and update the snapshot.
 */
  private reregister(agent: Agent, entry: RegisteredAgent): void {
    for (const dispose of entry.toolRestrictionsDisposers) {
      try { dispose() } catch { /* as above */ }
    }
    entry.toolRestrictionsDisposers = []

    // The modules are NOT registered here.
    //
    // @our/prompt-modules owns the loading: it reads the definitions file and
    // hands the modules to the harness, so the prompt content survives anything
    // that happens to this plugin (which chases upstream and therefore changes).
    // Registering them here as well would ALSO throw: dsh refuses a duplicate
    // section name within a scope ("prompt section \"X\" is already registered").
    //
    // What stays here is the DIGEST: the dirty check below compares the
    // definitions' current state with what was last applied, so the panel still
    // knows when a change is waiting on the next turn.
    const modules = this.mergedModules()

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
      modules: this.mergedModules().filter(m => m.enabled),
      toolRestrictions: config.toolRestrictions,
    })
    return current !== entry.snapshotDigest
  }

  /** @inheritdoc */
  getModuleView(_agent: Agent): PromptModule[] {
    return this.mergedModules()
  }

  /** @inheritdoc */
  getModuleViewForSession(sessionId: string): PromptModule[] {
    return this.agentFor(sessionId) === undefined ? [] : this.mergedModules()
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
  private registrySections(agent: Agent, table: 'sections' | 'contexts' = 'sections'): Map<string, number> | undefined {
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
        (layer: unknown) => (layer as Record<string, unknown>)[table],
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
  async contextsForSession(sessionId: string): Promise<Array<{ name: string; order: number; text: string }> | null> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return null
    // Contexts are the declared half of the runtime context: they ride the same
    // assembly as sections (PromptAssembly.contexts) and the same waterfall, so
    // they are read from the assembly rather than from a second registry walk.
    try {
      const assembly = await agent.ctx.systemPrompt.assemble(this.assembleContext(agent))
      const orders = this.registrySections(agent, 'contexts')
      return assembly.contexts.map(entry => ({
        name: entry.name,
        order: orders?.get(entry.name) ?? 0,
        text: entry.text,
      }))
    } catch {
      return null
    }
  }

  /**
   * Select one row for pruning, or drop it from the selection.
   *
   * A selection holds individual rows, and the prune that eventually runs takes
   * the closed range they span: selecting rows 3, 4 and 5 prunes 3–5. That is
   * the harness's own granularity — `compactRegion(start, end)` takes one
   * balanced span — so the selection is a way of choosing the span, not a set of
   * independent deletions.
   *
   * Nothing is pruned here. The selection is parked and run at the next turn
   * boundary (see `applyPrunes`); until then every selected row can be
   * deselected individually.
   * @param sessionId - the agent (= session) id.
   * @param seq - the surface node the row stands for.
   */
  togglePruneSelection(sessionId: string, seq: number): void {
    const current = this.pendingPrunes.get(sessionId) ?? new Set<number>()
    if (current.has(seq)) current.delete(seq)
    else current.add(seq)
    if (current.size === 0) this.pendingPrunes.delete(sessionId)
    else this.pendingPrunes.set(sessionId, current)
  }

  /**
   * Drop one row from the selection, or the whole selection.
   * @param sessionId - the agent (= session) id.
   * @param seq - the row to drop; omitted clears the whole selection.
   * @returns whether anything was selected.
   */
  cancelPrune(sessionId: string, seq?: number): boolean {
    const current = this.pendingPrunes.get(sessionId)
    if (current === undefined) return false
    if (seq === undefined) return this.pendingPrunes.delete(sessionId)
    current.delete(seq)
    if (current.size === 0) { this.pendingPrunes.delete(sessionId); return false }
    return true
  }

  /**
   * The smallest balanced span that contains one node.
   *
   * A node is not always prunable on its own: the harness refuses a cut that
   * would separate a tool call from its result, so a `tool/result` needs the
   * assistant message that called it, and a message carrying tool calls needs
   * those results. The span returned here is that node's minimal legal unit —
   * for a plain message it is the node itself.
   *
   * Balance is derived from the surface directly (a call adds to the in-progress
   * count, a result removes one) rather than by importing the harness helper,
   * which this layer deliberately does not depend on.
   * @param agent - the agent whose surface is read.
   * @param seq - the selected node.
   * @returns the span's first and last seqs, or undefined when the surface is unreadable.
   */
  private balancedSpanFor(agent: Agent, seq: number): { start: number; end: number } | undefined {
    try {
      const session = (agent as unknown as {
        session?: {
          surface?: { nodes?: unknown }
          eventAt?: (seq: number) => { type?: unknown; data?: unknown } | undefined
        }
      }).session
      const nodes = session?.surface?.nodes
      const eventAt = session?.eventAt
      if (!Array.isArray(nodes) || typeof eventAt !== 'function') return undefined
      const index = (nodes as number[]).indexOf(seq)
      if (index === -1) return undefined
      const delta = (at: number): number => {
        const event = eventAt.call(session, (nodes as number[])[at])
        if (event?.type === 'assistant/message') {
          const content = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
          return Array.isArray(content)
            ? content.filter((block: { type?: unknown }) => block.type === 'tool-call').length
            : 0
        }
        return event?.type === 'tool/result' ? -1 : 0
      }
      // A cut before index i is balanced when no call is open there.
      const balancedBefore = (i: number): boolean => {
        let open = 0
        for (let k = 0; k < i; k += 1) open += delta(k)
        return open === 0
      }
      // Expanding outward to the nearest balanced boundaries is what makes the
      // span legal; a node that is already balanced yields itself.
      let start = index
      while (start > 0 && !balancedBefore(start)) start -= 1
      let end = index
      // The closing cut must also be balanced: walk right until no call is open
      // after the span's last node.
      let open = 0
      for (let k = 0; k <= end; k += 1) open += delta(k)
      while (open !== 0 && end + 1 < (nodes as number[]).length) {
        end += 1
        open += delta(end)
      }
      if (open !== 0 || !balancedBefore(start)) return undefined
      return { start: (nodes as number[])[start], end: (nodes as number[])[end] }
    } catch {
      return undefined
    }
  }

  /**
   * Select every node of one round, or clear that round's selection.
   *
   * The panel resolves a round to its node seqs (it already maps rows to rounds)
   * and hands them here in one call, so "prune this round" is one action for the
   * user while remaining per-node underneath — the same calls an individually
   * picked selection produces.
   * @param sessionId - the agent (= session) id.
   * @param seqs - the round's node seqs.
   * @param select - true to select them all, false to drop them.
   */
  selectPruneSeqs(sessionId: string, seqs: number[], select: boolean): void {
    const current = this.pendingPrunes.get(sessionId) ?? new Set<number>()
    for (const seq of seqs) {
      if (select) current.add(seq)
      else current.delete(seq)
    }
    if (current.size === 0) this.pendingPrunes.delete(sessionId)
    else this.pendingPrunes.set(sessionId, current)
  }

  /**
   * The surface seqs of the runtime-context snapshot nodes for one conversation.
   *
   * The snapshot is ONE user-role node stamped with the system-prompt plugin as
   * its producer (`source.plugin === '@deepseek-ai/dsh-system-prompt'`); the
   * declared contexts all render into that single node rather than one node each.
   * Finding it is what lets the panel prune the snapshot the way it prunes a
   * message row.
   * @param sessionId - the agent (= session) id.
   * @returns the snapshot node seqs; empty when none is on the surface.
   */
  runtimeContextNodeSeqs(sessionId: string): number[] {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return []
    try {
      const session = (agent as unknown as {
        session?: {
          surface?: { nodes?: unknown }
          eventAt?: (seq: number) => { type?: unknown; data?: unknown } | undefined
        }
      }).session
      const nodes = session?.surface?.nodes
      const eventAt = session?.eventAt
      if (!Array.isArray(nodes) || typeof eventAt !== 'function') return []
      const out: number[] = []
      for (const seq of nodes as number[]) {
        const event = eventAt.call(session, seq)
        if (event?.type !== 'user/message') continue
        const source = (event.data as { message?: { source?: { kind?: unknown; plugin?: unknown } } } | undefined)?.message?.source
        if (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt') out.push(seq)
      }
      return out
    } catch {
      return []
    }
  }

  /** @inheritdoc */
  pendingPruneSeqs(sessionId: string): number[] {
    return [...(this.pendingPrunes.get(sessionId) ?? [])].sort((a, b) => a - b)
  }

  /**
   * Whether this conversation has rows selected for pruning.
   * @param sessionId - the agent (= session) id.
   * @returns true while a selection is parked.
   */
  hasPendingPrune(sessionId: string): boolean {
    return this.pendingPrunes.has(sessionId)
  }

  /**
   * Run any parked prune through the agent's idle-maintenance seam.
   *
   * Called at the turn boundary. The window between the button and this pass is
   * what makes the action cancellable; once it runs, the surface replacement is
   * durable and cannot be undone (there is no un-replace in the harness), which
   * is why the panel warns before the request is made.
   * @param agent - the agent whose parked request should run.
   * @returns the outcome, or null when nothing was requested or it could not run.
   */
  async applyPrunes(agent: Agent): Promise<PruneOutcome | null> {
    const selection = this.pendingPrunes.get(agent.id)
    if (selection === undefined || selection.size === 0) return null
    const compaction = this.compactionService()
    if (compaction === undefined) {
      // Without a compaction engine the request cannot be honoured; drop it so
      // the panel stops reporting a selection that will never run.
      this.pendingPrunes.delete(agent.id)
      return { ok: false, reason: 'unavailable' }
    }
    // One call per selected node, in surface order. The harness prunes one
    // balanced span per call, so pruning the selected nodes individually is what
    // keeps "I selected three rows" meaning exactly three removals — deriving one
    // span from their ends would silently take everything between them.
    const seqs = [...selection].sort((a, b) => a - b)
    try {
      // Claim the idle phase BEFORE clearing the selection: `runMaintenance`
      // throws synchronously when a turn (or another maintenance task) already
      // owns the agent, and in that case the selection must stay parked for the
      // next quiet boundary rather than being silently consumed.
      const run = agent.runMaintenance(async (signal) => {
        for (const seq of seqs) {
          if (signal.aborted) break
          // Each selected node is pruned as its own minimal legal unit: a tool
          // result pulls in the call that produced it, because the harness
          // refuses a cut that separates the pair. The user selects items; the
          // harness needs balanced ends.
          const span = this.balancedSpanFor(agent, seq) ?? { start: seq, end: seq }
          await compaction.compactRegion(span.start, span.end, agent, signal)
        }
      })
      this.pendingPrunes.delete(agent.id)
      await run
      return { ok: true, pruned: seqs }
    } catch (error) {
      // Busy keeps the selection; a genuine failure does not (retrying a broken
      // range every boundary would never succeed).
      const busy = String(error).includes('maintenance') || String(error).includes('turn')
      if (!busy) this.pendingPrunes.delete(agent.id)
      return { ok: false, reason: busy ? 'busy' : 'failed', detail: String(error) }
    }
  }

  /**
   * The compaction engine, when this deployment composes one.
   *
   * Reached through `ctx.get` rather than a property: `compaction` is not in
   * this plugin's declared injections, and an undeclared service is invisible to
   * the property proxy.
   * @returns the engine, or undefined when no compaction capability exists.
   */
  private compactionService(): {
    compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<unknown>
  } | undefined {
    try {
      const host = this.hostCtx as { get?: (name: string, strict?: boolean) => unknown } | undefined
      const service = host?.get?.('compaction', false) as { compactRegion?: unknown } | undefined
      if (service === undefined || typeof service.compactRegion !== 'function') return undefined
      return service as {
        compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<unknown>
      }
    } catch {
      return undefined
    }
  }

  /** @inheritdoc */
  observedInjectionsForSession(sessionId: string): InjectionSeen[] {
    return this.injectionKinds.get(sessionId) ?? []
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
      assemblySections = assembly.sections.map(section => ({ name: section.name, text: section.text }))
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
  private rewriteSections<T extends {
    sections: Array<{ name: string; text: string }>
    contexts?: Array<{ name: string; text: string }>
  }>(
    agentId: string,
    assembly: T,
    presetId?: string,
  ): T {
    const config = this.getConfig()
    // ONE level applies here (the deployment level is not ours to manage): the
    // preset's off list, shared by every conversation running it. Content — the
    // text overrides and the weights below — is global, so it needs no level.
    const disabled = new Set(presetId === undefined ? [] : (config.presetDisabledSections?.[presetId] ?? []))
    const overrides: Record<string, string | undefined> = config.sectionOverrides ?? {}
    const weights: Record<string, number | undefined> = config.sectionWeights ?? {}
    const contextsDisabled = new Set(presetId === undefined ? [] : (config.presetDisabledContexts?.[presetId] ?? []))
    const contextOverrides: Record<string, string | undefined> = config.contextOverrides ?? {}
    if (disabled.size === 0 && Object.keys(overrides).length === 0 && Object.keys(weights).length === 0
      && contextsDisabled.size === 0 && Object.keys(contextOverrides).length === 0) return assembly
    const sections = assembly.sections
      .filter(section => !disabled.has(section.name))
      .map((section) => {
        const override = overrides[section.name]
        return override === undefined ? section : { ...section, text: override }
      })
    // Re-order ONLY the weighted sections: they are sorted by their weight and
    // placed at the positions the weighted members already occupied, so an
    // untouched section never drifts (a plain sort would push every unweighted
    // section to one end and silently rewrite the prompt).
    const weighted = sections.filter(section => weights[section.name] !== undefined)
    if (weighted.length > 1) {
      const ordered = [...weighted].sort((a, b) => (weights[a.name] ?? 0) - (weights[b.name] ?? 0))
      let next = 0
      for (let i = 0; i < sections.length; i += 1) {
        if (weights[sections[i].name] === undefined) continue
        sections[i] = ordered[next]
        next += 1
      }
    }
    // Contexts follow the same two decisions (drop, or substitute the text);
    // they carry no weight of their own, so no re-ordering applies.
    const contexts = assembly.contexts === undefined
      ? undefined
      : assembly.contexts
        .filter(context => !contextsDisabled.has(context.name))
        .map((context) => {
          const override = contextOverrides[context.name]
          return override === undefined ? context : { ...context, text: override }
        })
    return { ...assembly, sections, ...(contexts === undefined ? {} : { contexts }) }
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
      for (const dispose of entry.toolRestrictionsDisposers) { try { dispose() } catch { /* ignore */ } }
      if (entry.waterfallDisposer !== undefined) { try { entry.waterfallDisposer() } catch { /* ignore */ } }
      if (entry.preStepDisposer !== undefined) { try { entry.preStepDisposer() } catch { /* ignore */ } }
    }
    this.registered.clear()
    this.agentBySession.clear()
  }
}
