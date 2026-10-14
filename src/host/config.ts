/**
 * dsh-context entry configuration: the `config:` block of the `dsh-context` loader row, plus
 * the per-user display preferences.
 *
 * The schema is schemastery so both consumers accept it: cordis validates the entry config
 * through its Standard Schema face before `apply`, and the harness's Config-form generation
 * derives the Plugins page's live form from the same schema, where the namespace is the entry
 * id and only the `.volatile()` fields are served and editable. Bound edits remount the entry
 * (the folds read them at apply); preference edits commit volatile-only and never remount.
 */

import z from '@deepseek-ai/schemastery'
import type { PluginSettings } from '../shared/types'
// OUR INSERT POINT (PATCHES.md #9): the context-management write layer's settings
// tree rides the entry config on harness 0.2+ (see src/our/panel/scope.ts).
import { CONTEXT_PANEL_ENTRY_SCHEMA, PRICE_MAP_SCHEMA } from '../our/panel/settings'
// The runtime value is the Volatile live reference; folds never read it, the typed
// face only satisfies the schema's inferred param (see the field doc).
import type { ContextPanelSettings } from '../our/types'

export const DEFAULT_BOUNDS = {
  maxRequestSteps: 1500,
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns: 300,
  maxEvents: 400,
  /** Pathological-session backstop only: each push ships the whole value (~150B/node). */
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
}

/** The resolved fold bounds; derived from {@link DEFAULT_BOUNDS} so the two cannot drift. */
export type FoldBounds = typeof DEFAULT_BOUNDS

/** The entry's own config fields, ours included (see {@link ContextPanelSettings}). */
export type Config = Partial<FoldBounds> & Partial<PluginSettings> & {
  /**
   * The context-management write layer's settings tree (OUR INSERT — see
   * PATCHES.md #9). The settings surface on harness 0.2+ (volatile → live-editable
   * without remounting; cordis resolves it to a live reference the folds never
   * read) and inert on the older lines, where the write layer registers its own
   * settings namespace instead.
   */
  panel?: ContextPanelSettings
  /** The model price mapping's manual rows, a top-level preference (OUR INSERT). */
  priceMap?: Record<string, { vendor: string; model: string }>
}

/** Mark a field live-editable where the harness's schemastery ships `.volatile()`; a plain
 * field where the modifier is absent, so one schema serves every harness the gate admits. */
export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

/**
 * The fold's retention/slice bounds as their OWN schema.
 *
 * `resolveBounds` resolves through this instead of the full entry `Config`: cordis
 * has already resolved the raw entry config before `apply` runs, so the value it
 * passes back carries each volatile field as its live reference. A second pass
 * through the full schema would re-enter those fields' resolvers — and a resolve
 * that yields an object (our `panel` tree) is refused by `createVolatile`
 * ("volatile config cannot contain functions"), failing the whole entry. Resolving
 * only the scalar bounds keeps both callers correct: the raw partial patch a test
 * hands in, and the already-resolved config cordis passes to `apply`.
 */
const BoundsSchema = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
})

export const Config = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
  // Loose: a stale persisted value degrades to the default instead of failing the entry.
  defaultPlacement: volatileField(z.union(['all', 'tab', 'sidebar']).default('all').loose()),
  defaultGranularity: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultTrendMode: volatileField(z.union(['total', 'delta']).default('total').loose()),
  defaultDeltaBase: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultToolSort: volatileField(z.union(['size', 'count', 'name']).default('count').loose()),
  defaultFileSort: volatileField(z.union(['count', 'latest', 'path']).default('count').loose()),
  insightsEntry: volatileField(z.union(['show', 'hide']).default('show').loose()),
  defaultDurationCurve: volatileField(z.union(['show', 'hide']).default('show').loose()),
  fleetTab: volatileField(z.union(['show', 'hide']).default('show').loose()),
  // Loose: a stale persisted value (or a non-string) degrades to the empty default instead of failing the entry.
  promptPrefix: volatileField(z.string().default('').loose()),
  promptSuffix: volatileField(z.string().default('').loose()),
  // OUR INSERT (PATCHES.md #9): the context-management settings tree — the
  // settings surface on 0.2+; a separate root so the volatile mark never leaks
  // into the registration schema (src/our/panel/settings.ts).
  panel: volatileField(CONTEXT_PANEL_ENTRY_SCHEMA),
  // OUR INSERT: the model-price mapping's manual rows, a TOP-LEVEL preference. It
  // must sit here rather than inside `panel`: the settings card addresses
  // top-level field names, exactly as it does for the display preferences above,
  // and the Config-form generation serves only the volatile top-level fields —
  // inside the tree the write would be dropped and the mapping lost on reboot.
  priceMap: volatileField(PRICE_MAP_SCHEMA.default({})),
})

export function resolveBounds(config: Config | undefined): FoldBounds {
  // Extra keys (the volatile preference references) merge through unread; the
  // returned object carries only fold data.
  const resolved = BoundsSchema(config ?? {}) as FoldBounds & Record<string, unknown>
  return {
    maxRequestSteps: resolved.maxRequestSteps,
    maxKeptTurns: resolved.maxKeptTurns,
    maxEvents: resolved.maxEvents,
    maxNodes: resolved.maxNodes,
    maxArchiveNodes: resolved.maxArchiveNodes,
    maxFileOps: resolved.maxFileOps,
  }
}
