// SettingsCard (src/client/components/settingsCard.tsx) rendered with real
// React against the real DICT_EN strings; the select rows open the REAL
// Menu primitive (portaled into document.body) and pick through it. The
// "Open in Settings" jump path mounts the card pre-expanded (settingsJump.ts
// expand request), with the scroll best-effort against stubbed prototypes.

import { createElement as h, useState, useSyncExternalStore } from 'react'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'vitest'
import { makePluginConfigCard, makeSettingsCard } from '../../../src/client/components/settingsCard'
import type { SettingsState } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { requestCardExpand } from '../../../src/client/settingsJump'
import { click, keydown, makeKit, mount, query, queryAll, text } from '../helpers/kit'
import { rowKey } from '../../../src/our/client/priceMap'
import { noteBook, priceMapStore, resetPriceBook } from '../../../src/our/client/priceBook'

const kit = makeKit()
const SettingsCard = makeSettingsCard(kit)

function hookFor(state: SettingsState) {
  return <T,>(sel: (s: SettingsState) => T): T => sel(state)
}

function stateOf(partial: Partial<SettingsState> = {}): SettingsState {
  return { status: 'ready', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', writable: true, ...partial }
}

/** Menu items portaled into document.body while a select is open. */
function menuItems(): HTMLElement[] {
  return queryAll(document.body, '[role="menu"] [role="menuitem"]')
}

type ScrollIntoViewLike = (this: Element, arg?: unknown) => void

/** Swap Element.prototype.scrollIntoView (absent in jsdom); returns the original. */
function stubScrollIntoView(impl: ScrollIntoViewLike | undefined): ScrollIntoViewLike | undefined {
  const proto = Element.prototype as unknown as { scrollIntoView?: ScrollIntoViewLike }
  const original = proto.scrollIntoView
  proto.scrollIntoView = impl
  return original
}

describe('SettingsCard', () => {
  test('renders nothing without a settings hook or when the namespace is unavailable', async () => {
    const m1 = await mount(h(SettingsCard, {}))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('loading state renders the card with disabled selects; the head toggles the body', async () => {
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ status: 'loading', writable: false })) }))
    const card = query(m.container, '.lc-settings-card')
    assert.ok(!card.className.includes('lc-settings-open'))
    const head = query(m.container, '.lc-settings-head')
    assert.equal(head.getAttribute('aria-expanded'), 'false')
    assert.equal(head.getAttribute('aria-label'), `${DICT_EN['settings.expand']}: ${DICT_EN['settings.title']}`)
    assert.ok(text(m.container).includes(DICT_EN['settings.desc']))
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 0)

    await click(head)
    assert.equal(head.getAttribute('aria-expanded'), 'true')
    assert.equal(head.getAttribute('aria-label'), `${DICT_EN['settings.collapse']}: ${DICT_EN['settings.title']}`)
    assert.ok(card.className.includes('lc-settings-open'))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.equal(selects.length, 7)
    assert.ok(selects.every(s => (s as HTMLButtonElement).disabled))
    // Loading is not ready: no read-only note.
    assert.equal(m.container.querySelector('.lc-settings-note'), null)

    await click(head)
    assert.equal(head.getAttribute('aria-expanded'), 'false')
    assert.ok(!card.className.includes('lc-settings-open'))
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 0)
    await m.unmount()
  })

  test('ready+writable: enabled selects pick through the real portaled Menu', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    await click(query(m.container, '.lc-settings-head'))
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.ok(selects.every(s => !s.disabled))
    assert.equal(m.container.querySelector('.lc-settings-note'), null)
    // The placement row leads; its label resolves through the options list.
    assert.ok(text(m.container).includes(DICT_EN['settings.placement']))
    assert.ok(text(selects[0]).includes(DICT_EN['placement.all']))
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    const placementItems = menuItems()
    assert.equal(placementItems.length, 3)
    assert.deepEqual(placementItems.map(i => text(i)), [
      DICT_EN['placement.all'],
      DICT_EN['placement.tab'],
      DICT_EN['placement.sidebar'],
    ])
    await click(placementItems[2]) // 'Sidebar'
    assert.deepEqual(calls, [['defaultPlacement', 'sidebar']])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The insights-entry row follows the placement one; its pick writes the
    // visibility field.
    assert.ok(text(m.container).includes(DICT_EN['settings.insightsEntry']))
    assert.ok(text(selects[1]).includes(DICT_EN['insightsEntry.show']))
    await click(selects[1])
    assert.equal(selects[1].getAttribute('aria-expanded'), 'true')
    const entryItems = menuItems()
    assert.deepEqual(entryItems.map(i => text(i)), [DICT_EN['insightsEntry.show'], DICT_EN['insightsEntry.hide']])
    await click(entryItems[1]) // 'Hide'
    assert.deepEqual(calls, [['defaultPlacement', 'sidebar'], ['insightsEntry', 'hide']])
    assert.equal(selects[1].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The granularity row follows.
    assert.ok(text(selects[2]).includes(DICT_EN['gran.step']))
    assert.ok(text(selects[3]).includes(DICT_EN['gran.total']))
    // The delta-baseline row leads the tool-sort one, reusing the toolbar's option labels.
    assert.ok(text(m.container).includes(DICT_EN['settings.deltaBase']))
    assert.ok(text(selects[4]).includes(DICT_EN['browser.base.step']))
    assert.ok(text(m.container).includes(DICT_EN['settings.toolSort']))
    assert.ok(text(selects[5]).includes(DICT_EN['tool.sort.count']))
    assert.ok(text(m.container).includes(DICT_EN['settings.fileSort']))
    assert.ok(text(selects[6]).includes(DICT_EN['files.sort.count']))

    await click(selects[2])
    assert.equal(selects[2].getAttribute('aria-expanded'), 'true')
    const items = menuItems()
    assert.equal(items.length, 2)
    assert.deepEqual(items.map(i => text(i)), [DICT_EN['gran.step'], DICT_EN['gran.turn']])

    await click(items[1]) // 'Turn'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['defaultGranularity', 'turn'],
    ])
    assert.equal(selects[2].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The trend-mode row writes the other field.
    await click(selects[3])
    const modeItems = menuItems()
    assert.deepEqual(modeItems.map(i => text(i)), [DICT_EN['gran.total'], DICT_EN['gran.delta']])
    await click(modeItems[1]) // 'Delta'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
    ])
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The delta-baseline row writes its field through the toolbar's vocabulary.
    await click(selects[4])
    const baseItems = menuItems()
    assert.deepEqual(baseItems.map(i => text(i)), [DICT_EN['browser.base.step'], DICT_EN['browser.base.turn']])
    await click(baseItems[1]) // 'prev turn'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDeltaBase', 'turn'],
    ])
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The tool-sort row leads the file-sort one.
    await click(selects[5])
    const toolItems = menuItems()
    assert.deepEqual(toolItems.map(i => text(i)), [
      DICT_EN['tool.sort.size'],
      DICT_EN['tool.sort.count'],
      DICT_EN['tool.sort.name'],
    ])
    await click(toolItems[2]) // 'By name'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
    ])
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The file-sort row writes the last field.
    await click(selects[6])
    const sortItems = menuItems()
    assert.deepEqual(sortItems.map(i => text(i)), [
      DICT_EN['files.sort.count'],
      DICT_EN['files.sort.latest'],
      DICT_EN['files.sort.path'],
    ])
    await click(sortItems[2]) // 'By path'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'path'],
    ])
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // Anchor toggles shut too (setOpen(v => !v) back edge).
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })

  test('Menu onClose (Escape) closes an open select without picking', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    await click(query(m.container, '.lc-settings-head'))
    const select = query(m.container, '.lc-settings-select')
    await click(select)
    assert.equal(select.getAttribute('aria-expanded'), 'true')
    assert.equal(menuItems().length, 3, 'the placement row leads with three options')
    await keydown('Escape', document.body)
    assert.equal(select.getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    assert.deepEqual(calls, [])
    await m.unmount()
  })

  test('ready+readonly: disabled selects and the read-only note when open', async () => {
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ writable: false })) }))
    // Note only renders once the body is open.
    await click(query(m.container, '.lc-settings-head'))
    const note = query(m.container, '.lc-settings-note')
    assert.equal(note.getAttribute('role'), 'status')
    assert.equal(text(note), DICT_EN['settings.readOnly'])
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-settings-select').every(s => s.disabled))
    await m.unmount()
  })

  test('a value matching no option falls back to the raw id; a missing set never throws', async () => {
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ placement: 'weird' as never })) }))
    await click(query(m.container, '.lc-settings-head'))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.ok(text(selects[0]).includes('weird'))
    // props.set undefined: picking still closes the menu, no throw.
    await click(selects[0])
    await click(menuItems()[1])
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })

  test('a fresh expand request mounts the card open, scrolled into view — once', async () => {
    const scrolled: Array<{ el: Element; arg: unknown }> = []
    const restore = stubScrollIntoView(function (this: Element, arg?: unknown) {
      scrolled.push({ el: this, arg })
    })
    try {
      requestCardExpand()
      const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf()) }))
      const card = query(m.container, '.lc-settings-card')
      assert.ok(card.className.includes('lc-settings-open'))
      assert.equal(query(m.container, '.lc-settings-head').getAttribute('aria-expanded'), 'true')
      assert.equal(queryAll(m.container, '.lc-settings-select').length, 7)
      assert.equal(scrolled.length, 1, 'the card scrolls itself into view')
      assert.deepEqual(scrolled[0].arg, { block: 'nearest' })
      assert.equal(scrolled[0].el, card)
      await m.unmount()

      // Consumed once: a later mount starts collapsed again.
      const again = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf()) }))
      assert.equal(query(again.container, '.lc-settings-head').getAttribute('aria-expanded'), 'false')
      assert.equal(scrolled.length, 1)
      await again.unmount()
    } finally {
      stubScrollIntoView(restore)
    }
  })

  test('a host whose scrollIntoView throws still mounts expanded', async () => {    const restore = stubScrollIntoView(() => { throw new Error('no scrolling here') })
    try {
      requestCardExpand()
      const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf()) }))
      assert.equal(query(m.container, '.lc-settings-head').getAttribute('aria-expanded'), 'true')
      await m.unmount()
    } finally {
      stubScrollIntoView(restore)
    }
  })

  test('a pending request is consumed even when the card renders nothing', async () => {
    requestCardExpand()
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m.container.childElementCount, 0)
    await m.unmount()

    const again = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf()) }))
    assert.equal(query(again.container, '.lc-settings-head').getAttribute('aria-expanded'), 'false')
    await again.unmount()
  })
})

