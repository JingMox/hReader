// 这层管：假 FileSystem（内存文件/目录/链接 + 故障注入 + 一次性钩子）；不碰真盘。
// 与 harness.ts 分开只是为了让"测试辅助"各自不超过 300 行；用法仍是 `import ... from "./harness"`。

import type { Clock, FileSystem, OpenFile, PatchDeps } from "../../src/io/ports";

export type FsMethod =
  | "readFile"
  | "writeFile"
  | "writeFileAtomic"
  | "rename"
  | "unlink"
  | "mkdir"
  | "lstat"
  | "readdir"
  | "realpath"
  | "open"
  | "handleWrite";

export interface FakeState {
  readonly files: Map<string, Uint8Array>;
  readonly dirs: Set<string>;
  readonly mtimes: Map<string, number>;
  /** 假符号链接：路径 → 目标；`lstat` 判 link，`realpath` 按链解析。 */
  readonly links: Map<string, string>;
  readonly hooks: Hook[];
  readonly seededAt: number;
  readonly failures: Failure[];
  readonly log: string[];
}

interface Hook {
  readonly method: FsMethod;
  readonly match: (path: string) => boolean;
  readonly run: (path: string) => void;
}

interface Failure {
  readonly method: FsMethod;
  readonly error: unknown;
  readonly match: (path: string) => boolean;
}

export interface FakeFs {
  readonly port: FileSystem;
  readonly state: FakeState;
  fail: (method: FsMethod, error: unknown, match?: (path: string) => boolean) => void;
  /** 一次性副作用：在方法成功执行后触发，用来构造"读完之后文件被换掉"这类竞态。 */
  once: (method: FsMethod, match: (path: string) => boolean, run: (path: string) => void) => void;
  textAt: (path: string) => string;
}

export const systemError = (code: string): Error => Object.assign(new Error(code), { code });
export const seedFakeFs = (seed: Readonly<Record<string, string>>): FakeState => ({
  files: new Map(
    Object.entries(seed).map(([path, text]) => [path, new TextEncoder().encode(text)]),
  ),
  dirs: new Set(Object.keys(seed).map((path) => path.slice(0, path.lastIndexOf("/")))),
  mtimes: new Map(),
  links: new Map(),
  hooks: [],
  seededAt: Date.now(),
  failures: [],
  log: [],
});

const takeFailure = (state: FakeState, method: FsMethod, path: string): Failure | undefined => {
  const index = state.failures.findIndex(
    (failure) => failure.method === method && failure.match(path),
  );
  if (index < 0) return undefined;
  const [failure] = state.failures.splice(index, 1);
  return failure;
};

const guard = (state: FakeState, method: FsMethod, path: string): void => {
  state.log.push(`${method}:${path}`);
  const failure = takeFailure(state, method, path);
  if (failure !== undefined) throw failure.error;
};

const runHooks = (state: FakeState, method: FsMethod, path: string): void => {
  const pending = state.hooks.filter((hook) => hook.method === method && hook.match(path));
  for (const hook of pending) {
    const index = state.hooks.indexOf(hook);
    if (index >= 0) state.hooks.splice(index, 1);
    hook.run(path);
  }
};

const resolveLinks = (state: FakeState, path: string): string => {
  let current = path;
  for (let step = 0; step < 10; step += 1) {
    const target = state.links.get(current);
    if (target === undefined) return current;
    current = target;
  }
  return current;
};

const readFileOf = (state: FakeState, path: string): Uint8Array => {
  const bytes = state.files.get(path);
  if (bytes === undefined) throw systemError("ENOENT");
  return new Uint8Array(bytes);
};

const dirEntriesOf = (state: FakeState, dir: string): readonly string[] => {
  if (!state.dirs.has(dir)) throw systemError("ENOENT");
  const prefix = `${dir}/`;
  const names = [...state.files.keys(), ...state.dirs].flatMap((path) => {
    if (!path.startsWith(prefix)) return [];
    const tail = path.slice(prefix.length);
    return tail.length === 0 || tail.includes("/") ? [] : [tail];
  });
  return [...new Set(names)];
};

