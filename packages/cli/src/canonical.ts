// This layer: turns a path into its realpath (resolving symlinks, completing a missing tail from the deepest existing ancestor); does not check existence or read content.
// Whether two paths are the same must be decided here: realpath on one side and plain resolve on the other would let macOS's `/tmp` -> `/private/tmp`
// split one file into two and make the hint lie.

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Returns undefined when the path (or a parent link) does not exist: the caller decides whether that is an error or a completion case. */
export const attemptRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** The target may not exist yet (patch may create it): the missing tail is completed from the deepest existing ancestor. */
export const realpathThroughAncestors = (path: string): string => {
  const real = attemptRealpath(path);
  if (real !== undefined) return real;
  const parent = dirname(path);
  return join(realpathThroughAncestors(parent), path.slice(parent.length + 1));
};
