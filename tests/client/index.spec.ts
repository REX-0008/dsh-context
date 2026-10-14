// Client entry (src/client/index.ts): the plugin's apply() wiring through the faithful harness-context seams.

import { createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import { modalStoreOf, type ModalStore } from '../../src/client/modalStore'
import type { SettingsField, SettingsScopeLike, SettingsState } from '../../src/client/settings'
import { TestClientCtx, TestSessions, asClientCtx } from './helpers/harness'
import { click, mount, query, queryAll, text } from './helpers/kit'

// The entry ships via `module.exports` (bundle handoff shape); its runtime exports are the plugin triple, opaque to the static import type.
const { name, inject, apply } = (await import('../../src/client/index')) as unknown as {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
}

function applyTo(ctx: TestClientCtx): void {
  apply(asClientCtx(ctx))
}

function makeScope(snapshot: { status: string; value: unknown; writable: boolean }): SettingsScopeLike & {
  subscribes: number
  sets: { field: string; value: unknown }[]
} {
  const rec = {
    subscribes: 0,
    sets: [] as { field: string; value: unknown }[],
    getSnapshot: () => snapshot,
    subscribe: (_listener: () => void) => {
      rec.subscribes += 1
      return () => {}
    },
    set: async (field: string, value: unknown) => {
      rec.sets.push({ field, value })
    },
  }
  return rec
}

/** A configForms stand-in capturing the whileServed registration. */
function fakeConfigForms(form: SettingsScopeLike): {
  gets: string[]
  whileServedCalls: string[][]
  register: () => () => void
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
} {
  const rec = {
    gets: [] as string[],
    whileServedCalls: [] as string[][],
    register: (): (() => void) => () => {},
    get(namespace: string): SettingsScopeLike {
      rec.gets.push(namespace)
      return form
    },
    whileServed(namespaces: string[], register: () => () => void): () => void {
      rec.whileServedCalls.push(namespaces)
      rec.register = register
      return () => {}
    },
  }
  return rec
}
/** A configForms face serving the given form (the card seat's transport). */
function formsServing(form: SettingsScopeLike): {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
} {
  return {
    get: () => form,
    whileServed: () => () => {},
  }
}

/** A settings form whose snapshot the test drives (the emit path). */
function scopeWith(snapshot: { status: string; value: unknown; writable: boolean }): SettingsScopeLike & {
  emit(next: { status: string; value: unknown; writable: boolean }): void
} {
  let current = snapshot
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: () => Promise.resolve(),
    emit(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

describe('client entry: constants', () => {
  test('name and inject declare the plugin identity and hard dependencies', () => {
    assert.equal(name, 'dsh-context')
    assert.deepEqual(inject, ['slots', 'locale'])
  })
})

// The registration keys name different things and must not be collapsed into
// one string again: the browser reads the locale/slot key against the BUNDLE
// PACKAGE NAME (the Plugins page renders the keyed `plugins.bundle.config`
// seat with `entryKey: pkg.name`), while the settings transport addresses the
// HOST LOADER ENTRY ID (`configForms.get` is documented as "Unique Host plugin
// entry id"). Upstream could reuse one string because its package, entry id and
// namespace were all `dsh-context`; this fork renamed the first two, which is
// exactly why the settings card stopped appearing on the Plugins page.
describe('client entry: the two registration keys', () => {
  // Read the real identities rather than restating them: the bundle package name
  // comes from package.json, the Host entry id from this package's own
  // cordis.patch.yml row. A rename that updates one but not the other fails here
  // instead of silently dropping the settings card from the Plugins page.
  const BUNDLE: string = JSON.parse(readFileSync('package.json', 'utf8')).name
  const ENTRY: string = /^\s*- id:\s*(\S+)/m.exec(readFileSync('cordis.patch.yml', 'utf8'))?.[1] ?? ''

  test('the bundle package name and the loader entry id are distinct', () => {
    assert.equal(BUNDLE, '@our/context-panel-write')
    assert.equal(ENTRY, 'context-panel-write')
  })

  test('the locale namespace and the Plugins-page slot key the bundle package name', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    assert.ok(ctx.locale.namespaces.has(BUNDLE), 'the dictionary registers under the bundle package name')
    ctx.dispose()
  })

  test('the settings transport keys the Host loader entry id', () => {
    const ctx = new TestClientCtx()
    const forms = fakeConfigForms(makeScope({ status: 'ready', value: {}, writable: true }))
    ctx.setService('configForms', forms)
    applyTo(ctx)
    assert.deepEqual(forms.gets, [ENTRY])
    assert.deepEqual(forms.whileServedCalls, [[ENTRY]])
    ctx.dispose()
  })
})

describe('client entry: dictionaries', () => {
  test('apply registers the real zh/en dicts; dispose removes them', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const dicts = ctx.locale.namespaces.get('@our/context-panel-write')
    assert.ok(dicts)
    assert.equal(dicts.zh, DICT_ZH)
    assert.equal(dicts.en, DICT_EN)
    // The bound translate resolves through the active-locale → en chain.
    assert.equal(ctx.locale.bind('@our/context-panel-write')('tab.context'), 'Context')
    ctx.dispose()
    assert.equal(ctx.locale.namespaces.has('@our/context-panel-write'), false)
  })

  test('the zh active locale binds the zh dictionary arm', () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    applyTo(ctx)
    assert.equal(ctx.locale.bind('@our/context-panel-write')('tab.context'), '上下文')
    ctx.dispose()
  })
})

