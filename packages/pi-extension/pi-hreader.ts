// 这层管：hReader 的 Pi 扩展——订阅 daemon 的 SSE 事件、把文档推给阅读器、向会话注入批注。
// Pi 只把**单个模块**当扩展加载（`~/.pi/agent/extensions/*/pi-hreader.ts` 或 `pi -e ./pi-hreader.ts`），
// 所以全部实现都在本文件：零本地相对 import、零 `@hreader/*`。
// 因此这里是 core 协议知识的第二份拼写（有意的重复），约束手段是 `tests/protocol-pins.test.ts` 的漂移钉子，不是共享代码。
// 纯层（帧解析 / 路径推导 / 错误文本 / 节点切片）在前；副作用（文件/网络/定时器）只经 `HreaderDeps` 注入。
// Pi 的类型是从 `pi-coding-agent@1.5.2` 的 d.ts **手抄**的（不装该依赖，它的 d.ts 要求 DOM 与完整
// `@types/node`，与本仓 `lib: ["ES2023"]` + `types: []` + `skipLibCheck: false` 冲突）。原文如下，类型一漂移就比这几段：
//   ExtensionUIContext（dist/core/extensions/types.d.ts:83-91）
//     confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
//     notify(message: string, type?: "info" | "warning" | "error"): void;
//   ExtensionContext（:233-241）
//     ui: ExtensionUIContext; mode: ExtensionMode; hasUI: boolean; cwd: string;
//   RegisteredCommand（:1214）
//     handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
//   ExtensionAPI（:1228、:1303、:1312）
//     sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
//       options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
//     sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { ... }): void;
//   ToolDefinition.execute（:519）
//     execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
//       onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Type, type Static, type TSchema } from "typebox";

const DAEMON_DIR = ".hreader";
const DAEMON_FILE = "daemon.json";
const DAEMON_MISSING_HINT = "hReader daemon 没在跑：先运行 `hr serve`（本扩展不会自己拉起进程）";
const USAGE_HINT = "用法：/hreader <path>——相对 daemon 的 workspace 或绝对路径";

/** 认证链路（`packages/core/src/server/auth.ts:7`）：cookie 名固定 `hr`，值就是 daemon token。 */
const COOKIE_NAME = "hr";
/** 写命令的 CSRF 头（`auth.ts:9`），值是字面量 `"1"`（`auth.ts:68` `csrfAllowed = (value) => value === "1"`）。 */
const CSRF_HEADER = "x-hr-csrf";
const CSRF_VALUE = "1";
/** core 在 `ready` 帧里给的 `retry: 2000`（`event-ring.ts:74`）：扩展侧按同一节奏重连。 */
export const RECONNECT_MS = 2000;
/** 无换行的巨型错误体不许一路攒到 `flush()`：超过就弃帧重连（环里有 `Last-Event-ID` 兜底）。 */
const SSE_BUFFER_LIMIT = 1024 * 1024;
/** 批注的"待处理"状态集（`packages/core/src/meta/constants.ts` `PENDING_ANNOTATION_STATUSES`）：旧版 `pending_ai` 与阅读器写的 `pending` 两态并存。 */
const PENDING_ANNOTATION_STATUSES: ReadonlySet<string> = new Set(["pending_ai", "pending"]);
/** `doc.changed` 的正文只有这四个业务类型（`runtime.ts:88/106/110/118/232`、`server.ts:159`）。 */
export const BUSINESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "doc.changed",
  "doc.error",
  "library.changed",
  "error",
]);

/** patch 的五个动作（`packages/core/src/ops/patchNode/constants.ts:3` `PatchAction`）。 */
export const PATCH_ACTIONS = [
  "replace",
  "insert_before",
  "insert_after",
  "append",
  "delete",
] as const;

/** `daemon.json` 的形状，与 `packages/core/src/server/contracts.ts` 的 `DaemonInfo` 同构。 */
export interface DaemonInfo {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly workspace: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const jsonOfText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** core 从不下发 `event:` 行，类型只在 `data` 的 JSON 里：取不出来就是坏帧。 */
const eventOf = (envelope: SseEnvelope): HreaderEvent | undefined => {
  const value = jsonOfText(envelope.data);
  if (!isRecord(value) || typeof value["type"] !== "string") return undefined;
  return { type: value["type"], payload: value, id: envelope.id };
};

const daemonFieldsOf = (record: Readonly<Record<string, unknown>>): DaemonInfo | undefined => {
  const port = record["port"];
  const token = record["token"];
  const pid = record["pid"];
  const workspace = record["workspace"];
  if (!isPositiveInt(port) || !isPositiveInt(pid)) return undefined;
  if (!isNonEmptyString(token) || !isNonEmptyString(workspace)) return undefined;
  return { port, token, pid, workspace };
};

/** 字段类型不对就当"没有 daemon"：坏文件不能把扩展带进半吊子状态。 */
export const parseDaemon = (text: string): DaemonInfo | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(value) ? daemonFieldsOf(value) : undefined;
};

export const daemonFileOf = (home: string): string => join(home, DAEMON_DIR, DAEMON_FILE);

/** 读 `daemon.json`：文件缺失/坏 JSON/权限问题一律当"daemon 没起"（提示里给的命令能修好这三种）。 */
export const readDaemonOf = async (deps: HreaderDeps): Promise<DaemonInfo | undefined> => {
  try {
    return parseDaemon(new TextDecoder().decode(await deps.readFile(daemonFileOf(deps.home))));
  } catch {
    return undefined;
  }
};

export type DocIdResult =
  | { readonly ok: true; readonly docId: string }
  | { readonly ok: false; readonly reason: "outside_workspace" };

/**
 * docId = 目标相对 daemon workspace 的路径，`/` 分隔（`GET /s/:docId` 与 `/api/doc/:docId/*` 都吃这个形状）。
 * 相对路径的基是 workspace 而不是 Pi 的 cwd；workspace 自身与越界路径都不算文档。
 * 前缀相似不是子目录：`relative` 而不是 `startsWith`，`/tmp/wsfoo` 不会被当成 `/tmp/ws` 下的文件。
 */
