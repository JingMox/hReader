// 这层管：测试替身——按字节脚本喂 SSE、伪造 Pi 的注册面与 UI、伪造 `~/.hreader/daemon.json` 的读盘。
// 替身故意只实现**形状**：`fetch` 的 body 由显式 `Uint8Array[]` 逐块 enqueue（切点由用例决定），
// 命令上下文可切成 `hasUI: false`，`confirm` 从队列里取 `true/false/throws`。

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

/** `confirms` 里的一项：预先排队的 confirm 答案，`"throw"` 模拟"该模式下 confirm 根本不可用"。 */
export type ConfirmAnswer = boolean | "throw";

export interface FakeContext {
  readonly ctx: HreaderContext;
  readonly notifies: readonly RecordedNotify[];
  /** 每次 `confirm` 的 `标题\n正文`，顺序与调用一致。 */
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
  /** `sendMessage` 收到的消息，按顺序。 */
  readonly sentMessages: readonly HreaderCustomMessage[];
  /** `on("session_shutdown", …)` 注册的处理器：测试自己调用它来模拟 Pi 收尾。 */
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

/** "未实现任何 fetch" 的默认值：不该被调用；被调用就抛，免得用例静默通过。 */
const missingFetch: FetchLike = () => Promise.reject(new Error("用例没有提供 fetch 替身"));

/** 读盘替身：`files` 里没有的路径按"文件不存在"抛错，与真 `node:fs` 的可观察行为一致。 */
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
  /** 每次 fetch 的原始入参，断言 cookie/CSRF/`Last-Event-ID` 就查它。 */
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

/** 跑一次斜杠命令（命令没注册就抛，别让用例静默通过）。 */
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
