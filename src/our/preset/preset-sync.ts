/**
 * 预设快照同步（档案）：把当前生效的模块装配说明写进用户级预设文件。
 *
 * 对齐 plans/2026-08-19-上下文工程后端部分.md §4（syncToPreset）与 §1.6（原位修改）：
 * - 运行时权威源 = settings（agent scope 注入，不经预设）；写预设不影响运行时；
 * - 目标：`$DSH_HOME/.agent-presets/<agentId>/agent.cordis.yml`（装配清单）；
 * - 写入方式：原位修改 —— 读取原文 → 找到对应插件行 → 改该行 config → 写回原位置
 *   （不补丁式追加、不整体重写），其余行/注释/结构字节原样保留；
 * - 差异才写（diff 写文件）；写文件不产代、不触发 skill watcher（§3.2 已实证）。
 *
 * 备案：除原位写入外，同时保留 sidecar 档案 `context-modules.json`（早期实现），
 * 作为纯 JSON 快照冗余，供审计/对比，与 agent.cordis.yml 无冲突。
 * @module @our/context-panel/preset-sync
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendPluginRow, renderPluginRow, updatePluginRowConfig } from './preset-edit'
import type { PromptModule } from '../types'

/** 数据根（DSH_HOME 由 dsh 进程设置；兜底用户主目录）。 */
const HOME_ROOT = process.env.DSH_HOME ?? homedir()

/** 本插件在装配清单里的行标识（行名随插件包名；旧 @our/context-assembler 已并入本插件）。 */
export const CONTEXT_PLUGIN_ID = 'context-panel'
export const CONTEXT_PLUGIN_NAME = '@our/context-panel'

/** skill-filesystem 行标识。 */
export const SKILL_FS_ID = 'skill-filesystem'
export const SKILL_FS_NAME = '@deepseek-ai/dsh-skill-filesystem'

/** agent-instructions 行标识。 */
export const AGENT_INSTRUCTIONS_ID = 'agent-instructions'
export const AGENT_INSTRUCTIONS_NAME = '@deepseek-ai/dsh-agent-instructions'

/** 读取文件内容，不存在返回 null。 */
function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** agent 预设文件路径（装配清单）。 */
function presetFilePath(agentId: string): string {
  return join(HOME_ROOT, '.agent-presets', agentId, 'agent.cordis.yml')
}

/** 备案 sidecar 路径（纯 JSON 快照）。 */
function snapshotFilePath(agentId: string): string {
  return join(HOME_ROOT, '.agent-presets', agentId, 'context-modules.json')
}

/** 模块合并视图 → 装配用 modules 映射（name → patch，含 text/channel/order/enabled）。 */
function modulesToConfig(modules: PromptModule[]): Record<string, { channel: 'section' | 'context'; order: number; enabled: boolean; text: string }> {
  const out: Record<string, { channel: 'section' | 'context'; order: number; enabled: boolean; text: string }> = {}
  for (const m of modules) {
    out[m.name] = { channel: m.channel, order: m.order, enabled: m.enabled, text: m.text }
  }
  return out
}

/**
 * 写 sidecar 备案（context-modules.json，早期实现的纯 JSON 档案，保留作冗余审计）。
 * @param agentId - agent id。
 * @param modules - 合并后的模块列表。
 */
export function writePresetSnapshot(agentId: string, modules: PromptModule[]): void {
  const target = snapshotFilePath(agentId)
  const content = JSON.stringify(
    { version: 1, agentId, updatedAt: new Date().toISOString(), modules },
    null,
    2,
  ) + '\n'
  mkdirSync(join(target, '..'), { recursive: true })
  if (readFileSafe(target) !== content) writeFileSync(target, content, 'utf8')
}

/**
 * 把模块装配说明原位写入 agent 预设装配清单（本插件行 config.modules）。
 * 目标行存在 → 原位改该行；不存在 → 文件末尾追加该行；文件不存在 → 新建。
 * @param agentId - agent id。
 * @param modules - 合并后的模块列表。
 */
export function syncToPresetFile(agentId: string, modules: PromptModule[]): void {
  const config = { modules: modulesToConfig(modules) }
  const target = presetFilePath(agentId)
  mkdirSync(join(target, '..'), { recursive: true })
  const existing = readFileSafe(target)
  let next: string
  if (existing === null) {
    next = renderPluginRow(CONTEXT_PLUGIN_ID, CONTEXT_PLUGIN_NAME, config, [
      'context-panel 装配档案（由 @our/context-panel 同步写入；仅档案快照，运行时经 settings 注入）',
    ])
  } else {
    const patched = updatePluginRowConfig(existing, CONTEXT_PLUGIN_ID, CONTEXT_PLUGIN_NAME, config)
    next = patched ?? appendPluginRow(existing, CONTEXT_PLUGIN_ID, CONTEXT_PLUGIN_NAME, config)
  }
  if (existing !== next) writeFileSync(target, next, 'utf8')
}

/**
 * 原位修改 agent 预设装配清单里指定插件行的 config（设置项，如 skill 目录 / 基线配置）。
 * 目标行存在 → 原位改该行；不存在 → 文件末尾追加；文件不存在 → 新建（含头部注释）。
 * @param agentId - agent id。
 * @param pluginId - 插件 id。
 * @param pluginName - 插件包名。
 * @param configPatch - 要写入 config 的键值（仅这些键被 set/更新）。
 * @param headerComment - 新建文件时的头部注释行。
 */
export function updatePresetPluginConfig(
  agentId: string,
  pluginId: string,
  pluginName: string,
  configPatch: Record<string, unknown>,
  headerComment?: string[],
): void {
  const target = presetFilePath(agentId)
  mkdirSync(join(target, '..'), { recursive: true })
  const existing = readFileSafe(target)
  let next: string
  if (existing === null) {
    next = renderPluginRow(pluginId, pluginName, configPatch, headerComment)
  } else {
    const patched = updatePluginRowConfig(existing, pluginId, pluginName, configPatch)
    next = patched ?? appendPluginRow(existing, pluginId, pluginName, configPatch)
  }
  if (existing !== next) writeFileSync(target, next, 'utf8')
}