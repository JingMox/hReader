// 这层管：批注模式的纯判定件——一次性批注令牌簿（TTL/绑定/容量上限）与
// `<script nonce>` 注入点定位（parse5 源码区间）。不碰 HTTP、不读文件。

import { randomBytes } from "node:crypto";

import { parse as parse5 } from "parse5";

import { HrError } from "../hr-error";
import type { Clock } from "../io/ports";

/** 批注令牌/nonce：128-bit 随机 → base64url（22 字符），只活在本进程内存里。 */
const RANDOM_BYTES = 16;

/** 从签发算起的服务窗口：只为一次 iframe 导航而活，过期即死。 */
export const ANNOTATE_TOKEN_TTL_MS = 60_000;

/** 同时存活的令牌上限：批注是低频用户动作，四位数的书足够宽。 */
export const ANNOTATE_TOKEN_LIMIT = 1_000;

/** 注入 `<script>` 指向的保留资源名：/f/ 路由上优先生效，目录内同名文件不可达。 */
export const ANNOTATOR_NAME = "__hr_annotator.js";

interface TokenEntry {
  readonly cap: string;
  readonly docName: string;
  readonly expiresAt: number;
}

export interface AnnotateTokenBook {
  /**
   * 为 (cap, docName) 签发令牌；先清过期再查容量，超限拒绝（`busy`：等 TTL 自然回收即可）。
   * 极小概率的随机撞号重抽有限次——撞上的旧令牌绝不被静默改绑。
   */
  readonly mint: (cap: string, docName: string) => string;
  /**
   * 单次核销：查到即删（无论对错都烧掉），再按"未过期 ∧ cap/docName 全对上"给结论。
   * 一切失败都是同一个 `false`——过期、伪造、错文档不可区分，不给探测口。
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
        // Stryker disable next-line StringLiteral: 测试契约锁 code 不锁文案——中文提示随口味改，等价。
        throw new HrError("busy", "批注令牌签发过于频繁，请稍后重试");
      }
      let token = randomToken();
      for (let attempt = 1; entries.has(token); attempt += 1) {
        if (attempt >= COLLISION_ATTEMPTS) {
          // Stryker disable next-line StringLiteral: 同上——契约是 code:"busy"，文案不进断言。
          throw new HrError("busy", "批注令牌签发冲突，请稍后重试");
        }
        token = randomToken();
      }
      entries.set(token, { cap, docName, expiresAt: nowMs + ANNOTATE_TOKEN_TTL_MS });
      return token;
    },
    consume: (cap, docName, token) => {
      const entry = entries.get(token);
      // 任何一次核销都把它抹掉：错 cap/错文档的试探顺手把真令牌也烧掉——
      // 响应只有一个"普通文档"，攻击者连"猜中过"都无从得知。
      if (entry === undefined) return false;
      entries.delete(token);
      return (
        entry.expiresAt > clock.now().getTime() && entry.cap === cap && entry.docName === docName
      );
    },
  };
};

/** 每次响应一枚新的 128-bit nonce：CSP 凭它放行注入脚本，复用会让"换 nonce"失去意义。 */
export const annotateNonce = (): string => randomBytes(RANDOM_BYTES).toString("base64url");

/**
 * `<script>` 的落点：doctype 之后；没有 doctype 就是字节 0。
 * 落在任何页面标记之前，悬垂标记（dangling markup）无从吞掉 nonce；
 * doctype 之后，不引入 quirks。parse5 只在文档顶层报告 `#documentType`——
 * BOM 或正文把 doctype 挤成文本时它不会出现，那就是"没有 doctype"。
 */
const doctypeEndOf = (html: string): number => {
  const document = parse5(html, { sourceCodeLocationInfo: true });
  for (const node of document.childNodes) {
    if (node.nodeName === "#documentType") {
      // `sourceCodeLocationInfo` 开着的实节点必有区间；`?? 0` 只是类型的余量，跑不到。
      // Stryker disable next-line ConditionalExpression,OptionalChaining: 等价变异——带位置的 #documentType 必有 endOffset。
      /* v8 ignore next */ return node.sourceCodeLocation?.endOffset ?? 0;
    }
  }
  return 0;
};

/** 注入标签的精确形状（冻结契约）：nonce/src/defer 三件套，原样插进响应字节。 */
export const annotatorTagOf = (cap: string, nonce: string): string =>
  `<script nonce="${nonce}" src="/f/${cap}/${ANNOTATOR_NAME}" defer></script>`;

/** 只改返回体——落盘文件一个字母不动。 */
export const injectAnnotator = (html: string, cap: string, nonce: string): string => {
  const at = doctypeEndOf(html);
  return `${html.slice(0, at)}${annotatorTagOf(cap, nonce)}${html.slice(at)}`;
};
