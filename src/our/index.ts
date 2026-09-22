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
import { presetEntryForSection } from './preset/section-entries'
import { SEED_MODULES } from './preset/seeds'
import type { ContextPanelSettings } from './types'

/** Wiring refs the routes read lazily (settings/webServer inject asynchronously). */
interface Wiring {
  scope?: SettingsScope<ContextPanelSettings>
  service?: ContextPanelService
  engine?: ContextAssemblerService
  sections?: SectionRegistry
  /** Host capabilities reused by this layer (see {@link OurHostBridge}). */
  bridge?: OurHostBridge
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
  // A section is "preset" only when a preset ENTRY actually owns it — that is
  // what makes a write-back possible. A bare prefix test would claim sections no
  // entry can write (`deployment:persona` is never registered; only the
  // -prefix/-suffix pair is), and the panel would offer a write-back that
  // silently does nothing.
  return presetEntryForSection(name) === undefined ? 'plugin' : 'preset'
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
function resolveOrigin(
  registry: SectionRegistry | undefined,
  name: string,
  index: number,
  registered?: Record<string, number>,
  toolOwnerOf?: (name: string) => string | undefined,
): {
  order?: number
  plugin?: string
  from: 'observed' | 'table' | 'none'
  staleTable: boolean
} {
  const seen = registry?.originOf(name)
  const known = knownSectionOf(name)
  // The registry read is the widest source (it holds every registration's own
  // argument, boot-time ones included); it outranks the stale generated table.
  const real = registered?.[name]
  if (seen === undefined && real !== undefined) {
    return {
      order: real,
      ...(known !== undefined ? { plugin: known.plugin } : {}),
      from: 'observed',
      staleTable: known !== undefined && known.order !== real,
    }
  }
  if (seen !== undefined) {
    return {
      order: seen.order,
      ...(seen.plugin !== undefined ? { plugin: seen.plugin } : (known !== undefined ? { plugin: known.plugin } : {})),
      from: 'observed',
      staleTable: known !== undefined && known.order !== seen.order,
    }
  }
  // A tool-guidance section is named `tool:<tool>`, so the host's own
  // tool→plugin attribution answers for it — the same resolver the tool row
  // uses, which covers third-party and MCP providers the table cannot know.
  const toolName = name.startsWith('tool:') ? name.slice('tool:'.length) : undefined
  const ownedBy = toolName === undefined ? undefined : toolOwnerOf?.(toolName)
  if (known !== undefined) {
    return { order: known.order, plugin: ownedBy ?? known.plugin, from: 'table', staleTable: false }
  }
  if (ownedBy !== undefined) {
    return { order: undefined, plugin: ownedBy, from: 'observed', staleTable: false }
  }
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
      // Two disable levels the panel owns: this conversation, and the preset it
      // runs on (a section off for a preset is off in every conversation using
      // it). The deployment level exists but is deliberately not managed here.
      const conversationOff = new Set(value?.conversationDisabledSections?.[sessionId] ?? [])
      // The preset NAME (what the panel shows) and the per-preset off list.
      const presetId = engine === undefined ? undefined : engine.presetIdForSession(sessionId)
      const presetOff = new Set(presetId === undefined ? [] : (value?.presetDisabledSections?.[presetId] ?? []))
      const overrides = value?.sectionOverrides?.[sessionId] ?? {}
      const weights = value?.sectionWeights?.[sessionId] ?? {}
      const originals = value?.sectionOriginals?.[sessionId] ?? {}
      const moduleView = engine === undefined ? [] : engine.getModuleViewForSession(sessionId)
      const ownModules = new Map(moduleView.map(module => [module.name, module]))
      // The registry read is the widest source, so it is fetched once per request
      // rather than per section.
      const registeredOrders = engine === undefined ? {} : engine.registeredOrdersForSession(sessionId)
      // The declared runtime contexts: same assembly, same waterfall as sections.
      const contexts = engine === undefined ? null : await engine.contextsForSession(sessionId)
      const systemSections = sections === null ? null : sections.map((section, index) => {
        const origin = resolveOrigin(wiring.sections, section.name, index, registeredOrders, wiring.bridge?.toolOwnerOf)
        // "Edited" means different things per kind, because the write path
        // differs. Our own module's body IS the record, so an edit shows up as a
        // body that no longer matches its seeded default; every other kind keeps
        // a local override, so its presence is the marker.
        const own = ownModules.get(section.name)
        const seeded = SEED_MODULES[section.name]?.text
        const edited = own !== undefined
          ? seeded !== undefined && own.text !== seeded
          : overrides[section.name] !== undefined
        const backup = originals[section.name]
        // "Changed" compares the ONE stored backup against the plugin's CURRENT
        // text: the backup is what the text looked like when it was edited, so a
        // difference means the plugin moved on underneath our edit. Only the
        // kinds that keep a backup can report this.
        const originalChanged = backup !== undefined && overrides[section.name] === undefined
          ? false
          : edited && backup !== undefined && backup !== section.text
        return {
          name: section.name,
          // Our own module's text already IS the edited text (the section was
          // rendered from that body); only the other kinds are overridden here.
          text: own !== undefined
            ? section.text
            : (overrides[section.name] as string | undefined) ?? section.text,
          kind: ownModules.has(section.name) ? 'config' as const : inferKind(section.name),
          // Tri-state, naming which level switched it off so the panel can say
          // so rather than showing a bare "off".
          enabled: !conversationOff.has(section.name) && !presetOff.has(section.name),
          ...(presetOff.has(section.name)
            ? { disabledAt: 'preset' as const }
            : conversationOff.has(section.name) ? { disabledAt: 'conversation' as const } : {}),
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
          /** The preset this conversation runs on (labels the preset-level state). */
          ...(presetId === undefined ? {} : { presetId }),
          /**
           * Whether a prune is parked for the next turn boundary. The panel uses
           * it to show the pending banner and to offer cancellation.
           */
          prunePending: engine === undefined ? false : engine.hasPendingPrune(sessionId),
          /** The declared runtime contexts (name/order/text) for this conversation. */
          contexts,
          /** Injection source kinds seen in this conversation's step batches. */
          observedInjections: engine === undefined ? [] : engine.observedInjectionsForSession(sessionId),
          /** Injection kinds the user has suppressed here. */
          suppressedInjections: value?.suppressedInjections?.[sessionId] ?? [],
          /**
           * How many sections each source holds for this session. The panel
           * lists one merged view, so when it looks short this names which
           * source came up short instead of leaving it to guesswork.
           */
          sectionSources: {
            listed: sections === null ? 0 : sections.length,
            registry: Object.keys(registeredOrders).length,
          },
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
  /**
   * Park a prune for the next turn boundary. Nothing is pruned here — the
   * panel's warning ("takes effect next turn, irreversible") describes exactly
   * this window, and the request stays cancellable until it runs.
   */
  requestPrune: ({ engine, sessionId }) => engine?.requestPrune(sessionId),
  /** Drop a parked prune before its boundary arrives. */
  cancelPrune: ({ engine, sessionId }) => { engine?.cancelPrune(sessionId) },
  /**
   * Switch one RUNTIME CONTEXT off (or back on) for this conversation.
   *
   * Contexts take the same two decisions as sections but are keyed separately,
   * so they need their own action rather than sharing `setSectionLevel`.
   */
  setContextLevel: ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const all = { ...(scope.get().conversationDisabledContexts ?? {}) }
    const mine = new Set(all[sessionId] ?? [])
    if (p.off === true) mine.add(name)
    else mine.delete(name)
    all[sessionId] = [...mine]
    return scope.update({ conversationDisabledContexts: all })
  },
  /** Replace one runtime context's text for this conversation. */
  setContextText: async ({ scope, p, sessionId }) => {
    const name = String(p.name)
    const all = { ...(scope.get().contextOverrides ?? {}) }
    const mine = { ...(all[sessionId] ?? {}) }
    mine[name] = String(p.text ?? '')
    all[sessionId] = mine
    await scope.update({ contextOverrides: all })
  },
  /**
   * Suppress (or restore) one injection source at the pre-step boundary.
   *
   * The list is per conversation and matched on the message's own
   * `source.kind`/`source.plugin`: an injection is per-step input, so it has no
   * preset-level form.
   */
  setInjectionSuppressed: ({ scope, p, sessionId }) => {
    const kind = String(p.kind)
    const all = { ...(scope.get().suppressedInjections ?? {}) }
    const mine = new Set(all[sessionId] ?? [])
    if (p.off === true) mine.add(kind)
    else mine.delete(kind)
    all[sessionId] = [...mine]
    return scope.update({ suppressedInjections: all })
  },
  setToolRestriction: ({ service, p }) => service.setToolRestriction(String(p.name), p.filter as never),
  setScope: ({ service, p }) => service.setScope(p.scope as 'conversation' | 'agent'),
  setAutoSyncPreset: ({ service, p }) => service.setAutoSyncPreset(p.enabled === true),
  setPanelWidth: ({ scope, p }) => scope.update({ panelWidth: typeof p.width === 'number' ? p.width : 720 }),
  /**
   * Set one section's state at ONE level.
   *
   * `level: 'conversation'` affects this conversation only; `level: 'preset'`
   * affects every conversation running the same preset. Disabling stops the
   * section's TEXT from being sent — it does not unload the plugin that
   * registered it.
   */
  setSectionLevel: ({ scope, p, sessionId, engine }) => {
    const name = typeof p.name === 'string' ? p.name : ''
    const level = p.level === 'preset' ? 'preset' : 'conversation'
    const off = p.off === true
    const value = scope.get()
    if (level === 'conversation') {
      const all = { ...(value.conversationDisabledSections ?? {}) }
      const mine = new Set(all[sessionId] ?? [])
      if (off) mine.add(name)
      else mine.delete(name)
      all[sessionId] = [...mine]
      return scope.update({ conversationDisabledSections: all })
    }
    const presetId = engine?.presetIdForSession(sessionId)
    // Without a preset there is nothing to scope a preset-level switch to.
    if (presetId === undefined) return
    const all = { ...(value.presetDisabledSections ?? {}) }
    const mine = new Set(all[presetId] ?? [])
    if (off) mine.add(name)
    else mine.delete(name)
    all[presetId] = [...mine]
    return scope.update({ presetDisabledSections: all })
  },
  /**
   * Edit one section's text. The first edit also stores a backup of the
   * plugin's original; later edits keep that single backup (the panel only
   * needs one "what it used to be" per section).
   */
  setSectionText: async ({ scope, p, sessionId, service, engine }) => {
    const name = String(p.name)
    const text = String(p.text ?? '')
    // A section this plugin injects has no separate body: this plugin's persisted
    // module registry IS both its source and its body, so the edit goes straight
    // into that record. Keeping a shadow override for it would leave two bodies
    // (the settings view reads the module, the panel would read the override) and
    // the two would drift.
    if (engine?.isOwnModuleForSession(sessionId, name) === true) {
      await service.updateModule('agent', name, { text }, sessionId)
      return
    }
    // Every other kind keeps its real text in someone else's file (a preset's or
    // a plugin's), so the edit is held locally and applied on the way out.
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
  clearSectionText: async ({ scope, p, sessionId, service, engine }) => {
    const name = String(p.name)
    // Our own module has no override to clear — the body IS the edit — so
    // "restore" means putting the seeded text back.
    const seeded = SEED_MODULES[name]?.text
    if (seeded !== undefined && engine?.isOwnModuleForSession(sessionId, name) === true) {
      await service.updateModule('agent', name, { text: seeded }, sessionId)
      return
    }
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
  setSectionWeight: async ({ scope, p, sessionId, service, engine }) => {
    const name = String(p.name)
    // Our own module's placement IS its body field, so the weight is written
    // there. A plugin's or preset's placement is decided by its own registration
    // (a preset entry exposes no order key — persona's order comes from the
    // harness's central table), so for those the weight is held locally as the
    // outgoing order and applied at send time.
    if (engine?.isOwnModuleForSession(sessionId, name) === true) {
      await service.updateModule('agent', name, { order: p.weight === null || p.weight === undefined ? undefined : Number(p.weight) }, sessionId)
      return
    }
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
/** Capabilities the host half shares with this layer (see PATches insert #2b). */
export interface OurHostBridge {
  /**
   * The host's tool→plugin attribution: resolves a tool's owning package, from
   * the live registration record, the pinned first-party map, or the MCP name
   * prefix (its own order). Shared rather than reimplemented so a tool-guidance
   * section is labelled exactly as the tool row is.
   * @param name - the tool name.
   * @returns the owning package label, or undefined when unattributed.
   */
  toolOwnerOf?: (name: string) => string | undefined
}

/**
 * Mount the write layer.
 * @param ctx - the host plugin context.
 * @param bridge - host capabilities this layer reuses (optional).
 */
export function applyOur(ctx: Context, bridge?: OurHostBridge): void {
  ctx.effect(() => {
    const wiring: Wiring = bridge === undefined ? {} : { bridge }
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
      ctx.on('agent/inbox/inserted', ({ agent }) => {
        engine.applyPending(agent)
        // A prune request takes effect at the NEXT turn boundary, never at the
        // moment it was made: it mutates the session surface, so running it
        // under an in-flight turn would rewrite history mid-step, and running it
        // after the turn had claimed its messages would be too late. Claiming the
        // idle phase here (before this turn's first step) is what puts it in the
        // window the user was promised; a busy agent keeps the request parked.
        void engine.applyPrunes(agent)
      })
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
