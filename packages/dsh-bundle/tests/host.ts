// Fake host: only books the three `HostContext` methods, no real implementation (no real SystemPrompt).

import type { HostContext, HreaderPromptSection } from "../src";

interface FakeHost {
  readonly ctx: HostContext;
  /** Live sections (name → section); should be empty after dispose. */
  readonly sections: Map<string, HreaderPromptSection>;
  /** Exposed services (name → value); should be empty after dispose. */
  readonly services: Map<string, unknown>;
  /** Runs all registered disposers (equivalent to the host unloading the plugin). */
  disposeAll: () => Promise<void>;
}

/**
 * Re-registering a same-named section throws: the real `SystemPrompt.section` behaves this way, and
 * the fake host copies it so that "repeat apply leaves only one section" stays discriminating.
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
