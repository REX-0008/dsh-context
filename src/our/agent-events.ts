/**
 * Local declarations for the agent lifecycle events this layer listens to.
 *
 * Why declare them here instead of importing `@deepseek-ai/dsh-agent`: the same
 * reason upstream declares `agent/pre-step` locally (host/stepIdentity.ts) —
 * importing the agent package's declarations conflicts with that narrow shim and
 * breaks the build. The payloads below are structurally narrowed to the one
 * field used (`agent`), which is all this layer needs and keeps it independent
 * of the harness version's agent surface.
 * @module @our/context-panel-write/our/agent-events
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentFace } from './agent-face'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A new agent was created (its scope context is live). */
    'agent/created'(this: Context, payload: { agent: AgentFace }): void
    /** One message entered a live inbox — the turn boundary we apply on. */
    'agent/inbox/inserted'(this: Context, payload: { agent: AgentFace }): void
  }
}
