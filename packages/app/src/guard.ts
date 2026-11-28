// 这层管：运行时形状守卫。`JSON.parse` 的结果是 `unknown`，先过这里再进逻辑；
// 不用 `Reflect`、不用 `as`——`in` 收窄与数组排除已经够用。

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const numberTextOf = (value: unknown): string | undefined =>
  typeof value === "number" || typeof value === "string" ? String(value) : undefined;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

interface WireCard {
  readonly id: string;
  readonly nodeId: string;
  readonly note: string;
  readonly status: "pending" | "resolved";
  readonly resolvedAt?: string;
  readonly resolutionNote?: string;
  readonly lost?: "anchor_lost" | "orphaned";
}

const isStatusOf = (value: unknown): value is WireCard["status"] =>
  value === "pending" || value === "resolved";

const isLostOf = (value: unknown): value is NonNullable<WireCard["lost"]> =>
  value === "anchor_lost" || value === "orphaned";

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

/** 一条卡片：`id`/`nodeId`/`note`/`status` 是后续选择器与渲染的前提，必填；其余字段给了就要对。 */
const isAnnotationCard = (value: unknown): value is WireCard =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["nodeId"] === "string" &&
  typeof value["note"] === "string" &&
  isStatusOf(value["status"]) &&
  isOptionalString(value["resolvedAt"]) &&
  isOptionalString(value["resolutionNote"]) &&
  (value["lost"] === undefined || isLostOf(value["lost"]));

/** `GET /api/doc/<id>/annotations` → 卡片列表 + 失效锚点 + 诊断。 */
export const isAnnotationList = (
  value: unknown,
): value is {
  readonly annotations: readonly WireCard[];
  readonly lost?: readonly string[];
  readonly diagnostics?: readonly string[];
} =>
  isRecord(value) &&
  Array.isArray(value["annotations"]) &&
  value["annotations"].every(isAnnotationCard) &&
  (value["lost"] === undefined || isStringArray(value["lost"])) &&
  (value["diagnostics"] === undefined || isStringArray(value["diagnostics"]));

/** One hit of `GET /api/search` (isomorphic to `@hreader/core`'s `SearchHit`; the app does not depend on core). */
export interface SearchHit {
  readonly path: string;
  readonly title: string;
  readonly kind: "doc" | "annotation";
  readonly annotationId?: string;
  readonly score: number;
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
}

/** `GET /api/search` reply (structural mirror of `LibrarySearchResult`). */
export interface SearchReply {
  readonly results: readonly SearchHit[];
  readonly total: number;
  readonly combine: "and" | "or";
  readonly truncated: boolean;
  readonly diagnostics?: readonly string[];
}

/** A highlight pair must be `[start, end)` numbers; out-of-range/reversed pairs are the renderer's problem — the guard only checks shape. */
const isHighlightPair = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "number" &&
  typeof value[1] === "number";

const isSearchHit = (value: unknown): value is SearchHit =>
  isRecord(value) &&
  typeof value["path"] === "string" &&
  typeof value["title"] === "string" &&
  (value["kind"] === "doc" || value["kind"] === "annotation") &&
  isOptionalString(value["annotationId"]) &&
  typeof value["score"] === "number" &&
  typeof value["snippet"] === "string" &&
  Array.isArray(value["highlights"]) &&
  (value["highlights"] as readonly unknown[]).every(isHighlightPair);

/** `GET /api/search`: every hit present in `results` must check out (path/title/snippet are prerequisites for rendering and navigation). */
export const isSearchReply = (value: unknown): value is SearchReply =>
  isRecord(value) &&
  Array.isArray(value["results"]) &&
  (value["results"] as readonly unknown[]).every(isSearchHit) &&
  typeof value["total"] === "number" &&
  (value["combine"] === "and" || value["combine"] === "or") &&
  typeof value["truncated"] === "boolean" &&
  (value["diagnostics"] === undefined || isStringArray(value["diagnostics"]));

/** `GET /api/doc/<id>/notes/<anId>/diff` → 服务端算好的 chunk。 */
export const isDiffResponse = (
  value: unknown,
): value is {
  readonly nodeId: string;
  readonly chunks: readonly { readonly kind: "same" | "ins" | "del"; readonly text: string }[];
  readonly degraded: boolean;
  readonly degradedReason?: string;
} =>
  isRecord(value) &&
  Array.isArray(value["chunks"]) &&
  typeof value["degraded"] === "boolean" &&
  typeof value["nodeId"] === "string" &&
  (value["degradedReason"] === undefined || typeof value["degradedReason"] === "string");
