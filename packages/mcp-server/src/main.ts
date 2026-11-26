// This layer: the only bin entry — hands argv to `cli.ts` and decides nothing itself.
// stdout is the JSON-RPC channel; this file never writes a single byte to it (`cli.ts` logs go to stderr too).

import { runMain } from "./cli";

process.exitCode = await runMain(process.argv.slice(2));
