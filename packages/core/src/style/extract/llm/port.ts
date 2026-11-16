// 这层管：LLM 边的形状与送模型的硬上限；不含实现、不碰网络（真实调用属于 CLI 侧适配层，F3）。

/**
 * 「一次补全」的全部能力面：core 只依赖这个接口，F3 用 `fetch` 实现它。
 * 放在这里也把 `fetch` 挡在 core 之外——本包是纯函数与数据，网络是适配层的职责。
 */
export interface LlmPort {
  readonly complete: (prompt: string) => Promise<string>;
}

/**
 * 送模型的语料上限（字节）：超出部分截断，并在 `dropped` 里记一条 `corpus/too_long`。
 * 与请求里的 `max_tokens: 2048` 同一个量级，防止一篇长文把单次调用撑成天价。
 */
export const PROMPT_MAX_CORPUS_BYTES = 64 * 1024;
