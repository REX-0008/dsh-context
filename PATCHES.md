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

Baseline: upstream `v0.53.4`.

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

## 7. `src/client/i18n.ts` — our added keys

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