export const docIdOf = (workspace: string, target: string): DocIdResult => {
  const root = resolve(workspace);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: "outside_workspace" };
  }
  // 分隔符归一成 `/`：posix 上 `split(sep)` 是恒等变换，Windows 上把 `\` 换掉。
  // 注意后半句只在 win32 成立，本条路径**未在 Windows CI 上验证过**（本仓开发机是 darwin）。
  return { ok: true, docId: rel.split(sep).join("/") };
};

/** `GET /s/:docId` 用 `token` 认证（`routes.ts`），所以 URL 里的 `t` 就是 `daemon.json` 的 token。 */
export const readerUrlOf = (info: DaemonInfo, docId: string): string =>
  `${apiUrlOf(info, pathOf(ENDPOINTS.document, { docId }))}?t=${encodeURIComponent(info.token)}`;

/**
 * 扩展用到的每一条 HTTP 端点，逐条对应 `packages/core/src/server/routes.ts` 的 `route(...)` 行。
 * 所有 URL 都由这张表拼出来（不再有第二处路径字面量），所以漂移钉子钉的就是真实用法。
 */
export const ENDPOINTS = {
  events: { method: "GET", segments: ["api", "events"], auth: "cookie" },
  outline: { method: "GET", segments: ["api", "doc", ":docId", "outline"], auth: "cookie" },
  annotations: {
    method: "GET",
    segments: ["api", "doc", ":docId", "annotations"],
    auth: "cookie",
  },
  patch: { method: "POST", segments: ["api", "patch"], auth: "cookie+csrf" },
  // 可选视觉 id 的**唯一**来源（`static.ts:136` 返回 `{ themes, default }`）。
  themes: { method: "GET", segments: ["api", "theme"], auth: "none" },
  style: { method: "POST", segments: ["api", "style"], auth: "cookie+csrf" },
  document: { method: "GET", segments: ["s", ":docId"], auth: "token" },
} as const satisfies Readonly<Record<string, Endpoint>>;

export interface Endpoint {
  readonly method: "GET" | "POST";
  /** `:docId` 这样的段是占位符，其余是字面量（与 `routes.ts` 同一套写法）。 */
  readonly segments: readonly string[];
  readonly auth: "none" | "cookie" | "token" | "cookie+csrf";
}

/** 占位符段的值必须编码：`/` 在 `:docId` 里只能是 `%2F`（`routes.ts` 注释已确认）。 */
export const pathOf = (endpoint: Endpoint, params: Readonly<Record<string, string>> = {}): string =>
  `/${endpoint.segments
    .map((segment) =>
      segment.startsWith(":") ? encodeURIComponent(params[segment.slice(1)] ?? "") : segment,
    )
    .join("/")}`;

const apiUrlOf = (info: DaemonInfo, path: string): string =>
  `http://127.0.0.1:${String(info.port)}${path}`;

export interface SseEnvelope {
  /** `id:` 字段原文。`ready` 帧的 `id: 0` 不在环里，能不能当 `Last-Event-ID` 由订阅层判定。 */
  readonly id?: string;
  /** 同一帧多条 `data:` 行按 `\n` 拼接后的原文（core 只写一条）。 */
  readonly data: string;
}

export interface SseDecoder {
  /** 喂一块字节，只返回本轮**已完整**的帧；半个帧留在解码器里等下一块。 */
  readonly push: (chunk: Uint8Array) => readonly SseEnvelope[];
  /** 流结束时把最后一帧（缺空行终止符）交出来；流真截断在半个字/半行上时，残余丢弃。 */
  readonly flush: () => readonly SseEnvelope[];
  /** 缓冲区超限（对方不按 SSE 发东西）：已丢帧，调用方应断开重连。 */
  readonly overflowed: () => boolean;
}

interface DecodeState {
  readonly decoder: TextDecoder;
  readonly limit: number;
  buffer: string;
  data: readonly string[];
  id: string | undefined;
  overflow: boolean;
}

interface LineCut {
  readonly line: string;
  readonly rest: string;
}

/**
 * 切出一行。SSE 的行终止符可以是 `\r\n` / `\n` / `\r`；`\r` 落在块尾时无法判断是不是 `\r\n` 的前半，
 * 必须等下一块（`atEnd` 为真则按终止符处理）——这就是"终止符半分"切点。
 */
const cutLine = (buffer: string, atEnd: boolean): LineCut | undefined => {
  const index = buffer.search(/[\r\n]/);
  if (index === -1) return atEnd && buffer !== "" ? { line: buffer, rest: "" } : undefined;
  if (buffer[index] === "\r" && index === buffer.length - 1 && !atEnd) return undefined;
  const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
  return { line: buffer.slice(0, index), rest: buffer.slice(index + width) };
};

const applyField = (state: DecodeState, line: string): void => {
  const colon = line.indexOf(":");
  const name = colon === -1 ? line : line.slice(0, colon);
  const raw = colon === -1 ? "" : line.slice(colon + 1);
  const value = raw.startsWith(" ") ? raw.slice(1) : raw;
  if (name === "data") state.data = [...state.data, value];
  if (name === "id") state.id = value;
};

/** 一帧结束：没有 `data:` 就是注释/心跳（`: keep-alive`、`: ready`）或空行，直接丢弃。 */
const envelopeOf = (state: DecodeState): SseEnvelope | undefined => {
  const { data, id } = state;
  state.data = [];
  state.id = undefined;
  if (data.length === 0) return undefined;
  const joined = data.join("\n");
  return id === undefined ? { data: joined } : { id, data: joined };
};

const dropBuffer = (state: DecodeState): void => {
  state.overflow = true;
  state.buffer = "";
  state.data = [];
  state.id = undefined;
};

const pump = (state: DecodeState, atEnd: boolean): readonly SseEnvelope[] => {
  const envelopes: SseEnvelope[] = [];
  let cut = cutLine(state.buffer, atEnd);
  while (cut !== undefined) {
    state.buffer = cut.rest;
    if (cut.line === "") {
      const envelope = envelopeOf(state);
      if (envelope !== undefined) envelopes.push(envelope);
    } else {
      applyField(state, cut.line);
    }
    cut = cutLine(state.buffer, atEnd);
  }
  if (state.buffer.length > state.limit) dropBuffer(state);
  return state.overflow ? [] : envelopes;
};

