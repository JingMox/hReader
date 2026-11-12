// 这层管：LIFO 栈的遍历写法；不知道栈里装什么，也不改变遍历顺序。

/**
 * 边遍历边 push 的栈遍历。用 `for` 条件而不是 `while (stack.length > 0) { pop(); if (x === undefined) break; }`：
 * 后者那个 `break` 永远不可达，覆盖率上是死分支，也会骗人以为"有防御"。
 */
export function* drainStack<T>(stack: T[]): Generator<T> {
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    yield item;
  }
}
