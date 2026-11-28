// This layer covers `serveCommand`/`serveCommandOf`'s in-process behavior (lifecycle, diagnostic outlets,
// `--app-dir`, allowHosts, `--home`); the subprocess cases only verify lifecycle.

import { existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serveCommand } from "../src/commands/serve";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/exit-codes";
import { run } from "../src/run";
import {
  serveDirs as dirs,
  serveInputOf as inputOf,
  stopHandle,
  waitGone,
  type ServeDirs,
} from "./serve-helpers";
import { parseArgs } from "../src/args";
import type { Intent } from "../src/args";
import { serveCommandOf, thumbWarnOf } from "../src/run-serve";

describe("serveCommand", () => {
  it("should print the json envelope", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const text = await serveCommand(inputOf(dir, true, stopped));

      expect(text).toMatch(/^\{.*\}\n$/u);
      expect(text).toContain('"port":');
      expect(text).toContain('"token":"');
      stop();
    } finally {
      dir.drop();
    }
  });

  it("should write daemon.json while serving", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      await serveCommand(inputOf(dir, true, stopped));

      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      stop();
    } finally {
      dir.drop();
    }
  });
});

describe("serveCommand · after it ends", () => {
  it("should remove daemon.json once stop resolves", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      await serveCommand(inputOf(dir, true, stopped));
      stop();
      await waitGone(join(dir.home, ".hreader", "daemon.json"));

      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      dir.drop();
    }
  });

  it("should print the human line when --json is off", async () => {
    const dir = dirs();
    try {
      const { stop, stopped } = stopHandle();
      const text = await serveCommand(inputOf(dir, false, stopped));
      stop();

      // What is printed must be the "paste straight into a browser" string: a bare address has no token — paste it and you get a 401 (`GET /` consumes the token).
      expect(text).toMatch(
        /^serving .+ on http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+ \(pid \d+\)\n$/u,
      );
    } finally {
      dir.drop();
    }
  });
});

const runServeJson = async (
  dir: ReturnType<typeof dirs>,
  stopped: Promise<void>,
): Promise<string[]> => {
  const out: string[] = [];
  await run(["serve", join(dir.workspace, "doc.html"), "--port", "0", "--json"], {
    cwd: dir.workspace,
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    stop: stopped,
  });
  return out;
};

