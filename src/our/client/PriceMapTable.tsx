/**
 * The "Model price mapping" block of the plugin settings card.
 *
 * One row per (local route, local model) pair the fold has actually billed,
 * showing where it prices from and the three figures worth watching: the rate,
 * the volume it has consumed (with the cache-hit share), and what it has cost.
 *
 * The two pickers are autocompleting text fields over the registry's own
 * catalogue — `<input list>` + `<datalist>`, the platform's combobox, with no
 * local open/filter state and no harness primitive. Only a KNOWN id commits;
 * free text reverts, so a cell can never name a vendor or model the price book
 * cannot answer.
 *
 * Editing a row is what takes it out of the mechanical pass; the ABSENCE of a
 * stored override is what leaves it in. There is no separate edited flag.
 * @module @our/context-panel-write/our/client/PriceMapTable
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { rowsOfSnapshot, usageTotalsOf } from '../../client/overview'
import { formatCost, type CostCurrency } from '../../client/cost'
import { cacheHitPercent } from '../../client/format'
import type { Translate } from '../../client/i18n'
import { rowKey, type PriceMapOverrides } from './priceMap'
import {
  modelChoices,
  noteObservedPairs,
  priceMapRows,
  vendorChoices,
  type ObservedPair,
  type PriceMapRow,
} from './priceBook'

/** One pair's consumed volume, in tokens. */
interface PairTokens {
  input: number
  output: number
  cache: number
  total: number
}

/** What the block needs from the card that hosts it. */
export interface PriceMapTableProps {
  /** The locale translator. */
  t: Translate
  /** The sessions seat (the standard prop the overview card also takes). */
  useSessions?: unknown
  /** The persisted overrides, and the write that replaces them wholesale. */
  overrides?: PriceMapOverrides
  onWrite?: (next: PriceMapOverrides) => void
  /** Display currency for the spend column. */
  currencyOf?: () => CostCurrency
  /** The store's revision: a new book changes rates and dropdown options. */
  revision?: number
}

/**
 * Fold the billed pairs and their volume off the session list. A row billing
 * several pairs credits each of them with the row's totals, which is the honest
 * reading of a figure the bill does not split.
 */
function observedOf(snapshot: unknown): { pairs: ObservedPair[]; tokens: Map<string, PairTokens> } {
  const pairs: ObservedPair[] = []
  const tokens = new Map<string, PairTokens>()
  const rows = rowsOfSnapshot(snapshot)
  if (rows === null) return { pairs, tokens }
  const seen = new Set<string>()
  for (const row of rows) {
    const cost = row.timeline?.cost
    if (cost === undefined) continue
    const totals = usageTotalsOf(cost)
    for (const provider of Object.keys(cost)) {
      const models = cost[provider]
      for (const model of Object.keys(models)) {
        const key = rowKey(provider, model)
        if (!seen.has(key)) {
          seen.add(key)
          pairs.push({ provider, model })
        }
        if (totals === null) continue
        const current = tokens.get(key) ?? { input: 0, output: 0, cache: 0, total: 0 }
        current.input += totals.input
        current.output += totals.output
        current.cache += totals.cacheRead + totals.cacheWrite
        current.total += totals.total
        tokens.set(key, current)
      }
    }
  }
  pairs.sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model))
  return { pairs, tokens }
}

/**
 * Tokens in millions. Above one the decimals say nothing, so the figure rounds
 * to a whole number; at or below one they carry the signal, so one decimal stays.
 * @param n - the token count.
 * @returns the millions figure.
 */
function millions(n: number): string {
  const m = n / 1e6
  return m >= 1 ? String(Math.round(m)) : m.toFixed(1)
}

/**
 * One picker cell: a text field that autocompletes over the given option ids.
 *
 * The field is keyed on its committed value: an external change (a vendor pick
 * rewriting the model) remounts it, so there is no draft state to sync and no
 * effect to keep in step.
 */
function Combo(props: {
  value: string
  options: readonly string[]
  listId: string
  placeholder: string
  label: string
  onPick: (id: string) => void
}): ReactElement {
  const commit = (input: HTMLInputElement): void => {
    const next = input.value.trim()
    if (next === props.value) return
    if (!props.options.includes(next)) {
      input.value = props.value
      return
    }
    props.onPick(next)
  }
  return (
    <>
      <input
        key={props.value}
        className={'lc-pricemap-pick' + (props.value === '' ? ' lc-pricemap-pick-empty' : '')}
        list={props.listId}
        defaultValue={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        onBlur={(event) => { commit(event.target) }}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(event.currentTarget) }}
      />
      <datalist id={props.listId}>
        {props.options.map(id => <option key={id} value={id} />)}
      </datalist>
    </>
  )
}

