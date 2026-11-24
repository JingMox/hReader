// 这层管：外来文档的信任档存取（`.hreader/trust.json`，键 = 文档内容的 sha256）；
// 不判文档分档、绝不改写文档本身。

import { join } from "node:path";

import { mkdirOrFail, writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8 } from "./bytes";
import type { PatchOptions } from "./contracts";
import { sha256Hex } from "./digest";
import { runLocked } from "./lock";
import type { ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/**
 * `"off"` = 默认档，CSP 把文档完全关死；`"local"` = 用户显式放行脚本。
 * 信任绑定的是**内容哈希**而非路径：文件改动一个字节，键就对不上，自动回落 `"off"`。
 */
export type TrustLevel = "off" | "local";

export interface TrustInput {
  readonly target: ResolvedTarget;
  readonly bytes: Uint8Array;
}

export interface TrustGrant extends TrustInput {
  readonly level: TrustLevel;
}

const STORE_FILE = "trust.json";
/** 跨文档共享表的专用锁：文件名不带 docId 派生值，与按文件的 `<sha1>.lock` 互不干扰。 */
const LOCK_FILE = "trust.lock";

const trustPathOf = (storeDir: string): string => join(storeDir, STORE_FILE);

const isTrustLevel = (value: unknown): value is TrustLevel => value === "off" || value === "local";

/**
 * 读取的任何失败与任何损坏形状都回落成"没有任何授权"：信任是显式授予物，
 * 文件丢了/坏了必须掉回最严的 `"off"`，而不是把整个服务拖死。
 */
const tableOf = async (deps: PatchDeps, path: string): Promise<Record<string, TrustLevel>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(await deps.fs.readFile(path), path));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const table: Record<string, TrustLevel> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isTrustLevel(value)) table[key] = value;
  }
  return table;
};

export const readTrust = async (input: TrustInput, deps: PatchDeps): Promise<TrustLevel> =>
  (await tableOf(deps, trustPathOf(input.target.storeDir)))[sha256Hex(input.bytes)] ?? "off";

/** 读-改-写必须整段在锁里：锁外合并会丢别的文档（或另一进程）刚写入的档。 */
export const writeTrust = async (
  input: TrustGrant,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<void> => {
  const lockPath = join(input.target.storeDir, "locks", LOCK_FILE);
  await runLocked({ lockPath }, deps, options, async () => {
    const path = trustPathOf(input.target.storeDir);
    const table = await tableOf(deps, path);
    table[sha256Hex(input.bytes)] = input.level;
    await mkdirOrFail(deps, input.target.storeDir);
    await writeAtomic(
      { path, workspace: input.target.workspace, data: encodeUtf8(JSON.stringify(table)) },
      deps,
    );
  });
};
