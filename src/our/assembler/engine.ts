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

  /** @inheritdoc */
  registerForAgent(agent: Agent): void {
    this.agentBySession.set(agent.id, agent)
    const entry = this.registered.get(agent.id)
    if (entry === undefined) {
      this.registered.set(agent.id, { disposers: new Map(), toolRestrictionsDisposers: [], snapshotDigest: '', pending: false })
    }
    const current = this.registered.get(agent.id)!
    // 全局 section 开关：assemble 瀑布里移除被禁用的 section（每 agent 注册一次，不随模块重注册）。
    if (current.waterfallDisposer === undefined) {
      current.waterfallDisposer = agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const transformed = await next()
        const disabled = new Set(this.getConfig().disabledSections ?? [])
        if (disabled.size === 0) return transformed
        return { ...transformed, sections: transformed.sections.filter((s) => !disabled.has(s.name)) }
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
    return this.agentBySession.has(sessionId) ? this.mergedModules(sessionId) : []
  }

  /** @inheritdoc */
  presetEntriesForSession(sessionId: string): PresetEntryInfo[] {
    const agent = this.agentBySession.get(sessionId)
    return agent === undefined ? [] : presetEntriesOf(agent, this.projectionReader)
  }

  /** @inheritdoc */
  async assembleSectionsForSession(sessionId: string): Promise<Array<{ name: string; text: string }> | null> {
    const agent = this.agentBySession.get(sessionId)
    if (agent === undefined) return null
    try {
      const scope = scopeOf(agent.ctx)
      const assembly = await agent.ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
      return assembly.sections.map((section) => ({ name: section.name, text: section.text }))
    } catch {
      return null
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