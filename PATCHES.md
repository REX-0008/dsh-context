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

Every key this plugin adds is namespaced `our.*` and appended after the last
upstream entry, so an upstream release that adds keys does not collide with them.

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