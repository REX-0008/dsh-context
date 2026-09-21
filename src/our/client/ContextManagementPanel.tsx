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
import { dispatchAction, fetchState, type PanelState, type SectionKind, type SystemSectionInfo } from './panel-api'

/**
 * The source kinds. Each kind changes differently, which is what the row's left
 * tag states:
 * - `config`: our own module — the persisted edit IS its source;
 * - `preset`: injected by an agent preset — its file can be written back, next session;
 * - `plugin`: a plugin's (or the harness's) text — its file is not ours to change,
 *   so the original is backed up and compared instead.
 */
const KIND_LABEL: Record<SectionKind, string> = {
  config: '配置',
  preset: '预设',
  plugin: '插件',
}

/** Why the source kind matters: it decides where a change finally lands. */
const KIND_HINT: Record<SectionKind, string> = {
  config: '本插件注入：本地持久化就是它的源，改完下一轮即生效',
  preset: '预设注入：先落本地持久化；要回到预设本身，点「写回预设」（新会话生效）',
  plugin: '插件注入（dsh 原生同样是插件）：源文件不归我们改，只改发出内容；原提示词已备份，供对比',
}

/** Estimated size, matching the host's fixed-density heuristic. */
function sizeOf(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** Props: the session, plus a builder that decorates upstream's browser. */
export interface ContextManagementPanelProps {
  sessionId: string
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
  }) => ReactNode
}

