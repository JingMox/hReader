// 这层管：`hr serve` 的真子进程生命周期——输出形状、SIGTERM 收尾、daemon.json、端口释放、fd。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const ENTRY = join(REPO, "packages", "cli", "src", "main.ts");
const DOC =
  '<!doctype html><html><body><article data-hr-id="hr-a"><p>正文</p></article></body></html>';

const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-")));
const workspace = realpathSync(mkdtempSync(join(root, "ws-")));
const home = realpathSync(mkdtempSync(join(root, "home-")));
writeFileSync(join(workspace, "doc.html"), DOC, "utf8");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const fdCount = (): number => readdirSync("/dev/fd").length;

interface Served {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}

const portClosed = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(true);
    });
  });

const spawnServe = (): ReturnType<typeof spawn> =>
  spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      ENTRY,
      "serve",
      "doc.html",
      "--port",
      "0",
      "--json",
      "--workspace",
      workspace,
    ],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home, HR_DEBUG: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    },
  );

const firstLineOf = (child: ReturnType<typeof spawn>): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let buffer = "";
    const out = child.stdout;
    if (out === null) {
      reject(new Error("serve 没有 stdout 管道"));
      return;
    }
    out.setEncoding("utf8");
    out.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) resolve(buffer.slice(0, index));
    });
    child.on("error", reject);
    setTimeout(() => {
      reject(new Error("serve 未在 10s 内打印启动行"));
    }, 10_000);
  });

const servedOf = (line: string, pid: number): Served => {
  const envelope: unknown = JSON.parse(line);
  if (typeof envelope !== "object" || envelope === null || !("data" in envelope))
    throw new Error("启动行形状不对");
  const data: unknown = envelope.data;
  if (typeof data !== "object" || data === null) throw new Error("启动行没有 data");
  const port = "port" in data ? data.port : 0;
  const token = "token" in data ? data.token : "";
  return { port: typeof port === "number" ? port : 0, token: String(token), pid };
};

const startServe = async (): Promise<{
  readonly child: ReturnType<typeof spawn>;
  readonly served: Served;
  readonly exit: Promise<number | null>;
}> => {
  const child = spawnServe();
  const exit = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => {
      resolve(code);
    }),
  );
  const line = await firstLineOf(child);
  return { child, served: servedOf(line, child.pid ?? 0), exit };
};

describe("hr serve · 生命周期", () => {
  it("should print the daemon envelope, then release port + daemon.json on SIGTERM", async () => {
    const before = fdCount();
    const { child, served, exit } = await startServe();
    const daemon = join(home, ".hreader", "daemon.json");

    expect(served.port).toBeGreaterThan(0);
    expect(served.token.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(daemon)).toBe(true);
    child.kill("SIGTERM");
    const code = await exit;

    expect(code).toBe(0);
    expect(existsSync(daemon)).toBe(false);
    expect(await portClosed(served.port)).toBe(true);
    expect(fdCount()).toBeLessThanOrEqual(before + 2);
  });
});

describe("hr serve · 第二个信号入口", () => {
  it("should clean up identically on SIGINT", async () => {
    const { child, served, exit } = await startServe();
    const daemon = join(home, ".hreader", "daemon.json");

    child.kill("SIGINT");
    const code = await exit;

    expect(code).toBe(0);
    expect(existsSync(daemon)).toBe(false);
    expect(await portClosed(served.port)).toBe(true);
  });
});

describe("hr serve · 生命周期（续）", () => {
  it("should exit non-zero with a JSON error when the file does not exist", async () => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        ENTRY,
        "serve",
        "nope.html",
        "--port",
        "0",
        "--json",
        "--workspace",
        workspace,
      ],
      {
        cwd: workspace,
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
    const out = await new Promise<string>((resolve) => {
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.on("exit", () => {
        resolve(text);
      });
    });

    expect(out).toContain('"ok":false');
    expect(out).toContain("not_a_file");
  });
});
