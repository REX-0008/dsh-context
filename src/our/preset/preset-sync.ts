/**
 * Preset snapshot sync (archive): write the currently effective module assembly
 * description into the user-level preset file.
 *
 * Follows plans/2026-08-19-上下文工程后端部分.md §4 (syncToPreset) and §1.6
 * (in-place modification):
 * - the runtime source of truth is settings (injected in the agent scope, not via
 *   the preset); writing the preset does not affect the runtime;
 * - target: `$DSH_HOME/.agent-presets/<agentId>/agent.cordis.yml` (the assembly
 *   manifest);
 * - write mode: in-place modification — read the original text → find the matching
 *   plugin row → change that row's config → write back at the same position (no
 *   patch-style appending, no whole-file rewrite), leaving the other rows /
 *   comments / structure byte-identical;
 * - write only on a difference (diff the file); writing the file produces no
 *   generation and triggers no skill watcher (proven in §3.2).
 *
 * Record: alongside the in-place write, the sidecar archive `context-modules.json`
 * (the earlier implementation) is kept as a redundant plain-JSON snapshot for
 * auditing/comparison, and it does not conflict with agent.cordis.yml.
 * @module @our/context-panel/preset-sync
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendPluginRow, renderPluginRow, updatePluginRowConfig } from './preset-edit'
import type { PromptModule } from '../types'

/** Data root (DSH_HOME is set by the dsh process; falls back to the user's home directory). */
const HOME_ROOT = process.env.DSH_HOME ?? homedir()

/**
 * This plugin's row identifiers in the assembly manifest (the row name follows the
 * plugin package name; the old @our/context-assembler is merged into this plugin).
 */
export const CONTEXT_PLUGIN_ID = 'context-panel'
export const CONTEXT_PLUGIN_NAME = '@our/context-panel'

/** skill-filesystem row identifiers. */
export const SKILL_FS_ID = 'skill-filesystem'
export const SKILL_FS_NAME = '@deepseek-ai/dsh-skill-filesystem'

/** agent-instructions row identifiers. */
export const AGENT_INSTRUCTIONS_ID = 'agent-instructions'
export const AGENT_INSTRUCTIONS_NAME = '@deepseek-ai/dsh-agent-instructions'

/** Read a file's content; null when it does not exist. */
function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The agent's preset file path (the assembly manifest). */
function presetFilePath(agentId: string): string {
  return join(HOME_ROOT, '.agent-presets', agentId, 'agent.cordis.yml')
}

/** The sidecar archive path (a plain-JSON snapshot). */
function snapshotFilePath(agentId: string): string {
  return join(HOME_ROOT, '.agent-presets', agentId, 'context-modules.json')
}

/** The merged module view → the assembly's modules map (name → patch, with text/channel/order/enabled). */
function modulesToConfig(modules: PromptModule[]): Record<string, { channel: 'section' | 'context'; order: number; enabled: boolean; text: string }> {
  const out: Record<string, { channel: 'section' | 'context'; order: number; enabled: boolean; text: string }> = {}
  for (const m of modules) {
    out[m.name] = { channel: m.channel, order: m.order, enabled: m.enabled, text: m.text }
  }
  return out
}

/**
 * Write the sidecar archive (context-modules.json, the earlier implementation's
 * plain-JSON record, kept for redundant auditing).
 * @param agentId - the agent id.
 * @param modules - the merged module list.
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
 * Write the module assembly description in place into the agent's preset assembly
 * manifest (this plugin's row config.modules).
 * Target row exists → modify it in place; does not exist → append the row at the
 * end of the file; file does not exist → create it.
 * @param agentId - the agent id.
 * @param modules - the merged module list.
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
 * Modify in place the config of a given plugin row in the agent's preset assembly
 * manifest (settings such as the skill directories / baseline configuration).
 * Target row exists → modify it in place; does not exist → append at the end of the
 * file; file does not exist → create it (with the header comment).
 * @param agentId - the agent id.
 * @param pluginId - the plugin id.
 * @param pluginName - the plugin package name.
 * @param configPatch - the key/values to write into config (only these keys are
 * set/updated).
 * @param headerComment - the header comment lines used when creating the file.
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
