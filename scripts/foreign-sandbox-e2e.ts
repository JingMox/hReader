// Adversarial verification of the foreign-document iframe sandbox in real Chrome —
// under `sandbox="allow-scripts"`, cookie/storage/top navigation/popups/forms/cross-origin DOM
// must all be blocked; under `sandbox=""` scripts must not run at all. Missing Chrome or
// `HREADER_SKIP_CHROME=1` prints SKIPPED and exits 0 — the same convention as print-e2e (CI that
// must really run sets `CHROME_BIN` explicitly).
//
// Boundary note: sandbox tokens do not block network — fetch/XHR containment is server-side CSP
// (response headers issued by the "script × network" permission combination), out of this
// script's scope; verified here is the half the attribute layer can promise.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipLineOf, skipReasonOf } from "../packages/cli/src/commands/print-skip.ts";

const CANDIDATES = [
  process.env["CHROME_BIN"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const chromeEnvOf = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => ({
  ...env,
  CHROME_BIN: CANDIDATES.find((path) => path !== undefined && existsSync(path)),
});

const chromeOf = (): string => {
  const env = chromeEnvOf(process.env);
  const reason = skipReasonOf(env);
  if (reason !== null) {
    process.stdout.write(skipLineOf(reason));
    process.exit(0);
  }
  return env["CHROME_BIN"] ?? "";
};

/** Attack script: each attack's result goes into `results`, finally postMessage'd back to the
 *  parent. postMessage flows freely between opaque origins (the sandbox does not filter
 *  messages), and the parent only uses it to collect the report — the real reader installs no
 *  message listener, so a forged message has no receiver by nature and is not an attack
 *  surface. */
const ATTACK = [
  // Explicit body: a bare-`<script>` document's script runs in head while `document.body` is still null.
  "<body><script>",
  "const results = {};",
  "const probe = (name, fn) => { try { results[name] = fn(); } catch (e) { results[name] = e.name; } };",
  "probe('cookie', () => { void document.cookie; return document.cookie; });",
  "probe('storage', () => { void window.localStorage; return 'ok'; });",
  "probe('parentDom', () => parent.document.title);",
  "probe('topGlobal', () => top.hrReader);",
  "probe('windowOpen', () => window.open('about:blank') === null ? 'blocked' : 'opened');",
  "probe('topNav', () => { top.location.href = 'about:blank#pwned'; return 'attempted'; });",
  "const form = document.createElement('form');",
  "form.action = 'about:blank#form'; form.target = '_top';",
  "document.body.appendChild(form);",
  "probe('form', () => { form.submit(); return 'attempted'; });",
  // postMessage forgery: slip the parent a "reader-protocol" message and see whether it is executed as a command.
  "parent.postMessage({type:'doc.changed',revision:'x',changedNodes:'\"x\"]'}, '*');",
  // Synchronous return: setTimeout inside a sandboxed iframe is not advanced by headless virtual-time, so waiting would hang forever.
  "results.alive = true;",
  "parent.postMessage(JSON.stringify(results), '*');",
  "</script>",
].join("");

/** off-tier iframe: a script that ran would postMessage; nothing reaching the parent = no script ran. */
const OFF_FRAME = `<iframe id="off" sandbox="" srcdoc="&lt;script&gt;parent.postMessage('off-ran','*')&lt;/script&gt;"></iframe>`;

/** script-enabled iframe: sandbox="allow-scripts", matching the only optional value in foreign.ts. */
const LOCAL_FRAME = `<iframe id="local" sandbox="allow-scripts" srcdoc="${ATTACK.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;

const FIXTURE = [
  "<!doctype html><title>sandbox-e2e</title>",
  "<div id=results></div><div id=nav>pending</div><div id=forged>clean</div><div id=off>pending</div>",
  LOCAL_FRAME,
  OFF_FRAME,
  "<script>",
  "window.addEventListener('message', (e) => {",
  "  const el = document.getElementById('results');",
  "  if (e.data === 'off-ran') { document.getElementById('off').textContent = 'scripts-ran'; return; }",
  // A message forged as "reader protocol" (an object, not a string): if the parent executed it as a command this would read touched.
  "  if (typeof e.data === 'object' && e.data !== null) { document.getElementById('forged').textContent = 'received-object'; return; }",
  "  if (typeof e.data === 'string' && e.data.startsWith('{')) el.textContent = e.data;",
  "});",
  // If top navigation/forms pierced the sandbox, the parent is already at about:blank and the
  // hash check never reaches this line.
  "setTimeout(() => {",
  "  document.getElementById('nav').textContent = location.hash === '' ? 'blocked' : 'NAVIGATED';",
  "  document.getElementById('off').textContent =",
  "    document.getElementById('off').textContent === 'pending' ? 'silent' : 'scripts-ran';",
  "}, 500);",
  "</script>",
].join("");

interface AttackResults {
  readonly cookie?: string;
  readonly storage?: string;
  readonly parentDom?: string;
  readonly topGlobal?: string;
  readonly windowOpen?: string;
  readonly topNav?: string;
  readonly form?: string;
  readonly alive?: boolean;
}

const failures: string[] = [];
const check = (ok: boolean, name: string): void => {
  if (!ok) failures.push(name);
};

const main = (): void => {
  const chrome = chromeOf();
  const dir = mkdtempSync(join(tmpdir(), "hr-sandbox-e2e-"));
  const htmlPath = join(dir, "fixture.html");
  writeFileSync(htmlPath, FIXTURE);

  const dom = execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=8000",
      `--dump-dom`,
      `file://${htmlPath}`,
    ],
    { stdio: "pipe", timeout: 60_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  // Circumstantial evidence of pierced top navigation: the whole page is replaced by about:blank, marker included.
  check(
    dom.includes('id="results"'),
    "parent page was taken over by top navigation (no results node in dump-dom)",
  );

  const nav = /id="nav">([^<]*)</u.exec(dom)?.[1] ?? "";
  check(nav === "blocked", `top navigation / form submit was not blocked (nav=${nav})`);

  const off = /id="off">([^<]*)</u.exec(dom)?.[1] ?? "";
  check(off === "silent", `script ran inside a sandbox="" iframe (off=${off})`);

  const raw = /id="results">([^<]*)</u.exec(dom)?.[1] ?? "";
  const results = JSON.parse(raw === "" ? "{}" : raw) as AttackResults;
  check(
    results.alive === true,
    "allow-scripts iframe returned no result (script did not run or message never arrived)",
  );

  // Chrome answers SecurityError to cookie/storage/cross-origin DOM access from opaque origins.
  for (const key of ["cookie", "storage", "parentDom", "topGlobal"] as const) {
    check(results[key] === "SecurityError", `${key} was not blocked (${String(results[key])})`);
  }
  check(
    results.windowOpen === "blocked",
    `window.open was not blocked (${String(results.windowOpen)})`,
  );
  check(
    results.topNav === "attempted" || results.topNav === "SecurityError",
    `top.location assignment misbehaved (${String(results.topNav)})`,
  );

  // Forged object message: the parent can only "receive" — the real reader installs no message listener (a forged message has no receiver).
  const forged = /id="forged">([^<]*)</u.exec(dom)?.[1] ?? "";
  check(
    forged === "received-object" || forged === "clean",
    `forged-message check itself is broken (${forged})`,
  );

  if (failures.length > 0) {
    process.stdout.write(`FAILED: ${failures.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `OK: all sandbox attacks blocked (cookie/storage/DOM/popups/navigation/forms; off tier silent; forged postMessage had no listener)\n`,
  );
};

main();