describe('PluginConfigCard (the Plugins-page seat)', () => {
  const PluginConfigCard = makePluginConfigCard(kit)

  test('renders nothing without a settings hook or when the namespace is unavailable', async () => {
    const m1 = await mount(h(PluginConfigCard, {}))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('renders the seven rows flat — no card chrome, no expand request consumption', async () => {
    requestCardExpand()
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'loading', writable: false })) }))
    assert.equal(m.container.querySelector('.lc-settings-card'), null, 'no settings-section chrome')
    assert.ok(query(m.container, '.lc-settings-prefs'))
    assert.equal(m.container.querySelector('.lc-settings-head'), null)
    // The rows render immediately: no expand/collapse leg.
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.equal(selects.length, 7)
    assert.ok(selects.every(s => s.disabled), 'loading is not ready: the rows are disabled')
    assert.equal(m.container.querySelector('.lc-settings-note'), null)
    await m.unmount()
  })

  test('ready rows pick through the portaled Menu; the read-only note renders without a disclosure', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ writable: false })),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const note = query(m.container, '.lc-settings-note')
    assert.equal(text(note), DICT_EN['settings.readOnly'])
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.ok(selects.every(s => s.disabled), 'read-only: the rows are disabled')

    const writable = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    assert.equal(writable.container.querySelector('.lc-settings-note'), null)
    const enabled = queryAll<HTMLButtonElement>(writable.container, '.lc-settings-select')
    assert.ok(enabled.every(s => !s.disabled))
    await click(enabled[6])
    const items = menuItems()
    assert.deepEqual(items.map(i => text(i)), [
      DICT_EN['files.sort.count'],
      DICT_EN['files.sort.latest'],
      DICT_EN['files.sort.path'],
    ])
    await click(items[2]) // 'By path'
    assert.deepEqual(calls, [['defaultFileSort', 'path']])
    await writable.unmount()
    await m.unmount()
  })
})

