/**
 * Our write layer (context management) mounted on the dsh-context fork.
 *
 * Kept physically separate from upstream files so `git diff upstream` stays
 * reviewable and every upstream insert point stays enumerable (see PATCHES.md).
 *
 * Responsibilities:
 * - settings namespace `context-panel-write` (module text/channel/order/enabled,
 *   per-conversation overlays, tool restrictions, disabled sections);
 * - the engine: registers our system-prompt sections/contexts per agent, filters
 *   disabled sections in the assemble waterfall, applies tool restrictions, and
 *   defers re-registration to the next turn boundary;
 * - the `contextSections` projection (our per-section attribution view);
 * - web routes `/api/context-panel-write/{state,action}` (the browser half's
 *   read/write channel; the harness settings RPC only exposes a whitelist).
 *
 * @module @our/context-panel-write/our
 */
import type { Context } from '@deepseek-ai/cordis'
// Declares the two agent lifecycle events we listen to, locally (see the module).
import './agent-events'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-host-webserver'
// No compaction type import: the capability is optional and its package name is
// not resolvable from every install, so the `compaction/summary` guard below
// compares by string instead of relying on the merged event table.
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { CONTEXT_PANEL_NS, CONTEXT_PANEL_SCHEMA, DEFAULT_SETTINGS } from './panel/settings'
import { createPanelService, type ContextPanelService } from './panel/panel-service'
import type { ContextAssemblerService } from './assembler/service'
import { ContextAssemblerEngine } from './assembler/engine'
import { createSectionRegistry, type SectionRegistry } from './section-registry'
import { KNOWN_SECTIONS_SOURCE, knownSectionOf } from './known-sections'
import type { ContextPanelSettings } from './types'

/** Wiring refs the routes read lazily (settings/webServer inject asynchronously). */
interface Wiring {
  scope?: SettingsScope<ContextPanelSettings>
  service?: ContextPanelService
  engine?: ContextAssemblerService
  sections?: SectionRegistry
}

/**
 * Classify a section by where it comes from, which decides how an edit must be
 * applied: our own modules are edited in our settings; preset-injected sections
 * are written back to the preset file (next session); everything else is a
 * plugin's text and is adjusted on the way out, never in the plugin's file.
 * @param name - the section name as the assembly reports it.
 * @returns the source kind.
 */
function inferKind(name: string): 'preset' | 'plugin' {
  // Preset-mounted plugins contribute named sections (deployment:* is the
  // persona line; plan:* comes from the plan-mode row). Anything else is a
  // plugin/native section, which is the majority and the adjust-on-send case.
  return name.startsWith('deployment:') ? 'preset' : 'plugin'
}

/** GET /api/context-panel-write/state — settings + dirty + section attribution. */
/**
 * Resolve one section's placement and owner.
 *
 * Live observation wins (it is the truth for anything registered after this
 * plugin mounted); the generated table fills the boot-time sections it cannot
 * see. When both know the section and their orders disagree, the table is stale
 * — the panel surfaces that as a warning rather than silently showing a number
 * that no longer matches the real order.
 * @param registry - the live observation registry, when composed.
 * @param name - the section name.
 * @param index - the section's position in the delivered order (0-based).
 * @returns the resolved origin, its source, and a staleness flag.
 */
function resolveOrigin(registry: SectionRegistry | undefined, name: string, index: number): {
  order?: number
  plugin?: string
  from: 'observed' | 'table' | 'none'
  staleTable: boolean
} {
  const seen = registry?.originOf(name)
  const known = knownSectionOf(name)
  if (seen !== undefined) {
    return {
      order: seen.order,
      ...(seen.plugin !== undefined ? { plugin: seen.plugin } : (known !== undefined ? { plugin: known.plugin } : {})),
      from: 'observed',
      staleTable: known !== undefined && known.order !== seen.order,
    }
  }
  if (known !== undefined) return { order: known.order, plugin: known.plugin, from: 'table', staleTable: false }
  // Nothing knows it: report the position it actually arrived at, marked as
  // unattributed, instead of inventing a number.
  return { from: 'none', staleTable: false, order: undefined, ...(index >= 0 ? {} : {}) }
}

