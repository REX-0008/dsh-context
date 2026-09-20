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

## 3. `src/client/components/contextView.tsx` — import

**Anchor**: the import block, right after `import { makeErrorBoundary } from './errorBoundary'`

```ts
// OUR INSERT POINT (PATCHES.md #3): the context-management card (see src/our/).
import { ContextManager } from '../../our/client/ContextManager'
```

## 4. `src/client/components/contextView.tsx` — the management card row

**Anchor**: inside the returned tree, immediately **before**
`<div className="lc-cols lc-cols-main">`

```tsx
        {/* OUR INSERT POINT (PATCHES.md #4): the write layer's management card,
            one full-width row above the read-only columns. */}
        {typeof sessionId === 'string' ? <ContextManager sessionId={sessionId} /> : null}
```

## 5. `src/client/components/browser.tsx` — the `rowAction` prop

**Anchor**: `ContextBrowserProps`, right after `onDetailRetry?: () => void`

```ts
  /**
   * OUR INSERT POINT (PATCHES.md #5): an optional per-row action renderer. The
   * write layer passes this to hang its own controls (e.g. a tool on/off
   * switch) on a row's trailing slot; absent, rendering is byte-identical to
   * upstream. `kind` names the row family, `name` the thing it is about.
   */
  rowAction?: (kind: 'tool' | 'system', name: string) => ReactNode
```

## 6. `src/client/components/browser.tsx` — the render hook

**Anchor**: in the tool row's `trailing` fragment, right after the hits chip line
`<span className="lc-br-hits" ...>{'×' + fmt(toolHitsOf(tool))}</span>`

```tsx
                  {props.rowAction !== undefined ? props.rowAction('tool', tool.name) : null}
```

## 7. `src/client/components/contextView.tsx` — passing the row action

**Anchor**: the `<ContextBrowser …/>` element, right after `onDetailRetry={source.retryDetail}`

```tsx
        /* OUR INSERT POINT (PATCHES.md #6): the write layer's per-row action. */
        rowAction={typeof sessionId === 'string'
          ? (kind, name) => (kind === 'tool' ? <ToolToggle sessionId={sessionId} toolName={name} /> : null)
          : undefined}
```

with the matching import next to #3:

```ts
import { ToolToggle } from '../../our/client/ToolToggle'
```

---

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
