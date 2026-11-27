// This layer owns: assertions and error shape. Orchestration belongs to Vitest
// (describe/test/beforeAll/afterAll); only the assertion helpers stay here —
// failure messages must read as plain sentences. Plus parseJson's uniform
// error face.

export class CheckError extends Error {}

// The `asserts ok` signature: after assert the caller gets type narrowing
// (unknown → concrete type) without an `as`. The variable itself also needs an
// explicit annotation (TS2775: every name in an assertion call target requires
// an explicit type).
export const assert: (ok: unknown, message: string) => asserts ok = (ok, message) => {
  if (!ok) throw new CheckError(message);
};

export const assertEq = <T>(actual: T, expected: T, label: string): void => {
  if (actual !== expected) {
    throw new CheckError(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

export const assertIncludes = (haystack: string, needle: string, label: string): void => {
  assert(
    haystack.includes(needle),
    `${label}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(haystack.slice(0, 300))}`,
  );
};

/** JSON.parse's failure path becomes a readable case failure instead of a bare SyntaxError. */
export const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new CheckError(
      `${label}: not valid JSON: ${JSON.stringify(text.slice(0, 300))} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};
