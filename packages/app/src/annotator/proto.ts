// Hand-rolled validation of parent→frame commands. Structured-clone payloads are
// plain data, so index access and `for` loops are safe; no prototype methods are
// invoked on incoming objects. Anything malformed is dropped without a side effect.

const ID_LIMIT = 256;
const ITEMS_LIMIT = 10_000;

export type HighlightStatus = "pending" | "resolved";

export interface HighlightItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly status: HighlightStatus;
}

type AnnotatorCommand =
  | { readonly kind: "highlights"; readonly items: readonly HighlightItem[] }
  | { readonly kind: "focus"; readonly id: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  for (const key of Object.keys(record)) {
    let ok = false;
    for (const allowed of keys) {
      if (key === allowed) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;

const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isItem = (value: unknown): value is HighlightItem => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "start", "end", "status"])) return false;
  return (
    isId(value["id"]) &&
    isOffset(value["start"]) &&
    isOffset(value["end"]) &&
    (value["status"] === "pending" || value["status"] === "resolved")
  );
};

export const parseAnnotatorCommand = (data: unknown): AnnotatorCommand | undefined => {
  if (!isRecord(data)) return undefined;
  const type = data["type"];
  if (type === "hr-annotator/highlights") {
    if (!hasOnlyKeys(data, ["type", "version", "items"])) return undefined;
    if (data["version"] !== 1) return undefined;
    const items = data["items"];
    if (!Array.isArray(items) || items.length > ITEMS_LIMIT) return undefined;
    for (const item of items) {
      if (!isItem(item)) return undefined;
    }
    return { kind: "highlights", items };
  }
  if (type === "hr-annotator/focus") {
    if (!hasOnlyKeys(data, ["type", "id"]) || !isId(data["id"])) return undefined;
    return { kind: "focus", id: data["id"] };
  }
  return undefined;
};
