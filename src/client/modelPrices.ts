/**
 * The client's model-price book: the hand-maintained table
 * (client/priceTable.ts) delivered in the book shape the pricing call sites
 * thread through. The book itself is no longer read — cost.ts prices from
 * the table directly — so there is no fetch, no store, and no failure state:
 * `failed` stays false and the snapshot is identity-stable for the whole page.
 */

import { tableRows } from './priceTable'
import type { ModelBook, ModelPrices } from './cost'

/** The table's rows under one neutral branch — the book shape, table-sourced. */
const TABLE_PRICES: ModelPrices = { table: Object.fromEntries(tableRows().map(({ key, row }) => [key, row])) }

const TABLE_BOOK: ModelBook = { prices: TABLE_PRICES }

/** The store's observable snapshot, identity-stable. */
export interface ModelPricesSnap {
  /** The delivered book (see cost.ts — the pricing functions ignore it). */
  book: ModelBook
  /** Always false: the table is local, it cannot fail to load. */
  failed: boolean
}

const SNAP: ModelPricesSnap = { book: TABLE_BOOK, failed: false }

/** The stats board's read of the price book. */
export function useModelPrices(): ModelPricesSnap {
  return SNAP
}