describe('client entry: conversation.view slot', () => {
  test('registers the Context tab whose label follows the locale and whose component renders', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.view')
    assert.equal(entries.length, 2)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.view')
    assert.equal(registration.id, 'context')
    assert.equal(registration.order, 20)
    assert.equal(registration.locale, '@our/context-panel-write')
    assert.equal(registration.label?.(), 'Context')

    const el = component({ sessionId: 's1', useProjection: () => undefined }) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'ContextView')
    const m = await mount(el)
    assert.equal(query(m.container, '.lc-empty').textContent, 'Reading the session log…')
    await m.unmount()
    ctx.dispose()
  })

  test('registers the Fleet tab right of the Context tab, and its component renders the same card', async () => {
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } } } })
    applyTo(ctx)
    const { registration, component } = ctx.slots.of('conversation.view')[1]
    assert.equal(registration.name, 'conversation.view')
    assert.equal(registration.id, 'fleet')
    assert.equal(registration.order, 30)
    assert.equal(registration.locale, '@our/context-panel-write')
    assert.equal(registration.label?.(), 'Fleet')

    const el = component({ sessionId: 's1', useProjection: () => undefined }) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'FleetView')
    const m = await mount(el)
    assert.equal(query(m.container, '.lc-empty').textContent, 'Reading the session log…')
    await m.unmount()
    ctx.dispose()
  })

  test('the tab labels translate to zh under an zh locale', () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    applyTo(ctx)
    const labels = ctx.slots.of('conversation.view').map(e => e.registration.label?.())
    assert.deepEqual(labels, ['上下文', '编队'])
    ctx.dispose()
  })

  test('the fleetTab preference serves and withdraws the Fleet tab alone', () => {
    const scope = scopeWith({ status: 'ready', value: { fleetTab: 'hide' }, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['context'], 'only the Context tab is served')
    scope.emit({ status: 'ready', value: { fleetTab: 'show' }, writable: true })
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['context', 'fleet'])
    scope.emit({ status: 'ready', value: { fleetTab: 'hide' }, writable: true })
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['context'], 'the Context tab is never churned')
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
  })
})

describe('client entry: assistant-actions seat', () => {
  test('registers the chat→Context jump entry whose component renders the labelled icon button', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.chat.assistant-actions')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.chat.assistant-actions')
    assert.equal(registration.id, 'context-jump')
    assert.equal(registration.order, 20, 'right of the shipped feedback entry')
    assert.equal(registration.locale, '@our/context-panel-write')

    const el = component({ messageId: 'm1' }) as ReactElement
    const m = await mount(el)
    assert.equal(query(m.container, 'button.lc-jump').getAttribute('aria-label'), 'View this turn in the Context view')
    await m.unmount()

    // Interruption-frozen partials address no durable message: nothing renders.
    const nil = await mount(component({ messageId: 7 }) as ReactElement)
    assert.equal(queryAll(nil.container, 'button').length, 0)
    await nil.unmount()
    ctx.dispose()
  })
})

describe('client entry: sessions scope seam', () => {
  test('absent sessions service: apply is a noop for the sessions seams', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    ctx.dispose()
  })

  test('sessions present: apply wires through and disposes cleanly', () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    applyTo(ctx)
    ctx.dispose()
  })
})

