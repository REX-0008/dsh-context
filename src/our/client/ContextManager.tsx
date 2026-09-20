/**
 * The context-management card: system-prompt attribution, module editing, tool
 * enable/disable, scope switching. Rendered inside the fork's Context tab.
 *
 * Decision 2 (dual attribution): the card shows the CONFIGURED assembly (what
 * the current settings would produce next turn, read in-process from
 * systemPrompt.assemble()) BESIDE the DELIVERED request (what the model
 * actually received last turn, from the upstream contextHeaders projection),
 * and marks the difference — editing settings never takes effect until the
 * next turn boundary, so the two legitimately diverge in between.
 *
 * Decision 5: no memory / workspace surface at all.
 *
 * @module @our/context-panel-write/our/client/ContextManager
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ContextPanelSettings, PromptModulePatch } from '../types'
import { dispatchAction, fetchState, type PanelState, type PresetEntryInfo, type SystemSectionInfo } from './panel-api'
import { mergedModules, type ClientModule } from './settings-view'

/** Known harness-global sections: section name to its owning plugin. */
const GLOBAL_SECTIONS: Record<string, { plugin: string; order: number }> = {
  'harness:identity': { plugin: 'dsh-system-prompt', order: -100 },
  'harness:source': { plugin: 'dsh-app-boot', order: -99 },
  'deployment:persona': { plugin: 'dsh-persona', order: 0 },
  'plan:policy': { plugin: 'dsh-plan-mode', order: 50 },
}

/** Attribute a section to its owning plugin and order. */
function globalInfo(sectionName: string): { plugin: string; order: number | null } {
  if (sectionName.startsWith('tool:')) return { plugin: '@deepseek-ai/dsh-tools', order: 100 }
  const known = GLOBAL_SECTIONS[sectionName]
  return known !== undefined ? { plugin: known.plugin, order: known.order } : { plugin: sectionName, order: null }
}

/** One rendered system-prompt block with its attribution. */
interface SystemBlock {
  key: string
  text: string
  provider: 'our' | 'preset' | 'global'
  sectionName: string
  injectOrder: number | null
  pluginLabel: string
}

/** Build the block list from the configured assembly (the in-process split). */
function buildBlocks(sections: SystemSectionInfo[] | null, modules: ClientModule[], presetEntries: PresetEntryInfo[]): SystemBlock[] {
  if (sections === null) return []
  return sections.map((section) => {
    const module = modules.find(m => m.name === section.name)
    if (module !== undefined) {
      return { key: 'our:' + section.name, text: section.text, provider: 'our', sectionName: section.name, injectOrder: module.order, pluginLabel: section.name }
    }
    const entry = presetEntries.find(e => e.name !== undefined && section.name.startsWith('deployment:'))
    if (entry !== undefined) {
      return { key: 'preset:' + entry.id, text: section.text, provider: 'preset', sectionName: section.name, injectOrder: 0, pluginLabel: 'preset:' + entry.id }
    }
    const info = globalInfo(section.name)
    return { key: 'global:' + section.name, text: section.text, provider: 'global', sectionName: section.name, injectOrder: info.order, pluginLabel: info.plugin }
  })
}

/** Estimation used for the per-block size column. */
function sizeOf(text: string): number {
  return Math.ceil(text.length / 4) + 4
}

