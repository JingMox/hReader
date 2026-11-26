// This layer owns the document capability tokens (`cap`): minting them from a
// per-process secret, registering which document each cap covers, and the
// constant-time lookup `/f/` performs per request. No HTTP, no disk IO.

import { createHmac, randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";

import type { ResolvedTarget } from "../io/paths";
import { tokenMatches } from "./auth";

const KEY_BYTES = 32;

/** Truncated base64url(HMAC-SHA256): 22 chars ≈ 132 bits of MAC — unforgeable and unguessable. */
export const CAP_LENGTH = 22;

/**
 * `subject` is the material a cap binds to — for documents, the directory's
 * workspace-relative path plus "\0" plus the document basename, so two
 * documents in one directory never share a cap. The secret only lives in this
 * process, so a restart voids every previously issued cap.
 */
export const capabilityOf = (key: Uint8Array, subject: string): string =>
  createHmac("sha256", key).update(subject).digest("base64url").slice(0, CAP_LENGTH);

/**
 * One document bound to a cap. `dir` is the scope root whitelisted assets
 * resolve under; `docName` is the single name served as the `/f/` ".html
 * exception" — sibling documents in the same directory stay unservable.
 */
export interface DocGrant {
  readonly cap: string;
  /** Real path of the doc directory; the root every `/f/` path resolves inside. */
  readonly dir: string;
  /** Exact basename of the document this cap may serve as HTML. */
  readonly docName: string;
  readonly doc: ResolvedTarget;
}

export interface CapabilityBook {
  /** Registers the document (idempotent per document) and returns its grant. */
  readonly register: (target: ResolvedTarget) => DocGrant;
  /** Constant-time cap check: forged, cross-document, and stale caps all miss. */
  readonly lookup: (cap: string) => DocGrant | undefined;
  /** `register` + `/f/<cap>/<basename>` in one step: a cap only exists once handed out. */
  readonly frameUrlOf: (target: ResolvedTarget) => string;
}

const dirRelativeOf = (target: ResolvedTarget): string => {
  const at = target.relative.lastIndexOf("/");
  return at === -1 ? "" : target.relative.slice(0, at);
};

export const createCapabilityBook = (key: Uint8Array = randomBytes(KEY_BYTES)): CapabilityBook => {
  const grants: DocGrant[] = [];
  const byDoc = new Map<string, DocGrant>();
  const register = (target: ResolvedTarget): DocGrant => {
    const existing = byDoc.get(target.realPath);
    if (existing !== undefined) return existing;
    const name = basename(target.realPath);
    const grant: DocGrant = {
      cap: capabilityOf(key, `${dirRelativeOf(target)}\0${name}`),
      dir: dirname(target.realPath),
      docName: name,
      doc: target,
    };
    byDoc.set(target.realPath, grant);
    grants.push(grant);
    return grant;
  };
  return {
    register,
    // Grants stay few (one per document opened this session): scanning them
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
