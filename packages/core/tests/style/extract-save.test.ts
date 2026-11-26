// 这层管：`saveStyleText` 的写入契约（先校验后落盘、覆盖守卫、父目录不代建、workspace 边界）。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import type { StyleSpec } from "../../src/style/contracts";
import { styleYamlOf } from "../../src/style/extract/yaml";
import { saveStyleText, type SaveStyleTextInput } from "../../src/style/save";
import { ROOT, builtinSeed, styleEnv } from "./harness";

const SPEC: StyleSpec = {
  id: "corpus-style",
  name: "语料风格",
  description: "从语料统计而来。",
  inheritsVisual: "atelier-editorial",
  language: {
    persona: "讲人话。",
    narrativeRules: ["每段控制在 2 句以内"],
    rhythm: { maxParagraphSentences: 2, style: "短句为主。" },
    vocabulary: { forbidden: ["赋能"], recommended: ["换句话说"] },
    examples: [],
  },
};

const YAML = styleYamlOf(SPEC);

const TARGET = `${ROOT}/out/corpus.yaml`;

const OLD = "旧内容";

/** 假 fs 只认精确目录集合：种一个文件让 `out/` 成为已存在的目录（不代建判据的前提）。 */
const envWithOut = () => styleEnv({ ...builtinSeed(), [`${ROOT}/out/seed.txt`]: "" });

const failureOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof HrError ? error.code : "not-hr-error";
  }
  throw new Error("期望抛错，但调用成功了");
};

const save = async (input: SaveStyleTextInput): Promise<string> => {
  const { deps } = envWithOut();
  return failureOf(saveStyleText(input, deps));
};

describe("saveStyleText · 正常写入", () => {
  it("should write the file and report the parsed spec", async () => {
    const { fake, deps } = envWithOut();

    const saved = await saveStyleText(
      { path: TARGET, workspace: ROOT, text: YAML, force: false },
      deps,
    );

    expect(saved.path).toBe(TARGET);
    expect(saved.spec).toEqual(SPEC);
    expect(fake.textAt(TARGET)).toBe(YAML);
  });

  it("should overwrite when force is set", async () => {
    const { fake, deps } = envWithOut();
    fake.state.files.set(TARGET, new Uint8Array(Buffer.from(OLD, "utf8")));

    await saveStyleText({ path: TARGET, workspace: ROOT, text: YAML, force: true }, deps);

    expect(fake.textAt(TARGET)).toBe(YAML);
  });
});

describe("saveStyleText · 校验先于写入", () => {
  it("should keep the original bytes untouched when the text does not parse", async () => {
    const { fake, deps } = envWithOut();
    fake.state.files.set(TARGET, new Uint8Array(Buffer.from(OLD, "utf8")));

    const code = await failureOf(
      saveStyleText(
        {
          path: TARGET,
          workspace: ROOT,
          text: 'id: "corpus-style"\nname: "缺字段"\n',
          force: true,
        },
        deps,
      ),
    );

    expect(code).toBe("invalid_style");
    expect(fake.textAt(TARGET)).toBe(OLD);
  });

  it("should refuse to overwrite an existing file without force", async () => {
    const { fake, deps } = envWithOut();
    fake.state.files.set(TARGET, new Uint8Array(Buffer.from(OLD, "utf8")));

    const code = await failureOf(
      saveStyleText({ path: TARGET, workspace: ROOT, text: YAML, force: false }, deps),
    );

    expect(code).toBe("file_exists");
    expect(fake.textAt(TARGET)).toBe(OLD);
  });
});

describe("saveStyleText · 路径守卫", () => {
  it("should refuse a path outside the workspace", async () => {
    expect(
      await save({ path: "/elsewhere/corpus.yaml", workspace: ROOT, text: YAML, force: true }),
    ).toBe("path_outside_workspace");
  });

  it("should refuse a missing parent directory instead of creating it", async () => {
    const { fake, deps } = envWithOut();
    const nested = `${ROOT}/out/deep/corpus.yaml`;

    const code = await failureOf(
      saveStyleText({ path: nested, workspace: ROOT, text: YAML, force: false }, deps),
    );

    expect(code).toBe("invalid_input");
    expect(fake.state.files.has(nested)).toBe(false);
  });
});
