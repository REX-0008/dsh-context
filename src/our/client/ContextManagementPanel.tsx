/**
 * The context-management panel: upstream's Context browser, with its
 * `system` category listing the prompt's own sections.
 *
 * There is no layout of our own here on purpose. The assembled system prompt is
 * joined into ONE string before it reaches the log, so upstream can only show
 * that string as a single row; the sections are read in-process instead (our own
 * state route) and handed back to upstream's browser through its `systemRows`
 * hook, which draws each one with the SAME row renderer — and the SAME expansion
 * chrome (foldable head, line count, raw/Markdown switch, copy) — that the
 * tool-schema and message rows use. The sections therefore read as what they
 * are: the system prompt's own contents, one per row.
 *
 * Everything else in the card (DNA switch, step picker, estimate-vs-actual
 * totals, composition bar, every other category) is upstream's, untouched.
 *
 * @module @our/context-panel-write/our/client/ContextManagementPanel
 */
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { BrowserRowBuilder } from '../../client/components/browser'
import type { Translate } from '../../client/i18n'
import { dispatchAction, fetchState, type PanelState, type SectionKind, type SystemSectionInfo } from './panel-api'

/**
 * The source kinds. Each kind changes differently, which is what the row's left
 * tag states:
 * - `config`: our own module — the persisted edit IS its source;
 * - `preset`: injected by an agent preset — its file can be written back, next session;
 * - `plugin`: a plugin's (or the harness's) text — its file is not ours to change,
 *   so the original is backed up and compared instead.
 */
const KIND_KEY: Record<SectionKind, string> = {
  config: 'our.kind.config',
  preset: 'our.kind.preset',
  plugin: 'our.kind.plugin',
}

/** Why the source kind matters: it decides where a change finally lands. */
const KIND_HINT_KEY: Record<SectionKind, string> = {
  config: 'our.kindHint.config',
  preset: 'our.kindHint.preset',
  plugin: 'our.kindHint.plugin',
}