/**
 * 增量 SSE 解码器：字节在**跨块**处才解码（`TextDecoder` 默认的流式模式），
 * 否则多字节 UTF-8 被块边界劈开就会出乱码而逐块单测全绿。
 */
export const createSseDecoder = (limit: number = SSE_BUFFER_LIMIT): SseDecoder => {
  const state: DecodeState = {
    decoder: new TextDecoder(),
    limit,
    buffer: "",
    data: [],
    id: undefined,
    overflow: false,
  };
  return {
    push: (chunk) => {
      if (state.overflow) return [];
      state.buffer += state.decoder.decode(chunk, { stream: true });
      return pump(state, false);
    },
    flush: () => {
      // 不带 `stream: true` 收尾：截断在半个字中间时按 U+FFFD 落地，然后整帧丢弃。
      state.buffer += state.decoder.decode();
      const envelopes = pump(state, true);
      const last = envelopeOf(state);
      if (last === undefined) return envelopes;
      // 断流截断是预期语义：残半行捞出来的帧若不成形就**静默**丢掉。报出去的话，每次普通断流
      // 都会让用户看到一条“疑似 core 协议漂移”假警报；真·流中坏帧仍由 `dispatchOf` 上报。
      return eventOf(last) === undefined ? envelopes : [...envelopes, last];
    },
    overflowed: () => state.overflow,
  };
};

/**
 * 扩展从 Pi 拿到的上下文里真正用到的部分（签名原文见文件头）。窄接口同时让测试替身
 * 不必伪造 Pi 的整套 API，也让本文件不必 `import type` 那个要求 DOM 的包。
 */
export interface HreaderUi {
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
}

export interface HreaderContext {
  readonly ui: HreaderUi;
  readonly hasUI: boolean;
  readonly cwd: string;
}

/** `RegisteredCommand.handler`：`args` 是斜杠命令后的整串，可能为空串。 */
export interface HreaderCommandOptions {
  readonly description: string;
  readonly handler: (args: string, ctx: HreaderContext) => Promise<void>;
}

export interface HreaderToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface HreaderTool<TParams extends TSchema = TSchema> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParams;
  // 方法语法是故意的：Pi 的 `ToolDefinition` 也是方法（双变），写成属性会让 `HreaderTool<typeof X>`
  // 因为 `params` 逆变而无法装进 `HreaderTool<TSchema>`（替身表就得强制转换）。
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: HreaderContext,
  ): Promise<HreaderToolResult>;
}

export interface HreaderCustomMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
}

/** `ExtensionAPI` 里本扩展用到的那部分；默认导出必须能被 Pi 当扩展工厂调用。 */
export interface HreaderPi {
  readonly registerCommand: (name: string, options: HreaderCommandOptions) => void;
  readonly registerTool: <TParams extends TSchema>(tool: HreaderTool<TParams>) => void;
  readonly sendMessage: (
    message: HreaderCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => void;
  readonly on: (event: "session_shutdown", handler: () => void) => () => void;
}

export interface FetchReply {
  readonly ok: boolean;
  readonly status: number;
  /** 事件流是 `ReadableStream`；一次性响应可以是 `null`（此时只读 `text()`）。 */
  readonly body: ReadableStream<Uint8Array> | null;
  readonly text: () => Promise<string>;
}

export interface HreaderRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type FetchLike = (url: string, request: HreaderRequest) => Promise<FetchReply>;

export interface HreaderDeps {
  /** `~`：`daemon.json` 在 `~/.hreader/` 下，测试给临时目录。 */
  readonly home: string;
  /** 读原始字节；UTF-8 解码在 `readDaemonOf` 里做，这样默认实现就是 `node:fs` 的原函数本身。 */
  readonly readFile: (file: string) => Promise<Uint8Array>;
  readonly fetch: FetchLike;
  /** 重连等待。默认实现必须 `unref()`，否则 Pi 的 print 模式退不出去。 */
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** daemon 的错误码文案（`packages/core/src/hr-error.ts` 的 `HrErrorCode` 全集，漏一个漂移钉子会红）。 */
export const ERROR_TEXTS: Readonly<Record<string, string>> = {
  invalid_html: "HTML 不合法",
  no_article: "文档里没有 `<article>`",
  node_not_found: "找不到该节点（id 可能已随上一次改动变化）",
  invalid_selector: "选择器不合法",
  invalid_document: "文档不合法",
  node_not_allowed: "该节点类型不允许这样改",
  invalid_max_bytes: "字节上限参数不合法",
  invalid_input: "入参不合法",
  locked: "文档正被另一个写请求占用",
  invalid_fragment: "片段不合法",
  forbidden_content: "片段里含脚本/样式等禁止内容",
  path_outside_workspace: "路径不在 daemon 的 workspace 里",
  not_a_file: "目标不是文件",
  io_failure: "daemon 读写文件失败",
  invalid_utf8: "文件不是合法 UTF-8",
  undo_unavailable: "没有可撤销的改动",
  invalid_style: "风格定义不合法",
  unknown_style: "没有这个风格",
  invalid_theme: "视觉主题不合法",
  style_io_failure: "主题样式表读写失败",
  not_found: "目标不存在",
  invalid_request: "请求不合法",
  busy: "daemon 正忙，请稍后重试",
  too_many_clients: "订阅者过多，daemon 拒绝了新连接",
  unauthorized: "认证失败（cookie/token 不对，daemon 可能已重启）",
  forbidden_origin: "来源被拒绝",
  daemon_already_running: "已经有一个 daemon 在跑",
  invalid_payload: "请求体不合法",
  nothing_to_undo: "没有可撤销的改动",
  anchor_lost: "批注锚点已失效（那段文字被改过了）",
  file_exists: "目标文件已存在（要覆盖请显式加 --force）",
  llm_failure: "风格建议层调用失败（检查 key / 网络，或用 --no-llm 走纯统计版）",
  empty_document: "文档正文裁掉交互 UI 后为空，没有可印的内容",
  chrome_missing: "找不到本机 Chrome（可用 HREADER_CHROME 指定）",
  chrome_failed: "Chrome 起不来或渲染失败",
  render_timeout: "渲染超时（Chrome 未在期限内完成）",
  render_empty: "Chrome 没有返回可用的 PDF/PNG",
  needs_normalize: "文档缺少 data-hr-id（先跑 hr normalize <file> --write）",
  port_in_use: "端口被别的进程占用（换一个 --port，或先停掉占它的进程）",
  content_model_conflict: "片段与目标容器内容模型冲突（换容器或改 --html）",
  duplicate_id: "两个元素共用一个 data-hr-id（只命中第一个）：先跑 hr normalize <file> --write",
};

export const errorTextOf = (code: string, detail?: string): string => {
  const text = ERROR_TEXTS[code] ?? "未知错误（看 daemon 日志）";
  return code.startsWith("http_")
    ? `daemon 返回 ${code.slice("http_".length)}：${text}`
    : detail === undefined || detail === ""
      ? `[${code}] ${text}`
      : `[${code}] ${text}——${detail}`;
};

/** 终端回显的长度上界：超长的 id（实测 4KB）会把一条 notify 撑成几千字符，满屏糊掉其它输出。 */
export const NOTIFY_MAX = 400;

/** 单行净化：控制字符（含 ESC 与换行）→ `?`。id 来自不可信的 workspace 目录名，回显 ESC 等于把终端交给 daemon；只用于**展示**（校验与 `POST` 用原值）。 */
export const safeTextOf = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }).join("");