describe('client entry: /context command effect', () => {
  test('absent inputTriggers service: no source, nothing thrown', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    ctx.dispose()
  })

  test('inputTriggers present: the source registers and dispose unregisters it', () => {
    const sources: { trigger: string; name: string }[] = []
    const inputTriggers = {
      registerSource(src: { trigger: string; name: string }): () => void {
        sources.push(src)
        return () => {
          const i = sources.indexOf(src)
          if (i >= 0) sources.splice(i, 1)
        }
      },
    }
    const ctx = new TestClientCtx({ services: { inputTriggers } })
    applyTo(ctx)
    assert.equal(sources.length, 1)
    assert.equal(sources[0].trigger, '/')
    assert.equal(sources[0].name, 'context')
    ctx.dispose()
    assert.equal(sources.length, 0)
  })
})

describe('client entry: conversation.input.overlay slot', () => {
  test('registers the modal overlay; inject binds the per-session modal store; closed renders null', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.input.overlay')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.input.overlay')
    assert.equal(registration.id, 'context-modal')
    assert.equal(registration.order, 10)
    assert.equal(registration.locale, '@our/context-panel-write')

    const face = registration.inject?.('sess-1') as { hooks: { contextModal: ModalStore } }
    assert.equal(face.hooks.contextModal, modalStoreOf('sess-1'))

    const el = component({
      sessionId: 'sess-1',
      useContextModal: (sel: (open: boolean) => boolean) => sel(modalStoreOf('sess-1').getSnapshot()),
    }) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'ContextModal')
    const m = await mount(el)
    assert.equal(m.container.textContent, '')
    await m.unmount()
    ctx.dispose()
  })
})

describe('client entry: Context Insights page seats', () => {
  test('registers the keyed main page and the sidebar panel-list entry under one id', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)

    const pages = ctx.slots.of('main')
    assert.equal(pages.length, 1)
    assert.equal(pages[0].registration.name, 'main')
    assert.equal(pages[0].registration.key, 'dsh-context')
    assert.equal(pages[0].registration.locale, '@our/context-panel-write')
    const pageEl = pages[0].component({}) as ReactElement
    assert.equal((pageEl.type as { name: string }).name, 'OverviewPanel')
    const pageMount = await mount(pageEl)
    assert.ok(query(pageMount.container, 'section.lc-ov-page') !== null, 'the page renders on mount (mount IS the open)')
    assert.ok(text(pageMount.container).includes('The session list is unavailable'), 'no standard kit degrades visibly')
    await pageMount.unmount()

    const entries = ctx.slots.of('sidebar.panellist')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].registration.name, 'sidebar.panellist')
    assert.equal(entries[0].registration.id, 'dsh-context', 'the entry id addresses the main panel')
    assert.equal(entries[0].registration.order, 20, 'after the shipped Plugins (0) and Automation tasks (10)')
    assert.equal(entries[0].registration.locale, '@our/context-panel-write')
    assert.equal(entries[0].registration.label?.(), 'Context Insights')
    const iconMount = await mount(entries[0].component({ size: 16 }) as ReactElement)
    assert.ok(query(iconMount.container, 'svg') !== null, 'the entry glyph renders')
    await iconMount.unmount()
    ctx.dispose()
  })

  test('the insightsEntry preference unwinds and remounts the pair', async () => {
    const scope = scopeWith({ status: 'ready', value: {}, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.equal(ctx.slots.of('main').length, 1, 'the default entry mounts the page')
    scope.emit({ status: 'ready', value: { insightsEntry: 'hide' }, writable: true })
    assert.equal(ctx.slots.of('main').length, 0, 'hiding the entry unwinds the page')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0, 'hiding unwinds the entry')
    scope.emit({ status: 'ready', value: { insightsEntry: 'show' }, writable: true })
    assert.equal(ctx.slots.of('main').length, 1)
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)
    ctx.dispose()
    assert.equal(ctx.slots.of('main').length, 0, 'the plugin dispose unwinds the pair')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0)
  })
})

describe('client entry: settingsScope inject', () => {
  test('absent at apply time: the inject stays pending — no settings.plugin.item slot', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    assert.equal(ctx.slots.of('settings.plugin.item').length, 0)
    ctx.dispose()
  })

  test('armed later: the pending inject runs — scope attached and card slot registered', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const scope = makeScope({ status: 'ready', value: {}, writable: true })
    const specs: { namespace: string }[] = []
    ctx.setService('settingsScope', {
      bind: (spec: { namespace: string }) => {
        specs.push(spec)
        return scope
      },
    })
    assert.deepEqual(specs, [{ namespace: 'context-panel-write' }])
    assert.equal(scope.subscribes, 1)
    assert.equal(ctx.slots.of('settings.plugin.item').length, 1)
    ctx.dispose()
  })

  test('defensive arm: service key present but undefined — early return, no slot, no throw', () => {
    const ctx = new TestClientCtx()
    ctx.setService('settingsScope', undefined)
    applyTo(ctx)
    assert.equal(ctx.slots.of('settings.plugin.item').length, 0)
    ctx.dispose()
  })
})

