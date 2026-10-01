/**
 * The "Model price mapping" block of the plugin settings card.
 *
 * One row per (local route, local model) pair the fold has actually billed,
 * showing where it prices from and the two figures worth watching: the tokens it
 * has consumed and what they add up to. The vendor and model cells are pickers
 * over the registry's own catalogue, so a row can never name a vendor or model
 * the price book cannot answer.
 *
 * Editing a row is what takes it out of the mechanical pass; the ABSENCE of a
 * stored override is what leaves it in. There is no separate edited flag.
 * @module @our/context-panel-write/our/client/PriceMapTable
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** One vendor option, as the picker takes it. */
interface VendorChoice { id: string; name: string }

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

/** One picker cell: the current choice plus a searchable menu of the options. */
function Picker(props: {
  value: string
  options: ReadonlyArray<{ id: string; label: string }>
  placeholder: string
  searchLabel: string
  onPick: (id: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = q === '' ? props.options : props.options.filter(o => o.id.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
    // A menu with no rows renders an empty card, so an unmatched query states
    // that instead (a non-interactive label row).
    return matching.length === 0
      ? [{ type: 'label' as const, id: 'none', text: props.searchLabel }]
      : matching.map(o => ({ id: o.id, label: o.label }))
  }, [props.options, props.searchLabel, query])
  const label = props.value === ''
    ? props.placeholder
    : (props.options.find(o => o.id === props.value)?.label ?? props.value)
  return (
    <Menu
      open={open}
      anchor={(
        <button
          type="button"
          className={'lc-pricemap-pick' + (props.value === '' ? ' lc-pricemap-pick-empty' : '')}
          onClick={() => { setOpen(!open) }}
        >
          {label}
        </button>
      )}
      portal
      items={items}
      selectedId={props.value}
      onSelect={(id) => {
        setOpen(false)
        setQuery('')
        if (id !== 'none') props.onPick(id)
      }}
      onClose={() => { setOpen(false); setQuery('') }}
    >
      <input
        className="lc-pricemap-search"
        value={query}
        aria-label={props.searchLabel}
        placeholder={props.searchLabel}
        onChange={(event) => { setQuery(event.target.value) }}
        onClick={(event) => { event.stopPropagation() }}
      />
    </Menu>
  )
}

/**
 * Run one derivation, reporting the step instead of throwing.
 *
 * The step name is the whole point: a render throw reaches the fence with only
 * the runtime's message, which names no code. A named step turns the next report
 * into an answer.
 * @param step - the derivation's name, as the note prints it.
 * @param make - the derivation.
 * @param fallback - what to render when it refuses.
 * @returns the value and, when it refused, the step plus the runtime's message.
 */
function guarded<T>(step: string, make: () => T, fallback: T): { value: T; failed: string } {
  try {
    return { value: make(), failed: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { value: fallback, failed: step + ' — ' + message }
  }
}

/** The block. */
export function PriceMapTable(props: PriceMapTableProps): ReactElement {
  const { t } = props
  // The sessions seat is a real hook, so it is read once at the top rather than
  // inside a memo (the same guarded-seat contract the overview card follows).
  const seat = props.useSessions
  const snapshot = useMemo(() => {
    if (typeof seat !== 'function') return null
    try {
      return (seat as <T>(selector: (value: unknown) => T) => T)(value => value)
    } catch {
      return null
    }
  }, [seat])
  // Every derivation runs inside its own guard. A seat/snapshot the fold cannot
  // read must cost this block its table, never the settings card: the note names
  // the step that refused, which is what a report needs to be actionable.
  // The pair list is derived on its OWN, off the snapshot only. Folding it in
  // with the override-keyed rows would hand it a new identity whenever the
  // caller rebuilds an equal overrides object, and the effect below feeds the
  // pairs into the store — the identity churn that once grew into an unbounded
  // render loop.
  const observed = useMemo(
    () => guarded('pairs', () => observedOf(snapshot), { pairs: [] as ObservedPair[], tokens: new Map<string, PairTokens>() }),
    [snapshot],
  )
  const { pairs, tokens } = observed.value
  const rowGuard = useMemo(
    () => guarded('rows', () => priceMapRows(pairs, props.overrides), [] as PriceMapRow[]),
    // A new book changes rates and options without changing the pair list, so
    // the store's revision is part of the derivation.
    [pairs, props.overrides, props.revision],
  )
  const vendorGuard = useMemo(() => guarded('vendors', () => vendorChoices(), [] as VendorChoice[]), [props.revision])
  const rows = rowGuard.value
  const vendors = vendorGuard.value
  const failed = observed.failed !== '' ? observed.failed : rowGuard.failed !== '' ? rowGuard.failed : vendorGuard.failed
  // The runtime synthesizes from the same pair list this table renders, so the
  // estimate and the table can never disagree about what is billed.
  useEffect(() => { noteObservedPairs(pairs) }, [pairs])
  const overrides = props.overrides ?? {}
  /**
   * The whole body, built as a value so it can be fenced.
   *
   * React attributes a render throw to this COMPONENT's definition, and the
   * bundler inlines every helper into that frame, so the component frame cannot
   * name the expression. Catching here yields the runtime's own stack frame,
   * which can — that is what makes a report of this block actionable.
   */
  const body = (): ReactElement => {
    const currency: CostCurrency = props.currencyOf?.() ?? 'usd'
    const setRow = (provider: string, model: string, vendor: string, target: string): void => {
      props.onWrite?.({ ...overrides, [rowKey(provider, model)]: { vendor, model: target } })
    }
    const clearRow = (provider: string, model: string): void => {
      const { [rowKey(provider, model)]: _dropped, ...rest } = overrides
      props.onWrite?.(rest)
    }
    /** The rate cells print input/output/cache-read/cache-write, as the board does. */
    const rateOf = (rate: PriceTriple | undefined): string =>
      rate === undefined ? '—' : [rate.miss, rate.out, rate.hit, rate.write].map(n => formatCost(n, currency)).join(' / ')
    const spendOf = (rate: PriceTriple | undefined, usage: PairTokens | undefined): string => {
      if (rate === undefined || usage === undefined) return '—'
      return formatCost((usage.input * rate.miss + usage.cache * rate.hit + usage.output * rate.out) / 1e6, currency)
    }

    return (
      <div className="lc-pricemap">
        <p className="lc-settings-note">{t('settings.priceMapHint', { n: rows.length })}</p>
        {failed === ''
          ? null
          : <p className="lc-settings-note lc-pricemap-failed" role="status">{t('settings.priceMapFailed', { step: failed })}</p>}
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
                    const targetOptions = row.target === null ? [] : modelChoices(row.target.vendor)
                    return (
                      <tr key={key} className={row.edited ? 'lc-pricemap-edited' : undefined}>
                        <td className="lc-pricemap-mono" data-label={t('settings.priceMapRoute')}>{row.provider}</td>
                        <td className="lc-pricemap-mono" data-label={t('settings.priceMapModel')}>{row.model}</td>
                        <td data-label={t('settings.priceMapVendor')}>
                          <Picker
                            value={row.target?.vendor ?? ''}
                            options={vendors.map(vendor => ({ id: vendor.id, label: vendor.name }))}
                            placeholder={t('settings.priceMapPick')}
                            searchLabel={t('settings.priceMapSearch')}
                            onPick={(vendor) => {
                              const choices = modelChoices(vendor)
                              if (choices.length > 0) setRow(row.provider, row.model, vendor, choices[0])
                            }}
                          />
                        </td>
                        <td data-label={t('settings.priceMapTarget')}>
                          <Picker
                            value={row.target?.model ?? ''}
                            options={targetOptions.map(id => ({ id, label: id }))}
                            placeholder={t('settings.priceMapPick')}
                            searchLabel={t('settings.priceMapSearch')}
                            onPick={(target) => {
                              if (row.target !== null) setRow(row.provider, row.model, row.target.vendor, target)
                            }}
                          />
                        </td>
                        <td className="lc-pricemap-nums" data-label={t('settings.priceMapRate')}>{rateOf(row.rate)}</td>
                        <td className="lc-pricemap-nums" data-label={t('settings.priceMapTokens')}>
                          {usage === undefined
                            ? '—'
                            : t('settings.priceMapTokenCell', {
                              total: millions(usage.total),
                              input: millions(usage.input),
                              output: millions(usage.output),
                              cache: millions(usage.cache),
                            })}
                        </td>
                        <td className="lc-pricemap-nums" data-label={t('settings.priceMapSpend')}>{spendOf(row.rate, usage)}</td>
                        <td className="lc-pricemap-src-cell" data-label={t('settings.priceMapFrom')}>
                          <span className={'lc-pricemap-src lc-pricemap-src-' + row.source}>
                            {t('settings.priceMapSource.' + row.source)}
                          </span>
                          {row.edited
                            ? (
                              <button type="button" className="lc-pricemap-clear" onClick={() => { clearRow(row.provider, row.model) }}>
                                {t('settings.priceMapClear')}
                              </button>
                            )
                            : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    )
  }
  try {
    return body()
  } catch (error) {
    return (
      <div className="lc-pricemap">
        <p className="lc-settings-note lc-pricemap-failed" role="status">{t('settings.priceMapFailed', { step: crashFrameOf(error) })}</p>
      </div>
    )
  }
}

/**
 * The runtime's own top frame for a caught render error — `file:line:column`
 * plus the message, which is the only thing that names the failing expression.
 * @param error - the caught value.
 * @returns one line for the card.
 */
export function crashFrameOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('at ')) return line.replace(/^at\s+/, '') + ' — ' + message
  }
  return message
}
