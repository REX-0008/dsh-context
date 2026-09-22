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
 * The minimal agent face used here: an id (also the session id), its scoped
 * cordis context (which carries `systemPrompt` and `tools`), and the idle
 * maintenance seam.
 *
 * `runMaintenance` is declared because pruning must NOT run while a turn is in
 * flight: it mutates the session surface. That seam runs one task from the true
 * idle phase, keeps later waking input in the inbox until the task settles, and
 * throws synchronously when a turn or another maintenance task already owns the
 * agent.
 */
export interface AgentFace {
  readonly id: string
  readonly ctx: Context
  /**
   * Run one non-turn maintenance task from the idle phase.
   * @param task - the operation, given a signal aborted by agent cancellation.
   * @returns the task's own result.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}
