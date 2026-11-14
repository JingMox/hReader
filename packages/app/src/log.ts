// 这层管：诊断出口（`console.error` 的唯一落点）。`no-console` 是硬规则，所以只在此文件出现一次。

declare const globalThis: { readonly console?: { readonly error: (message: string) => void } };

export const errorLogger = (message: string): void => {
  globalThis.console?.error(message);
};
