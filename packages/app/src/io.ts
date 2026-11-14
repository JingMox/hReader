// 这层管：浏览器侧的 IO 契约（类型只在，不含实现）；`main.ts` 提供真 `fetch` 实现，测试可替换。
// 单独成文件是为了断开 `main.ts ↔ wiring.ts` 的循环依赖（depcruise `no-circular`）。

export interface AppIo {
  readonly text: (path: string) => Promise<string>;
  readonly json: <T>(path: string, guard: (value: unknown) => value is T) => Promise<T>;
  /** 写请求（批注提交 / undo）；缺省时写操作明确报错，不静默成功。 */
  readonly post?: <T>(
    path: string,
    body: Readonly<Record<string, unknown>>,
    guard: (value: unknown) => value is T,
  ) => Promise<T>;
}

/** `POST /api/doc/<id>/undo`、`POST .../annotations` 的成功响应形状。 */
export interface RevisionResponse {
  readonly revision: string;
}
