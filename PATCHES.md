# Local modifications to upstream files

This fork carries a write layer (context management) under `src/our/`, which is
**new code, not a modification**. This file lists the only places where upstream
files were touched, so an upstream update can be replayed mechanically:

1. read the diff below,
2. re-apply it to the new upstream file (each insert point is anchored on a line
   that upstream is unlikely to rewrite),
3. delete any insert point upstream has since absorbed natively.

Rule: every entry here must be an **insert-only** change (added lines, no
rewritten upstream logic). If an update ever requires rewriting upstream code,
that is a signal to reconsider the approach rather than grow this file.

Baseline: upstream `v0.6.x` (merge commit `98073b6`, upstream/main `31ae13a`).

## 0. Pricing: upstream's models.dev registry, not a local table

An earlier local change replaced upstream's price source with a hand-maintained
17-row table (`src/client/priceTable.ts` + `src/client/seenModels.ts`, with
`cost.ts`/`modelPrices.ts`/`providers.ts` rewritten around it). That was
reverted: upstream prices from the [models.dev](https://models.dev) registry
through `@opencode-ai/models`, which carries **215 providers and 7,914 priced
models** keyed by (provider, model) with an `npm`-package fallback index for
unknown provider ids. The table covered 17 keys by fuzzy containment, so the
same model could match a neighbouring tier's rates (measured: `deepseek-v4-flash`
priced at 0.7/1.4 against the registry's actual 0.15/0.6) and newer models
(`deepseek-v4-pro`, `gpt-5.4`, `claude-sonnet-5`, `glm-5.3`, `kimi-k3`…) had no
row at all. A wrong cost figure is worse than none.

So these files are **unmodified upstream** and must stay that way:
`src/client/cost.ts`, `src/client/modelPrices.ts`, `src/shared/providers.ts`,
`src/client/modelPrices.ts`'s dependency `@opencode-ai/models`, and the pricing
sections of `statsContext.tsx` / `settingsCard.tsx` / `i18n.ts`. The former
`settings.billing*` i18n keys and the settings card's `BillingBlock` went with
the table.

What replaced it is the **model price mapping** (#16–#19): a local route is a
gateway, not a vendor, so no provider rename can price it — and several vendors
resell one route under spellings the registry does not carry. The mapping answers
it per (route, model) pair by NAME (family → vendor, then a folded model-id match)
with a manual override for the rows that cannot settle, and applies it by feeding
`cost.ts` the route's own branch — the one path upstream already reads first and
treats as final. Upstream's lookup ladder, ambiguity refusal, and period handling
are all untouched.

---

## 1. `src/host/index.ts` — import

**Anchor**: the import block, right after `import { meetsBaseline } from '../shared/version'`

```ts
// OUR INSERT POINT (PATCHES.md #1): the context-management write layer lives
// entirely under src/our/; upstream code above is untouched.
import { applyOur } from '../our/index'
```

## 2. `src/host/index.ts` — mount

**Anchor**: end of `apply()`, right after `installSettings(ctx)`

```ts
  // OUR INSERT POINT (PATCHES.md #2): mount the write layer alongside upstream's
  // read-only projections. It registers its own settings namespace, its own
  // projection key (contextSections), and its own web routes.
  applyOur(ctx)
```

> Note: the write layer registers **no** session projection since Step 4 — the
> per-section view is served on demand from the plugin's own route, so upstream's
> projection keys are untouched.

## 3. `src/client/components/contextView.tsx` — import + our panel

**Import** (after `import { makeContextBrowser } from './browser'`):

```ts
import type { ContextBrowserProps } from './browser'
```

**Panel** — inside `.lc-cols-main`, the panel takes the BROWSER's own column and
carries the browser inside it (one browser on the page, not two):

```tsx
<div className="lc-col lc-col-browser flex-1 min-w-[min(360px,100%)]">
  {typeof sessionId === 'string' ? (
    <ContextManagementPanel sessionId={sessionId}
      browser={hooks => browser({ ...hooks, titleOverride: '上下文管理' })} />
  ) : browserCard}
</div>
```

Rewritten lines: the original `const browserCard = (` call becomes
`const browserCard = browser()` (a builder, so the panel can inject its hooks),
and the browser's column now renders the panel instead of `{browserCard}`.

## 4. `src/client/components/browser.tsx` — system-category hooks

**Anchor**: `ContextBrowserProps`, right after `onDetailRetry?: () => void`

```ts
  systemRows?: (
    row: BrowserRowBuilder,
    body: (name: string, text: string, extra?: ReactNode) => ReactNode,
    toolbar: (value: string, onChange: (next: string) => void) => ReactNode,
    pinnedSeq: number | null,
  ) => ReactNode
  systemCount?: number
  systemDeliveredLabel?: string
  titleOverride?: string
```

plus the exported `BrowserRowBuilder` type after the interface, the
`SectionBody` helper, and four small branches in `toolCount` / `singleKeyOf` /
`toggleCat` / `catBody('system')`. Without any of these props, rendering is
unchanged.

Rewritten lines (3): `toolCount` gains the caller's count; `singleKeyOf('system')`
returns null when the caller supplies rows; `catBody`'s system branch defers to
them; the card title reads `titleOverride ?? t('browser.title')`.

## 5. `src/client/index.ts` — our stylesheet

**Anchor**: after the last upstream `styles/*.css` import.

```ts
import './styles/contextManagement.css'
```

## 6. `src/client/components/browser.tsx` — category-head hooks

**Anchor**: `ContextBrowserProps`, after the `titleOverride` entry added above.

```ts
  categoryActions?: (category: string) => ReactNode
  categoryMarked?: (category: string) => boolean
```

plus, in the category head: the `lc-br-cat-pruned` class on the row and a
`lc-br-cat-actions` span rendered BESIDE the head button (separate controls —
nesting a button in a button is invalid markup). Without these props the heads
render exactly as before.

## 8. `src/client/components/browser.tsx` — delivered system row

**Anchor**: `catBody`'s `system` branch, right before the built-in prompt row.

```tsx
const sysNode = view.system
const deliveredText = sysNode !== null ? headerContent.get(sysNode.seq)?.system : undefined
const deliveredLabel = props.systemDeliveredLabel ?? catLabel('system')
const delivered = deliveredText !== undefined && sysNode !== null ? elemRow('sys-delivered', null, deliveredLabel, sysNode.tokens, undefined, <TextSection ... />) : null
```

Renders the actually-delivered system prompt of the live/pinned request above
the caller-supplied rows; hidden when no delivered content exists. The
`&& sysNode !== null` clause is required for TS narrowing (the ternary above
does not link back to `sysNode`). Also: the render-time `openable` guard in the
category list mirrors `toggleCat` exactly (`(c.key === 'system' &&
props.systemRows !== undefined)` clause) — without it a toggled-open system
category with caller rows only never renders its body.

## 9. `src/host/config.ts` — entry-config carrier for the write layer

**Import** (after the upstream imports):

```ts
// OUR INSERT POINT (PATCHES.md #9): the context-management write layer's
// settings tree rides the entry config on harness 0.2+ (see src/our/panel/scope.ts).
import { CONTEXT_PANEL_ENTRY_SCHEMA } from '../our/panel/settings'
import type { ContextPanelSettings } from '../our/types'
```

**Interface** (`Config` gains one optional field):

```ts
  /** The context-management write layer's settings tree (OUR INSERT — see PATCHES.md #9). ... */
  panel?: ContextPanelSettings
```

**Schema** (after `insightsEntry`):

```ts
  panel: volatileField(CONTEXT_PANEL_ENTRY_SCHEMA),
```

The `volatileField` wrapper makes the subtree live-editable on harness 0.2+
settings (profile patch, no remount) and a plain inert field on older lines.
The interface types the field as `ContextPanelSettings` although the runtime
value is the Volatile live reference — folds never read it.

**The re-resolve hazard (fixed with the field).** cordis resolves the raw entry
config through this schema BEFORE `apply`, so the config `apply` receives
carries `panel` as an already-built Volatile reference. `resolveBounds` used to
run the whole `Config` a second time; that re-entered the volatile resolver, and
`createVolatile` refuses a resolve whose value contains functions — the live
reference's `get`. The entry then failed at its first statement, and cordis
rolled back every effect the fiber had registered: the timeline/headers/activity
units and the detail route disappeared while the browser half still served its
UI, so the Context panel's detail read hit the connection dispatcher's bare
`not found`. Upstream's volatile fields escaped this only because they are
scalar and `.loose()` — a second resolve degrades them to their default. The
bounds now resolve through a bounds-only schema (`BoundsSchema`), which never
touches the volatile subtrees.

**The read path (the fix to this insert).** The read path is the Config reference, never `describe()`. The official
contract is that a business plugin reads its own Config reference
(`docs/subsystems/settings.md`: "Business consumers read `.get()` on their own
Config references"). The 0.1.x registration adapter that read through
`settings.describe()` was wrong: `describe` projects every entry's form schema
for the management page (it walks the whole profile, serializes each schema, and
emits `settings/document-updated`), and the write layer reads its settings on
every model request — once from the `agent/pre-step` waterfall and once from
`system-prompt/assemble`. Measured on the desktop runtime, that put roughly 1 ms
of whole-profile form projection on the per-request path. `src/our/panel/scope.ts`
now wraps the resolved `config.panel` reference for reads (0.029 us measured)
and uses the Settings service only for the merge WRITE (`update(ns, { panel })`).

## 14. Registration keys — three roles, two distinct strings

Upstream could use one string for every key because its package name, Host loader
entry id, and settings namespace were all `dsh-context`. This fork renamed the
first two, so they must be tracked separately:

| Key | Value | Who reads it |
| --- | --- | --- |
| Locale namespace, `settings.plugin.item` key, `plugins.bundle.config` key | `@our/context-panel-write` | the browser; the Plugins page renders the keyed `plugins.bundle.config` seat with `entryKey: pkg.name` |
| Settings transport namespace (`configForms.get` / `whileServed`) | `context-panel-write` | the Host settings document; `configForms.get` is documented as "Unique Host plugin entry id" |
| Host loader entry id (host/config.ts write address) | `context-panel-write` | `cordis.patch.yml`'s row id, which the write uses as `ns` |

Collapsing these is what hid the preference card from the Plugins page;
`tests/client/index.spec.ts` now reads both identities from `package.json` and
`cordis.patch.yml` and asserts they stay distinct.

## 15. `src/client/i18n.ts` — our added keys

**Anchor**: the end of `DICT_ZH` and `DICT_EN`.

Keys this plugin adds are appended after the last upstream entry, so an upstream
release that adds keys does not collide with them. Panel-owned strings are
namespaced `our.*`; the price-mapping block's labels ride the settings card's own
`settings.priceMap*` prefix (they are settings-card strings, and the block is
rendered by that card).

## 16. `src/client/settings.ts` — the price-mapping read/write

**Anchor**: `createContextSettings`, plus the `ContextSettings` interface.

Two additions, both driven by the same scope snapshot the preferences already come
from:

- a module-local `raw` holding the last scope value, so non-preference fields
  (`priceMap`) are readable without a second subscription;
- `priceMap()` / `setPriceMap(next)`, the mapping's read and wholesale write.

The write is optimistic-then-fenced like the preference setter: it echoes, then
writes through the scope, and rolls the echo back if the scope refuses. It writes
the WHOLE map (not a per-row patch) because only a wholesale write can express a
removal — a merge could never return a row to the mechanical pass.

## 17. `src/client/modelPrices.ts` — the additive observer

**Anchor**: the end of the file, after `useModelPrices`.

`observeModelPrices(note)` hands every PUBLISHED book to the caller and returns the
disposer. The store itself is untouched: no behavior changes for a deployment that
never calls it, which is what keeps this upstreamable as a plain test/extension
seam. It exists so the price mapping can synthesize the local routes' branches
(`src/our/client/priceBook.ts`) without editing `cost.ts`'s lookup ladder.

## 18. `src/client/components/settingsCard.tsx` — the mapping block

**Anchor**: the end of `SettingsCardProps`, both cards' `PreferenceRows` render,
and `PriceMapBlock` appended after `makePluginConfigCard`.

Upstream's card gains three props (`usePriceMap`, `useSessions`, `currencyOf`) and
one collapsible block under the preference rows. The block renders nothing when the
seat is absent, so a deployment whose Host does not serve the mapping shows exactly
upstream's card.

The block is wrapped in the harness's own `makeErrorBoundary`, so a throw inside OUR
block can never unmount the host card's preference rows — the observed failure mode
when this block first shipped (every setting on the page vanished). The boundary is
built in the card FACTORY, never in the block: a component type created during
render is a new type every render, which makes React unmount and remount the
subtree instead of updating it, re-running its effects on every pass.

## 19. `src/client/index.ts` — the mapping's seat and subscription

**Anchor**: `cardFace`, and the statement after `watchHistoryFaces(ctx)`.

`cardFace` grows `usePriceMap` (the table's seat: stored overrides, the wholesale
write, and the store revision) and carries `priceMapStore` in the inject `hooks`
compartment — a bare observable the renderer binds here at the binding site, per
the client stack rules. One `ctx.effect(() => observeModelPrices(noteBook), …)`
mounts the runtime, deliberately outside any component so the estimate is already
mapped on the first render that reads it.

A second effect subscribes to the settings store and pushes `settings.priceMap()`
into the runtime, so the mapping prices a session whether or not the settings card
is open. Two hazards are load-bearing here and are pinned by tests:

- the store's `priceMap()` returns a **stable object** while its stored value is
  unchanged. Rebuilding it per read gave an identity-keyed effect a new value every
  render, and each run notified the pricing store — an unbounded update loop that
  unmounted the whole settings card;
- `priceBook.setOverrides` ignores an **equal** map for the same reason.

## Local identity (not an insert point)

For installing this fork beside the published package (and for a trivial
rollback), three identity strings differ from upstream:

- `package.json` `name`: `dsh-context` → `@our/context-panel-write`
- `package.json` `dsh.client.inject`: **removed** (see the pitfall in the
  workspace: the client loader force-arrives `inject` rows, so declaring the
  shell's own preloaded packages here re-executes a non-idempotent combo batch
  and trips `duplicate factory registration`)
- `cordis.patch.yml`: row id `dsh-context` → `context-panel-write`, name → `@our/context-panel-write`

**PR branches must not carry these**: cut them from `upstream/main` and pick only
the upstreamable insert points (the `rowAction` slot in #5/#6 is the generic one;
the management card #3/#4/#7 is ours).