// 这层管：运行期状态（当前文档 / 分发到 handler / SSE 广播）；不监听端口、不写 daemon.json。

import type { IncomingMessage } from "node:http";
import { basename, dirname, join, relative, sep } from "node:path";

import { parseHtml } from "../html/parse";
import { TMP_PREFIX } from "../io/atomic";
import { decodeUtf8 } from "../io/bytes";
import { resolveTarget, type ResolvedTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import type { DocumentModel } from "../model/constants";
import { toDocumentModel } from "../model/derive";
import type { StyleDeps } from "../style";
import { requiredStringOf } from "./body";
import type { Reply } from "./contracts";
import { diffNodes } from "./diff-nodes";
import {
  annotationReply,
  documentReply,
  LOCK_WAIT_MS,
  modelReply,
  outlineReply,
  patchReply,
  styleReply,
  type HandlerContext,
  type Written,
} from "./handlers";
import { bodyRecordOf } from "./http-io";
import type { Hub } from "./hub";
import { docQueueKey, withDocQueue } from "./queue";
import { revisionOf } from "./revision";
import type { Route } from "./routes";
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
  model: DocumentModel | undefined;
  revision: string | undefined;
}

const modelOfPath = async (deps: RuntimeDeps, target: ResolvedTarget): Promise<DocumentModel> =>
  toDocumentModel(
    parseHtml(decodeUtf8(await deps.patch.fs.readFile(target.realPath), target.realPath)),
  );

/** `.hreader/` 是库（锁/历史），tmp 是原子写的中间态：都不算"文档变了"，否则 SSE 会被自己的痕迹刷屏。 */
const internalOf = (workspace: string, path: string): boolean => {
  const store = join(workspace, ".hreader");
  if (path === store || path.startsWith(`${store}${sep}`)) return true;
  const name = basename(path);
  return name.startsWith(TMP_PREFIX) || name.endsWith("~");
};

interface PublishInput {
  readonly hub: Hub;
  readonly deps: RuntimeDeps;
  readonly state: Watched;
  readonly workspace: string;
  readonly model: DocumentModel;
  readonly target: ResolvedTarget;
}

/** `revision` 只有一个口径：文件字节的 sha256 前 16 位（与 REST 响应、`patch` 回执同源）。 */
const publishChanged = (input: PublishInput): void => {
  const previous = input.state.model;
  const changedNodes = previous === undefined ? [] : diffNodes(previous, input.model);
  input.state.model = input.model;
  void input.deps.patch.fs.readFile(input.target.realPath).then(
    (bytes) => {
      const revision = revisionOf(bytes);
      // 字节没变（mtime 抖动/格式化）才不发事件；"模型没差异"不等于"文件没变"（属性、无 id 的新节点）。
      if (revision === input.state.revision) return;
      input.state.revision = revision;
      input.hub.publish("doc.changed", {
        docId: relative(input.workspace, input.target.realPath),
        path: input.target.realPath,
        revision,
        changedNodes,
      });
    },
    () => undefined,
  );
};

/** 打开文档时才挂监听：整库递归监听在 10 万文件上会把 CPU 烧穿（卡 D8）。 */
const watchOf = (deps: RuntimeDeps, hub: Hub, state: Watched, workspace: string): Watcher => {
  const onFileChange = (path: string): void => {
    if (internalOf(workspace, path)) return;
    const active = state.active;
    if (active === undefined) {
      hub.publish("library.changed", { path });
      return;
    }
    if (path !== active.realPath) {
      hub.publish("library.changed", { path });
      return;
    }
    void modelOfPath(deps, active).then(
      (model) => {
        publishChanged({ hub, deps, state, workspace, model, target: active });
      },
      () => {
        hub.publish("doc.error", { path });
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

const writeReplyOf = (
  context: HandlerContext,
  route: Route,
  body: Readonly<Record<string, unknown>>,
): Promise<Written> => {
  if (route.kind === "patch") return patchReply(context, body, LOCK_WAIT_MS);
  if (route.kind === "style") return styleReply(context, body, LOCK_WAIT_MS);
  return annotationReply(context, body, LOCK_WAIT_MS);
};

const dispatchWrite = async (
  context: HandlerContext,
  route: Route,
  req: IncomingMessage,
  bodyMs: number,
): Promise<Written> => {
  const body = await bodyRecordOf(req, bodyMs);
  const key = docQueueKey(context.workspace, requiredStringOf(body, "docId"));
  return withDocQueue(key, () => writeReplyOf(context, route, body));
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
    if (route.kind === "document" || route.kind === "model" || route.kind === "outline") {
      const docId = params["docId"] ?? options.docId;
      await runtime.remember(docId);
      if (route.kind === "document") return (await documentReply(context, docId)).reply;
      return route.kind === "model" ? modelReply(context, docId) : outlineReply(context, docId);
    }
    const written = await dispatchWrite(context, route, req, bodyMs);
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
    state.active = written.target;
    state.revision = written.revision;
    hub.publish("doc.changed", {
      docId: relative(options.workspace, written.target.realPath),
      path: written.target.realPath,
      revision: written.revision,
      changedNodes: written.changedNodes,
    });
    void modelOfPath(deps, written.target).then(
      (model) => {
        state.model = model;
      },
      () => undefined,
    );
  };

export const createRuntime = (
  options: { readonly workspace: string; readonly docId: string; readonly bodyMs: number },
  deps: RuntimeDeps,
  hub: Hub,
): Runtime => {
  const state: Watched = { active: undefined, model: undefined, revision: undefined };
  const context: HandlerContext = {
    workspace: options.workspace,
    deps: deps.patch,
    styleDeps: deps.style,
  };
  const watcher = watchOf(deps, hub, state, options.workspace);
  const noteWrite = noteWriterOf({ options, deps, hub, state, watcher });
  const remember = async (docId: string): Promise<ResolvedTarget> => {
    const target = await resolveTarget(
      { workspace: options.workspace, file: docId },
      deps.patch.fs,
    );
    if (state.active?.realPath === target.realPath) return target;
    state.active = target;
    state.model = await modelOfPath(deps, target);
    state.revision = revisionOf(await deps.patch.fs.readFile(target.realPath));
    watcher.add(dirname(target.realPath), basename(target.realPath));
    return target;
  };
  return {
    remember,
    noteWrite,
    dispatch: dispatchOf(context, options, { remember, noteWrite }, options.bodyMs),
    close: () => {
      watcher.close();
    },
  };
};
