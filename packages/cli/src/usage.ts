// 这层管：`--help` 文本的单一来源（根目录 + 每条命令一段）；不做解析、不格式化结果。

export const COMMAND_NAMES = [
  "new",
  "normalize",
  "outline",
  "read",
  "patch",
  "check",
  "style",
  "undo",
  "export",
  "pdf",
  "png",
  "serve",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

const NAMES: readonly string[] = COMMAND_NAMES;

export const isCommandName = (value: string | undefined): value is CommandName =>
  value !== undefined && NAMES.includes(value);

const COMMON = [
  "  --json              stdout 只输出单行 JSON（无缩进、无尾随空格）",
  "  --workspace <dir>   路径安全边界（默认当前目录；写命令按它算相对路径）",
  "  --help              显示帮助",
];

const SYNOPSIS = [
  "hr new <file> [--kind note|report|minutes|brief|slides] [--title <标题>] [--visual <id>] [--force] [--json]",
  "hr normalize <file> [--write] [--json]",
  "hr outline <file> [--json]",
  "hr read <file> <nodeId|selector> [--json] [--max-bytes <n>]",
  "hr patch <file> <nodeId|selector> --action <replace|insert_before|insert_after|append|delete>",
  "         (--html <s> | --html-file <p> | --html-stdin) [--json]",
  "hr check <file> [--json]",
  "hr style <file> (--visual <id> | --tone <id> | --lint) [--json]",
  "hr style extract <file...> [--id <id>] [--name <名字>] [--out <path>] [--no-llm] [--json]",
  "hr undo <file> [--json]",
  "hr export <file> [--visual <id>] [--out <path>] [--force] [--json]",
  "hr pdf <file> --out <path> [--page-size a4|letter|a5] [--no-outline] [--timeout <1..600>] [--force] [--json]",
  "hr png <file> --out <path> [--width 256..4096] [--scale 1..3] [--max-height 1000..50000] [--json]",
  "hr serve <file> [--port <n>] [--allow-host <h>] [--app-dir <dir>] [--home <dir>]",
  "         [--exit-with-parent] [--json]",
  "hr --help | hr <cmd> --help",
];

const SECTIONS: Readonly<Record<CommandName, readonly string[]>> = {
  new: [
    "用法：hr new <file> [--kind <形态>] [--title <标题>] [--visual <id>] [--force] [--json]",
    "",
    "  --kind <形态>   note 笔记（默认）| report 报告 | minutes 会议纪要 | brief 决策简报 | slides 幻灯片",
    "  --title <标题>  写进 <title> 与 <h1>（默认取文件名）",
    "  --visual <id>   视觉主题（默认内置主题）",
    "  --force         <file> 已存在时覆盖（缺省报 file_exists）",
    "",
    "  按形态写一份带齐 data-hr-id、已套主题的起稿骨架：占位文字写在全角括号里，逐块 patch 掉即可。",
    "  slides 形态每个顶层 <section> 是一页：浏览器里滚动即翻页，打印是横版一页一张。",
    "  JSON 时为 { path, kind, title, bytes }。",
  ],
  normalize: [
    "用法：hr normalize <file> [--write] [--json]",
    "",
    "  --write  原地写回（临时文件 + rename）；已有 data-hr-id 一字不动，再跑一次什么也不变",
    "",
    "  给缺 data-hr-id 的文档补上稳定 id（同一输入永远同一批 id；内容寻址，不含时间/随机/路径）。",
    "  不带 --write 时把规范化结果打印到 stdout；JSON 时为 { needsNormalize, html, injected }。",
    "  文档里没有 <article> 时报 invalid_document（退出码 1）。",
    "  outline / read / patch / serve 遇到缺 id 的文档会直接报 needs_normalize（退出码 2）并指向本命令。",
  ],
  outline: [
    "用法：hr outline <file> [--json]",
    "",
    "  打印 <article> 的缩进大纲（JSON 时输出 Outline 原样）。",
    "  一份标题都没有时不静默：输出（没有标题）并给出可直接粘的 `hr read <file> <nodeId|selector>`。",
  ],
  read: [
    "用法：hr read <file> <nodeId|selector> [--json] [--max-bytes <n>]",
    "",
    "  --max-bytes <n>      子树字节上限（正整数，≤ 10000000；默认 65536）",
    "  第二个参数先按选择器解析；不命中时按 node id（data-hr-id）再试一次；",
    "  两种解释都成立时（串既是选择器、又撞上同名 data-hr-id）不猜：报 invalid_selector",
    '  （reason: ambiguous），改用 #id 或 [data-hr-id="…"] 指定。',
    "  打印目标节点的 HTML 原文；JSON 时为 { html, ids }（ids 只列返回的 html 里出现的）。",
  ],
  patch: [
    "用法：hr patch <file> <nodeId|selector> --action <action> (--html <s> | --html-file <p> | --html-stdin) [--json]",
    "",
    "  第二个参数与 hr read 同一解析器（先选择器、再 node id）。",
    "  选择器命中多个可寻址元素时不猜：报 invalid_selector（reason: ambiguous，附前 5 个 id）。",
    '  同一串既是选择器、又撞上同名 data-hr-id 时也不猜（同上）：改用 #id 或 [data-hr-id="…"]。',
    "",
    "  --action <action>    replace | insert_before | insert_after | append | delete",
    "  --html <s>           片段字面量",
    "  --html-file <p>      从文件读片段（严格 UTF-8）",
    "  --html-stdin         从 stdin 读片段（空 stdin 为用法错误）",
    "  delete 不接受任何 --html* 来源。",
  ],
  check: [
    "用法：hr check <file> [--json]",
    "",
    "  检查文档是否守住排版约束：组件名在白名单内、组件结构完整（根标签 / 子元素个数 / 必备子元素）、",
    "  没有内联 style，外加文档级诊断（重复 id、标题跳级等）。只读，不改文件。",
    "  每条一行 `<severity>: <code> — <message>`；JSON 时为 { issues, count }。",
    "  同一套检查在 hr patch 写入时也会跑：片段照常落盘，问题随回执的 warnings 给出。",
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
    "  --model <id>         覆盖模型（默认 deepseek-v4.1-flash）",
    "  --base-url <url>     覆盖网关地址（默认 https://opencode.ai/zen/go/v1）",
  ],
  undo: [
    "用法：hr undo <file> [--json]",
    "",
    "  恢复到最近一份历史快照（与批注/样式/patch 共用同一条快照链）；",
    "  没有历史时报 nothing_to_undo（退出码非 0）。",
  ],
  export: [
    "用法：hr export <file> [--visual <id>] [--out <path>] [--force] [--json]",
    "",
    "  --visual <id>  视觉主题（默认内置主题）；主题必须离线自足",
    "  --out <path>   写单文件打印稿（默认打印到 stdout）；必须在 --workspace 内",
    "  --force        --out 已存在时覆盖（缺省报 file_exists）",
    "",
    "  产物是自带 CSS 的单文件 HTML：封面 + 目录 + 正文；`--json` 时为",
    "  { html, bytes, droppedImages, out }（无 --out 时 out 为 null）。",
    "  被移除的外部图片数 > 0 时在 stderr 提示一行。",
    "",
    "  上限：打印稿 4 MiB（4194304 字节，按 UTF-8 计）——超了报 invalid_input 并给出",
    "  实际字节数；按章拆分文档、单篇控制在 4 MiB 以内再导出。",
  ],
  pdf: [
    "用法：hr pdf <file> --out <path> [--page-size a4|letter|a5] [--no-outline] [--timeout <1..600>] [--force] [--json]",
    "",
    "  --out <path>         写 PDF（必填；必须在 --workspace 内）；已存在需 --force",
    "  --page-size <size>   a4 | letter | a5（默认 a4）",
    "  --outline            产物带大纲/书签（默认开；h1–h6 成树，标题就是打印稿的 heading 文本）",
    "  --no-outline         不出大纲；与 --outline 不可同传",
    "  --timeout <sec>      渲染上限 1..600 秒（默认 60；到点先 SIGTERM，2s 后 SIGKILL）",
    "",
    "  走本机 Chrome（HREADER_CHROME 可覆盖，缺省探测三个标准路径）；`--json` 时为",
    "  { pdf, bytes, pages, outline, out }（pdf 为 base64，outline 为打印稿 heading 数）。Chrome 缺失/起不来/渲染报错/超时/空产物分别报",
    "  chrome_missing / chrome_failed / render_timeout / render_empty（均 exit 3）。",
  ],
  png: [
    "用法：hr png <file> --out <path> [--width 256..4096] [--scale 1..3] [--max-height 1000..50000] [--timeout <1..600>] [--force] [--json]",
    "",
    "  --out <path>         写 PNG（必填；必须在 --workspace 内）；已存在需 --force",
    "  --width <px>         CSS 像素宽 256..4096（默认 1200）",
    "  --scale <n>          设备像素倍率 1..3（默认 2）；产物宽高 = CSS 尺寸 × n",
    "  --max-height <px>    整页高度上限 1000..50000（默认 20000；超出先裁不缩，结果置 clipped）",
    "  --timeout <sec>      渲染上限 1..600 秒（默认 60）",
    "",
    "  按整页高截一张长图（同一套 Chrome 生命周期与 --out 规矩）；`--json` 时为",
    "  { png, bytes, width, height, clipped, out }（png 为 base64，宽高是设备像素）。",
  ],
  serve: [
    "用法：hr serve <file> [--port <n>] [--allow-host <h>] [--app-dir <dir>] [--home <dir>]",
    "         [--exit-with-parent] [--json]",
    "  --allow-host <h>  可重复/逗号分隔；缺省 127.0.0.1:<port> 与 localhost:<port>",
    "  --app-dir <dir>   构建产物目录（index.html + assets/）；缺省 packages/app/dist",
    "  --home <dir>      daemon.json 的父目录（默认 $HOME）；必须已存在，用于隔离壳自己拉起的 daemon",
    "  --exit-with-parent 父进程消失（被 kill -9 / re-parent）时自己退出并删 daemon.json；",
    "                    默认关，只有桌面壳会传（它被 kill -9 时没人替它收尸）",
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
