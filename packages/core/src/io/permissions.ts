// 这层管：外来 HTML 的两个权限维度（脚本 / 联网）的存取与合成——
// 单文档授权存工作区 `.hreader/trust.json`（键 = 工作区相对路径，内容改动不失效），
// 全局默认模式存用户级 `<home>/.hreader/permissions.json`（home 由调用方注入，绝不读真实 HOME）。
// 旧版"内容 sha256 → off/local"记录在读取时按当前字节惰性迁移成路径键。
// 不判 CSP、不改文档本身。

import { dirname, join } from "node:path";

import { mkdirOrFail, writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8 } from "./bytes";
import type { PatchOptions } from "./contracts";
import { sha256Hex } from "./digest";
import { failureOf } from "./errors";
import { runLocked } from "./lock";
import type { ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/** 全局默认的三选一档位：`per-doc` = 逐文档开关（两项的缺省值）。 */
export type PermissionMode = "allow" | "deny" | "per-doc";

/** 全局默认设置：脚本与联网各一个模式，独立不联动。 */
export interface GlobalModes {
  readonly scripts: PermissionMode;
  readonly network: PermissionMode;
}

/** 单文档授权的两维开关；按路径记，文件改名/移动即失效（相当于新地址）。 */
export interface DocGrant {
  readonly scripts: boolean;
  readonly network: boolean;
}

/** 全局模式 + 单文档授权算出的生效值与出处（`per-doc` 维度的值才来自单文档记录）。 */
export interface EffectivePermissions {
  readonly scripts: boolean;
  readonly network: boolean;
  readonly scriptsSource: "doc" | "global";
  readonly networkSource: "doc" | "global";
}

/** 旧式信任档的对外兼容面：`local` = 脚本可跑且无网络，现在等价于 grant {scripts:true, network:false}。 */
export type TrustLevel = "off" | "local";

/**
 * 全局模式的部分更新体：字段可缺省，缺省维度沿用现值。
 * `| undefined` 是 `exactOptionalPropertyTypes` 下的显式可缺——zod 的可选字段输出同形。
 */
export interface GlobalModesPatch {
  readonly scripts?: PermissionMode | undefined;
  readonly network?: PermissionMode | undefined;
}

/**
 * Partial update shape for a doc grant: a missing dimension keeps the stored
 * value. Same explicit-optional convention as GlobalModesPatch.
 */
export interface DocGrantPatch {
  readonly scripts?: boolean | undefined;
  readonly network?: boolean | undefined;
}

/** `per-doc` 维度取授权值，全局档维度取模式值；出处只用来向 UI 解释"开关归谁管"。 */
export const effectiveOf = (modes: GlobalModes, grant: DocGrant): EffectivePermissions => ({
  scripts: modes.scripts === "allow" ? true : modes.scripts === "deny" ? false : grant.scripts,
  network: modes.network === "allow" ? true : modes.network === "deny" ? false : grant.network,
  scriptsSource: modes.scripts === "per-doc" ? "doc" : "global",
  networkSource: modes.network === "per-doc" ? "doc" : "global",
});

export const grantOfLevel = (level: TrustLevel): DocGrant => ({
  scripts: level === "local",
  network: false,
});

export const levelOfScripts = (scripts: boolean): TrustLevel => (scripts ? "local" : "off");

// ---- 单文档授权：`<workspace>/.hreader/trust.json`，键 = `ResolvedTarget.relative` ----

const STORE_FILE = "trust.json";
/** 跨文档共享表的专用锁：文件名不带 docId 派生值，与按文件的 `<sha1>.lock` 互不干扰。 */
const LOCK_FILE = "trust.lock";

const trustPathOf = (storeDir: string): string => join(storeDir, STORE_FILE);
const trustLockOf = (storeDir: string): string => join(storeDir, "locks", LOCK_FILE);

/** 旧格式授权值；sha 键与新路径键靠值的形状区分（字符串 = 旧，对象 = 新）。 */
type LegacyLevel = "off" | "local";

interface TrustTable {
  readonly grants: Record<string, DocGrant>;
  /** 迁移后仍保留旧键：两份内容相同的文档共享同一 sha 授权，删掉会让第二篇丢档。 */
  readonly legacy: Record<string, LegacyLevel>;
}

const isLegacyLevel = (value: unknown): value is LegacyLevel =>
  value === "off" || value === "local";

const isGrantShape = (value: unknown): value is DocGrant =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "scripts") === "boolean" &&
  typeof Reflect.get(value, "network") === "boolean";

