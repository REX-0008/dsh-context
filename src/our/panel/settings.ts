/**
 * context-panel settings namespace：schema + 默认值 + 注册。
 *
 * 与方案文档的差异：直接用 settings.register（而非 installSettingsSection）——
 * installSettingsSection 只暴露读（setSource/onChange），本插件需要 scope.update()
 * 写路径（updateModule/syncConversationToAgent），register 返回的
 * scope 同时提供 get/watch/update。
 * @module @our/context-panel/settings
 */
import z from '@deepseek-ai/schemastery'
import type { ContextPanelSettings, PromptModulePatch } from '../types'
import { SEED_MODULES } from '../preset/seeds'

/** Our own namespace, distinct from upstream dsh-context's. */
export const CONTEXT_PANEL_NS = 'context-panel-write'

/** 模块补丁 schema（全部字段可选；source 为宽松对象保留扩展）。 */
const PatchSchema = z.object({
  text: z.string(),
  channel: z.union([z.const('section'), z.const('context')]),
  order: z.number(),
  enabled: z.boolean(),
  source: z.any(),
})

/**
 * 默认配置（模块定义单一数据源来自 preset/seeds.ts；前端可在面板编辑）。
 * 区间：section 避开 harness(-100)/persona(0)/工具指引(100-199)；context 独立区间。
 */
export const DEFAULT_SETTINGS: ContextPanelSettings = {
  scope: 'agent',
  autoSyncPreset: false,
  panelWidth: 720,
  modules: { ...SEED_MODULES },
  conversationOverrides: {},
  toolRestrictions: {},
  disabledSections: [],
}

/** namespace schema（schemastery 原语：z.dict 替代 zod 的 z.record；字段默认可选）。 */
export const CONTEXT_PANEL_SCHEMA: z<ContextPanelSettings> = z.object({
  scope: z.union([z.const('conversation'), z.const('agent')]),
  autoSyncPreset: z.boolean(),
  panelWidth: z.number(),
  modules: z.dict(PatchSchema),
  conversationOverrides: z.dict(z.dict(PatchSchema)),
  toolRestrictions: z.dict(z.object({ allow: z.array(z.string()), deny: z.array(z.string()) })),
  disabledSections: z.array(z.string()),
})

/** 合并两段补丁（后者覆盖前者，undefined 字段忽略）。 */
export function mergePatch(...patches: Array<PromptModulePatch | undefined>): PromptModulePatch {
  const out: PromptModulePatch = {}
  for (const p of patches) {
    if (p === undefined) continue
    if (p.text !== undefined) out.text = p.text
    if (p.channel !== undefined) out.channel = p.channel
    if (p.order !== undefined) out.order = p.order
    if (p.enabled !== undefined) out.enabled = p.enabled
    if (p.source !== undefined) out.source = p.source
  }
  return out
}

