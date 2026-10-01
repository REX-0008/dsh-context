/**
 * The "Model price mapping" block of the plugin settings card.
 *
 * One row per (local route, local model) pair the fold has actually billed,
 * showing where it prices from and the two figures worth watching: the tokens it
 * has consumed and what they add up to.
 *
 * The two pickers are native `<select>`s: a dropdown with an option list, and
 * the browser's own type-to-search while choosing. Nothing here needs the
 * harness's menu primitive — and driving that primitive this way is what cost
 * this block a render failure whose cause the component frame could not name.
 *
 * Editing a row is what takes it out of the mechanical pass; the ABSENCE of a
 * stored override is what leaves it in. There is no separate edited flag.
 * @module @our/context-panel-write/our/client/PriceMapTable
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { rowsOfSnapshot, usageTotalsOf } from '../../client/overview'
import { formatCost, type CostCurrency, type PriceTriple } from '../../client/cost'
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

/** Tokens in millions, one decimal — the unit this panel's readers think in. */
function millions(n: number): string {
  return (n / 1e6).toFixed(1)
}

/**
 * One picker cell: a text input that autocompletes over the given option ids.
 *
 * `<input list>` + `<datalist>` is the platform's own combobox: type and the
 * browser narrows the suggestions, pick one and it lands in the field. No local
 * open/filter state, no portal, and no harness primitive — the block renders its
 * options and the browser does the rest.
 *
 * Only a KNOWN id commits; free text reverts on blur or Enter, so a cell can
 * never name a vendor or model the price book cannot answer.
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
        // Keyed on the committed value: an external change (a vendor pick
        // rewriting the model) remounts the field, so there is no draft state to
        // sync and no effect to keep in step.
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

/** The block. */
export function PriceMapTable(props: PriceMapTableProps): ReactElement {
  const { t } = props
  const currency: CostCurrency = props.currencyOf?.() ?? 'usd'
  // The sessions seat is a real hook, so it is read once at the top rather than
  // inside a memo (the same guarded-seat contract the overview card follows).
  // The sessions seat is a REAL HOOK, so it is called here at the top level,
  // unconditionally — never inside a memo factory. That is the contract the
  // overview card's `sessionsSnapshotOf` documents: the seat yields the raw
  // snapshot, and only the DERIVATION rides useMemo. Calling it inside a factory
  // is a Rules-of-Hooks violation, and the harness's hook dispatch fails on it —
  // measured as a shell-bundle frame reading `length` of undefined, surfacing as
  // this block's render error.
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
  const rows = useMemo(
    () => priceMapRows(pairs, props.overrides),
    // A new book changes rates and options without changing the pair list, so
    // the store's revision is part of the derivation.
    [pairs, props.overrides, props.revision],
  )
  const vendors = useMemo(() => vendorChoices(), [props.revision])
  // The vendors picked in THIS view, by row key. The model field's options follow
  // this first, so a pick shows that vendor's models at once — the stored map is
  // not consulted for it, because the store round-trip (echo, scope write,
  // republish) is not something the UI may depend on to become usable.
  const [picked, setPicked] = useState<Record<string, string>>({})
  const overrides = props.overrides ?? {}
  const rateOf = (rate: PriceTriple | undefined): string =>
    rate === undefined ? '—' : [rate.miss, rate.out, rate.hit, rate.write].map(n => formatCost(n, currency)).join(' / ')
  const spendOf = (rate: PriceTriple | undefined, usage: PairTokens | undefined): string => {
    if (rate === undefined || usage === undefined) return '—'
    return formatCost((usage.input * rate.miss + usage.cache * rate.hit + usage.output * rate.out) / 1e6, currency)
  }
  const tokenCell = (usage: PairTokens | undefined): string =>
    usage === undefined
      ? '—'
      : t('settings.priceMapTokenCell', {
        total: millions(usage.total),
        input: millions(usage.input),
        output: millions(usage.output),
        cache: millions(usage.cache),
      })

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
                  <th>{t('settings.priceMapRate')}</th>
                  <th>{t('settings.priceMapTokens')}</th>
                  <th>{t('settings.priceMapSpend')}</th>
                  <th>{t('settings.priceMapFrom')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = rowKey(row.provider, row.model)
                  const usage = tokens.get(key)
                  // The vendor the row is SHOWING: the stored override's, else the
                  // mechanical one. The model field's options follow this, NOT the
                  // resolved target — a target needs a model too, so a row whose
                  // vendor is set but whose model is not yet would otherwise show
                  // an empty model list.
                  const stored: { vendor: string; model: string } | undefined = Object.hasOwn(overrides, key) ? overrides[key] : undefined
                  const pickedVendor: string | undefined = Object.hasOwn(picked, key) ? picked[key] : undefined
                  const chosenVendor = pickedVendor ?? stored?.vendor ?? row.target?.vendor ?? ''
                  return (
                    <PriceMapRowCells
                      key={key}
                      row={row}
                      t={t}
                      vendors={vendors}
                      chosenVendor={chosenVendor}
                      rate={rateOf(row.rate)}
                      spend={spendOf(row.rate, usage)}
                      tokensCell={tokenCell(usage)}
                      onPickVendor={(vendor) => {
                        // Local first: the model list must follow the pick even when
                        // the write below is refused or still in flight. The vendor is
                        // stored even when its model list is empty, so the pick is
                        // never silently dropped.
                        setPicked((current: Record<string, string>) => ({ ...current, [key]: vendor }))
                        const next = { ...overrides }
                        next[key] = { vendor, model: modelChoices(vendor)[0] ?? '' }
                        props.onWrite?.(next)
                      }}
                      onPickModel={(target) => {
                        const next = { ...overrides }
                        next[key] = { vendor: chosenVendor === '' ? row.target?.vendor ?? '' : chosenVendor, model: target }
                        props.onWrite?.(next)
                      }}
                      onClear={() => {
                        const { [rowKey(row.provider, row.model)]: _dropped, ...rest } = overrides
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

/** One body row. A component of its own so the table's map stays readable. */
function PriceMapRowCells(props: {
  row: PriceMapRow
  t: Translate
  vendors: ReadonlyArray<{ id: string; name: string }>
  rate: string
  spend: string
  tokensCell: string
  chosenVendor: string
  onPickVendor: (vendor: string) => void
  onPickModel: (target: string) => void
  onClear: () => void
}): ReactElement {
  const { row, t } = props
  const targetOptions = props.chosenVendor === '' ? [] : modelChoices(props.chosenVendor)
  const vendorIds = props.vendors.map(vendor => vendor.id)
  // A datalist id must be unique per field, or the browser binds one list to
  // both cells and the model field suggests vendors.
  const listPrefix = 'lc-pricemap-list-' + rowKey(row.provider, row.model).replace(/[^A-Za-z0-9_-]/g, '_')
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
      <td className="lc-pricemap-nums" data-label={t('settings.priceMapRate')}>{props.rate}</td>
      <td className="lc-pricemap-nums" data-label={t('settings.priceMapTokens')}>{props.tokensCell}</td>
      <td className="lc-pricemap-nums" data-label={t('settings.priceMapSpend')}>{props.spend}</td>
      <td className="lc-pricemap-src-cell" data-label={t('settings.priceMapFrom')}>
        <span className={'lc-pricemap-src lc-pricemap-src-' + row.source}>
          {t('settings.priceMapSource.' + row.source)}
        </span>
        {row.edited
          ? (
            <button type="button" className="lc-pricemap-clear" onClick={props.onClear}>
              {t('settings.priceMapClear')}
            </button>
          )
          : null}
      </td>
    </tr>
  )
}
