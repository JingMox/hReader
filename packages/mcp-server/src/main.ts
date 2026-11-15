// 这层管：唯一的 bin 入口——把 argv 交给 `cli.ts`，自己不做任何决定。
// stdout 是 JSON-RPC 通道，本文件一行都不往 stdout 写（`cli.ts` 的日志也只走 stderr）。

import { runMain } from "./cli";

process.exitCode = await runMain(process.argv.slice(2));
