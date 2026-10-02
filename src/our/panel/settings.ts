/**
 * The context-panel settings schema + defaults, and the two roots the two
 * harness generations register them through.
 *
 * The field set is declared once (`FIELDS`) and built into two SEPARATE roots:
 * 0.1.x registers `CONTEXT_PANEL_SCHEMA` on its own settings namespace, while
 * 0.2.x nests `CONTEXT_PANEL_ENTRY_SCHEMA` under the entry config's `panel`
 * field, marked volatile (host/config.ts). Separate roots because `.volatile()`
 * mutates the node it is applied to, and the 0.1.x registration must keep
 * resolving plain values.
 * @module @our/context-panel/settings
 */
import z from '@deepseek-ai/schemastery'
import type { ContextPanelSettings, PromptModulePatch } from '../types'
import { SEED_MODULES } from '../preset/seeds'

/**
 * Our own settings namespace, distinct from upstream dsh-context's. It doubles
 * as the 0.2.x write address: the Settings service keys forms by the HOST
 * LOADER ENTRY ID (`configForms.get` is documented as "Unique Host plugin entry
 * id"), which this package's cordis.patch.yml declares as `context-panel-write`.
 */
export const CONTEXT_PANEL_NS = 'context-panel-write'

/**
 * Module patch schema (every field optional; source stays a loose object so it can
 * be extended).
 *
 * EXPORTED so the module-definitions FILE validates through this same shape: a
 * second schema would be a second answer to "is this a module", and the file and
 * the settings it succeeds must agree by construction.
 */
export const PatchSchema = z.object({
  text: z.string(),
  channel: z.union([z.const('section'), z.const('context')]),
  order: z.number(),
  enabled: z.boolean(),
  source: z.any(),
})

/**
 * Default configuration (the single source of module definitions is
 * preset/seeds.ts; the client can edit it in the panel).
 * Ranges: section avoids harness(-100)/persona(0)/tool guidance(100-199); context
 * has its own range.
 */
export const DEFAULT_SETTINGS: ContextPanelSettings = {
  panelWidth: 720,
  modules: { ...SEED_MODULES },
  toolRestrictions: {},
  presetDisabledSections: {},
  presetDisabledContexts: {},
  contextOverrides: {},
  suppressedInjections: {},
}


/** The field set both carriers share. */
const FIELDS = {
  panelWidth: z.number(),
  modules: z.dict(PatchSchema),
  toolRestrictions: z.dict(z.object({ allow: z.array(z.string()), deny: z.array(z.string()) })),
  // The ONE level this layer owns: a preset's off lists.
  presetDisabledSections: z.dict(z.array(z.string())),
  presetDisabledContexts: z.dict(z.array(z.string())),
  suppressedInjections: z.dict(z.array(z.string())),
  // Content is global: one value per name, no per-conversation dimension. The
  // nested alternative is the PRE-MIGRATION shape, still accepted so a stored
  // document from before the change resolves instead of being dropped; readPanel
  // folds it into the flat one.
  contextOverrides: contentMap(z.string()),
  sectionOverrides: contentMap(z.string()),
  sectionWeights: contentMap(z.number()),
  sectionOriginals: contentMap(z.string()),
}

/**
 * The model-price mapping's manual rows: one entry per EDITED row, keyed by
 * `priceMap.rowKey`. An absent key leaves that row to the mechanical pass.
 *
 * Deliberately NOT part of the panel tree above: that tree rides the entry
 * config's `panel` field, while the settings card writes TOP-LEVEL field names
 * (`set('priceMap', …)`, the same call the display preferences use). Declared
 * inside the tree it would be unaddressable — the write lands on a field the
 * schema does not carry, is dropped, and the mapping vanishes on the next boot.
 */
/** One manual mapping row: the vendor id and that vendor's model id. */
export interface PriceMapEntry { vendor: string; model: string }

// Annotated, not inferred: the declaration emit cannot name the Dict type this
// would otherwise infer to (TS2883), and the same pattern the panel roots use.
export const PRICE_MAP_SCHEMA: z<Record<string, PriceMapEntry>> = z.dict(z.object({ vendor: z.string(), model: z.string() }))

/**
 * One content map, ACCEPTING the pre-migration nested shape while TYPING as the
 * flat one.
 *
 * The cast is the point: the schema has to let an old document resolve, but
 * every consumer reads the folded value `readPanel` returns, so the flat type is
 * the only one the code should ever see. Losing validation here is acceptable —
 * `foldMap` ignores anything that is not a map.
 * @param inner - the value schema of one entry.
 * @returns the map schema, typed flat.
 */
function contentMap<T>(inner: z<T>): z<Record<string, T>> {
  return z.union([z.dict(inner), z.dict(z.dict(inner))]) as unknown as z<Record<string, T>>
}

/**
 * Fold one content map to its GLOBAL form, whichever shape it has.
 *
 * A document stored before the per-conversation dimension was dropped carries
 * `{ sessionId: { name: value } }`; the last session key wins per name, which is
 * what "merge the experiments up" means. A flat map passes through.
 * @param value - the stored field.
 * @returns the flat map (never a nested one).
 */
function foldMap<T>(value: unknown): Record<string, T> {
  const out: Record<string, T> = {}
  if (value === null || typeof value !== 'object') return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== null && typeof entry === 'object') Object.assign(out, entry as Record<string, T>)
    else out[key] = entry as T
  }
  return out
}

/**
 * The settings as this layer consumes them: every content map global, whatever
 * shape the stored document holds.
 *
 * Applied wherever the settings are read — the state route, the actions and the
 * engine's config reader — so no consumer has to know the pre-migration shape.
 * @param value - the resolved settings.
 * @returns the same settings with the content maps folded flat.
 */
export function readPanel(value: ContextPanelSettings): ContextPanelSettings {
  return {
    ...value,
    contextOverrides: foldMap<string>(value.contextOverrides),
    sectionOverrides: foldMap<string>(value.sectionOverrides),
    sectionWeights: foldMap<number>(value.sectionWeights),
    sectionOriginals: foldMap<string>(value.sectionOriginals),
  }
}

/** Namespace schema (schemastery primitives: z.dict replaces zod's z.record; fields are optional by default). */
export const CONTEXT_PANEL_SCHEMA: z<ContextPanelSettings> = z.object(FIELDS)

/**
 * The entry-config carrier for harness 0.2+ (host/config.ts nests it under
 * `panel` and marks it volatile). A separate ROOT node: the volatile mark
 * mutates the node it is applied to, and the registration schema above must
 * keep resolving namespace values as plain data on the 0.1.x lines.
 */
export const CONTEXT_PANEL_ENTRY_SCHEMA: z<ContextPanelSettings> = z.object(FIELDS)


/** Merge two patches (the latter overrides the former; undefined fields are ignored). */
export function mergePatch(...patches: Array<PromptModulePatch | undefined>): PromptModulePatch {
  const out: PromptModulePatch = {}
  for (const p of patches) {
    if (p === undefined) continue
    if (p.text !== undefined) out.text = p.text
    if (p.channel !== undefined) out.channel = p.channel
    if (p.order !== undefined) out.order = p.order
    if (p.enabled !== undefined) out.enabled = p.enabled
    if (p.source !== undefined) out.source = p.source
  }
  return out
}
