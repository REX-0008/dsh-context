/**
 * ErrorBoundary — the tab's no-white-screen guarantee: a render error in the
 * subtree degrades to a styled error card instead of propagating into the
 * harness's slot renderer and unmounting the conversation view. Class
 * component: the only React primitive that can catch a subtree's render errors
 * (no hook-based boundary in React 18); Retry resets the boundary and a healthy
 * value resumes.
 *
 * The card names the component that threw. A boundary showing only the message
 * leaves a reported failure as "Cannot read properties of undefined (reading
 * 'length')" with no way to tell which of the plugin's many folds produced it —
 * the reporter can read the culprit straight off the card instead.
 */

import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import type { Translate } from '../i18n'

/**
 * The throwing component's own frame from a React component stack.
 *
 * The framework's frames (the boundary itself, the slot outlet above it) sit at
 * the top and would always be the answer, so they are skipped. An absent stack,
 * or one naming nothing else, yields the empty string — the card then hides the
 * line (see the `:empty` rule with the other error styles).
 * @param componentStack - React's `ErrorInfo.componentStack`, when the host provided one.
 * @returns the culprit frame, or the empty string when the stack names none.
 */
export function culpritOf(componentStack: string | undefined | null): string {
  if (typeof componentStack !== 'string') return ''
  for (const raw of componentStack.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('at ErrorBoundary')) continue
    return line
  }
  return ''
}

export function makeErrorBoundary(t: Translate): ComponentType<{ children?: ReactNode }> {
  return class ErrorBoundary extends Component<{ children?: ReactNode }, { error: Error | null; where: string }> {
    constructor(props: { children?: ReactNode }) {
      super(props)
      this.state = { error: null, where: '' }
    }

    static getDerivedStateFromError(error: unknown): { error: Error | null; where: string } {
      return { error: error instanceof Error ? error : new Error(String(error)), where: '' }
    }

    /** React hands the component stack here, never to `getDerivedStateFromError`. */
    componentDidCatch(_error: unknown, info: ErrorInfo): void {
      this.setState({ where: culpritOf(info.componentStack) })
    }

    render(): ReactNode {
      const error = this.state.error
      if (error === null) return this.props.children
      return (
        <div className="lc-root">
          <div className="lc-empty lc-error">
            <span>{t('error')}</span>
            <code className="lc-error-msg">{error.message}</code>
            <code className="lc-error-where">{this.state.where}</code>
            <button
              type="button"
              className="lc-error-retry hover:border-(--dsw-alias-label-primary)"
              onClick={() => { this.setState({ error: null, where: '' }) }}
            >{t('error.retry')}</button>
          </div>
        </div>
      )
    }
  }
}