/**
 * Table keys come from untrusted disk contents and file names, so both maps
 * are prototype-free: on a plain object a `__proto__` key would swap the
 * prototype instead of landing as data (silently dropping the write) and
 * reads of slot-colliding names like `scripts` would return polluted values.
 */
const emptyTable = (): TrustTable => ({
  grants: Object.create(null) as Record<string, DocGrant>,
  legacy: Object.create(null) as Record<string, LegacyLevel>,
});

/**
 * 读取的任何失败与任何损坏形状都回落成"没有任何授权"：信任是显式授予物，
 * 文件丢了/坏了必须掉回最严的全关，而不是把整个服务拖死。
 * 回落必须给**新对象**——写侧会把 grant 塞进返回的表，共享空表会把授权漏进下个世界。
 */
const tableOf = async (deps: PatchDeps, path: string): Promise<TrustTable> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(await deps.fs.readFile(path), path));
  } catch {
    return emptyTable();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyTable();
  const table = emptyTable();
  for (const [key, value] of Object.entries(parsed)) {
    if (isGrantShape(value)) table.grants[key] = { scripts: value.scripts, network: value.network };
    else if (isLegacyLevel(value)) table.legacy[key] = value;
  }
  return table;
};

const DENIED: DocGrant = { scripts: false, network: false };

const serializeTable = (table: TrustTable): string =>
  // 旧键与新键落在同一份 JSON 里：旧键只可能被读成 legacy（值是字符串），不会被当 grant。
  JSON.stringify({ ...table.legacy, ...table.grants });

/** 锁内重读再落盘：迁移期间授权可能被改/被别的迁移抢先，只迁"此刻仍待迁"的那条。 */
const persistMigration = async (
  input: { readonly target: ResolvedTarget; readonly bytes: Uint8Array },
  deps: PatchDeps,
): Promise<void> => {
  const path = trustPathOf(input.target.storeDir);
  await runLocked({ lockPath: trustLockOf(input.target.storeDir) }, deps, {}, async () => {
    const table = await tableOf(deps, path);
    if (table.grants[input.target.relative] !== undefined) return;
    if (table.legacy[sha256Hex(input.bytes)] !== "local") return;
    table.grants[input.target.relative] = { scripts: true, network: false };
    await mkdirOrFail(deps, input.target.storeDir);
    await writeAtomic(
      {
        path,
        workspace: input.target.workspace,
        data: encodeUtf8(serializeTable(table)),
      },
      deps,
    );
  });
};

/**
 * 路径键直查；落空再看"内容 sha == 旧键"（旧版信任档）：匹配就按 `{scripts:true, network:false}`
 * 迁移成本路径并落盘。迁移写不进不阻塞读——授权值已经算出，下次读到旧键还会重试（幂等）。
 */
export const readDocGrant = async (
  input: { readonly target: ResolvedTarget; readonly bytes: Uint8Array },
  deps: PatchDeps,
): Promise<DocGrant> => {
  const table = await tableOf(deps, trustPathOf(input.target.storeDir));
  const direct = table.grants[input.target.relative];
  if (direct !== undefined) return direct;
  if (table.legacy[sha256Hex(input.bytes)] !== "local") return DENIED;
  await persistMigration(input, deps).catch(() => undefined);
  return { scripts: true, network: false };
};

