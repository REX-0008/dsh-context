/**
 * The context-management panel: upstream's Context browser, with its
 * `system` category listing the prompt's own sections.
 *
 * There is no layout of our own here on purpose. The assembled system prompt is
 * joined into ONE string before it reaches the log, so upstream can only show
 * that string as a single row; the sections are read in-process instead (our own
 * state route) and handed back to upstream's browser through its `systemRows`
 * hook, which draws each one with the SAME row renderer the tool-schema rows
 * use. The sections therefore read as what they are — the system prompt's own
 * contents, one per row — with our controls riding the row's trailing slot.
 *
 * Everything else in the card (DNA switch, step picker, estimate-vs-actual
 * totals, composition bar, every other category) is upstream's, untouched.
 *
 * @module @our/context-panel-write/our/client/ContextManagementPanel
 */
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { BrowserRowBuilder } from '../../client/components/browser'
import type { RichKit } from '../../client/components/richText'
import { dispatchAction, fetchState, type PanelState, type SectionKind, type SystemSectionInfo } from './panel-api'

/**
 * The source kinds, in the order the explanation column lists them. Each kind
 * changes differently, which is what the left tag states:
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

/**
 * Token figures share one width so the right edge lines up. The widest realistic
 * figure is `888k`, hence four digit slots plus the `≈`.
 */
function tokenFigure(tokens: number): string {
  const text = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens)
  return '≈' + text.padStart(4, ' ')
}

/** Props: the session, plus a builder that decorates upstream's browser. */
export interface ContextManagementPanelProps {
  sessionId: string
  /**
   * Builds upstream's browser card, handing back the two hooks this panel fills
   * in. The caller supplies the browser's own props; this panel only decides what
   * the `system` category lists.
   */
  browser: (hooks: {
    systemRows: (row: BrowserRowBuilder) => ReactNode
    systemCount: number
    /** Label for the delivered-prompt row the browser keeps below the split list. */
    deliveredLabel: string
  }) => ReactNode
  /**
   * Upstream's rich-text kit (raw line numbers / rendered Markdown / copy). Used
   * for the section body so the "MD preview" view is the SAME renderer the
   * browser's own detail sections use, not a second markdown implementation.
   */
  rich: RichKit
}

