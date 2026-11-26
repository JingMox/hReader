### 宿主插件使用说明（本地构建，host-only）

**装进宿主 profile**：本插件不发布，装的是仓库里的目录，且 `--profile` 是**必填**选项（漏了宿主直接 usage 报错）：

```bash
pnpm -C packages/plugin build        # 产 dist/index.js（自包含）+ dist/index.d.ts
host plugin --profile <profile> add "$(pwd)/packages/plugin"
```

烟测脚本用新建的临时 `$HOST_HOME` + 固定 profile 名 `smoke` 跑同一件事（`--profile` 只收**名字**不是路径，profile 落在 `$HOST_HOME/profiles/smoke`，绝不碰用户真实目录）；本机没装宿主时它 SKIP（不进 CI，SKIP 日志给出安装方法）。**已用真宿主二进制验过**：`host plugin --profile smoke add <包目录>` 退出码 0，`host --profile smoke --dump-config` 的合成树里逐字出现：

```yaml
# == @example/plugin
- id: example
  name: "@example/plugin"
```

三条断言（注释头 / `- id: example` / `name: '@example/plugin'`）各自独立检查，失败时贴 `--dump-config` 的尾巴。旧版"临时 profile 目录里出现插件名"的软断言已删：它扫描的目录在 `add` 非 0 时也可能已写进包名，是假绿来源。

**`workspace` 从哪来（四步）**：宿主上下文对象上**没有**工作区字段——类型定义里只有模块解析用的 `baseUrl`，系统提示的声明里 `cwd`/`workspace` 零命中。所以：

1. `config.workspace` 缺省 → 取宿主进程 `process.cwd()`，并往 **stderr** 打一行 `[example] config.workspace 未配置，使用宿主进程 cwd=<abs>`（用户有权知道内容是按哪个目录渲染的）；
2. 原始串含 `..` 段 → fail-fast（`resolve` 会把 `<repo>/../..` 静默改成仓库的父目录，配置文件路径就跟着换人）；
3. 给了**相对路径** → 按 cwd 解析成绝对路径；
4. 给了但**不存在 / 不是目录** → fail-fast，错误文案点名 `config.workspace`（拼错的路径比 cwd 兜底更危险）。

**不要求 `workspace` 落在 cwd 之内**：本插件只**读**配置文件、从不写盘（`writeFileSync|writeFile|mkdirSync|renameSync|unlink` 全文零命中），`workspace: "/tmp"` 因此合法；路径 containment 的守卫归写侧，本插件不重复实现一遍。测试里有一条名字写明这条理由的钉子用例。

随包的清单 yaml 里 `config: {}` 就是这个意思：开箱即用（按 cwd），想钉死工作区就填绝对路径。**不改随包 yaml 是设计要求**——"让用户手改依赖里的文件"是敌意设计。

**未知配置 id**：fail-fast，抛受控错误，消息里列出当前可用 id（内置预设 + 工作区级 + 用户级）。不选"退默认 + warn"：产出里混进一个退了默认的配置，作者永远发现不了自己拼错。

**卸载语义**：注册全在 `ctx.effect(() => {...}, "example")` 里，dispose 时摘掉 section 与 `example` 服务；同一个 ctx 上重复 `apply` 先撤旧的（`WeakMap` 记账），宿主里始终只有一个 section。

**`order = 100` 的理由**：真常量表在宿主类型声明里：身份段是负数、persona 段是 0、策略段是 500、工具指引从 1000 起。语言规约是 persona 级指令，必须排在 persona 之后、policy 与工具指引之前 → 100。（旧版本文档写的分段与真包不符，已更正。）

**`styles` 与 `dist`**：宿主从 profile 的 `node_modules` 加载插件，`exports` 指向 `.ts` 一定失败，故 `build` 产 `dist/index.js`（打包器把内部包与依赖一起打进，`exports`/`main` 指向它）与 `dist/*.d.ts`（模块增强的合并要靠它才对使用方可见），并把资源目录拷到 `dist/`（样式文件无法打包）。

**`dist/*.d.ts` 里没有裸依赖（对外形状一律本地镜像）**：声明文件里一个裸 `import type` 就够使用方报 TS2307，所以对外接口在源码里本地重述（三个 readonly 字段），不 import 宿主包；漂移由类型测试的双向/单向赋值盯着（官方改字段类型、加/删字段都会红）。唯一的例外是一行 `import type {} from "宿主包"`：它不绑任何名字，作用是让本包看见宿主的增强链，而 tsc 会把它从 `dist/*.d.ts` 里整行擦掉——有产物测试的"声明文件里没有 `from "宿主包"`"挡着。因此**没有** `peerDependencies`，也**没有**为它加的忽略配置（不需要就一点不留）。

**构建上的两个非常规动作（都有原因，别"顺手改掉"）**：`tsc` 发声明时会把内部包的源码拉进 program 并给它们也发 `.d.ts`（`rootDir` 设了会直接报错），所以 `outDir` 指向暂存目录，build 只把需要的子树拷到 `dist/` 再删掉暂存；同因，这一步用 `--noCheck`（类型检查由单独的 `tsc -p` 全覆盖），否则声明一生成就会往内部源码目录里写文件。

**devDeps 里有两个"没人 import"的包**：它们不是本包用的，而是宿主类型链的 peer，缺了 `tsc` 直接报错；配置文件用忽略清单登记了这条事实，别当垃圾删掉。

**`build` 关掉源码内联**：产物 map 也是交付物，默认会内联全部源码（含内部包的字节），装出去就是把内部源码随包带走；关掉内联后 map 只留 `sources` 路径，栈帧照样能指回 `src/index.ts`。**别**改成关掉 sourcemap——那是拿宿主的调试能力换一行检索干净。产物测试对整份 `dist/**`（含 map）断言内部包名 / workspace 协议零命中。

**已知风险**：① 清单里的兼容性字段是照第三方插件的实证写法抄的，且本仓装的类型里**没有**该字段；已用真宿主验过：`plugin add` 退出码 0，合成树含本插件（见上），不构成实际问题。② 依赖全是 rc 版本，上游一改常量表或签名就会漂——清单测试钉的是精确版本，升级时先读升级后的类型声明再改常量。③ 类型测试只挡类型层漂移（改名/删字段/新增必填必红；新增可选字段不红），语义漂移只有手工烟测兜底，而它不在 CI 里。

**已知限制**：打包产物与仓库资源目录**同时**缺失时（典型的半截安装），错误文案只说"已查内置预设、工作区配置、用户级配置"，**不提产物内目录**——而打包安装后前两者都不存在，用户按文案去查会一无所获。修法（须随"错误文案与资源解析同源"一起改，不许只改文案）：把资源解析的回落链显式记进错误消息。本文只如实记录该限制，不改动相关逻辑。

---
