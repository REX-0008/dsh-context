/**
 * The context-management panel: upstream's Context browser with our
 * system-prompt section controls placed above it, inside the same card.
 *
 * This is deliberately "his browser plus our content", not a new list:
 * the browser is rendered by upstream's own `makeContextBrowser` factory with
 * the very props upstream's view passes, so the DNA switch, the step picker
 * ("current / next request"), the estimate-vs-actual totals and the composition
 * bar all behave exactly as they do in upstream's tab. The only addition is the
 * section list on top.
 *
 * Why the section list has to live here: the assembled system prompt is joined
 * into ONE string before it reaches the session log, so a per-section split
 * exists only in-process (our own state route reads it off
 * `systemPrompt.assemble()`). Upstream therefore has no per-section view at all.
 *
 * The data props are the SAME ones upstream's view computes for its browser
 * card; phase 2 (replacing upstream's view wholesale) will supply them from this
 * panel's own plumbing instead of being handed down.
 *
 * @module @our/context-panel-write/our/client/ContextManagementPanel
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { dispatchAction, fetchState, type PanelState, type SectionKind, type SystemSectionInfo } from './panel-api'

/** Human label per source kind. */
const KIND_LABEL: Record<SectionKind, string> = {
  config: '配置',
  preset: '预设',
  plugin: '插件',
}

/** One row's explanatory tooltip, stating how an edit lands. */
const KIND_HINT: Record<SectionKind, string> = {
  config: '我们自己注入的模块：改这里即时生效',
  preset: '预设（agent 配方）注入：改动写回预设文件，新会话生效',
  plugin: '插件注入（dsh 原生同样是插件）：不改插件文件，只在发出前调整',
}

/** Estimated size, matching the host's fixed-density heuristic. */
function sizeOf(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** Props: the session, plus upstream's browser already rendered by the caller. */
export interface ContextManagementPanelProps {
  sessionId: string
  /**
   * Upstream's browser card as a ready element. The caller builds it with the
   * same props upstream's own view passes, so this panel gets that browser
   * verbatim (DNA switch, step picker, totals, composition bar included) rather
   * than a re-implementation of it.
   */
  browser: ReactNode
}

/** The panel: our section controls above upstream's browser, one card. */
export function ContextManagementPanel(props: ContextManagementPanelProps): ReactElement {
  const { sessionId, browser } = props
  const [state, setState] = useState<PanelState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [comparing, setComparing] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
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

  const sections: SystemSectionInfo[] = useMemo(() => state?.systemSections ?? [], [state])

  const dispatch = useCallback(async (action: string, payload?: object): Promise<void> => {
    try {
      await dispatchAction(sessionId, action, payload)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }, [refresh, sessionId])

  const offCount = sections.filter(section => !section.enabled).length

  return (
    <div className="lc-card">
      <div className="lc-card-title">
        <span className="lc-card-title-text">{'上下文管理'}</span>
        <span className="lc-br-tag">{'系统提示词分节'}</span>
        {state?.dirty === true ? <span className="lc-br-tag">{'有未应用的修改'}</span> : null}
        <button type="button" className="lc-gran-btn"
          onClick={() => setCollapsed(value => !value)}>
          {collapsed ? '展开分节' : '收起分节'}
        </button>
      </div>

      {error !== null ? <div className="lc-error">{error}</div> : null}

      {collapsed ? (
        <div className="lc-empty">
          {sections.length === 0
            ? '（开始一轮对话后可列出系统提示词分节）'
            : '共 ' + String(sections.length) + ' 节' + (offCount > 0 ? '，其中 ' + String(offCount) + ' 节已停用' : '')}
        </div>
      ) : null}

      {!collapsed && sections.length === 0 ? (
        <div className="lc-empty">{'（该会话尚未组装过系统提示词：开始一轮对话后这里会列出各分节）'}</div>
      ) : null}

      {!collapsed ? sections.map((section) => {
        const open = editing === section.name
        return (
          <div key={section.name} className="lc-br-elem" style={section.enabled ? undefined : { opacity: 0.5 }}>
            <div className="lc-br-elem-row" title={KIND_HINT[section.kind]}>
              <span className="lc-br-tag">{KIND_LABEL[section.kind]}</span>
              <span className="lc-br-preview">{section.name}</span>
              {section.edited ? <span className="lc-br-tag" title={'已修改：发出去的是你的版本'}>{'已改'}</span> : null}
              {section.originalChanged ? (
                <button type="button" className="lc-br-tag" title={'插件的原文已变化，点击查看对比'}
                  onClick={(event) => { event.stopPropagation(); setComparing(comparing === section.name ? null : section.name) }}>
                  {'原文已变 · 对比'}
                </button>
              ) : null}
              <span className="lc-br-tokens">{'≈' + String(sizeOf(section.text))}</span>
              <input className="lc-br-hits" style={{ width: '5em' }}
                defaultValue={section.weight === undefined ? '' : String(section.weight)}
                title={'排序权重：填数字调整顺序（留空 = 保持原位置）'}
                onBlur={(event) => {
                  const raw = event.target.value.trim()
                  void dispatch('setSectionWeight', { name: section.name, weight: raw === '' ? null : Number(raw) })
                }} />
              <button type="button" className="lc-gran-btn"
                onClick={(event) => { event.stopPropagation(); void dispatch('setGlobalSectionEnabled', { name: section.name, enabled: !section.enabled }) }}>
                {section.enabled ? '停用' : '启用'}
              </button>
              <button type="button" className="lc-gran-btn"
                onClick={(event) => { event.stopPropagation(); setEditing(open ? null : section.name); setDraft(section.text) }}>
                {'编辑'}
              </button>
            </div>

            {comparing === section.name ? (
              <div className="lc-br-content">
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
              </div>
            ) : null}

            {open ? (
              <div className="lc-br-content">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={8}
                  style={{ width: '100%' }} />
                <div>
                  <button type="button" className="lc-gran-btn"
                    onClick={() => { void dispatch('setSectionText', { name: section.name, text: draft, original: section.text }).then(() => setEditing(null)) }}>
                    {'保存'}
                  </button>
                  <button type="button" className="lc-gran-btn" onClick={() => setEditing(null)}>{'取消'}</button>
                </div>
              </div>
            ) : null}
          </div>
        )
      }) : null}

      {/* Upstream's own Context browser: identical to the one in his tab,
          because it IS the same component with the same props. */}
      {browser}
    </div>
  )
}
