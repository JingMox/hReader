// 对抗面：foreign iframe 的 sandbox 必须先于 src 落位。
// 静态 index.html 的 <iframe id="hr-foreign-frame"> 不自带 sandbox——第一次 src 导航若
// 抢在 sandbox 设值前提交，外来文档就以**无沙箱**的同源页面加载一轮（读 cookie、同源 fetch）。
// 同一任务里先 src 后 sandbox 在主流浏览器上通常仍被沙箱化（沙箱标志在导航提交时采样），
// 但这是规范灰区；bfcache 恢复/元素复用路径上顺序就是生死。钉死顺序，不赌时序。

import { describe, expect, it } from "vitest";

import { mountForeign, type ForeignDeps } from "../src/widgets/foreign.ts";
import { createFakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const FRAME = `${ROOT} #hr-foreign-frame`;

const depsOf = (host: ReturnType<typeof createFakeHost>["host"]): ForeignDeps => ({
  host,
  parent: ROOT,
  docId: "doc.html",
  info: { cls: "foreign", trust: "off", scripts: true },
  setTrust: (level) => Promise.resolve(level),
  normalize: () => Promise.resolve(),
  theme: undefined,
});

describe("foreign · sandbox/src 落位顺序", () => {
  it("should set the sandbox attribute before the first src navigation", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake.host));

    const calls = fake.calls.filter((call) => call.op === "attr" && call.args[0] === FRAME);
    const sandboxAt = calls.findIndex((call) => call.args[1] === "sandbox");
    const srcAt = calls.findIndex((call) => call.args[1] === "src");

    expect(srcAt).toBeGreaterThanOrEqual(0);
    expect(sandboxAt).toBeGreaterThanOrEqual(0);
    expect(sandboxAt).toBeLessThan(srcAt);
  });
});
