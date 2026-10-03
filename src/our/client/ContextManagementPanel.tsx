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
import type { BrowserRowBuilder, MessageRowRef } from '../../client/components/browser'
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

/**
 * One section's effective placement: its weight when the user set one, else the
 * order it reports. A section whose placement nothing knows sorts last rather
 * than jumping to the top on a missing value.
 * @param section - the section row.
 * @returns its placement, or Infinity when unknown.
 */
function placeOf(section: SystemSectionInfo): number {
  return section.weight ?? section.order ?? Number.POSITIVE_INFINITY
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
    /** Per-row actions on message rows (the prune control). */
    messageRowActions: (row: MessageRowRef) => ReactNode
    /** Whether a message row is part of a pruned range. */
    messageRowMarked: (row: MessageRowRef) => boolean
    /** Extra rows at the top of a category body (contexts and injection sources). */
    categoryRows: (category: string, row: BrowserRowBuilder) => ReactNode
    /** Whether that category has such rows, so it stays openable when empty. */
    categoryHasRows: (category: string) => boolean
    /** A tool row's own switch (the tool itself, not its guidance section). */
    toolRowActions: (toolName: string) => ReactNode
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
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('our:')
  const [newChannel, setNewChannel] = useState<'section' | 'context'>('section')
  const [newOrder, setNewOrder] = useState('50')
  const [newText, setNewText] = useState('')
  const [addError, setAddError] = useState('')


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
  /**
   * Add one module.
   *
   * The name is the module's identity and cannot be changed afterwards, so it is
   * validated before anything is written: the `our:` prefix keeps the entry in
   * this plugin's own family (nothing else can be dropped or renamed here), a
   * collision would shadow an existing definition, and an empty body has nothing
   * to send.
   */
  const createModule = (): void => {
    const name = newName.trim()
    if (!name.startsWith('our:')) { setAddError(t('our.add.errPrefix')); return }
    if (sections.some(section => section.name === name)) { setAddError(t('our.add.errDup')); return }
    if (newText.trim() === '') { setAddError(t('our.add.errText')); return }
    setAddError('')
    const order = Number(newOrder)
    void dispatch('updateModule', {
      target: 'agent',
      name,
      patch: { text: newText, channel: newChannel, order: Number.isFinite(order) ? order : 50, enabled: true },
    }).then(() => {
      setCreating(false)
      setNewName('our:')
      setNewText('')
      setNewOrder('50')
      setNewChannel('section')
    })
  }
  /** The declared runtime contexts (dynamic, low-authority half of the prompt). */
  const contexts: SystemSectionInfo[] = state?.contexts ?? []
  /** The plugins that can inject (their switches). */
  const injectors = state?.injectors ?? []
  /** What this conversation actually received, per producer (content, not capability). */
  const injected = state?.injected ?? []
  const suppressedInjections = new Set(state?.suppressedInjections ?? [])
  /** The runtime-context snapshot nodes, offered for pruning. */
  const contextSnapshotSeqs = state?.contextSnapshotSeqs ?? []
  // Collapse state per group. Kept local: it is a viewing preference of this
  // panel instance, not something the host needs to remember.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const groupHead = (key: string, title: string, tip: string): ReactNode => (
    <button type="button" className="lc-br-group-head"
      title={tip}
      onClick={(event) => {
        event.stopPropagation()
        setCollapsedGroups(current => ({ ...current, [key]: ! current[key] }))
      }}>
      <span className={'lc-br-chev' + (collapsedGroups[key] ? '' : ' lc-br-chev-on')} />
      <span className="lc-br-group-title">{title}</span>
      <span className="lc-br-group-hint">{collapsedGroups[key] ? t('our.expand') : t('our.collapse')}</span>
    </button>
  )
  /** Tools this conversation currently denies (the tool switch's off state). */
  const deniedTools = new Set(
    Object.entries(state?.settings?.toolRestrictions ?? {})
      .filter(([, filter]) => (filter.deny ?? []).length > 0)
      .map(([name]) => name),
  )


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
    const listed = needle === ''
      ? sections
      : sections.filter(section =>
        section.name.toLowerCase().includes(needle)
        || (section.plugin ?? '').toLowerCase().includes(needle)
        || section.text.toLowerCase().includes(needle))
    // Sorted by the effective weight so an edit reorders the list AT ONCE: the
    // delivered order is the last ASSEMBLY's snapshot, which only moves on the
    // next turn (engine.assembleSectionsForSession).
    const shown = listed.slice().sort((a, b) => placeOf(a) - placeOf(b))
    return (
      <>
        {atPastStep ? (
          <div className="lc-br-note">
            {t('our.pastStep')}
          </div>
        ) : null}
        {stale && !atPastStep ? (
          <div className="lc-br-note" title={t('our.staleTableTip')}>
            {'⚠ ' + t('our.staleTable', { src: state?.knownSectionsSource ?? '—' })}
          </div>
        ) : null}
        {sections.length === 0 && !atPastStep ? (
          <div className="lc-br-note">{t('our.empty')}</div>
        ) : null}

        {/* The category's own filter toolbar, mounted even when nothing matches so
          the filter can always be cleared. */}
        {atPastStep || sections.length === 0 ? null : (
          <div className="lc-br-addbar">
            <div className="lc-br-addbar-search">{toolbar(query, setQuery)}</div>
            <button type="button" className="lc-gran-btn"
              title={t('our.action.addModuleTip')}
              onClick={() => { setCreating(!creating); setAddError('') }}>
              {t('our.action.addModule')}
            </button>
          </div>
        )}
        {creating && !atPastStep ? (
          <div className="lc-br-addform">
            <label className="lc-br-addfield">
              <span>{t('our.add.name')}</span>
              <input className="lc-br-tag" value={newName} placeholder="our:example"
                title={t('our.add.nameTip')}
                onChange={(event) => { setNewName(event.target.value) }} />
            </label>
            <label className="lc-br-addfield">
              <span>{t('our.add.channel')}</span>
              <select className="lc-br-tag" value={newChannel}
                onChange={(event) => { setNewChannel(event.target.value === 'context' ? 'context' : 'section') }}>
                <option value="section">{t('our.add.channelSection')}</option>
                <option value="context">{t('our.add.channelContext')}</option>
              </select>
            </label>
            <label className="lc-br-addfield">
              <span>{t('our.add.order')}</span>
              <input className="lc-br-tag" value={newOrder} title={t('our.add.orderTip')}
                onChange={(event) => { setNewOrder(event.target.value) }} />
            </label>
            <textarea className="lc-br-addtext" value={newText} rows={5}
              placeholder={t('our.add.textPlaceholder')}
              onChange={(event) => { setNewText(event.target.value) }} />
            {addError === '' ? null : <div className="lc-br-note lc-br-adderr">{addError}</div>}
            <div className="lc-br-addactions">
              <button type="button" className="lc-gran-btn" onClick={createModule}>{t('our.add.create')}</button>
              <button type="button" className="lc-gran-btn" onClick={() => { setCreating(false); setAddError('') }}>{t('our.action.cancel')}</button>
            </div>
          </div>
        ) : null}
        {sections.length > 0 && shown.length === 0 ? (
          <div className="lc-br-note">{t('our.noMatch')}</div>
        ) : null}
        {/* Scoped so the token-column alignment below applies to OUR rows only:
          upstream's tool/message rows keep their original figure width. */}
        <div className="lc-our-sections">
          {(atPastStep ? [] : shown).map((section) => {
            const open = editing === section.name
            const weightEdited = section.weightEdited
            // The weight when one was set, else the placement the section reports.
            const weightValue = section.weight ?? section.order

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
                {/* Only OUR modules can be dropped: another plugin's section is its
                    registration, and a preset's section is its own file. The
                    confirmation is the panel's usual one, and there is no undo. */}
                {section.kind === 'config' ? (
                  <button type="button" className="lc-rich-seg-btn" title={t('our.action.deleteTip')}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!window.confirm(t('our.action.deleteConfirm', { name: section.name }))) return
                      void dispatch('removeModule', { name: section.name })
                    }}>
                    {t('our.action.delete')}
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
                <textarea value={draft} onChange={(event) =>{  setDraft(event.target.value) }} rows={12}
                  style={{ width: '100%' }} />
                <div>
                  <button type="button" className="lc-gran-btn"
                    onClick={() => { void dispatch('setSectionText', { name: section.name, text: draft, original: section.text }).then(() =>{  setEditing(null) }) }}>
                    {t('our.action.save')}
                  </button>
                  <button type="button" className="lc-gran-btn" onClick={() =>{  setEditing(null) }}>{t('our.action.cancel')}</button>
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
                  onClick={() => { void dispatch('refreshSectionBaseline', { name: section.name, original: section.originalText }).then(() =>{  setComparing(null) }) }}>
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
                    onClick={(event) =>{  event.stopPropagation() }}
                    onChange={(event) =>{  setWeightDraft(event.target.value) }}
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
                {/* Only a changed weight offers this: an untouched row has nothing
                    to put back. A null weight clears the value the row is holding. */}
                {weightEdited && weightOpen !== section.name ? (
                  <button type="button" className="lc-br-tag lc-br-sect-revert"
                    title={t('our.weightTip.revert')}
                    onClick={(event) => {
                      event.stopPropagation()
                      void dispatch('setSectionWeight', { name: section.name, weight: null })
                    }}>
                    ↺
                  </button>
                ) : null}
                {/* Three states, because two disable levels exist (the deployment
                level is not managed here). ONE level remains: clicking toggles this
                section for the whole PRESET, so every conversation running it agrees. */}
                <button type="button"
                  className={'lc-br-tag' + (section.disabledAt === undefined ? '' : ' lc-br-sect-off')}
                  title={section.disabledAt === 'preset' ? t('our.state.offPresetTip') : t('our.state.onTip')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void dispatch('setSectionLevel', { name: section.name, off: section.disabledAt === undefined })
                  }}>
                  {section.disabledAt === 'preset' ? t('our.state.offPreset') : t('our.state.on')}
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

      </>
    )
  }

  /**
   * The rows this panel adds to the inject category's body.
   *
   * TWO groups, because they answer two different questions and mixing them made
   * the same label appear as both a switch and an entry:
   *
   * 1. plugins that can inject content — WHICH producers may inject, with their switches. This is
   *    capability, so it is populated from a static list before any turn runs.
   * 2. what was actually injected — WHAT was actually injected into this conversation: the
   *    runtime contexts the assembly declares (sandbox policy, approval policy,
   *    subagent delegation) plus everything observed in this conversation's own
   *    step batches. This is content, so the observed part is empty until a turn
   *    has run.
   *
   * The runtime contexts live in group 2 rather than a group of their own: they
   * ARE injected content (user-role snapshots), and a separate heading made them
   * read as a third category alongside the two the panel actually has.
   */
  const categoryRows = (category: string, row: BrowserRowBuilder): ReactNode => {
    if (category !== 'inject') return null
    const injectorsOpen = ! collapsedGroups['injectors']
    const injectedOpen = ! collapsedGroups['injected']
    return (
      <>
        {/* The runtime-context snapshot has its own prune: it removes the whole
            block from the next request, and the switch is the same parked
            request/apply-at-boundary cycle the message rows use. */}
        {contextSnapshotSeqs.length > 0 ? (
          <>
            {groupHead('contexts', t('our.contexts'), t('our.contexts.tip'))}
            {!collapsedGroups['contexts'] ? (
              <button type="button" className="lc-br-tag lc-br-prune"
                title={t('our.contexts.prune')}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!window.confirm(t('our.prune.confirm'))) return
                  void dispatch('selectContextPrune')
                }}>
                {t('our.contexts.prune')}
              </button>
            ) : null}
          </>
        ) : null}

        {injectors.length > 0 ? (
          <>
            {groupHead('injectors', t('our.injectors.title'), t('our.injectors.tip'))}
            {injectorsOpen ? injectors.map(({ label, note }) => {
              const off = suppressedInjections.has(label)
              return row(
                'inj:' + label,
                <i className="lc-br-kind">{t('our.kind.plugin')}</i>,
                label,
                0,
                undefined,
                <div className="lc-br-note">{note ?? t('our.injectors.tip')}</div>,
                false,
                <button type="button"
                  className={'lc-br-tag' + (off ? ' lc-br-sect-off' : '')}
                  title={t('our.injectors.tip')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void dispatch('setInjectionSuppressed', { kind: label, off: !off })
                  }}>
                  {off ? t('our.state.off') : t('our.state.on')}
                </button>,
              )
            }) : null}
          </>
        ) : null}

        <div className="lc-br-divider" />
        {groupHead('injected', t('our.injected.title'), t('our.injected.tip'))}
        {injectedOpen ? (
          <>
            {/* Declared runtime contexts first: they are always present, so they
                anchor the group before any turn has produced anything. Their
                switches live in the producers group above — this group is the
                content view, and its one action prunes the whole snapshot. */}
            {contexts.map(context => row(
              'ctx:' + context.name,
              <i className={'lc-br-kind' + (context.edited ? ' lc-br-kind-edited' : '')}>{t('our.kind.plugin')}</i>,
              context.name,
              sizeOf(context.text),
              undefined,
              <div className="lc-br-note" style={{ whiteSpace: 'pre-wrap' }}>{context.text}</div>,
              false,
            ))}
            {injected.map(entry => row(
              'got:' + entry.label,
              <i className="lc-br-kind">{t('our.kind.plugin')}</i>,
              entry.label + (entry.count > 1 ? ' ×' + String(entry.count) : ''),
              sizeOf(entry.text),
              undefined,
              <div className="lc-br-note" style={{ whiteSpace: 'pre-wrap' }}>{entry.text}</div>,
              false,
            ))}
            {contexts.length === 0 && injected.length === 0 ? (
              <div className="lc-br-note">{t('our.injected.empty')}</div>
            ) : null}
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
  /** The rows the user has selected for pruning, ascending (host-owned). */
  const pruneSeqs = state?.pruneSeqs ?? []
  const pending = pruneSeqs.length > 0

  /**
   * The prune control, on ONE message row.
   *
   * Each row toggles ITSELF in or out of the selection, so several rows can be
   * chosen — and dropped — independently. Each selected row is pruned on its
   * own (one call per item), so picking three rows removes exactly those three
   * rather than everything between them.
   *
   * The prune by round button on the same row selects the whole round instead: the
   * run's user message, the assistant replies, the tool calls and their results.
   * It resolves to the same per-item calls, so a round can be narrowed
   * afterwards by deselecting single rows.
   *
   * Selecting only PARKS the choice: it runs at the next turn boundary, and
   * until then every row can still be deselected. Once it has run it cannot be
   * undone (the harness has no un-replace for a surface range).
   */
  const messageRowActions = (row: MessageRowRef): ReactNode => {
    if (!PRUNABLE.has(row.category)) return null
    const selected = pruneSeqs.includes(row.seq)
    return (
      <>
        <button type="button"
          className={'lc-br-tag' + (selected ? ' lc-br-prune-on' : '')}
          title={selected ? t('our.prune.removeTip') : t('our.prune.tip')}
          onClick={(event) => {
            event.stopPropagation()
            // Only the FIRST selection needs the warning: that is the moment the
            // irreversible action is decided, and repeating it per row would
            // train the user to dismiss it unread.
            if (!selected && pruneSeqs.length === 0 && !window.confirm(t('our.prune.confirm'))) return
            void dispatch('togglePrune', { seq: row.seq })
          }}>
          {selected ? t('our.prune.selectedOne') : t('our.prune.item')}
        </button>
        {/* Whole-round selection: one action for the round, resolved to the same
            per-node calls as picking the rows by hand. Rendered only when a round
            is known — a row the fold could not map to a request has no round to
            select, and offering the button would promise an action it cannot
            perform. */}
        {row.roundSeqs === undefined || row.roundSeqs.length === 0 ? null : (
          <button type="button" className="lc-br-tag"
            title={t('our.prune.roundTip')}
            onClick={(event) => {
              event.stopPropagation()
              if (!window.confirm(t('our.prune.confirm'))) return
              void dispatch('selectPruneRound', { seqs: row.roundSeqs, select: true })
            }}>
            {t('our.prune.round')}
          </button>
        )}
      </>
    )
  }

  /**
   * The tool enable/disable switch, on the tool's own row.
   *
   * This is the TOOL switch (`tools.restrict`): disabling it makes calls fail.
   * It is deliberately distinct from the `tool:<name>` guidance section switch
   * in the system prompt, which only stops that text while the tool stays
   * callable — the two read as one action unless each says what it does.
   */
  const toolRowActions = (toolName: string): ReactNode => {
    const off = deniedTools.has(toolName)
    return (
      <button type="button"
        className={'lc-br-tag' + (off ? ' lc-br-sect-off' : '')}
        title={off ? t('our.toolOffTip') : t('our.toolOnTip')}
        onClick={(event) => {
          event.stopPropagation()
          void dispatch('setToolRestriction', {
            name: toolName,
            filter: off ? {} : { deny: ['*'] },
          })
        }}>
        {off ? t('our.state.off') : t('our.state.on')}
      </button>
    )
  }

  /**
   * Whether a row is inside the selected span.
   *
   * Driven by the SELECTION the host reports, not by local state: the highlight
   * therefore follows a deselection immediately and cannot outlive it, which is
   * what made the earlier version leave a stale red border behind.
   */
  const messageRowMarked = (row: MessageRowRef): boolean => {
    if (pruneSeqs.length === 0) return false
    const start = pruneSeqs[0]
    const end = pruneSeqs[pruneSeqs.length - 1]
    return row.seq >= start && row.seq <= end
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
        messageRowActions,
        messageRowMarked,
        categoryRows,
        categoryHasRows: (category: string) =>
          category === 'inject' && (contexts.length > 0 || injectors.length > 0),
        toolRowActions,
      })}
    </>
  )
}
