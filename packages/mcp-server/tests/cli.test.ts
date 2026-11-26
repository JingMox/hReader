// This layer: `cli.ts`'s argument parsing, exit codes and transport startup (all io injected, no real processes);
// the two-line shell of `main.ts` is also evaluated once here (the real-subprocess check lives in `stdio.test.ts`, the shape the host sees).

import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  cliIoOf,
  modeOf,
  portOfAddress,
  runMain,
  startHttp,
  USAGE,
  warningLinesOf,
  workspaceWarningOf,
} from "../src/cli";

const stderrLines = (): string[] => {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return written;
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("warningLinesOf", () => {
  it("should stay silent when the theme resources are found, and speak up when they are not", () => {
    expect(warningLinesOf(undefined)).toEqual([]);
    expect(warningLinesOf("WARNING 主题资源缺失：/nope")).toEqual(["WARNING 主题资源缺失：/nope"]);
  });
});

describe("modeOf", () => {
  it("should default to stdio when no argument is given", () => {
    expect(modeOf([])).toEqual({ kind: "stdio" });
  });

  it("should answer --help wherever it appears", () => {
    expect(modeOf(["--http", "3000", "--help"])).toEqual({ kind: "help" });
  });

  it("should parse --http with a port", () => {
    expect(modeOf(["--http", "3000"])).toEqual({ kind: "http", port: 3000 });
  });

  it("should reject an out-of-range port", () => {
    expect(modeOf(["--http", "70000"]).kind).toBe("bad");
    expect(modeOf(["--http", "abc"]).kind).toBe("bad");
  });

  it("should reject unknown arguments instead of guessing", () => {
    expect(modeOf(["--serve"])).toEqual({ kind: "bad", reason: "无法识别的参数：--serve" });
    expect(modeOf(["--http"]).kind).toBe("bad");
    expect(modeOf(["--http", "3000", "--http", "3001"])).toEqual({
      kind: "bad",
      reason: "重复的参数：--http",
    });
  });
});

describe("modeOf --workspace", () => {
  it("should parse --workspace alongside stdio and --http and reject missing/duplicate values", () => {
    expect(modeOf(["--workspace", "/tmp/ws"])).toEqual({ kind: "stdio", workspace: "/tmp/ws" });
    expect(modeOf(["--workspace", "/tmp/ws", "--http", "3000"])).toEqual({
      kind: "http",
      port: 3000,
      workspace: "/tmp/ws",
    });
    expect(modeOf(["--http", "3000", "--workspace", "/tmp/ws"])).toEqual({
      kind: "http",
      port: 3000,
      workspace: "/tmp/ws",
    });
    expect(modeOf(["--workspace"])).toEqual({
      kind: "bad",
      reason: "缺少工作区路径：--workspace",
    });
    expect(modeOf(["--workspace", "   "]).kind).toBe("bad");
    expect(modeOf(["--workspace", "/a", "--workspace", "/b"])).toEqual({
      kind: "bad",
      reason: "重复的参数：--workspace",
    });
  });
});

describe("workspaceWarningOf", () => {
  it("should warn when workspace is filesystem root or HOME, and stay quiet otherwise", () => {
    expect(workspaceWarningOf("/")).toContain("WARNING 工作区范围过大");
    expect(workspaceWarningOf("/Users/demo-user", "/Users/demo-user")).toContain(
      "WARNING 工作区范围过大",
    );
    expect(workspaceWarningOf("/tmp/project", "/Users/demo-user")).toBeUndefined();
  });
});

describe("runMain", () => {
  it("should print the usage on stderr and exit 0 for --help", async () => {
    const lines = stderrLines();

    await expect(runMain(["--help"])).resolves.toBe(0);
    expect(lines.join("")).toContain(USAGE);
  });

  it("should exit 2 with the usage for a bad argument", async () => {
    const lines = stderrLines();

    await expect(runMain(["--nope"])).resolves.toBe(2);
    expect(lines.join("")).toContain("无法识别的参数");
  });

  it("should exit 1 when the chosen transport cannot start", async () => {
    const lines = stderrLines();
    const code = await runMain(["--http", "3000"], {
      startStdio: () => Promise.resolve(),
      startHttp: () => Promise.reject(new Error("端口被占用")),
    });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("启动失败：端口被占用");
  });

  it("should exit 0 and log the port once http is listening", async () => {
    const lines = stderrLines();
    const code = await runMain(["--http", "3000"], {
      startStdio: () => Promise.resolve(),
      startHttp: () => Promise.resolve({ port: 3000, close: () => Promise.resolve() }),
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("http://127.0.0.1:3000/");
  });
});

describe("runMain · stdio", () => {
  it("should exit 0 once the stdio transport is attached", async () => {
    const code = await runMain([], { startStdio: () => Promise.resolve(), startHttp: startHttpOf });

    expect(code).toBe(0);
  });

  it("should invoke custom chdir when --workspace is given", async () => {
    const dirs: string[] = [];
    const code = await runMain(["--workspace", "/tmp/custom-ws"], {
      startStdio: () => Promise.resolve(),
      startHttp: startHttpOf,
      chdir: (dir) => {
        dirs.push(dir);
      },
    });

    expect(code).toBe(0);
    expect(dirs).toEqual(["/tmp/custom-ws"]);
  });

  it("should switch real process cwd with default chdir when --workspace is passed", async () => {
    const saved = process.cwd();
    const target = tmpdir();
    try {
      const code = await runMain(["--workspace", target], {
        startStdio: () => Promise.resolve(),
        startHttp: startHttpOf,
      });
      expect(code).toBe(0);
    } finally {
      process.chdir(saved);
    }
  });
});

describe("cliIoOf", () => {
  it("should connect the server to the transport the caller supplies", async () => {
    const [clientSide] = InMemoryTransport.createLinkedPair();

    await expect(cliIoOf(() => clientSide).startStdio()).resolves.toBeUndefined();
  });

  it("should turn a transport error into one stderr line instead of dying silently", async () => {
    const written = stderrLines();
    const [clientSide] = InMemoryTransport.createLinkedPair();

    await cliIoOf(() => clientSide).startStdio();
    clientSide.onerror?.(new Error("ReadBuffer exceeded maximum size of 10485760 bytes"));

    expect(written.join("")).toContain("[hreader-mcp] 传输错误：ReadBuffer exceeded maximum size");
  });
});

describe("portOfAddress", () => {
  it("should read the port off a tcp address", () => {
    expect(portOfAddress({ address: "127.0.0.1", family: "IPv4", port: 3000 })).toBe(3000);
  });

  it("should refuse a server that is not listening on tcp", () => {
    expect(() => portOfAddress(null)).toThrow(/没有 TCP 端口/u);
    expect(() => portOfAddress("\\\\?\\pipe\\hr")).toThrow(/没有 TCP 端口/u);
  });
});

const startHttpOf = (): never => {
  throw new Error("runMain should never reach startHttp in stdio mode");
};

describe("startHttp", () => {
  it("should bind 127.0.0.1, serve /mcp and report the port it actually got", async () => {
    const running = await startHttp(0);

    expect(running.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${String(running.port)}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cli-test", version: "0.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(running.close()).resolves.toBeUndefined();
  });
});

describe("main.ts · process shell", () => {
  it("should hand argv to runMain and set the exit code", async () => {
    const lines = stderrLines();
    process.argv = [process.execPath, "main.ts", "--help"];

    await import("../src/main");

    expect(process.exitCode).toBe(0);
    expect(lines.join("")).toContain(USAGE);
  });
});
