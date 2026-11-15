// 这层管：给 SDK 的类型声明擦屁股——`@modelcontextprotocol/sdk` 的
// `dist/esm/shared/transport.d.ts` 用了 DOM 的 `HeadersInit`，而本仓 `lib` 只有 ES2023
// 且 `skipLibCheck: false`（依赖的 .d.ts 也会被检查）。Node 侧的等价类型就是全局
// `RequestInit["headers"]`，这里只把名字接上，不另立一套定义。
// SDK 补上这个类型后删掉本文件——届时 `tsc` 会因找不到 `HeadersInit` 而变红，那正是该删的信号。
// 本文件是全局声明：除下面这一行外不许再放任何类型。

type HeadersInit = NonNullable<RequestInit["headers"]>;
