// 这层管：运行期状态（当前文档 / 分发到 handler / SSE 广播）；不监听端口、不写 daemon.json。

import type { IncomingMessage } from "node:http";
import { basename, dirname, relative, sep } from "node:path";

import { parseHtml } from "../html/parse";
import { decodeUtf8 } from "../io/bytes";
import { resolveTarget, type ResolvedTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { loadDocument } from "../model/load";
import type { DocumentLoad } from "../model/load";
import type { StyleDeps } from "../style";
import { createAnnotateTokenBook } from "./annotate";
import { createCapabilityBook } from "./capability";
import type { Reply } from "./contracts";
import { diffNodes } from "./diff-nodes";
import { annotationDiffReply, annotationsReply } from "./annotation-replies";
import { docAssetReply } from "./doc-assets";
import {
  docInfoReply,
  documentRedirectOf,
  globalModesReply,
  globalModesSetReply,
  LOCK_WAIT_MS,
  modelReply,
  outlineReply,
  type HandlerContext,
  type Written,
} from "./handlers";
import { dispatchWrite } from "./write-replies";
import { sidecarListReply } from "./sidecar-replies";
import { bodyRecordOf, jsonOf } from "./http-io";
import type { Hub } from "./hub";
import { revisionOf } from "./revision";
import { paramOf, type Route } from "./routes";
import { assetReply, indexReply, themesReply, themeReply } from "./static";
import { createWatcher, isLibraryPath, type WatchFn, type Watcher } from "./watcher";

interface RuntimeDeps {
  readonly patch: PatchDeps;
  readonly style: StyleDeps;
  readonly watch?: WatchFn;
}

export interface Runtime {
  readonly remember: (docId: string) => Promise<ResolvedTarget>;
  readonly noteWrite: (written: Written) => void;
  readonly dispatch: (
    route: Route,
    params: Readonly<Record<string, string>>,
    req: IncomingMessage,
  ) => Promise<Reply>;
  readonly close: () => void;
}

interface Watched {
  active: ResolvedTarget | undefined;
  /** 缓存整份加载结果（含分档）：每次文件变更直接换，不为外来文档反复走 derive-抛错-吞掉的老路。 */
  load: DocumentLoad | undefined;
  revision: string | undefined;
}

const loadOfPath = async (deps: RuntimeDeps, target: ResolvedTarget): Promise<DocumentLoad> =>
  loadDocument(
    parseHtml(decodeUtf8(await deps.patch.fs.readFile(target.realPath), target.realPath)),
  );

interface PublishInput {
  readonly hub: Hub;
  readonly state: Watched;
  readonly load: DocumentLoad;
  readonly target: ResolvedTarget;
  readonly bytes: Uint8Array;
}

/** `revision` 只有一个口径：文件字节的 sha256 前 16 位（与 REST 响应、`patch` 回执同源）。
 *  前后两侧都托管才 diff；外来文档没有模型，`changedNodes` 恒空，事件照发让阅读器刷新。 */
const publishChanged = (input: PublishInput): void => {
  const previous = input.state.load;
  const changedNodes =
    previous !== undefined && previous.ok && input.load.ok
      ? diffNodes(previous.model, input.load.model)
      : [];
  input.state.load = input.load;
  const revision = revisionOf(input.bytes);
  // 字节没变（mtime 抖动/格式化）才不发事件；"模型没差异"不等于"文件没变"（属性、无 id 的新节点）。
  if (revision === input.state.revision) return;
  input.state.revision = revision;
  input.hub.publish("doc.changed", {
    docId: input.target.relative,
    revision,
    changedNodes,
  });
};

/** 整库递归挂载一次覆盖所有子目录（书库是文档级规模，内部目录由 `ignored` 整棵剪掉）；
 *  被服务文档另挂文件级监听——挂载盲窗的 reconcile 心跳只跑在文件级挂载上。 */
const watchOf = (deps: RuntimeDeps, hub: Hub, state: Watched, workspace: string): Watcher => {
  // 事件路径必须与 realPath 同口径：workspace 含符号链接时（macOS /var→/private/var、
  // 软链的家目录），未解析的目录前缀拼出的事件路径永远 ≠ active.realPath——活跃文档的
  // 改动被错报成 library.changed（浏览器不认），MCP/CLI 的写就此丢刷新。整目录监听因此
  // 挂在解析后的真实路径上；realpath 失败退回词法路径（保持旧行为，仍比不报强）。
  let root = workspace;
  const onFileChange = (path: string, probe?: boolean): void => {
    const active = state.active;
    // 盲窗对账只对活跃文档有意义：未活跃路径的探针不能放大成 library.changed 刷屏
    // （心跳每个 tick 一条）。文档没开过的话首开本来就会全量读，盲窗丢它不可惜。
    if (path !== active?.realPath) {
      // 内部口径只挡"是否广播 library.changed"：活跃文档落在 node_modules/ 之类的
      // 内部目录里也照走上面的 realPath 比对拿 doc.changed。
      if (probe !== true && isLibraryPath(root, path)) {
        // 载荷只给 workspace 相对路径：绝对路径不进浏览器；分隔符与 docId 同用 "/"（doc.changed 同口径）。
        hub.publish("library.changed", { path: relative(root, path).split(sep).join("/") });
      }
      return;
    }
    const docPath = relative(root, path).split(sep).join("/");
    // 先读字节对 sha：自写回声/mtime 抖动落在同一字节上直接短路，省掉整份模型重解析；
    // 字节真变了才 load+diff+publish。别进程（MCP/CLI/编辑器）的写必然过这道闸——
    // 旧的 200ms 回声窗会把窗口内的外部写整段吞掉（批注 resolve 后阅读器不刷新）。
    void deps.patch.fs.readFile(active.realPath).then(
      (bytes) => {
        if (revisionOf(bytes) === state.revision) return;
        void loadOfPath(deps, active).then(
          (load) => {
            publishChanged({ hub, state, load, target: active, bytes });
          },
          () => {
            hub.publish("doc.error", { path: docPath });
          },
        );
      },
      () => {
        hub.publish("doc.error", { path: docPath });
      },
    );
  };
  const watcher = createWatcher({ onFileChange }, deps.watch);
  void deps.patch.fs.realpath(workspace).then(
    (real) => {
      root = real;
      watcher.add(real, undefined);
    },
    () => {
      watcher.add(workspace, undefined);
    },
  );
  return watcher;
};

/** `/`、`/assets/*`、`/api/theme[/<id>]` 都不碰文档状态，直接由静态层出 `Reply`。 */
interface StaticInput {
  readonly context: HandlerContext;
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
  readonly docId: string;
  readonly hasDocQuery: boolean;
}

const onlyValueOf = (params: Readonly<Record<string, string>>): string =>
  Object.values(params).join("");

const staticOf = (input: StaticInput): Promise<Reply> => {
  switch (input.route.kind) {
    case "home":
      return indexReply(input.context, input.docId, input.hasDocQuery);
    case "themes":
      return themesReply(input.context);
    case "assets":
      return assetReply(input.context, onlyValueOf(input.params));
    default:
      return themeReply(input.context, onlyValueOf(input.params));
  }
};

type StaticKind = Extract<Route["kind"], "home" | "assets" | "theme" | "themes">;

const isStaticKind = (kind: Route["kind"]): kind is StaticKind =>
  kind === "home" || kind === "assets" || kind === "theme" || kind === "themes";

/** 读类路由（document/docInfo/model/outline/annotations/sidecar）共用"先 remember 再取"。 */
type ReadKind = Extract<
  Route["kind"],
  "document" | "docInfo" | "model" | "outline" | "annotations" | "sidecar"
>;

const isReadKind = (kind: Route["kind"]): kind is ReadKind =>
  kind === "document" ||
  kind === "docInfo" ||
  kind === "model" ||
  kind === "outline" ||
  kind === "annotations" ||
  kind === "sidecar";

/** 侧车写五兄弟：成功完成时广播 `doc.annotations`（noteWrite 对它们静默）。 */
const SIDECAR_WRITE_KINDS: ReadonlySet<Route["kind"]> = new Set([
  "sidecarAdd",
  "sidecarResolve",
  "sidecarReopen",
  "sidecarReply",
  "sidecarDelete",
]);

const readReplyOf = async (
  context: HandlerContext,
  kind: ReadKind,
  docId: string,
  remember: Runtime["remember"],
): Promise<Reply> => {
  const target = await remember(docId);
  // `/s/` 只发入口：页面本体与同目录资源都交给 `/f/`（cap 在这里登记）。
  if (kind === "document") return documentRedirectOf(context, target);
  if (kind === "docInfo") return docInfoReply(context, docId);
  if (kind === "annotations") return annotationsReply(context, docId);
  if (kind === "sidecar") return sidecarListReply(context, docId);
  return kind === "model" ? modelReply(context, docId) : outlineReply(context, docId);
};

const dispatchOf =
  (
    context: HandlerContext,
    options: { readonly docId: string },
    runtime: {
      readonly remember: Runtime["remember"];
      readonly noteWrite: Runtime["noteWrite"];
      readonly hub: Hub;
    },
    bodyMs: number,
  ) =>
  async (
    route: Route,
    params: Readonly<Record<string, string>>,
    req: IncomingMessage,
  ): Promise<Reply> => {
    // 全局权限模式不设 docId：不走 docIdOf 那套写队列（它是"所有外来文档"的设置，
    // 不是某个文档的），广播走独立的 `permissions.changed` 事件。
    if (route.kind === "permissionsGet") return globalModesReply(context);
    if (route.kind === "permissionsSet") {
      const body = await bodyRecordOf(req, bodyMs);
      const { reply, modes } = await globalModesSetReply(context, body, LOCK_WAIT_MS);
      runtime.hub.publish("permissions.changed", { modes });
      return reply;
    }
    // `/f/` 与 docId 体系无关：cap 是唯一凭证，目录从能力簿里查。
    if (route.kind === "docAsset") {
      // A missing `req.url` can only come from a hand-made request object: same verdict as the static routes, a testable 400.
      if (req.url === undefined) {
        return jsonOf(400, { code: "invalid_request", message: "请求行缺少 URL" });
      }
      // The `annotate` token rides in the query: only the document exception branch consumes it; every other asset path ignores it outright.
      const annotate = new URL(req.url, "http://local").searchParams.get("annotate") ?? undefined;
      return docAssetReply(
        context,
        paramOf(params, "cap", ""),
        paramOf(params, "path", ""),
        annotate,
      );
    }
    if (isStaticKind(route.kind)) {
      // `req.url` 在 HTTP/1.1 的 origin-form 请求里恒有值；缺失只可能来自“手搓的请求对象”，
      // 所以这里给一条能测的 400，而不是一个永远进不去的 `?? "/"` 默认值。
      if (req.url === undefined) {
        return jsonOf(400, { code: "invalid_request", message: "请求行缺少 URL" });
      }
      const url = new URL(req.url, "http://local");
      const input = { context, route, params, docId: options.docId };
      return staticOf({ ...input, hasDocQuery: url.searchParams.has("doc") });
    }
    if (route.kind === "annotationDiff") {
      return annotationDiffReply(context, {
        docId: paramOf(params, "docId", options.docId),
        anId: paramOf(params, "anId", ""),
      });
    }
    if (isReadKind(route.kind)) {
      const docId = paramOf(params, "docId", options.docId);
      return readReplyOf(context, route.kind, docId, runtime.remember);
    }
    const written = await dispatchWrite(context, route, params, { req, bodyMs });
    runtime.noteWrite(written);
    // 侧车写不动文档字节（changed:false → doc.changed 静默），批注变化走自己的事件：
    // 写成功才广播，失败写什么动静都没有。
    if (SIDECAR_WRITE_KINDS.has(route.kind)) {
      runtime.hub.publish("doc.annotations", { docId: written.target.relative });
    }
    return written.reply;
  };

/** 自己的写直接广播（fs 事件照样走监听 → 下游 sha 去重），监听负责一切落盘改动。 */
interface NoteContext {
  readonly deps: RuntimeDeps;
  readonly hub: Hub;
  readonly state: Watched;
  readonly watcher: Watcher;
}

const noteWriterOf =
  (context: NoteContext): Runtime["noteWrite"] =>
  (written) => {
    const { deps, hub, state, watcher } = context;
    if (!written.changed) return;
    // 写路由可能是这份文档的第一次接触：remember 没跑过就没有它的文件级挂载——
    // 盲窗 reconcile 心跳只跑在文件级挂载上，不补挂会在挂载盲窗里丢一次外部编辑。
    watcher.add(dirname(written.target.realPath), basename(written.target.realPath));
    state.active = written.target;
    state.revision = written.revision;
    hub.publish("doc.changed", {
      docId: written.target.relative,
      revision: written.revision,
      changedNodes: written.changedNodes,
    });
    void loadOfPath(deps, written.target).then(
      (load) => {
        state.load = load;
      },
      () => undefined,
    );
  };

const rememberOf =
  (ctx: {
    readonly options: { readonly workspace: string };
    readonly deps: RuntimeDeps;
    readonly state: Watched;
    readonly watcher: Watcher;
  }): ((docId: string) => Promise<ResolvedTarget>) =>
  async (docId) => {
    const target = await resolveTarget(
      { workspace: ctx.options.workspace, file: docId },
      ctx.deps.patch.fs,
    );
    if (ctx.state.active?.realPath === target.realPath) return target;
    // 先加载再认领 active：二进制/坏 UTF-8 文档加载失败时不得改指，
    // 否则前一个文档的外部编辑会漏成 library.changed。
    const load = await loadOfPath(ctx.deps, target);
    const revision = revisionOf(await ctx.deps.patch.fs.readFile(target.realPath));
    ctx.state.active = target;
    // 外来文档不拒：`remember` 只负责定位与缓存分档，托管与否由 `model`/`outline` 各自判（422/409 契约照旧）。
    ctx.state.load = load;
    ctx.state.revision = revision;
    ctx.watcher.add(dirname(target.realPath), basename(target.realPath));
    return target;
  };

export const createRuntime = (
  options: {
    readonly workspace: string;
    readonly docId: string;
    readonly bodyMs: number;
    /** 构建产物根；缺省空串（只有 `/`、`/assets/*`、`/api/theme/*` 用得到）。 */
    readonly appDir?: string;
    /**
     * 用户级配置根（`~/.hreader` 的父目录）：全局权限模式写在 `<home>/.hreader/`。
     * 缺省回 `workspace`——此时全局设置落在工作区 `.hreader/` 里，
     * 测试只起 runtime 不起 server 时不碰真实 HOME。
     */
    readonly home?: string;
  },
  deps: RuntimeDeps,
  hub: Hub,
): Runtime => {
  const state: Watched = { active: undefined, load: undefined, revision: undefined };
  const context: HandlerContext = {
    workspace: options.workspace,
    appDir: options.appDir ?? "",
    home: options.home ?? options.workspace,
    deps: deps.patch,
    styleDeps: deps.style,
    // Per-runtime secret: a restart mints a fresh key and every old cap dies.
    caps: createCapabilityBook(),
    // Same lifetime rule for annotate tokens: injected clock, per-runtime book.
    annotateTokens: createAnnotateTokenBook(deps.patch.clock),
  };
  const watcher = watchOf(deps, hub, state, options.workspace);
  // 被服务的文档启动时就挂文件级监听，不等第一个 HTTP 触碰：挂载→ready 的盲窗里，
  // 事件源看不见任何写（首轮扫描把窗口内容当存量），高负载下 ready 能拖到几十秒——
  // 盲窗期间的写只有 reconcile 兜底，收敛太晚。启动挂载把盲窗收窄到"服务还没起来"的
  // 那段时间，测试与真实客户端的写都在 ready 之后。文档不存在就不挂（后续 remember 照走）。
  void resolveTarget({ workspace: options.workspace, file: options.docId }, deps.patch.fs).then(
    (target) => {
      watcher.add(dirname(target.realPath), basename(target.realPath));
    },
    () => undefined,
  );
  const noteWrite = noteWriterOf({ deps, hub, state, watcher });
  const remember = rememberOf({ options, deps, state, watcher });
  return {
    remember,
    noteWrite,
    dispatch: dispatchOf(context, options, { remember, noteWrite, hub }, options.bodyMs),
    close: () => {
      watcher.close();
    },
  };
};
