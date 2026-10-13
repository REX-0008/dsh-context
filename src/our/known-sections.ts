/**
 * Static owner index: prompt-section NAME to the package that registers it.
 *
 * WHY THIS IS STILL NEEDED, AND WHY IT IS THIS SMALL
 *
 * The panel answers two questions per row: its placement order and who registered
 * it. Placement is read LIVE from the running registry (`registrySections`), which
 * holds each registration's own argument — boot-time registrations included — so
 * no order is copied here any more: a snapshot would only ever be an out-of-date
 * duplicate of a value that is already available.
 *
 * The OWNER has no such live source. `assemble()` strips it, and this plugin's
 * interception only sees registrations that happen after it mounts, while the
 * harness registers its own sections during boot. So the owner of those sections
 * cannot be asked for; it is recorded here.
 *
 * The table holds ONLY what nothing else can answer:
 *   - sections NOT named `tool:<tool>` (that family resolves live, through the
 *     host's own tool→plugin attribution, which also covers third-party providers
 *     this file could never list);
 *   - sections this plugin cannot observe registering (i.e. not its own).
 * Everything else is dead weight: it would restate a live answer, and a restated
 * answer is one that can be wrong.
 *
 * Names verified against the runtime in use (dsh 0.2.0-rc.2): every entry below
 * was found as a live `systemPrompt.section({ name })` call with this exact owner.
 * @module @our/context-panel-write/our/known-sections
 */

/** One known section's owning package. */
export interface KnownSection {
  /** The package that registers the section. */
  plugin: string
}

/** Where the owner names were verified, shown in the panel for audits. */
export const KNOWN_SECTIONS_SOURCE = 'dsh 0.2.0-rc.2'

/**
 * Sections whose owner nothing else can answer for.
 *
 * A harness section registered at boot: no observation saw it, and the assembled
 * value drops the owner. Package names change far more rarely than placements, so
 * this list needs verifying only when a harness section is renamed or moved.
 */
export const KNOWN_SECTIONS: Record<string, KnownSection> = {
  'harness:identity': { plugin: '@deepseek-ai/dsh-system-prompt' },
  // The persona sections are registered TWICE by design: dsh-system-prompt puts the
  // deployment default in the global layer, and dsh-persona registers the same names
  // in an agent's scope to SHADOW it (dsh-subagent does the same for subagents). The
  // feature owner is what the panel should name, so it is the scoped registrant.
  'deployment:persona-prefix': { plugin: '@deepseek-ai/dsh-persona' },
  'deployment:persona-suffix': { plugin: '@deepseek-ai/dsh-persona' },
  'plan:policy': { plugin: '@deepseek-ai/dsh-plan-mode' },
  'team:policy': { plugin: '@deepseek-ai/dsh-experimental-tool-agent-team' },
  'tools:ptc-only': { plugin: '@deepseek-ai/dsh-tools' },
  'tools:sdk': { plugin: '@deepseek-ai/dsh-tools' },
  'context:file-reference': { plugin: '@deepseek-ai/dsh-file-reference-local' },
  'ui:deliverable-file-references': { plugin: '@deepseek-ai/dsh-client-ui-deliverables' },
  'app:web-surface': { plugin: '@deepseek-ai/dsh-web-app' },
}

/**
 * Look one section's owner up.
 * @param name - the section name as the assembly reports it.
 * @returns its known owner, or undefined when nothing here knows it.
 */
export function knownSectionOf(name: string): KnownSection | undefined {
  return KNOWN_SECTIONS[name]
}