describe('SettingsCard: the model-price mapping block', () => {
  // The runtime store is module state shared across cases; each one starts empty.
  beforeEach(() => { resetPriceBook() })

  /** A price-map seat with a stored override on one row. The returned face is
   *  stable, as the real one must be for the table's memos to settle. */
  function priceSeat(overrides: Record<string, { vendor: string; model: string }> = {}) {
    const face = {
      overrides,
      write: (next: Record<string, { vendor: string; model: string }>) => { priceSeat.written = next },
      revision: 0,
    }
    return () => face
  }
  priceSeat.written = undefined as Record<string, { vendor: string; model: string }> | undefined

  /**
   * A price seat modelled on the REAL one: `overrides` is a freshly built object
   * on every call. The regression this guards is a render loop — the table
   * pushed that object into the store from an effect keyed on its identity, the
   * store notified, the seat rebuilt it, and the whole settings card came down
   * with "Maximum update depth exceeded".
   */
  function churningPriceSeat(overrides: Record<string, { vendor: string; model: string }> = {}) {
    let renders = 0
    return {
      seat: () => {
        renders += 1
        // Exactly the real seat: it binds the store's observable, and it builds
        // a fresh overrides object on every call (as settings.priceMap does).
        const revision = useSyncExternalStore(
          listener => priceMapStore.subscribe(listener),
          () => priceMapStore.getSnapshot(),
        )
        return { overrides: { ...overrides }, write: () => {}, revision }
      },
      renders: () => renders,
    }
  }

  /** The sessions seat the table folds pairs from (a hook taking a selector). */
  function sessionsSeat(cost: Record<string, unknown>) {
    const snapshot = { ids: ['s1'], byId: { s1: { title: 't', updatedAt: 1, projectionValues: { contextTimeline: { cost } } } } }
    return <T,>(sel: (value: unknown) => T): T => sel(snapshot)
  }

  test('the block stays collapsed until opened, and is absent without the seat', async () => {
    priceSeat.written = undefined
    const without = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf()) }))
    assert.equal(queryAll(without.container, '.lc-settings-pricemap').length, 0, 'no seat, no block')

    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
    }))
    // The card itself starts collapsed; the block lives in its body.
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    const head = query(m.container, '.lc-settings-subhead') as HTMLElement
    assert.ok(head, 'the block renders collapsed')
    assert.equal(queryAll(m.container, '.lc-pricemap-table').length, 0, 'the table is not mounted while collapsed')
    await click(head)
    // No billed pairs arrive without the sessions seat, so the block states that
    // instead of drawing an empty table.
    assert.ok(text(m.container).includes(DICT_EN['settings.priceMapEmpty']), 'the empty note shows')
  })

  test('a billed pair renders one row with its mapping and source', async () => {
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 } } },
      }),
    }))
    // The card itself starts collapsed; the block lives in its body.
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    const cells = queryAll(m.container, '.lc-pricemap-table tbody tr td').map(td => text(td))
    assert.equal(cells[0], 'dycp')
    assert.equal(cells[1], 'glm-5.3-flash')
    // The tokens cell prints total / cache-hit% / input / output (millions;
    // whole numbers above 1, and the hit share alone keeps a decimal).
    assert.equal(cells[6], '3 / 0.0% / 2 / 1')
  })

  test('opening the block does not re-render without bound when the seat rebuilds its overrides', async () => {
    const churning = churningPriceSeat()
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: churning.seat,
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    // The table renders, and the preference rows are still on the page: a render
    // loop would have taken the whole card down instead.
    assert.ok(query(m.container, '.lc-pricemap-table'), 'the table rendered')
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 7, 'every preference row survives')
    assert.ok(churning.renders() < 20, 'the seat is not rebuilt without bound (was ' + churning.renders() + ')')
    await m.unmount()
  })

  test('a throwing table is fenced: the preference rows survive it', async () => {
    // The reported failure was the whole settings card disappearing. Whatever our
    // block does, the host card's own rows must stay on the page.
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({}),
      currencyOf: () => { throw new Error('boom') },
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    assert.equal(queryAll(m.container, '.lc-pricemap-table').length, 0, 'the broken table is not rendered')
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 7, 'every preference row survives')
    await m.unmount()
  })

  test('picking a vendor fills the model field even when the write is never echoed back', async () => {
    // The real failure: the seat's write is asynchronous (echo, scope write,
    // republish), and the model list must not wait on it.
    noteBook({
      prices: { zai: { 'glm-5.2': { hit: 1, miss: 2, write: 3, out: 4 }, 'glm-5.3': { hit: 1, miss: 2, write: 3, out: 4 } } },
      index: { byModel: new Map() },
    } as never)
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    const inputs = queryAll(m.container, '.lc-pricemap-pick') as HTMLInputElement[]
    const modelList = inputs[1].getAttribute('list') ?? ''
    assert.equal(document.querySelectorAll('#' + modelList + ' option').length, 0, 'nothing picked yet')
    inputs[0].value = 'zai'
    await keydown('Enter', inputs[0])
    assert.equal(document.querySelectorAll('#' + modelList + ' option').length, 2, 'the models appear without any echo')
    await m.unmount()
  })

  test('an unloaded catalogue says so instead of offering nothing', async () => {
    resetPriceBook()
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    assert.ok(text(m.container).includes(DICT_EN['settings.priceMapNoVendors']), 'the empty catalogue is stated')
    await m.unmount()
  })
  test('picking a vendor fills the model field with that vendor\'s models', async () => {
    // A seat that FEEDS ITS OWN WRITE BACK, as the real store does — without
    // that the model list can never follow the pick, which was the bug.
    noteBook({
      prices: { zai: { 'glm-5.2': { hit: 1, miss: 2, write: 3, out: 4 }, 'glm-5.3': { hit: 1, miss: 2, write: 3, out: 4 } } },
      index: { byModel: new Map() },
    } as never)
    const live = () => {
      const [map, setMap] = useState<Record<string, { vendor: string; model: string }>>({})
      return { overrides: map, write: (next: Record<string, { vendor: string; model: string }>) => { setMap(next) }, revision: 0 }
    }
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: live,
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    const inputs = queryAll(m.container, '.lc-pricemap-pick') as HTMLInputElement[]
    const modelList = inputs[1].getAttribute('list') ?? ''
    assert.equal(document.querySelectorAll('#' + modelList + ' option').length, 0, 'no vendor picked yet')
    inputs[0].value = 'zai'
    await keydown('Enter', inputs[0])
    assert.equal(document.querySelectorAll('#' + modelList + ' option').length, 2, 'the vendor\'s models are offered')
    await m.unmount()
  })
  test('the pickers autocomplete and only commit a known option', async () => {
    // Seed a book so the vendor list is non-empty (the seats are the module's
    // own store, which is unseeded in jsdom).
    noteBook({ prices: { zai: { 'glm-5.2': { hit: 0.1, miss: 1, write: 0, out: 2 } } }, index: { byModel: new Map() } } as never)
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    const inputs = queryAll(m.container, '.lc-pricemap-pick') as HTMLInputElement[]
    assert.equal(inputs.length, 2, 'a vendor field and a model field')
    assert.ok(inputs[0].getAttribute('list'), 'the vendor field has a datalist')
    assert.notEqual(inputs[0].getAttribute('list'), inputs[1].getAttribute('list'), 'each field has its own datalist')
    // Free text is not a commitment: it reverts to the committed value.
    inputs[0].value = 'no-such-vendor'
    await keydown('Enter', inputs[0])
    assert.equal(inputs[0].value, '', 'an unknown vendor reverts')
    // A known id commits through the seat's write.
    inputs[0].value = 'zai'
    await keydown('Enter', inputs[0])
    assert.deepEqual(priceSeat.written, { [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } })
    await m.unmount()
  })
  test('the pickers open on an unresolved row, where the model list is empty', async () => {
    // An unresolvable pair has no vendor, so the model picker has NO options at
    // all — a menu with only a label row. The primitives' keyboard walk is the
    // kind of code that assumes a selectable row exists.
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({
        dycp: { 'mystery-model': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    const picks = queryAll(m.container, '.lc-pricemap-pick') as HTMLElement[]
    assert.equal(picks.length, 2, 'a vendor and a model picker')
    // The model picker (second) has no options on an unresolved row.
    await click(picks[1])
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 7, 'the card survives')
    await m.unmount()
  })

  test('a SLIM wire head (no collections) renders without throwing', async () => {
    // What the session list actually delivers on the split generation: the head
    // carries counts/last/detailRev and NO request/event collections. Every other
    // case in this file feeds a fat row, so this shape was untested.
    const slim = {
      ids: ['s1'],
      byId: {
        s1: {
          title: 't',
          updatedAt: 1,
          projectionValues: {
            contextTimeline: {
              ok: true,
              current: { system: 1, tools: 2, user: 3, inject: 4, skill: 5, assistant: 6, tool: 7, total: 28 },
              counts: { turns: 2, steps: 5, injects: 1, compactions: 0, prunes: 0 },
              last: { seq: 9, total: 100 },
              detailRev: 3,
              cost: { dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
            },
          },
        },
      },
    }
    const seat = <T,>(sel: (value: unknown) => T): T => sel(slim)
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: seat,
    }))
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    assert.ok(query(m.container, '.lc-pricemap-table'), 'the table rendered from a slim head')
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 7, 'the card survives')
    await m.unmount()
  })

  test('an empty bill says so instead of drawing an empty table', async () => {
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat(),
      useSessions: sessionsSeat({}),
    }))
    // The card itself starts collapsed; the block lives in its body.
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    assert.equal(queryAll(m.container, '.lc-pricemap-table').length, 0)
    assert.ok(text(m.container).includes(DICT_EN['settings.priceMapEmpty']))
  })

  test('a stored override marks the row edited and offers the revert control', async () => {
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      usePriceMap: priceSeat({ [rowKey('dycp', 'glm-5.3-flash')]: { vendor: 'zai', model: 'glm-5.2' } }),
      useSessions: sessionsSeat({
        dycp: { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }),
    }))
    // The card itself starts collapsed; the block lives in its body.
    await click(query(m.container, '.lc-settings-head') as HTMLElement)
    await click(query(m.container, '.lc-settings-subhead') as HTMLElement)
    const tr = query(m.container, '.lc-pricemap-table tbody tr') as HTMLElement
    assert.equal(tr.className, 'lc-pricemap-edited')
    // No source column any more: the edited state IS the revert control's presence.
    assert.ok(query(tr, '.lc-pricemap-clear'), 'an edited row offers the revert control')
    const clear = query(tr, '.lc-pricemap-clear') as HTMLElement
    assert.ok(clear, 'the revert control is offered')
    await click(clear)
    assert.deepEqual(priceSeat.written, {}, 'reverting drops the override')
  })
})
