/**
 * dsh-context entry configuration — the `config:` block of the `dsh-context`
 * loader row in cordis.yml, plus the per-user display preferences.
 *
 * The schema is schemastery so both consumers it must serve accept it: cordis
 * validates the entry config through the schema's Standard Schema face before
 * `apply` runs (defaults per field, unknown keys merged through), and the
 * harness's Config-form generation (dsh 0.1.7+) derives the Plugins page's
 * live form from this same schema — there the namespace is the entry id
 * (`dsh-context`) and only the `.volatile()` preference fields are served and
 * editable. Bounds edits remount the entry (the folds read them at apply);
 * preference edits commit volatile-only and never remount. On the older lines
 * the preferences are inert here — their surface is the registered settings
 * namespace (settings.ts). The `Config` type describes the RESOLVED shape
 * cordis hands to `apply`; the raw patch values are partial and the schema
 * fills every default.
 */

import z from '@deepseek-ai/schemastery'
import type { DefaultFileSort, DefaultGranularity, DefaultPlacement, DefaultTrendMode, DefaultToolSort, InsightsEntry } from '../shared/types'
// OUR INSERT POINT (PATCHES.md #9): the context-management write layer's
// settings tree rides the entry config on harness 0.2+ (see src/our/panel/scope.ts).
import { CONTEXT_PANEL_ENTRY_SCHEMA, PRICE_MAP_SCHEMA } from '../our/panel/settings'
// The runtime value is the Volatile live reference; folds never read it, the
// typed face only satisfies the schema's inferred param (see the field doc).
import type { ContextPanelSettings } from '../our/types'

export interface Config {
  /** Cap on kept per-step request records (the hard step backstop). */
  maxRequestSteps?: number
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns?: number
  maxEvents?: number
  /**
    * Served surface nodes (newest carry the signal; live inject nodes are pinned — they land first and are few). Deliberately generous:
    * auto-compaction keeps healthy surfaces far below it, so the browser effectively lists every live node; the bound is a
    * pathological-session backstop (each push ships the whole value, ~150B/node).
   */
  maxNodes?: number
  /** Removed (shadowed) surface nodes kept for per-step reconstruction. */
  maxArchiveNodes?: number
  /** Fold-derived file-operation records kept (the File Activity card's raw material). */
  maxFileOps?: number
  /** Where the Context view is offered (the conversation tab, the right Sidebar, or both). */
  defaultPlacement?: DefaultPlacement
  /** Timeline default granularity (per step or per turn). */
  defaultGranularity?: DefaultGranularity
  /** Timeline default trend mode (total or delta). */
  defaultTrendMode?: DefaultTrendMode
  /** Tool-definition row default order. */
  defaultToolSort?: DefaultToolSort
  /** File Activity row default order. */
  defaultFileSort?: DefaultFileSort
  /** Whether the Context Insights panel's sidebar entry is offered. */
  insightsEntry?: InsightsEntry
  /**
   * The context-management write layer's settings tree (OUR INSERT — see
   * PATCHES.md #9). The settings surface on harness 0.2+ (volatile → live-
   * editable without remounting; cordis resolves it to a live reference the
   * folds never read) and inert on the older lines, where the write layer
   * registers its own settings namespace instead.
   */
  panel?: ContextPanelSettings
}

/** The fold's retention/slice bounds, as the schema resolves them. */
export interface FoldBounds {
  maxRequestSteps: number
  maxKeptTurns: number
  maxEvents: number
  maxNodes: number
  maxArchiveNodes: number
  maxFileOps: number
}

export const DEFAULT_BOUNDS: FoldBounds = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
}

/**
 * Mark a field live-editable where the harness's schemastery ships the
 * `.volatile()` modifier (the Config-form generation reads the mark to serve
 * the field on the Plugins page); a plain field on the older lines whose
 * schemastery predates the modifier.
 */
export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

/** One bounded positive-integer count. */
function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

/**
 * The fold's retention/slice bounds as their OWN schema.
 *
 * `resolveBounds` resolves through this instead of the full entry `Config`:
 * cordis has already resolved the raw entry config before `apply` runs, so the
 * value it passes back carries each volatile field as its live reference. A
 * second pass through the full schema would re-enter those fields' resolvers —
 * and a resolve that yields an object (this plugin's `panel` tree) is refused
 * by `createVolatile` ("volatile config cannot contain functions"), failing the
 * whole entry. Resolving only the scalar bounds keeps both callers correct: the
 * raw partial patch a test hands in, and the already-resolved config cordis
 * passes to `apply`.
 */
const BoundsSchema = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
})

/** The cordis `Config` validator and the Config-form generation's served schema. */
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
  // OUR INSERT (PATCHES.md #9): the context-management settings tree — the
  // settings surface on 0.2+; a separate root so the volatile mark never
  // leaks into the registration schema (src/our/panel/settings.ts).
  panel: volatileField(CONTEXT_PANEL_ENTRY_SCHEMA),
  // OUR INSERT: the model-price mapping's manual rows, a TOP-LEVEL preference.
  // It must sit here rather than inside `panel`: the settings card addresses
  // top-level field names, exactly as it does for the display preferences above,
  // and the Config-form generation serves only the volatile top-level fields —
  // inside the tree the write would be dropped and the mapping lost on reboot.
  priceMap: volatileField(PRICE_MAP_SCHEMA.default({})),
})

/**
 * Resolve the fold's retention bounds (the schema fills every default).
 *
 * Accepts either the raw partial patch or the config cordis already resolved
 * (see `BoundsSchema`): only the scalar bounds are read, so the volatile
 * preference subtrees are never re-resolved.
 */
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