/** The panel: upstream's browser with our section rows in its system category. */
export function ContextManagementPanel({ sessionId, browser }: ContextManagementPanelProps): ReactElement {
  const [state, setState] = useState<PanelState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [comparing, setComparing] = useState<string | null>(null)
  const [weightOpen, setWeightOpen] = useState<string | null>(null)
  const [weightDraft, setWeightDraft] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

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
          {'正在查看历史时点：编辑功能只在当前对话有效，无法追溯修改旧对话。切回「当前」即可编辑。'}
        </div>
      ) : null}
      {stale && !atPastStep ? (
        <div className="lc-br-note" title={'实际排序与内置对照表的数值不一致，表需要按当前 dsh 版本重新生成'}>
          {'⚠ 内置对照表与实际排序不一致（对照表生成自 ' + String(state?.knownSectionsSource ?? '未知版本') + '），橙色数值表示该行需要核对。'}
        </div>
      ) : null}
      {sections.length === 0 && !atPastStep ? (
        <div className="lc-br-note">{'该会话尚未组装过系统提示词：开始一轮对话后这里会列出各分节。'}</div>
      ) : null}

      {/* The category's own filter toolbar, mounted even when nothing matches so
          the filter can always be cleared. */}
      {atPastStep || sections.length === 0 ? null : toolbar(query, setQuery)}
      {sections.length > 0 && shown.length === 0 ? (
        <div className="lc-br-note">{'没有匹配的分节。'}</div>
      ) : null}
      {/* Scoped so the token-column alignment below applies to OUR rows only:
          upstream's tool/message rows keep their original figure width. */}
      <div className="lc-our-sections">
      {(atPastStep ? [] : shown).map((section) => {
        const open = editing === section.name
        const weightEdited = section.weight !== undefined
        const weightValue = weightEdited ? section.weight : section.order

        // The expanded body: upstream's own chrome (head + line count + 原文 /
        // Markdown switch + copy) with our actions in the same head group, in
        // the order 原文 · Markdown · 编辑 · (写回预设 / 还原).
        const extra = (
          <>
            {section.kind === 'preset' ? (
              <button type="button" className="lc-rich-seg-btn"
                title={'把当前文本写回预设文件；新会话生效'}
                onClick={(event) => { event.stopPropagation(); void dispatch('writeBackPreset', { name: section.name }) }}>
                {'写回预设'}
              </button>
            ) : null}
            {section.edited ? (
              <button type="button" className="lc-rich-seg-btn" title={'放弃修改，恢复插件原文'}
                onClick={(event) => { event.stopPropagation(); void dispatch('clearSectionText', { name: section.name }) }}>
                {'还原'}
              </button>
            ) : null}
            <button type="button" className={'lc-rich-seg-btn' + (open ? ' lc-rich-seg-on' : '')}
              title={'直接修改这一段文本'}
              onClick={(event) => {
                event.stopPropagation()
                if (open) setEditing(null)
                else { setDraft(section.text); setEditing(section.name); setComparing(null) }
              }}>
              {'编辑'}
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
                {'保存'}
              </button>
              <button type="button" className="lc-gran-btn" onClick={() => setEditing(null)}>{'取消'}</button>
            </div>
          </>
        ) : comparing === section.name ? (
          <>
            <div className="lc-cols">
              <div className="lc-col">
                <div className="lc-empty" style={{ textAlign: 'left' }}>{'你的版本（正在发出）'}</div>
                <pre className="lc-br-preview" style={{ whiteSpace: 'pre-wrap' }}>{section.text}</pre>
              </div>
              <div className="lc-col">
                <div className="lc-empty" style={{ textAlign: 'left' }}>{'插件现在的原文'}</div>
                <pre className="lc-br-preview" style={{ whiteSpace: 'pre-wrap' }}>{section.originalText ?? ''}</pre>
              </div>
            </div>
            <button type="button" className="lc-gran-btn"
              onClick={() => { void dispatch('refreshSectionBaseline', { name: section.name, original: section.originalText }).then(() => setComparing(null)) }}>
              {'以新原文为基准（保留我的修改）'}
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
              <span className="lc-br-tag lc-br-tool-plugin" title={'来源插件'}>{section.plugin}</span>
            ) : (
              <span className="lc-br-tag lc-br-sect-unknown" title={'未观测到注册来源（该分节在本插件挂载前注册，且不在内置对照表中）'}>
                {'来源未知'}
              </span>
            )}
            {section.edited ? <span className="lc-br-tag lc-br-sect-edited" title={'已修改：发出的是你的版本'}>{'已改'}</span> : null}
            {section.originalChanged ? (
              <button type="button" className="lc-br-tag lc-br-sect-edited" title={'插件的原文已变化，点击查看对比'}
                onClick={(event) => { event.stopPropagation(); setComparing(comparing === section.name ? null : section.name) }}>
                {'原文已变'}
              </button>
            ) : null}
            {weightOpen === section.name ? (
              <input className="lc-br-tag" style={{ width: '4.5em', textAlign: 'center' }}
                autoFocus value={weightDraft}
                title={weightEdited && section.order !== undefined
                  ? '原本权重 ' + String(section.order) + '（半透明显示在输入框内）'
                  : '排序权重'}
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
                  ? '内置对照表与实际排序不一致，此数值需核对'
                  : weightEdited
                    ? '已改权重（原本 ' + String(section.order ?? '—') + '），点击修改'
                    : section.order === undefined ? '权重未知，点击设置' : '排序权重，点击修改'}
                onClick={(event) => { event.stopPropagation(); setWeightDraft(weightValue === undefined ? '' : String(weightValue)); setWeightOpen(section.name) }}>
                {weightValue === undefined ? '—' : String(weightValue)}
              </button>
            )}
            {/* Three states, because two disable levels exist (the deployment
                level is not managed here). Clicking cycles 已启用 → 对话禁用 →
                预设禁用 → 已启用, and the tooltip names the current level. */}
            <button type="button"
              className={'lc-br-tag' + (section.disabledAt === undefined ? '' : ' lc-br-sect-off')}
              title={section.disabledAt === 'preset'
                ? '预设禁用：只要用这个预设的对话都不再发送这一段（不卸载插件，只停发提示词）。点击改为只在当前对话禁用'
                : section.disabledAt === 'conversation'
                  ? '对话禁用：只在当前对话不发送这一段，其他对话不受影响。点击改为预设级禁用'
                  : '已启用：这一段正常发送。点击改为只在当前对话禁用'}
              onClick={(event) => {
                event.stopPropagation()
                const next = section.disabledAt === undefined
                  ? { level: 'conversation' as const, off: true }
                  : section.disabledAt === 'conversation'
                    ? { level: 'preset' as const, off: true }
                    : { level: 'conversation' as const, off: false }
                void dispatch('setSectionLevel', { name: section.name, ...next })
              }}>
              {section.disabledAt === 'preset' ? '预设禁用' : section.disabledAt === 'conversation' ? '对话禁用' : '已启用'}
            </button>
          </>
        )

        // The left tag slot states the SOURCE KIND (how a change lands) — the same
        // slot surface rows use for their kind tag; an edited section's tag turns
        // brand-coloured as the reminder.
        const kindTag = (
          <i className={'lc-br-kind' + (section.edited ? ' lc-br-kind-edited' : '')}>{KIND_LABEL[section.kind]}</i>
        )
        // The token figure goes in its own column (the row's `tokens` slot, which
        // right-aligns and now pads to a fixed width); the preview stays the name.
        return row('sec:' + section.name, kindTag, section.name, sizeOf(section.text), undefined, bodyNode, false, trailing)
      })}
      </div>
    </>
    )
  }

  // No card of our own: the panel IS the browser (its system category lists the
  // prompt's sections), so the title is retitled in place rather than framed by
  // a second card.
  return (
    <>
      {error !== null ? <div className="lc-error">{error}</div> : null}
      {browser({
        systemRows,
        systemCount: sections.length,
        deliveredLabel: '当前实际发送系统提示词（所有修改落实后才会更新）',
      })}
    </>
  )
}