/** One body row. A component of its own so the table's map stays readable. */
function PriceMapRowCells(props: {
  row: PriceMapRow
  t: Translate
  vendors: ReadonlyArray<{ id: string; name: string }>
  chosenVendor: string
  usage: PairTokens | undefined
  currency: CostCurrency
  onPickVendor: (vendor: string) => void
  onPickModel: (target: string) => void
  onClear: () => void
}): ReactElement {
  const { row, t, currency } = props
  const targetOptions = props.chosenVendor === '' ? [] : modelChoices(props.chosenVendor)
  const vendorIds = props.vendors.map(vendor => vendor.id)
  // A datalist id must be unique per field, or the browser binds one list to both
  // cells and the model field suggests vendors.
  const listPrefix = 'lc-pricemap-list-' + rowKey(row.provider, row.model).replace(/[^A-Za-z0-9_-]/g, '_')
  const rate = row.rate
  // Input, output, cache-read. The cache-WRITE rate is deliberately absent: few
  // listings carry one and it is not what this figure is read for.
  const rateCell = rate === undefined
    ? '—'
    : [rate.miss, rate.out, rate.hit].map(n => formatCost(n, currency)).join(' / ')
  const usage = props.usage
  // Total, cache-hit share, input, output — the hit share is a percentage, so it
  // is the one figure here that keeps a decimal.
  const hit = usage === undefined
    ? null
    : cacheHitPercent(usage.cache, usage.input + usage.cache, 1)
  const tokensCell = usage === undefined
    ? '—'
    : t('settings.priceMapTokenCell', {
      total: millions(usage.total),
      // Carries its own sign: a bare figure here reads as another token count.
      cache: hit === null ? '—' : `${hit}%`,
      input: millions(usage.input),
      output: millions(usage.output),
    })
  // Total spend, then the cache portion alone: what the cache reads and writes
  // cost. The remaining (uncached input + output) is the difference, so it is not
  // listed separately.
  const spendCell = (): string => {
    if (rate === undefined || usage === undefined) return '—'
    const cache = (usage.cache * rate.hit) / 1e6
    const total = (usage.input * rate.miss + usage.cache * rate.hit + usage.output * rate.out) / 1e6
    return t('settings.priceMapSpendCell', {
      total: formatCost(total, currency),
      cache: formatCost(cache, currency),
    })
  }
  return (
    <tr className={row.edited ? 'lc-pricemap-edited' : undefined}>
      <td className="lc-pricemap-mono" data-label={t('settings.priceMapRoute')}>{row.provider}</td>
      <td className="lc-pricemap-mono" data-label={t('settings.priceMapModel')}>{row.model}</td>
      <td data-label={t('settings.priceMapVendor')}>
        <Combo
          value={props.chosenVendor}
          options={vendorIds}
          listId={listPrefix + '-vendor'}
          placeholder={t('settings.priceMapPick')}
          label={t('settings.priceMapVendor')}
          onPick={props.onPickVendor}
        />
      </td>
      <td data-label={t('settings.priceMapTarget')}>
        <Combo
          value={row.target?.model ?? ''}
          options={targetOptions}
          listId={listPrefix + '-model'}
          placeholder={t('settings.priceMapPick')}
          label={t('settings.priceMapTarget')}
          onPick={props.onPickModel}
        />
      </td>
      {/* The row's own action, right after the mapping it undoes: an automatic
          row has nothing to revert, so it shows nothing. */}
      <td className="lc-pricemap-act">
        {row.edited
          ? (
            <button
              type="button"
              className="lc-pricemap-clear"
              title={t('settings.priceMapClear')}
              aria-label={t('settings.priceMapClear')}
              onClick={props.onClear}
            >↺</button>
          )
          : null}
      </td>
      <td className="lc-pricemap-nums" data-label={t('settings.priceMapRate')}>{rateCell}</td>
      <td className="lc-pricemap-nums" data-label={t('settings.priceMapTokens')}>{tokensCell}</td>
      <td className="lc-pricemap-nums" data-label={t('settings.priceMapSpend')}>{spendCell()}</td>
    </tr>
  )
}

