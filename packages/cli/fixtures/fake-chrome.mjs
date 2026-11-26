#!/usr/bin/env node
// 假 Chrome（测试专用）：不实现 CDP，只提供 `/json/version` 与 stderr 的 DevTools 行，
// 另带三个故障模式（崩溃 / 静默挂住 / stderr 洪流）供超时、进程卫生与缓冲上限用例使用。
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const pidFile = process.env.FAKE_CHROME_PID_FILE;
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

// `FAKE_CHROME_GRANDCHILD=1`：再 fork 一个孙进程（同一进程组），每 40ms 往标记文件追加一个字节。
// 杀进程组会连它一起收；只杀主 pid 会留它继续 tick —— 判别点就在这里。
const markerFile = process.env.FAKE_CHROME_MARKER_FILE;
if (process.env.FAKE_CHROME_GRANDCHILD === "1" && markerFile !== undefined) {
  const script = `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(markerFile)}, "x"), 40)`;
  spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

if (process.env.FAKE_CHROME_EXIT === "1") {
  process.stderr.write("fake chrome: cannot start\nsecond line must be truncated\n");
  process.exit(2);
}

if (process.env.FAKE_CHROME_SLEEP === "1") {
  setInterval(() => undefined, 1000);
} else {
  let port = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
      }),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    const listening = `DevTools listening on ws://127.0.0.1:${String(port)}/devtools/browser/fake\n`;
    process.stderr.write(listening);
    // `FAKE_MODE=flood` 只在 DevTools 行之后喷 5 MB：行必须仍能从前缀里解析出来。
    if (process.env.FAKE_MODE === "flood") process.stderr.write("x".repeat(5 * 1024 * 1024));
  });
}
