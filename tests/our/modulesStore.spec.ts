// The module-definitions file on disk (src/our/panel/modules-store.ts): the cache
// the hot path reads, the atomic write, and the two rules that protect a hand
// edit — never overwrite an unusable file, never re-read when nothing moved.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { openModulesStore, type ModulesStore } from '../../src/our/panel/modules-store'
import { MODULES_FILE_VERSION, parseModulesFile, serializeModulesFile } from '../../src/our/panel/modules-file'
import { SEED_MODULES } from '../../src/our/preset/seeds'

let dir = ''
let path = ''
let store: ModulesStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'modules-store-'))
  path = join(dir, 'data', 'modules.json')
  store = openModulesStore(path)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Read the file's definitions as they are on disk. */
function onDisk(): Record<string, unknown> {
  const parsed = parseModulesFile(readFileSync(path, 'utf8'))
  assert.ok(parsed.ok)
  return parsed.document.modules
}

describe('first run', () => {
  test('an absent file reads as absent, with nothing to show', () => {
    assert.deepEqual(store.status(), { kind: 'absent' })
    assert.deepEqual(store.current(), {})
  })

  test('seeding writes the built-in modules and creates the directory', () => {
    const status = store.seedIfAbsent()
    assert.equal(status.kind, 'loaded')
    assert.deepEqual(status.kind === 'loaded' ? status.document.modules : {}, SEED_MODULES)
    assert.deepEqual(onDisk(), SEED_MODULES)
  })

  test('a migration carries the user\'s definitions instead of the seed', () => {
    store.seedIfAbsent({ 'our:mine': { text: 'body' } }, 'settings', '2026-10-03T00:00:00.000Z')
    assert.deepEqual(onDisk(), { 'our:mine': { text: 'body' } })
    assert.ok(readFileSync(path, 'utf8').includes('"migratedFrom": "settings"'))
  })

  test('an empty migration falls back to the seed, so a first run is never blank', () => {
    store.seedIfAbsent({}, 'settings')
    assert.deepEqual(onDisk(), SEED_MODULES)
  })

  test('seeding an existing file only loads it — a restart never reseeds', () => {
    store.seedIfAbsent()
    store.upsert('our:x', { text: 'mine' })
    const before = readFileSync(path, 'utf8')
    store.seedIfAbsent({ 'our:other': { text: 'nope' } }, 'settings')
    assert.equal(readFileSync(path, 'utf8'), before, 'the file is not touched')
    assert.equal(store.current()['our:x']?.text, 'mine')
  })
})

describe('writes', () => {
  test('upsert creates then patches, and the file matches the cache', () => {
    store.upsert('our:x', { text: 'first', order: 50 })
    assert.deepEqual(store.current()['our:x'], { text: 'first', order: 50 })
    store.upsert('our:x', { order: 20 })
    assert.deepEqual(store.current()['our:x'], { text: 'first', order: 20 })
    assert.deepEqual(onDisk()['our:x'], { text: 'first', order: 20 })
  })

  test('remove drops the entry and leaves the rest', () => {
    store.seedIfAbsent()
    store.upsert('our:a', { text: 'a' })
    store.remove('our:a')
    assert.ok(!('our:a' in store.current()), 'the entry is gone')
    assert.deepEqual(store.current(), onDisk(), 'and the file agrees')
    assert.deepEqual(Object.keys(store.current()), Object.keys(SEED_MODULES), 'the seeds are untouched')
  })

  test('a write on a fresh install KEEPS the seeds instead of dropping them', () => {
    // The seed fills a first run, so the first write must build on it: writing
    // into an empty baseline would silently lose every built-in module.
    store.upsert('our:x', { text: 'mine' })
    const keys = Object.keys(onDisk())
    assert.ok(keys.includes('our:x'))
    for (const seeded of Object.keys(SEED_MODULES)) assert.ok(keys.includes(seeded), 'kept: ' + seeded)
  })

  test('a write creates the file even when nothing was read first', () => {
    store.upsert('our:x', { text: 'x' })
    assert.equal(store.status().kind, 'loaded')
    assert.deepEqual(onDisk()['our:x'], { text: 'x' })
  })

  test('a first write on an EXISTING file builds on what is there, not on the seed', () => {
    // A fresh process writes without having read first: the file's definitions are
    // the baseline, and only a genuinely absent file falls back to the seed.
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(path, serializeModulesFile({
      version: MODULES_FILE_VERSION,
      modules: { 'our:existing': { text: 'kept' } },
    }), 'utf8')
    const fresh = openModulesStore(path)
    fresh.upsert('our:new', { text: 'added' })
    assert.deepEqual(Object.keys(onDisk()).sort(), ['our:existing', 'our:new'])
    for (const seeded of Object.keys(SEED_MODULES)) {
      assert.ok(!(seeded in onDisk()), 'the seed must not leak in on an existing install: ' + seeded)
    }
  })

  test('an unusable patch leaves the definitions alone', () => {
    store.upsert('our:x', { text: 'kept' })
    const before = readFileSync(path, 'utf8')
    store.upsert('our:x', { order: 'ten' as never })
    assert.equal(readFileSync(path, 'utf8'), before)
  })

  test('a temp file never survives a write', () => {
    store.upsert('our:x', { text: 'x' })
    const names = readdirSync(join(dir, 'data'))
    assert.deepEqual(names, ['modules.json'], 'the rename consumed the temp file')
  })
})

describe('a hand-edited file', () => {
  test('an edit is picked up by the mtime check', () => {
    store.seedIfAbsent()
    writeFileSync(path, serializeModulesFile({
      version: MODULES_FILE_VERSION,
      modules: { 'our:hand': { text: 'written by a person' } },
    }), 'utf8')
    // mtime resolution: force a distinct value rather than sleeping.
    const later = Date.now() / 1000 + 10
    utimesSync(path, later, later)
    assert.deepEqual(Object.keys(store.current()), ['our:hand'])
  })

  test('an UNUSABLE file is reported and NEVER overwritten', () => {
    store.upsert('our:x', { text: 'was here' })
    writeFileSync(path, '{ "version": 1, "modules": ', 'utf8')
    const broken = readFileSync(path, 'utf8')
    assert.deepEqual(store.load(), { kind: 'unreadable', reason: 'syntax' })
    assert.deepEqual(store.current(), {})
    // A write must refuse rather than replace what the user was editing.
    assert.deepEqual(store.upsert('our:new', { text: 'nope' }), { kind: 'unreadable', reason: 'syntax' })
    assert.deepEqual(store.remove('our:x'), { kind: 'unreadable', reason: 'syntax' })
    assert.equal(readFileSync(path, 'utf8'), broken, 'the typo survives for the user to fix')
  })

  test('a structurally wrong file is refused the same way', () => {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(path, '[1,2,3]', 'utf8')
    assert.deepEqual(store.load(), { kind: 'unreadable', reason: 'shape' })
  })

  test('a malformed ENTRY is counted, and the rest still serve', () => {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, modules: { good: { text: 'g' }, bad: 7 } }), 'utf8')
    const status = store.load()
    assert.equal(status.kind, 'loaded')
    assert.equal(status.kind === 'loaded' ? status.dropped : -1, 1)
    assert.deepEqual(Object.keys(store.current()), ['good'])
  })

  test('a file that disappears falls back to absent', () => {
    store.upsert('our:x', { text: 'x' })
    rmSync(path)
    assert.deepEqual(store.load(), { kind: 'absent' })
  })
})