describe('client entry: configForms inject (the Config-form generation)', () => {

  test('absent at apply time: the inject stays pending — no plugins.bundle.config slot', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    assert.equal(ctx.slots.of('plugins.bundle.config').length, 0)
    ctx.dispose()
  })

  test('defensive arm: a service without the consumed faces — early return, no slot, no throw', () => {
    const ctx = new TestClientCtx()
    ctx.setService('configForms', { get: () => makeScope({ status: 'ready', value: {}, writable: true }) })
    applyTo(ctx)
    assert.equal(ctx.slots.of('plugins.bundle.config').length, 0)
    ctx.dispose()
    const ctx2 = new TestClientCtx()
    ctx2.setService('configForms', undefined)
    applyTo(ctx2)
    assert.equal(ctx2.slots.of('plugins.bundle.config').length, 0)
    ctx2.dispose()
  })

  test('armed later: the form binds the namespace and the served registration claims the Plugins-page seat', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const scope = makeScope({ status: 'ready', value: { defaultTrendMode: 'delta' }, writable: true })
    const forms = fakeConfigForms(scope)
    ctx.setService('configForms', forms)
    // The namespace is the Host loader entry id (this fork renamed it; see the two-keys note).
    assert.deepEqual(forms.gets, ['context-panel-write'])
    assert.equal(scope.subscribes, 1, 'the settings store attached to the form')
    assert.deepEqual(forms.whileServedCalls, [['context-panel-write']])
    // Nothing registers until the Host serves the namespace.
    assert.equal(ctx.slots.of('plugins.bundle.config').length, 0)
    // The Host serves: the register claims the keyed seat.
    const disposeRegistration = forms.register()
    const entries = ctx.slots.of('plugins.bundle.config')
    assert.equal(entries.length, 1)
    const registration = entries[0].registration as never as {
      name: string
      key?: string
      locale?: string
      inject?: () => unknown
    }
    assert.equal(registration.name, 'plugins.bundle.config')
    assert.equal(registration.key, '@our/context-panel-write')
    assert.equal(registration.locale, '@our/context-panel-write')
    const face = registration.inject?.() as {
      hooks: { contextSettings: { getSnapshot(): SettingsState } }
      set: (field: SettingsField, value: string) => void
    }
    assert.equal(face.hooks.contextSettings.getSnapshot().mode, 'delta', 'the card reads the form snapshot')
    face.set('defaultToolSort', 'name')
    assert.deepEqual(scope.sets, [{ field: 'defaultToolSort', value: 'name' }])
    // The seat's component renders the flat Plugins-page card.
    const el = entries[0].component({}) as ReactElement
    assert.equal((el.type as { name: string }).name, 'PluginConfigCard')
    const store = face.hooks.contextSettings
    const m = await mount(h(el.type as never, {
      useContextSettings: <T,>(sel: (state: SettingsState) => T): T => sel(store.getSnapshot()),
    }))
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 9)
    assert.equal(queryAll(m.container, '.lc-settings-textarea').length, 2)
    assert.equal(m.container.querySelector('.lc-settings-head'), null, 'no settings-section chrome on this seat')
    await m.unmount()
    disposeRegistration()
    assert.deepEqual(ctx.slots.of('plugins.bundle.config'), [], 'the registration disposer withdraws the seat')
    ctx.dispose()
  })
})

describe('client entry: right Sidebar Context tab', () => {
  test('absent sidebar registry at apply time: no tab, no body seat, no throw', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
    ctx.dispose()
  })

  test('armed later: the pending inject registers the Context tab type and body', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const definitions: { id?: string; kind?: string; title?: () => string }[] = []
    ctx.setService('sidebarRightTabs', {
      register: (definition: { id?: string; kind?: string; title?: () => string }) => {
        definitions.push(definition)
        return () => {}
      },
    })
    assert.equal(definitions.length, 1)
    assert.equal(definitions[0].id, 'dsh-context')
    assert.equal(definitions[0].kind, 'dsh-context')
    assert.equal(definitions[0].title?.(), 'Context')
    const bodies = ctx.slots.of('sidebar.right.pane.tab')
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].registration.key, 'dsh-context')
    ctx.dispose()
  })
})

