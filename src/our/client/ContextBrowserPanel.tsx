/**
 * The context-management panel: upstream's Context browser shell with our
 * section controls on top.
 *
 * Layout (top to bottom):
 * 1. **Our system-prompt section list** — one row per section, in upstream's own
 *    row style, carrying the source tag (config / preset / plugin), an editable
 *    ordering weight, the section's size, an on/off switch and an edit entry.
 * 2. Upstream's **Context browser** below it, unchanged: that is the "what the
 *    model actually received" record, and it is what makes this panel a full
 *    replacement for upstream's own tab.
 *
 * Why the split: the assembled system prompt is joined into ONE string before
 * it reaches the log, so the per-section split exists only in-process (the
 * plugin's own state route reads it off `systemPrompt.assemble()`). Upstream has
 * no per-section view at all — everything above the browser is our addition.
 *
 * @module @our/context-panel-write/our/client/ContextBrowserPanel
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
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

/** Props: the session this panel is looking at. */
export interface ContextBrowserPanelProps {
  sessionId: string
}

/** The panel (his browser shell + our section controls). */
export function ContextBrowserPanel({ sessionId }: ContextBrowserPanelProps): ReactElement {
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

  const sections: SystemSectionInfo[] = useMemo(() => state?.systemSections ?? [], [state])

  const dispatch = useCallback(async (action: string, payload?: object): Promise<void> => {
    try {
      await dispatchAction(sessionId, action, payload)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }, [refresh, sessionId])

  const toggle = (section: SystemSectionInfo): void => {
    void dispatch('setGlobalSectionEnabled', { name: section.name, enabled: !section.enabled }, )
  }

  const saveEdit = (section: SystemSectionInfo): void => {
    void dispatch('setSectionText', { name: section.name, text: draft, original: section.text })
      .then(() => setEditing(null))
  }

  const clearEdit = (section: SystemSectionInfo): void => {
    void dispatch('clearSectionText', { name: section.name }).then(() => { setComparing(null); setEditing(null) })
  }

  const setWeight = (section: SystemSectionInfo, raw: string): void => {
    const trimmed = raw.trim()
    void dispatch('setSectionWeight', { name: section.name, weight: trimmed === '' ? null : Number(trimmed) })
  }

  return (
    <div className="lc-card">
      <div className="lc-card-title">
        <span className="lc-card-title-text">{'上下文管理'}</span>
        <span className="lc-br-tag">{'系统提示词分节'}</span>
        {state?.dirty === true ? <span className="lc-br-tag">{'有未应用的修改'}</span> : null}
      </div>

      {error !== null ? <div className="lc-error">{error}</div> : null}

      {sections.length === 0 ? (
        <div className="lc-empty">{'（该会话尚未组装过系统提示词：开始一轮对话后这里会列出各分节）'}</div>
      ) : null}

      {sections.map((section) => {
        const open = editing === section.name
        return (
          <div key={section.name} className={'lc-br-elem' + (section.enabled ? '' : ' lc-br-cat-empty')}
            style={section.enabled ? undefined : { opacity: 0.55 }}>
            <div className="lc-br-elem-row" title={KIND_HINT[section.kind]}>
              <span className="lc-br-chev" />
              <span className="lc-br-tag">{KIND_LABEL[section.kind]}</span>
              <span className="lc-br-preview">{section.name}</span>
              {section.edited ? <span className="lc-br-tag" title={'已修改过：发出去的是你的版本'}>{'已改'}</span> : null}
              {section.originalChanged ? (
                <button type="button" className="lc-br-tag"
                  title={'插件的原文已变化，点击查看对比'}
                  onClick={(event) => { event.stopPropagation(); setComparing(comparing === section.name ? null : section.name) }}>
                  {'原文已变 · 对比'}
                </button>
              ) : null}
              <span className="lc-br-tokens">{'≈' + String(sizeOf(section.text))}</span>
              <input
                className="lc-br-hits"
                style={{ width: '5em' }}
                defaultValue={section.weight === undefined ? '' : String(section.weight)}
                title={'排序权重：填数字即可调整顺序（留空 = 保持原位置）'}
                onBlur={(event) => setWeight(section, event.target.value)}
              />
              <button type="button" className="lc-gran-btn"
                onClick={(event) => { event.stopPropagation(); toggle(section) }}>
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
                <button type="button" className="lc-gran-btn" onClick={() => clearEdit(section)}>
                  {'以插件新原文为准（放弃我的修改）'}
                </button>
              </div>
            ) : null}

            {open ? (
              <div className="lc-br-content">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={8}
                  style={{ width: '100%' }} />
                <div>
                  <button type="button" className="lc-gran-btn" onClick={() => saveEdit(section)}>{'保存'}</button>
                  <button type="button" className="lc-gran-btn" onClick={() => setEditing(null)}>{'取消'}</button>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}

      <div className="lc-empty">{'上面的开关只决定"发不发出去"；下方是模型实际收到的原文。'}</div>
    </div>
  )
}
