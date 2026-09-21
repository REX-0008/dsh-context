/**
 * @our/context-panel 共享类型（单插件内部所有模块共用；client 半也经此对齐）。
 * @module @our/context-panel/types
 */

/** 模块注册通道：权威×动态判据决定前缀缓存命运（section 期望稳定，context 变则 supersede）。 */
export type PromptChannel = 'section' | 'context'

/** 模块覆盖的父来源（父=原插件注入的 section；子=我们的模块，同名自动 shadow 父）。 */
export interface ModuleSource {
  /** 父来源种类：preset（预设条目注入）/ global（profile 全局）/ none（纯新增，无父）。 */
  kind: 'preset' | 'global' | 'none'
  /** 预设条目 id（preset 时：如 'persona'）。 */
  entryId?: string
  /** 被覆盖的父 section 名（= 本模块的 name，同名才 shadow）。 */
  sectionName?: string
  /** 父原文（从预设条目 config 读到；preset 找不到时不填）。 */
  parentText?: string
}

/** 模块补丁（前端经 settings 通道只发 patch；settings 是模块定义单一数据源）。 */
export interface PromptModulePatch {
  /** 注入文本。 */
  text?: string
  /** 通道：稳定高权威 → section；动态低权威 → context。 */
  channel?: PromptChannel
  /** 组装顺序（section 与 context 各自独立排序）。 */
  order?: number
  /** 开关。 */
  enabled?: boolean
  /** 覆盖的父来源（dsh 不读，我们写我们读，供显示/对比/写回追溯）。 */
  source?: ModuleSource
}

/** 一个已解析的模块（合并 agent 级 + 会话级覆盖后的最终形态）。 */
export interface PromptModule {
  /** 注册名，如 'our:soul' / 'our:workspace'；覆盖父时 = 父 section 名。 */
  name: string
  /** 通道。 */
  channel: PromptChannel
  /** 组装顺序。 */
  order: number
  /** 是否注入。 */
  enabled: boolean
  /** 注入文本（静态文本，注册时从配置渲染一次）。 */
  text: string
  /** 覆盖的父来源（新增模块无）。 */
  source?: ModuleSource
}

/** context-panel settings namespace 的值（磁盘持久化；引擎/面板/预设共用）。 */
export interface ContextPanelSettings {
  /** 当前编辑作用域。 */
  scope: 'conversation' | 'agent'
  /** 同步至预设开关。 */
  autoSyncPreset: boolean
  /** 面板默认宽度（% of window，软件级 UI 偏好）。 */
  panelWidth: number
  /** agent 级模块配置（权威源）。 */
  modules: Record<string, PromptModulePatch>
  /** 会话级临时覆盖（每会话一份）。 */
  conversationOverrides: Record<string, Record<string, PromptModulePatch>>
  /** agent 级工具限制（按工具名 → filter）。 */
  toolRestrictions: Record<string, { allow?: string[]; deny?: string[] }>
  /**
   * Sections disabled for every conversation under the same PRESET (the
   * "preset off" state): keyed by preset id, then section name is membership.
   *
   * Three levels exist; this pair covers the two the panel owns:
   * - the deployment (profile) level is NOT managed here;
   * - preset level = this field, so every conversation on that preset is affected;
   * - conversation level = {@link conversationDisabledSections}.
   *
   * Disabling a section only stops its TEXT from being sent; it never unloads the
   * plugin that registered it.
   */
  presetDisabledSections?: Record<string, string[]>
  /**
   * Sections disabled for ONE conversation only: keyed by session id, then
   * section name is membership. Takes effect for this conversation alone, so a
   * section can be off here and on in every other conversation.
   */
  conversationDisabledSections?: Record<string, string[]>
  /**
   * Per-agent section text overrides, keyed by section name: the "plugin"
   * source kind is adjusted here instead of in its own file, so a third-party
   * plugin's prompt can be rewritten without touching that plugin.
   */
  sectionOverrides?: Record<string, Record<string, string>>
  /**
   * Per-agent section weights, keyed by section name. Editing a number
   * re-orders the prompt; sections without a weight keep their position.
   */
  sectionWeights?: Record<string, Record<string, number>>
  /**
   * What an overridden section's original text looked like when it was edited,
   * one backup per section. When the plugin later changes that original, the
   * two differ and the panel offers a comparison.
   */
  sectionOriginals?: Record<string, Record<string, string>>
}

/** 空配置（settings 未就绪时的兜底）。 */
export const EMPTY_CONFIG: ContextPanelSettings = {
  scope: 'agent',
  autoSyncPreset: false,
  panelWidth: 720,
  modules: {},
  conversationOverrides: {},
  toolRestrictions: {},
  presetDisabledSections: {},
  conversationDisabledSections: {},
  sectionOverrides: {},
  sectionWeights: {},
  sectionOriginals: {},
}
