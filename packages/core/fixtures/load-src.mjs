// 这层管：让子进程夹具能加载 TS 源码（Node 只剥类型，不补无扩展名的相对导入）。
// 子进程夹具必须跑真源码：拿一份重写的实现去测原子写，等于自己测自己。

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const TS_EXTENSION = /\.[cm]?[jt]sx?$/u;

let hooksRegistered = false;

const CANDIDATES = [".ts", "/index.ts"];

const relativeToTs = (specifier, parentUrl) => {
  if (parentUrl === undefined || !specifier.startsWith(".")) return undefined;
  if (TS_EXTENSION.test(specifier)) return undefined;
  for (const suffix of CANDIDATES) {
    const candidate = new URL(`${specifier}${suffix}`, parentUrl);
    if (existsSync(candidate)) return candidate.href;
  }
  return undefined;
};

const registerTsResolution = () => {
  if (hooksRegistered) return;
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const url = relativeToTs(specifier, context.parentURL);
      return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true };
    },
  });
  hooksRegistered = true;
};

/** `path` 相对本文件（`fixtures/`）解析；返回源码模块。 */
export const loadSrc = (path) => {
  registerTsResolution();
  return import(new URL(path, import.meta.url).href);
};