function stateHandler(wiring: Wiring) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const { scope, engine } = wiring
      // Per-section assembly (the ONLY source of section-level truth: the
      // rendered system message is already joined into one string before it is
      // logged, so the split is read in-process from systemPrompt.assemble()).
      const sections = engine === undefined ? null : await engine.assembleSectionsForSession(sessionId)
      const value = scope === undefined ? null : scope.get()
      // Decorate each section for the panel: source kind, whether it is
      // currently suppressed, whether its text was edited, and — when the
      // plugin has since changed the original — that the backup no longer
      // matches (which is what offers a comparison).
      const disabled = new Set(value?.disabledSections ?? [])
      const overrides = value?.sectionOverrides?.[sessionId] ?? {}
      const weights = value?.sectionWeights?.[sessionId] ?? {}
      const originals = value?.sectionOriginals?.[sessionId] ?? {}
      const ownModules = new Set(
        engine === undefined ? [] : engine.getModuleViewForSession(sessionId).map(m => m.name),
      )
      const systemSections = sections === null ? null : sections.map((section, index) => {
        const origin = resolveOrigin(wiring.sections, section.name, index)
        const edited = overrides[section.name] !== undefined
        const backup = originals[section.name]
        // "Changed" compares the ONE stored backup against the plugin's CURRENT
        // text: the backup is what the text looked like when it was edited, so a
        // difference means the plugin moved on underneath our edit.
        const originalChanged = edited && backup !== undefined && backup !== section.text
        return {
          name: section.name,
          text: edited ? (overrides[section.name] as string) : section.text,
          kind: ownModules.has(section.name) ? 'config' as const : inferKind(section.name),
          enabled: !disabled.has(section.name),
          edited,
          originalChanged,
          // Placement/owner resolved above: observed live, filled from the
          // generated table, or unknown. `staleTable` means the table disagrees
          // with the live order, i.e. the table needs regenerating.
          ...(origin.order === undefined ? {} : { order: origin.order }),
          ...(origin.plugin === undefined ? {} : { plugin: origin.plugin }),
          originFrom: origin.from,
          staleTable: origin.staleTable,
          /** The plugin's current text, delivered only for the comparison. */
          ...(originalChanged ? { originalText: section.text } : {}),
          weight: weights[section.name],
        }
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        value: {
          settings: scope === undefined ? null : scope.get(),
          dirty: engine === undefined ? false : engine.isDirty(sessionId),
          presetEntries: engine === undefined ? [] : engine.presetEntriesForSession(sessionId),
          systemSections,
          /** Where the fallback table was generated from (shown in the panel). */
          knownSectionsSource: KNOWN_SECTIONS_SOURCE,
        },
      }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
  }
}

/** Loose payload shape (the browser half sends what it sends). */
type ActionPayload = Record<string, unknown>

/** One action handler. */
interface ActionContext {
  service: ContextPanelService
  scope: SettingsScope<ContextPanelSettings>
  sessionId: string
  p: ActionPayload
  engine?: ContextAssemblerService
}
type ActionHandler = (ac: ActionContext) => void | Promise<void>

