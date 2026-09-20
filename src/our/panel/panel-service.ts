/**
 * ctx.contextPanel 服务实现（Profile 层面板后端）。
 *
 * 前端经 webServer 路由（/api/context-panel/action）触发动作，本服务是 host 侧
 * 逻辑收口，直接持引擎实例（同包内 import）。settings 是配置单一数据源，
 * 由本服务与引擎在进程内读写。
 *
 * editSkillDirs / editBaselineConfig：委托引擎**原位修改** agent 预设装配清单
 * （.agent-presets/<agent>/agent.cordis.yml 对应插件行 config），新会话（换代）生效。
 * @module @our/context-panel/panel-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ContextAssemblerService } from '../assembler/service'
import type { ContextPanelSettings, PromptModulePatch } from '../types'
import { mergePatch } from './settings'

/** ctx.contextPanel 对外契约。 */
export interface ContextPanelService {
  /**
   * 当前会话的模块视图 + 作用域/同步状态 + dirty。
   * @param sessionId - 目标会话 id。
   * @returns 合并后的模块列表（含未启用）与面板元信息。
   */
  getSnapshot(sessionId: string): {
    modules: Array<{ name: string; channel: 'section' | 'context'; order: number; enabled: boolean; text: string }>
    scope: 'conversation' | 'agent'
    autoSyncPreset: boolean
    dirty: boolean
  }
  /**
   * 按作用域写模块补丁（conversation → 会话覆盖；agent → 权威源）。
   * @param target - 写入层级。
   * @param name - 模块名。
   * @param patch - 补丁。
   * @param sessionId - 会话 id。
   */
  updateModule(target: 'conversation' | 'agent', name: string, patch: PromptModulePatch, sessionId: string): Promise<void>
  /**
   * 会话级覆盖全量覆盖到 agent 级并清空本会话覆盖（前端确认弹窗后调）。
   * @param sessionId - 会话 id。
   */
  syncConversationToAgent(sessionId: string): Promise<void>
  /**
   * 设置某工具的限制（禁用 → { deny:[name] }；启用 → {} 删除）。
   * @param name - 工具名。
   * @param filter - 限制；空 filter 表示清除该工具限制。
   */
  setToolRestriction(name: string, filter: { allow?: string[]; deny?: string[] }): Promise<void>
  /**
   * 当前会话是否有未应用修改（配置 digest ≠ 注册快照 digest）。
   * @param sessionId - 会话 id。
   */
  getDirty(sessionId: string): boolean
  /**
   * 激活更新（pending=true，下个 turn 边界执行重注册）。
   * @param sessionId - 会话 id。
   */
  applyChanges(sessionId: string): void
  /** 切换编辑作用域（conversation → agent 会丢弃会话覆盖，前端先确认）。 */
  setScope(scope: 'conversation' | 'agent'): Promise<void>
  /** 切换自动同步预设开关。 */
  setAutoSyncPreset(b: boolean): Promise<void>
  /**
   * 记录技能目录设置（原位修改 agent 预设 skill-filesystem 行 config，换代生效）。
   * @param dirs - customSkillDirs。
   * @param sessionId - 会话 id。
   */
  editSkillDirs(dirs: string[], sessionId: string): void
  /**
   * 记录基线设置（原位修改 agent 预设 agent-instructions 行 config，换代生效）。
   * @param patch - agent-instructions config 键值。
   * @param sessionId - 会话 id。
   */
  editBaselineConfig(patch: Record<string, unknown>, sessionId: string): void
}

/**
 * 构造 ctx.contextPanel 服务（同包内直接持引擎实例）。
 * @param ctx - 插件根 context。
 * @param getScope - 返回 settings namespace scope（读/写配置）。
 * @param engine - 引擎实例。
 * @returns 服务实现。
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
      // 原位修改 agent 预设 skill-filesystem 行 config（引擎实现，换代生效）
      engine.editSkillDirs(dirs, sessionId)
    },
    editBaselineConfig(patch, sessionId) {
      // 原位修改 agent 预设 agent-instructions 行 config（引擎实现，换代生效）
      engine.editBaselineConfig(patch, sessionId)
    },
  }
}

