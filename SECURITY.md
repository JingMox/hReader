# Security Policy

## Security Model Overview

hReader is a local-first document reader, workbench, and AI authoring protocol designed with defense-in-depth boundaries:

- **Loopback Binding & Session Authentication**: `hr serve` binds strictly to loopback (`127.0.0.1`) with an ephemeral high-entropy token (`?t=` / `?token=`) that upgrades to an `HttpOnly`, `SameSite=Strict` cookie.
- **Workspace Sandbox (`--workspace`)**: File read, outline, patch, create, rename, delete, and static-serve routes validate canonicalized paths via `realpath` and reject traversal (`..`), NUL bytes, and symlinks pointing outside the workspace root.
- **Fragment Sanitization**: Patching and creation operations inspect DOM fragments for `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta http-equiv="refresh">`, `<form>`, inline `on*` attributes, and `javascript:` / `data:text/html` URIs, rejecting offending payloads with `forbidden_content` without touching the file on disk.
- **Desktop Daemon Isolation**: `@hreader/desktop` stores its own daemon metadata in an application-private state directory rather than `$HOME/.hreader/daemon.json`, preventing accidental interference with user-run `hr serve` instances, and restricts custom UI theme JSON (`~/.hreader/themes/*.json`) CSS variables and selectors against injection.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `1.0.x` | Yes       |

## Reporting a Vulnerability

Please **do not** disclose security vulnerabilities in public GitHub issues.

Instead:

1. Open a private GitHub Security Advisory at [github.com/JingMox/hReader/security/advisories/new](https://github.com/JingMox/hReader/security/advisories/new), **or**
2. Contact the maintainer via GitHub (`@JingMox`) with reproduction steps, affected component (`core`, `cli`, `desktop`, `mcp-server`, `pi-extension`, `dsh-bundle`), and potential impact.

We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.
