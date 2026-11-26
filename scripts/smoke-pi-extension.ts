// Manual smoke gate for the Pi extension — the extension's Pi types are a hand-copied narrow
// interface (no compiler in this repo watches it), so the only real verification is loading this
// file once under real `pi`. **Not in CI** (requires a local pi install and real processes).
// Usage: `pnpm smoke:pi`.
//
// All verdicts land on reproducible signals, never on model phrasing:
//   1. local pi version == the version the signatures were copied from (if it drifted, re-copy the
//      four blocks at the top of `pi-hreader.ts`);
//   2. loading does not report `Failed to load extension` — this also covers registration-time
//      validation: Pi's `registerCommand` checks a non-empty name + function handler,
//      `registerTool` checks `parameters` is an object schema, and any miscopied signature blows up
//      into this same error at load;
//   3. `/hreader` and `/hr-style` are handled as **commands**: print mode has no UI, the handler
//      finishes silently → empty output + exit 0;
//   4. control: without the extension loaded, the same `/hreader` is sent to the model as a prompt
//      → nonempty output.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The pi version in effect when the `ExtensionAPI`/`ExtensionContext` signatures were copied (see the header comment of `pi-hreader.ts`). */
const SIGNATURE_PI_VERSION = "1.5.2";
const EXTENSION = fileURLToPath(new URL("../packages/pi-extension/pi-hreader.ts", import.meta.url));
const TIMEOUT_MS = 120_000;
const LOAD_FAILURE = "Failed to load extension";

interface Run {
  readonly status: number | null;
  readonly output: string;
}

/** Runs in an empty directory: the repo's AGENTS.md, skills, and templates would all perturb the prompt path and dirty the control group. */
const SANDBOX = mkdtempSync(join(tmpdir(), "hreader-smoke-"));

const runPi = (args: readonly string[]): Run => {
  const result = spawnSync("pi", args, {
    cwd: SANDBOX,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/** json mode emits one event per line; only the `type` field matters. */
const eventTypesOf = (output: string): readonly string[] =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
          const type: unknown = parsed.type;
          return typeof type === "string" ? [type] : [];
        }
        return [];
      } catch {
        return [];
      }
    });

const failures: string[] = [];
const check = (passed: boolean, label: string, detail: string): void => {
  process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n`);
  if (!passed) failures.push(`${label}——${detail.trim().slice(0, 400)}`);
};

const BASE = [
  "--offline",
  "--no-session",
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--mode",
  "json",
];

const version = runPi(["--version"]).output.trim();
check(
  version === SIGNATURE_PI_VERSION,
  `pi version matches the one the signatures were copied from: ${SIGNATURE_PI_VERSION}`,
  `actual ${version}: re-check the four signature segments at the top of pi-hreader.ts before changing this constant`,
);

const loaded = runPi([...BASE, "--extension", EXTENSION, "--print", "/hreader"]);
check(
  !loaded.output.includes(LOAD_FAILURE),
  "extension loads through Pi's registration checks (command name/handler, tool parameters)",
  loaded.output,
);
const loadedTypes = eventTypesOf(loaded.output);
check(
  loaded.status === 0 && loadedTypes.length > 0 && loadedTypes.every((type) => type === "session"),
  "`/hreader` executes as a command (print mode has no UI → only session events, no model turn)",
  `exit code ${String(loaded.status)}; events: ${loadedTypes.join(",") || "none"}; output: ${loaded.output}`,
);

const control = runPi([...BASE, "--print", "/hreader"]);
const controlTypes = eventTypesOf(control.output);
check(
  controlTypes.some((type) => type !== "session"),
  "control: without the extension, `/hreader` falls through to the model (a model-turn event appears, so this is not a vacuous assertion)",
  `exit code ${String(control.status)}; events: ${controlTypes.join(",") || "none"}; output: ${control.output}`,
);

// One more real-load proof: `/hr-style` must also be a **command** (finishes silently in print
// mode, never reaching a model turn).
const styled = runPi([...BASE, "--extension", EXTENSION, "--print", "/hr-style"]);
const styledTypes = eventTypesOf(styled.output);
check(
  styled.status === 0 && styledTypes.length > 0 && styledTypes.every((type) => type === "session"),
  "`/hr-style` also executes as a command (the registration surface has two commands, not just `/hreader`)",
  `exit code ${String(styled.status)}; events: ${styledTypes.join(",") || "none"}; output: ${styled.output}`,
);

if (failures.length > 0) {
  process.stderr.write(`\nsmoke failures (${String(failures.length)}):\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "\nsmoke passed: real pi loads this extension and executes `/hreader` and `/hr-style`.\n",
  );
}
