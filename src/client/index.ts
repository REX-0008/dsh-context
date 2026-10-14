/** dsh-context — client half bundle entry. The Context view reads the harness session projection
 * `contextTimeline` (the split generation's slim head); heavy collections arrive on demand from the
 * host's detail endpoint, one read per viewing client (timelineSource.ts). */

import { createElement as h, useSyncExternalStore } from 'react'
import { DICT_EN, DICT_ZH } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeOverviewPanel } from './components/overviewPanel'
import { makePluginConfigCard, makeSettingsCard } from './components/settingsCard'
import { watchInsightPage } from './insightPage'
import { modalStoreOf } from './modalStore'
import { entrySeated, type ClientCtx } from './services'
import { createContextSettings, type ConfigFormsFace, type SettingsField, type SettingsScopeBinderFace } from './settings'
import { makeContextView } from './components/contextView'
import { makeContextJumpButton } from './components/contextJump'
import { noteBook, priceMapStore, setOverrides } from '../our/client/priceBook'
import { observeModelPrices } from './modelPrices'
import { watchObservedPairs } from '../our/client/pairObserver'
import { makeFleetView } from './components/fleetView'
import { watchFleetTab } from './fleetTab'
import { makeAgentHeads } from './agentHeads'
import { watchHistoryFaces } from './historyPage'
import { watchPlacement } from './placement'
import { watchSidebarContextTab } from './sidebar'
import { makeViewKit } from './viewkit'

// Import order IS cascade order among same-specificity rules: the Tailwind utilities sheet stays first,
// then base, then the per-component sheets, which keep winning the ties.
import './styles/tailwind.css'
import './styles/base.css'
import './styles/stats.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'
import './styles/fleet.css'
import './styles/overview.css'
import './styles/dateRange.css'
// Ours last, so our additions win on equal specificity without editing upstream
// sheets (all classes here are new; see contextManagement.css).
import './styles/contextManagement.css'

// Two distinct keys, both of which must name THIS package on this fork:
//   - the Locale/Slots namespace and the `plugins.bundle.config` slot key are
//     the BUNDLE PACKAGE NAME (the Plugins page renders that keyed slot with
//     `entryKey: pkg.name`);
//   - the settings transport key (`configForms.get`/`whileServed`) is the HOST
//     loader ENTRY ID, which our cordis.patch.yml declares as `context-panel-write`.
// Upstream could use one string for all three because its package, entry id and
// namespace were all `dsh-context`; this fork renamed the first two.
const NS = '@our/context-panel-write'
const SETTINGS_NS = 'context-panel-write'

/** The chat→Context jump entry doubles as this bundle's mount marker: no
 * preference gates it, so a ledger seating it means a mount already registered
 * the bundle's seats. */
const JUMP_SLOT = 'conversation.chat.assistant-actions'
const JUMP_ID = 'context-jump'

