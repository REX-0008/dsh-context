/**
 * The model ids this browser has seen in folded session cost, for the price
 * table's gap report.
 *
 * Why the session list and not a configured catalog: the settings card is a
 * ROOT-scope panel with no session of its own, and the list snapshot is the one
 * model-carrying source it can reach. It reports what has actually been BILLED,
 * which is exactly what a gap matters for — a model nobody used needs no price.
 *
 * The snapshot is untrusted wire data, so every field is re-proved here: a
 * malformed row contributes nothing rather than throwing in a settings panel.
 * @module @our/context-panel-write/client/seenModels
 */

/** One session row, as far as this module reads it. */
interface SnapshotLike {
  sessions?: unknown
}

/** One session row's model-carrying facts, as far as they can be proved. */
function ownersOf(row: unknown): string[] {
  if (row === null || typeof row !== 'object') return []
  const cost = (row as { timeline?: { cost?: unknown } }).timeline?.cost
  if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) return []
  const out: string[] = []
  for (const provider of Object.keys(cost)) {
    const models = (cost as Record<string, unknown>)[provider]
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    for (const model of Object.keys(models)) out.push(model)
  }
  return out
}

/**
 * Every distinct model id in the session snapshot, in first-seen order.
 * @param snapshot - the session-list snapshot, of unknown shape.
 * @returns the model ids; empty when the snapshot is missing or malformed.
 */
export function seenModelsOf(snapshot: unknown): string[] {
  const sessions = (snapshot as SnapshotLike | null)?.sessions
  if (!Array.isArray(sessions)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of sessions) {
    for (const model of ownersOf(row)) {
      if (model === '' || seen.has(model)) continue
      seen.add(model)
      out.push(model)
    }
  }
  return out
}
