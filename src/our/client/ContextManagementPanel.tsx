/**
 * The context-management panel: upstream's Context browser, with its
 * `system` category listing the prompt's own sections.
 *
 * There is no separate layout here on purpose. The assembled system prompt is
 * joined into ONE string before it reaches the log, so upstream can only show
 * that string as a single row; the sections are read in-process instead (our own
 * state route) and handed back to upstream's browser through its `systemRows`
 * hook. The browser then builds each section with its OWN row renderer, so the
 * rows are visually identical to the tool-schema rows — the sections ARE the
 * system prompt's contents, shown one per row, with our on/off switch and edit
 * entry added to the row.
 *
 * Everything else in the card (DNA switch, step picker, estimate-vs-actual
 * totals, composition bar, every other category) is upstream's, untouched.
 *
 * @module @our/context-panel-write/our/client/ContextManagementPanel
 */
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { BrowserRowBuilder } from '../../client/components/browser'
import { dispatchAction, fetchState, type PanelState, type SectionKind, type SystemSectionInfo } from './panel-api'

/** Human label per source kind. */
const KIND_LABEL: Record<SectionKind, string> = {
  config: '配置',
  preset: '预设',
  plugin: '插件',
}

/** Why the source kind matters: it decides how an edit lands. */
const KIND_HINT: Record<SectionKind, string> = {
  config: '我们自己注入的模块：改这里即时生效',
  preset: '预设（agent 配方）注入：改动写回预设文件，新会话生效',
  plugin: '插件注入（dsh 原生同样是插件）：不改插件文件，只在发出前调整',
}

/** Estimated size, matching the host's fixed-density heuristic. */
function sizeOf(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** Props: the session, plus a builder that decorates upstream's browser. */
export interface ContextManagementPanelProps {
  sessionId: string
  /**
   * Builds upstream's browser card, handing back the two hooks this panel fills
   * in. The caller supplies the browser's own props (the ones its view passes);
   * this panel only decides what the `system` category lists.
   */
  browser: (hooks: { systemRows: (row: BrowserRowBuilder) => ReactNode; systemCount: number }) => ReactNode
}

/** The panel: upstream's browser with our section rows in its system category. */
export function ContextManagementPanel({ sessionId, browser }: ContextManagementPanelProps): ReactElement {
  const [state, setState] = useState<PanelState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [comparing, setComparing] = useState<string | null>(null)
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

  /**
   * The section rows, built through the browser's own row renderer so each one
   * carries the same frame, chips and expansion as a tool-schema row. Our
   * controls ride the row's trailing slot and its expanded body.
   */
  const systemRows = (row: BrowserRowBuilder): ReactNode => (
    <>
      {sections.length === 0 ? (
        <div className="lc-br-note">{'该会话尚未组装过系统提示词：开始一轮对话后这里会列出各分节。'}</div>
      ) : null}
      {sections.map((section) => {
        const open = editing === section.name
        const body = (
          <>
            {open ? (
              <>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={10}
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
                  onClick={() => { void dispatch('clearSectionText', { name: section.name }).then(() => setComparing(null)) }}>
                  {'以插件新原文为准（放弃我的修改）'}
                </button>
              </>
            ) : (
              <pre className="lc-br-preview" style={{ whiteSpace: 'pre-wrap' }}>{section.text}</pre>
            )}
          </>
        )
        // The row's trailing slot is where the tool rows carry their plugin and
        // hit chips; ours carry the source tag and the section's controls.
        const trailing = (
          <>
            <span className="lc-br-tag" title={KIND_HINT[section.kind]}>{KIND_LABEL[section.kind]}</span>
            {section.edited ? <span className="lc-br-tag" title={'已修改：发出去的是你的版本'}>{'已改'}</span> : null}
            {section.originalChanged ? (
              <button type="button" className="lc-br-tag" title={'插件的原文已变化，点击查看对比'}
                onClick={(event) => { event.stopPropagation(); setComparing(comparing === section.name ? null : section.name) }}>
                {'原文已变'}
              </button>
            ) : null}
            <input className="lc-br-tag" style={{ width: '3.5em', textAlign: 'center' }}
              title={'排序权重：填数字调整顺序（留空 = 保持原位置）'}
              defaultValue={section.weight === undefined ? '' : String(section.weight)}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                const raw = event.target.value.trim()
                void dispatch('setSectionWeight', { name: section.name, weight: raw === '' ? null : Number(raw) })
              }} />
            <button type="button" className="lc-br-tag"
              title={section.enabled ? '停用：下一轮起不再发出这一段' : '启用：下一轮起重新发出这一段'}
              onClick={(event) => { event.stopPropagation(); void dispatch('setGlobalSectionEnabled', { name: section.name, enabled: !section.enabled }) }}>
              {section.enabled ? '停用' : '启用'}
            </button>
          </>
        )
        return row('sec:' + section.name, null, section.name, sizeOf(section.text), undefined, body, false, trailing)
      })}
    </>
  )

  return (
    <div className="lc-card">
      <div className="lc-card-title">
        <span className="lc-card-title-text">{'上下文管理'}</span>
        {state?.dirty === true ? <span className="lc-br-tag">{'有未应用的修改'}</span> : null}
      </div>
      {error !== null ? <div className="lc-error">{error}</div> : null}
      {browser({ systemRows, systemCount: sections.length })}
    </div>
  )
}
