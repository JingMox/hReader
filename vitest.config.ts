// Full test discovery, cross-package resolution (straight to sources), and the coverage gate; not
// test content. Per-package configs (`pnpm -F <pkg> test`) live in packages/*/vitest.config.ts and
// share vitest.shared.ts.
import { defineConfig } from "vitest/config";

import { packageAliases, packageTest } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    ...packageTest,
    include: ["packages/*/tests/**/*.test.ts", "tests/leak-guard/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // `pi-hreader.ts` is a single-file extension (at package root, not under `src/`), so it must be listed explicitly in coverage.
      include: ["packages/*/src/**/*.ts", "packages/*/pi-hreader.ts"],
      reporter: ["text", "json-summary"],
      // On any test failure the default `onTestFailure` first `rm -rf`s `coverage/.tmp` while an
      // in-flight `writeFile(coverage-N.json)` is still queued — the real failure then gets masked
      // by an `ENOENT coverage/.tmp/coverage-N.json` unhandled rejection. Keep the temp directory
      // so a failure is reported as it actually happened.
      reportOnFailure: true,
      // Global four-dimension ratchet: on 2026-11-24 lines/statements/functions/branches all
      // measured 100, so thresholds pin the measured value against regression. No perFile — it
      // turns "new file" into a hard must-be-fully-tested constraint; a global threshold lets one
      // file dip as long as the total does not regress.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
