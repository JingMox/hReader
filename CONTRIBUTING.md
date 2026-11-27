# Contributing Guide

Thanks for contributing to hReader! This document covers local development, testing, and the commit workflow.

## Requirements

- **Node.js `>= 22`** (`.node-version` pins the major version; fnm/nvm/volta switch automatically)
- **pnpm `11.x`** (`corepack enable`, or `npm i -g pnpm@11`; do not mix in npm/yarn)
- **Rust** (only needed when changing `packages/desktop`; with rustup installed, the toolchain is selected automatically per `rust-toolchain.toml`)
- **Linux desktop builds** additionally need system libraries:
  ```bash
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev patchelf libssl-dev
  ```

## Quick Start

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Repository Layout

```
packages/core           Semantic HTML parsing, data-hr-id tree, outline, patching, styles, and the local server (the dependency foundation)
packages/renderer-html  PDF / PNG / print-ready HTML rendering (→ core)
packages/cli            The `hr` command line (→ core, renderer-html)
packages/mcp-server     MCP stdio server (→ core)
packages/app            Reader front-end shared by the desktop and browser builds
packages/pi-extension   Pi single-file extension
packages/dsh-bundle     dsh bundle (core is bundled into dist at build time)
packages/desktop        Tauri v2 desktop shell (Rust + webview)
```

Versions of shared dependencies converge in `pnpm-workspace.yaml` under `catalog:`; when adding the same dependency to multiple packages, write `catalog:` in the package instead of a version number.

## Common Commands

```bash
pnpm verify          # the full gate: format:check / lint / lint:sh / typecheck / build / test:coverage / test:perf / theme:check / depcruise / knip
pnpm test            # run all unit tests
pnpm test:coverage   # tests + coverage thresholds
pnpm -F @hreader/core test   # run a single package
pnpm lint            # ESLint (strictTypeChecked + stylisticTypeChecked)
pnpm typecheck       # tsc --noEmit across all packages
pnpm format          # Prettier autofix
pnpm desktop:check   # desktop shell gate: layer boundary + rustfmt + clippy -D warnings + cargo test
```