describe('client entry: settings card slot', () => {
  function setup(): {
    ctx: TestClientCtx
    scope: ReturnType<typeof makeScope>
    registration: { name: string; key?: string; locale?: string; inject?: () => unknown }
    component: (props: Record<string, unknown>) => unknown
  } {
    const scope = makeScope({ status: 'loading', value: null, writable: false })
    const ctx = new TestClientCtx({
      services: { settingsScope: { bind: () => scope } },
    })
    applyTo(ctx)
    const entry = ctx.slots.of('settings.plugin.item')[0]
    return {
      ctx,
      scope,
      registration: entry.registration as never,
      component: entry.component as never,
    }
  }

  test('registers the keyed card; inject exposes the settings store and a set verb', () => {
    const { ctx, scope, registration } = setup()
    assert.equal(registration.name, 'settings.plugin.item')
    assert.equal(registration.key, '@our/context-panel-write')
    assert.equal(registration.locale, '@our/context-panel-write')

    const face = registration.inject?.() as {
      hooks: { contextSettings: { getSnapshot(): SettingsState }; priceMapRevision: unknown }
      set: (field: SettingsField, value: string) => void
      usePriceMap: () => {
        overrides: Record<string, { vendor: string; model: string }>
        write: (next: Record<string, { vendor: string; model: string }>) => void
        revision: number
      }
    }
    assert.equal(face.hooks.contextSettings.getSnapshot().granularity, 'step')
    face.set('defaultGranularity', 'turn')
    assert.equal(face.hooks.contextSettings.getSnapshot().granularity, 'turn')
    assert.deepEqual(scope.sets, [{ field: 'defaultGranularity', value: 'turn' }])
    // The price-mapping seat rides the same face. Its reader is a real hook, so
    // it is exercised in the render test below, not called out of band.
    assert.ok(face.hooks.priceMapRevision, 'the revision observable is exposed')
    ctx.dispose()
  })

  test('the price-mapping seat reads the stored overrides and writes them back', async () => {
    const { ctx, scope } = setup()
    const face = ctx.slots.of('settings.plugin.item')[0].registration.inject?.() as {
      usePriceMap: () => {
        overrides: Record<string, { vendor: string; model: string }>
        write: (next: Record<string, { vendor: string; model: string }>) => void
        revision: number
      }
    }
    // The seat is a hook, so a component calls it exactly as the card does.
    let seen: { overrides: Record<string, { vendor: string; model: string }>; revision: number } | undefined
    let write: ((next: Record<string, { vendor: string; model: string }>) => void) | undefined
    function Probe(): ReactElement {
      const seat = face.usePriceMap()
      seen = { overrides: seat.overrides, revision: seat.revision }
      write = seat.write
      return h('span', null, String(seat.revision))
    }
    const m = await mount(h(Probe as never, {}))
    assert.deepEqual(seen?.overrides, {}, 'no overrides stored yet')
    assert.equal(typeof seen?.revision, 'number')
    write?.({ k: { vendor: 'zai', model: 'glm-5.2' } })
    assert.deepEqual(scope.sets, [{ field: 'priceMap', value: { k: { vendor: 'zai', model: 'glm-5.2' } } }])
    await m.unmount()
    ctx.dispose()
  })

  test('the component renders the card DOM (loading status → disabled selects)', async () => {
    const { ctx, component } = setup()
    const el = component({}) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'SettingsCard')
    const store = (ctx.slots.of('settings.plugin.item')[0].registration.inject?.() as {
      hooks: { contextSettings: { getSnapshot(): SettingsState } }
    }).hooks.contextSettings
    const m = await mount(h(el.type as never, {
      useContextSettings: <T,>(sel: (state: SettingsState) => T): T => sel(store.getSnapshot()),
    }))
    assert.ok(query(m.container, '.lc-settings-card'))
    await click(query(m.container, '.lc-settings-head'))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.equal(selects.length, 9)
    for (const s of selects) assert.ok((s as HTMLButtonElement).disabled)
    await m.unmount()
    ctx.dispose()
  })
})

