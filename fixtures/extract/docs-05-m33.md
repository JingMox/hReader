### M3.3 `@hreader/dsh-bundle` 使用节（host-only）

**装进宿主 profile**：本包不发布，装的是仓库里的目录，且 `--profile` 是**必填**选项（漏了 dsh 直接 usage 报错）：

```bash
pnpm -C packages/dsh-bundle build      # 产 dist/index.js（自包含）+ dist/index.d.ts
dsh plugin --profile <profile> add "$(pwd)/packages/dsh-bundle"
```

`pnpm smoke:dsh` 用新建的临时 `$DSH_HOME` + 固定 profile 名 `smoke` 跑同一件事（`--profile` 只收**名字**不是路径，profile 落在 `$DSH_HOME/profiles/smoke`，绝不碰用户 `~/.dsh`）；本机没装 `dsh` 时它 SKIP（不进 CI，SKIP 日志给出 `npm i -D @deepseek-ai/dsh@0.2.2-rc.1` 的装法）。**已用真 `@deepseek-ai/dsh@0.2.2-rc.1` 验过**：`dsh plugin --profile smoke add <包目录>` 退出码 0，`dsh --profile smoke --dump-config` 的合成树里逐字出现：

```yaml
# == @hreader/dsh-bundle
- id: hreader
  name: "@hreader/dsh-bundle"
```

三条断言（注释头 / `- id: hreader` / `name: '@hreader/dsh-bundle'`）各自独立 `check`，失败时贴 `--dump-config` 的尾巴。旧版“临时 profile 目录里出现插件名”的软断言已删：它扫描的目录在 `add` 非 0 时也可能已写进包名，是假绿来源。

**`workspace` 从哪来（四步）**：宿主 `Context` 上**没有**工作区字段——`@deepseek-ai/cordis` 的 `context.d.ts:23` 只有模块解析用的 `baseUrl`，`dsh-system-prompt` 的 d.ts 里 `cwd`/`workspace` 零命中。所以：

1. `config.workspace` 缺省 → 取宿主进程 `process.cwd()`，并往 **stderr** 打一行 `[hreader] config.workspace 未配置，使用宿主进程 cwd=<abs>`（用户有权知道 prompt 是按哪个目录的风格渲染的）；
2. 原始串含 `..` 段 → fail-fast（`resolve` 会把 `<repo>/../..` 静默改成仓库的父目录，`<workspace>/.hreader/style.yaml` 就跟着换人）；
3. 给了**相对路径** → 按 cwd 解析成绝对路径；
4. 给了但**不存在 / 不是目录** → fail-fast，错误文案点名 `config.workspace`（拼错的路径比 cwd 兜底更危险）。

**不要求 `workspace` 落在 cwd 之内**：本包只**读**风格文件、从不写盘（`writeFileSync|writeFile|mkdirSync|renameSync|unlink` 全文零命中），`workspace: "/tmp"` 因此合法；路径 containment 的守卫归 `packages/core/src/io/paths.ts:73-79`（写侧），本包不重复实现一遍。`tests/plugin.test.ts` 有一条名字写明这条理由的钉子用例。

随包的 `cordis.patch.yml` 里 `config: {}` 就是这个意思：开箱即用（按 cwd），想钉死工作区就填绝对路径。**不改随包 yaml 是设计要求**——"让用户手改依赖里的文件"是敌意设计。

**未知 `styleId`**：fail-fast，抛 `HrError`（code `unknown_style`），消息里列出当前可用 id（内置预设 + `<workspace>/styles/` 项目风格 + `~/.hreader/styles`）。不选"退默认风格 + warn"：prompt 里混进一个退了默认的风格，作者永远发现不了自己拼错。

**卸载语义**：注册全在 `ctx.effect(() => {...}, "hreader")` 里，dispose 时摘掉 section 与 `hreader` 服务；同一个 ctx 上重复 `apply` 先撤旧的（`WeakMap` 记账），宿主里始终只有一个 section。

**`order = 100` 的理由**：真常量表在 `@deepseek-ai/dsh-system-prompt@0.2.2-rc.1` 的 `lib/types/index.d.ts`：`HARNESS_IDENTITY = -1000`、`DEPLOYMENT_PERSONA_PREFIX = 0`、`PLAN_POLICY = 500`、`TOOL_BASH = 1000` 起是工具指引。语言规约是 persona 级指令，必须排在 persona 之后、policy 与工具指引之前 → 100。（旧版本文档写的 "`-100` identity / `100-199` tool guidance" 与真包不符，已被 M3.3 更正。）

**`styles` 与 `dist`**：`dsh` 从 profile 的 `node_modules` 加载插件，`exports` 指向 `.ts` 一定失败，故 `build` 产 `dist/index.js`（esbuild 把 `@hreader/core` 与 `yaml` 一起打进，`exports`/`main` 指向它）与 `dist/*.d.ts`（`declare module '@deepseek-ai/cordis'` 的合并要靠它才对使用方可见），并把仓库根 `styles/` 拷到 `dist/styles`（主题 CSS 无法打包）。`nodeStyleDeps().stylesRoot` 指向仓库布局，装进 profile 后路径会落到使用者目录树，故插件显式改写 `stylesRoot`（见 `src/index.ts` 的 `stylesRootOf`）。