/** The panel: upstream's browser with our section rows in its system category. */
export function ContextManagementPanel({ sessionId, browser, rich }: ContextManagementPanelProps): ReactElement {
  const [state, setState] = useState<PanelState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [comparing, setComparing] = useState<string | null>(null)
  // Per-section body mode: 'md' renders the section's text, 'edit' swaps in the
  // editor. Held per section so switching one row never disturbs another.
  const [bodyMode, setBodyMode] = useState<Record<string, 'md' | 'edit'>>({})
  // Per-section render mode for the body ('md' renders, 'raw' shows the source).
  const [richMode, setRichMode] = useState<Record<string, 'md' | 'raw'>>({})
  const [weightOpen, setWeightOpen] = useState<string | null>(null)
  const [weightDraft, setWeightDraft] = useState('')
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

  /**
   * The section rows, built through the browser's own row renderer so each one
   * carries the same frame, chips and expansion as a tool-schema row.
   */
  const systemRows = (row: BrowserRowBuilder): ReactNode => (
    <>
      {stale ? (
        <div className="lc-br-note" title={'实际排序与内置对照表的数值不一致，表需要按当前 dsh 版本重新生成'}>
          {'⚠ 内置对照表与实际排序不一致（对照表生成自 ' + String(state?.knownSectionsSource ?? '未知版本') + '），橙色数值表示该行需要核对。'}
        </div>
      ) : null}
      {sections.length === 0 ? (
        <div className="lc-br-note">{'该会话尚未组装过系统提示词：开始一轮对话后这里会列出各分节。'}</div>
      ) : null}
      {sections.map((section) => {
        const open = editing === section.name
        const weightEdited = section.weight !== undefined
        const weightValue = weightEdited ? section.weight : section.order
        const body = (
          <>
            {open ? (
              <>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={12}
                  style={{ width: '100%' }} />
                <div>
                  <button type="button" className="lc-gran-btn"
                    onClick={() => { void dispatch('setSectionText', { name: section.name, text: draft, original: section.text }).then(() => setEditing(null)) }}>
                    {'保存'}
                  </button>
                  <button type="button" className="lc-gran-btn" onClick={() => setEditing(null)}>{'取消'}</button>
                  {section.kind === 'preset' ? (
                    <button type="button" className="lc-gran-btn"
                      title={'把当前文本写回预设文件；新会话生效'}
                      onClick={() => { void dispatch('writeBackPreset', { name: section.name }) }}>
                      {'写回预设'}
                    </button>
                  ) : null}
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
            ) : bodyMode[section.name] === 'edit' ? (
              <>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={12}
                  style={{ width: '100%' }} />
                <div>
                  <button type="button" className="lc-gran-btn"
                    onClick={() => { void dispatch('setSectionText', { name: section.name, text: draft, original: section.text }).then(() => setBodyMode(m => ({ ...m, [section.name]: 'md' }))) }}>
                    {'保存'}
                  </button>
                  <button type="button" className="lc-gran-btn"
                    onClick={() => setBodyMode(m => ({ ...m, [section.name]: 'md' }))}>
                    {'取消'}
                  </button>
                  {section.kind === 'preset' ? (
                    <button type="button" className="lc-gran-btn"
                      title={'把当前文本写回预设文件；新会话生效'}
                      onClick={() => { void dispatch('writeBackPreset', { name: section.name }) }}>
                      {'写回预设'}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              // The body renders through upstream's own rich text (rendered
              // Markdown, or raw when switched), so a section reads exactly like
              // any other detail section in this browser.
              <rich.RichText text={section.text} mode={richMode[section.name] ?? 'md'} />
            )}
            {comparing !== section.name ? (
              <div>
                <button type="button" className={'lc-gran-btn' + (bodyMode[section.name] === 'edit' ? ' lc-gran-on' : '')}
                  title={'直接修改这一段文本'}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (bodyMode[section.name] === 'edit') setBodyMode(m => ({ ...m, [section.name]: 'md' }))
                    else { setDraft(section.text); setBodyMode(m => ({ ...m, [section.name]: 'edit' })) }
                  }}>
                  {'编辑'}
                </button>
                <button type="button" className={'lc-gran-btn' + (bodyMode[section.name] !== 'edit' && (richMode[section.name] ?? 'md') === 'md' ? ' lc-gran-on' : '')}
                  title={'以渲染后的 Markdown 预览这一段'}
                  onClick={(event) => {
                    event.stopPropagation()
                    setBodyMode(m => ({ ...m, [section.name]: 'md' }))
                    setRichMode(m => ({ ...m, [section.name]: 'md' }))
                  }}>
                  {'MD 预览'}
                </button>
                <button type="button" className={'lc-gran-btn' + (bodyMode[section.name] !== 'edit' && richMode[section.name] === 'raw' ? ' lc-gran-on' : '')}
                  title={'查看未经渲染的原文'}
                  onClick={(event) => {
                    event.stopPropagation()
                    setBodyMode(m => ({ ...m, [section.name]: 'md' }))
                    setRichMode(m => ({ ...m, [section.name]: 'raw' }))
                  }}>
                  {'原文'}
                </button>
                {section.edited ? (
                  <button type="button" className="lc-gran-btn" title={'放弃修改，恢复插件原文'}
                    onClick={(event) => { event.stopPropagation(); void dispatch('clearSectionText', { name: section.name }) }}>
                    {'还原'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )
        // The row's trailing slot is where tool rows carry their plugin and hit
        // chips; ours carry the plugin chip, the weight control and the switch.
        const trailing = (
          <>
            {section.plugin !== undefined ? (
              <span className="lc-br-tag lc-br-tool-plugin" title={'来源插件'}>{section.plugin}</span>
            ) : null}
            {section.edited ? <span className="lc-br-tag lc-br-sect-edited" title={'已修改：发出的是你的版本'}>{'已改'}</span> : null}
            {section.originalChanged ? (
              <button type="button" className="lc-br-tag lc-br-sect-edited" title={'插件的原文已变化，点击查看对比'}
                onClick={(event) => { event.stopPropagation(); setComparing(comparing === section.name ? null : section.name) }}>
                {'原文已变'}
              </button>
            ) : null}
            {weightOpen === section.name ? (
              <input className="lc-br-tag" style={{ width: '5em', textAlign: 'center' }}
                autoFocus
                value={weightDraft}
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
                style={{ width: '5em', textAlign: 'center' }}
                title={section.staleTable
                  ? '内置对照表与实际排序不一致，此数值需核对'
                  : weightEdited
                    ? '已改权重（原本 ' + String(section.order ?? '—') + '），点击修改'
                    : section.order === undefined ? '权重未知，点击设置' : '排序权重，点击修改'}
                onClick={(event) => { event.stopPropagation(); setWeightDraft(weightValue === undefined ? '' : String(weightValue)); setWeightOpen(section.name) }}>
                {weightValue === undefined ? '—' : String(weightValue)}
              </button>
            )}
            <button type="button" className={'lc-br-tag' + (section.enabled ? '' : ' lc-br-sect-off')}
              title={section.enabled ? '下一轮起不再发出这一段' : '下一轮起重新发出这一段'}
              onClick={(event) => { event.stopPropagation(); void dispatch('setGlobalSectionEnabled', { name: section.name, enabled: !section.enabled }) }}>
              {section.enabled ? '已启用' : '已停用'}
            </button>
          </>
        )
        // The left tag slot states the SOURCE KIND (how a change lands), the
        // same slot the surface rows use for their kind tag; an edited section's
        // tag turns brand-coloured as the reminder. The right side carries the
        // registering plugin's chip and the controls.
        const kindTag = (
          <i className={'lc-br-kind' + (section.edited ? ' lc-br-kind-edited' : '')}>{KIND_LABEL[section.kind]}</i>
        )
        return row('sec:' + section.name, kindTag, section.name + '  ' + tokenFigure(sizeOf(section.text)), 0, undefined, body, false, trailing)
      })}

      {/* The delivered prompt stays a row of its own, drawn by the browser
          below this list (see its `deliveredLabel`), so "what I configured" and
          "what was actually sent" sit in one column. */}
    </>
  )

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