/** The block. */
export function PriceMapTable(props: PriceMapTableProps): ReactElement {
  const { t } = props
  const currency: CostCurrency = props.currencyOf?.() ?? 'usd'
  // The sessions seat is a REAL HOOK, so it is called here at the top level,
  // unconditionally — never inside a memo factory. That is the contract the
  // overview card's `sessionsSnapshotOf` documents: the seat yields the raw
  // snapshot and only the DERIVATION rides useMemo. Calling it inside a factory
  // is a Rules-of-Hooks violation, and the harness's hook dispatch fails on it.
  const seat = props.useSessions
  let snapshot: unknown = null
  if (typeof seat === 'function') {
    try {
      snapshot = (seat as <T>(selector: (value: unknown) => T) => T)(value => value)
    } catch {
      snapshot = null
    }
  }
  // The pair list is derived on its OWN, off the snapshot only. Folding it in
  // with the override-keyed rows would hand it a new identity whenever the caller
  // rebuilt an equal overrides object, and the effect below feeds the pairs into
  // the store — that identity churn once grew into an unbounded render loop.
  const { pairs, tokens } = useMemo(() => observedOf(snapshot), [snapshot])
  // The runtime synthesizes from the same pair list this table renders, so the
  // estimate and the table can never disagree about what is billed.
  useEffect(() => { noteObservedPairs(pairs) }, [pairs])
  // The rows picked in THIS view, by row key. Local first, and this is
  // load-bearing: the stored map arrives through a round-trip (optimistic echo,
  // fenced scope write, republish), and nothing the user sees may wait on it —
  // not the model list, not the resolved rate. The store write stays as the
  // persistence side-channel; the view renders from here.
  const [picked, setPicked] = useState<Record<string, { vendor: string; model: string }>>({})
  const overrides = useMemo(
    () => ({ ...(props.overrides ?? {}), ...picked }),
    [props.overrides, picked],
  )
  const rows = useMemo(
    () => priceMapRows(pairs, overrides),
    // A new book changes rates and options without changing the pair list, so
    // the store's revision is part of the derivation.
    [pairs, overrides, props.revision],
  )
  const vendors = useMemo(() => vendorChoices(), [props.revision])

  return (
    <div className="lc-pricemap">
      <p className="lc-settings-note">{t('settings.priceMapHint', { n: rows.length })}</p>
      {vendors.length === 0
        ? <p className="lc-settings-note" role="status">{t('settings.priceMapNoVendors')}</p>
        : null}
      {rows.length === 0
        ? <p className="lc-settings-note" role="status">{t('settings.priceMapEmpty')}</p>
        : (
          <div className="lc-pricemap-wrap">
            <table className="lc-pricemap-table">
              <thead>
                <tr>
                  <th>{t('settings.priceMapRoute')}</th>
                  <th>{t('settings.priceMapModel')}</th>
                  <th>{t('settings.priceMapVendor')}</th>
                  <th>{t('settings.priceMapTarget')}</th>
                  <th />
                  <th>{t('settings.priceMapRate')}</th>
                  <th>{t('settings.priceMapTokens')}</th>
                  <th>{t('settings.priceMapSpend')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = rowKey(row.provider, row.model)
                  const stored: { vendor: string; model: string } | undefined = Object.hasOwn(overrides, key) ? overrides[key] : undefined
                  const chosenVendor = stored?.vendor ?? row.target?.vendor ?? ''
                  return (
                    <PriceMapRowCells
                      key={key}
                      row={row}
                      t={t}
                      vendors={vendors}
                      chosenVendor={chosenVendor}
                      usage={tokens.get(key)}
                      currency={currency}
                      onPickVendor={(vendor) => {
                        // The vendor is stored even when its model list is empty,
                        // so the pick is never silently dropped and the model field
                        // can offer that vendor's models straight away.
                        const choice = { vendor, model: modelChoices(vendor)[0] ?? '' }
                        setPicked(current => ({ ...current, [key]: choice }))
                        const next = { ...overrides }
                        next[key] = choice
                        props.onWrite?.(next)
                      }}
                      onPickModel={(target) => {
                        const choice = { vendor: chosenVendor, model: target }
                        setPicked(current => ({ ...current, [key]: choice }))
                        const next = { ...overrides }
                        next[key] = choice
                        props.onWrite?.(next)
                      }}
                      onClear={() => {
                        setPicked((current) => {
                          const { [key]: _droppedLocal, ...restLocal } = current
                          return restLocal
                        })
                        const { [key]: _dropped, ...rest } = overrides
                        props.onWrite?.(rest)
                      }}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
