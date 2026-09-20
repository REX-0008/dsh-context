/**
 * Read the current agent's preset composition entries (id / name / config).
 *
 * Used for system-prompt source attribution: whether a section is injected by
 * the preset (and therefore overridable) and, when it is, the parent text the
 * preset carries (e.g. persona's `config.text`).
 *
 * The preset id is read from the harness's `agentPreset` session projection
 * (`@deepseek-ai/dsh-agent-presets` registers it, init = `header.agentPreset`);
 * the projection is the documented reconstruction source, and reading it avoids
 * importing the presets package — which would drag the harness's real
 * `agent/pre-step` declaration in and break upstream's narrow shim (see
 * `agent-face.ts`).
 *
 * @module @our/context-panel-write/our/assembler/preset-entries
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import type { AgentFace as Agent } from '../agent-face'

/** One preset entry (an `- id: …` row in agent.cordis.yml). */
export interface PresetEntryInfo {
  /** Entry id (the `- id:` in the preset file). */
  id: string
  /** Package name. */
  name: string
  /** Entry config (the injected text may live in `config.text`). */
  config?: unknown
}

/**
 * Preset plugins known to register a system-prompt section (entry id to section
 * name). Everything else in a preset (skill-filesystem / tool-skill /
 * agent-instructions / persistent-shell …) contributes through the skill
 * registry, pre-step hooks or user context instead, so it is not listed.
 */
export const KNOWN_PRESET_SECTIONS: Record<string, readonly string[]> = {
  persona: ['deployment:persona'],
}

/** The agent's preset id, read from the registered `agentPreset` projection. */
function presetIdOf(agent: Agent, readProjection: (agent: Agent, key: string) => unknown): string | undefined {
  try {
    const value = readProjection(agent, 'agentPreset')
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** The current agent's preset entries; empty when no preset or file is available. */
export function presetEntriesOf(agent: Agent, readProjection: (agent: Agent, key: string) => unknown): PresetEntryInfo[] {
  const presetId = presetIdOf(agent, readProjection)
  if (presetId === undefined) return []
  const file = findPresetFile(presetId)
  if (file === null) return []
  try {
    const doc = yamlLoad(readFileSync(file, 'utf8'))
    if (!Array.isArray(doc)) return []
    return (doc as Array<Record<string, unknown>>)
      .filter((entry) => entry !== null && typeof entry === 'object'
        && typeof entry.id === 'string' && typeof entry.name === 'string')
      .map((entry) => ({
        id: entry.id as string,
        name: entry.name as string,
        ...(entry.config === undefined ? {} : { config: entry.config }),
      }))
  } catch {
    return []
  }
}

/** Locate the preset file: the user root (`.agent-presets/<id>/`) first, then the config root. */
function findPresetFile(presetId: string): string | null {
  const candidates = [
    join(process.env.DSH_HOME ?? homedir(), '.agent-presets', presetId, 'agent.cordis.yml'),
    join(process.cwd(), 'apps', 'cli', 'config', 'agent-presets', presetId, 'agent.cordis.yml'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