/** 截断并附 `…`，结果**不超过** `max` 个字符。 */
export const clipTextOf = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** 用户输入的 id 回显上限：留住后面的可选列表，不让一大坨长输入把它挤掉。 */
const ECHO_MAX = 120;
/** 进终端的唯一出口：所有 `ctx.ui.notify` 都走它（消息自身的换行是故意的，所以只截断、不整条净化）。 */
export const notifyOf = (
  ctx: HreaderContext,
  message: string,
  type: "info" | "warning" | "error",
): void => {
  ctx.ui.notify(clipTextOf(message, NOTIFY_MAX), type);
};

/** 可选 id 的展示形式：逐个净化后用 `、` 拼。 */
export const idListTextOf = (ids: readonly string[]): string =>
  ids.map((id) => safeTextOf(id)).join("、");

/** 从 `/s/:docId` 取到的**源文件字节**里切出某个节点：core 没有 readNode 路由，节点源码只能从这里来。 */
export const nodeSliceOf = (html: string, nodeId: string): string | undefined => {
  const open = nodeId === "root" ? html.indexOf("<article") : findByIdOf(html, nodeId);
  if (open === undefined || open === -1) return undefined;
  const end = closeIndexOf(html, open);
  return end === undefined ? undefined : html.slice(open, end);
};

interface TagStart {
  readonly start: number;
  readonly name: string;
  readonly tagEnd: number;
  readonly selfClosing: boolean;
}
const findByIdOf = (html: string, nodeId: string): number | undefined => {
  const patterns = [`data-hr-id="${nodeId}"`, `data-hr-id='${nodeId}'`];
  for (const pattern of patterns) {
    const at = html.indexOf(pattern);
    if (at !== -1) return html.lastIndexOf("<", at);
  }
  return undefined;
};

const tagAtOf = (html: string, start: number): TagStart | undefined => {
  const head = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start, start + 40));
  if (head === null) return undefined;
  const tagEnd = html.indexOf(">", start);
  if (tagEnd === -1) return undefined;
  // `slice/join` 而不是 `head[1] ?? ""`：perFile 100% 下，兜底分支必须是能跑到的。
  return {
    start,
    name: head.slice(1, 2).join(""),
    tagEnd,
    selfClosing: html[tagEnd - 1] === "/",
  };
};

/** 从开标签往后数同名标签的嵌套深度，回到 0 就是该节点的收尾位置（`</tag>` 之后）。 */
const closeIndexOf = (html: string, start: number): number | undefined => {
  const tag = tagAtOf(html, start);
  if (tag === undefined) return undefined;
  if (tag.selfClosing || VOID_TAGS.has(tag.name)) return tag.tagEnd + 1;
  let depth = 1;
  let cursor = tag.tagEnd + 1;
  // 没有 `while (cursor < html.length)` 收尾：`closeAt + 1` 最多到 `length - 2`，
  // 所以"循环条件为假"这条出口永远走不到（perFile 100% 会把它变成红点）。收尾只走 `closeAt === -1`。
  for (;;) {
    const openAt = html.indexOf(`<${tag.name}`, cursor);
    const closeAt = html.indexOf(`</${tag.name}`, cursor);
    if (closeAt === -1) return undefined;
    if (openAt !== -1 && openAt < closeAt) {
      depth += 1;
      cursor = openAt + 1;
      continue;
    }
    depth -= 1;
    cursor = closeAt + 1;
    if (depth === 0) {
      // 没有 `>`（源文件被截断在半写的标签中间）时**不能**返回 `-1 + 1 = 0`：
      // 那会让 `html.slice(open, 0)` 得到空串，被上层当成“读到了空节点源码”。
      const end = html.indexOf(">", closeAt);
      return end === -1 ? undefined : end + 1;
    }
  }
};

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "img", "hr", "input", "meta", "link"]);

/** 读文档源文件（`/s/:docId` 是 token 认证，不吃 cookie）。 */
const documentOf = async (
  deps: HreaderDeps,
  info: DaemonInfo,
  docId: string,
): Promise<string | undefined> => {
  try {
    const reply = await deps.fetch(readerUrlOf(info, docId), {
      method: "GET",
      headers: {},
    });
    return reply.ok ? await reply.text() : undefined;
  } catch {
    return undefined;
  }
};

export type ApiResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly text: string };

const jsonOf = async (reply: FetchReply): Promise<unknown> => {
  try {
    return JSON.parse(await reply.text());
  } catch {
    return undefined;
  }
};

const failureTextOf = (status: number, value: unknown): string => {
  // 2xx 却不是 JSON 时，说“返回 200：未知错误”会把人往错方向引（那是代理/前端页插进来的时候）。
  if (status < 400 && !isRecord(value)) {
    return `daemon 返回 ${String(status)} 但响应不是 JSON（看 daemon 日志）`;
  }
  const codeOf = (): string =>
    isRecord(value) && typeof value["code"] === "string" ? value["code"] : `http_${String(status)}`;
  const code = safeTextOf(codeOf());
  const messageOf = (): string | undefined =>
    isRecord(value) && typeof value["message"] === "string"
      ? safeTextOf(value["message"])
      : undefined;
  return errorTextOf(code, messageOf());
};

