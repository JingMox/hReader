// 请求体解析：只接受 JSON 对象，其余一律 invalid_request。
import { describe, expect, it } from "vitest";

import { bodyRecordOf } from "../../src/server/http-io";
import { requestLike } from "./casts";

describe("http-io · 请求体只接受 JSON 对象", () => {
  const bodyOf = (text: string): ReturnType<typeof bodyRecordOf> => {
    const req = {
      on: (event: string, handler: (chunk?: Buffer) => void) => {
        if (event === "data") handler(Buffer.from(text));
        if (event === "end") handler();
        return req;
      },
    };
    return bodyRecordOf(requestLike(req));
  };

  it("should accept a JSON object", async () => {
    await expect(bodyOf('{"a":1}')).resolves.toEqual({ a: 1 });
  });

  it.each([["not-json"], ["[]"], ["null"], ["1"], ['"x"'], ["{"], ["{}x"]])(
    "should throw invalid_request for %j",
    async (text) => {
      await expect(bodyOf(text)).rejects.toMatchObject({ code: "invalid_request" });
    },
  );
});
