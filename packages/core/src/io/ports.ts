// 这层管：IO 端口的裸结构类型（fs / clock / sleep）；不含实现、不碰真实系统。

export interface FileStat {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly mtimeMs: number;
  /** 完整 `st_mode`（含文件类型位）；缺省 = 该 fs 不提供，调用方不得因此改权。 */
  readonly mode?: number;
}

/**
 * 打开模式只有两种，且都由调用方显式给出：
 * `wx` 独占创建（锁文件，已存在即 `EEXIST`）；`wx-nofollow` 额外拒符号链接（tmp，P0-1）。
 */
export type OpenMode = "wx" | "wx-nofollow";

export interface OpenFile {
  readonly write: (data: Uint8Array) => Promise<void>;
  readonly sync: () => Promise<void>;
}

/** 一个端口，不拆 Reader/Writer：本卡用到的 fs 方法全部落在这里。 */
export interface FileSystem {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly lstat: (path: string) => Promise<FileStat>;
  /** 只在保留权限位时用到；缺省 = 该 fs 不表态（测试替身），按不改权处理。 */
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly realpath: (path: string) => Promise<string>;
  readonly open: (path: string, mode: OpenMode) => Promise<OpenFile>;
  readonly close: (file: OpenFile) => Promise<void>;
}

export interface Clock {
  readonly now: () => Date;
}

export interface PatchDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
}
