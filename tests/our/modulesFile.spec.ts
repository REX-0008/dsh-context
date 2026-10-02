// The module-definitions file's pure half (src/our/panel/modules-file.ts): the
// parse rules, the serialization, the seed document and the set edits. No disk
// here — the fs adapter is tested separately — so every case is deterministic.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  MODULES_FILE_VERSION,
  dropModuleEntry,
  mergeModuleEntry,
  parseModulesFile,
  seedModulesDocument,
  serializeModulesFile,
  type ModulesDocument,
} from '../../src/our/panel/modules-file'
import { SEED_MODULES } from '../../src/our/preset/seeds'

/** A minimal valid document. */
const doc = (modules: ModulesDocument['modules']): ModulesDocument => ({ version: MODULES_FILE_VERSION, modules })

describe('parseModulesFile', () => {
  test('the version and the module map are both required', () => {
    assert.deepEqual(parseModulesFile('{'), { ok: false, reason: 'syntax' })
    assert.deepEqual(parseModulesFile('[]'), { ok: false, reason: 'shape' })
    assert.deepEqual(parseModulesFile('"text"'), { ok: false, reason: 'shape' })
    assert.deepEqual(parseModulesFile('{}'), { ok: false, reason: 'shape' })
    assert.deepEqual(parseModulesFile('{"version":99,"modules":{}}'), { ok: false, reason: 'shape' })
  })

  test('a document without a module map reads as empty rather than failing', () => {
    const parsed = parseModulesFile('{"version":1}')
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.document.modules, {})
    assert.equal(parsed.dropped, 0)
  })

  test('a malformed ENTRY costs that entry alone', () => {
    const parsed = parseModulesFile(JSON.stringify({
      version: 1,
      modules: {
        good: { text: 'body', order: 10 },
        'not-a-record': 'text',
        'bad-order': { text: 'x', order: 'ten' },
        'null-entry': null,
      },
    }))
    assert.ok(parsed.ok)
    assert.deepEqual(Object.keys(parsed.document.modules), ['good'])
    assert.equal(parsed.dropped, 3, 'every unusable entry is counted, not hidden')
  })

  test('the migration record is carried through when present', () => {
    const parsed = parseModulesFile('{"version":1,"migratedFrom":"settings","migratedAt":"2026-10-03T00:00:00.000Z","modules":{}}')
    assert.ok(parsed.ok)
    assert.equal(parsed.document.migratedFrom, 'settings')
    assert.equal(parsed.document.migratedAt, '2026-10-03T00:00:00.000Z')
    const plain = parseModulesFile('{"version":1,"migratedFrom":7,"modules":{}}')
    assert.ok(plain.ok)
    assert.equal(plain.document.migratedFrom, undefined, 'a non-string marker is not carried')
  })
})

describe('serializeModulesFile', () => {
  test('a document round-trips through text unchanged', () => {
    const document = doc({ 'our:x': { text: 'body', channel: 'section', order: 50, enabled: true } })
    const parsed = parseModulesFile(serializeModulesFile(document))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.document.modules, document.modules)
  })

  test('the migration record is written only when it exists', () => {
    assert.ok(!serializeModulesFile(doc({})).includes('migratedFrom'))
    assert.ok(serializeModulesFile(seedModulesDocument('settings', 'now')).includes('"migratedFrom": "settings"'))
  })

  test('the text is meant to be read: indented and newline-terminated', () => {
    const text = serializeModulesFile(doc({}))
    assert.ok(text.endsWith('\n'))
    assert.ok(text.includes('\n  "version"'))
  })
})

describe('seedModulesDocument', () => {
  test('a first run seeds every built-in module', () => {
    const document = seedModulesDocument()
    assert.deepEqual(document.modules, SEED_MODULES)
    assert.equal(document.migratedFrom, undefined)
    assert.equal(document.migratedAt, undefined)
  })

  test('a migration records where the definitions came from', () => {
    const document = seedModulesDocument('settings', '2026-10-03T00:00:00.000Z')
    assert.equal(document.migratedFrom, 'settings')
    assert.equal(document.migratedAt, '2026-10-03T00:00:00.000Z')
  })
})

describe('mergeModuleEntry', () => {
  test('a new name creates the definition', () => {
    const merged = mergeModuleEntry({}, 'our:new', { text: 'body', order: 50 })
    assert.deepEqual(merged, { 'our:new': { text: 'body', order: 50 } })
  })

  test('an existing name patches only the fields it carries', () => {
    const before = { 'our:x': { text: 'old', order: 10, enabled: true } }
    const merged = mergeModuleEntry(before, 'our:x', { order: 20 })
    assert.deepEqual(merged['our:x'], { text: 'old', order: 20, enabled: true })
    assert.deepEqual(before['our:x'], { text: 'old', order: 10, enabled: true }, 'the input is not mutated')
  })

  test('a patch that would leave an unusable entry changes nothing', () => {
    const before = { 'our:x': { text: 'old', order: 10 } }
    const merged = mergeModuleEntry(before, 'our:x', { order: 'ten' as never })
    assert.deepEqual(merged, before)
  })
})

describe('dropModuleEntry', () => {
  test('a name is removed and the input survives', () => {
    const before = { a: { text: 'a' }, b: { text: 'b' } }
    const after = dropModuleEntry(before, 'a')
    assert.deepEqual(Object.keys(after), ['b'])
    assert.deepEqual(Object.keys(before), ['a', 'b'])
  })

  test('an absent name is a no-op', () => {
    const before = { a: { text: 'a' } }
    assert.deepEqual(dropModuleEntry(before, 'zzz'), before)
  })
})
