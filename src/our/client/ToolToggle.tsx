/**
 * The tool on/off switch the write layer hangs on a Context Browser tool row
 * (decision 1: management UI lives inside the fork's own Context tab).
 *
 * It reads the write layer's settings once and writes through the plugin's own
 * action route; the disabled set is what the engine compiles into
 * `tools.restrict` at the next turn boundary.
 * @module @our/context-panel-write/our/client/ToolToggle
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { dispatchAction, fetchState } from './panel-api'

/** Props: which tool this switch controls, and the session it belongs to. */
export interface ToolToggleProps {
  sessionId: string
  toolName: string
}

/** One tool's visibility switch. */
export function ToolToggle({ sessionId, toolName }: ToolToggleProps): ReactElement {
  const [disabled, setDisabled] = useState<boolean | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const state = await fetchState(sessionId)
      const filter = state.settings?.toolRestrictions?.[toolName]
      setDisabled(filter?.deny?.includes(toolName) === true)
    } catch {
      setDisabled(false)
    }
  }, [sessionId, toolName])

  useEffect(() => { void load() }, [load])

  const toggle = (): void => {
    const next = !(disabled === true)
    setDisabled(next)
    void dispatchAction(sessionId, 'setToolRestriction', { name: toolName, filter: next ? { deny: [toolName] } : { deny: [] } })
  }

  return (
    <button
      type="button"
      className={'lc-br-tag' + (disabled === true ? '' : ' lc-br-tool-plugin')}
      title={disabled === true ? '已禁用：下个回合起模型看不到该工具' : '点击禁用该工具（下个回合生效）'}
      onClick={(event) => { event.stopPropagation(); toggle() }}
    >
      {disabled === true ? '已禁用' : '禁用'}
    </button>
  )
}