End-to-end, integration, and performance checks (CI's `e2e` job runs all three; `test:e2e` and `test:integration` both need Chrome/Edge/Chromium locally — missing Chrome prints `SKIPPED` and exits 0, and the desktop smoke auto-skips when the debug binary is not built; `test:perf` has no external dependencies):

```bash
pnpm test:e2e          # print pagination + foreign-document sandbox (real Chrome)
pnpm test:integration  # cross-package integration / user journeys (real dist artifacts + real Chrome)
pnpm test:perf         # absolute time-budget perf gate (tests/perf/**, no coverage, single serial worker)
```

Still local on-demand only (CI does not run these):

```bash
pnpm smoke:pi        # Pi extension smoke test
pnpm smoke:dsh       # dsh bundle smoke test
pnpm desktop:build   # build the desktop installer locally
```

## Gate Policy

CI splits the package scripts above into parallel `lint` / `test` / `e2e` jobs (desktop is its own job); the check set covers `pnpm verify`, though the order may differ — if it is green locally, CI will be green too.

- **Lint**: `typescript-eslint`'s `strictTypeChecked` + `stylisticTypeChecked`, plus a cross-package deep-import ban (cross-package imports may only go through the `@hreader/<name>` public entry point). No hard line-count/complexity caps — complexity is policed in review.
- **Escape-hatch comments**: `eslint-disable` is allowed but must be bounded and carry a description (enforced by `@eslint-community/eslint-comments`); `@ts-ignore`/`@ts-nocheck` are banned; `@ts-expect-error` must carry a one-line justification.
- **Assertions**: `as` is allowed; object-literal assertions, `any`, and non-null assertions `!` are banned.
- **Coverage**: the global four-dimension thresholds (lines/branches/functions/statements) live in `vitest.config.ts` and are pinned to the currently measured values as a ratchet — they only prevent regression, they do not require full per-file coverage.
- **Architecture boundaries**: `dependency-cruiser` polices dependency direction (core depends on no other package, no cycles, src must not import devDeps, src must not import tests); `knip` polices dead code.
- **Shell**: `lint:sh` uses shellcheck; when it is not installed locally you get a notice and a skip — it always runs in CI.

## Code Style Highlights

The rules you will hit most often:

- Comments only say what the signature cannot (contracts, trade-offs, formats, counter-intuitive spots); do not write comments that paraphrase the code, and update stale comments together with the code. Orphan TODOs are not allowed — only `TODO(name, issue#): ...` may exist.
- Public APIs use bare types (primitives, literal unions, plain data interfaces, discriminated unions); no wrapper classes/brand types, no boolean control parameters (when parameters grow, take a plain-object options bag), no mixing `null`/`undefined` (`undefined` uniformly means absent).
- External input (files, argv, HTTP/MCP parameters, `hr-meta` JSON) is validated at the boundary (type guards or zod); bare types flow inward and are not re-validated inside.
- Errors use `HrError` or a `{ ok: false, code, message }` discriminated union; never silently catch.
- Pure logic layers (`app`'s state/keys/store, etc.) never touch the DOM or browser globals; dependencies are injected through parameters.

## Commits & PRs

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, type ∈ `feat`/`fix`/`refactor`/`test`/`docs`/`chore`/`perf`/`build`.
- Run `pnpm format` and `pnpm verify` before committing; if you changed `packages/desktop`, also run `pnpm desktop:check`.
- PR descriptions state the motivation, the blast radius, and the verification results; when changing the public API or the documentation structure, update `README.md` / `docs/` in the same change.
- One PR does one thing; keep refactors and feature changes separate.

## Test Conventions

- Each test asserts one observable behavior and is named `should <behavior> when <condition>`.
- Assert concrete values and error `code`s — do not just assert "it threw".
- Do not mock the unit under test; external dependencies like fs/network/time are controlled through injected doubles.
- Use `mkdtemp` for temporary directories and clean them up in `finally`.
- Isolate the config root (`~/.hreader`, where `permissions.json` and `daemon.json` live) with `HREADER_HOME`; do not rewrite `HOME`: `HOME` is inherited by the Chrome child process — an empty `HOME` keeps the browser's network stack from starting and rendering stalls until the deadline; `HREADER_HOME` never enters Chrome's view.
- No `test.only`, commented-out tests, unseeded randomness, direct `Date.now()` reads, real network, or `setTimeout` polling.
- Tests that assert absolute time budgets ("< N ms", whether wall clock or `process.cpuUsage()`) go in `tests/perf/**/*.perf.test.ts` and run separately under `pnpm test:perf` (`vitest.perf.config.ts`: no coverage, single worker, sequential) — v8 instrumentation slows `src/**` several times over, so absolute budgets inevitably flake red inside a coverage run. Unit tests keep only machine-speed-independent assertions: complexity/linear-growth ratios (ratios barely move under instrumentation), structural upper bounds (byte counts, node counts, truncation positions), functional correctness.
- Artifact tests run real child processes against the **build artifacts** (`cli`'s `dist/cli.mjs`, `mcp-server`'s `dist/main.js`), not just src.

## Mutation Testing

Test strength is quantified with StrykerJS (`@stryker-mutator/vitest-runner`); configuration lives in `stryker.config.mjs`.

```bash
pnpm test:mutation                          # run the full scope in the config (takes a long time)
pnpm test:mutation --mutate "packages/core/src/io/paths.ts"   # run only one/few files (comma-separated globs)
```

- Reports land in `.reports-tmp/mutation/` (HTML + JSON, gitignored); the incremental cache is `.reports-tmp/stryker-incremental.json` — changed files are retested automatically, delete it to force a full run.
- Reading reports: `killed`/`timeout` are mutants the tests caught; `survived` are ones they missed — either add behavior-level tests, or, once confirmed to be an equivalent mutant, mark it with `// Stryker disable next-line <Mutator>: <reason>` and state the reason.
- `thresholds.break` is the anti-regression ratchet: below it the command exits non-zero. Once newly added tests kill mutants, the score may only go up.
- CI's `mutation.yml` runs on a weekly schedule and supports manual `workflow_dispatch` triggers (a `mutate` input narrows the scope); it does not block PRs.
- Note: Stryker runs in sandbox mode — it copies the working tree to `.stryker-tmp/` (`node_modules` goes through symlinks), and each sandbox runs `scripts/stryker-prep.mjs` once before the initial test run (restoring executable bits, disabling pnpm's verify-deps-before-run auto-install). Sources are never rewritten in place; but source edits made after the run starts will not enter that run.
