// 这层管：真实子进程的 kill 试验体——用真实 wx 写 tmp 后停在 IPC barrier，等父进程 go 才 rename。
// 停在这里被 SIGKILL，能真实复现"tmp 残留、原文件未动"的崩溃现场；不许 mock。

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { nodePatchDeps } from "../src/io/node-fs.ts";

const [target] = process.argv.slice(2);
if (target === undefined) throw new Error("kill-writer 需要目标文件路径");

const tmp = join(
  dirname(target),
  `.hr-tmp.${String(process.pid)}.${randomBytes(6).toString("hex")}.${basename(target)}`,
);
const handle = await nodePatchDeps.fs.open(tmp);
await handle.write(new TextEncoder().encode("half-written payload"));
await handle.sync();
await nodePatchDeps.fs.close(handle);

process.send?.({ ready: true, tmp });

process.once("message", async () => {
  await nodePatchDeps.fs.rename(tmp, target);
  process.send?.({ renamed: true });
  process.exit(0);
});

setInterval(() => undefined, 1_000);
