/**
 * Fallback table: prompt-section NAME to its placement order and owning
 * package, for sections this plugin cannot observe being registered.
 *
 * Why a fallback is needed at all: the assemble interface hands over
 * `{ name, text }` only — the placement order and the registering plugin are
 * stripped before a section reaches a listener, and this plugin's interception
 * (section-registry.ts) can only see registrations that happen AFTER it mounts.
 * The harness's own sections are registered during boot, so they must be looked
 * up here.
 *
 * The fallback is used ONLY when interception missed a section, and the panel
 * flags a mismatch when the observed order disagrees with the table (the table
 * is a snapshot and a dsh upgrade can move a section).
 *
 * GENERATED from deepseek-harness commit/tag in use: `0.1.5-rc.1`
 * (`packages/core/system-prompt/src/index.ts` SECTION_ORDERS plus each
 * registering package's literal). Regenerate rather than hand-edit.
 * @module @our/context-panel-write/our/known-sections
 */

/** One known section's placement and owner. */
export interface KnownSection {
  /** Placement order the harness sorts by. */
  order: number
  /** The package that registers the section. */
  plugin: string
}

/** Where the table was generated from (shown in the panel for audits). */
export const KNOWN_SECTIONS_SOURCE = 'dsh 0.1.5-rc.1'

/** Known sections by name. */
export const KNOWN_SECTIONS: Record<string, KnownSection> = {
  'harness:identity': { order: -1000, plugin: '@deepseek-ai/dsh-system-prompt' },
  'deployment:persona-prefix': { order: 0, plugin: '@deepseek-ai/dsh-persona' },
  'plan:policy': { order: 500, plugin: '@deepseek-ai/dsh-plan-mode' },
  'team:policy': { order: 600, plugin: '@deepseek-ai/dsh-tool-agent-team' },
  'tools:ptc-only': { order: 800, plugin: '@deepseek-ai/dsh-tools' },
  'context:file-reference': { order: 900, plugin: '@deepseek-ai/dsh-file-reference-local' },
  'tool:bash': { order: 1000, plugin: '@deepseek-ai/dsh-tool-bash' },
  'tool:pwsh': { order: 1010, plugin: '@deepseek-ai/dsh-tool-pwsh' },
  'tool:read': { order: 1100, plugin: '@deepseek-ai/dsh-tool-fs' },
  'tool:write': { order: 1200, plugin: '@deepseek-ai/dsh-tool-fs' },
  'tool:edit': { order: 1300, plugin: '@deepseek-ai/dsh-tool-fs' },
  'tool:glob': { order: 1400, plugin: '@deepseek-ai/dsh-tool-fs-search' },
  'tool:grep': { order: 1500, plugin: '@deepseek-ai/dsh-tool-fs-search' },
  'tool:jobs': { order: 1600, plugin: '@deepseek-ai/dsh-tool-jobs' },
  'tool:pty': { order: 1700, plugin: '@deepseek-ai/dsh-tool-terminal' },
  'tool:web_search': { order: 2000, plugin: '@deepseek-ai/dsh-tool-web' },
  'tool:web_fetch': { order: 2100, plugin: '@deepseek-ai/dsh-tool-web' },
  'tool:lsp': { order: 2200, plugin: '@deepseek-ai/dsh-tool-lsp' },
  'tool:session-query': { order: 2300, plugin: '@deepseek-ai/dsh-tool-session-query' },
  'tool:goal': { order: 2400, plugin: '@deepseek-ai/dsh-tool-goal' },
  'tool:cordis': { order: 2500, plugin: '@deepseek-ai/dsh-tool-cordis' },
  'tool:ralph': { order: 2700, plugin: '@deepseek-ai/dsh-tool-ralph' },
  'tools:sdk': { order: 5000, plugin: '@deepseek-ai/dsh-tools' },
  'ui:deliverable-file-references': { order: 9000, plugin: '@deepseek-ai/dsh-client-ui-deliverables' },
  'app:web-surface': { order: 10100, plugin: '@deepseek-ai/dsh-web-app' },
}

/**
 * Look one section up.
 * @param name - the section name as the assembly reports it.
 * @returns its known placement and owner, or undefined when the table has none.
 */
export function knownSectionOf(name: string): KnownSection | undefined {
  return KNOWN_SECTIONS[name]
}