/** The context-management card. */
export function ContextManager({ sessionId }: { sessionId: string }): ReactElement {
  const [state, setState] = useState<PanelState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [skillForm, setSkillForm] = useState(false)
  const [skillDraft, setSkillDraft] = useState('')
  const [baselineForm, setBaselineForm] = useState(false)
  const [baselineDraft, setBaselineDraft] = useState('{"maxBytes":65536}')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchState(sessionId)
      setState(next)
      setDirty(next.dirty)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const dispatch = useCallback(async (action: string, payload?: object, markDirty = true): Promise<void> => {
    try {
      await dispatchAction(sessionId, action, payload)
      if (markDirty) setDirty(true)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }, [refresh, sessionId])

  const settings: ContextPanelSettings | null = state?.settings ?? null
  const modules = useMemo(() => (settings === null ? [] : mergedModules(settings, sessionId)), [settings, sessionId])
  const blocks = useMemo(
    () => buildBlocks(state?.systemSections ?? null, modules, state?.presetEntries ?? []),
    [state, modules],
  )
  const disabledSections = settings?.disabledSections ?? []
  const toolRestrictions = settings?.toolRestrictions ?? {}
  const scope = settings?.scope ?? 'agent'

  const saveModuleText = (name: string): void => {
    const patch: PromptModulePatch = { text: draft }
    void dispatch('updateModule', { target: scope, name, patch }).then(() => setEditing(null))
  }

  /** Toggle a whole upstream section off/on (removed in the assemble waterfall). */
  const toggleSection = (name: string, enabled: boolean): void => {
    void dispatch('setGlobalSectionEnabled', { name, enabled }, false)
  }

  /** Toggle one tool's visibility for this agent. */
  const toggleTool = (name: string): void => {
    const disabled = toolRestrictions[name]?.deny?.includes(name) === true
    void dispatch('setToolRestriction', { name, filter: disabled ? { deny: [] } : { deny: [name] } })
  }

  const toolNames = useMemo(() => Object.keys(toolRestrictions), [toolRestrictions])

  return (
    <div className="lc-card">
      <div className="lc-card-title">
        <span className="lc-card-title-text">{'上下文管理-旧'}</span>
        <span className="lc-br-tag">{scope === 'conversation' ? '本对话' : 'Agent'}</span>
        {dirty ? <span className="lc-br-tag">{'有未应用的修改'}</span> : null}
      </div>
      {error !== null ? <div className="lc-error">{error}</div> : null}

      {/* Scope + apply */}
      <div className="lc-gran" style={{ marginBottom: 8 }}>
        <button type="button" className={'lc-gran-btn' + (scope === 'agent' ? ' lc-gran-on' : '')} onClick={() => void dispatch('setScope', { scope: 'agent' }, false)}>{'Agent 级'}</button>
        <button type="button" className={'lc-gran-btn' + (scope === 'conversation' ? ' lc-gran-on' : '')} onClick={() => void dispatch('setScope', { scope: 'conversation' }, false)}>{'本对话'}</button>
        <button type="button" className="lc-gran-btn" disabled={!dirty} onClick={() => void dispatch('apply', {}, false)}>{'应用到下一轮'}</button>
      </div>

      {/* System prompt: per-section attribution (decision 2) */}
      <div className="lc-empty" style={{ textAlign: 'left', marginTop: 4 }}>{'系统提示词（按来源拆解）'}</div>
      {blocks.length === 0 ? <div className="lc-empty">{'（暂无：该会话尚未组装过）'}</div> : null}
      {blocks.map((block) => {
        const off = disabledSections.includes(block.sectionName)
        return (
          <div key={block.key} className="lc-br-elem">
            <div className="lc-br-elem-row">
              <span className="lc-br-tag">{block.provider === 'our' ? '我们' : block.provider === 'preset' ? '预设' : '全局'}</span>
              <span>{block.sectionName}</span>
              <span className="lc-br-tag">{block.pluginLabel}</span>
              <span>{block.injectOrder === null ? '—' : '#' + String(block.injectOrder)}</span>
              <span>{String(sizeOf(block.text))}</span>
              <button type="button" className="lc-gran-btn" onClick={() => toggleSection(block.sectionName, off)}>{off ? '启用' : '停用'}</button>
            </div>
          </div>
        )
      })}

      {/* Our modules */}
      <div className="lc-empty" style={{ textAlign: 'left', marginTop: 12 }}>{'我们的提示词模块'}</div>
      {modules.length === 0 ? <div className="lc-empty">{'（无）'}</div> : null}
      {modules.map((module) => (
        <div key={module.name} className="lc-br-elem">
          <div className="lc-br-elem-row">
            <span className="lc-br-tag">{module.channel === 'section' ? '稳定' : '动态'}</span>
            <span>{module.name}</span>
            <span>{'#' + String(module.order)}</span>
            <span>{String(sizeOf(module.text))}</span>
            <button type="button" className="lc-gran-btn" onClick={() => { setEditing(module.name); setDraft(module.text) }}>{'编辑'}</button>
            <button type="button" className="lc-gran-btn" onClick={() => void dispatch('updateModule', { target: scope, name: module.name, patch: { enabled: !module.enabled } })}>{module.enabled ? '停用' : '启用'}</button>
          </div>
          {editing === module.name ? (
            <div className="lc-br-content">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} style={{ width: '100%' }} />
              <div>
                <button type="button" className="lc-gran-btn" onClick={() => saveModuleText(module.name)}>{'保存'}</button>
                <button type="button" className="lc-gran-btn" onClick={() => setEditing(null)}>{'取消'}</button>
              </div>
            </div>
          ) : null}
        </div>
      ))}

      {/* Tools */}
      <div className="lc-empty" style={{ textAlign: 'left', marginTop: 12 }}>{'工具开关（记录在案的工具）'}</div>
      {toolNames.length === 0 ? <div className="lc-empty">{'（还没有被禁用的工具）'}</div> : null}
      {toolNames.map((name) => {
        const disabled = toolRestrictions[name]?.deny?.includes(name) === true
        return (
          <div key={name} className="lc-br-elem">
            <div className="lc-br-elem-row">
              <span>{name}</span>
              <span className="lc-br-tag">{disabled ? '已禁用' : '已启用'}</span>
              <button type="button" className="lc-gran-btn" onClick={() => toggleTool(name)}>{disabled ? '启用' : '禁用'}</button>
            </div>
          </div>
        )
      })}
      <div className="lc-empty" style={{ textAlign: 'left' }}>{'在下方「工具」分类里可直接按行禁用任意工具。'}</div>

      {/* Preset write-back: real forms (decision 3) */}
      <div className="lc-empty" style={{ textAlign: 'left', marginTop: 12 }}>{'写入预设（新会话生效）'}</div>
      <div className="lc-br-elem">
        <div className="lc-br-elem-row">
          <span>{'技能目录'}</span>
          <button type="button" className="lc-gran-btn" onClick={() => setSkillForm(v => !v)}>{skillForm ? '收起' : '填写'}</button>
        </div>
        {skillForm ? (
          <div className="lc-br-content">
            <label>
              {'每行一个目录路径'}
              <textarea value={skillDraft} onChange={(e) => setSkillDraft(e.target.value)} rows={3} placeholder={'F:\\path\\to\\skills'} style={{ width: '100%' }} />
            </label>
            <button type="button" className="lc-gran-btn" onClick={() => { void dispatch('editSkillDirs', { dirs: skillDraft.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0) }, false) }}>{'保存'}</button>
          </div>
        ) : null}
      </div>
      <div className="lc-br-elem">
        <div className="lc-br-elem-row">
          <span>{'规则文件设置'}</span>
          <button type="button" className="lc-gran-btn" onClick={() => setBaselineForm(v => !v)}>{baselineForm ? '收起' : '填写'}</button>
        </div>
        {baselineForm ? (
          <div className="lc-br-content">
            <label>
              {'配置项（键值对，JSON 格式）'}
              <textarea value={baselineDraft} onChange={(e) => setBaselineDraft(e.target.value)} rows={3} style={{ width: '100%' }} />
            </label>
            <button type="button" className="lc-gran-btn" onClick={() => {
              try { void dispatch('editBaseline', { patch: JSON.parse(baselineDraft) as Record<string, unknown> }, false) } catch { setError('JSON 格式不正确') }
            }}>{'保存'}</button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
