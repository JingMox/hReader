// 这层管：全部用户可见中文文案（以后 i18n 只改这一处）。代码标识符一律英文，文案不许散落在 widget 里。

export const COPY = {
  library: "书库",
  outline: "目录",
  sidenotes: "旁注",
  sidenotesEmpty: "本章有 0 条批注（M2.3 启用）",
  controlsTheme: "主题",
  controlsFocus: "专注",
  statusConnecting: "连接中…",
  statusLive: "已同步",
  statusReconnecting: "重连中…",
  statusOffline: "离线",
  shortcuts: "j/k 移动 · h 高亮 · c 旁注 · / 搜索 · Esc 关闭",
  searchDeferred: "搜索将在后续卡片启用",
  version: "v0.0.0",
} as const;
