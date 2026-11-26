// 旅程 3（外来 HTML 权限对抗）：真 Chrome 里把沙箱 iframe 当攻击者跑。
//   凭据隔离：联网开后 fetch 能"过线"到达 127.0.0.1 daemon（CSP connect-src 放 http:），
//     但 opaque origin + HttpOnly + SameSite=Strict 三重保证请求里永远没有 hr cookie——
//     读回包是 opaque 空壳，写请求被 401 拒（服务端 grant 不变作证）。
//   第四象限：脚本关+联网开，meta-CSP 覆写、<base> 劫持、外链 script、事件处理属性、
//     javascript: 全部静默——后下发的 HTTP 头 CSP 只会叠加，meta 覆写无效。
//   全局模式：三档写后立即推送 permissions.changed，底栏开关按"由设置统一控制"置灰。
//   路径语义：改名 = 新地址无授权，同径重建保留。
//
// 需要真 Chrome（puppeteer-core）；无 Chrome 时整组跳过，与 foreign-journey 同约定。

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

// 探针文档：opaque 源里每一项隔离事实写进一条 postMessage（父页只收，不回执）。
// fetch 打的是相对路径——opaque origin 下它解析成 daemon 本机地址，正好拿来测
// "联网档能不能碰到 hReader API"。三种 fetch 形态各有诊断值：
//   mode:cors（默认）→ 请求过线后服务端 401 + 无 ACAO → TypeError（响应被没收）；
//   mode:no-cors → opaque 空壳（status:0/body 空）——能证明请求真实过了网线；
//   CSP connect-src 'none'（联网关）→ TypeError（请求根本没出门）。
// 写探针用 text/plain 避开 CORS 预检，让请求真实到达服务端再被拒——
// 被拒的证据是测试侧随后看到 grant 没变（{scripts:false} 没有生效）。
const PROBE_HTML = `<!DOCTYPE html><html><body><script>
const out = {};
const probe = (n, f) => { try { out[n] = f(); } catch (e) { out[n] = e.name; } };
probe('cookie', () => { void document.cookie; return document.cookie; });
probe('storage', () => { void window.localStorage; return 'ok'; });
probe('parentDom', () => parent.document.title);
const emit = (m) => parent.postMessage('pp:' + m, '*');
(async () => {
  try {
    const r = await fetch('/api/permissions', { credentials: 'include' });
    emit('readCors=' + r.status + ':' + r.type);
  } catch (e) { emit('readCors=' + e.name); }
  try {
    const r = await fetch('/api/permissions', { mode: 'no-cors' });
    emit('read=' + r.status + ':' + r.type);
    try { emit('readBody=' + JSON.stringify(await r.text())); } catch (e) { emit('readBody=' + e.name); }
  } catch (e) { emit('read=' + e.name); }
  try {
    const r = await fetch('/api/doc/probe.html/permissions', {
      method: 'POST', mode: 'no-cors',
      headers: { 'content-type': 'text/plain' }, body: '{"scripts":false}',
    });
    emit('write=' + r.status + ':' + r.type);
  } catch (e) { emit('write=' + e.name); }
  emit('probes=' + JSON.stringify(out));
  setInterval(() => parent.postMessage('pp:beat', '*'), 50);
})();
</script></body></html>`;

