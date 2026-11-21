# Contributing to hReader

Thank you for your interest in contributing to **hReader**!

## Development Setup

### Prerequisites

- **Node.js `>= 22`**
- **pnpm `11.x`** (`corepack enable` or `npm i -g pnpm@11`)
- **Rust `1.98.0`** (automatically picked up via [`rust-toolchain.toml`](./rust-toolchain.toml) when `rustup` is installed)
- **Linux Desktop Only**: WebKitGTK & GTK development packages:
  ```bash
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev patchelf libssl-dev
  ```

### Install & Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

---

## Quality Gates

Every pull request must pass both the 10-step JS/TS verification gate and the Rust desktop shell check. All CI steps mirror local scripts verbatim (verified by `scripts/check-ci-parity.mjs`).

```bash
# 1. JS/TS verification gate (format, ci-parity, eslint, shell lint, typecheck, build, 100% coverage, depcruise, knip)
pnpm verify

# 2. Rust desktop shell verification (rustfmt, clippy -D warnings, unit & integration tests)
pnpm desktop:check
```

Optional verification scripts:

```bash
# Requires local Chrome, Edge, or Chromium
pnpm test:e2e

# Pi extension smoke test
pnpm smoke:pi

# Build desktop app bundles locally
pnpm desktop:build
```

---

## Architectural Conventions

1. **Workspace & Auth Boundaries (`@hreader/core`)**:
   - All file operations must resolve strictly inside the configured `--workspace` directory (symlinks escaping workspace and path traversal must be rejected with `path_outside_workspace`).
   - Executable content (`<script>`, `on*` event attributes, `javascript:` URLs, `<iframe>`, etc.) must be rejected with `forbidden_content`.
2. **Pure Logic vs. Platform Side Effects (`@hreader/desktop`)**:
   - Keep pure logic modules (`options.rs`, `workbench.rs`, `url_build.rs`, `open_arg.rs`, `daemon_file.rs`, `spawn_decision.rs`, etc.) completely free of `tauri::` imports. `packages/desktop/scripts/check.sh` enforces this statically.
3. **100% Test Coverage & Known Defects**:
   - Vitest enforces 100% statement/branch/function/line coverage across configured source packages (`vitest.config.ts`).
   - Never add un-tracked `it.fails` tests. If a bug is pinned instead of fixed immediately, follow the registry contract in [`docs/known-defects.md`](./docs/known-defects.md).
4. **Engineering Standards**:
   - Follow [`docs/04-engineering-standards.md`](./docs/04-engineering-standards.md): flat control flow, explicit signatures, no silent catches, zero dead code (`knip`), zero circular imports (`dependency-cruiser`).

---

## Submitting a Pull Request

1. Fork the repository and create a branch from `main`.
2. Keep commits focused and descriptive (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
3. Ensure `pnpm format`, `pnpm verify`, and `pnpm desktop:check` pass before opening a PR.
4. Explain the motivation, architectural scope, and verification results in the PR description.
