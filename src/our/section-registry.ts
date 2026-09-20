/**
 * Live observation of prompt-section registrations: which section, at what
 * placement order, registered by which plugin.
 *
 * Why interception instead of asking the harness: `assemble()` hands listeners
 * `{ name, text }` only — the order and the owner are not carried on the
 * assembled section (verified against packages/core/system-prompt). The one
 * place both facts exist together is the `systemPrompt.section(…)` call, whose
 * argument carries `order` and whose caller's fiber names the registering
 * package. This module wraps that method (the same technique the upstream
 * tool-attribution hook uses for `tools.register`) and records what it sees.
 *
 * Known limit, shared with upstream's own tool attribution: only registrations
 * that happen AFTER this plugin mounts are observed. Sections the harness
 * registers during boot are invisible here and fall back to known-sections.ts;
 * the panel flags the fallback rather than pretending it observed them.
 *
 * @module @our/context-panel-write/our/section-registry
 */
import type { Context } from '@deepseek-ai/cordis'

/** One observed registration. */
export interface SectionOrigin {
  /** Placement order the registrant asked for. */
  order: number
  /** The registering plugin (its fiber name), when resolvable. */
  plugin?: string
}

/** What this registry exposes to the rest of the plugin. */
export interface SectionRegistry {
  /**
   * Record one section's origin.
   * @param name - section name.
   * @param order - the order the registrant passed.
   * @param plugin - the registrant's fiber name.
   */
  note(name: string, order: number, plugin: string | undefined): void
  /**
   * Look one section's origin up.
   * @param name - section name.
   * @returns the observed origin, or undefined when this plugin never saw it register.
   */
  originOf(name: string): SectionOrigin | undefined
}

/** A section registration argument, narrowed to what is read here. */
interface SectionArgument {
  name?: unknown
  order?: unknown
}

/** The systemPrompt face as far as this module touches it. */
interface SystemPromptFace {
  section?: unknown
}

/**
 * Install the interception on the calling plugin's context.
 *
 * The wrapper is installed once per systemPrompt service instance and rides the
 * calling fiber: unload restores the original method, so no other plugin is left
 * running through a dead hook.
 * @param ctx - the plugin's root context.
 * @returns the registry the panel reads origins from.
 */
export function createSectionRegistry(ctx: Context): SectionRegistry {
  const observed = new Map<string, SectionOrigin>()
  const wrapped = new WeakSet<object>()
  const restores: Array<() => void> = []
  // This plugin's own fiber name: its registrations are ours, not third-party
  // ones, and the panel derives "config" sections from the module view anyway.
  const self = ctx.fiber.name
  let lastReader: Context | undefined

  const wrapInstance = (systemPrompt: unknown): void => {
    if (systemPrompt === null || typeof systemPrompt !== 'object' || wrapped.has(systemPrompt)) return
    const original = (systemPrompt as SystemPromptFace).section
    if (typeof original !== 'function') return
    wrapped.add(systemPrompt)
    const instance = systemPrompt as { section: (section: SectionArgument) => unknown }
    const wrappedSection = function (this: unknown, section: SectionArgument): unknown {
      const name = section?.name
      const order = section?.order
      if (typeof name === 'string' && typeof order === 'number') {
        // The caller's fiber names the registering package. `lastReader` is the
        // context that just read the service (the registrant), which is more
        // reliable than the stack when a loader-mediated caller is in play.
        const owner = lastReader?.fiber.name
        observed.set(name, {
          order,
          ...(owner === undefined || owner === 'root' || owner === self ? {} : { plugin: owner }),
        })
      }
      return (original as (section: SectionArgument) => unknown).call(this, section)
    }
    instance.section = wrappedSection
    restores.push(() => {
      if (instance.section === wrappedSection) {
        instance.section = original as (section: SectionArgument) => unknown
      }
    })
  }

  // The service is reached through the context proxy; this hook is where its
  // live instance becomes visible (upstream's attribution hook uses the same
  // event for `tools`).
  ctx.on('internal/get' as never, ((reader: Context, name: string, _error: unknown, next: () => unknown) => {
    if (name !== 'systemPrompt') return next()
    const value = next()
    lastReader = reader
    wrapInstance(value)
    return value
  }) as never)

  ctx.effect(() => () => {
    for (const restore of restores.splice(0)) restore()
  }, 'context-panel-write: section registry restore')

  // An instance already composed before this plugin started is wrapped too, so
  // later registrations are still captured.
  try {
    const existing = ctx.get('systemPrompt', false) as unknown
    wrapInstance(existing)
  } catch {
    // No systemPrompt composed in this deployment: the registry stays empty and
    // the panel falls back to the generated table.
  }

  return {
    note(name, order, plugin) {
      observed.set(name, { order, ...(plugin === undefined ? {} : { plugin }) })
    },
    originOf(name) {
      return observed.get(name)
    },
  }
}