**`dist/*.d.ts` 里没有裸依赖（对外形状一律本地镜像）**：G2-R1 指出"声明文件里一个裸 `import type` 就够使用方报 TS2307"，所以 `HreaderPromptSection` 在 `src/events.ts` 里本地重述（`name`/`order`/`text` 三个 readonly 字段），不 import `@deepseek-ai/dsh-system-prompt`；漂移由 `tests/drift.test-d.ts` 的双向/单向赋值盯着（官方改 `order` 类型、加/删字段都会红）。唯一的例外是 `src/events.ts` 里一行 `import type {} from "@deepseek-ai/cordis"`：它不绑任何名字，作用是让本包看见 cordis 的增强链（缺它 `Context` 只剩基础面，`tests/types.test-d.ts` 会红），而 tsc 会把它从 `dist/events.d.ts` 里整行擦掉——有 `tests/dist.test.ts` 的“声明文件里没有 `from "@deepseek-ai/…"`”挡着。因此**没有** `peerDependencies`/`peerDependenciesMeta`，也**没有**为它加的 `knip.json ignoreDependencies` 与 `.dependency-cruiser.cjs` 的 `dependencyTypesNot: ["npm-peer"]`（不需要就一点不留）。

例外且唯一的裸包名出现处是 `src/events.ts` 里那行 `import type {} from "@deepseek-ai/cordis"`：它只做"把 cordis 的增强链载进本包的 program"（缺了它 `Context` 没有 `emit`/`provide`/`effect`，`tsc` 直接红），空绑定会被 tsc 从 `dist/events.d.ts` 里整个擦掉——`tests/dist.test.ts` 断言 `dist/*.d.ts` 里 `from "@deepseek-ai/` 零命中。

**构建上的两个非常规动作（都有原因，别"顺手改掉"）**：`tsc` 发声明时会把 `@hreader/core` 的源码拉进 program 并给它们也发 `.d.ts`（`rootDir` 设了会直接 TS6059 报错），所以 `tsconfig.build.json` 的 `outDir` 指向 `dist/.types`，build 只把 `dist/.types/dsh-bundle/src/*.d.ts` 拷到 `dist/` 再删掉暂存目录；同因，这一步用 `--noCheck`（类型检查由 `tsc -p tsconfig.json` 全覆盖），否则声明一生成就会往 `packages/core/src/` 里拉屎。

**devDeps 里有两个"没人 import"的包**：`@deepseek-ai/dsh-attachment` 与 `@deepseek-ai/dsh-package-manifest` 不是本包用的，而是 `@deepseek-ai/cordis → dsh-llm` 类型链的 peer，缺了 `tsc` 直接 TS2307；`knip.json` 用 `ignoreDependencies` 登记了这条事实，别当垃圾删掉。

**`build` 用 `--sources-content=false`**：`index.js.map` 也是交付物，默认会 `sourcesContent` 内联全部源码（含 `@hreader/core` 的字节），装出去就是把 core 源码随包带走；关掉内联后 map 只留 `sources` 路径，栈帧照样能指回 `src/index.ts`。**别**改成关掉 sourcemap——那是拿宿主的调试能力换一行 grep 干净。`tests/dist.test.ts` 对整份 `dist/**`（含 map）断言 `@hreader/core` / `workspace:*` 零命中。

**已知风险**：①（已消解）`dsh.compatibility.dshReleases` 是照第三方插件 `dsh-web-app@0.6.1` 的实证写法抄的，且本仓装的 `@deepseek-ai/dsh-package-manifest@0.2.2-rc.1` 的类型里**没有** `compatibility` 字段；已用真 `@deepseek-ai/dsh@0.2.2-rc.1` 验过：`dsh plugin add` 退出码 0，`--dump-config` 合成树含本 bundle（见上）。② 依赖全是 `0.2.2-rc.1` 的 rc 版本，上游一改 `SECTION_ORDERS` 或 `SystemPrompt.section` 签名就会漂——`tests/manifest.test.ts` 钉的是精确版本，升级时先读升级后的 `lib/types/index.d.ts` 再改常量。③ `tests/drift.test-d.ts` 只挡类型层漂移（改名/删字段/新增必填必红；新增可选字段不红），`order` 撞位、`name` 新约束这类语义漂移只有 `scripts/smoke-dsh.ts` 兜底，而它不在 CI 里。

**已知限制（`L-34`）**：`dist/styles` 与仓库 `styles/` **同时**缺失时（典型的半截安装：`files` 字段漏了 `dist/styles`，或有人只手拷了 `dist/index.js`），`HrError` 的文案只说"已查内置预设、`<workspace>` 的项目风格、`~/.hreader/styles`"，**不提 `dist/styles`**——而打包安装后前两者都不存在，用户按文案去查会一无所获。复现：`rm -rf packages/dsh-bundle/dist/styles && mv styles /tmp/styles.bak && node -e 'import("./packages/dsh-bundle/dist/index.js").then(m=>m.apply(fakeCtx,{styleId:"atelier-editorial"}))'`。修法（须随"错误文案与资源解析同源"一起改，不许只改文案）：把 `stylesRootOf` 的回落链显式记进错误消息。M3.3 不改 core、也不改文案模板之外的逻辑，故登记不修。

---
