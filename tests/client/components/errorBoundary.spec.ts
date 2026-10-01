// ErrorBoundary (src/client/components/errorBoundary.tsx): real subtree
// errors degrade to the styled error card; Retry resets the boundary.
// React logs caught errors to console and replays the failed render through a
// fake DOM event — silenced with a window-error preventer and a spy, never
// mocked.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { culpritOf, describeCrash, makeErrorBoundary } from '../../../src/client/components/errorBoundary'
import { click, makeKit, mount, query, silenceWindowErrors, text } from '../helpers/kit'

const kit = makeKit()
const ErrorBoundary = makeErrorBoundary(kit.t)

let consoleSpy: ReturnType<typeof vi.spyOn> | null = null
let silenceErrors: (() => void) | null = null

afterEach(() => {
  consoleSpy?.mockRestore()
  consoleSpy = null
  silenceErrors?.()
  silenceErrors = null
})

function silenceRenderErrors(): void {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  silenceErrors = silenceWindowErrors()
}

describe('ErrorBoundary', () => {
  test('passes children through when nothing throws', async () => {
    const m = await mount(h(ErrorBoundary, {}, h('div', { className: 'healthy' }, 'all good')))
    assert.equal(text(m.container), 'all good')
    await m.unmount()
  })

  test('a render error degrades to the error card; Retry resumes a healthy child', async () => {
    silenceRenderErrors()
    let shouldThrow = true
    function Bomb() {
      if (shouldThrow) throw new Error('kaboom')
      return h('div', { className: 'healthy' }, 'recovered')
    }
    const m = await mount(h(ErrorBoundary, {}, h(Bomb, {})))
    const card = query(m.container, '.lc-error')
    assert.ok(text(card).includes('Failed to read context data:'))
    assert.equal(query(card, '.lc-error-msg').textContent, 'kaboom')
    const retry = query(card, '.lc-error-retry')
    assert.equal(retry.textContent, 'Retry')
    shouldThrow = false
    await click(retry)
    assert.equal(text(m.container), 'recovered')
    await m.unmount()
  })

  test('a non-Error throw is stringified into the card', async () => {
    silenceRenderErrors()
    function Bomb(): never {
      throw 'string failure' // deliberate non-Error throw
    }
    const m = await mount(h(ErrorBoundary, {}, h(Bomb, {})))
    assert.equal(query(m.container, '.lc-error-msg').textContent, 'string failure')
    await m.unmount()
  })

  test('the card names the component that threw, so a report is diagnosable', async () => {
    silenceRenderErrors()
    function Culprit(): never {
      throw new Error('reading length of undefined')
    }
    const m = await mount(h(ErrorBoundary, {}, h(Culprit, {})))
    const where = query(m.container, '.lc-error-where').textContent ?? ''
    // The report LEADS with the culprit frame; the full component stack follows
    // it (which is where the boundary's own frames appear).
    assert.ok(where.split('\n')[0].includes('Culprit'), 'the culprit frame leads: ' + where)
    assert.ok(where.includes('ErrorBoundary'), 'the full component stack follows')
    await m.unmount()
  })

  test('describeCrash leads with the culprit and carries both stacks', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at Thing (a.tsx:1:1)'
    const report = describeCrash(err, '\n    at Culprit (b.tsx:2:2)\n    at ErrorBoundary (c.tsx:3:3)\n').split('\n')
    assert.equal(report[0], 'at Culprit (b.tsx:2:2)', 'the culprit leads')
    assert.ok(report.includes('    at Thing (a.tsx:1:1)'), 'the runtime stack is carried')
    // Degenerate inputs still produce the message rather than an empty card.
    assert.equal(describeCrash('plain', undefined), 'plain\n\nplain')
    const noStack = new Error('bare')
    noStack.stack = undefined
    assert.equal(describeCrash(noStack, ''), 'bare\n\nbare')
  })

  test('culpritOf skips the boundary frame and tolerates a missing stack', () => {
    assert.equal(culpritOf(undefined), '')
    assert.equal(culpritOf(null), '')
    assert.equal(culpritOf(''), '')
    assert.equal(culpritOf('   \n  '), '')
    assert.equal(
      culpritOf('\n    at ErrorBoundary (a.tsx:1:1)\n    at PriceMapTable (b.tsx:9:9)\n'),
      'at PriceMapTable (b.tsx:9:9)',
    )
  })
})
