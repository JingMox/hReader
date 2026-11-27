// 这层管：UI 模板必须有的锚点清单。
// "函数存在 ≠ 路径可达"——`boot` 挂载后逐条核对，缺一个就**可见地失败**（状态栏 + console.error），
// 绝不允许静默跳过：模板少一个 id，整条交互链就是死码。

import type { Host } from "./dom.ts";

export const REQUIRED_ANCHORS: readonly string[] = [
  // 骨架
  "#hr-root",
  // 左栏（书库）：标题 / 搜索 / 目录
  "#hr-library",
  "#hr-lib-title",
  "#hr-search",
  "#hr-toc-title",
  "#hr-toc",
  // 中栏（正文 + 控制条）：主题样式表 / 控制条标签 / 正文
  "#hr-theme",
  "#hr-canvas",
  "#hr-controls",
  "#hr-theme-label",
  "#hr-theme-select",
  "#hr-focus-label",
  "#hr-doc",
  // 外来/未规范化文档：横幅（文案 / 动作 / 错误）+ iframe 承载
  "#hr-foreign",
  "#hr-foreign-text",
  "#hr-foreign-action",
  "#hr-foreign-error",
  "#hr-foreign-frame",
  // 外来批注：横幅开关 + 选区浮层（草稿 / 只读 / 提示 / 两钮）
  "#hr-annotate-btn",
  "#hr-annotate-pop",
  "#hr-annotate-draft",
  "#hr-annotate-view",
  "#hr-annotate-hint",
  "#hr-annotate-actions",
  "#hr-annotate-save",
  "#hr-annotate-cancel",
  // 演示模式：入口按钮 / 覆盖层容器 / 页码 / 退出
  "#hr-present-btn",
  "#hr-present",
  "#hr-present-pager",
  "#hr-present-exit",
  // 右栏（旁注）：标题 / 选区按钮 / 编辑器 / 提示 / 两组 / diff
  "#hr-notes",
  "#hr-notes-title",
  "#hr-notes-actions",
  "#hr-note-btn",
  "#hr-note-editor",
  "#hr-note-draft",
  "#hr-note-error",
  "#hr-note-submit",
  "#hr-note-cancel",
  "#hr-notes-pending",
  "#hr-notes-resolved",
  "#hr-notes-body",
  "#hr-diff",
  "#hr-diff-chunks",
  "#hr-diff-status",
  // 底部状态栏：连接 / 版本 / 外来权限开关 / 沉浸入口 / 快捷键 / `/` 的可见提示
  "#hr-statusbar",
  "#hr-conn",
  "#hr-version",
  "#hr-perms",
  "#hr-perm-scripts",
  "#hr-perm-network",
  "#hr-immersive-btn",
  "#hr-shortcuts",
  "#hr-hint",
  // 沉浸模式的兜底出口（顶边热区按钮；iframe 拿焦吃掉 Esc/i 时的唯一退路）
  "#hr-immersive-exit",
];

/** 只被容器语义使用的锚点：内容由子元素或服务端渲染填充，JS 不直接写它们。
 *  它们仍必须在模板中存在，但不参与"必须有写点"检查。
 *
 *  与 `REQUIRED_ANCHORS` 一体两面，因此和它同源（`wiring-static.test.ts` 也从这里取）。
 *
 *  `#hr-search` **不在**这里：它只是尚未接线，不是容器。`disabled` 让它不算交互元素，
 *  而写点检查仍盯着它（`boot` 把延期文案写进它的 `title`，是真写点）；接线那天两条规则一起松口。 */
export const CONTAINER_ANCHORS: readonly string[] = [
  "#hr-root",
  "#hr-library",
  "#hr-canvas",
  "#hr-controls",
  "#hr-notes-actions",
  "#hr-present",
  "#hr-annotate-actions",
];

/** 缺失的锚点（空数组 = 模板完整）；`host.has` 缺失时（假 host）不做检查，返回空清单。 */
export const missingAnchorsOf = (host: Pick<Host, "has">): readonly string[] => {
  const probe = host.has;
  if (probe === undefined) return [];
  // 假 host 的 `has` 可能对某些选择器抛错（测试显式覆盖这一面）：抛错视为"未知"，不算缺失。
  const missing = (selector: string): boolean => {
    try {
      return !probe(selector);
    } catch {
      return false;
    }
  };
  return REQUIRED_ANCHORS.filter(missing);
};

/** 同一组缺失只报一次（每个进程一次），避免测试里每次 boot 都刷屏。 */
let reported: string | undefined;

export const reportMissingAnchors = (
  host: Pick<Host, "text">,
  logger: (message: string) => void,
  missing: readonly string[],
): void => {
  if (missing.length === 0) return;
  const message = `UI 模板缺锚点: ${missing.join(", ")}`;
  if (reported === message) return;
  reported = message;
  logger(message);
  host.text("#hr-statusbar", message);
};
