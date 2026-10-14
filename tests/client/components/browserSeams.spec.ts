// The context-management panel's seams into the Context browser (PATCHES.md #5, #7-#13):
// a caller supplies the system category's rows, keeps the delivered prompt beneath
// them, and marks the rows a pending prune covers. These are OUR insert points, so
// this file is ours — upstream's own browser specs never exercise them.

import { createElement as h, Fragment } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextHeaders } from '../../../src/shared/types'
import { click, flush, mount, query, queryAll, surfaceNode, text } from '../helpers/kit'
import {
  Browser, catRow, elemRows, pickStep, props, req, tl, withEpochContent,
} from './browserHarness'

const HEADERS: ContextHeaders = {
  headers: [
    { seq: 15, time: 1500, systemTokens: 8, tools: [{ name: 'old', tokens: 1 }] },
    { seq: 35, time: 3500, systemTokens: 12, tools: [{ name: 'fresh', tokens: 9 }] },
  ],
}
const CONTENTS = {
  15: { system: 'SYS A', tools: [{ name: 'old', schema: {} }] },
  35: { system: 'SYS B\nsecond line', tools: [{ name: 'fresh', description: 'fresh tool', schema: {} }] },
}
const lazy = withEpochContent(HEADERS, CONTENTS)

describe('ContextBrowser caller seams', () => {
  test('a caller-supplied systemRows list replaces the built-in prompt row', async () => {
    // The context-management panel passes systemRows (its split section list)
    // and keeps the delivered prompt as one row below it. The callback gets the
    // browser's own row/section/toolbar builders, so the caller rows are the
    // real thing — this drives all three plus the delivered row.
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const pins: Array<number | null> = []
    const m = await mount(h(Browser, props({
      data,
      ...lazy,
      systemCount: 2,
      systemDeliveredLabel: 'Sent prompt',
      systemRows: (row, body, toolbar, pinnedSeq) => {
        pins.push(pinnedSeq)
        return h(Fragment, null,
          toolbar('', () => {}),
          row('sec:alpha', null, 'alpha', 3, undefined, body('alpha', 'Alpha body\ntext')),
        )
      },
    })))
    assert.ok(text(catRow(m, 'system')).includes('2 Items'), 'the count rides systemCount')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pins[0], null, 'the live surface pins null')
    // Rows fold shut like every other element row: expand the caller's row.
    await click(elemRows(m)[0])
    const bodyEl = query(m.container, '.lc-br-body')
    assert.ok(text(bodyEl).includes('alpha'), 'the caller row renders through the browser row builder')
    // SectionBody is the caller's section chrome — its line-count memo rides the head.
    assert.ok(text(bodyEl).includes('2 lines'), 'the caller section body renders (line-count chrome)')
    assert.ok(text(bodyEl).includes('Sent prompt'), 'the delivered prompt row keeps its caller label')
    // The delivered row folds too — expand it, then its TextSection carries the epoch.
    await click(elemRows(m).find(r => text(r).includes('Sent prompt')) as HTMLElement)
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'), 'the delivered row carries the epoch content')
    await m.unmount()

    // Past step + no caller label: the pinned seq reaches the callback, the
    // delivered row falls back to the category label, and rows the caller
    // flags as pruned carry the tinted frame.
    const dataPast = tl({
      current: { system: 30, tools: 9, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 49 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 1, text: 'pinned question' })],
    })
    const pins2: Array<number | null> = []
    const m2 = await mount(h(Browser, props({
      data: dataPast,
      ...lazy,
      systemRows: (row, body, toolbar, pinnedSeq) => {
        pins2.push(pinnedSeq)
        return h(Fragment, null,
          toolbar('', () => {}),
          row('sec:beta', null, 'beta', 3, undefined, body('beta', 'Beta body')),
        )
      },
      messageRowMarked: () => true,
    })))
    await pickStep(m2, '20')
    await click(catRow(m2, 'system'))
    await flush()
    assert.equal(pins2[0], 20, 'a past step pins its seq')
    // No systemDeliveredLabel: the delivered row falls back to the category label.
    assert.ok(text(query(m2.container, '.lc-br-body')).includes('System Prompt'), 'the delivered row falls back to the category label')
    await click(elemRows(m2).find(r => text(r).includes('System Prompt')) as HTMLElement)
    assert.ok(text(query(m2.container, '.lc-br-body')).includes('SYS A'), 'the fallback delivered row carries the epoch in force')
    await click(catRow(m2, 'user'))
    assert.ok(queryAll(m2.container, '.lc-br-elem-pruned').length >= 1, "the caller's prune mark tints flagged rows")
    await m2.unmount()

    // An epoch without system content leaves the delivered row out entirely.
    const headersNoSys: ContextHeaders = { headers: [{ seq: 1, time: 1, tools: [{ name: 'x', tokens: 1 }] }] }
    const m3 = await mount(h(Browser, props({
      data,
      ...withEpochContent(headersNoSys, { 1: { tools: [] } }),
      systemRows: (_row, _body, toolbar) => toolbar('', () => {}),
    })))
    await click(catRow(m3, 'system'))
    await flush()
    assert.equal(queryAll(m3.container, '.lc-br-elem-row').length, 0, 'no delivered row without system content')
    await m3.unmount()
  })

  test('a caller supplies a category body rows and a tool row action slot', async () => {
    // PATCHES.md #12 and #13: the caller's rows ride the category body's TOP and are
    // built with the browser's own row builder (so they carry the same frame, chips
    // and expansion), and a tool row carries the caller's action slot.
    const data = tl({ current: { system: 0, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 9 } })
    const m = await mount(h(Browser, props({
      data,
      ...withEpochContent(
        { headers: [{ seq: 1, time: 1, tools: [{ name: 'alpha', tokens: 4 }] }] },
        { 1: { tools: [{ name: 'alpha', description: 'a tool', schema: {} }] } },
      ),
      // No surface nodes of its own, so the category stays shut without this.
      categoryHasRows: c => c === 'inject',
      categoryRows: (c, row) => c === 'inject'
        ? row('ctx:one', null, 'runtime context', 2, undefined, 'body', true, 'trail')
        : null,
      toolRowActions: name => h('span', { className: 'seam-tool-action' }, 'act-' + name),
    })))
    // The caller's rows make an otherwise empty category openable.
    await click(catRow(m, 'inject'))
    await flush()
    const rows = elemRows(m)
    assert.equal(rows.length, 1, 'the caller row renders')
    assert.ok(text(rows[0]).includes('runtime context'))
    assert.ok(queryAll(m.container, '.lc-br-elem-err-dot').length >= 0, 'the err flag is accepted')
    await click(catRow(m, 'tools'))
    await flush()
    assert.ok(text(m.container).includes('act-alpha'), 'the tool row carries the caller action')
    await m.unmount()
  })

  test('caller system rows without a prompt in force, and a caller row without err or trailing', async () => {
    // Two defensive arms of the same seam: with systemRows supplied but NO prompt
    // in force the delivered row is simply absent, and a caller row may omit the
    // optional err/trailing arguments (the builder fills the defaults).
    const data = tl({ current: { system: 0, tools: 0, user: 0, inject: 5, skill: 0, assistant: 0, tool: 0, total: 5 } })
    const m = await mount(h(Browser, props({
      data,
      headers: null,
      systemRows: (_row, _body, toolbar) => toolbar('', () => {}),
      categoryHasRows: c => c === 'inject',
      categoryRows: (c, row) => c === 'inject' ? row('ctx:bare', null, 'bare row', 1, undefined, 'b') : null,
    })))
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(queryAll(m.container, '.lc-br-elem-row').length, 0, 'no delivered row without a prompt')
    await click(catRow(m, 'inject'))
    await flush()
    assert.equal(elemRows(m).length, 1, 'the caller row renders without err/trailing')
    await m.unmount()
  })
})
