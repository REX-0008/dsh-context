/**
 * Where this plugin's data file lives: the active PROFILE's data directory.
 *
 * The profile's name is not fixed (desktop / web / anything), and it is not this
 * plugin's business to guess it. The host answers: `profileContext` is provided by
 * `apps/cli/src/profile-boot.ts` BEFORE any config-tree entry is mounted, so it is
 * already readable in `apply`. A sibling fork plugin resolved the same path this
 * way and proved it in production (`dsh-todo-board`'s `uiDefaultDir`).
 *
 * Two fallbacks, in this order, and the order matters:
 * 1. `profileContext.dir` — the host's own answer;
 * 2. `DSH_PROFILE` + `<DSH_HOME>/profiles/<name>/data` — for a deployment that
 *    composes no `profileContext` (an older dsh line, or a test stub);
 * 3. `<DSH_HOME>/data` — last resort, so a write never lands somewhere wild.
 *
 * What is deliberately NOT used:
 * - `process.env.DSH_PROFILE` as the PRIMARY source: the harness sets it for the
 *   MODEL's shell calls, not for the plugin process;
 * - `import.meta.url`: Node resolves symlinks, and this plugin is reached through
 *   the profile's `node_modules` link, so it would resolve into its own checkout;
 * - a hard-coded profile name: the one earlier releases assumed does not exist on
 *   the desktop.
 * @module @our/context-panel/panel/data-dir
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** This plugin's directory name under the profile's data root. */
export const DATA_DIR_NAME = 'context-panel-write'

/** The definitions file's name inside {@link DATA_DIR_NAME}. */
export const MODULES_FILE_NAME = 'modules.json'

/** The harness home, as the environment names it (falls back to the user's home). */
function homeRoot(): string {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : homedir()
}

/** The `profileContext` service face, as far as this plugin consumes it. */
export interface ProfileContextFace {
  /** The active profile's directory, absolute. */
  dir?: unknown
}

/**
 * The active profile's data directory.
 * @param ctx - the plugin context; a test stub may compose no `profileContext`.
 * @returns the absolute directory (not created here).
 */
export function dataDirOf(ctx: unknown): string {
  const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  const profile = typeof get === 'function' ? get.call(ctx, 'profileContext') as ProfileContextFace | undefined : undefined
  const dir = profile?.dir
  if (typeof dir === 'string' && dir.trim() !== '') return join(dir, 'data', DATA_DIR_NAME)
  const name = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  if (name !== '') return join(homeRoot(), 'profiles', name, 'data', DATA_DIR_NAME)
  return join(homeRoot(), 'data', DATA_DIR_NAME)
}

/**
 * The module-definitions file's absolute path.
 * @param ctx - the plugin context.
 * @returns the path (not created here).
 */
export function modulesFileOf(ctx: unknown): string {
  return join(dataDirOf(ctx), MODULES_FILE_NAME)
}
