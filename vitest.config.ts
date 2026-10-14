import { defineConfig } from 'vitest/config'

// Specs import src/ directly, never the built lib/, so the suite needs no build step and coverage reflects what ships.
export default defineConfig({
  test: {
    reporters: ['dot'],
    projects: [
      {
        test: {
          name: 'host',
          include: ['tests/host/**/*.spec.ts', 'tests/shared/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        // The write layer's PURE modules (priceMap/priceBook): importable
        // functions with no ctx, so they take the ordinary per-file gate. The
        // rest of src/our/ is exercised through the wiring it mounts and stays
        // out of coverage (see the exclude list).
        test: {
          name: 'our',
          include: ['tests/our/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        // The inlined primitives dist references a sourcemap it does not
        // ship; vite's warning is noise, so the client lane logs errors only.
        // The inlined primitives dist references a sourcemap it does not ship; vite's warning is noise.
        logLevel: 'error',
        test: {
          name: 'client',
          include: ['tests/client/**/*.spec.ts'],
          environment: 'jsdom',
          setupFiles: ['tests/client/setup.ts'],
          server: {
            deps: {
              // The primitives dist imports .module.css; inlining lets vite transform it (externalized Node ESM would reject the .css).
              inline: ['@deepseek-ai/dsh-client-ui-primitives'],
            },
          },
        },
      },
      {
        // Exercises the BUILT plugin and skips cleanly when lib/ is absent. The matrix also needs a dsh checkout (env DSH_REPO), and its first run per baseline installs the tag's vendored cordis into .tmp/compat — hence the timeout.
        test: {
          name: 'compat',
          include: ['tests/compat/**/*.spec.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        // Pure type declarations: no runtime surface to instrument.
        'src/shared/types.ts',
        'src/host/compat.ts',
        // Most of the write layer is exercised through the wiring it mounts (host
        // applyOur, the context view's panel) rather than importable pure
        // functions, so a per-file unit gate does not apply to it. The importable
        // modules tests/our/ drives directly STAY inside the gate — enumerated by
        // directory rather than globbed away (a later pure module joins them).
        'src/our/agent-events.ts',
        'src/our/agent-face.ts',
        'src/our/index.ts',
        'src/our/known-injectors.ts',
        'src/our/known-sections.ts',
        'src/our/section-registry.ts',
        'src/our/types.ts',
        'src/our/assembler/**',
        // The panel is wiring, with ONE exception: the module-definitions file's
        // content rules are pure, so it stays inside the gate.
        'src/our/panel/panel-service.ts',
        'src/our/panel/scope.ts',
        'src/our/panel/settings.ts',
        'src/our/preset/**',
        'src/our/client/**',
      ],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
      reporter: ['text', 'html'],
      // The text table lists only files below 100%; an empty table means full coverage.
      skipFull: true,
      reportsDirectory: './coverage',
    },
  },
})
