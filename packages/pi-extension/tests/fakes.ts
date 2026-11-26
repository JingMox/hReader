// Test doubles: scripted-byte SSE feeds, fakes of Pi's registration surface and UI, and a fake
// `~/.hreader/daemon.json` disk read. Doubles implement **shape** only on purpose: `fetch` bodies are
// enqueued chunk by chunk from an explicit `Uint8Array[]` (the case picks the cut points), the command
// context can flip to `hasUI: false`, and `confirm` draws `true/false/throws` from a queue.

import type {
  FetchLike,
  HreaderCommandOptions,
  HreaderContext,
  HreaderCustomMessage,
  HreaderDeps,
  HreaderPi,
  HreaderRequest,
  HreaderTool,
  HreaderToolResult,
  HreaderUi,
} from "../pi-hreader.ts";
import { holdDelayOf } from "./sse-fakes.ts";

export interface RecordedNotify {
  readonly message: string;
  readonly type: string | undefined;
}

/** One entry of `confirms`: a pre-queued confirm answer, where `"throw"` simulates "confirm is unavailable in this mode". */
export type ConfirmAnswer = boolean | "throw";

export interface FakeContext {
  readonly ctx: HreaderContext;
  readonly notifies: readonly RecordedNotify[];
  /** `title\nbody` of every `confirm`, in call order. */
  readonly confirms: readonly string[];
}

export const fakeContextOf = (
  options: {
    readonly hasUI?: boolean;
    readonly confirms?: readonly ConfirmAnswer[];
  } = {},
): FakeContext => {
  const notifies: RecordedNotify[] = [];
  const confirms: string[] = [];
  const queue = [...(options.confirms ?? [])];
  const next = (): boolean => {
    const answer = queue.shift();
    if (answer === "throw") throw new Error("confirm 不可用");
    return answer ?? false;
  };
  const ui: HreaderUi = {
    notify: (message, type) => {
      notifies.push({ message, type });
    },
    confirm: (title, message) => {
      confirms.push(`${title}\n${message}`);
      return Promise.resolve(next());
    },
  };
  return { ctx: { ui, hasUI: options.hasUI ?? true, cwd: "/work" }, notifies, confirms };
};

export interface FakePi {
  readonly pi: HreaderPi;
  readonly commands: ReadonlyMap<string, HreaderCommandOptions>;
  readonly tools: ReadonlyMap<string, HreaderTool>;
  /** Messages received by `sendMessage`, in order. */
  readonly sentMessages: readonly HreaderCustomMessage[];
  /** Handler registered via `on("session_shutdown", …)`: the test calls it itself to simulate Pi winding down. */
  readonly shutdown: readonly (() => void)[];
}

export const fakePiOf = (): FakePi => {
  const commands = new Map<string, HreaderCommandOptions>();
  const tools = new Map<string, HreaderTool>();
  const sentMessages: HreaderCustomMessage[] = [];
  const shutdown: (() => void)[] = [];
  return {
    pi: {
      registerCommand: (name, options) => {
        commands.set(name, options);
      },
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
      sendMessage: (message) => {
        sentMessages.push(message);
      },
      on: (_event, handler) => {
        shutdown.push(handler);
        return () => {
          shutdown.pop();
        };
      },
    },
    commands,
    tools,
    sentMessages,
    shutdown,
  };
};

/** Default for "no fetch stubbed": must not be called — throws if it is, so a case cannot pass silently. */
const missingFetch: FetchLike = () => Promise.reject(new Error("用例没有提供 fetch 替身"));

/** Disk-read double: paths absent from `files` throw "file does not exist", matching real `node:fs` observable behavior. */
export const fakeReadFileOf =
  (files: Readonly<Record<string, string>>) =>
  (file: string): Promise<Uint8Array> => {
    const text = files[file];
    if (text === undefined)
      return Promise.reject(new Error(`ENOENT: no such file, open '${file}'`));
    return Promise.resolve(new TextEncoder().encode(text));
  };

export interface FakeDeps {
  readonly deps: HreaderDeps;
  /** Raw arguments of every fetch; cookie/CSRF/`Last-Event-ID` assertions read from it. */
  readonly requests: readonly { readonly url: string; readonly request: HreaderRequest }[];
}

export const fakeDepsOf = (
  options: {
    readonly home?: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly fetch?: FetchLike;
    readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly daemon?: string;
  } = {},
): FakeDeps => {
  const requests: { url: string; request: HreaderRequest }[] = [];
  const home = options.home ?? "/home";
  const files: Record<string, string> = { ...options.files };
  if (options.daemon !== undefined) files[`${home}/.hreader/daemon.json`] = options.daemon;
  const fetch = options.fetch ?? missingFetch;
  return {
    deps: {
      home,
      readFile: fakeReadFileOf(files),
      fetch: (url, request) => {
        requests.push({ url, request });
        return fetch(url, request);
      },
      delay: options.delay ?? holdDelayOf(),
    },
    requests,
  };
};

export const callToolOf = (
  fake: FakePi,
  name: string,
  params: Readonly<Record<string, unknown>>,
  ctx: HreaderContext,
): Promise<HreaderToolResult> => {
  const tool = fake.tools.get(name);
  if (tool === undefined) throw new Error(`工具没注册：${name}`);
  return tool.execute("call-1", params, undefined, undefined, ctx);
};

/** Runs a slash command once (throws when unregistered — a case must not pass silently). */
export const runCommandOf = (
  fake: FakePi,
  name: string,
  args: string,
  ctx: HreaderContext,
): Promise<void> => {
  const command = fake.commands.get(name);
  if (command === undefined) throw new Error(`命令没注册：${name}`);
  return command.handler(args, ctx);
};

export const daemonJsonOf = (fields: {
  readonly port?: number;
  readonly token?: string;
  readonly pid?: number;
  readonly workspace?: string;
}): string =>
  JSON.stringify({
    port: fields.port ?? 5175,
    token: fields.token ?? "tok-123",
    pid: fields.pid ?? 4321,
    workspace: fields.workspace ?? "/work",
  });
