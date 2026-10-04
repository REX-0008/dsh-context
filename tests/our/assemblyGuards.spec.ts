// The hot-path guards in src/our/assembler/engine.ts.
//
// Both listeners run on EVERY request (system-prompt/assemble and agent/pre-step).
// An unguarded throw in either would fail the request itself — a whole conversation
// losing its prompt because a section override misbehaved. These tests pin the
// posture: our layer may fail to apply, but it may never fail the request.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ContextAssemblerEngine } from '../../src/our/assembler/engine'

type Listener = (...args: unknown[]) => unknown

/** A minimal agent whose context records the listeners the engine registers. */
function makeAgent(id: string): {
  agent: never
  listeners: Map<string, Listener>
  disposed: string[]
} {
  const listeners = new Map<string, Listener>()
  const disposed: string[] = []
  const on = (name: string, listener: Listener): (() => void) => {
    listeners.set(name, listener)
    return () => { disposed.push(name) }
  }
  const ctx = { on, systemPrompt: { section: () => () => {}, context: () => () => {} } }
  return { agent: { id, ctx } as never, listeners, disposed }
}

/** A config reader that throws, standing in for any failure inside our layer. */
const throwingReader = (): never => { throw new Error('config is broken') }

describe('the assemble waterfall', () => {
  test('a throwing config leaves the assembly UNTOUCHED instead of failing it', async () => {
    const engine = new ContextAssemblerEngine()
    engine.setConfigReader(throwingReader)
    const { agent, listeners } = makeAgent('s1')
    engine.registerForAgent(agent)
    const listener = listeners.get('system-prompt/assemble')
    assert.ok(listener !== undefined, 'the engine registered the assemble listener')
    const assembly = { sections: [{ name: 'a', text: 'keep me' }], contexts: [] }
    const result = await listener!(assembly, {}, async () => assembly)
    assert.deepEqual(result, assembly, 'the untouched assembly is returned')
  })

  test('with a working config the rewrite DOES apply (the guard is not a no-op)', async () => {
    const engine = new ContextAssemblerEngine()
    engine.setConfigReader(() => ({
      panelWidth: 720,
      modules: {},
      toolRestrictions: {},
      presetDisabledSections: {},
      presetDisabledContexts: {},
      suppressedInjections: {},
      contextOverrides: {},
      sectionOverrides: { a: 'rewritten' },
      sectionWeights: {},
      sectionOriginals: {},
    }) as never)
    const { agent, listeners } = makeAgent('s2')
    engine.registerForAgent(agent)
    const listener = listeners.get('system-prompt/assemble')
    const assembly = { sections: [{ name: 'a', text: 'original' }], contexts: [] }
    const result = await listener!(assembly, {}, async () => assembly) as { sections: Array<{ name: string; text: string }> }
    assert.deepEqual(result.sections, [{ name: 'a', text: 'rewritten' }])
  })
})

describe('the pre-step waterfall', () => {
  test('a throwing config leaves the step decision exactly as produced', async () => {
    const engine = new ContextAssemblerEngine()
    engine.setConfigReader(throwingReader)
    const { agent, listeners } = makeAgent('s3')
    engine.registerForAgent(agent)
    const listener = listeners.get('agent/pre-step')
    assert.ok(listener !== undefined, 'the engine registered the pre-step listener')
    const decision = { kind: 'enter', messages: [{ source: { kind: 'agent-instructions' }, text: 'hi' }] }
    const result = await listener!({}, async () => decision)
    assert.deepEqual(result, decision)
  })

  test('a non-enter decision passes straight through, config never read', async () => {
    const engine = new ContextAssemblerEngine()
    engine.setConfigReader(throwingReader)
    const { agent, listeners } = makeAgent('s4')
    engine.registerForAgent(agent)
    const listener = listeners.get('agent/pre-step')
    const decision = { kind: 'skip' }
    const result = await listener!({}, async () => decision)
    assert.deepEqual(result, decision)
  })
})

describe('registration lifecycle', () => {
  test('the two listeners are installed ONCE per agent, however often it re-registers', () => {
    const engine = new ContextAssemblerEngine()
    engine.setConfigReader(() => ({ modules: {}, toolRestrictions: {} }) as never)
    const { agent, listeners, disposed } = makeAgent('s5')
    engine.registerForAgent(agent)
    engine.registerForAgent(agent)
    // Re-registration redoes the MODULE registrations, not the listeners: installing
    // a second pair would double-apply every rewrite and filter downstream.
    assert.equal(listeners.size, 2)
    assert.deepEqual(disposed, [], 'the listeners survive a re-registration')
  })

  test('dispose tears the listeners down', () => {
    const engine = new ContextAssemblerEngine()
    engine.setConfigReader(() => ({ modules: {}, toolRestrictions: {} }) as never)
    const { agent, disposed } = makeAgent('s6')
    engine.registerForAgent(agent)
    engine.dispose()
    assert.deepEqual(disposed.sort(), ['agent/pre-step', 'system-prompt/assemble'])
  })
})
