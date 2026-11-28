// 这层管：书库搜索面板（`/` 或桌面端 ⌘K 打开）。
// 安全不变量：标题/路径/snippet 一律经 `NodeSpec.text` 落到 textContent——绝不进 innerHTML；
// `highlights` 偏移先按 snippet 长度钳制、丢弃无效对，再按序切成 `mark` 文本run；
// `path` 只用于导航，不拼进 HTML、不拼进选择器。

import type { Host, NodeSpec, TargetLike } from "../dom.ts";
import type { Schedule } from "../flash.ts";
import type { SearchHit, SearchReply } from "../guard.ts";
import type { ReaderIntent, ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

/** 与 core `SEARCH_LIMITS.queryChars` 同值：客户端先拦下超长查询，不发请求。 */
const QUERY_MAX = 200;
const DEBOUNCE_MS = 150;

interface SearchDeps {
  readonly host: Host;
  readonly parent: string;
  /** `GET /api/search?q=…&limit=…` 的封装；由 `main.ts`/`boot.ts` 注入，测试塞假件。 */
  readonly fetch: (query: string) => Promise<SearchReply>;
  /** 打开一条命中：导航/批注聚焦的归属在 `boot.ts`（widget 不读 path 语义）。 */
  readonly openHit: (hit: SearchHit) => void;
  /** 面板开合走 store 意图（`searchOpened`/`panelClosed`），状态唯一出口。 */
  readonly onIntent: (intent: ReaderIntent) => void;
  /** 防抖计时器：与 `flash` 同一个 `Schedule` 注入点（测试塞手动钟）。 */
  readonly schedule: Schedule;
}

/** 高亮对钳制到 snippet 范围：负数抬到 0、越界压到末尾、反向/空调弃。 */
const normalizePairs = (
  snippet: string,
  highlights: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] => {
  const pairs: [number, number][] = [];
  for (const [rawStart, rawEnd] of highlights) {
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const start = Math.max(0, Math.min(snippet.length, Math.trunc(rawStart)));
    const end = Math.max(0, Math.min(snippet.length, Math.trunc(rawEnd)));
    if (end <= start) continue;
    pairs.push([start, end]);
  }
  pairs.sort(([sa, ea], [sb, eb]) => sa - sb || ea - eb);
  return pairs;
};

/** snippet → 纯文本 run：普通段 `span`，命中段 `mark`；重叠的后续区段截去已覆盖部分。 */
const snippetSpecs = (
  snippet: string,
  highlights: readonly (readonly [number, number])[],
): readonly NodeSpec[] => {
  const runs: NodeSpec[] = [];
  let pos = 0;
  for (const [start, end] of normalizePairs(snippet, highlights)) {
    if (end <= pos) continue;
    const from = Math.max(start, pos);
    if (from > pos) runs.push({ tag: "span", text: snippet.slice(pos, from) });
    runs.push({ tag: "mark", text: snippet.slice(from, end) });
    pos = end;
  }
  if (pos < snippet.length) runs.push({ tag: "span", text: snippet.slice(pos) });
  return runs.length === 0 ? [{ tag: "span", text: "" }] : runs;
};

export const mountSearch = (deps: SearchDeps): Widget => {
  const { host, parent } = deps;
  // SP_* 前缀避免与别的 widget 的同名选择器常量相撞（静态接线检查按名字成表）。
  const SP_PANEL = `${parent} #hr-search-panel`;
  const SP_INPUT = `${parent} #hr-search-input`;
  const SP_HINT = `${parent} #hr-search-hint`;
  const SP_DOCS = `${parent} #hr-search-docs`;
  const SP_DOCS_TITLE = `${parent} #hr-search-docs-title`;
  const SP_DOCS_LIST = `${parent} #hr-search-docs-list`;
  const SP_ANNS = `${parent} #hr-search-anns`;
  const SP_ANNS_TITLE = `${parent} #hr-search-anns-title`;
  const SP_ANNS_LIST = `${parent} #hr-search-anns-list`;
  const SP_STATUS = `${parent} #hr-hint`;

  let open = false;
  let hits: readonly SearchHit[] = [];
  let active = 0;
  /** 单调递增的请求号：迟到的旧响应一看号对不上就丢（stale 永不覆盖新结果）。 */
  let seq = 0;
  let cancelPending: (() => void) | undefined;
  /** 输入框里的当前词（input 事件把它更新进来；查询发起时读取）。 */
  let pendingQuery = "";

  const hint = (text: string): void => {
    host.text(SP_HINT, text);
    host.text(SP_STATUS, text);
  };

  const paintActive = (index: number, on: boolean): void => {
    host.cls(`${SP_PANEL} [data-hr-index="${String(index)}"]`, "search__item--on", on);
  };

  const clearLists = (): void => {
    hits = [];
    active = 0;
    host.children(SP_DOCS_LIST, []);
    host.children(SP_ANNS_LIST, []);
    host.attr(SP_DOCS, "hidden", "");
    host.attr(SP_ANNS, "hidden", "");
  };

  const itemSpec = (hit: SearchHit, index: number): NodeSpec => ({
    tag: "li",
    attrs: {
      class: `search__item${index === active ? " search__item--on" : ""}`,
      "data-hr-index": String(index),
      role: "option",
    },
    children: [
      {
        tag: "p",
        attrs: { class: "search__title" },
        children: [
          {
            tag: "span",
            attrs: { class: "search__kind" },
            text: hit.kind === "doc" ? COPY.searchDocs : COPY.searchAnns,
          },
          { tag: "span", text: hit.title === "" ? hit.path : hit.title },
        ],
      },
      {
        tag: "p",
        attrs: { class: "search__snippet" },
        children: snippetSpecs(hit.snippet, hit.highlights),
      },
    ],
  });

  const render = (reply: SearchReply): void => {
    const docs = reply.results.filter((hit) => hit.kind === "doc");
    const anns = reply.results.filter((hit) => hit.kind === "annotation");
    hits = [...docs, ...anns];
    active = 0;
    host.children(
      SP_DOCS_LIST,
      docs.map((hit, index) => itemSpec(hit, index)),
    );
    host.children(
      SP_ANNS_LIST,
      anns.map((hit, index) => itemSpec(hit, docs.length + index)),
    );
    host.attr(SP_DOCS, "hidden", docs.length === 0 ? "" : undefined);
    host.attr(SP_ANNS, "hidden", anns.length === 0 ? "" : undefined);
    if (hits.length === 0) hint(COPY.searchEmpty);
    else if (reply.combine === "or") hint(COPY.searchPartial);
    else hint("");
  };

  const query = (): void => {
    seq += 1;
    const mine = seq;
    const input = pendingQuery;
    hint(COPY.searchLoading);
    void deps.fetch(input).then(
      (reply) => {
        if (mine !== seq || !open) return;
        render(reply);
      },
      (cause: unknown) => {
        if (mine !== seq || !open) return;
        clearLists();
        hint(`${COPY.searchError}${cause instanceof Error ? cause.message : String(cause)}`);
      },
    );
  };

  const onInput = (target: TargetLike): void => {
    pendingQuery = target.value ?? "";
    cancelPending?.();
    cancelPending = undefined;
    seq += 1;
    if (pendingQuery.trim() === "") {
      clearLists();
      hint(COPY.searchIdle);
      return;
    }
    if (Array.from(pendingQuery).length > QUERY_MAX) {
      clearLists();
      hint(COPY.searchTooLong);
      return;
    }
    cancelPending = deps.schedule(DEBOUNCE_MS, () => {
      cancelPending = undefined;
      query();
    });
  };

  const choose = (index: number): void => {
    const hit = hits[index];
    if (hit === undefined) return;
    deps.onIntent({ kind: "panelClosed" });
    deps.openHit(hit);
  };

  const move = (delta: number): void => {
    if (hits.length === 0) return;
    paintActive(active, false);
    active = (active + delta + hits.length) % hits.length;
    paintActive(active, true);
    host.scrollTo(`${SP_PANEL} [data-hr-index="${String(active)}"]`);
  };

  const onKey = (target: TargetLike): void => {
    if (target.key === "ArrowDown") move(1);
    else if (target.key === "ArrowUp") move(-1);
    else if (target.key === "Enter") choose(active);
    else if (target.key === "Escape") deps.onIntent({ kind: "panelClosed" });
  };

  const onClick = (target: TargetLike): void => {
    const indexText = target.closest?.("[data-hr-index]")?.getAttribute("data-hr-index");
    if (indexText === null || indexText === undefined) return;
    choose(Number(indexText));
  };

  const show = (): void => {
    seq += 1;
    cancelPending?.();
    cancelPending = undefined;
    pendingQuery = "";
    clearLists();
    host.text(SP_INPUT, "");
    host.attr(SP_PANEL, "hidden", undefined);
    hint(COPY.searchIdle);
    host.focus?.(SP_INPUT);
  };

  const hide = (): void => {
    seq += 1;
    cancelPending?.();
    cancelPending = undefined;
    clearLists();
    host.attr(SP_PANEL, "hidden", "");
    hint("");
  };

  // `data-hr-search` 是能力标记：桌面端 ⌘K 先探它再派 `hr-search-open`，
  // 没有这个标记的页面（空工作台等）由壳降级成一条提示。
  host.attr(parent, "data-hr-search", "");
  host.attr(SP_INPUT, "placeholder", COPY.searchPlaceholder);
  host.attr(SP_INPUT, "aria-label", COPY.searchTitle);
  host.text(SP_DOCS_TITLE, COPY.searchDocs);
  host.text(SP_ANNS_TITLE, COPY.searchAnns);
  host.on(SP_INPUT, "input", onInput);
  host.on(SP_INPUT, "keydown", onKey);
  host.on(SP_PANEL, "click", onClick);
  host.on(parent, "hr-search-open", () => {
    deps.onIntent({ kind: "searchOpened" });
  });

  const update = (next: ReaderState): void => {
    if (next.searchOpen === open) return;
    open = next.searchOpen;
    if (open) show();
    else hide();
  };

  return { update };
};