/** 一次 API 调用：读命令带 cookie，写命令再带 `x-hr-csrf: 1`（`routes.ts` 的 auth 列）。 */
const apiOf = async (
  deps: HreaderDeps,
  info: DaemonInfo,
  endpoint: Endpoint,
  params: Readonly<Record<string, string>>,
  body?: Readonly<Record<string, unknown>>,
): Promise<ApiResult> => {
  // 写不写 CSRF 头由端点表里的 auth 决定，不在调用处再写一遍 `method === "POST"`。
  const write = endpoint.auth === "cookie+csrf";
  const headers: Record<string, string> = {
    cookie: `${COOKIE_NAME}=${info.token}`,
    "content-type": "application/json",
    ...(write ? { [CSRF_HEADER]: CSRF_VALUE } : {}),
  };
  try {
    const reply = await deps.fetch(apiUrlOf(info, pathOf(endpoint, params)), {
      method: endpoint.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await jsonOf(reply);
    if (reply.ok && isRecord(value)) return { ok: true, value };
    return { ok: false, text: failureTextOf(reply.status, value) };
  } catch {
    return { ok: false, text: errorTextOf("io_failure", "连不上 daemon（可能已退出）") };
  }
};

export interface HreaderEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly id: string | undefined;
}

export interface SubscribeHandlers {
  readonly onEvent: (event: HreaderEvent) => void;
  /** `reset` 帧（`event-ring.ts:83`）：环已过期，必须让用户知道事件丢了。 */
  readonly onStale: () => void;
  /** 一轮读流结束（断线/服务端关闭），即将重连。 */
  readonly onDown: () => void;
  /** 帧的 `data` 不是带 `type` 的 JSON 对象：丢掉它，但不能静默（那是协议漂移的样子）。 */
  readonly onBadFrame: (detail: string) => void;
}

export interface Subscription {
  readonly stop: () => void;
}

interface CycleContext {
  readonly deps: HreaderDeps;
  readonly info: DaemonInfo;
  readonly handlers: SubscribeHandlers;
  readonly signal: AbortSignal;
  /** 已报过的告警类别（`bad`/`down`），见 `reportOnceOf`。 */
  readonly reported: Set<"bad" | "down">;
  lastEventId: string | undefined;
}

/**
 * 一次订阅内同类告警只放行一条：一坏帧一提示在 50ms 的坏流上就是每秒 20 条永久刷屏。
 * 流健康过一次（收到业务事件）就清空，重连后再出问题可以再报一次。
 */
const reportOnceOf = (context: CycleContext, key: "bad" | "down"): boolean => {
  if (context.reported.has(key)) return false;
  context.reported.add(key);
  return true;
};

/** 一帧的去向：`reset` → 降级提示；四个业务类型 → 处理；其余（含 `ready`）忽略。 */
const dispatchOf = (context: CycleContext, envelope: SseEnvelope): void => {
  const event = eventOf(envelope);
  if (event === undefined) {
    if (reportOnceOf(context, "bad")) context.handlers.onBadFrame(envelope.data);
    return;
  }
  if (event.type === "reset") {
    context.handlers.onStale();
    return;
  }
  if (BUSINESS_EVENT_TYPES.has(event.type)) {
    context.reported.clear();
    context.handlers.onEvent(event);
  }
  // `ready` 的 `id: 0` 不在环里：拿它当 `Last-Event-ID` 会让重连从"环首"重新回放。
  if (event.id !== undefined && event.id !== "0") context.lastEventId = event.id;
};

/** 被 abort 的流上 `cancel()` 会 reject：Node 24 默认把未处理的 rejection 变成进程崩溃。 */
const cancelQuietlyOf = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  reader.cancel().catch(() => undefined);
};

const readStreamOf = async (
  context: CycleContext,
  body: ReadableStream<Uint8Array>,
): Promise<void> => {
  const reader = body.getReader();
  const onAbort = (): void => {
    cancelQuietlyOf(reader);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  const decoder = createSseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const envelope of decoder.push(value)) dispatchOf(context, envelope);
      if (decoder.overflowed()) return;
    }
    for (const envelope of decoder.flush()) dispatchOf(context, envelope);
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    // 溢出弃帧从 `return` 出去时也必须关掉 body：`loopOf` 2 秒后重连，不然每次溢出泄漏一个连接
    // （2s 一次溢出 = 无上界增长）。正常读完时 `cancel()` 是无害的 no-op。
    cancelQuietlyOf(reader);
  }
};

const headersOfEvents = (
  info: DaemonInfo,
  lastEventId: string | undefined,
): Record<string, string> => ({
  cookie: `${COOKIE_NAME}=${info.token}`,
  accept: "text/event-stream",
  ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
});

const runCycleOf = async (context: CycleContext): Promise<void> => {
  try {
    const reply = await context.deps.fetch(apiUrlOf(context.info, "/api/events"), {
      method: "GET",
      headers: headersOfEvents(context.info, context.lastEventId),
      signal: context.signal,
    });
    if (!reply.ok || reply.body === null) return;
    await readStreamOf(context, reply.body);
  } catch {
    // 断线是常态：交给外层 `onDown` + 重连，不把异常抛给 Pi。
  }
};

/** 经函数读 `aborted`：`while (!signal.aborted)` 会把后面的读取窄化成 `false`（TS 认为只读属性不变）。 */
const abortedOf = (signal: AbortSignal): boolean => signal.aborted;

const loopOf = async (context: CycleContext): Promise<void> => {
  while (!abortedOf(context.signal)) {
    await runCycleOf(context);
    if (abortedOf(context.signal)) return;
    if (reportOnceOf(context, "down")) context.handlers.onDown();
    await context.deps.delay(RECONNECT_MS, context.signal);
  }
};

/** 订阅 `/api/events`：一次读到断就退，退完等 `RECONNECT_MS` 再带 `Last-Event-ID` 重连，直到 `stop()`。 */
export const subscribeOf = (
  deps: HreaderDeps,
  info: DaemonInfo,
  handlers: SubscribeHandlers,
): Subscription => {
  const controller = new AbortController();
  const context: CycleContext = {
    deps,
    info,
    handlers,
    signal: controller.signal,
    reported: new Set<"bad" | "down">(),
    lastEventId: undefined,
  };
  void loopOf(context);
  return {
    stop: () => {
      controller.abort();
    },
  };
};

