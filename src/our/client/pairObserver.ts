/**
 * Feed the pricing runtime the billed (route, model) pairs, from the ROOT scope.
 *
 * Why this does not live in a component: the pairs drive branch synthesis, and the
 * only component that used to feed them was the mapping table — which mounts on
 * the settings page. A session opened with the card closed therefore priced every
 * local route as null until someone happened to open that page, which read as "the
 * mapping only works after I visit the settings".
 *
 * The sessions service is composed at the root, so subscribing here keeps the
 * pairs current for every surface that reads a price. Nothing renders from this
 * module: it is a pure push into the store.
 * @module @our/context-panel-write/our/client/pairObserver
 */
import { noteObservedPairs, type ObservedPair } from './priceBook'

/** The outward `ctx.sessions` face, as far as this observer consumes it. */
export interface SessionsListFace {
  list: {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
  }
}

/** A record-shape guard (the service boundary re-proves everything it reads). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Narrow `ctx.get('sessions')` to the list face.
 * @param ctx - the plugin's root context.
 * @returns the face, or null on a harness without the outward sessions service.
 */
export function sessionsListOf(ctx: { get(name: string): unknown }): SessionsListFace | null {
  const rec = asRecord(ctx.get('sessions'))
  if (rec === null) return null
  const list = asRecord(rec.list)
  if (list === null || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
  return rec as unknown as SessionsListFace
}

/**
 * The billed pairs off a session-list snapshot.
 *
 * Mirrors the mapping table's own fold (one entry per session, per provider, per
 * model the bill carries): a row billing several pairs contributes each of them,
 * which is the honest reading of a figure the bill does not split.
 * @param snapshot - the raw list snapshot.
 * @returns the observed pairs, deduplicated.
 */
export function pairsOfSnapshot(snapshot: unknown): ObservedPair[] {
  const state = asRecord(snapshot)
  if (state === null) return []
  const byId = asRecord(state.byId)
  if (byId === null) return []
  const seen = new Set<string>()
  const pairs: ObservedPair[] = []
  for (const row of Object.values(byId)) {
    const values = asRecord(asRecord(row)?.projectionValues)
    const timeline = asRecord(values?.contextTimeline)
    const cost = asRecord(timeline?.cost)
    if (cost === null) continue
    for (const provider of Object.keys(cost)) {
      const models = asRecord(cost[provider])
      if (models === null) continue
      for (const model of Object.keys(models)) {
        const key = provider + '\u0000' + model
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push({ provider, model })
      }
    }
  }
  return pairs
}

/**
 * Subscribe to the sessions list and push the billed pairs into the pricing
 * runtime. Called once from the client root, so the mapping is in force before
 * any surface renders a price.
 * @param ctx - the plugin's root context.
 * @returns the disposer (a no-op when the service is absent).
 */
export function watchObservedPairs(ctx: { get(name: string): unknown }): () => void {
  const face = sessionsListOf(ctx)
  if (face === null) return () => {}
  const push = (): void => {
    try {
      noteObservedPairs(pairsOfSnapshot(face.list.getSnapshot()))
    } catch {
      // A hostile snapshot keeps the last good pair list: pricing degrades to
      // "unmapped", never to a thrown render.
    }
  }
  push()
  return face.list.subscribe(push)
}
