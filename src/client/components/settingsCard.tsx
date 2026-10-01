/**
 * The dsh-context preference cards — two seats over the same seven rows. The
 * settings-section card (`settings.plugin.item`, the older harness lines)
 * renders a collapsible list item in Settings → Plugins → Plugin
 * configuration; the Plugins-page card (`plugins.bundle.config`, the
 * Config-form generation) renders the rows flat inside the section chrome the
 * Plugins page draws for the bundle. Both are keyed on the Host-served
 * `dsh-context` namespace and render nothing while it is unavailable (a
 * deployment without the Host half, or a remote browser, shows no trace).
 * The settings-section card mounts expanded when the Plugin Info card's
 * "Open plugin settings" jump left a fresh expand request (settingsJump.ts),
 * scrolling itself into view.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown } from '../primitives'
import { consumeCardExpand } from '../settingsJump'
import { PriceMapTable } from '../../our/client/PriceMapTable'
import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

export interface SettingsCardProps {
  useContextSettings?: <T>(selector: (state: SettingsState) => T) => T
  set?: (field: SettingsField, value: string) => void
  /**
   * The model-price mapping's seat: the stored overrides, the wholesale write,
   * and the store's revision (a new price book moves the rates and the pickers'
   * options without moving the preferences).
   */
  usePriceMap?: () => {
    overrides: Record<string, { vendor: string; model: string }>
    write: (next: Record<string, { vendor: string; model: string }>) => void
    revision: number
  }
  /** The sessions seat the price table folds its billed pairs from. */
  useSessions?: unknown
  /**
   * Reads the display currency. A CALLBACK rather than a value: the slot outlet
   * re-renders on a locale switch, so reading per render keeps the printed
   * figures in step with the language.
   */
  currencyOf?: () => 'usd' | 'cny'
}

interface PrefRowProps {
  label: string
  value: string
  options: ReadonlyArray<{ id: string; label: string }>
  disabled: boolean
  onPick: (id: string) => void
}

function PrefRow(props: PrefRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const active = props.options.find(o => o.id === props.value)?.label ?? props.value
  return (
    <div className="lc-settings-row">
      <span className="lc-settings-label">{props.label}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={props.options}
        selectedId={props.value}
        onSelect={(id) => { setOpen(false); props.onPick(id) }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className="lc-settings-select hover:enabled:bg-(--dsw-alias-interactive-bg-hover) disabled:opacity-50 disabled:cursor-default"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {active}
            <IconChevronDown />
          </button>
        )}
      />
    </div>
  )
}

/** Translate over the plugin's dictionary, as the view kit binds it. */
type Translate = ViewKit['t']

/** The seven preference rows shared by both seats. */
function PreferenceRows(props: { t: Translate; state: SettingsState; set?: SettingsCardProps['set'] }): ReactElement {
  const { t, state, set } = props
  const disabled = state.status !== 'ready' || !state.writable
  return (
    <>
      <PrefRow
        label={t('settings.placement')}
        value={state.placement}
        disabled={disabled}
        options={[
          { id: 'all', label: t('placement.all') },
          { id: 'tab', label: t('placement.tab') },
          { id: 'sidebar', label: t('placement.sidebar') },
        ]}
        onPick={(id) => { set?.('defaultPlacement', id) }}
      />
      <PrefRow
        label={t('settings.insightsEntry')}
        value={state.insightsEntry}
        disabled={disabled}
        options={[
          { id: 'show', label: t('insightsEntry.show') },
          { id: 'hide', label: t('insightsEntry.hide') },
        ]}
        onPick={(id) => { set?.('insightsEntry', id) }}
      />
      <PrefRow
        label={t('settings.gran')}
        value={state.granularity}
        disabled={disabled}
        options={[
          { id: 'step', label: t('gran.step') },
          { id: 'turn', label: t('gran.turn') },
        ]}
        onPick={(id) => { set?.('defaultGranularity', id) }}
      />
      <PrefRow
        label={t('settings.mode')}
        value={state.mode}
        disabled={disabled}
        options={[
          { id: 'total', label: t('gran.total') },
          { id: 'delta', label: t('gran.delta') },
        ]}
        onPick={(id) => { set?.('defaultTrendMode', id) }}
      />
      <PrefRow
        label={t('settings.deltaBase')}
        value={state.deltaBase}
        disabled={disabled}
        options={[
          { id: 'step', label: t('browser.base.step') },
          { id: 'turn', label: t('browser.base.turn') },
        ]}
        onPick={(id) => { set?.('defaultDeltaBase', id) }}
      />
      <PrefRow
        label={t('settings.toolSort')}
        value={state.toolSort}
        disabled={disabled}
        options={[
          { id: 'size', label: t('tool.sort.size') },
          { id: 'count', label: t('tool.sort.count') },
          { id: 'name', label: t('tool.sort.name') },
        ]}
        onPick={(id) => { set?.('defaultToolSort', id) }}
      />
      <PrefRow
        label={t('settings.fileSort')}
        value={state.fileSort}
        disabled={disabled}
        options={[
          { id: 'count', label: t('files.sort.count') },
          { id: 'latest', label: t('files.sort.latest') },
          { id: 'path', label: t('files.sort.path') },
        ]}
        onPick={(id) => { set?.('defaultFileSort', id) }}
      />
    </>
  )
}

