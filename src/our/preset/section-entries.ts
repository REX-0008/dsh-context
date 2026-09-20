/**
 * Which preset entry owns a given system-prompt section.
 *
 * A preset composes an agent from entries (`- id: <entry>` rows in
 * `agent.cordis.yml`); each entry's plugin may register prompt sections. To
 * write an edited section back to the preset, the section must be mapped to the
 * entry that produced it. Only entries known to register a section are listed —
 * the rest of a preset (skill dirs, tool rows, instructions) contributes through
 * other channels and has no section to write back.
 * @module @our/context-panel-write/our/preset/section-entries
 */

/** One preset entry that owns prompt sections. */
export interface PresetSectionOwner {
  /** The entry id as it appears in the preset file. */
  id: string
  /** The package the entry loads. */
  name: string
}

/** Section names to their owning preset entry. */
const SECTION_OWNERS: Record<string, PresetSectionOwner> = {
  'deployment:persona': { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  'deployment:persona-prefix': { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  'deployment:persona-suffix': { id: 'persona', name: '@deepseek-ai/dsh-persona' },
}

/**
 * Resolve a section's owning preset entry.
 * @param sectionName - the section name as the assembly reports it.
 * @returns the owning entry, or undefined when no entry is known to own it.
 */
export function presetEntryForSection(sectionName: string): PresetSectionOwner | undefined {
  return SECTION_OWNERS[sectionName]
}
