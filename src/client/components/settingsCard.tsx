/** The dsh-context preference card, keyed on the Host-served `dsh-context` namespace: while that namespace is
 * unavailable (a deployment without the Host half, or a remote browser) the card renders nothing. */

import { useEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown } from '../primitives'
import { makeErrorBoundary } from './errorBoundary'
import { PriceMapTable } from '../../our/client/PriceMapTable'

import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

interface SettingsCardProps {
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

type Translate = ViewKit['t']

interface PromptTextRowProps {
  label: string
  placeholder: string
  value: string
  disabled: boolean
  onCommit: (text: string) => void
}

/** One free-text preference row: a local draft committed on blur (and on an
 *  unmount without a prior blur), so typing never writes the wire per keystroke. */
function PromptTextRow(props: PromptTextRowProps): ReactElement {
  const [draft, setDraft] = useState(props.value)
  const [focused, setFocused] = useState(false)
  const latest = useRef({ draft: props.value, value: props.value, commit: props.onCommit })
  latest.current = { draft, value: props.value, commit: props.onCommit }
  // Follow the served value only while the row is idle: a host push (or the
  // optimistic echo) must never clobber in-progress typing.
  if (!focused && draft !== props.value) setDraft(props.value)
  useEffect(() => () => {
    const { draft: text, value, commit } = latest.current
    if (text !== value) commit(text)
  }, [])
  const rows = Math.min(8, Math.max(2, draft.split('\n').length))
  return (
    <div className="lc-settings-row lc-settings-textrow">
      <span className="lc-settings-label">{props.label}</span>
      <textarea
        className="lc-settings-textarea"
        rows={rows}
        placeholder={props.placeholder}
        disabled={props.disabled}
        value={draft}
        onFocus={() => { setFocused(true) }}
        onBlur={() => {
          setFocused(false)
          if (draft !== props.value) props.onCommit(draft)
        }}
        onChange={(event) => { setDraft(event.target.value) }}
      />
    </div>
  )
}

/** The three on/off gates (entry visibility, the Fleet tab, the trend duration curve) share one row shape. */
function ShowHideRow(props: { t: Translate; label: string; value: string; disabled: boolean; onPick: (id: string) => void }): ReactElement {
  return (
    <PrefRow
      label={props.label}
      value={props.value}
      disabled={props.disabled}
      options={[
        { id: 'show', label: props.t('showHide.show') },
        { id: 'hide', label: props.t('showHide.hide') },
      ]}
      onPick={props.onPick}
    />
  )
}

/** One titled preference group: the harness projects no group chrome into the
 *  `plugins.bundle.config` slot, so the card draws its own — a small heading over
 *  its rows, a hairline separating the groups. */
function Group(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="lc-settings-group" role="group" aria-label={props.title}>
      <div className="lc-settings-group-title">{props.title}</div>
      {props.children}
    </div>
  )
}

function PreferenceRows(props: { t: Translate; state: SettingsState; set?: SettingsCardProps['set'] }): ReactElement {
  const { t, state, set } = props
  const disabled = state.status !== 'ready' || !state.writable
  return (
    <>
      <Group title={t('settings.group.entry')}>
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
        <ShowHideRow t={t} label={t('settings.insightsEntry')} value={state.insightsEntry} disabled={disabled}
          onPick={(id) => { set?.('insightsEntry', id) }} />
        <ShowHideRow t={t} label={t('settings.fleetTab')} value={state.fleetTab} disabled={disabled}
          onPick={(id) => { set?.('fleetTab', id) }} />
      </Group>
      <Group title={t('settings.group.view')}>
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
        <ShowHideRow t={t} label={t('settings.durationCurve')} value={state.durationCurve} disabled={disabled}
          onPick={(id) => { set?.('defaultDurationCurve', id) }} />
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
      </Group>
      <Group title={t('settings.group.prompt')}>
        <p className="lc-settings-note">{t('settings.promptHint')}</p>
        <PromptTextRow
          label={t('settings.promptPrefix')}
          placeholder={t('settings.promptPlaceholder')}
          value={state.promptPrefix}
          disabled={disabled}
          onCommit={(text) => { set?.('promptPrefix', text) }}
        />
        <PromptTextRow
          label={t('settings.promptSuffix')}
          placeholder={t('settings.promptPlaceholder')}
          value={state.promptSuffix}
          disabled={disabled}
          onCommit={(text) => { set?.('promptSuffix', text) }}
        />
      </Group>
    </>
  )
}

export function makePluginConfigCard(kit: ViewKit): (props: SettingsCardProps) => ReactElement | null {
  const { t } = kit
  const PriceMapBoundary = makeErrorBoundary(t)
  return function PluginConfigCard(props: SettingsCardProps): ReactElement | null {
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    return (
      <div className="lc-settings-prefs">
        {!state.writable && state.status === 'ready'
          ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
          : null}
        <PreferenceRows t={t} state={state} set={props.set} />
        <PriceMapBlock {...props} t={t} boundary={PriceMapBoundary} />
      </div>
    )
  }
}

/**
 * The model-price mapping block: a collapsible section so the card stays short
 * until the mapping is actually wanted (the table is wide and rarely needed).
 */
interface PriceMapBlockProps extends SettingsCardProps {
  t: Translate
  /** The pre-built fence (see below); a component type must not be made in render. */
  boundary: ComponentType<{ children?: ReactNode }>
}

/**
 * The block's fence, built ONCE per card factory.
 *
 * It cannot be built inside the block: a component type created during render is
 * a new type every render, so React unmounts and remounts the subtree instead of
 * updating it — which re-ran the table's effects on every pass and spun a render
 * loop. Upstream's other boundaries are module-scope for the same reason; here
 * the translator only exists in the factory, so the factory is where it is built.
 */
function PriceMapBlock(props: PriceMapBlockProps): ReactElement | null {
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
          <props.boundary>
            <PriceMapTable
              t={props.t}
              useSessions={props.useSessions}
              overrides={state.overrides}
              onWrite={state.write}
              currencyOf={props.currencyOf}
              revision={state.revision}
            />
          </props.boundary>
        )
        : null}
    </div>
  )
}