/** Action table (a new action is one entry). */
const ACTION_HANDLERS: Record<string, ActionHandler> = {
  updateModule: ({ service, p, sessionId }) => service.updateModule(p.target as 'conversation' | 'agent', String(p.name), p.patch as never, sessionId),
  sync: ({ service, sessionId }) => service.syncConversationToAgent(sessionId),
  setToolRestriction: ({ service, p }) => service.setToolRestriction(String(p.name), p.filter as never),
  setScope: ({ service, p }) => service.setScope(p.scope as 'conversation' | 'agent'),
  setAutoSyncPreset: ({ service, p }) => service.setAutoSyncPreset(p.enabled === true),
  setPanelWidth: ({ scope, p }) => scope.update({ panelWidth: typeof p.width === 'number' ? p.width : 720 }),
  setGlobalSectionEnabled: ({ scope, p }) => {
    const name = typeof p.name === 'string' ? p.name : ''
    const enabled = p.enabled === true
    const current = new Set(scope.get().disabledSections ?? [])
    if (enabled) current.delete(name)
    else current.add(name)
    return scope.update({ disabledSections: [...current] })
  },
  /**
   * Edit one section's text. The first edit also stores a backup of the
   * plugin's original; later edits keep that single backup (the panel only
   * needs one "what it used to be" per section).
   */
  setSectionText: async ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const text = String(p.text ?? '')
    const value = scope.get()
    const overrides = { ...(value.sectionOverrides ?? {}) }
    const session = { ...(overrides[sessionId] ?? {}) }
    session[name] = text
    overrides[sessionId] = session
    const originals = { ...(value.sectionOriginals ?? {}) }
    const sessionOriginals = { ...(originals[sessionId] ?? {}) }
    if (typeof p.original === 'string' && sessionOriginals[name] === undefined) {
      sessionOriginals[name] = p.original
    }
    originals[sessionId] = sessionOriginals
    await scope.update({ sectionOverrides: overrides, sectionOriginals: originals })
  },
  /** Drop an edit: the plugin's own text is used again (its backup goes too). */
  clearSectionText: async ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const value = scope.get()
    const overrides = { ...(value.sectionOverrides ?? {}) }
    const session = { ...(overrides[sessionId] ?? {}) }
    delete session[name]
    overrides[sessionId] = session
    const originals = { ...(value.sectionOriginals ?? {}) }
    const sessionOriginals = { ...(originals[sessionId] ?? {}) }
    delete sessionOriginals[name]
    originals[sessionId] = sessionOriginals
    await scope.update({ sectionOverrides: overrides, sectionOriginals: originals })
  },
  /**
   * Accept the plugin's current text as the new baseline after a comparison:
   * the edit is dropped and the backup is replaced, so the reminder clears.
   */
  acceptSectionOriginal: async ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const value = scope.get()
    const overrides = { ...(value.sectionOverrides ?? {}) }
    const session = { ...(overrides[sessionId] ?? {}) }
    delete session[name]
    overrides[sessionId] = session
    const originals = { ...(value.sectionOriginals ?? {}) }
    const sessionOriginals = { ...(originals[sessionId] ?? {}) }
    delete sessionOriginals[name]
    originals[sessionId] = sessionOriginals
    await scope.update({ sectionOverrides: overrides, sectionOriginals: originals })
  },
  /**
   * Write an edited preset section's text back into the preset file (the only
   * kind that CAN be written back; a plugin's file is not ours). Effective for
   * sessions created after this, per the preset's next-session semantics.
   */
  writeBackPreset: ({ scope, p, sessionId, engine }) => {
    const name = String(p.name)
    const text = scope.get().sectionOverrides?.[sessionId]?.[name]
    if (typeof text !== 'string' || engine === undefined) return
    // The engine owns the preset file edit (line-level, so the rest of the
    // composition survives).
    engine.writeSectionBackToPreset(name, text, sessionId)
  },
  /**
   * Accept the plugin's CURRENT original as the comparison baseline, keeping the
   * user's edit: the backup is replaced, so the "original changed" reminder
   * clears while the user's version stays in force.
   */
  refreshSectionBaseline: async ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const original = typeof p.original === 'string' ? p.original : ''
    const value = scope.get()
    const originals = { ...(value.sectionOriginals ?? {}) }
    const sessionOriginals = { ...(originals[sessionId] ?? {}) }
    sessionOriginals[name] = original
    originals[sessionId] = sessionOriginals
    await scope.update({ sectionOriginals: originals })
  },
  /** Set (or clear, with null) one section's ordering weight. */
  setSectionWeight: async ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const value = scope.get()
    const weights = { ...(value.sectionWeights ?? {}) }
    const session = { ...(weights[sessionId] ?? {}) }
    if (p.weight === null || p.weight === undefined) delete session[name]
    else session[name] = Number(p.weight)
    weights[sessionId] = session
    await scope.update({ sectionWeights: weights })
  },
  apply: ({ service, sessionId }) => service.applyChanges(sessionId),
  editSkillDirs: ({ service, p, sessionId }) => service.editSkillDirs((p.dirs as string[] | undefined) ?? [], sessionId),
  editBaseline: ({ service, p, sessionId }) => service.editBaselineConfig((p.patch as Record<string, unknown> | undefined) ?? {}, sessionId),
  clearOverrides: ({ scope, sessionId }) => {
    const value = scope.get()
    const rest: Record<string, Record<string, unknown>> = { ...(value.conversationOverrides ?? {}) }
    delete rest[sessionId]
    return scope.update({ conversationOverrides: rest })
  },
}

