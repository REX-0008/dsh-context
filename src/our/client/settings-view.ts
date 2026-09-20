/**
 * Client-side pure helpers: the merged module view and local token estimates.
 * The single source of module definitions is the settings namespace; the
 * browser merges the agent level with this conversation's overlay exactly as
 * the engine does.
 * @module @our/context-panel-write/our/client/settings-view
 */
import type { ContextPanelSettings, ModuleSource } from '../types'

/** One module as the browser sees it (agent level merged with the overlay). */
export interface ClientModule {
  name: string
  channel: 'section' | 'context'
  order: number
  enabled: boolean
  text: string
  /** The overridden parent source (absent for a purely new module). */
  source?: ModuleSource
}

/** Merge agent modules with this conversation's overrides, order-sorted (mirrors the engine). */
export function mergedModules(settings: ContextPanelSettings, sessionId: string): ClientModule[] {
  const overrides = settings.conversationOverrides?.[sessionId] ?? {}
  const names = new Set<string>([...Object.keys(settings.modules ?? {}), ...Object.keys(overrides)])
  const list: ClientModule[] = []
  for (const name of names) {
    const agent = (settings.modules ?? {})[name] ?? {}
    const sess = overrides[name] ?? {}
    list.push({
      name,
      channel: sess.channel ?? agent.channel ?? 'section',
      order: sess.order ?? agent.order ?? 0,
      enabled: sess.enabled ?? agent.enabled ?? true,
      text: sess.text ?? agent.text ?? '',
      source: sess.source ?? agent.source,
    })
  }
  return list.sort((a, b) => a.order - b.order)
}

/** The same fixed-density heuristic the host uses (~4 chars per token plus role overhead). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** Compact token text (>=1000 renders as `12.2k`). */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'k'
  return String(tokens)
}