function apply(ctx: ClientCtx): void {
  // One live mount per page (dsh-context#137). Two mounts of this bundle share
  // one slot ledger, and the client-plugin runner force-assigns a fresh
  // shadowing priority to every registration, so the registry's same-id guard
  // never fires across them and the session header — which renders the raw
  // ledger and matches the active view by id — paints both copies of every
  // seat. A marker already in the ledger means a mount is live: this one adds
  // nothing. Fails open, so a face without the ledger view still mounts.
  if (entrySeated(ctx, JUMP_SLOT, JUMP_ID)) return
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t)
  // History faces are resolved through the DECLARED inject: a non-declared read of the traced remote proxy
  // throws "cannot get property … without inject" and takes the view down (see historyPage.ts).
  watchHistoryFaces(ctx)
  // The price-mapping runtime follows the price book: each published book is
  // adopted, and the local routes' branches are synthesized from it (see
  // our/client/priceBook). Mounted here rather than in a component so the
  // estimate is already mapped on the first render that reads it.
  ctx.effect(() => observeModelPrices(noteBook), 'dsh-context: price map follows the book')
  // The billed pairs must be feeding the runtime whether or not the settings card
  // is open: a component that mounts only there would leave every local route
  // unpriced until someone opened it (see our/client/pairObserver).
  ctx.effect(() => watchObservedPairs(ctx), 'dsh-context: price map follows the sessions list')
  const settings = createContextSettings()
  // The stored overrides reach the runtime from the STORE, not the settings
  // card: the mapping must price a session whether or not that card is open.
  // (The card's own push was an identity-keyed effect, and its churn is what once
  // spun an unbounded render loop.) setOverrides ignores an equal map, so the
  // store's every preference notification is cheap here.
  ctx.effect(() => {
    const push = (): void => { setOverrides(settings.priceMap()) }
    push()
    return settings.store.subscribe(push)
  }, 'dsh-context: price map follows the settings store')
  // Poll the sessions list so the mapping's observed pairs are in force before any
  // surface reads a price (see our/client/pairObserver).
  ctx.effect(() => watchObservedPairs(ctx), 'dsh-context: price map follows the sessions list')
  // One page-scope cold-head cache for every agent-data reader: the Context view's stats cell and inline card
  // (right Sidebar host), and the Fleet tab's card — all of which can be mounted at the same time.
  const heads = makeAgentHeads()
  const ContextView = makeContextView(ctx, kit, settings, heads)
  const FleetView = makeFleetView(ctx, kit, heads)

  ctx.effect(() => watchPlacement(settings, {
    tab: () => ctx.slots.inject('conversation.view', () => ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10).
      { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab.context') },
      props => h(ContextView, props),
    )),
    sidebar: () => watchSidebarContextTab(ctx, ContextView, t, NS),
  }), 'dsh-context: placement')

  // The Fleet tab: its own show/hide preference on top of the placement gate (fleetTab.ts).
  ctx.effect(() => watchFleetTab(
    ctx,
    settings,
    props => h(FleetView, props as unknown as Parameters<typeof FleetView>[0]),
    t,
    NS,
  ), 'dsh-context: fleet tab')

  // Chat → Context jump: opens the right Sidebar's tab pinned to the reply's turn where served, else the
  // conversation tab (contextJump.tsx; relay and activation in viewFocus.ts).
  const ContextJump = makeContextJumpButton(ctx, kit)
  ctx.slots.inject(JUMP_SLOT, () => {
    return ctx.slots.register(
      // After the shipped feedback entry (10), still inside the icon row.
      { name: JUMP_SLOT, id: JUMP_ID, order: 20, locale: NS },
      props => h(ContextJump, props),
    )
  })

  registerContextCommand(ctx, kit)
  const ContextModal = makeContextModal(ctx, kit, settings)
  ctx.slots.inject('conversation.input.overlay', () => {
    return ctx.slots.register(
      { name: 'conversation.input.overlay',
        id: 'context-modal',
        order: 10,
        locale: NS,
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })

  // Context Insights page: the panel on the keyed `main` slot and its sidebar entry on
  // `sidebar.panellist`, both mounted or unwound by the `insightsEntry` preference (insightPage.ts).
  const OverviewPanel = makeOverviewPanel(ctx, kit)
  ctx.effect(() => watchInsightPage(
    ctx,
    settings,
    // Root-scope seats: the owner props (the standard kit) arrive untyped.
    props => h(OverviewPanel, props as unknown as Parameters<typeof OverviewPanel>[0]),
    t,
    NS,
  ), 'dsh-context: insight page')

  const cardFace = (): {
    hooks: { contextSettings: typeof settings.store; priceMapRevision: typeof priceMapStore }
    set: (field: SettingsField, value: string) => void
    usePriceMap: () => {
      overrides: Record<string, { vendor: string; model: string }>
      write: (next: Record<string, { vendor: string; model: string }>) => void
      revision: number
    }
  } => ({
    hooks: { contextSettings: settings.store, priceMapRevision: priceMapStore },
    set: (field, value) => { settings.set(field, value) },
    // The price table's seat. The bare observable rides the hooks compartment and
    // is bound to a hook here at the binding site, per the client stack rules
    // (business components never subscribe themselves).
    usePriceMap: () => {
      const revision = useSyncExternalStore(
        listener => priceMapStore.subscribe(listener),
        () => priceMapStore.getSnapshot(),
      )
      return {
        overrides: settings.priceMap(),
        write: (next: Record<string, { vendor: string; model: string }>) => { settings.setPriceMap(next) },
        revision,
      }
    },
  })

  // Per-user display preferences. Two generations, two transports and seats,
  // switched by SERVICE PRESENCE (each deferred inject fires on exactly one
  // side; a host without its service never runs the callback):
  //   - the settingsScope generation registers the card on the keyed
  //     `settings.plugin.item` slot (Settings → Plugins → Plugin
  //     configuration), binding the Host-served `dsh-context` namespace;
  //   - the Config-form generation (dsh 0.1.7+) retired that pair — there the
  //     card rides the configForms transport and the Plugins page's keyed
  //     `plugins.bundle.config` seat, alive only while the Host serves the
  //     entry (its Config's volatile preference fields).
  // The two seats key differently (see the NS/SETTINGS_NS note above): the slot
  // key is the bundle package name, the transport namespace the loader entry id.
  ctx.inject(['settingsScope'], (raw) => {
    const c = raw as ClientCtx & { settingsScope?: SettingsScopeBinderFace }
    const binder = c.settingsScope
    if (binder === undefined) return
    c.effect(() => settings.attach(binder.bind({ namespace: SETTINGS_NS })), 'dsh-context: settings scope')
    const SettingsCard = makeSettingsCard(kit)
    c.slots.inject('settings.plugin.item', () => {
      return c.slots.register(
        { name: 'settings.plugin.item', key: NS, locale: NS, inject: cardFace },
        // Root-scope keyed slot: no sessionId on these props — the face
        // (hooks + set) arrives through the registration's inject.
        props => h(SettingsCard, props as unknown as Parameters<typeof SettingsCard>[0]),
      )
    })
  })
  ctx.inject(['configForms'], (raw) => {
    const c = raw as ClientCtx & { configForms?: ConfigFormsFace }
    const forms = c.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    c.effect(() => settings.attach(forms.get(SETTINGS_NS)), 'dsh-context: config forms')
    const PluginConfigCard = makePluginConfigCard(kit)
    c.effect(() => forms.whileServed([SETTINGS_NS], () => {
      // slots.inject's disposer is the registration's disposer (the typed
      // local face reads unknown; the harness contract returns a disposer).
      return c.slots.inject('plugins.bundle.config', () => {
        return c.slots.register(
          { name: 'plugins.bundle.config', key: NS, locale: NS, inject: cardFace },
          props => h(PluginConfigCard, props as unknown as Parameters<typeof PluginConfigCard>[0]),
        )
      }) as () => void
    }), 'dsh-context: plugins-page card')
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['slots', 'locale'],
  apply,
}
