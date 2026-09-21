/**
 * Which preset entry owns a given system-prompt section, and under which config
 * key its text lives.
 *
 * A preset composes an agent from entries (`- id: <entry>` rows in
 * `agent.cordis.yml`); an entry's plugin may register prompt sections. Writing
 * an edited section back to the preset means writing THAT ENTRY'S config — so
 * the section must map to both the entry and the exact key the plugin reads.
 *
 * The key is the plugin's own, not ours: `@deepseek-ai/dsh-persona` reads
 * `prefix`/`suffix` (it registers `deployment:persona-prefix` from
 * `config.prefix`), so a write must name those. Writing a key the plugin does
 * not read would silently do nothing.
 *
 * Only entries known to register a section are listed; the rest of a preset
 * (tool rows, skill dirs, instructions) contributes through other channels.
 * @module @our/context-panel-write/our/preset/section-entries
 */

/** One preset entry that owns a prompt section. */
export interface PresetSectionOwner {
  /** The entry id as it appears in the preset file. */
  id: string
  /** The package the entry loads. */
  name: string
  /** The config key on that entry holding this section's text. */
  textKey: string
}

/** Section names to their owning preset entry and config key. */
const SECTION_OWNERS: Record<string, PresetSectionOwner> = {
  'deployment:persona-prefix': { id: 'persona', name: '@deepseek-ai/dsh-persona', textKey: 'prefix' },
  'deployment:persona-suffix': { id: 'persona', name: '@deepseek-ai/dsh-persona', textKey: 'suffix' },
}

/**
 * Resolve a section's owning preset entry.
 * @param sectionName - the section name as the assembly reports it.
 * @returns the owning entry, or undefined when no entry is known to own it.
 */
export function presetEntryForSection(sectionName: string): PresetSectionOwner | undefined {
  return SECTION_OWNERS[sectionName]
}
