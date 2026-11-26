// This layer owns the doc-directory capability tokens (`cap`): minting them
// from a per-process secret, registering which directory each cap covers, and
// the constant-time lookup `/f/` performs per request. No HTTP, no disk IO.

import { createHmac, randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";

import type { ResolvedTarget } from "../io/paths";
import { tokenMatches } from "./auth";

const KEY_BYTES = 32;

/** Truncated base64url(HMAC-SHA256): 22 chars ≈ 132 bits of MAC — unforgeable and unguessable. */
export const CAP_LENGTH = 22;

/**
 * `dirRelative` is the doc directory's workspace-relative path ("" for a doc
 * sitting at the workspace root). The secret only lives in this process, so a
 * restart voids every previously issued cap.
 */
export const capabilityOf = (key: Uint8Array, dirRelative: string): string =>
  createHmac("sha256", key).update(dirRelative).digest("base64url").slice(0, CAP_LENGTH);

/**
 * One directory covered by a cap. `docs` is the `/f/` ".html exception" set:
 * only basenames registered here may be served as the document itself —
 * every other HTML stays unservable even though it shares the directory.
 */
export interface DirGrant {
  readonly cap: string;
  /** Real path of the doc directory; the root every `/f/` path resolves inside. */
  readonly dir: string;
  readonly docs: Map<string, ResolvedTarget>;
}

export interface CapabilityBook {
  /** Registers the doc's directory (idempotent per directory) and returns its grant. */
  readonly register: (target: ResolvedTarget) => DirGrant;
  /** Constant-time cap check: forged, cross-directory, and stale caps all miss. */
  readonly lookup: (cap: string) => DirGrant | undefined;
  /** `register` + `/f/<cap>/<basename>` in one step: a cap only exists once handed out. */
  readonly frameUrlOf: (target: ResolvedTarget) => string;
}

const dirRelativeOf = (target: ResolvedTarget): string => {
  const at = target.relative.lastIndexOf("/");
  return at === -1 ? "" : target.relative.slice(0, at);
};

export const createCapabilityBook = (key: Uint8Array = randomBytes(KEY_BYTES)): CapabilityBook => {
  const grants: DirGrant[] = [];
  const byDir = new Map<string, DirGrant>();
  const register = (target: ResolvedTarget): DirGrant => {
    const dir = dirname(target.realPath);
    const existing = byDir.get(dir);
    if (existing !== undefined) {
      existing.docs.set(basename(target.realPath), target);
      return existing;
    }
    const grant: DirGrant = {
      cap: capabilityOf(key, dirRelativeOf(target)),
      dir,
      docs: new Map([[basename(target.realPath), target]]),
    };
    byDir.set(dir, grant);
    grants.push(grant);
    return grant;
  };
  return {
    register,
    // Grants stay few (one per directory touched this session): scanning them
    // with tokenMatches' constant-time comparison is cheap and never lets a
    // hashmap probe leak a correct-prefix timing signal.
    lookup: (cap) => {
      for (const grant of grants) if (tokenMatches(cap, grant.cap)) return grant;
      return undefined;
    },
    frameUrlOf: (target) =>
      `/f/${register(target).cap}/${encodeURIComponent(basename(target.realPath))}`,
  };
};
