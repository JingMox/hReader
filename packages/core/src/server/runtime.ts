// 这层管：运行期状态（当前文档 / 分发到 handler / SSE 广播）；不监听端口、不写 daemon.json。

import type { IncomingMessage } from "node:http";
import { basename, dirname, join, relative, sep } from "node:path";

import { parseHtml } from "../html/parse";
import { isTmpFileName } from "../io/atomic";
import { decodeUtf8 } from "../io/bytes";
import { resolveTarget, type ResolvedTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { loadDocument } from "../model/load";
import type { DocumentLoad } from "../model/load";
import type { StyleDeps } from "../style";
import type { Reply } from "./contracts";
import { diffNodes } from "./diff-nodes";
import { annotationDiffReply, annotationsReply } from "./annotation-replies";
import {
  docInfoReply,
  documentReply,
  modelReply,
  outlineReply,
  type HandlerContext,
  type Written,
} from "./handlers";
import { dispatchWrite } from "./write-replies";
import { jsonOf } from "./http-io";
import type { Hub } from "./hub";
import { revisionOf } from "./revision";
import { paramOf, type Route } from "./routes";
import { assetReply, indexReply, themesReply, themeReply } from "./static";
import { createWatcher, type WatchFn, type Watcher } from "./watcher";

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

/** `.hreader/` 是库（锁/历史），tmp 是原子写的中间态：都不算"文档变了"，否则 SSE 会被自己的痕迹刷屏。 */
const internalOf = (workspace: string, path: string): boolean => {
  const store = join(workspace, ".hreader");
  if (path === store || path.startsWith(`${store}${sep}`)) return true;
  const name = basename(path);
  return isTmpFileName(name) || name.endsWith("~");
};

interface PublishInput {
  readonly hub: Hub;
  readonly deps: RuntimeDeps;
  readonly state: Watched;
  readonly workspace: string;
  readonly load: DocumentLoad;
  readonly target: ResolvedTarget;
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
  void input.deps.patch.fs.readFile(input.target.realPath).then(
    (bytes) => {
      const revision = revisionOf(bytes);
      // 字节没变（mtime 抖动/格式化）才不发事件；"模型没差异"不等于"文件没变"（属性、无 id 的新节点）。
      if (revision === input.state.revision) return;
      input.state.revision = revision;
      input.hub.publish("doc.changed", {
        docId: relative(input.workspace, input.target.realPath),
        revision,
        changedNodes,
      });
    },
    () => undefined,
  );
};

/** 打开文档时才挂监听：整库递归监听在 10 万文件上会把 CPU 烧穿。 */
const watchOf = (deps: RuntimeDeps, hub: Hub, state: Watched, workspace: string): Watcher => {
  const onFileChange = (path: string): void => {
    if (internalOf(workspace, path)) return;
    const active = state.active;
    // 载荷只给 workspace 相对路径：绝对路径不进浏览器（与 `doc.changed` 同口径）。
    const docPath = relative(workspace, path);
    if (active === undefined) {
      hub.publish("library.changed", { path: docPath });
      return;
    }
    if (path !== active.realPath) {
      hub.publish("library.changed", { path: docPath });
      return;
    }
    void loadOfPath(deps, active).then(
      (load) => {
        publishChanged({ hub, deps, state, workspace, load, target: active });
      },
      () => {
        hub.publish("doc.error", { path: docPath });
      },
    );
  };
  const watcher = createWatcher(
    { now: () => deps.patch.clock.now().getTime(), onFileChange },
    deps.watch,
  );
  watcher.add(workspace, undefined);
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

/** 读类路由（document/docInfo/model/outline/annotations）共用"先 remember 再取"。 */
type ReadKind = Extract<
  Route["kind"],
  "document" | "docInfo" | "model" | "outline" | "annotations"
>;

const isReadKind = (kind: Route["kind"]): kind is ReadKind =>
  kind === "document" ||
  kind === "docInfo" ||
  kind === "model" ||
  kind === "outline" ||
  kind === "annotations";

const readReplyOf = async (
  context: HandlerContext,
  kind: ReadKind,
  docId: string,
  remember: Runtime["remember"],
): Promise<Reply> => {
  await remember(docId);
  if (kind === "document") return (await documentReply(context, docId)).reply;
  if (kind === "docInfo") return docInfoReply(context, docId);
  if (kind === "annotations") return annotationsReply(context, docId);
  return kind === "model" ? modelReply(context, docId) : outlineReply(context, docId);
};

const dispatchOf =
  (
    context: HandlerContext,
    options: { readonly docId: string },
    runtime: { readonly remember: Runtime["remember"]; readonly noteWrite: Runtime["noteWrite"] },
    bodyMs: number,
  ) =>
  async (
    route: Route,
    params: Readonly<Record<string, string>>,
    req: IncomingMessage,
  ): Promise<Reply> => {
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
    return written.reply;
  };

/** 自己的写直接广播（watcher 的回声窗口会吞掉同一路径），监听只负责"外部改动"。 */
interface NoteContext {
  readonly options: { readonly workspace: string };
  readonly deps: RuntimeDeps;
  readonly hub: Hub;
  readonly state: Watched;
  readonly watcher: Watcher;
}

const noteWriterOf =
  (context: NoteContext): Runtime["noteWrite"] =>
  (written) => {
    const { options, deps, hub, state, watcher } = context;
    if (!written.changed) return;
    watcher.noteSelfWrite(written.target.realPath);
    // 写路由可能是这份文档的第一次接触：remember 没跑过就不会挂监听，
    // 子目录文档的外部编辑会漏报（workspace 目录监听是 depth:0）。
    watcher.add(dirname(written.target.realPath), basename(written.target.realPath));
    state.active = written.target;
    state.revision = written.revision;
    hub.publish("doc.changed", {
      docId: relative(options.workspace, written.target.realPath),
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
  },
  deps: RuntimeDeps,
  hub: Hub,
): Runtime => {
  const state: Watched = { active: undefined, load: undefined, revision: undefined };
  const context: HandlerContext = {
    workspace: options.workspace,
    appDir: options.appDir ?? "",
    deps: deps.patch,
    styleDeps: deps.style,
  };
  const watcher = watchOf(deps, hub, state, options.workspace);
  const noteWrite = noteWriterOf({ options, deps, hub, state, watcher });
  const remember = rememberOf({ options, deps, state, watcher });
  return {
    remember,
    noteWrite,
    dispatch: dispatchOf(context, options, { remember, noteWrite }, options.bodyMs),
    close: () => {
      watcher.close();
    },
  };
};
