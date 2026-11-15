// 这层管：`readStyleSource` 的"原文 vs 序列化产物"与内置档往返一致性（M3.1 AC-5）。

import { describe, expect, it } from "vitest";

import { BUILTIN_STYLES } from "../../src/style/presets";
import { readStyleSource } from "../../src/style/source";
import { parseStyleText } from "../../src/style/spec";
import { builtinSeed, PROJECT_STYLE, STYLE_YAML, styleEnv, USER_STYLE } from "./harness";

describe("readStyleSource · 文本来源", () => {
  it("should return the project file verbatim with origin file", async () => {
    const raw = STYLE_YAML("atelier-editorial", "项目级");
    const env = styleEnv({ ...builtinSeed(), [PROJECT_STYLE]: raw });

    const source = await readStyleSource("atelier-editorial", env.deps);

    expect(source.origin).toBe("file");
    expect(source.yaml).toBe(raw);
  });

  it("should return the user file verbatim when no project file claims the id", async () => {
    const raw = STYLE_YAML("quiet-clerk", "用户级");
    const env = styleEnv({ ...builtinSeed(), [USER_STYLE("quiet-clerk")]: raw });

    const source = await readStyleSource("quiet-clerk", env.deps);

    expect(source.origin).toBe("file");
    expect(source.yaml).toBe(raw);
  });

  it("should serialize every builtin preset into YAML that the parser reads back unchanged", async () => {
    const env = styleEnv(builtinSeed());

    for (const preset of BUILTIN_STYLES) {
      const source = await readStyleSource(preset.id, env.deps);

      expect(source.origin).toBe("generated");
      // 内核自己都读不回去的 YAML 不该发给宿主：往返一致是这条产物的验收条件。
      expect(parseStyleText(source.yaml, `${preset.id}.yaml`)).toEqual(preset);
    }
  });
});
