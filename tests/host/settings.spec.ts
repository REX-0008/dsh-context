// Integration tests for the plugin settings namespace (src/host/settings.ts)
// against the real cordis context. The register face is generation-specific —
// dsh V4+ removed `settings.register` and no longer exports the provider base
// class at all — so both service faces are stubbed here: a V3 service carrying
// `register` and a V4+ service carrying only `describe`.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installSettings, SETTINGS_NAMESPACE, SettingsSchema } from '../../src/host/settings'

/** A V3-shaped service: the register face stores the namespace and its schema. */
class MemorySettings {
  readonly registered = new Map<string, unknown>()

  register(ns: string, schema: unknown): unknown {
    this.registered.set(ns, schema)
    return undefined
  }
}

/** Poll until the inject callback inside installSettings has registered the namespace. */
async function untilRegistered(provider: MemorySettings): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (provider.registered.has(SETTINGS_NAMESPACE)) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('the dsh-context settings namespace was never registered')
}

describe('installSettings', () => {
  test('the namespace is the plugin short name', () => {
    assert.equal(SETTINGS_NAMESPACE, 'dsh-context')
  })

  test('registers the dsh-context namespace with the section schema', async () => {
    const provider = new MemorySettings()
    const ctx = new Context()
    ctx.provide('settings', provider)
    installSettings(ctx)
    await untilRegistered(provider)
    assert.equal(provider.registered.get(SETTINGS_NAMESPACE), SettingsSchema, 'the section schema is registered')
  })

  test('the schema resolves defaults and degrades stale values', () => {
    assert.deepEqual(SettingsSchema({}), {
      defaultPlacement: 'all',
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultDeltaBase: 'step',
      defaultToolSort: 'count',
      defaultFileSort: 'count',
      insightsEntry: 'show',
    }, 'schema defaults resolve')
    // The stale values are only legal at runtime (the type face is strict);
    // the loose fields accept them and resolve back to the defaults.
    const resolved = SettingsSchema({ defaultFileSort: 'net', insightsEntry: 'gone' } as never)
    assert.equal(resolved.defaultFileSort, 'count', 'a stale file sort degrades to the default')
    assert.equal(resolved.insightsEntry, 'show', 'a stale insights entry degrades to visible')
  })

  test('without a settings provider the install is inert', () => {
    const ctx = new Context()
    assert.doesNotThrow(() => installSettings(ctx))
    assert.equal(ctx.get('settings'), undefined, 'no provider composed, nothing registered')
  })

  test('a settings service without the register face (dsh V4+) stays inert', async () => {
    // The V4+ settings service derives forms from the entry's own Config
    // schema and no longer carries `settings.register`; the install must
    // feature-detect the face instead of throwing inside the inject fiber.
    const ctx = new Context()
    ctx.provide('settings', { describe: () => [] })
    assert.doesNotThrow(() => installSettings(ctx))
    // Let the inject callback run; a mis-spelled call would fail the fiber.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(ctx.get('settings') !== undefined, 'the foreign service stays composed')
  })
})