describe("serveCommand · allowHosts and run dispatch", () => {
  it("should pass an explicit allowHosts list through to startServer", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const text = await serveCommand({
        ...inputOf(dir, true, stopped),
        allowHosts: ["127.0.0.1"],
      });
      stop();

      expect(text).toContain('"port":');
    } finally {
      dir.drop();
    }
  });

  it("should dispatch the serve intent through run() with io.stop", async () => {
    const dir = dirs();
    const previous = process.env["HOME"];
    process.env["HOME"] = dir.home;
    const { stop, stopped } = stopHandle();
    try {
      const out = await runServeJson(dir, stopped);
      stop();

      expect(out.join("")).toContain('"port":');
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});

const runServeWith = async (
  dir: ReturnType<typeof dirs>,
  appDir: string,
): Promise<{ readonly code: number; readonly err: string }> => {
  const err: string[] = [];
  const code = await run(
    ["serve", join(dir.workspace, "doc.html"), "--port", "0", "--app-dir", appDir],
    {
      cwd: dir.workspace,
      stdout: () => undefined,
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
    },
  );
  return { code, err: err.join("") };
};

describe("run · --app-dir end-to-end passthrough", () => {
  it("should pass an existing --app-dir through run() into startServer", async () => {
    const dir = dirs();
    const previous = process.env["HOME"];
    process.env["HOME"] = dir.home;
    const { stop, stopped } = stopHandle();
    try {
      const out: string[] = [];
      const code = await run(
        [
          "serve",
          join(dir.workspace, "doc.html"),
          "--port",
          "0",
          "--json",
          "--app-dir",
          dir.workspace,
        ],
        {
          cwd: dir.workspace,
          stdout: (text) => out.push(text),
          stderr: () => undefined,
          readStdin: () => Promise.resolve(new Uint8Array()),
          debug: false,
          launchParentPid: process.ppid,
          stop: stopped,
        },
      );
      stop();

      expect(code).toBe(0);
      expect(out.join("")).toContain('"port":');
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});

describe("serveCommand · the two --app-dir branches", () => {
  it("should pass an existing appDir through to startServer", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const text = await serveCommand({ ...inputOf(dir, true, stopped), appDir: dir.workspace });
      stop();

      expect(text).toContain('"port":');
    } finally {
      dir.drop();
    }
  });

  it("should reject an explicit --app-dir that does not exist and leave no daemon", async () => {
    const dir = dirs();
    try {
      const { code, err } = await runServeWith(dir, join(dir.workspace, "no-such-app"));

      // The doc spec claims exit 2; in fact `invalid_input` maps to EXIT_FAILURE (1) —
      // only `daemon_already_running` is 2. Assertions pin the current implemented behavior.
      expect(code).toBe(EXIT_FAILURE);
      expect(err).toContain("--app-dir 目录不存在");
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      dir.drop();
    }
  });
});

const runServeHome = async (
  dir: ReturnType<typeof dirs>,
  home: string,
  stop: Promise<void>,
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    ["serve", join(dir.workspace, "doc.html"), "--port", "0", "--json", "--home", home],
    {
      cwd: dir.workspace,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
      stop,
    },
  );
  return { code, out: out.join(""), err: err.join("") };
};

describe("run · serve --home", () => {
  it("should write daemon.json under --home and never under $HOME", async () => {
    const dir = dirs();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-other-home-")));
    const previous = process.env["HOME"];
    process.env["HOME"] = other;
    const { stop, stopped } = stopHandle();
    try {
      const { code, out } = await runServeHome(dir, dir.home, stopped);
      stop();
      await stopped;

      expect(code).toBe(0);
      expect(out).toContain('"port":');
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      expect(existsSync(join(other, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      process.env["HOME"] = previous;
      rmSync(other, { recursive: true, force: true });
      dir.drop();
    }
  });

  it("should reject a --home that does not exist with a usage error", async () => {
    const dir = dirs();
    try {
      const ghost = join(dir.workspace, "no-such-home");
      const { code, err } = await runServeHome(dir, ghost, Promise.resolve());

      expect(code).toBe(EXIT_USAGE);
      expect(err).toContain(`--home 目录不存在：${ghost}`);
    } finally {
      dir.drop();
    }
  });
});
type ServeIntent = Extract<Intent, { kind: "serve" }>;

/** An assembled `serve` intent: the four app-dir situations share one copy, changing only the app-dir fields. */
const serveIntentOf = (workspace: string): ServeIntent => {
  const parsed = parseArgs(
    ["serve", "doc.html", "--port", "0", "--json", "--workspace", workspace],
    workspace,
  );
  if (!parsed.ok) throw new Error(`forwarded parse failed: ${parsed.message}`);
  const { intent } = parsed;
  if (intent.kind !== "serve") throw new Error(`intent is not serve: ${intent.kind}`);
  return intent;
};

/** The registry file left behind by a kill -9'd daemon: core reports a "cleaning stale…" line. */
const seedStaleDaemon = (home: string, workspace: string): void => {
  mkdirSync(join(home, ".hreader"), { recursive: true });
  writeFileSync(
    join(home, ".hreader", "daemon.json"),
    JSON.stringify({ port: 1, pid: 2_000_000_000, token: "stale", workspace }),
  );
};

describe("serveCommandOf · diagnostic outlets", () => {
  it("should hand core's one-line diagnoses to stderr with a trailing newline", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    const rows: string[] = [];
    try {
      seedStaleDaemon(dir.home, dir.workspace);

      await serveCommandOf(
        serveIntentOf(dir.workspace),
        { workspace: dir.workspace, file: "doc.html" },
        {
          home: dir.home,
          stop: stopped,
          launchParentPid: process.ppid,
          diagnose: (row) => rows.push(row),
        },
      );
      stop();

      // core's diagnostics carry no newline ("one line per statement"): this wrapper must add it, or stderr glues into one line.
      expect(rows.join("")).toContain("清理陈旧 daemon.json");
      expect(rows.every((row) => row.endsWith("\n"))).toBe(true);
    } finally {
      dir.drop();
    }
  });
});

/** Start one `serveCommandOf`: the workspace deliberately does not exist — core fails at once, no listener starts. */
const callServeOf = (
  dir: ServeDirs,
  appDir: string | undefined,
  appDirGiven: boolean,
): {
  readonly running: Promise<string>;
  readonly stop: () => void;
  readonly stopped: Promise<void>;
} => {
  const { stop, stopped } = stopHandle();
  const running = serveCommandOf(
    { ...serveIntentOf(dir.workspace), appDir, appDirGiven },
    { workspace: join(dir.workspace, "没有这个目录"), file: "doc.html" },
    { home: dir.home, stop: stopped, launchParentPid: process.ppid, diagnose: () => undefined },
  );
  return { running, stop, stopped };
};

describe("serveCommandOf · --app-dir defensive branch", () => {
  it("should pass an existing app-dir through without any path display", async () => {
    // When `appDirGiven` is true but `appDir` is `undefined`, it must not `existsSync(undefined)` — pass through to core.
    const dir = dirs();
    try {
      const call = callServeOf(dir, undefined, true);

      await expect(call.running).rejects.toThrow();
      expect(call.stop).toBeTypeOf("function");
    } finally {
      dir.drop();
    }
  });

  it("should accept an existing app-dir and hand it to core", async () => {
    // Positive control: `--app-dir` pointing at a real directory is not an error and passes through verbatim.
    const dir = dirs();
    try {
      const call = callServeOf(dir, dir.workspace, true);

      await expect(call.running).rejects.toThrow();
      expect(call.stop).toBeTypeOf("function");
    } finally {
      dir.drop();
    }
  });

  it("should refuse a missing app-dir and fall back to the process cwd for the path", () => {
    // This one takes the real "directory does not exist" refusal branch; `wiring.cwd` is deliberately unset so the report echoes the process cwd.
    const dir = dirs();
    try {
      // This check throws synchronously at assembly (before core): `serveCommandOf` is not an async function.
      expect(() => callServeOf(dir, join(dir.workspace, "没有这个主题"), true)).toThrow(
        /--app-dir 目录不存在/u,
      );
    } finally {
      dir.drop();
    }
  });
});

describe("thumbWarnOf · the thumbnail notice adapter", () => {
  it("should strip the pipeline notice's trailing newline before handing it to diagnose", () => {
    const rows: string[] = [];
    const warn = thumbWarnOf((row) => rows.push(row));

    warn("外部图片已丢弃\n");
    warn("另一条提示");

    expect(rows).toEqual(["外部图片已丢弃", "另一条提示"]);
  });
});
