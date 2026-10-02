/**
 * The module DEFINITIONS file: parse, validate, serialize — pure, no fs.
 *
 * The module set used to live in settings, which meant two carriers (a 0.1.x
 * settings namespace, a 0.2.x entry-config volatile field) for one truth, and a
 * value a person could not open, diff or back up. It now lives in one JSON file
 * under the profile's data directory (see data-dir.ts for WHERE), and this module
 * owns everything about that file's CONTENT.
 *
 * Split from the fs adapter on purpose: the rules here are the ones worth holding
 * to 100%, and none of them need a disk.
 *
 * Trust posture: the file is hand-editable, so it is parsed as untrusted input.
 * An unusable file is reported, never silently replaced — a typo must not cost
 * the user their definitions.
 * @module @our/context-panel/panel/modules-file
 */
import { PatchSchema } from './settings'
import { SEED_MODULES } from '../preset/seeds'
import type { PromptModulePatch } from '../types'

/**
 * The document's format version.
 *
 * Written so a future change can migrate deliberately: a reader that meets a
 * version it does not know refuses the file instead of guessing at its shape.
 */
export const MODULES_FILE_VERSION = 1

/** The file's whole content. */
export interface ModulesDocument {
  /** {@link MODULES_FILE_VERSION} at write time. */
  version: number
  /** Where the definitions came from when they were migrated, not seeded. */
  migratedFrom?: string
  /** When that migration ran (ISO 8601), for the record. */
  migratedAt?: string
  /** One definition per module name (the single source of truth). */
  modules: Record<string, PromptModulePatch>
}

/** The outcome of reading the file's text, with the reason kept for the report. */
export type ModulesParse =
  | { ok: true; document: ModulesDocument; /** Entries dropped as malformed. */ dropped: number }
  | { ok: false; reason: 'syntax' | 'shape' }

/** Whether a value is a plain record (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One stored entry, validated through the shared module schema.
 * @param value - the entry as stored.
 * @returns the entry, or undefined when it is not a module at all.
 */
function entryOf(value: unknown): PromptModulePatch | undefined {
  if (!isRecord(value)) return undefined
  try {
    return PatchSchema(value) as PromptModulePatch
  } catch {
    return undefined
  }
}

/**
 * Read the file's text into a document.
 *
 * Malformed ENTRIES are dropped and counted rather than failing the whole file: a
 * single bad row should cost that row, not every definition beside it. A file
 * that is not JSON, or whose root is not an object, is refused whole —
 * (`ok: false`) because nothing in it can be trusted.
 * @param text - the file's content.
 * @returns the parsed document, or the refusal reason.
 */
export function parseModulesFile(text: string): ModulesParse {
  let root: unknown
  try {
    root = JSON.parse(text) as unknown
  } catch {
    return { ok: false, reason: 'syntax' }
  }
  if (!isRecord(root)) return { ok: false, reason: 'shape' }
  if (root.version !== MODULES_FILE_VERSION) return { ok: false, reason: 'shape' }
  const raw = isRecord(root.modules) ? root.modules : {}
  const modules: Record<string, PromptModulePatch> = {}
  let dropped = 0
  for (const [name, value] of Object.entries(raw)) {
    const entry = entryOf(value)
    if (entry === undefined) {
      dropped += 1
      continue
    }
    modules[name] = entry
  }
  return {
    ok: true,
    dropped,
    document: {
      version: MODULES_FILE_VERSION,
      ...(typeof root.migratedFrom === 'string' ? { migratedFrom: root.migratedFrom } : {}),
      ...(typeof root.migratedAt === 'string' ? { migratedAt: root.migratedAt } : {}),
      modules,
    },
  }
}

/**
 * Render a document as the file's text.
 *
 * Two-space indent and a trailing newline: the file is meant to be opened, read
 * and hand-edited, so a diff of it should be legible.
 * @param document - the document to write.
 * @returns the file's content.
 */
export function serializeModulesFile(document: ModulesDocument): string {
  return JSON.stringify({
    version: MODULES_FILE_VERSION,
    ...(document.migratedFrom === undefined ? {} : { migratedFrom: document.migratedFrom }),
    ...(document.migratedAt === undefined ? {} : { migratedAt: document.migratedAt }),
    modules: document.modules,
  }, null, 2) + '\n'
}

/**
 * The seed document: what a FIRST run writes.
 *
 * `SEED_MODULES` is the seed, not the truth — once a file exists it is the only
 * source, so a later release's new seed does not appear on an existing install
 * (the same rule that keeps a deleted seed deleted).
 * @param migratedFrom - set when the seed replaces a migrated value.
 * @param migratedAt - the migration's timestamp.
 * @returns a fresh document holding the seeds.
 */
export function seedModulesDocument(migratedFrom?: string, migratedAt?: string): ModulesDocument {
  return {
    version: MODULES_FILE_VERSION,
    ...(migratedFrom === undefined ? {} : { migratedFrom }),
    ...(migratedAt === undefined ? {} : { migratedAt }),
    modules: { ...SEED_MODULES },
  }
}

/**
 * Merge one validated patch into the set (a new name creates the entry).
 * @param modules - the current definitions.
 * @param name - the module name.
 * @param patch - the fields to set.
 * @returns the new definitions; the input is not mutated.
 */
export function mergeModuleEntry(
  modules: Record<string, PromptModulePatch>,
  name: string,
  patch: PromptModulePatch,
): Record<string, PromptModulePatch> {
  // A patch arrives over HTTP, so the MERGED entry is validated here too: an
  // unusable one leaves the previous definition in place rather than writing
  // something the next parse would drop.
  const checked = entryOf({ ...modules[name], ...patch })
  if (checked === undefined) return { ...modules }
  return { ...modules, [name]: checked }
}

/**
 * Drop one definition.
 * @param modules - the current definitions.
 * @param name - the module name.
 * @returns the new definitions; the input is not mutated.
 */
export function dropModuleEntry(
  modules: Record<string, PromptModulePatch>,
  name: string,
): Record<string, PromptModulePatch> {
  const { [name]: _removed, ...rest } = modules
  return rest
}
