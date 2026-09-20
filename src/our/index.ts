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
import type { ContextPanelSettings } from './types'

/** Wiring refs the routes read lazily (settings/webServer inject asynchronously). */
interface Wiring {
  scope?: SettingsScope<ContextPanelSettings>
  service?: ContextPanelService
  engine?: ContextAssemblerService
}

/** GET /api/context-panel-write/state — settings + dirty + section attribution. */
function stateHandler(wiring: Wiring) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const { scope, engine } = wiring
      // Per-section assembly (the ONLY source of section-level truth: the
      // rendered system message is already joined into one string before it is
      // logged, so the split is read in-process from systemPrompt.assemble()).
      const systemSections = engine === undefined ? null : await engine.assembleSectionsForSession(sessionId)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        value: {
          settings: scope === undefined ? null : scope.get(),
          dirty: engine === undefined ? false : engine.isDirty(sessionId),
          presetEntries: engine === undefined ? [] : engine.presetEntriesForSession(sessionId),
          systemSections,
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
      await handler({ service, scope, sessionId: parsed.sessionId ?? '', p: parsed.payload ?? {} })
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
      engine.setConfigReader(() => scope.get())
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
