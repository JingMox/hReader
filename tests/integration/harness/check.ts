// 这层管：最小的测试编排（注册 → 顺序执行 → 汇总）与断言；没有框架依赖，
// 每个套件文件既能被 run.ts 当子进程跑，也能 `node tests/integration/suites/x.ts` 单跑。

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

// 同步收尾（killAllTracked/cleanup）不该被迫挂个空 await。
type TestFn = () => Promise<void> | void;

interface Case {
  readonly name: string;
  readonly fn: TestFn;
}

const queue: Case[] = [];
/** `beforeAll`/`afterAll`：每个套件文件各跑一遍（套件=进程）。 */
let beforeAll: TestFn | undefined;
let afterAll: TestFn | undefined;

export const test = (name: string, fn: TestFn): void => {
  queue.push({ name, fn });
};

export const setUp = (fn: TestFn): void => {
  beforeAll = fn;
};
export const tearDown = (fn: TestFn): void => {
  afterAll = fn;
};

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** 单进程跑完本套件：失败不中断后续用例（交叉复审要看全貌），退出码按汇总给。 */
export const runSuite = async (suite: string): Promise<void> => {
  const failures: string[] = [];
  if (beforeAll !== undefined) {
    try {
      await beforeAll();
    } catch (error: unknown) {
      write(`[SETUP-FAIL] ${suite}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  for (const item of queue) {
    const at = Date.now();
    try {
      await item.fn();
      write(`[PASS] ${suite} :: ${item.name} (${String(Date.now() - at)}ms)`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(item.name);
      write(`[FAIL] ${suite} :: ${item.name} — ${message.split("\n")[0] ?? ""}`);
    }
  }
  if (afterAll !== undefined) {
    try {
      await afterAll();
    } catch (error: unknown) {
      failures.push("(teardown)");
      write(
        `[FAIL] ${suite} :: (teardown) — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    write(
      `FAILED ${suite}: ${String(failures.length)}/${String(queue.length)} — ${failures.join(" | ")}`,
    );
    process.exitCode = 1;
    return;
  }
  write(`OK ${suite}: ${String(queue.length)} 用例全过`);
};

/** Chrome 缺席时按仓内 e2e 的约定：印一行 SKIPPED 并以 0 退出（需要真跑的 CI 显式给 CHROME_BIN）。 */
export const skipSuite = (suite: string, reason: string): void => {
  write(`SKIPPED ${suite}: ${reason}`);
};
