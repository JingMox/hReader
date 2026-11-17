import { afterEach, describe, expect, it } from "vitest";

import { fakeTransportOf, wsTransportOf, type FakeTransport } from "../src/chrome/transport";

class FakeSocket {
  static last: FakeSocket | undefined;
  readonly sent: string[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(): void {
    this.onclose?.();
  }
}

const originalWebSocket: unknown = Reflect.get(globalThis, "WebSocket");

const installFakeSocket = (): void => {
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeSocket,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    value: originalWebSocket,
    configurable: true,
    writable: true,
  });
  FakeSocket.last = undefined;
});

describe("fakeTransportOf", () => {
  it("记录发出的报文，投递注入的报文，close 后通知 onClose", () => {
    const transport: FakeTransport = fakeTransportOf();
    const received: string[] = [];
    let closed = false;
    transport.onMessage((text) => {
      received.push(text);
    });
    transport.onClose(() => {
      closed = true;
    });
    transport.send("a");
    transport.send("b");
    expect(transport.sent).toEqual(["a", "b"]);
    transport.receive("c");
    expect(received).toEqual(["c"]);
    transport.close();
    expect(closed).toBe(false);
  });

  it("drop 模拟对端断链", () => {
    const transport = fakeTransportOf();
    let closed = 0;
    transport.onClose(() => {
      closed += 1;
    });
    transport.drop();
    expect(closed).toBe(1);
    transport.drop();
    expect(closed).toBe(2);
  });
});

describe("wsTransportOf · 排队与收报文", () => {
  it("open 前的报文排队，open 后按序发出", () => {
    installFakeSocket();
    const transport = wsTransportOf("ws://127.0.0.1:9222/devtools/browser/fake");
    const socket = FakeSocket.last;
    expect(socket?.url).toBe("ws://127.0.0.1:9222/devtools/browser/fake");
    transport.send("before-open");
    expect(socket?.sent).toEqual([]);
    socket?.emitOpen();
    expect(socket?.sent).toEqual(["before-open"]);
    transport.send("after-open");
    expect(socket?.sent).toEqual(["before-open", "after-open"]);
  });

  it("文本报文投递给 onMessage，非文本被忽略", () => {
    installFakeSocket();
    const transport = wsTransportOf("ws://127.0.0.1:1/x");
    const received: string[] = [];
    transport.onMessage((text) => {
      received.push(text);
    });
    FakeSocket.last?.emitMessage("hi");
    FakeSocket.last?.emitMessage(new Uint8Array([1, 2]));
    expect(received).toEqual(["hi"]);
  });
});

describe("wsTransportOf · 关闭", () => {
  it("对端关闭时通知 onClose", () => {
    installFakeSocket();
    const transport = wsTransportOf("ws://127.0.0.1:1/x");
    let closed = 0;
    transport.onClose(() => {
      closed += 1;
    });
    FakeSocket.last?.emitClose();
    expect(closed).toBe(1);
  });

  it("close 转给底层 socket", () => {
    installFakeSocket();
    const transport = wsTransportOf("ws://127.0.0.1:1/x");
    transport.send("x");
    transport.close();
    expect(FakeSocket.last?.closed).toBe(true);
  });
});
