/**
 * The module-definitions file on disk, with the memory cache the hot path reads.
 *
 * The hot path constraint decides this file's shape: the settings read runs on
 * every `system-prompt/assemble` and every `agent/pre-step`, so the disk is
 * touched ONCE and the answer cached. `current()` is synchronous and serves the
 * cache; it re-reads only when the file's mtime moved, which is what lets a hand
 * edit take effect without a restart.
 *
 * Writes are atomic by construction: a temp file in the same directory, then a
 * rename over the target. A crash mid-write therefore leaves either the old file
 * or the new one — never a half file. The harness ships its own atomic-write
 * helpers, but a profile-installed plugin resolves modules from its own directory
 * and cannot import them, so the semantics are reproduced here.
 * @module @our/context-panel/panel/modules-store
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MODULES_FILE_VERSION,
  mergeModuleEntry,
  dropModuleEntry,
  parseModulesFile,
  seedModulesDocument,
  serializeModulesFile,
  type ModulesDocument,
} from './modules-file'
import type { PromptModulePatch } from '../types'

/** How the last read of the file went, for the panel's report. */
export type StoreStatus =
  /** The file was read and parsed. */
  | { kind: 'loaded'; dropped: number; document: ModulesDocument }
  /** No file yet: the caller decides whether to seed or migrate. */
  | { kind: 'absent' }
  /** The file exists but could not be used; it is left exactly as it is. */
  | { kind: 'unreadable'; reason: 'syntax' | 'shape' | 'io' }

/** One store over one path: a cache, a status, and the writes that maintain both. */
export interface ModulesStore {
  /** The definitions as last read (empty until {@link load}). */
  current(): Record<string, PromptModulePatch>
  /** How the last read went. */
  status(): StoreStatus
  /**
   * Read the file into the cache.
   * @returns the status of that read.
   */
  load(): StoreStatus
  /**
   * Create the file when it does not exist yet.
   *
   * A migration's value wins over the seed: what the user already had is the
   * truth, and the seed is only what a first run starts from.
   * @param migrated - definitions carried over from the previous carrier.
   * @param migratedFrom - the carrier's name, recorded in the file.
   * @param now - the migration timestamp (ISO 8601).
   * @returns the status after the write.
   */
  seedIfAbsent(migrated?: Record<string, PromptModulePatch>, migratedFrom?: string, now?: string): StoreStatus
  /**
   * Set one definition (a new name creates it).
   * @param name - the module name.
   * @param patch - the fields to set.
   * @returns the status after the write.
   */
  upsert(name: string, patch: PromptModulePatch): StoreStatus
  /**
   * Remove one definition.
   * @param name - the module name.
   * @returns the status after the write.
   */
  remove(name: string): StoreStatus
}

/** The mtime of a path, or null when it cannot be read. */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Open a store over one file path.
 * @param path - the definitions file's absolute path.
 * @returns the store; nothing is read until {@link ModulesStore.load}.
 */
export function openModulesStore(path: string): ModulesStore {
  let document: ModulesDocument | undefined
  let status: StoreStatus = { kind: 'absent' }
  /**
   * The mtime the cache was built from; `undefined` means nothing has been read
   * yet. A stable value — including `null` for an ABSENT file, or the mtime of an
   * UNREADABLE one — is what keeps the hot path off the disk: without it, a file
   * that cannot be parsed would be re-read on every assemble.
   */
  let readMtime: number | null | undefined

  /** Write the document atomically and adopt it as the cache. */
  const write = (next: ModulesDocument): StoreStatus => {
    mkdirSync(dirname(path), { recursive: true })
    // Same directory, so the rename stays atomic (a cross-device rename is a copy).
    // Unique per call, so two writers cannot collide on the temp name.
    // ponytail: a crash between the write and the rename can leave one temp file
    // behind. It is inert (nothing reads it) and the next successful write of the
    // same pid+version overwrites it; reap stale ones if this ever shows up in a
    // listing as clutter.
    const suffix = [MODULES_FILE_VERSION, process.pid, Date.now()].join('-')
    const temp = join(dirname(path), `.${suffix}.tmp`)
    try {
      writeFileSync(temp, serializeModulesFile(next), 'utf8')
      renameSync(temp, path)
    } catch (error) {
      // Leave no litter on a failed write, then let the caller see the failure.
      try { rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
      throw error
    }
    document = next
    readMtime = mtimeOf(path)
    status = { kind: 'loaded', dropped: 0, document: next }
    return status
  }

  /**
   * The document a write builds on: the loaded one, a fresh seed when no file
   * exists, or null when the file EXISTS but cannot be used.
   *
   * That null is the important branch. A hand edit with a typo is never
   * overwritten to "fix" it, because doing so would destroy the definitions the
   * user was editing; the panel reports the file instead.
   * @returns the base document, or null when a write must be refused.
   */
  const baseForWrite = (): ModulesDocument | null => {
    if (document !== undefined) return document
    // A write may be the first thing that happens in a process, so read once and
    // decide from the OUTCOME: a loaded file is the baseline, an absent one is
    // seeded, and a file that exists but cannot be parsed refuses the write (its
    // definitions are the user's, and replacing them would destroy an edit).
    const loaded = load()
    if (loaded.kind === 'absent') return seedModulesDocument()
    if (loaded.kind === 'loaded') return loaded.document
    return null
  }

  const load = (): StoreStatus => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      document = undefined
      readMtime = mtimeOf(path)
      status = { kind: 'absent' }
      return status
    }
    const parsed = parseModulesFile(text)
    if (!parsed.ok) {
      // The file is left exactly as it is: a hand edit with a typo must not cost
      // the user their definitions, so nothing is overwritten to "fix" it.
      document = undefined
      readMtime = mtimeOf(path)
      status = { kind: 'unreadable', reason: parsed.reason }
      return status
    }
    document = parsed.document
    readMtime = mtimeOf(path)
    status = { kind: 'loaded', dropped: parsed.dropped, document: parsed.document }
    return status
  }

  return {
    status: () => status,
    load,
    current() {
      // A hand edit is invisible until this check; everything else is the cache.
      const mtime = mtimeOf(path)
      if (readMtime === undefined || mtime !== readMtime) load()
      return document === undefined ? {} : document.modules
    },
    seedIfAbsent(migrated, migratedFrom, now) {
      if (mtimeOf(path) !== null) return load()
      const seed = seedModulesDocument(migratedFrom, now)
      // A migration's definitions are the truth when there are any; the seed only
      // fills a genuinely first run.
      const modules = migrated !== undefined && Object.keys(migrated).length > 0 ? migrated : seed.modules
      return write({ ...seed, modules })
    },
    upsert(name, patch) {
      const base = baseForWrite()
      if (base === null) return status
      return write({ ...base, modules: mergeModuleEntry(base.modules, name, patch) })
    },
    remove(name) {
      const base = baseForWrite()
      if (base === null) return status
      return write({ ...base, modules: dropModuleEntry(base.modules, name) })
    },
  }
}
