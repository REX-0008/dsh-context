/**
 * The injection sources the panel offers for suppression, known WITHOUT having
 * observed them.
 *
 * Why a static list exists at all: an injection is identified at runtime by the
 * message's own `source` — either the shared `{ kind: 'plugin', plugin }` form
 * or a plugin-registered kind such as `agent-instructions`. Those only appear in
 * a step batch AFTER a turn has run, and the baseline and the skill catalog are
 * present in essentially every conversation, so waiting to observe them would
 * leave the most predictable sources missing from the list exactly when the user
 * first opens the panel.
 *
 * The list is a set of LABELS to offer; suppression matches the same labels at
 * the pre-step boundary, and anything observed that is not listed here is added
 * at runtime. A label that never appears simply has no effect.
 * @module @our/context-panel-write/our/known-injectors
 */

/** One injection source the panel can offer for suppression. */
export interface KnownInjector {
  /** The label matched against a message's `source` (see `injectorLabel`). */
  label: string
  /** What produces it, for the row's tooltip. */
  note: string
}

/**
 * Sources shipped by the harness's own deployment. Each entry names the
 * `source.kind` or the `source.plugin` value its producer stamps, verified
 * against the packages that write them.
 */
export const KNOWN_INJECTORS: KnownInjector[] = [
  { label: 'agent-instructions', note: 'AGENTS.md / CLAUDE.md instruction baseline' },
  { label: 'skill-catalog', note: 'the <available_skills> catalog' },
  { label: 'skill-invocation', note: 'a skill body injected by an explicit /skill invocation' },
  { label: 'session-reference', note: 'references to other sessions' },
  { label: 'time-context', note: 'the current time and time zone snapshot' },
  { label: 'tmux-context', note: 'the tmux pane snapshot' },
  { label: 'team-message', note: 'a message from an agent team member' },
  { label: 'goal', note: 'goal-round driver prompts' },
  { label: 'webhook', note: 'input admitted from a webhook rule' },
]

/**
 * The label for one message's source, in the same form the panel lists and the
 * suppression matches.
 *
 * A plugin-stamped source is labelled by its plugin name — that is what
 * distinguishes one `{ kind: 'plugin' }` injector from another, since they share
 * the kind. A plugin-registered kind is labelled by that kind.
 * @param source - the message's `source` value, of unknown shape.
 * @returns the label, or undefined when the message is not an injection.
 */
export function injectorLabel(source: unknown): string | undefined {
  if (source === null || typeof source !== 'object') return undefined
  const record = source as { kind?: unknown; plugin?: unknown }
  if (record.kind === 'user' || record.kind === 'model' || record.kind === 'tool') return undefined
  if (typeof record.plugin === 'string' && record.plugin !== '') return record.plugin
  return typeof record.kind === 'string' ? record.kind : undefined
}