const handleOf = (state: FakeState, path: string): OpenFile => ({
  write: (data: Uint8Array) => {
    guard(state, "handleWrite", path);
    state.files.set(path, new Uint8Array(data));
    return Promise.resolve();
  },
  sync: () => Promise.resolve(),
});

const readMethodsOf = (
  state: FakeState,
): Omit<FileSystem, "writeFile" | "writeFileAtomic" | "rename" | "unlink" | "mkdir"> => ({
  readFile: (path) => {
    guard(state, "readFile", path);
    const bytes = readFileOf(state, path);
    runHooks(state, "readFile", path);
    return Promise.resolve(bytes);
  },
  lstat: (path) => {
    guard(state, "lstat", path);
    runHooks(state, "lstat", path);
    const mtimeMs = state.mtimes.get(path) ?? state.seededAt;
    if (state.links.has(path)) {
      return Promise.resolve({
        isFile: () => false,
        isSymbolicLink: () => true,
        mtimeMs,
        size: 0,
      });
    }
    if (state.dirs.has(path))
      return Promise.resolve({
        isFile: () => false,
        isSymbolicLink: () => false,
        mtimeMs,
        size: 0,
      });
    if (state.files.has(path))
      return Promise.resolve({
        isFile: () => true,
        isSymbolicLink: () => false,
        mtimeMs,
        size: state.files.get(path)?.length ?? 0,
      });
    throw systemError("ENOENT");
  },
  readdir: (dir) => {
    guard(state, "readdir", dir);
    return Promise.resolve(dirEntriesOf(state, dir));
  },
  realpath: (path) => {
    guard(state, "realpath", path);
    const resolved = resolveLinks(state, path);
    if (state.files.has(resolved) || state.dirs.has(resolved)) return Promise.resolve(resolved);
    throw systemError("ENOENT");
  },
  open: (path) => {
    guard(state, "open", path);
    if (state.files.has(path)) throw systemError("EEXIST");
    return Promise.resolve(handleOf(state, path));
  },
  close: () => Promise.resolve(),
});

const writeMethodsOf = (
  state: FakeState,
): Pick<FileSystem, "writeFile" | "writeFileAtomic" | "rename" | "unlink" | "mkdir"> => ({
  writeFile: (path, data) => {
    guard(state, "writeFile", path);
    state.files.set(path, new Uint8Array(data));
    state.mtimes.set(path, state.seededAt);
    return Promise.resolve();
  },
  // 假 fs 的一步写天然"原子"：tmp/rename 的细节是真实实现（write-file-atomic）自己的事。
  writeFileAtomic: (path, data) => {
    guard(state, "writeFileAtomic", path);
    state.files.set(path, new Uint8Array(data));
    state.mtimes.set(path, state.seededAt);
    return Promise.resolve();
  },
  rename: (from, to) => {
    guard(state, "rename", from);
    state.files.set(to, new Uint8Array(readFileOf(state, from)));
    state.files.delete(from);
    return Promise.resolve();
  },
  unlink: (path) => {
    guard(state, "unlink", path);
    if (!state.files.delete(path)) throw systemError("ENOENT");
    return Promise.resolve();
  },
  mkdir: (path) => {
    guard(state, "mkdir", path);
    state.dirs.add(path);
    return Promise.resolve();
  },
});

const fileSystemOf = (state: FakeState): FileSystem => ({
  ...readMethodsOf(state),
  ...writeMethodsOf(state),
});

export const fakeFs = (seed: Readonly<Record<string, string>>): FakeFs => {
  const state = seedFakeFs(seed);
  return {
    port: fileSystemOf(state),
    state,
    fail: (method, error, match) => {
      state.failures.push({ method, error, match: match ?? (() => true) });
    },
    once: (method, match, run) => {
      state.hooks.push({ method, match, run });
    },
    textAt: (path) => new TextDecoder().decode(readFileOf(state, path)),
  };
};

export const depsOf = (
  fs: FileSystem,
  clock: Clock,
  sleep: (ms: number) => Promise<void>,
): PatchDeps => ({ fs, clock, sleep });
