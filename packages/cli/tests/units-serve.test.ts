// 这层管：`serveCommand` 的进程内行为（子进程案只验生命周期，覆盖率要靠这条）。

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { serveCommand } from "../src/commands/serve";
import { run } from "../src/run";

const DOC =
  '<!doctype html><html><body><article data-hr-id="hr-a"><p>x</p></article></body></html>';

const dirs = (): {
  readonly workspace: string;
  readonly home: string;
  readonly drop: () => void;
} => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-ws-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-home-")));
  writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
  return {
    workspace,
    home,
    drop: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
};

const inputOf = (
  dir: { readonly workspace: string; readonly home: string },
  json: boolean,
  stop: Promise<void>,
): Parameters<typeof serveCommand>[0] => ({
  file: "doc.html",
  workspace: dir.workspace,
  home: dir.home,
  port: 0,
  json,
  stop,
});

describe("serveCommand", () => {
  it("should print the json envelope and stay up until stop resolves", async () => {
    const dir = dirs();
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    try {
      const text = await serveCommand(inputOf(dir, true, stopped));

      expect(text).toMatch(/^\{.*\}\n$/u);
      expect(text).toContain('"port":');
      expect(text).toContain('"token":"');
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      stop();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      dir.drop();
    }
  });

  it("should print the human line when --json is off", async () => {
    const dir = dirs();
    try {
      let stop: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const text = await serveCommand(inputOf(dir, false, stopped));
      stop();

      expect(text).toMatch(/^serving .+ on http:\/\/127\.0\.0\.1:\d+\/ \(pid \d+\)\n$/u);
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
    stop: stopped,
  });
  return out;
};

describe("serveCommand · allowHosts 与 run 分发", () => {
  it("should pass an explicit allowHosts list through to startServer", async () => {
    const dir = dirs();
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
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
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
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
