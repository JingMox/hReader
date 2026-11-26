// 静态接线双向校验：模板、源码、样式是三个独立事实源，任何一侧改了而另一侧没跟上都必须在这里红。
// 规则按**元素性质**分层：零引用的静态标题/标签本来就不该有写点（不算缺陷），
// 但零引用的按钮/输入框/选择框一定是漏接线——这正是 `#hr-diff-accept` 那类死按钮能躲过“零引用即放行”的原因。
//
// ① `src` 引用的每个 id，必须在模板里且出现在 `REQUIRED_ANCHORS`（防止模板改名后源码指向空气）。
// ② `REQUIRED_ANCHORS` 里除 `CONTAINER_ANCHORS` 外的每条 id，必须有写点或事件绑定（防止清单自我认证）。
// ③ 模板里每个**交互元素**（button/input/select/textarea/a[href]，`<input type="hidden">` 不算——
//    用户根本看不见它）必须有绑定写点，或有 `disabled`/`aria-disabled` 声明（抓死控件）。
//    判据一句话：能看见 + 能点 + 没有 `disabled`/`aria-disabled` 声明 = 死控件。
//    声明是显式延期，不是放行：既没接线、又没让用户看见"它还不能用"的控件，就是缺陷。
// ④ `host.cls` 挂的每个类名必须在 `styles.css` 里有规则（抓“挂 class 但没人画”）。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTAINER_ANCHORS, REQUIRED_ANCHORS } from "../src/anchors.ts";

const APP_DIR = join(import.meta.dirname, "..");
const SRC_DIR = join(APP_DIR, "src");
const TEMPLATE = readFileSync(join(APP_DIR, "static/index.html"), "utf8");
const STYLES = readFileSync(join(APP_DIR, "static/styles.css"), "utf8");

