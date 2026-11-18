# M4.2 真机 GUI 证据（协调者执行，2026-11-18）

靶子：`packages/desktop/src-tauri/target/release/bundle/macos/hReader.app/Contents/MacOS/hreader-desktop`
夹具：`/tmp/hr-gui/{ws/a.html, home/, hr-shim}`

## 0. 先踩到的两个坑（不是壳的缺陷，是夹具/环境）

1. **`hr` 在本机不能裸跑**：`packages/cli/package.json` 的 `bin.hr = ./src/main.ts`，Node 24 裸跑 `node src/main.ts` 会在 core 的免后缀 import 上 `ERR_MODULE_NOT_FOUND`。可用的跑法是 `node_modules/.bin/jiti packages/cli/src/main.ts`（仓里带 `jiti 2.7.0`）。壳的 `HREADER_CLI` 指向的 shim 就是：
   ```sh
   #!/bin/sh
   export PATH=<node-bin>:/usr/bin:/bin
   exec <repo>/node_modules/.bin/jiti <repo>/packages/cli/src/main.ts "$@"
   ```
2. **文档夹具要满足 core 的文档契约**，否则 `hr serve` 直接 `invalid_document`：
   - `<article data-hr-id="root">`（缺 `data-hr-id` 报「模型根 ID 不得为空（输入需先经 injectNodeIds）」）；
   - 建议带 `<script id="hr-meta" type="application/json">{"version":"1.0","annotations":[]}</script>`。

## 1. AC-20「webview 真加载」—— PASS（无需截图）

本机 `screencapture` 报 `could not create image from display`（代理会话无屏幕录制授权），改用 **AX + 剪贴板**取证：

```
$ osascript -e 'tell application "System Events" to get size of window 1 of (first process whose name contains "hreader")'
1120, 820
$ osascript -e '... keystroke "a" using command down'; ... keystroke "c" using command down
$ pbpaste
真机渲染验证

如果这段文字出现在窗口里，说明 webview 真的加载了带 cookie 的阅读器页面，而不是停在 401 或白屏。
```

剪贴板内容 == 文档正文 ⇒ webview 真的拿到了带 cookie 的阅读器页面并完成了渲染。这条比截图更硬（截图还要人眼判断「是不是白屏」）。

## 2. AC-9/D1 隔离 home —— PASS

`--home /tmp/hr-gui/home` 下生成 `home/.hreader/daemon.json`（`{"port":49178,"token":"…","pid":73721,"workspace":"/private/tmp/hr-gui/ws"}`）；用户的 `~/.hreader/daemon.json` 不存在/未被创建（`ls` 空）。

## 3. **缺陷（P1，编写员自测未覆盖）：GUI 路径退出不收拾子进程**

两种退出方式都留下孤儿 daemon + 残留 `daemon.json`：

```
app=73929 daemon=73931
$ kill -TERM 73929      → app alive: no / daemon alive: yes / daemon.json: daemon.json
app=74002 daemon=74004
$ osascript -e 'tell application "hReader" to quit'  → app alive: no / daemon alive: yes / daemon.json: daemon.json
```

根因（静态可见）：`packages/desktop/src-tauri/src/lib.rs:99` 的 GUI 分支走 `window::run(url, session)`，而 `signals::watch()` 只在 `hold()`（`lib.rs:121`）里装配；`window::run` 也没有注册 tauri 的 `RunEvent::Exit`/`WindowEvent::CloseRequested` 收尸钩子。于是**任何**正常退出都不跑 `Daemon` 的 Drop 收尸。

编写员的 AC-14 只测了 `--hold 30` + `kill -TERM` 这条**恰好**装了信号监听的路径，所以自测绿。

影响：每次关窗/退出后，daemon 继续占端口与文档，`daemon.json` 残留；下次启动按 `spawn_decision` 的「复用」分支把它当自己的才怪——它会被 `adopted`（外部），于是**再也不会被回收**，形成永久泄漏。

## 4. 附带发现（P3）

- `lib.rs:131` 与 `lib.rs:141` 两次调用 `document_of(&action, &options.workspace)?`，第二次的结果被 `let doc_id = …` 遮蔽外层变量，冗余。