export function makeSettingsCard(kit: ViewKit): (props: SettingsCardProps) => ReactElement | null {
  const { t } = kit
  return function SettingsCard(props: SettingsCardProps): ReactElement | null {
    const [open, setOpen] = useState(false)
    const itemRef = useRef<HTMLLIElement | null>(null)
    // "Open plugin settings" jump: consume its fresh expand request once on
    // mount and land open; every guard stays local so no host quirk can surface.
    useEffect(() => {
      if (!consumeCardExpand()) return
      setOpen(true)
      try {
        itemRef.current?.scrollIntoView({ block: 'nearest' })
      } catch { /* hosts without scrollIntoView: expanded but unscrolled */ }
    }, [])
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    return (
      <li ref={itemRef} className={'lc-settings-card' + (open ? ' lc-settings-open' : '')}>
        <button
          type="button"
          className="lc-settings-head"
          aria-expanded={open}
          aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${t('settings.title')}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className="lc-settings-headtext">
            <span className="lc-settings-name">{t('settings.title')}</span>
            <span className="lc-settings-desc">{t('settings.desc')}</span>
          </span>
          <IconChevronDown className="lc-settings-chevron" />
        </button>
        {open
          ? (
            <div className="lc-settings-body">
              {!state.writable && state.status === 'ready'
                ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
                : null}
              <PreferenceRows t={t} state={state} set={props.set} />
              <PriceMapBlock {...props} t={t} />
            </div>
          )
          : null}
      </li>
    )
  }
}

/**
 * The Plugins-page card (the Config-form generation's `plugins.bundle.config`
 * seat, `view: 'page'`): the page owns the bundle's page and section chrome,
 * so the rows render flat. Same unserved/absent degradation as the
 * settings-section card.
 */
export function makePluginConfigCard(kit: ViewKit): (props: SettingsCardProps) => ReactElement | null {
  const { t } = kit
  return function PluginConfigCard(props: SettingsCardProps): ReactElement | null {
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    return (
      <div className="lc-settings-prefs">
        {!state.writable && state.status === 'ready'
          ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
          : null}
        <PreferenceRows t={t} state={state} set={props.set} />
        <PriceMapBlock {...props} t={t} />
      </div>
    )
  }
}

/**
 * The model-price mapping block: a collapsible section so the card stays short
 * until the mapping is actually wanted (the table is wide and rarely needed).
 */
function PriceMapBlock(props: SettingsCardProps & { t: Translate }): ReactElement | null {
  const [open, setOpen] = useState(false)
  const seat = props.usePriceMap
  const state = typeof seat === 'function' ? seat() : undefined
  if (state === undefined) return null
  return (
    <div className="lc-settings-row lc-settings-pricemap">
      <button
        type="button"
        className="lc-settings-head lc-settings-subhead"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className="lc-settings-headtext">
          <span className="lc-settings-name">{props.t('settings.priceMap')}</span>
          <span className="lc-settings-desc">{props.t('settings.priceMapDesc')}</span>
        </span>
        <IconChevronDown className="lc-settings-chevron" />
      </button>
      {open
        ? (
          <PriceMapTable
            t={props.t}
            useSessions={props.useSessions}
            overrides={state.overrides}
            onWrite={state.write}
            currencyOf={props.currencyOf}
            revision={state.revision}
          />
        )
        : null}
    </div>
  )
}