/** 递归收集 src 下的 .ts：源码侧的事实只认这些文件，测试自己不算。 */
const sourceFilesOf = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesOf(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

const SOURCE = sourceFilesOf(SRC_DIR)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const idsIn = (text: string): readonly string[] =>
  [...text.matchAll(/#hr-[\w-]+/g)].map((match) => match[0]);

const templateIds = new Set(
  [...TEMPLATE.matchAll(/\bid="(hr-[\w-]+)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [`#${match[1]}`],
  ),
);

/** 选择器常量：源码里 `const ROOT = "#hr-root"` 这种间接写法也得算“有写点”。 */
const namedSelectors = new Map(
  [...SOURCE.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*("[^"]*"|`[^`]*`);/g)].flatMap((match) =>
    match[1] === undefined || match[2] === undefined ? [] : [[match[1], idsIn(match[2])] as const],
  ),
);

/** `host.<写操作>(` 的首参：字面量（模板字符串／双引号）或指向字面量的常量名。 */
const boundIds = new Set(
  [
    ...SOURCE.matchAll(
      /host\.(?:on|text|children|attr|cls)\(\s*(?:"([^"]*)"|`([^`]*)`|([A-Z][A-Z0-9_]*))/g,
    ),
  ].flatMap((match) => {
    const literal = match[1] ?? match[2];
    const own = literal === undefined ? [] : idsIn(literal);
    // `${ROOT} #hr-notes` 这种“容器作前缀”也是真写点：容器本身不需要被单独写。
    const interpolated = (literal ?? "").matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g);
    return [
      ...own,
      ...[...interpolated].flatMap((piece) =>
        piece[1] === undefined ? [] : (namedSelectors.get(piece[1]) ?? []),
      ),
      ...(match[3] === undefined ? [] : (namedSelectors.get(match[3]) ?? [])),
    ];
  }),
);

const referencedIds = new Set(idsIn(SOURCE));

interface TemplateTag {
  readonly attrs: string;
  readonly id: string | undefined;
  readonly tag: string;
}

const tagsOf = (html: string): readonly TemplateTag[] =>
  [...html.matchAll(/<([a-z][a-z0-9]*)([^>]*)>/g)].map((match) => ({
    tag: match[1] ?? "",
    attrs: match[2] ?? "",
    id: /\bid="([^"]+)"/.exec(match[2] ?? "")?.[1],
  }));

const INTERACTIVE_TAGS: readonly string[] = ["button", "input", "select", "textarea"];

/** `<input type="hidden">` 在标签层面是输入框，但对用户不存在：它压根不是交互控件，不进 ③。 */
const isHiddenInput = (tag: TemplateTag): boolean =>
  tag.tag === "input" && /\btype\s*=\s*["']?hidden/i.test(tag.attrs);

const isInteractive = (tag: TemplateTag): boolean =>
  (INTERACTIVE_TAGS.includes(tag.tag) && !isHiddenInput(tag)) ||
  (tag.tag === "a" && /\shref=/.test(tag.attrs));

/** `disabled` / `aria-disabled="true"` 是作者对"这个控件还没接线"的声明，算合格；
 *  没声明又没绑定的才算死控件。无障碍属性与视觉状态同等待遇：读屏用户读到的也是"不可用"。 */
const isDeferred = (tag: TemplateTag): boolean =>
  /\sdisabled(?:[\s=/>]|$)/.test(tag.attrs) || /\baria-disabled\s*=\s*["']?true/i.test(tag.attrs);

describe("静态接线 · 源码引用 → 模板 + 锚点清单", () => {
  it("should point every id the source references at a template element listed in REQUIRED_ANCHORS", () => {
    const violations = [...referencedIds].flatMap((id) => {
      const shared = REQUIRED_ANCHORS.includes(id);
      const inTemplate = templateIds.has(id);
      if (shared && inTemplate) return [];
      const reasons = [
        ...(inTemplate ? [] : ["模板里没有"]),
        ...(shared ? [] : ["缺 REQUIRED_ANCHORS 条目"]),
      ];
      return [`${id}: ${reasons.join(" + ")}`];
    });

    expect(violations).toEqual([]);
  });
});

describe("静态接线 · 锚点清单 → 写点", () => {
  it("should give every non-container REQUIRED_ANCHORS entry a host write point or event binding", () => {
    const unbound = REQUIRED_ANCHORS.filter((id) => !CONTAINER_ANCHORS.includes(id))
      .filter((id) => !boundIds.has(id) || !templateIds.has(id))
      .map((id) => (templateIds.has(id) ? `${id}: 无 host 写点` : `${id}: 模板里没有`));

    expect(unbound).toEqual([]);
  });
});

describe("静态接线 · 交互元素 → 绑定写点", () => {
  it("should bind every interactive template element to a host write point", () => {
    const dead = tagsOf(TEMPLATE)
      .filter(isInteractive)
      .filter((tag) => !isDeferred(tag))
      .flatMap((tag) => (tag.id !== undefined && boundIds.has(`#${tag.id}`) ? [] : [tag]))
      .map(
        (tag) => `<${tag.tag} id="${tag.id ?? "<无 id>"}">: 无 host 绑定且未 disabled（死控件）`,
      );

    expect(dead).toEqual([]);
  });
});

describe("静态接线 · host.cls 类名 ↔ styles.css", () => {
  it("should style every class the source toggles", () => {
    const namedClasses = new Map(
      [...SOURCE.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)].flatMap((match) =>
        match[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]] as const],
      ),
    );
    const classNames = [
      ...SOURCE.matchAll(/host\.cls\([\s\S]{0,200}?,\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/g),
    ].flatMap((match) => {
      const literal = match[1];
      const resolved = match[2] === undefined ? undefined : namedClasses.get(match[2]);
      return literal ?? resolved ?? [];
    });
    const missing = classNames.filter((name) => !STYLES.includes(`.${name}`));

    expect([...new Set(missing)]).toEqual([]);
  });
});