/** Estimated size, matching the host's fixed-density heuristic. */
function sizeOf(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** Props: the session, plus a builder that decorates upstream's browser. */
export interface ContextManagementPanelProps {
  sessionId: string
  /** The locale translator; every product string in this panel goes through it. */
  t: Translate
  /**
   * Builds upstream's browser card, handing back the hooks this panel fills in.
   * `body` is upstream's own expansion chrome (head, line count, raw/Markdown
   * switch, copy) so a section expands exactly like a tool schema.
   */
  browser: (hooks: {
    systemRows: (
      row: BrowserRowBuilder,
      body: (name: string, text: string, extra?: ReactNode) => ReactNode,
      toolbar: (value: string, onChange: (next: string) => void) => ReactNode,
      pinnedSeq: number | null,
    ) => ReactNode
    systemCount: number
    /** Caption for the delivered-prompt row kept below the split list. */
    deliveredLabel: string
    /** Per-category head actions (the prune control on message categories). */
    categoryActions: (category: string) => ReactNode
    /** Whether a category head should read as pruned. */
    categoryMarked: (category: string) => boolean
  }) => ReactNode
}

/** The panel: upstream's browser with our section rows in its system category. */
export function ContextManagementPanel({ sessionId, browser, t }: ContextManagementPanelProps): ReactElement {
  const [state, setState] = useState<PanelState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [comparing, setComparing] = useState<string | null>(null)
  const [weightOpen, setWeightOpen] = useState<string | null>(null)
  const [weightDraft, setWeightDraft] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Which message categories have been pruned, with the figures the head banner
  // reports. Held per session in memory: the durable record of a prune is the
  // session log itself (a compaction/prune event), not a panel preference.
  const [pruned, setPruned] = useState<Record<string, { count: number; tokens: number }>>({})

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await fetchState(sessionId))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const dispatch = useCallback(async (action: string, payload?: object): Promise<void> => {
    try {
      await dispatchAction(sessionId, action, payload)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }, [refresh, sessionId])

  const sections: SystemSectionInfo[] = state?.systemSections ?? []
  const stale = sections.some(section => section.staleTable)
  /** The declared runtime contexts (dynamic, low-authority half of the prompt). */
  const contexts: SystemSectionInfo[] = state?.contexts ?? []
  /** Injection source kinds offered for suppression, and those already off. */
  const injections = state?.observedInjections ?? []
  const suppressedInjections = new Set(state?.suppressedInjections ?? [])


  const systemRows = (
    row: BrowserRowBuilder,
    body: (name: string, text: string, extra?: ReactNode) => ReactNode,
    toolbar: (value: string, onChange: (next: string) => void) => ReactNode,
    pinnedSeq: number | null,
  ): ReactNode => {
    // A past step is already sent, so the split list (the editable
    // configuration) is replaced by a note rather than pretending those rows
    // can be changed: edits only ever apply to the current conversation.
    const atPastStep = pinnedSeq !== null
    // The row filter: matches a section's name, its source plugin, and its text,
    // which is what makes a long section list navigable.
    const needle = query.trim().toLowerCase()
    const shown = needle === ''
      ? sections
      : sections.filter(section =>
        section.name.toLowerCase().includes(needle)
        || (section.plugin ?? '').toLowerCase().includes(needle)
        || section.text.toLowerCase().includes(needle))
    return (
    <>
      {atPastStep ? (
        <div className="lc-br-note">
          {t('our.pastStep')}
        </div>
      ) : null}
      {stale && !atPastStep ? (
        <div className="lc-br-note" title={t('our.staleTableTip')}>
          {'⚠ ' + t('our.staleTable', { src: String(state?.knownSectionsSource ?? '—') })}
        </div>
      ) : null}
      {sections.length === 0 && !atPastStep ? (
        <div className="lc-br-note">{t('our.empty')}</div>
      ) : null}

      {/* The category's own filter toolbar, mounted even when nothing matches so
          the filter can always be cleared. */}
      {atPastStep || sections.length === 0 ? null : toolbar(query, setQuery)}
      {sections.length > 0 && shown.length === 0 ? (
        <div className="lc-br-note">{t('our.noMatch')}</div>
      ) : null}
      {/* Scoped so the token-column alignment below applies to OUR rows only:
          upstream's tool/message rows keep their original figure width. */}
      <div className="lc-our-sections">
      {(atPastStep ? [] : shown).map((section) => {
        const open = editing === section.name
        const weightEdited = section.weight !== undefined
        const weightValue = weightEdited ? section.weight : section.order

        // The expanded body: upstream's own chrome (head + line count + raw /
        // Markdown switch + copy) with our actions in the same head group,
        // ordered raw · Markdown · edit · (write-back / restore).
        const extra = (
          <>
            {section.kind === 'preset' ? (
              <button type="button" className="lc-rich-seg-btn"
                title={t('our.action.writeBackTip')}
                onClick={(event) => { event.stopPropagation(); void dispatch('writeBackPreset', { name: section.name }) }}>
                {t('our.action.writeBack')}
              </button>
            ) : null}
            {section.edited ? (
              <button type="button" className="lc-rich-seg-btn" title={t('our.action.restoreTip')}
                onClick={(event) => { event.stopPropagation(); void dispatch('clearSectionText', { name: section.name }) }}>
                {t('our.action.restore')}
              </button>
            ) : null}
            <button type="button" className={'lc-rich-seg-btn' + (open ? ' lc-rich-seg-on' : '')}
              title={t('our.action.editTip')}
              onClick={(event) => {
                event.stopPropagation()
                if (open) setEditing(null)
                else { setDraft(section.text); setEditing(section.name); setComparing(null) }
              }}>
              {t('our.action.edit')}
            </button>
          </>
        )

        const bodyNode = open ? (
          <>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={12}
              style={{ width: '100%' }} />
            <div>
              <button type="button" className="lc-gran-btn"
                onClick={() => { void dispatch('setSectionText', { name: section.name, text: draft, original: section.text }).then(() => setEditing(null)) }}>
                {t('our.action.save')}
              </button>
              <button type="button" className="lc-gran-btn" onClick={() => setEditing(null)}>{t('our.action.cancel')}</button>
            </div>
          </>
        ) : comparing === section.name ? (
          <>
            <div className="lc-cols">
              <div className="lc-col">
                <div className="lc-empty" style={{ textAlign: 'left' }}>{t('our.compare.mine')}</div>
                <pre className="lc-br-preview" style={{ whiteSpace: 'pre-wrap' }}>{section.text}</pre>
              </div>
              <div className="lc-col">
                <div className="lc-empty" style={{ textAlign: 'left' }}>{t('our.compare.original')}</div>
                <pre className="lc-br-preview" style={{ whiteSpace: 'pre-wrap' }}>{section.originalText ?? ''}</pre>
              </div>
            </div>
            <button type="button" className="lc-gran-btn"
              onClick={() => { void dispatch('refreshSectionBaseline', { name: section.name, original: section.originalText }).then(() => setComparing(null)) }}>
              {t('our.action.refreshBaseline')}
            </button>
          </>
        ) : body(section.name, section.text, extra)

        // The row's trailing slot is where tool rows carry their plugin chip and
        // hit tally; ours carry the same chips plus the weight control and switch.
        const trailing = (
          <>
            {/* The registering plugin, in the same chip the tool rows use for
                theirs — required on the COLLAPSED row, not only when expanded. */}
            {section.plugin !== undefined ? (
              <span className="lc-br-tag lc-br-tool-plugin" title={t('our.chip.pluginTip')}>{section.plugin}</span>
            ) : (
              <span className="lc-br-tag lc-br-sect-unknown" title={t('our.chip.unknownSourceTip')}>
                {t('our.chip.unknownSource')}
              </span>
            )}
            {section.edited ? <span className="lc-br-tag lc-br-sect-edited" title={t('our.chip.editedTip')}>{t('our.chip.edited')}</span> : null}
            {section.originalChanged ? (
              <button type="button" className="lc-br-tag lc-br-sect-edited" title={t('our.chip.originalChangedTip')}
                onClick={(event) => { event.stopPropagation(); setComparing(comparing === section.name ? null : section.name) }}>
                {t('our.chip.originalChanged')}
              </button>
            ) : null}
            {weightOpen === section.name ? (
              <input className="lc-br-tag" style={{ width: '4.5em', textAlign: 'center' }}
                autoFocus value={weightDraft}
                title={weightEdited && section.order !== undefined
                  ? t('our.weightTip.original', { orig: String(section.order) })
                  : t('our.weightTip')}
                placeholder={weightEdited && section.order !== undefined ? String(section.order) : ''}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setWeightDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
                onBlur={(event) => {
                  const raw = event.target.value.trim()
                  void dispatch('setSectionWeight', { name: section.name, weight: raw === '' ? null : Number(raw) })
                  setWeightOpen(null)
                }} />
            ) : (
              <button type="button"
                className={'lc-br-tag' + (weightEdited ? ' lc-br-sect-edited' : '') + (section.staleTable ? ' lc-br-sect-stale' : '')}
                style={{ width: '4.5em', textAlign: 'center' }}
                title={section.staleTable
                  ? t('our.weightTip.stale')
                  : weightEdited
                    ? t('our.weightTip.edited', { orig: String(section.order ?? '—') })
                    : section.order === undefined ? t('our.weightTip.unknown') : t('our.weightTip')}
                onClick={(event) => { event.stopPropagation(); setWeightDraft(weightValue === undefined ? '' : String(weightValue)); setWeightOpen(section.name) }}>
                {weightValue === undefined ? '—' : String(weightValue)}
              </button>
            )}
            {/* Three states, because two disable levels exist (the deployment
                level is not managed here). Clicking cycles enabled → off-here →
                off-for-preset → enabled, and the tooltip names the current level. */}
            <button type="button"
              className={'lc-br-tag' + (section.disabledAt === undefined ? '' : ' lc-br-sect-off')}
              title={section.disabledAt === 'preset'
                ? t('our.state.offPresetTip')
                : section.disabledAt === 'conversation'
                  ? t('our.state.offConversationTip')
                  : t('our.state.onTip')}
              onClick={(event) => {
                event.stopPropagation()
                const next = section.disabledAt === undefined
                  ? { level: 'conversation' as const, off: true }
                  : section.disabledAt === 'conversation'
                    ? { level: 'preset' as const, off: true }
                    : { level: 'conversation' as const, off: false }
                void dispatch('setSectionLevel', { name: section.name, ...next })
              }}>
              {section.disabledAt === 'preset' ? t('our.state.offPreset') : section.disabledAt === 'conversation' ? t('our.state.offConversation') : t('our.state.on')}
            </button>
          </>
        )

        // The left tag slot states the SOURCE KIND (how a change lands) — the same
        // slot surface rows use for their kind tag; an edited section's tag turns
        // brand-coloured as the reminder.
        // A tool-guidance section (`tool:<name>`) has a second, distinct switch
        // elsewhere: the tools category carries the tool itself, whose
        // restriction makes CALLS fail while this switch only stops the
        // guidance TEXT from being sent. The tooltip states the difference,
        // because the two read as the same action otherwise.
        const isToolGuidance = section.name.startsWith('tool:')
        const kindTag = (
          <i className={'lc-br-kind' + (section.edited ? ' lc-br-kind-edited' : '')}
            title={isToolGuidance ? t(KIND_HINT_KEY[section.kind]) + ' — ' + t('our.toolGuidanceHint') : t(KIND_HINT_KEY[section.kind])}>
            {t(KIND_KEY[section.kind])}
          </i>
        )
        // The token figure goes in its own column (the row's `tokens` slot, which
        // right-aligns and now pads to a fixed width); the preview stays the name.
        return row('sec:' + section.name, kindTag, section.name, sizeOf(section.text), undefined, bodyNode, false, trailing)
      })}
      </div>

      {/* Runtime contexts: the declared, dynamic half. Same row idiom as the
          sections above, because they take the same two decisions. */}
      {contexts.length > 0 ? (
        <>
          <div className="lc-br-divider" />
          <div className="lc-br-note" title={t('our.contexts.tip')}>{t('our.contexts')}</div>
          <div className="lc-our-sections">
            {contexts.map(context => {
              const off = context.disabledAt !== undefined
              return row(
                'ctx:' + context.name,
                <i className={'lc-br-kind' + (context.edited ? ' lc-br-kind-edited' : '')}>{t('our.kind.plugin')}</i>,
                context.name,
                sizeOf(context.text),
                undefined,
                body(context.name, context.text),
                false,
                <>
                  {context.edited ? <span className="lc-br-tag lc-br-sect-edited" title={t('our.chip.editedTip')}>{t('our.chip.edited')}</span> : null}
                  <button type="button"
                    className={'lc-br-tag' + (off ? ' lc-br-sect-off' : '')}
                    title={off ? t('our.state.offConversationTip') : t('our.state.onTip')}
                    onClick={(event) => {
                      event.stopPropagation()
                      void dispatch('setContextLevel', { name: context.name, off: !off })
                    }}>
                    {off ? t('our.state.offConversation') : t('our.state.on')}
                  </button>
                </>,
              )
            })}
          </div>
        </>
      ) : null}

      {/* Injection sources: these append to the step batch rather than registering
          a prompt contribution, so the only action is suppression. Filtering only
          — nothing is rewritten. */}
      {injections.length > 0 ? (
        <>
          <div className="lc-br-divider" />
          <div className="lc-br-note">{t('our.injections')}</div>
          <div className="lc-our-sections">
            {injections.map(kind => {
              const off = suppressedInjections.has(kind)
              return (
                <div key={kind} className="lc-br-elem">
                  <div className="lc-br-elem-row" style={{ cursor: 'default' }}>
                    <span className="lc-br-kind">{t('our.kind.plugin')}</span>
                    <span className="lc-br-elem-name">{kind}</span>
                    <span className="lc-br-tag">{off ? t('our.injections.off') : ''}</span>
                    <button type="button"
                      className={'lc-br-tag' + (off ? ' lc-br-sect-off' : '')}
                      title={t('our.injections.tip')}
                      onClick={() => { void dispatch('setInjectionSuppressed', { kind, off: !off }) }}>
                      {off ? t('our.injections.restore') : t('our.injections.suppress')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </>
    )
  }

  /**
   * The message categories a prune may act on. The prompt-side categories
   * (`system`, `tools`) are governed by the section controls, not by pruning.
   */
  const PRUNABLE = new Set(['user', 'inject', 'skill', 'assistant', 'tool'])
  const pending = state?.prunePending === true

  /**
   * The per-category prune control.
   *
   * Pressing it only PARKS the request: the prune runs at the next turn boundary
   * and stays cancellable until then, so the control switches to a cancel action
   * while it waits. Once it has run the action is irreversible (the harness has
   * no un-replace for a surface range), which is why the control warns before
   * parking and the head keeps a red outline afterwards.
   */
  const categoryActions = (category: string): ReactNode => {
    if (!PRUNABLE.has(category)) return null
    const done = pruned[category]
    return (
      <>
        {done !== undefined ? (
          <span className="lc-br-prune-mark" title={t('our.prune.mark')}>{t('our.prune.mark')}</span>
        ) : null}
        {pending ? (
          <button type="button" className="lc-br-prune-pending"
            title={t('our.prune.pendingBanner')}
            onClick={(event) => { event.stopPropagation(); void dispatch('cancelPrune') }}>
            {t('our.prune.cancel')}
          </button>
        ) : (
          <button type="button" className="lc-br-prune"
            title={t('our.prune.tip')}
            onClick={(event) => {
              event.stopPropagation()
              // The warning is the point: the action cannot be undone once the
              // next boundary passes, so the confirmation names both facts.
              if (!window.confirm(t('our.prune.confirm'))) return
              setPruned(current => ({
                ...current,
                [category]: { count: 0, tokens: 0 },
              }))
              void dispatch('requestPrune')
            }}>
            {t('our.prune')}
          </button>
        )}
      </>
    )
  }

  // No card of our own: the panel IS the browser (its system category lists the
  // prompt's sections), so the title is retitled in place rather than framed by
  // a second card.
  return (
    <>
      {error !== null ? <div className="lc-error">{error}</div> : null}
      {pending ? (
        <div className="lc-br-prune-banner">{t('our.prune.pendingBanner')}</div>
      ) : null}
      {browser({
        systemRows,
        systemCount: sections.length,
        deliveredLabel: t('our.delivered'),
        categoryActions,
        categoryMarked: (category: string) => pruned[category] !== undefined,
      })}
    </>
  )
}
