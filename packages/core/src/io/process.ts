// 这层管：pid 存活探测（只管"在不在"，不管权限）；不含接管策略。

import { codeOf } from "./errors";

/** `EPERM` = 进程存在但没权限发信号；只有 `ESRCH` 才说明确实不在了。 */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return codeOf(error) !== "ESRCH";
  }
};
