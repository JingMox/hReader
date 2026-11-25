// 这层管：断言与错误形状。编排交给 Vitest（describe/test/beforeAll/afterAll），
// 这里只留断言助手——失败信息要能直接读出人话；外加 parseJson 的统一报错面。

export class CheckError extends Error {}

// `asserts ok` 签名：assert 之后调用方能拿到类型窄化（unknown → 具体类型），不用再 as。
// 变量本身也要显式标注（TS2775：assertion 调用目标的每个名字都要有显式类型）。
export const assert: (ok: unknown, message: string) => asserts ok = (ok, message) => {
  if (!ok) throw new CheckError(message);
};

export const assertEq = <T>(actual: T, expected: T, label: string): void => {
  if (actual !== expected) {
    throw new CheckError(
      `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
};

export const assertIncludes = (haystack: string, needle: string, label: string): void => {
  assert(
    haystack.includes(needle),
    `${label}：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack.slice(0, 300))}`,
  );
};

/** JSON.parse 的失败路径统一成可读的用例失败，而不是裸 SyntaxError。 */
export const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new CheckError(
      `${label}：不是合法 JSON：${JSON.stringify(text.slice(0, 300))}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
};
