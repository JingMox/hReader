// 这层管：`knip --strict` 报的 21 个"无人 import 的导出"——它们是 server 的可单测部件，
// 但此前只被同文件内部调用。这里从**内部路径/门面**逐个引入并断言真实行为，
// 让 `pnpm verify` 的 knip 一段不再把它们当死导出（不动 src、不加 ignore）。

import { describe, expect, it } from "vitest";

import { defaultHostsOf } from "../../src/server/auth";
import { numberFieldOf } from "../../src/server/body";
import { daemonAlive, parseDaemon } from "../../src/server/daemon";
import { frameTokenOf } from "../../src/server/event-ring";
import { CONNECT_COMMENT, MAX_CLIENTS, RETRY_AFTER_MS, createHub } from "../../src/server/hub";
import {
  daemonFileOf,
  matchRoute,
  statusOf,
  READY_FRAME,
  createEventRing,
} from "../../src/server/index";
import { REVISION_CHARS } from "../../src/server/revision";
import { ROUTES } from "../../src/server/routes";
import { DEBOUNCE_MS, ECHO_MS, createWatcher } from "../../src/server/watcher";

describe("auth/body · 小工具", () => {
  it("should list both loopback hosts for the given port", () => {
    expect(defaultHostsOf(7421)).toEqual(["127.0.0.1:7421", "localhost:7421"]);
  });

  it("should accept finite numbers only and reject NaN / numeric strings", () => {
    expect(numberFieldOf({ n: 3, s: "3", nan: Number.NaN }, "n")).toBe(3);
    expect(numberFieldOf({ n: 3, s: "3", nan: Number.NaN }, "s")).toBeUndefined();
    expect(numberFieldOf({ n: 3, s: "3", nan: Number.NaN }, "nan")).toBeUndefined();
  });
});

describe("daemon · 记录解析与存活判定", () => {
  it("should build the store path under .hreader", () => {
    expect(daemonFileOf("/home/u")).toBe("/home/u/.hreader/daemon.json");
  });

  it("should reject malformed payloads instead of half-trusting them", () => {
    const good = JSON.stringify({ port: 7421, token: "t", pid: 12, workspace: "/ws" });
    expect(parseDaemon(good)).toEqual({ port: 7421, token: "t", pid: 12, workspace: "/ws" });
    expect(parseDaemon("{not json")).toBeUndefined();
    expect(parseDaemon("[]")).toBeUndefined();
    expect(
      parseDaemon(JSON.stringify({ port: 0, token: "t", pid: 12, workspace: "/ws" })),
    ).toBeUndefined();
    expect(
      parseDaemon(JSON.stringify({ port: 7421, token: "", pid: 12, workspace: "/ws" })),
    ).toBeUndefined();
  });

  it("should treat the current pid as alive and a dead one as not", () => {
    expect(daemonAlive({ port: 7421, token: "t", pid: process.pid, workspace: "/ws" })).toBe(true);
    expect(daemonAlive({ port: 7421, token: "t", pid: 999_999, workspace: "/ws" })).toBe(false);
  });
});

describe("event-ring/watcher · 帧头转义与常量", () => {
  it("should fold CR/LF and escape backslashes in header tokens", () => {
    expect(frameTokenOf("a\nb")).toBe("a-b");
    expect(frameTokenOf("a\\b")).toBe("a\\\\b");
    expect(frameTokenOf("a\r\nb")).toBe("a--b");
    expect(frameTokenOf("plain")).toBe("plain");
  });

  it("should pin the protocol constants", () => {
    expect(CONNECT_COMMENT).toBe(": ready\n\n");
    expect(READY_FRAME).toContain("ready");
    expect(RETRY_AFTER_MS).toBe(2000);
    expect(MAX_CLIENTS).toBe(64);
    expect(DEBOUNCE_MS).toBe(100);
    expect(ECHO_MS).toBe(200);
    expect(REVISION_CHARS).toBe(16);
  });
});

describe("门面 · 可单测部件仍可用", () => {
  it("should create a hub whose ring starts empty", () => {
    const ring = createEventRing(4);
    const hub = createHub({ ring, heartbeatMs: 60_000 });
    hub.close();

    expect(hub.clientCount).toBe(0);
    expect(ring.since(0).events).toEqual([]);
  });

  it("should create a watcher with the three-method surface", () => {
    const watcher = createWatcher({ now: () => 0, onFileChange: () => undefined });
    watcher.close();

    expect(typeof watcher.add).toBe("function");
    expect(typeof watcher.noteSelfWrite).toBe("function");
  });

  it("should match routes and map error codes to statuses", () => {
    const hit = matchRoute("GET", "/api/events");
    expect(hit.kind).toBe("route");
    expect(hit.kind === "route" ? hit.route.kind : "").toBe("events");

    const wrong = matchRoute("POST", "/api/events");
    expect(wrong.kind).toBe("method");

    expect(ROUTES).toHaveLength(9);
    expect(statusOf("locked")).toBe(409);
    expect(statusOf("too_many_clients")).toBe(429);
    expect(statusOf("path_outside_workspace")).toBe(403);
  });
});