// 对抗文档：meta-CSP 试图放宽、<base> 试图改写基址、所有脚本向量齐上。
// 任何一条跑了都会打 'sneaky:*'；全部静默才证明 script-src 'none' 罩住。
const SNEAKY_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:">
<base href="https://evil.example/">
</head><body>
<img src="no-such.png" onerror="parent.postMessage('sneaky:onerror','*')">
<script>parent.postMessage('sneaky:inline','*')</script>
<script src="data:text/javascript,parent.postMessage('sneaky:src','*')"></script>
<a id="jx" href="javascript:parent.postMessage('sneaky:jsurl','*')">x</a>
<script>try { eval("parent.postMessage('sneaky:eval','*')"); } catch(e) {}
document.getElementById('jx').click();</script>
</body></html>`;

describe.skipIf(skip !== undefined)("permissions-journey", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;

  const infoOf = async (docId: string) => await api.getJson(`${docApi(docId)}/info`);

  /** 收集页面上的 pp:/sneaky 消息；navigate 后必须重挂（执行上下文随导航销毁）。 */
  const installCollector = async (): Promise<void> => {
    await page.eval(`(() => {
      window.__pp = [];
      window.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && (e.data.startsWith('pp:') || e.data.startsWith('sneaky:'))) {
          window.__pp.push(e.data);
        }
      });
      return true;
    })()`);
  };

  /**
   * 等 app 的 SSE 进入 live 再动手：doc.changed/permissions.changed 只在连接上之后
   * 才到得了页面——先于它发 POST，事件就永远错过（可观察条件，不是时序假设）。
   */
  const waitLive = async (): Promise<void> => {
    const live = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && el.getAttribute('data-conn') === 'live'; })()`,
      20_000,
    );
    assert(live === true, "app 的 SSE 一直没进 live");
  };

  const msgs = async (): Promise<string[]> => {
    const value = await page.eval(`Array.isArray(window.__pp) ? window.__pp : []`);
    return Array.isArray(value) ? (value as string[]) : [];
  };

  /** 等到收集器里出现以 prefix 开头的消息；返回该消息或 undefined。 */
  const waitMsg = async (prefix: string, timeoutMs = 20_000): Promise<string | undefined> => {
    const hit = await page.wait(
      `window.__pp && window.__pp.some((m) => m.startsWith(${JSON.stringify(prefix)}))`,
      timeoutMs,
    );
    if (hit !== true) return undefined;
    return (await msgs()).find((m) => m.startsWith(prefix));
  };

  beforeAll(async () => {
    home = sandbox("perms");
    await writeFile(docPath(home.ws, "probe.html"), PROBE_HTML, "utf8");
    await writeFile(docPath(home.ws, "sneaky.html"), SNEAKY_HTML, "utf8");
    daemon = await startServe({ file: "probe.html", workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    await installCollector();
    await waitLive();
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    killAllTracked();
    home.cleanup();
  });

  test("脚本开+联网关：沙箱隔离全拦，connect-src 'none' 让 fetch 出不了门", async () => {
    const grant = await api.post(`${docApi("probe.html")}/permissions`, { scripts: true });
    assertEq(grant.status, 200, "scripts 授信 POST 状态码");
    const info = await infoOf("probe.html");
    assertEq(info["trust"], "local", "scripts 开 → trust 兼容字段");
    const sandboxAttr = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && f.getAttribute('sandbox') === 'allow-scripts' && 'ok'; })()`,
    );
    assertEq(sandboxAttr, "ok", "scripts 开后 sandbox");

    const probes = await waitMsg("pp:probes=");
    assert(probes !== undefined, "探针结果没有回传（脚本没跑）");
    for (const key of ["cookie", "storage", "parentDom"]) {
      assert(
        probes.includes(`"${key}":"SecurityError"`),
        `${key} 未被 opaque origin 拦住：${probes}`,
      );
    }
    // 联网关：connect-src 'none'，fetch 连出门都不行——请求被拒在 CSP 层。
    const read = await waitMsg("pp:read=");
    assert(
      read?.includes("TypeError") === true,
      `联网关时 fetch 本机 API 竟然成功了：${String(read)}`,
    );
  });

  test("脚本开+联网开：请求过线但凭据不在包里——响应被没收 + 写被拒 grant 不变", async () => {
    const grant = await api.post(`${docApi("probe.html")}/permissions`, { network: true });
    assertEq(grant.status, 200, "network 授信 POST 状态码");
    // 组合变了 → widget 重载 iframe → 探针重跑，新一轮消息到来。
    // no-cors 读：opaque 空壳——请求真实过了网线，但 status/body 对页面不可读。
    const read = await waitMsg("pp:read=0:opaque");
    assert(
      read !== undefined,
      `联网开后 no-cors fetch 应得 opaque 空壳（拿到的是 ${JSON.stringify(await msgs())}）`,
    );
    const body = await waitMsg("pp:readBody=");
    assert(body !== undefined, "readBody 消息缺失");
    assert(
      body === "pp:readBody=\"\"",
      `凭据隔离：opaque 响应体应为空串，实际 ${body}`,
    );
    // 默认 cors 读：服务端已 401 拒绝（无 hr cookie），无 ACAO → TypeError 没收。
    const readCors = await waitMsg("pp:readCors=", 5_000);
    assert(
      readCors === "pp:readCors=TypeError",
      `默认模式 fetch 应被 CORS 没收响应，实际 ${String(readCors)}`,
    );
    const write = await waitMsg("pp:write=0:opaque");
    assert(
      write !== undefined,
      `写请求应返回 opaque（拿到的是 ${JSON.stringify(await msgs())}）`,
    );
    // 服务端视角的否决证据：iframe 里那次 POST 想把 scripts 关掉——grant 必须原样。
    const info = await infoOf("probe.html");
    const perms = info["permissions"] as Record<string, unknown> | undefined;
    assertEq(perms?.["scripts"], true, "iframe 内伪造写请求后 scripts grant 必须仍在");
    assertEq(perms?.["network"], true, "network grant 应仍开");

    // 凭据不上线的第二重证明（cookie 本体属性，与 iframe 无关）：
    // HttpOnly → JS 读不到；SameSite=Strict → 跨站请求永不携带（opaque origin 全是跨站）。
    const boot = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/?token=${encodeURIComponent(daemon.token)}`,
      { redirect: "manual" },
    );
    const setCookie = boot.headers.get("set-cookie") ?? "";
    assert(setCookie.includes("HttpOnly"), `会话 cookie 缺 HttpOnly：${setCookie}`);
    assert(
      setCookie.includes("SameSite=Strict"),
      `会话 cookie 缺 SameSite=Strict：${setCookie}`,
    );
  });

  test("脚本关+联网开：meta-CSP 覆写 / base 劫持 / 全部脚本向量静默", async () => {
    // 先授权再取头：/s/ 的 CSP 跟授权走，顺序倒了拿到的是默认全关档。
    const grant = await api.post(`${docApi("sneaky.html")}/permissions`, { network: true });
    assertEq(grant.status, 200, "sneaky 联网授权 POST 状态码");
    // 头部契约先钉死（组合 off|on 的确切 CSP），再看真实行为。
    const res = await api.get(`/s/${encodeURIComponent("sneaky.html")}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert(csp.includes("script-src 'none'"), `scripts-off CSP 应禁脚本：${csp}`);
    assert(csp.includes("img-src http: https:"), `network-on CSP 应放图片：${csp}`);
    assert(csp.includes("sandbox") && !csp.includes("allow-scripts"), "sandbox 不应带脚本");

    await page.navigate(`http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent("sneaky.html")}`);
    await installCollector();
    const loaded = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && !f.hidden && f.getAttribute('sandbox') === ''; })()`,
      20_000,
    );
    assert(loaded === true, "sneaky iframe 没按 scripts-off 档出现");

    // 窗口期静默：所有 sneaky:* 向量（inline/onerror/src/eval/javascript:）都不得送达。
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const leaks = (await msgs()).filter((m) => m.startsWith("sneaky:"));
    assertEq(leaks.length, 0, `scripts-off 下仍有脚本向量跑出来：${leaks.join(",")}`);
  });

  test("全局接管：POST /api/permissions 广播 permissions.changed，底栏开关置灰", async () => {
    await page.navigate(`http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent("probe.html")}`);
    await installCollector();
    await waitLive();
    const sse = await api.openSse();
    try {
      const modes = await api.post("/api/permissions", { scripts: "deny" });
      assertEq(modes.status, 200, "全局 scripts=deny POST 状态码");
      const event = await sse.next("permissions.changed", 15_000);
      assert(event !== undefined, "permissions.changed 事件没有推送");

      const greyed = await page.wait(
        `(() => { const b = document.querySelector('#hr-perm-scripts'); return b && b.disabled && 'ok'; })()`,
        15_000,
      );
      assertEq(greyed, "ok", "全局 deny 下底栏开关没有置灰");
      const title = await page.eval(
        `(() => { const b = document.querySelector('#hr-perm-scripts'); return b ? b.title : ''; })()`,
      );
      assert(
        typeof title === "string" && title.includes("设置"),
        `置灰开关应提示"由设置统一控制"：${String(title)}`,
      );
      const info = await infoOf("probe.html");
      const perms = info["permissions"] as Record<string, unknown> | undefined;
      assertEq(perms?.["scripts"], false, "全局 deny 覆盖文档授权");
      assertEq(perms?.["scriptsSource"], "global", "scripts 出处应为 global");

      // 切回逐个文档：原 grant 重新生效，开关回活。
      const back = await api.post("/api/permissions", { scripts: "per-doc" });
      assertEq(back.status, 200, "切回 per-doc 状态码");
      const enabled = await page.wait(
        `(() => { const b = document.querySelector('#hr-perm-scripts'); return b && !b.disabled && 'ok'; })()`,
        15_000,
      );
      assertEq(enabled, "ok", "切回 per-doc 后开关没有恢复");
      const info2 = await infoOf("probe.html");
      const perms2 = info2["permissions"] as Record<string, unknown> | undefined;
      assertEq(perms2?.["scripts"], true, "per-doc 恢复后文档 grant 重新生效");
      assertEq(perms2?.["scriptsSource"], "doc", "scripts 出处应回 doc");
    } finally {
      sse.close();
    }
  });
});