/** POST /api/context-panel-write/action — dispatch one browser action. */
function actionHandler(wiring: Wiring) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    let body = ''
    for await (const chunk of req) body += chunk
    let parsed: { action?: string; sessionId?: string; payload?: Record<string, unknown> }
    try {
      parsed = JSON.parse(body === '' ? '{}' : body) as typeof parsed
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
      return
    }
    const { service, scope } = wiring
    if (service === undefined || scope === undefined) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'context-panel-write not ready' }))
      return
    }
    const handler = ACTION_HANDLERS[parsed.action ?? '']
    if (handler === undefined) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `unknown action ${String(parsed.action)}` }))
      return
    }
    try {
      await handler({ service, scope, sessionId: parsed.sessionId ?? '', p: parsed.payload ?? {}, ...(wiring.engine === undefined ? {} : { engine: wiring.engine }) })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
  }
}

/**
 * Mount the write layer. Called from the fork's host entry (one line).
 * @param ctx - plugin root context.
 */
export function applyOur(ctx: Context): void {
  ctx.effect(() => {
    const wiring: Wiring = {}
    const disposeCore = ctx.inject(['settings', 'sessionProjections'], (sctx) => {
      const scope = sctx.settings.register(CONTEXT_PANEL_NS as never, CONTEXT_PANEL_SCHEMA as never, {
        base: DEFAULT_SETTINGS,
        applies: 'live',
      }) as unknown as SettingsScope<ContextPanelSettings>
      const engine = new ContextAssemblerEngine()
      // The engine resolves agents on demand (an agent created before this
      // plugin mounted still resolves), so it needs the host context.
      engine.setHostContext(ctx)
      engine.setConfigReader(() => scope.get())
      // Live section-origin observation (placement order + registering package):
      // the assemble interface carries neither, so they are captured at the
      // registration call instead.
      wiring.sections = createSectionRegistry(ctx)
      const service = createPanelService(ctx, () => scope, engine)
      const disposeProvide = ctx.provide('contextPanelWrite', service)
      const disposeEngineProvide = ctx.provide('contextAssemblerWrite', engine)
      wiring.scope = scope
      wiring.service = service
      wiring.engine = engine
      // Listeners registered inside this effect are disposed with it (the
      // registration rides the calling fiber), so only the explicit disposers
      // returned below need collecting here.
      ctx.on('agent/created', ({ agent }) => { engine.registerForAgent(agent) })
      ctx.on('agent/inbox/inserted', ({ agent }) => { engine.applyPending(agent) })
      ctx.on('session/event', (session, event) => {
        // Compared by string: the compaction capability is optional, so its
        // event type may not be part of SessionEventMap in this build.
        if ((event.type as string) === 'compaction/summary') engine.markPending(session.id)
      })
      return () => {
        disposeProvide()
        disposeEngineProvide()
        engine.dispose()
      }
    })
    ctx.inject(['webServer'], (wctx) => {
      const disposeState = wctx.webServer.register({
        kind: 'exact',
        path: '/api/context-panel-write/state',
        handler: stateHandler(wiring),
      })
      const disposeAction = wctx.webServer.register({
        kind: 'exact',
        path: '/api/context-panel-write/action',
        handler: actionHandler(wiring),
      })
      return () => {
        disposeState()
        disposeAction()
      }
    })
    // `ctx.inject` returns the injection fiber (not a callable disposer); the
    // outer effect's own teardown removes both children automatically.
    return () => { void disposeCore }
  })
}
