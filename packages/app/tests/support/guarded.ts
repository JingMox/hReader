// 测试共用：把"任意形状的假响应"喂给真守卫，拿到 `T` 而不用 `as T`（仓库禁 `as`）。
// 守卫不过就抛错——假响应形状写错时会当场炸，而不是静默返回一个假 `T`。

export const guardedOf = <T>(candidate: unknown, guard: (value: unknown) => value is T): T => {
  if (!guard(candidate)) throw new Error("测试假响应与守卫不符");
  return candidate;
};
