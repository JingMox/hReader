// 这层管：`--help` 文本的单一来源（根目录 + 每条命令一段）；不做解析、不格式化结果。

export const COMMAND_NAMES = ["outline", "read", "patch", "style", "undo", "serve"] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

const NAMES: readonly string[] = COMMAND_NAMES;

export const isCommandName = (value: string | undefined): value is CommandName =>
  value !== undefined && NAMES.includes(value);

const COMMON = [
  "  --json              stdout 只输出单行 JSON（无缩进、无尾随空格）",
  "  --workspace <dir>   路径安全边界（默认当前目录；patch/style --visual 用）",
  "  --help              显示帮助",
];

const SYNOPSIS = [
  "hr outline <file> [--json]",
  "hr read <file> <nodeId|selector> [--json] [--max-bytes <n>]",
  "hr patch <file> <nodeId> --action <replace|insert_before|insert_after|append|delete>",
  "         (--html <s> | --html-file <p> | --html-stdin) [--json]",
  "hr style <file> (--visual <id> | --tone <id> | --lint) [--json]",
  "hr style extract <file...> [--id <id>] [--name <名字>] [--out <path>] [--no-llm] [--json]",
  "hr undo <file> [--json]",
  "hr serve <file> [--port <n>] [--allow-host <h>] [--app-dir <dir>] [--json]",
  "hr --help | hr <cmd> --help",
];

const SECTIONS: Readonly<Record<CommandName, readonly string[]>> = {
  outline: [
    "用法：hr outline <file> [--json]",
    "",
    "  打印 <article> 的缩进大纲（JSON 时输出 Outline 原样）。",
  ],
  read: [
    "用法：hr read <file> <nodeId|selector> [--json] [--max-bytes <n>]",
    "",
    "  --max-bytes <n>      子树字节上限（正整数，≤ 10000000；默认 65536）",
    "  第二个参数先按选择器解析；不命中时按 node id（data-hr-id）再试一次；",
    "  同名的标签优先（`read div` 读的是 <div> 标签，不是 id 为 div 的节点）。",
    "  打印目标节点的 HTML 原文；JSON 时为 { html, ids }（ids 只列返回的 html 里出现的）。",
  ],
  patch: [
    "用法：hr patch <file> <nodeId> --action <action> (--html <s> | --html-file <p> | --html-stdin) [--json]",
    "",
    "  --action <action>    replace | insert_before | insert_after | append | delete",
    "  --html <s>           片段字面量",
    "  --html-file <p>      从文件读片段（严格 UTF-8）",
    "  --html-stdin         从 stdin 读片段（空 stdin 为用法错误）",
    "  delete 不接受任何 --html* 来源。",
  ],
  style: [
    "用法：hr style <file> (--visual <id> | --tone <id> | --lint) [--json]",
    "      hr style extract <file...> [--id <id>] [--name <名字>] [--out <path>] [--json]",
    "",
    "  --visual <id>        把主题写进文档（只替换 style 内部）",
    "  --tone <id>          打印该风格编译后的 prompt",
    "  --lint               用默认风格的禁用词表检查文档",
    "",
    "  extract：从 1..N 篇 .md/.html 语料统计出 style.yaml。",
    "  --id <id>            风格 id（默认取首篇文件名 slug）",
    "  --name <名字>        显示名（默认同 id）",
    "  --out <path>         写到文件（默认打印到 stdout）；已存在需 --force",
    "  --inherits-visual <id>  视觉继承的主题 id（默认内置风格）",
    "  --no-llm             强制纯统计版（无 key 时也自动走这里）",
  ],
  undo: [
    "用法：hr undo <file> [--json]",
    "",
    "  恢复到最近一份历史快照（与批注/样式/patch 共用同一条快照链）；",
    "  没有历史时报 nothing_to_undo（退出码非 0）。",
  ],
  serve: [
    "用法：hr serve <file> [--port <n>] [--allow-host <h>] [--app-dir <dir>] [--json]",
    "  --allow-host <h>  可重复/逗号分隔；缺省 127.0.0.1:<port> 与 localhost:<port>",
    "  --app-dir <dir>   构建产物目录（index.html + assets/）；缺省 packages/app/dist",
    "",
    "  --port <n>           监听端口（0 = 系统分配，默认 0）",
    "  起本地 daemon 并在 stdout 打印一行（JSON 时为 { port, token, pid, workspace }）；",
    "  SIGTERM/SIGINT 关闭并删除 ~/.hreader/daemon.json。",
  ],
};

const sectionText = (topic: CommandName): string => SECTIONS[topic].join("\n");

export const usageText = (topic: CommandName | undefined): string => {
  const head = [
    "hReader CLI",
    "",
    "用法：",
    ...SYNOPSIS.map((line) => `  ${line}`),
    "",
    "通用选项：",
    ...COMMON,
  ];
  const body = topic === undefined ? [] : ["", sectionText(topic)];
  return [...head, ...body, ""].join("\n");
};
