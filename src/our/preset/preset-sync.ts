/**
 * Editing a preset from here: the plugin's ONE deliberate write into a preset file.
 *
 * The built-in modules no longer mirror into the preset's manifest row, nor into the
 * `context-modules.json` sidecar beside it — the definitions have a file of their own,
 * and a third copy nothing read was only a way to disagree with it.
 *
 * What remains is the other direction: a section the PRESET owns is written BACK into
 * the preset, because that text lives in a file this user owns rather than inside a
 * plugin's package. The edit is line-level, so the rest of the composition survives,
 * and it takes effect for the next session (a preset composes sessions, not turns).
 * @module @our/context-panel/preset-sync
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendPluginRow, renderPluginRow, updatePluginRowConfig } from './preset-edit'

/** Data root (DSH_HOME is set by the dsh process; falls back to the user's home directory). */
const HOME_ROOT = process.env.DSH_HOME ?? homedir()


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
