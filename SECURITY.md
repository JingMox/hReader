# Security Policy

## Security Model Overview

hReader is a local-first document reader, workbench, and AI authoring protocol designed with defense-in-depth boundaries:

- **Loopback Binding & Session Authentication**: `hr serve` binds strictly to loopback (`127.0.0.1`) with an ephemeral high-entropy token (`?t=` / `?token=`) that upgrades to an `HttpOnly`, `SameSite=Strict` cookie.
- **Workspace Sandbox (`--workspace`)**: File read, outline, patch, create, rename, delete, and static-serve routes validate canonicalized paths via `realpath` and reject traversal (`..`), NUL bytes, and symlinks pointing outside the workspace root.
- **Fragment Sanitization**: Patching and creation operations inspect DOM fragments for `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta http-equiv="refresh">`, `<form>`, inline `on*` attributes, and `javascript:` / `data:text/html` URIs, rejecting offending payloads with `forbidden_content` without touching the file on disk.
- **Desktop Daemon Isolation**: `@hreader/desktop` stores its own daemon metadata in an application-private state directory rather than `$HOME/.hreader/daemon.json`, preventing accidental interference with user-run `hr serve` instances, and restricts custom UI theme JSON (`~/.hreader/themes/*.json`) CSS variables and selectors against injection.

## Foreign HTML Sandbox and Permissions

hReader opens arbitrary HTML files in the workspace. Files that are not hReader documents (`foreign`) are treated as hostile input: they render only inside `<iframe src="/s/<docId>">` — never in the reader's own DOM — and the server stamps a Content-Security-Policy onto every `/s/` response.

### Sandbox invariants

- The iframe `sandbox` attribute is either empty or `allow-scripts`; it **never** contains `allow-same-origin`, `allow-popups`, `allow-modals`, `allow-top-navigation`, or `allow-forms`, and it is set before the first `src` navigation. `allow="fullscreen"` is the only granted feature policy, and the frame sends `referrerpolicy="no-referrer"`.
- Every `/s/` CSP carries the `sandbox` directive, so a foreign document opened top-level in a browser tab is still forced into an opaque origin: it cannot read the session cookie or call the same-origin API even if it somehow gained scripts there.

### Permission model

Foreign pages are governed by two independent dimensions, **scripts** and **network**, which combine into a 2×2 CSP matrix. Per-document grants are keyed by workspace-relative path in `<workspace>/.hreader/trust.json`; they survive edits and theme switches but are lost on rename or move (failing closed to both-off). Legacy content-SHA `local` grants migrate lazily to `{scripts: true, network: false}`. Global modes — `allow`, `deny`, or `per-doc` (both defaulting to `per-doc`) — live in `<home>/.hreader/permissions.json` and override per-document grants.

CSP highlights per effective combination (all four also pin `default-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'` and `frame-ancestors 'self'`):

| scripts | network | Highlights                                                                                                                                    |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| off     | off     | `script-src 'none'`; only `style-src 'unsafe-inline'` and `img-src data:` are open; `sandbox`                                                 |
| off     | on      | `script-src 'none'` stays; styles, images, media, fonts and `connect-src` open to `http: https:` (`ws: wss:` for connections); `sandbox`      |
| on      | off     | `script-src 'unsafe-inline' 'unsafe-eval'`; `connect-src 'none'`; images, media and fonts limited to `data:`/`blob:`; `sandbox allow-scripts` |
| on      | on      | `script-src` additionally allows `http: https:`; `connect-src http: https: ws: wss:`; `sandbox allow-scripts`                                 |

### Why a network-enabled page still cannot reach the local API

Even with `network` on — where `connect-src http: https:` lets a sandboxed page issue a request to `http://127.0.0.1:<port>` — three independent layers keep it out of hReader's own API:

1. **Origin gate**: a sandboxed page runs in an opaque origin, so its CORS and POST requests carry `Origin: null`, which never matches the loopback allowlist and is answered 403 before routing. A "simple" GET without an `Origin` header does pass this check — but then fails authentication with 401, because it carries no session cookie (next layer).
2. **Credentials**: the session credential is an `HttpOnly`, `SameSite=Strict` cookie — the page cannot read it, and the browser does not attach it to cross-site requests.
3. **CSRF header and no CORS**: write routes additionally require the `x-hr-csrf` header, which a cross-site "simple request" cannot add. The server never emits `Access-Control-Allow-Origin`, so even a request that reaches the wire returns a response the page cannot read.

### Self-navigation and resource hints

- With network off, the reader detects iframe loads it did not initiate (`meta refresh`, `target=_self`, `location=`) and navigates the frame back to `/s/`; on desktop, the same gate denies external navigation from a foreign frame without even handing it to the system browser.
- Resource hints (`dns-prefetch`, `preconnect`, `prefetch`, `prerender`, `modulepreload`) are **not reliably** governed by CSP across engines — `prefetch`/`prerender` fall under `prefetch-src` where supported (`default-src` otherwise), and `modulepreload` under `script-src`, but `dns-prefetch` and `preconnect` sit outside it. Every `/s/` response sends `X-DNS-Prefetch-Control: off`, and with network off those `<link>` elements are stripped from the served bytes — the file on disk is untouched.

### Agents are read-only

Permission state is written only by the user in the reader UI (per-document toggles) or desktop settings (global modes). No MCP tool and no `hr` command can grant or change permissions; the `permissions` field exposed by `GET /api/doc/:id/info` is read-only status.

### Known boundaries

- Prefetch-hint stripping applies to the markup as served. A page running with scripts enabled can create hint `<link>` nodes at runtime that the server never sees, and what such a node can still do depends on the hint and the engine: `dns-prefetch` costs at most a DNS lookup; `preconnect` may still establish a connection on some engines (without exchanging data); `prefetch`/`prerender` issue real requests and are only caught where the engine honors `prefetch-src` (or `default-src` as its fallback); `modulepreload` is governed by `script-src` and stays blocked under the current CSP. Keep `scripts` off for pages you do not trust — and treat the network-off serve-time stripping of these `<link>` elements as the first line of defense, not a complete one.
- `network` is an all-or-nothing switch: a page granted network can issue requests to any `http:`/`https:` origin, including other loopback services. Origins that do not opt in via CORS still cannot be read back, and credentialed cross-site requests carry no cookies — but side-effect GETs on unauthenticated local services are reachable. Keep `network` off for pages you do not trust.

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
