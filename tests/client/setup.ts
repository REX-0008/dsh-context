// Client project setup: React 18 `act` requires this flag to flush effects
// synchronously in tests; every jsdom spec shares the real React runtime.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom does not implement scrollIntoView; the plugin calls it when focusing
// a browser row. A no-op polyfill stands in for the platform (layout-free).
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => {}
}

// jsdom has no ResizeObserver; the primitives' fit-to-content effects (tooltip
// bubbles, balance capsule) mount one. A no-op stand-in skips real layout.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if ((globalThis as { ResizeObserver?: unknown }).ResizeObserver === undefined) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
}
