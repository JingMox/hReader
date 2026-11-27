import { describe, expect, it } from "vitest";

import { HrError } from "../src/index";
import type { HrErrorCode } from "../src/index";

// 用例表的单一事实源：Record<HrErrorCode, true> 缺键即 TS2741，由 `pnpm typecheck` 拦截
// （单根 tsconfig.json，include 含 packages/*/tests/**）。实测：删掉 locked 键 → exit 2
// 。
const CODE_MATRIX: Record<HrErrorCode, true> = {
  invalid_html: true,
  no_article: true,
  node_not_found: true,
  invalid_selector: true,
  invalid_document: true,
  node_not_allowed: true,
  invalid_max_bytes: true,
  invalid_input: true,
  locked: true,
  invalid_fragment: true,
  forbidden_content: true,
  path_outside_workspace: true,
  not_a_file: true,
  io_failure: true,
  undo_unavailable: true,
  invalid_style: true,
  unknown_style: true,
  invalid_theme: true,
  style_io_failure: true,
  invalid_utf8: true,
  not_found: true,
  invalid_request: true,
  busy: true,
  too_many_clients: true,
  unauthorized: true,
  forbidden_origin: true,
  daemon_already_running: true,
  invalid_payload: true,
  nothing_to_undo: true,
  anchor_lost: true,
  llm_failure: true,
  file_exists: true,
  empty_document: true,
  chrome_missing: true,
  chrome_failed: true,
  render_timeout: true,
  render_empty: true,
  needs_normalize: true,
  port_in_use: true,
  // 片段内容模型与目标容器不兼容（列表尾：与 `HrErrorCode` 的声明顺序一致）
  content_model_conflict: true,
  // 同一文档里两个元素共用同一个 `data-hr-id`，读/写入口直接 exit 2。
  duplicate_id: true,
  unknown_template: true,
  invalid_template: true,
  // 块地址失效（路径/指纹都找不到唯一目标），重新 list 即可恢复——exit 1。
  target_moved: true,
};

function isHrErrorCode(value: string): value is HrErrorCode {
  return Object.hasOwn(CODE_MATRIX, value);
}

const ALL_CODES: HrErrorCode[] = Object.keys(CODE_MATRIX).filter(isHrErrorCode);

describe("HrError identity", () => {
  it("should be an Error subclass that is recognisable by instanceof", () => {
    const error = new HrError("no_article", "missing <article>");

    expect(error).toBeInstanceOf(HrError);
    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(HrError.prototype);
  });

  it("should expose the stable name HrError", () => {
    const error = new HrError("locked", "file is locked");

    expect(error.name).toBe("HrError");
    expect(error.toString()).toBe("HrError: file is locked");
  });

  it("should survive throw/catch with code discriminable via instanceof", () => {
    const thrown: unknown = (() => {
      try {
        throw new HrError("node_not_allowed", "refusing <script>");
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(HrError);

    if (!(thrown instanceof HrError)) {
      throw new Error("unreachable: instanceof HrError already asserted");
    }

    expect(thrown.code).toBe("node_not_allowed");
    expect(thrown.message).toBe("refusing <script>");
  });
});

describe("HrError payload", () => {
  it("should keep the message verbatim, including empty and non-ASCII messages", () => {
    const messages = ["", "段落不存在", "emoji 🧱 & <script>", "line1\nline2"];

    for (const message of messages) {
      expect(new HrError("invalid_html", message).message).toBe(message);
    }
  });

  it.each(ALL_CODES)('should pass the code "%s" through unchanged', (code) => {
    expect(new HrError(code, "irrelevant").code).toBe(code);
  });

  it("should keep each instance's code independent", () => {
    const first = new HrError("node_not_found", "a");
    const second = new HrError("invalid_selector", "b");

    expect(first.code).toBe("node_not_found");
    expect(second.code).toBe("invalid_selector");
  });
});

describe("HrError cause passthrough", () => {
  it("should attach cause by identity when one is provided", () => {
    const cause = new RangeError("root cause");

    const error = new HrError("invalid_html", "parse failed", { cause });

    expect(error.cause).toBe(cause);
    expect("cause" in error).toBe(true);
  });

  it("should not define cause when options are omitted", () => {
    const error = new HrError("locked", "no options");

    expect("cause" in error).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  it("should not define cause when options carry no cause key", () => {
    const error = new HrError("locked", "empty options", {});

    expect("cause" in error).toBe(false);
  });
});

describe("HrError observable surface", () => {
  it("should keep the enumerable surface to name/code/data (serialisable, no cause/stack)", () => {
    const error = new HrError("invalid_html", "serialisable", { cause: "deep" });

    // 可枚举面即 JSON.stringify 面：`data` 是程序可面，
    // 让调用方用 `reason` 判别两种 `invalid_selector` 成因），其余 message/cause/stack 不得外泄。
    expect(Object.keys(error).sort()).toEqual(["code", "data", "name"]);
    expect(Object.prototype.propertyIsEnumerable.call(error, "message")).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(error, "cause")).toBe(false);
  });

  it("should carry `data` through JSON and omit it when the caller gave none", () => {
    // 多义报文要能被 Agent 解析：`reason/count/candidates` 必须出现在序列化结果里；
    // 没带 `data` 的码（如单纯 node_not_found）不得凭空长出这个键。
    const withData = new HrError("invalid_selector", "多义", {
      data: { reason: "ambiguous", count: 7, candidates: ["hr-a"] },
    });
    expect(JSON.parse(JSON.stringify(withData))).toEqual({
      code: "invalid_selector",
      data: { reason: "ambiguous", count: 7, candidates: ["hr-a"] },
      name: "HrError",
    });
    expect(JSON.parse(JSON.stringify(new HrError("node_not_found", "无")))).toEqual({
      code: "node_not_found",
      name: "HrError",
    });
  });
});
