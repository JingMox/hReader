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
