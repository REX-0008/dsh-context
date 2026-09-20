/**
 * The agent face this write layer consumes, declared STRUCTURALLY.
 *
 * Why not import the real `Agent` type: upstream's plugin deliberately never
 * imports `@deepseek-ai/dsh-agent`, and pulling that package's declarations into
 * the program introduces the harness's real `agent/pre-step` event signature,
 * which then conflicts with the narrow local shim upstream declares in
 * host/stepIdentity.ts (the build failed only once our layer was added). The
 * layer below needs exactly two members, so it declares them and stays
 * independent of the harness version's agent surface.
 * @module @our/context-panel-write/our/agent-face
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * The minimal agent face used here: an id (also the session id) and its scoped
 * cordis context (which carries `systemPrompt` and `tools`).
 */
export interface AgentFace {
  readonly id: string
  readonly ctx: Context
}
