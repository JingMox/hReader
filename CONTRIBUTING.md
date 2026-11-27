# 贡献指南

感谢你愿意为 hReader 贡献代码！这份文档说明本地开发、测试与提交流程。

## 环境要求

- **Node.js `>= 22`**（`.node-version` 已固定主版本，fnm/nvm/volta 会自动切换）
- **pnpm `11.x`**（`corepack enable`，或 `npm i -g pnpm@11`；不要混用 npm/yarn）
- **Rust**（仅改动 `packages/desktop` 时需要；装了 rustup 会按 `rust-toolchain.toml` 自动选版本）
- **Linux 桌面构建**还需要系统库：
  ```bash
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev patchelf libssl-dev
  ```

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm build
```

## 仓库结构

```
packages/core           语义化 HTML 解析、data-hr-id 树、大纲、修补、风格与本地服务（依赖底座）
packages/renderer-html  PDF / PNG / 打印版 HTML 渲染（→ core）
packages/cli            `hr` 命令行（→ core, renderer-html）
packages/mcp-server     MCP stdio 服务（→ core）
packages/app            桌面端/浏览器共用的阅读器前端
packages/pi-extension   Pi 单文件扩展
packages/dsh-bundle     dsh bundle（构建期把 core 打进 dist）
packages/desktop        Tauri v2 桌面壳（Rust + webview）
```

共享依赖的版本统一在 `pnpm-workspace.yaml` 的 `catalog:` 里；给多个包加同一个依赖时，在包里写 `catalog:` 而不是版本号。

## 常用命令

```bash
pnpm verify          # 全量门禁：format / lint / lint:sh / typecheck / build / 覆盖率 / theme:check / depcruise / knip
pnpm test            # 跑全部单元测试
pnpm test:coverage   # 测试 + 覆盖率阈值
pnpm -F @hreader/core test   # 只跑一个包
pnpm lint            # ESLint（strictTypeChecked + stylisticTypeChecked）
pnpm typecheck       # tsc --noEmit，覆盖所有包
pnpm format          # Prettier 修复
pnpm desktop:check   # 桌面壳门禁：rustfmt + clippy -D warnings + cargo test
```

端到端、集成与性能检查（CI 的 `e2e` job 会跑这三条；`test:e2e` 与 `test:integration` 本地都需要 Chrome/Edge/Chromium，桌面冒烟在无桌面环境自动 SKIP，`test:perf` 无外部依赖）：

```bash
pnpm test:e2e          # 打印稿分页 + 外来文档沙箱（真 Chrome）
pnpm test:integration  # 跨包集成/用户旅程（真 dist 产物 + 真 Chrome）
pnpm test:perf         # 绝对时间预算性能门（tests/perf/**，不开覆盖率、单 worker 串行）
```

仍属本地按需（CI 不跑）：

```bash
pnpm smoke:pi        # Pi 扩展冒烟
pnpm desktop:build   # 本地打出桌面安装包
```

## 门禁策略

CI 把上面这些 package scripts 拆成并行的 `lint` / `test` / `e2e` job（desktop 是独立 job），检查集合与 `pnpm verify` 一致、顺序可不同——本地绿了 CI 才会绿。

- **Lint**：`typescript-eslint` 的 `strictTypeChecked` + `stylisticTypeChecked`，另加跨包深层导入禁令（跨包只能走 `@hreader/<name>` 公开入口）。不设行数/复杂度硬上限——复杂度由 review 把关。
- **豁免注释**：`eslint-disable` 允许但必须有界、带说明（`@eslint-community/eslint-comments` 强制）；`@ts-ignore`/`@ts-nocheck` 禁止，`@ts-expect-error` 必须带一行理由。
- **断言**：允许 `as`，禁止对象字面量断言、`any`、非空断言 `!`。
- **覆盖率**：全局四维阈值（lines/branches/functions/statements）写在 `vitest.config.ts`，取当前实测值作棘轮——只防退化，不要求每个文件满覆盖。
- **架构边界**：`dependency-cruiser` 管依赖方向（core 不依赖任何其他包、无环、src 不引 devDeps、src 不引 tests）；`knip` 管死代码。
- **Shell**：`lint:sh` 用 shellcheck；本地没装会提示并跳过，CI 上必跑。

## 代码规范要点

最常碰到的几条：

- 注释只写签名表达不了的东西（契约、取舍、格式、反直觉处）；不写复述代码的注释，过时注释随代码一起改。无主 TODO 不允许——`TODO(name, issue#): ...` 才可以存在。
- 对外 API 用裸类型（原始类型、字面量联合、纯数据接口、判别联合）；不造包装类/brand 类型、不用 boolean 控制参数（参数多了收 plain-object options）、`null`/`undefined` 不混用（统一 `undefined` 表缺失）。
- 外部输入（文件、argv、HTTP/MCP 参数、`hr-meta` JSON）在边界处校验（类型守卫或 zod），向内传裸类型，内部不重复校验。
- 错误用 `HrError` 或 `{ ok: false, code, message }` 判别联合，不静默 catch。
- 纯逻辑层（`app` 的 state/keys/store 等）不碰 DOM 与浏览器全局；依赖靠参数注入。

## 提交与 PR

- Commit 用 [Conventional Commits](https://www.conventionalcommits.org/)：`type(scope): summary`，type ∈ `feat`/`fix`/`refactor`/`test`/`docs`/`chore`/`perf`/`build`。
- 提交前跑过 `pnpm format`、`pnpm verify`；改了 `packages/desktop` 再跑 `pnpm desktop:check`。
- PR 描述写清动机、影响面和验证结果；改公开 API 或文档结构时同步更新 `README.md` / `docs/`。
- 一个 PR 只做一件事；重构与功能改动尽量分开。

## 测试约定

- 每个测试断言一个可观察行为，命名 `should <behavior> when <condition>`。
- 断言具体值与错误 `code`，不只断言"抛了错"。
- 不 mock 被测单元本体；fs/网络/时间等外部依赖通过注入的替身控制。
- 临时目录用 `mkdtemp` 并在 `finally` 里清理。
- 隔离配置根（`~/.hreader`，即 `permissions.json`、`daemon.json` 所在）用 `HREADER_HOME`，不要改写 `HOME`：`HOME` 会被 Chrome 子进程继承——空 `HOME` 会让浏览器网络栈起不来、渲染卡到 deadline；`HREADER_HOME` 不进 Chrome 视野。
- 禁止 `test.only`、注释掉的测试、无种子随机、直读 `Date.now()`、真实网络、`setTimeout` 轮询。
- 断言绝对时间预算（"< N ms"，不管墙钟还是 `process.cpuUsage()`）的测试放 `tests/perf/**/*.perf.test.ts`，由 `pnpm test:perf` 单跑（`vitest.perf.config.ts`：不开覆盖率、单 worker 顺序执行）——v8 插桩会让 `src/**` 慢好几倍，开覆盖率的运行里绝对预算必然随机红。单元测试里只保留与机器速度无关的断言：复杂度/线性增长比值（插桩下比值大体不变）、结构性上界（字节数、节点数、截断位置）、功能正确性。
- 交付物测试对**构建产物**跑真子进程（`cli` 的 `dist/cli.mjs`、`mcp-server` 的 `dist/main.js`），不是只测 src。

## 变异测试

测试强度用 StrykerJS（`@stryker-mutator/vitest-runner`）量化，配置在 `stryker.config.mjs`。

```bash
pnpm test:mutation                          # 跑 config 里的全量范围（很久）
pnpm test:mutation --mutate "packages/core/src/io/paths.ts"   # 只跑一个/几个文件（逗号分隔 glob）
```

- 结果在 `.reports-tmp/mutation/`（HTML + JSON，已 gitignore）；增量缓存在 `.reports-tmp/stryker-incremental.json`，改过的文件会自动重测，删掉它可强制全量。
- 读报告：`killed`/`timeout` 是测试逮住的变异体；`survived` 是测试漏掉的——要么补行为级测试，要么确认是等价变异后用 `// Stryker disable next-line <Mutator>: <理由>` 标记并写明理由。
- `thresholds.break` 是防退化棘轮：低于它命令退出非零。新补的测试杀死变异体后，分数只能升不能降。
- CI 的 `mutation.yml` 每周定期跑 + 支持 `workflow_dispatch` 手动触发（可传 `mutate` 缩小范围），不阻塞 PR。
- 注意：Stryker 用 sandbox 模式跑——把工作树拷到 `.stryker-tmp/`（`node_modules` 走符号链接），每个沙箱在初始测试前先执行一次 `scripts/stryker-prep.mjs`（补可执行位、关掉 pnpm 的 verify-deps-before-run 自动 install）。源码不会被就地覆写；但开跑之后再改的源码也不会进本次运行。
