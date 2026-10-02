// Where the data file lands (src/our/panel/data-dir.ts). The three-step fallback
// is the whole point: the host's answer first, an env fallback for a deployment
// that composes none, and a last resort that never lands somewhere wild.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { join } from 'node:path'
import { DATA_DIR_NAME, MODULES_FILE_NAME, dataDirOf, modulesFileOf } from '../../src/our/panel/data-dir'

const savedHome = process.env.DSH_HOME
const savedProfile = process.env.DSH_PROFILE

beforeEach(() => {
  delete process.env.DSH_HOME
  delete process.env.DSH_PROFILE
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedProfile === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = savedProfile
})

/** A context whose `get` answers for one service name only. */
const ctxWith = (profileContext: unknown) => ({ get: (name: string) => (name === 'profileContext' ? profileContext : undefined) })

describe('dataDirOf', () => {
  test('the host\'s profileContext.dir is the first answer', () => {
    process.env.DSH_HOME = 'H:/home'
    process.env.DSH_PROFILE = 'ignored-when-the-host-answers'
    assert.equal(dataDirOf(ctxWith({ dir: 'H:/home/profiles/desktop' })), join('H:/home/profiles/desktop', 'data', DATA_DIR_NAME))
  })

  test('a blank or non-string dir falls through to the env fallback', () => {
    process.env.DSH_HOME = 'H:/home'
    process.env.DSH_PROFILE = 'web'
    const expected = join('H:/home', 'profiles', 'web', 'data', DATA_DIR_NAME)
    assert.equal(dataDirOf(ctxWith({ dir: '   ' })), expected)
    assert.equal(dataDirOf(ctxWith({ dir: 7 })), expected)
    assert.equal(dataDirOf(ctxWith({})), expected)
  })

  test('with neither answer it still lands under the harness home', () => {
    process.env.DSH_HOME = 'H:/home'
    assert.equal(dataDirOf(ctxWith(undefined)), join('H:/home', 'data', DATA_DIR_NAME))
  })

  test('a context that is not a context, or has no get, is tolerated', () => {
    process.env.DSH_HOME = 'H:/home'
    const expected = join('H:/home', 'data', DATA_DIR_NAME)
    assert.equal(dataDirOf(undefined), expected)
    assert.equal(dataDirOf(null), expected)
    assert.equal(dataDirOf({}), expected)
    assert.equal(dataDirOf({ get: 'not-a-function' }), expected)
  })

  test('a blank DSH_HOME is ignored rather than used as a root', () => {
    process.env.DSH_HOME = '   '
    process.env.DSH_PROFILE = 'desktop'
    const dir = dataDirOf(ctxWith(undefined))
    assert.ok(!dir.startsWith('   '), 'the blank home is never a prefix: ' + dir)
    assert.ok(dir.endsWith(join('profiles', 'desktop', 'data', DATA_DIR_NAME)), 'resolved under the real home: ' + dir)
  })
})

describe('modulesFileOf', () => {
  test('the file sits inside the data directory', () => {
    process.env.DSH_HOME = 'H:/home'
    assert.equal(modulesFileOf(ctxWith({ dir: 'H:/p' })), join('H:/p', 'data', DATA_DIR_NAME, MODULES_FILE_NAME))
  })
})
