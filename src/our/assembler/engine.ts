/**
 * 引擎本体：模块注册表 + 注入 + 「激活 → turn 边界应用」更新模型。
 *
 * 职责（对齐 plans/2026-08-19-上下文工程后端部分.md §1.4/§6）：
 * - 注册快照：每个 agent 上次注册的模块/工具限制 digest；getDirty 用它对比当前配置；
 * - 激活标记（pending）：applyChanges()（用户点击）或压缩总结（compaction/summary
 *   会话事件）置位；只在 turn 边界（agent/inbox/inserted）执行重注册；
 * - 变化不自动提交：配置落盘只让 getDirty 变 true，不触发任何重注册。
 *
 * 与源码实证的差异（相对方案文档）：
 * - compaction/summary 是 durable 会话事件而非 live 事件，改经 ctx.on('session/event')
 *   在投影层判断事件类型触发激活（docs/会话持久化系统调研.md §2.4）；
 * - 预设快照写用户级 .agent-presets/<agent>/context-modules.json（档案旁路文件），
 *   不覆写 agent.cordis.yml —— 方案原样把我们的配置写进 agent.cordis.yml 会破坏
 *   该预设的真实装配（persona/工具行丢失）。
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
import { scopeOf } from '@deepseek-ai/dsh-scope'
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

/** 一个模块在引擎侧的最小定义（兜底值；真实定义在 settings，单一数据源）。 */
export interface ModuleDefinition {
  /** 注册名。 */
  name: string
  /** 通道：稳定高权威→section；动态低权威→context（决定前缀缓存命运）。 */
  channel: 'section' | 'context'
  /** 默认组装顺序。 */
  order: number
  /** 默认开关。 */
  enabled: boolean
  /** 默认注入文本。 */
  text: string
}

/**
 * 模块通道/顺序的兜底默认值。模块定义（文本/通道/顺序/开关）的单一数据源是
 * context-panel 的 settings 命名空间（DEFAULT_SETTINGS.modules，前端可编辑），
 * 引擎只在此处为「settings 中未出现的名字」提供最小兜底（settings 为空时不注入）。
 */
export const FALLBACK_CHANNEL: 'section' | 'context' = 'section'

/** 一个 agent 的注册态。 */
interface RegisteredAgent {
  /** 模块名 → 注册 disposer。 */
  disposers: Map<string, () => void>
  /** 工具限制 disposer（restrict 返回）。 */
  toolRestrictionsDisposers: Array<() => void>
  /** 全局 section 开关 waterfall disposer（每个 agent 注册一次）。 */
  waterfallDisposer?: () => void
  /** 注册快照 digest（上次注册的配置）。 */
  snapshotDigest: string
  /** 激活标记：用户点击 / 压缩触发后置位，turn 边界消费。 */
  pending: boolean
}

/** 配置 → 确定性 digest（注册快照对比用）。 */
function digestOf(value: unknown): string {
  return JSON.stringify(value)
}

/** 按序叠加补丁：后置补丁覆盖前置（agent 级 → 会话级）。source 透传（覆盖的父来源）。 */
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

/** 把面板工具限制表（按工具名）编译成 tools.restrict 接受的单个 filter。 */
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
      // 空 filter 无意义（tools.restrict 会抛），按「保留该工具」处理 → 不产生限制
      continue
    }
  }
  return {
    ...(allow.size > 0 ? { allow: [...allow] } : {}),
    ...(deny.size > 0 ? { deny: [...deny] } : {}),
  }
}

/** 引擎实现。 */
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
    // 面板晚于引擎装载：已注册的 agent 按新配置重注册
    for (const agent of this.agentBySession.values()) this.registerForAgent(agent)
  }

  /** 读取当前配置（面板未装载时兜底空配置）。 */
  private getConfig(): ContextPanelSettings {
    try {
      return this.configReader()
    } catch {
      return EMPTY_CONFIG
    }
  }

  /** 合并 agent 级 + 会话级覆盖，按 order 排序（settings 是模块定义单一数据源）。 */
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
        return this.rewriteSections(agent.id, transformed)
      })
    }
    this.reregister(agent, current)
  }

  /** 注销旧注册，按当前配置重注册模块与工具限制，更新快照。 */
  private reregister(agent: Agent, entry: RegisteredAgent): void {
    for (const dispose of entry.disposers.values()) {
      try { dispose() } catch { /* 注销失败不阻断重注册 */ }
    }
    entry.disposers.clear()
    for (const dispose of entry.toolRestrictionsDisposers) {
      try { dispose() } catch { /* 同上 */ }
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
      } catch { /* 非法限制（空 filter / 未知工具）由 tools 抛错，静默保留原状 */ }
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
        scopeOf(agent.ctx),
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
      const scope = scopeOf(agent.ctx)
      const assembly = await agent.ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
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
   * @returns the assembly to send onward.
   */
  private rewriteSections<T extends { sections: Array<{ name: string; text: string }> }>(agentId: string, assembly: T): T {
    const config = this.getConfig()
    const disabled = new Set(config.disabledSections ?? [])
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
      updatePresetPluginConfig(agentId, entry.id, entry.name, { text }, [
        'Written back by context-panel-write from the Context tab.',
        'Takes effect for sessions created after this one.',
      ])
    } catch {
      // A preset whose file is absent or read-only stays untouched: the local
      // edit still applies to the outgoing prompt, so nothing is lost.
    }
  }

  /** 渲染当前生效模块为一段可读文本（快照/展示用）。 */
  renderModules(agentId: string): string {
    return this.mergedModules(agentId)
      .filter(m => m.enabled)
      .map(m => `# ${m.name}（${m.channel}，order ${m.order}）\n${m.text}`)
      .join('\n\n')
  }

  /** @inheritdoc */
  syncToPreset(agentId: string): void {
    try {
      const modules = this.mergedModules(agentId)
      // 原位写入装配清单（本插件行 config.modules）
      syncToPresetFile(agentId, modules)
      // 备案：sidecar 纯 JSON 快照（早期实现的冗余档案）
      writePresetSnapshot(agentId, modules)
    } catch { /* 预设写失败不影响运行时 */ }
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
    } catch { /* 预设写失败不影响运行时 */ }
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
    } catch { /* 预设写失败不影响运行时 */ }
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