interface HreaderSession {
  docId: string | undefined;
  /** 每个文档换过的视觉 id：`POST /api/style` 带的就是 `docId`，风格是**文档属性**，换回来仍记得。 */
  readonly themeOf: Map<string, string>;
  /** `/hr-style` 的单调序号：后发起的命令赢，慢响回来时靠它识别“已经被取代了”。 */
  styleSeq: number;
  subscription: Subscription | undefined;
  readonly asked: Set<string>;
  /** 引流串行化：同一个 chunk 里的两条 `doc.changed` 不能并发跑（去重集合还没登记就会问两遍）。 */
  queue: Promise<void>;
}

const sessionOf = (): HreaderSession => ({
  docId: undefined,
  themeOf: new Map<string, string>(),
  styleSeq: 0,
  subscription: undefined,
  asked: new Set<string>(),
  queue: Promise.resolve(),
});

interface PendingAnnotation {
  readonly id: string;
  readonly nodeId: string;
  readonly note: string;
}

/** 认 `pending_ai` 与 `pending`（与 core 同口径）；`resolved`/已拒绝等其它状态一律排除，不该再问用户一次。 */
const pendingOf = (value: unknown): PendingAnnotation | undefined => {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const nodeId = value["nodeId"];
  if (!isNonEmptyString(id) || !isNonEmptyString(nodeId)) return undefined;
  const status = value["status"];
  if (typeof status !== "string" || !PENDING_ANNOTATION_STATUSES.has(status)) return undefined;
  const note = value["note"];
  return { id, nodeId, note: typeof note === "string" ? note : "" };
};

const pendingListOf = (
  value: unknown,
  asked: ReadonlySet<string>,
): readonly PendingAnnotation[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const annotation = pendingOf(item);
    return annotation === undefined || asked.has(annotation.id) ? [] : [annotation];
  });
};

/** `doc.changed` 的正文里，文档标识叫 `docId`（`runtime.ts:232`）；`path` 只出现在 `doc.error`/`library.changed`。 */
const docIdOfEvent = (payload: Readonly<Record<string, unknown>>): string | undefined => {
  const docId = payload["docId"];
  return typeof docId === "string" ? docId : undefined;
};

const injectionOf = (
  annotation: PendingAnnotation,
  docId: string,
  document: string | undefined,
): string => {
  const source =
    document === undefined ? "（读不到节点源码）" : nodeSliceOf(document, annotation.nodeId);
  return [
    `hReader 批注（文档 ${docId}，节点 ${annotation.nodeId}）`,
    "",
    "节点源码：",
    source ?? "（该节点已不在文档里）",
    "",
    "批注：",
    annotation.note,
    "",
    "请按批注改这一个节点；改完用 hreader_patch_node 落盘（改完记得在阅读器里解决批注）。",
  ].join("\n");
};

interface OfferContext {
  readonly pi: HreaderPi;
  readonly ctx: HreaderContext;
  readonly docId: string;
  readonly document: string | undefined;
}

const offerOf = async (context: OfferContext, annotation: PendingAnnotation): Promise<void> => {
  const text = injectionOf(annotation, context.docId, context.document);
  // 无 UI（print/json 模式）时 `confirm` 不可用：只提示，不擅自把批注塞进会话。
  if (!context.ctx.hasUI) {
    // `nodeId`/`note` 是 daemon 来源的不可信片段（`docs/01` 威胁模型）：回显前净化。
    notifyOf(
      context.ctx,
      `有新批注（${safeTextOf(annotation.nodeId)}）：${safeTextOf(annotation.note)}`,
      "info",
    );
    return;
  }
  const accepted = await context.ctx.ui.confirm("hReader 批注", text);
  if (!accepted) return;
  context.pi.sendMessage(
    { customType: "hreader.annotation", content: text, display: true },
    { triggerTurn: true, deliverAs: "followUp" },
  );
};

const intakeOf =
  (deps: HreaderDeps, session: HreaderSession, pi: HreaderPi) =>
  async (event: HreaderEvent, ctx: HreaderContext): Promise<void> => {
    if (event.type !== "doc.changed") return;
    const docId = docIdOfEvent(event.payload);
    if (docId === undefined || docId !== session.docId) return;
    const info = await readDaemonOf(deps);
    if (info === undefined) return;
    const listed = await apiOf(deps, info, ENDPOINTS.annotations, { docId });
    if (!listed.ok) return;
    const pending = pendingListOf(listed.value["annotations"], session.asked);
    if (pending.length === 0) return;
    const document = await documentOf(deps, info, docId);
    for (const annotation of pending) {
      // 先登记再问：`confirm` 挂着时又来一个 `doc.changed`，同一 `anId` 不能再问一遍。
      session.asked.add(annotation.id);
      await offerOf({ pi, ctx, docId, document }, annotation);
    }
  };

