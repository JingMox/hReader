// 外部输入（HTTP 请求体、meta、daemon.json、LLM 响应）共用的 zod 零件。

import { z } from "zod";

/** `JSON.parse` 失败返回 `undefined`：调用方再交给 zod 判形状，两种失败走同一条"不合法"路径。 */
export const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
};

/**
 * 顶层必须是对象：数组与 null 都不算。用 `custom` 而不是 `z.record`：后者会拷贝并静默丢掉 `__proto__` 键，
 * 而"出现了不认识的键"恰恰是调用方要报告的信息。
 */
export const jsonObject = z.custom<Readonly<Record<string, unknown>>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

export const jsonArray = z.array(z.unknown());

/** 宽松字符串：类型不对按"没给"处理，由调用方决定缺省值；用于容错读取旧数据。 */
export const looseString = z.string().optional().catch(undefined);
