#!/usr/bin/env node
// Fake Chrome (tests only): no CDP — just `/json/version` and the DevTools stderr line,
// plus three failure modes (crash / silent hang / stderr flood) for the timeout, process-hygiene, and buffer-cap cases.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const pidFile = process.env.FAKE_CHROME_PID_FILE;
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

// `FAKE_CHROME_GRANDCHILD=1`: forks one grandchild (same process group) that appends a byte to a marker file every 40 ms.
// Killing the process group takes it down too; killing only the main pid leaves it ticking — that is the distinguishing check.
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
    // `FAKE_MODE=flood` sprays 5 MB after the DevTools line: the line must still parse from the prefix.
    if (process.env.FAKE_MODE === "flood") process.stderr.write("x".repeat(5 * 1024 * 1024));
  });
}