/** 读-改-写必须整段在锁里：锁外合并会丢别的文档（或另一进程）刚写入的授权。 */
export const writeDocGrant = async (
  input: { readonly target: ResolvedTarget; readonly grant: DocGrant },
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<void> => {
  const path = trustPathOf(input.target.storeDir);
  await runLocked({ lockPath: trustLockOf(input.target.storeDir) }, deps, options, async () => {
    const table = await tableOf(deps, path);
    table.grants[input.target.relative] = input.grant;
    await mkdirOrFail(deps, input.target.storeDir);
    await writeAtomic(
      {
        path,
        workspace: input.target.workspace,
        data: encodeUtf8(serializeTable(table)),
      },
      deps,
    );
  });
};

/**
 * Partial grant write where the merge base is read inside the lock: a caller
 * merging outside could only see a stale record once a parallel write —
 * another process, or an alias docId past the per-doc request queue —
 * commits first. The base honors a pending legacy sha grant just like
 * readDocGrant does, so a patch cannot silently drop an unmigrated scripts
 * grant. Returns the merged grant so callers skip a second read.
 */
export const patchDocGrant = async (
  input: {
    readonly target: ResolvedTarget;
    readonly patch: DocGrantPatch;
    readonly bytes: Uint8Array;
  },
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<DocGrant> => {
  const path = trustPathOf(input.target.storeDir);
  return await runLocked(
    { lockPath: trustLockOf(input.target.storeDir) },
    deps,
    options,
    async () => {
      const table = await tableOf(deps, path);
      const current: DocGrant =
        table.grants[input.target.relative] ??
        (table.legacy[sha256Hex(input.bytes)] === "local"
          ? { scripts: true, network: false }
          : DENIED);
      const merged: DocGrant = {
        scripts: input.patch.scripts ?? current.scripts,
        network: input.patch.network ?? current.network,
      };
      table.grants[input.target.relative] = merged;
      await mkdirOrFail(deps, input.target.storeDir);
      await writeAtomic(
        {
          path,
          workspace: input.target.workspace,
          data: encodeUtf8(serializeTable(table)),
        },
        deps,
      );
      return merged;
    },
  );
};

// ---- 全局默认：`<home>/.hreader/permissions.json`，home 由调用方注入 ----

const SETTINGS_DIR = ".hreader";
const SETTINGS_FILE = "permissions.json";
const SETTINGS_LOCK = "settings.lock";

export const settingsPathOf = (home: string): string => join(home, SETTINGS_DIR, SETTINGS_FILE);
const settingsLockOf = (home: string): string => join(home, SETTINGS_DIR, "locks", SETTINGS_LOCK);

const DEFAULT_MODES: GlobalModes = { scripts: "per-doc", network: "per-doc" };

const isMode = (value: unknown): value is PermissionMode =>
  value === "allow" || value === "deny" || value === "per-doc";

/** 字段各自独立回落：一个维度坏了不连坐另一个。 */
const modesOf = (parsed: unknown): GlobalModes => {
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_MODES;
  const scripts: unknown = Reflect.get(parsed, "scripts");
  const network: unknown = Reflect.get(parsed, "network");
  return {
    scripts: isMode(scripts) ? scripts : "per-doc",
    network: isMode(network) ? network : "per-doc",
  };
};

/** 缺失/损坏/读失败一律回落双 `per-doc`：全局档是便利设施，不是安全闸的根基。 */
export const readGlobalModes = async (home: string, deps: PatchDeps): Promise<GlobalModes> => {
  const path = settingsPathOf(home);
  try {
    return modesOf(JSON.parse(decodeUtf8(await deps.fs.readFile(path), path)));
  } catch {
    return DEFAULT_MODES;
  }
};

/**
 * 部分更新：只给的维度覆盖，没给的沿用现值；写不进就抛（调用方把 500 翻译成可读错误，
 * 服务本身不受影响）。`workspace` 传真实化的 `home`——`.hreader` 在 home 之下，
 * 原子写的"父目录不得逃逸"复核照走。
 */
export const writeGlobalModes = async (
  input: { readonly home: string; readonly modes: GlobalModesPatch },
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<GlobalModes> => {
  const path = settingsPathOf(input.home);
  let workspace: string;
  try {
    workspace = await deps.fs.realpath(input.home);
  } catch (error: unknown) {
    throw failureOf("解析用户配置根", input.home, error);
  }
  return await runLocked({ lockPath: settingsLockOf(input.home) }, deps, options, async () => {
    const current = await readGlobalModes(input.home, deps);
    const next: GlobalModes = {
      scripts: input.modes.scripts ?? current.scripts,
      network: input.modes.network ?? current.network,
    };
    await mkdirOrFail(deps, dirname(path));
    await writeAtomic({ path, workspace, data: encodeUtf8(JSON.stringify(next)) }, deps);
    return next;
  });
};
