// This layer owns the annotate-mode pure pieces: the single-use token book
// (TTL / binding / capacity cap) and the `<script nonce>` injection point
// (parse5 source locations). No HTTP, no file IO.

import { randomBytes } from "node:crypto";

import { parse as parse5 } from "parse5";

import { HrError } from "../hr-error";
import type { Clock } from "../io/ports";

/** Annotate tokens and nonces: 128-bit random → base64url (22 chars), held in process memory only. */
const RANDOM_BYTES = 16;

/** Service window counted from minting: a token lives for one iframe navigation; past that it is dead. */
export const ANNOTATE_TOKEN_TTL_MS = 60_000;

/** Cap on concurrently live tokens: annotating is a low-frequency user action, so four digits is generous. */
export const ANNOTATE_TOKEN_LIMIT = 1_000;

/** Reserved resource name the injected `<script>` points at: it wins on the /f/ route, so a same-named file in the doc directory is unreachable. */
export const ANNOTATOR_NAME = "__hr_annotator.js";

interface TokenEntry {
  readonly cap: string;
  readonly docName: string;
  readonly expiresAt: number;
}

export interface AnnotateTokenBook {
  /**
   * Mint a token for (cap, docName): expired entries are swept before the
   * capacity check, and past the cap minting is refused (`busy` — the TTL
   * reaps them soon enough). A vanishingly rare random collision retries a
   * bounded number of times — a colliding live token is never silently rebound.
   */
  readonly mint: (cap: string, docName: string) => string;
  /**
   * Single-use burn: a hit is deleted whatever the verdict, then judged by
   * "unexpired AND cap/docName both match". Every failure is the same `false`
   * — expired, forged and wrong-document are indistinguishable, so probing
   * learns nothing.
   */
  readonly consume: (cap: string, docName: string, token: string) => boolean;
}

const COLLISION_ATTEMPTS = 8;

export const createAnnotateTokenBook = (
  clock: Clock,
  randomToken: () => string = () => randomBytes(RANDOM_BYTES).toString("base64url"),
): AnnotateTokenBook => {
  const entries = new Map<string, TokenEntry>();
  const sweep = (nowMs: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(key);
    }
  };
  return {
    mint: (cap, docName) => {
      const nowMs = clock.now().getTime();
      sweep(nowMs);
      if (entries.size >= ANNOTATE_TOKEN_LIMIT) {
        // Stryker disable next-line StringLiteral: the contract pins the code, not the wording — message text is free to vary, equivalent.
        throw new HrError("busy", "批注令牌签发过于频繁，请稍后重试");
      }
      let token = randomToken();
      for (let attempt = 1; entries.has(token); attempt += 1) {
        if (attempt >= COLLISION_ATTEMPTS) {
          // Stryker disable next-line StringLiteral: same — the contract is code:"busy"; wording is not asserted.
          throw new HrError("busy", "批注令牌签发冲突，请稍后重试");
        }
        token = randomToken();
      }
      entries.set(token, { cap, docName, expiresAt: nowMs + ANNOTATE_TOKEN_TTL_MS });
      return token;
    },
    consume: (cap, docName, token) => {
      const entry = entries.get(token);
      // Every consume wipes it: a probe with a wrong cap or wrong doc burns
      // the real token as a side effect — the answer is always "plain
      // document", so the attacker cannot even tell a hit happened.
      if (entry === undefined) return false;
      entries.delete(token);
      return (
        entry.expiresAt > clock.now().getTime() && entry.cap === cap && entry.docName === docName
      );
    },
  };
};

/** A fresh 128-bit nonce per response: the CSP admits the injected script by it, and reuse would defeat the point of rotating it. */
export const annotateNonce = (): string => randomBytes(RANDOM_BYTES).toString("base64url");

/**
 * Where `<script>` lands: right after the doctype; byte 0 when there is none.
 * Ahead of every page tag, dangling markup cannot capture the nonce; after
 * the doctype, no quirks mode is introduced. parse5 reports `#documentType`
 * only at the document top level — when a BOM or body text squeezes it into
 * character data it never appears, and that means "no doctype".
 */
const doctypeEndOf = (html: string): number => {
  const document = parse5(html, { sourceCodeLocationInfo: true });
  for (const node of document.childNodes) {
    if (node.nodeName === "#documentType") {
      // A real node under `sourceCodeLocationInfo` always has a range; `?? 0` is slack for the type, never taken.
      // Stryker disable next-line ConditionalExpression,OptionalChaining: equivalent mutation — a located #documentType always has endOffset.
      /* v8 ignore next */ return node.sourceCodeLocation?.endOffset ?? 0;
    }
  }
  return 0;
};

/** The injected tag's exact shape (frozen contract): the nonce/src/defer trio, spliced into the response bytes verbatim. */
export const annotatorTagOf = (cap: string, nonce: string): string =>
  `<script nonce="${nonce}" src="/f/${cap}/${ANNOTATOR_NAME}" defer></script>`;

/** Only the response body changes — the on-disk file keeps every byte. */
export const injectAnnotator = (html: string, cap: string, nonce: string): string => {
  const at = doctypeEndOf(html);
  return `${html.slice(0, at)}${annotatorTagOf(cap, nonce)}${html.slice(at)}`;
};
