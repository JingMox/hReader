// 这层管：假宿主——只按 `HostContext` 的三个方法记账，不做真实实现（不碰真 SystemPrompt）。

import type { HostContext, HreaderPromptSection } from "../src";

interface FakeHost {
  readonly ctx: HostContext;
  /** 当前活着的 section（名字 → section），dispose 后应为空。 */
  readonly sections: Map<string, HreaderPromptSection>;
  /** 当前暴露的服务（名字 → 值），dispose 后应为空。 */
  readonly services: Map<string, unknown>;
  /** 跑掉所有已注册的清理器（等价于宿主卸载本插件）。 */
  disposeAll: () => Promise<void>;
}

/**
 * 重复注册同名 section 会抛错：真 `SystemPrompt.section` 就是这个语义，
 * 假宿主照抄它，"重复 apply 只留一个 section" 这条才有分辨力。
 */
export const fakeHostOf = (): FakeHost => {
  const sections = new Map<string, HreaderPromptSection>();
  const services = new Map<string, unknown>();
  const disposers: (() => void)[] = [];

  const disposeAll = (): Promise<void> => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    return Promise.resolve();
  };

  const ctx: HostContext = {
    systemPrompt: {
      section: (section) => {
        if (sections.has(section.name)) throw new Error(`同名 section 重复注册：${section.name}`);
        sections.set(section.name, section);
        return () => {
          sections.delete(section.name);
        };
      },
    },
    provide: (name, value) => {
      services.set(name, value);
      return () => {
        services.delete(name);
      };
    },
    effect: (execute) => {
      disposers.push(execute());
      return disposeAll;
    },
  };

  return { ctx, sections, services, disposeAll };
};
