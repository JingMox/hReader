// 这层管：原文件字节的快照（写入/列举/裁剪/取最近一份）；不校验路径、不加锁。

import { join } from "node:path";

import { mkdirOrFail, writeAtomic } from "./atomic";
import { failureOf, isMissing } from "./errors";
import { sha256Hex } from "./digest";
import { unlinkOf } from "./fs-ops";
import type { PatchDeps } from "./ports";

export const HISTORY_LIMIT = 10;

/** `<sha256 前 16 位>-<ts>-<seq>.html`：哈希进名字，undo 才能自证"这份快照没被截断"。 */
const SNAPSHOT_PATTERN = /^([0-9a-f]{16})-(\d{4}-\d{2}-\d{2}T[\d:.]+Z)-(\d+)\.html$/u;

interface Snapshot {
  readonly name: string;
  readonly hash: string;
  readonly at: string;
  readonly seq: number;
}

const snapshotOf = (name: string): Snapshot | undefined => {
  const matched = SNAPSHOT_PATTERN.exec(name);
  if (matched === null) return undefined;
  return { name, hash: String(matched[1]), at: String(matched[2]), seq: Number(matched[3]) };
};

const sortKey = (snapshot: Snapshot): string =>
  `${snapshot.at}\u0000${String(snapshot.seq).padStart(6, "0")}`;

/** 历史目录在第一次写入前不存在：缺目录等于"没有快照"，不是故障。 */
const readdirOrEmpty = async (deps: PatchDeps, dir: string): Promise<readonly string[]> => {
  try {
    return await deps.fs.readdir(dir);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw failureOf("读历史目录", dir, error);
  }
};

const nextSeq = (snapshots: readonly Snapshot[], at: string): number => {
  let max = 0;
  for (const snapshot of snapshots) {
    if (snapshot.at === at && snapshot.seq > max) max = snapshot.seq;
  }
  return max + 1;
};

/** 升序（旧 → 新）：最后一项就是 undo 要还原的那份。 */
export const listSnapshots = async (deps: PatchDeps, dir: string): Promise<readonly Snapshot[]> => {
  const snapshots: Snapshot[] = [];
  for (const name of await readdirOrEmpty(deps, dir)) {
    const snapshot = snapshotOf(name);
    if (snapshot !== undefined) snapshots.push(snapshot);
  }
  return snapshots.sort((left, right) => (sortKey(left) < sortKey(right) ? -1 : 1));
};

export const latestOf = (snapshots: readonly Snapshot[]): Snapshot | undefined =>
  snapshots[snapshots.length - 1];

export const writeSnapshot = async (
  input: { readonly dir: string; readonly workspace: string; readonly data: Uint8Array },
  deps: PatchDeps,
): Promise<string> => {
  await mkdirOrFail(deps, input.dir);
  const at = deps.clock.now().toISOString();
  const seq = nextSeq(await listSnapshots(deps, input.dir), at);
  const path = join(input.dir, `${sha256Hex(input.data).slice(0, 16)}-${at}-${String(seq)}.html`);
  await writeAtomic({ path, workspace: input.workspace, data: input.data }, deps);
  return path;
};

/** 只留最近 `HISTORY_LIMIT` 份；按时间序从旧往新裁。 */
export const pruneSnapshots = async (deps: PatchDeps, dir: string): Promise<void> => {
  const snapshots = await listSnapshots(deps, dir);
  for (const snapshot of snapshots.slice(0, Math.max(0, snapshots.length - HISTORY_LIMIT))) {
    await unlinkOf(deps.fs, join(dir, snapshot.name));
  }
};