const summaryOf = (value: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(value, null, 2);

const toolResultOf = (
  text: string,
  details: Readonly<Record<string, unknown>> = {},
): HreaderToolResult => ({ content: [{ type: "text", text }], details });

interface ToolContext {
  readonly info: DaemonInfo;
  readonly docId: string;
}

/** 三工具共同的壳：daemon 缺失/路径越界都变成**文本**，绝不抛裸异常。
 * 这里没有 `try/catch`：三个 IO 缝各自内部就把异常收成 `undefined` / `ok: false`，所以 `work` 只剩
 * 不抛的纯计算。往 `work` 里加 IO 前，先把那个缝 total 化，否则工具的"永不抛"承诺会在这里破掉。 */
const runToolOf = async (
  deps: HreaderDeps,
  path: string,
  work: (context: ToolContext) => Promise<HreaderToolResult>,
): Promise<HreaderToolResult> => {
  const info = await readDaemonOf(deps);
  if (info === undefined) return toolResultOf(DAEMON_MISSING_HINT);
  const docId = docIdOf(info.workspace, path);
  if (!docId.ok) {
    return toolResultOf(errorTextOf("path_outside_workspace", `${path} 不在 ${info.workspace} 里`));
  }
  return work({ info, docId: docId.docId });
};

const OUTLINE_PARAMS = Type.Object({ path: Type.String() });
const READ_NODE_PARAMS = Type.Object({ path: Type.String(), nodeId: Type.String() });
const PATCH_NODE_PARAMS = Type.Object({
  path: Type.String(),
  nodeId: Type.String(),
  action: Type.Union(PATCH_ACTIONS.map((action) => Type.Literal(action))),
  htmlContent: Type.String(),
});

const outlineToolOf = (deps: HreaderDeps): HreaderTool<typeof OUTLINE_PARAMS> => ({
  name: "hreader_outline",
  label: "读文档大纲",
  description: "写稿前先看结构：返回标题层级、每节字数与未处理的批注。要挑一个节点改时先调它",
  parameters: OUTLINE_PARAMS,
  execute: async (_toolCallId, params) =>
    runToolOf(deps, params.path, async ({ info, docId }) => {
      const result = await apiOf(deps, info, ENDPOINTS.outline, { docId });
      if (!result.ok) return toolResultOf(result.text);
      return toolResultOf(summaryOf(result.value), {
        revision: result.value["revision"],
        docId,
      });
    }),
});

const readNodeToolOf = (deps: HreaderDeps): HreaderTool<typeof READ_NODE_PARAMS> => ({
  name: "hreader_read_node",
  label: "读单个节点",
  description:
    "按 `hreader_outline` 给的 nodeId 取那一块的真实 HTML 与它身上的批注。要改某段正文前先用它看清现状",
  parameters: READ_NODE_PARAMS,
  execute: async (_toolCallId, params) =>
    runToolOf(deps, params.path, async ({ info, docId }) => {
      const document = await documentOf(deps, info, docId);
      if (document === undefined) return toolResultOf(errorTextOf("io_failure", "取不到文档源码"));
      const html = nodeSliceOf(document, params.nodeId);
      if (html === undefined) return toolResultOf(errorTextOf("node_not_found", params.nodeId));
      const listed = await apiOf(deps, info, ENDPOINTS.annotations, { docId });
      // 只要这个节点身上的未处理批注：别的节点的批注属于别的工具调用。
      const notes = listed.ok
        ? pendingListOf(listed.value["annotations"], new Set()).filter(
            (annotation) => annotation.nodeId === params.nodeId,
          )
        : [];
      return toolResultOf(
        JSON.stringify({ docId, nodeId: params.nodeId, html, annotations: notes }, null, 2),
        {
          docId,
          nodeId: params.nodeId,
          revision: listed.ok ? listed.value["revision"] : undefined,
        },
      );
    }),
});

/** `delete` 不发片段（同 MCP 侧 `patch-node.ts:35-38` 的分叉）；其余四种必带。 */
const patchBodyOf = (
  docId: string,
  params: { readonly nodeId: string; readonly action: string; readonly htmlContent: string },
): Readonly<Record<string, unknown>> =>
  params.action === "delete"
    ? { docId, targetId: params.nodeId, action: params.action }
    : { docId, targetId: params.nodeId, action: params.action, fragment: params.htmlContent };

const patchNodeToolOf = (deps: HreaderDeps): HreaderTool<typeof PATCH_NODE_PARAMS> => ({
  name: "hreader_patch_node",
  label: "改一个节点",
  description:
    "对某个节点做 replace/insert_before/insert_after/append/delete。要动正文时用它，别整篇重写；写盘走原子替换并留 undo 快照",
  parameters: PATCH_NODE_PARAMS,
  execute: async (_toolCallId, params) =>
    runToolOf(deps, params.path, async ({ info, docId }) => {
      const result = await apiOf(deps, info, ENDPOINTS.patch, {}, patchBodyOf(docId, params));
      if (!result.ok) return toolResultOf(result.text);
      return toolResultOf(summaryOf(result.value), {
        revision: result.value["revision"],
        changed: result.value["changed"],
      });
    }),
});

const statusHintOf = (info: DaemonInfo, session: HreaderSession): string => {
  // 只看**当前绑定文档**的记录：别的文档的风格与本篇无关。
  const themeId = session.docId === undefined ? undefined : session.themeOf.get(session.docId);
  const style = themeId === undefined ? "" : `，风格 ${safeTextOf(themeId)}`;
  return `${USAGE_HINT}\ndaemon 在跑：127.0.0.1:${String(info.port)}，workspace ${safeTextOf(info.workspace)}${style}`;
};

/** `GET /api/theme` 的 `themes` 字段；非法形状/空串一律剔除，宁可少报也不报出个假 id。 */
const themeIdsOf = (value: Readonly<Record<string, unknown>>): readonly string[] => {
  const listed = value["themes"];
  if (!Array.isArray(listed)) return [];
  return listed.filter((item): item is string => isNonEmptyString(item));
};

/** 上下文在订阅时就定下来：订阅只从"已绑定文档"的那条分叉里起，所以处理器里它不可能是 undefined。 */
const handlersOf = (
  deps: HreaderDeps,
  session: HreaderSession,
  pi: HreaderPi,
  ctx: HreaderContext,
): SubscribeHandlers => ({
  onEvent: (event) => {
    session.queue = session.queue
      .then(() => intakeOf(deps, session, pi)(event, ctx))
      .catch(() => {
        notifyOf(ctx, "处理 hReader 批注事件时出错（见 Pi 日志）", "warning");
      });
  },
  // 环过期是“你断了太久”，必须让用户知道，不能让“未知类型”把它吞掉。
  onStale: () => {
    notifyOf(
      ctx,
      "事件已过期（events_expired）：环里你断线期间的事件已滚掉，请刷新阅读器",
      "warning",
    );
  },
  onDown: () => {
    notifyOf(ctx, "hReader 事件流断开，2 秒后重连", "warning");
  },
  onBadFrame: (detail) => {
    notifyOf(ctx, `收到无法解析的事件帧（疑似 core 协议漂移）：${detail.slice(0, 80)}`, "warning");
  },
});

const hreaderCommandOf =
  (deps: HreaderDeps, session: HreaderSession, pi: HreaderPi) =>
  async (args: string, ctx: HreaderContext): Promise<void> => {
    const info = await readDaemonOf(deps);
    if (info === undefined) {
      notifyOf(ctx, DAEMON_MISSING_HINT, "error");
      return;
    }
    const target = args.trim();
    if (target === "") {
      // 无参只给用法 + daemon 状态。`GET /` 是 cookie 认证、`/s/:docId` 是 token 认证，
      // 无参时没有可点的合法链接，打印根 URL 就是死链。
      notifyOf(ctx, statusHintOf(info, session), "info");
      return;
    }
    const docId = docIdOf(info.workspace, target);
    if (!docId.ok) {
      notifyOf(ctx, `${target} 不在 daemon 的 workspace（${info.workspace}）里`, "error");
      return;
    }
    session.docId = docId.docId;
    session.asked.clear();
    session.subscription?.stop();
    session.subscription = subscribeOf(deps, info, handlersOf(deps, session, pi, ctx));
    notifyOf(ctx, `阅读器：${readerUrlOf(info, docId.docId)}`, "info");
  };

const STYLE_USAGE_HINT = "用法：/hr-style <视觉 id>——不给 id 就列出 daemon 报的可选值";

/** 取可选视觉 id；列表取不到/为空时**已经** notify 过，返回 `undefined` 让调用方直接收尾。 */
const styleIdsOf = async (
  deps: HreaderDeps,
  info: DaemonInfo,
  ctx: HreaderContext,
): Promise<readonly string[] | undefined> => {
  const listed = await apiOf(deps, info, ENDPOINTS.themes, {});
  if (!listed.ok) {
    notifyOf(ctx, listed.text, "error");
    return undefined;
  }
  const ids = themeIdsOf(listed.value);
  if (ids.length === 0) {
    notifyOf(ctx, "daemon 没报任何可选风格（`GET /api/theme` 的 themes 为空）", "error");
    return undefined;
  }
  return ids;
};

/** 校验 id 与文档绑定；不合法时**已经** notify 过，返回 `undefined`。 */
const styleTargetOf = (
  ids: readonly string[],
  requested: string,
  session: HreaderSession,
  ctx: HreaderContext,
): { readonly docId: string; readonly visualId: string } | undefined => {
  // 先对照列表校验：不在列表里的 id 连 POST 都不发（`applyStyle` 侧会报 `unknown_style`，但那时已经动了锁）。
  if (!ids.includes(requested)) {
    const echo = clipTextOf(safeTextOf(requested), ECHO_MAX);
    notifyOf(ctx, `没有叫 ${echo} 的风格\n可选风格：${idListTextOf(ids)}`, "error");
    return undefined;
  }
  const docId = session.docId;
  if (docId === undefined) {
    notifyOf(ctx, "先用 /hreader <文档路径> 绑定文档；/hr-style 只换当前文档的视觉", "error");
    return undefined;
  }
  return { docId, visualId: requested };
};

const styleDoneTextOf = (_changed: boolean, docId: string, requested: string): string =>
  _changed
    ? `已把 ${safeTextOf(docId)} 换成 ${safeTextOf(requested)}`
    : `${safeTextOf(requested)} 与当前视觉相同，文档没变`;

/** `/hr-style <id>` 的唯一语义是**换视觉**；id 只从 `GET /api/theme` 来（扩展不扫主题目录）。
 * 入场先取号，带号码回写——先发慢响一律静默丢弃，不 notify 也不改状态（“后发起的命令赢”）。 */
const styleCommandOf =
  (deps: HreaderDeps, session: HreaderSession) =>
  async (args: string, ctx: HreaderContext): Promise<void> => {
    const token = (session.styleSeq += 1);
    const info = await readDaemonOf(deps);
    if (info === undefined) {
      notifyOf(ctx, DAEMON_MISSING_HINT, "error");
      return;
    }
    const ids = await styleIdsOf(deps, info, ctx);
    if (ids === undefined || token !== session.styleSeq) return;
    const requested = args.trim();
    if (requested === "") {
      notifyOf(ctx, `${STYLE_USAGE_HINT}\n可选风格：${idListTextOf(ids)}`, "info");
      return;
    }
    const target = styleTargetOf(ids, requested, session, ctx);
    if (target === undefined) return;
    // body 只有这两个键（`handlers.ts:191-197` 只读 `docId`/`visualId`）。
    const result = await apiOf(deps, info, ENDPOINTS.style, {}, target);
    // 发票期间又被更晚的 `/hr-style` 取代：这一发的结果已经过时，静默丢。
    if (token !== session.styleSeq) return;
    if (!result.ok) {
      notifyOf(ctx, result.text, "error");
      return;
    }
    session.themeOf.set(target.docId, target.visualId);
    notifyOf(
      ctx,
      styleDoneTextOf(result.value["changed"] === true, target.docId, requested),
      "info",
    );
  };

export const hreaderExtensionOf =
  (deps: HreaderDeps) =>
  (pi: HreaderPi): void => {
    const session = sessionOf();
    pi.registerCommand("hreader", {
      description: "把文档推到 hReader 阅读器并订阅它的批注事件",
      handler: hreaderCommandOf(deps, session, pi),
    });
    pi.registerCommand("hr-style", {
      description: "换当前文档的视觉（id 来自 daemon 的 `GET /api/theme`）",
      handler: styleCommandOf(deps, session),
    });
    pi.registerTool(outlineToolOf(deps));
    pi.registerTool(readNodeToolOf(deps));
    pi.registerTool(patchNodeToolOf(deps));
    // 常驻的 SSE 连接会占住事件循环：Pi 退出会话时必须主动收尾，否则进程挂不出去。
    pi.on("session_shutdown", () => {
      session.subscription?.stop();
      session.subscription = undefined;
    });
  };

/** 默认重连等待：`unref()` 是硬要求（真是否住进程由 smoke 脚本的退出码证明）。 */
export const delayOf = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((done) => {
    if (signal.aborted) {
      done();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });

const liveDeps = (): HreaderDeps => ({
  home: homedir(),
  readFile,
  // 全局 `fetch` 的签名比 `FetchLike` 更宽（`RequestInit`），直接给即可：
  // 包一层 `(url, request) => fetch(url, request)` 会多出一个测试永远走不到的函数。
  fetch,
  delay: delayOf,
});

export default (api: HreaderPi): void => {
  hreaderExtensionOf(liveDeps())(api);
};
