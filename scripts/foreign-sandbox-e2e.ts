// 这层管：真 Chrome 里跑一遍外来文档的 iframe 沙箱对抗验证——
// `sandbox="allow-scripts"` 下 cookie/存储/顶层导航/弹窗/表单/跨源 DOM 必须全部被拦，
// `sandbox=""` 下脚本根本不跑。Chrome 缺失或 `HREADER_SKIP_CHROME=1` 时打印 SKIPPED 并以 0 退出，
// 与 print-e2e 同一套约定（需要真跑的 CI 显式给 `CHROME_BIN`）。
//
// 边界说明：sandbox 令牌不拦网络——fetch/XHR 的收口靠服务端 CSP（`local` 信任档的响应头），
// 不在本脚本范围；这里验的是属性层能承诺的那一半。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipLineOf, skipReasonOf } from "../packages/cli/src/commands/print-skip.ts";

const CANDIDATES = [
  process.env["CHROME_BIN"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const chromeEnvOf = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => ({
  ...env,
  CHROME_BIN: CANDIDATES.find((path) => path !== undefined && existsSync(path)),
});

const chromeOf = (): string => {
  const env = chromeEnvOf(process.env);
  const reason = skipReasonOf(env);
  if (reason !== null) {
    process.stdout.write(skipLineOf(reason));
    process.exit(0);
  }
  return env["CHROME_BIN"] ?? "";
};

/** 攻击脚本：每项攻击的结果写进 results，最后 postMessage 回父页。
 *  opaque 源之间 postMessage 畅通（沙箱不拦消息），父页只用它收报告——
 *  真实阅读器没有 message 监听，伪造消息天然无人接，不构成攻击面。 */
const ATTACK = [
  // 显式 body：裸 `<script>` 文档的脚本落在 head 里执行，`document.body` 还是 null。
  "<body><script>",
  "const results = {};",
  "const probe = (name, fn) => { try { results[name] = fn(); } catch (e) { results[name] = e.name; } };",
  "probe('cookie', () => { void document.cookie; return document.cookie; });",
  "probe('storage', () => { void window.localStorage; return 'ok'; });",
  "probe('parentDom', () => parent.document.title);",
  "probe('topGlobal', () => top.hrReader);",
  "probe('windowOpen', () => window.open('about:blank') === null ? 'blocked' : 'opened');",
  "probe('topNav', () => { top.location.href = 'about:blank#pwned'; return 'attempted'; });",
  "const form = document.createElement('form');",
  "form.action = 'about:blank#form'; form.target = '_top';",
  "document.body.appendChild(form);",
  "probe('form', () => { form.submit(); return 'attempted'; });",
  // postMessage 伪造：给父页塞一条"读者协议"消息，看会不会被当成指令执行。
  "parent.postMessage({type:'doc.changed',revision:'x',changedNodes:'\"x\"]'}, '*');",
  // 同步回传：沙箱 iframe 里的 setTimeout 不被 headless 的 virtual-time 推进，等它必空挂。
  "results.alive = true;",
  "parent.postMessage(JSON.stringify(results), '*');",
  "</script>",
].join("");

/** off 档 iframe：脚本若跑了就会 postMessage，父页收不到 = 脚本没跑。 */
const OFF_FRAME = `<iframe id="off" sandbox="" srcdoc="&lt;script&gt;parent.postMessage('off-ran','*')&lt;/script&gt;"></iframe>`;

/** local 档 iframe：sandbox="allow-scripts"，与 foreign.ts 的唯一可选值一致。 */
const LOCAL_FRAME = `<iframe id="local" sandbox="allow-scripts" srcdoc="${ATTACK.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;

const FIXTURE = [
  "<!doctype html><title>sandbox-e2e</title>",
  "<div id=results></div><div id=nav>pending</div><div id=forged>clean</div><div id=off>pending</div>",
  LOCAL_FRAME,
  OFF_FRAME,
  "<script>",
  "window.addEventListener('message', (e) => {",
  "  const el = document.getElementById('results');",
  "  if (e.data === 'off-ran') { document.getElementById('off').textContent = 'scripts-ran'; return; }",
  // 伪造成"读者协议"的消息（对象而非字符串）：父页若真把它当指令执行，这里会变成 touched。
  "  if (typeof e.data === 'object' && e.data !== null) { document.getElementById('forged').textContent = 'received-object'; return; }",
  "  if (typeof e.data === 'string' && e.data.startsWith('{')) el.textContent = e.data;",
  "});",
  // 顶层导航/表单若穿透沙箱，父页已被带去 about:blank，hash 检查到不了这行。
  "setTimeout(() => {",
  "  document.getElementById('nav').textContent = location.hash === '' ? 'blocked' : 'NAVIGATED';",
  "  document.getElementById('off').textContent =",
  "    document.getElementById('off').textContent === 'pending' ? 'silent' : 'scripts-ran';",
  "}, 500);",
  "</script>",
].join("");

interface AttackResults {
  readonly cookie?: string;
  readonly storage?: string;
  readonly parentDom?: string;
  readonly topGlobal?: string;
  readonly windowOpen?: string;
  readonly topNav?: string;
  readonly form?: string;
  readonly alive?: boolean;
}

const failures: string[] = [];
const check = (ok: boolean, name: string): void => {
  if (!ok) failures.push(name);
};

const main = (): void => {
  const chrome = chromeOf();
  const dir = mkdtempSync(join(tmpdir(), "hr-sandbox-e2e-"));
  const htmlPath = join(dir, "fixture.html");
  writeFileSync(htmlPath, FIXTURE);

  const dom = execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=8000",
      `--dump-dom`,
      `file://${htmlPath}`,
    ],
    { stdio: "pipe", timeout: 60_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  // 顶层导航被穿透的旁证：整页被换成 about:blank，连 marker 都不剩。
  check(dom.includes('id="results"'), "父页被顶层导航带走（dump-dom 里找不到 results）");

  const nav = /id="nav">([^<]*)</u.exec(dom)?.[1] ?? "";
  check(nav === "blocked", `顶层导航/表单提交未被拦截（nav=${nav}）`);

  const off = /id="off">([^<]*)</u.exec(dom)?.[1] ?? "";
  check(off === "silent", `sandbox="" 的 iframe 里脚本居然跑了（off=${off}）`);

  const raw = /id="results">([^<]*)</u.exec(dom)?.[1] ?? "";
  const results = JSON.parse(raw === "" ? "{}" : raw) as AttackResults;
  check(results.alive === true, "allow-scripts 的 iframe 没有回传结果（脚本没跑或消息没到）");

  // Chrome 对 opaque 源的 cookie/存储/跨源 DOM 访问一律 SecurityError。
  for (const key of ["cookie", "storage", "parentDom", "topGlobal"] as const) {
    check(results[key] === "SecurityError", `${key} 未被拦（${String(results[key])}）`);
  }
  check(results.windowOpen === "blocked", `window.open 未被拦（${String(results.windowOpen)}）`);
  check(
    results.topNav === "attempted" || results.topNav === "SecurityError",
    `top.location 赋值出意外（${String(results.topNav)}）`,
  );

  // 伪造对象消息：父页只能"收到"，真实阅读器没有 message 监听（伪造消息无人接）。
  const forged = /id="forged">([^<]*)</u.exec(dom)?.[1] ?? "";
  check(forged === "received-object" || forged === "clean", `伪造消息检测本身坏了（${forged}）`);

  if (failures.length > 0) {
    process.stdout.write(`FAILED: ${failures.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `OK: 沙箱对抗全拦（cookie/storage/DOM/弹窗/导航/表单；off 档静默；伪造 postMessage 无监听方）\n`,
  );
};

main();
