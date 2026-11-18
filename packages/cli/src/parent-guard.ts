// 这层管：「daemon 该不该因为父进程消失而自杀」的判定与采集口径；不读 process 之外的东西、不起定时器。
//
// 壳被 `kill -9` 时 Rust 侧没有任何机会收尸（`Daemon` 的 Drop 不会跑），所以 `hr serve` 必须自己看着父进程。
// 只由壳显式传 `--exit-with-parent` 时启用：用户自己起的 daemon 不该因为终端退出就死。

/** 启动时记下的父 pid + 读当前 ppid 的注入点（真实现读 `process.ppid`）。 */
export interface ParentWatch {
  readonly parentPid: number;
  readonly readParentPid: () => number;
}

/** 每秒看一次：父进程被换掉（re-parent 到 1 或别的 pid）= 壳已经不在了。 */
export const PARENT_POLL_MS = 1_000;

/**
 * 启动时父进程已经是 init：壳在 spawn 之后、我们跑到这里之前就死了。
 * 这种现场改看父进程发现不了——`process.ppid` 现在就是 1，而它会被当成"正常的父 pid"记下来（B5）。
 */
export const orphanedAtLaunch = (parentPid: number): boolean => parentPid === 1;

export const parentGone = (watch: ParentWatch): boolean =>
  watch.readParentPid() !== watch.parentPid;

/** `parentPid` 必须是壳在进程启动早期（任何 `await` 之前）采集的那个值，见 `main.ts`。 */
export const parentWatchOf = (parentPid: number): ParentWatch => ({
  parentPid,
  readParentPid: () => process.ppid,
});