describe('client entry: placement gating', () => {
  /** The sidebar registry stand-in counting registrations and disposer calls. */
  function registry(): { definitions: unknown[]; disposed: number; register(d: unknown): () => void } {
    const rec = {
      definitions: [] as unknown[],
      disposed: 0,
      register(d: unknown): () => void {
        rec.definitions.push(d)
        return () => { rec.disposed += 1 }
      },
    }
    return rec
  }

  test('a registry that hands back no disposer unwinds the tab mount without a throw', () => {
    const ctx = new TestClientCtx()
    // A foreign/hostile registry: the registration contract's disposer is absent, so the mount's own
    // disposer must skip it rather than call a non-function on the placement flip.
    ;(ctx.slots as unknown as { register: () => unknown }).register = () => undefined
    applyTo(ctx)
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
  })

  test("the persisted 'sidebar' placement skips the conversation tab and keeps the sidebar", () => {
    const scope = scopeWith({ status: 'ready', value: { defaultPlacement: 'sidebar' }, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.deepEqual(ctx.slots.of('conversation.view'), [], 'the dropped tabs never registered')
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(tabs.definitions.length, 1, 'the kept sidebar still registers')
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    ctx.dispose()
    assert.equal(tabs.disposed, 1)
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })

  test('a preference flip moves the registrations live; disposal unwinds everything', () => {
    const scope = scopeWith({ status: 'ready', value: {}, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(ctx.slots.of('conversation.view').length, 2, "the default 'all' carries both tabs")

    scope.emit({ status: 'ready', value: { defaultPlacement: 'tab' }, writable: true })
    assert.equal(tabs.disposed, 1, 'the sidebar registration unwound')
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab.title'), [])
    assert.equal(ctx.slots.of('conversation.view').length, 2)

    scope.emit({ status: 'ready', value: { defaultPlacement: 'all' }, writable: true })
    assert.equal(tabs.definitions.length, 2, 'the sidebar re-registered')
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    assert.equal(ctx.slots.of('conversation.view').length, 2, 'the kept tabs are never churned')
    ctx.dispose()
    assert.equal(tabs.disposed, 2)
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })
})

describe('client entry: second-mount guard', () => {
  test('a ledger already seating the jump marker skips the whole apply', () => {
    const sources: unknown[] = []
    const ctx = new TestClientCtx({ services: { inputTriggers: { registerSource: (src: unknown) => {
      sources.push(src)
      return () => {
        const i = sources.indexOf(src)
        if (i >= 0) sources.splice(i, 1)
      }
    } } } })
    applyTo(ctx)
    const first = ctx.slots.of('conversation.view').length
    assert.ok(first > 0, 'the first mount registers')
    assert.equal(sources.length, 1, 'the first mount registers the /context source')
    // The second mount of the same bundle — the static profile bundle plus a dynamic-runner run in one page.
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view').length, first, 'no second tab is seated')
    assert.equal(ctx.slots.of('conversation.chat.assistant-actions').length, 1)
    assert.equal(ctx.slots.of('conversation.input.overlay').length, 1)
    assert.equal(ctx.slots.of('main').length, 1)
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)
    assert.equal(sources.length, 1, 'no second /context source')
    ctx.dispose()
  })

  test('a ledger seating foreign entries only fails open into a full mount', () => {
    const ctx = new TestClientCtx()
    ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'feedback' }, () => null)
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view').length, 2, 'the tabs register')
    assert.equal(ctx.slots.of('conversation.chat.assistant-actions').length, 2, 'the jump registers beside the foreign row')
    ctx.dispose()
  })

  test('a hostile ledger face fails open into a full mount', () => {
    const ctx = new TestClientCtx()
    ;(ctx.slots as unknown as { entries: () => never }).entries = () => {
      throw new Error('boom')
    }
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view').length, 2)
    ctx.dispose()
  })
})

describe('client entry: dispose', () => {
  test('a full apply unwinds dictionaries and the command source', () => {
    const sources: unknown[] = []
    const inputTriggers = {
      registerSource(src: unknown): () => void {
        sources.push(src)
        return () => {
          const i = sources.indexOf(src)
          if (i >= 0) sources.splice(i, 1)
        }
      },
    }
    const ctx = new TestClientCtx({ services: { inputTriggers } })
    applyTo(ctx)
    assert.ok(ctx.locale.namespaces.has('@our/context-panel-write'))
    assert.equal(sources.length, 1)
    ctx.dispose()
    assert.equal(ctx.locale.namespaces.has('@our/context-panel-write'), false)
    assert.equal(sources.length, 0)
  })
})
