/**
 * @our/context-panel 的引擎服务契约（ctx.contextAssembler，同包内 panel-service
 * 直接持引擎实例；暴露服务供未来 memory 等内部/外部模块消费）。
 * @module @our/context-panel/assembler/service
 */
import type { AgentFace as Agent } from '../agent-face'
import type { PresetEntryInfo } from './preset-entries'
import type { PromptModule } from '../types'

/** 引擎服务契约（panel-service 与未来记忆/其他消费者注入使用）。 */
export interface ContextAssemblerService {
  /**
   * 注入配置读取器：context-panel 注册完 settings 后调用，返回当前配置快照。
   * 设置后已存在的 agent 会按新配置重注册（面板晚于引擎装载时兜底）。
   * @param reader - 返回 context-panel settings namespace 当前值。
   */
  setConfigReader(reader: () => import('../types').ContextPanelSettings): void
  /**
   * 新会话创建（agent/created）：按当前配置注册该 agent 的模块与工具限制，存注册快照。
   * @param agent - 新 agent。
   */
  registerForAgent(agent: Agent): void
  /**
   * turn 边界应用（agent/inbox/inserted）：有激活标记才重注册模块 + 重应用工具限制 + 更新快照。
   * @param agent - 目标 agent。
   * @returns 是否真的应用了更新。
   */
  applyPending(agent: Agent): boolean
  /**
   * 激活该 agent 的更新（用户点击更新上下文 / 压缩总结自动触发）。
   * @param sessionId - agent 的会话 id（= agent.id）。
   */
  markPending(sessionId: string): void
  /**
   * 配置是否与注册快照有差异（有未应用修改）。
   * @param sessionId - agent 的会话 id。
   * @returns 有差异为 true。
   */
  isDirty(sessionId: string): boolean
  /**
   * 当前会话合并后的模块视图（agent 级 + 会话级覆盖）。
   * @param agent - 目标 agent。
   * @returns 排序后的模块列表（含未启用项）。
   */
  getModuleView(agent: Agent): PromptModule[]
  /**
   * 按会话 id 读合并后的模块视图（panel-service 的 getSnapshot 用；未知会话返回空）。
   * @param sessionId - agent 的会话 id。
   * @returns 排序后的模块列表（含未启用项）。
   */
  getModuleViewForSession(sessionId: string): PromptModule[]
  /**
   * 当前 agent 预设的条目列表（id/name/config），供系统提示词板块来源判定（预设可关联/可覆盖）。
   * @param sessionId - agent 的会话 id。
   * @returns 预设条目；无预设/未知会话返回空。
   */
  presetEntriesForSession(sessionId: string): PresetEntryInfo[]
  /**
   * 按 agent 组装一次系统提示词，返回逐 section 明细（name/text，按 order 排序）。
   * 来源：assemble({ scope })——精确的「哪个 section + 排序」来源，前端据此标注插件与顺序。
   * @param sessionId - agent 的会话 id。
   * @returns sections；未知会话/组装失败返回 null。
   */
  assembleSectionsForSession(sessionId: string): Promise<Array<{ name: string; text: string }> | null>
  /**
   * 把当前生效模块装配说明原位写入用户级预设装配清单（agent.cordis.yml 的
   * context-assembler 行 config.modules），并保留 sidecar 备案（不影响运行时）。
   * @param agentId - agent id。
   */
  syncToPreset(agentId: string): void
  /**
   * 原位修改 agent 预设装配清单的 skill-filesystem 行 config（customSkillDirs），
   * 新会话（换代）生效；不触碰运行时。
   * @param dirs - customSkillDirs。
   * @param agentId - agent id。
   */
  editSkillDirs(dirs: string[], agentId: string): void
  /**
   * 原位修改 agent 预设装配清单的 agent-instructions 行 config（maxBytes /
   * instructionFileCandidates / projectRootMarkers 等），新会话（换代）生效。
   * @param patch - agent-instructions config 键值。
   * @param agentId - agent id。
   */
  editBaselineConfig(patch: Record<string, unknown>, agentId: string): void
  /** 卸载：注销全部已注册模块与工具限制。 */
  dispose(): void
}