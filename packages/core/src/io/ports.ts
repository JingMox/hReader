// 这层管：IO 端口的裸结构类型（fs / clock / sleep）；不含实现、不碰真实系统。

export interface FileStat {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly mtimeMs: number;
  /** 逻辑大小（字节）；容量预检用——读到的真实长度仍以 readFile 返回值为准。 */
  readonly size: number;
  /** 完整 `st_mode`（含文件类型位）；缺省 = 该 fs 不提供，调用方不得因此改权。 */
  readonly mode?: number;
}

export interface OpenFile {
  readonly write: (data: Uint8Array) => Promise<void>;
  readonly sync: () => Promise<void>;
}

/** 一个端口，不拆 Reader/Writer：本卡用到的 fs 方法全部落在这里。 */
export interface FileSystem {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  /**
   * Hard link (`link(2)`): `EEXIST` when the target exists, never overwrites — the atomic gate for "create only if absent".
   * Optional: without it, implementations fall back to exclusive `open` create (which can leave a half-written file inside the crash window).
   */
  readonly link?: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly lstat: (path: string) => Promise<FileStat>;
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly realpath: (path: string) => Promise<string>;
  /** 独占创建：文件已存在即 `EEXIST`——锁文件就靠这条语义互斥。 */
  readonly open: (path: string) => Promise<OpenFile>;
  readonly close: (file: OpenFile) => Promise<void>;
  /**
   * 同目录 tmp → fsync → 沿用原文件权限位/属主 → rename 的整段原子写。
   * 真实实现委托 write-file-atomic；workspace 安全复核在调用方（atomic.ts）。
   */
  readonly writeFileAtomic: (path: string, data: Uint8Array) => Promise<void>;
}

export interface Clock {
  readonly now: () => Date;
}

export interface PatchDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
}
