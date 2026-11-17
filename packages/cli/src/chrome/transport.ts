// 这层管：CDP 的文本通道（接口 + `globalThis.WebSocket` 真实现 + 测试用内存假双工）；不认识报文含义。

export interface ChromeTransport {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

interface SocketState {
  readonly socket: WebSocket;
  readonly queue: string[];
  readonly messageListeners: ((text: string) => void)[];
  readonly closeListeners: (() => void)[];
  open: boolean;
}

const sendTo = (state: SocketState, text: string): void => {
  // Chrome 就绪前队列里攒着：undici 的 `send` 在 CONNECTING 阶段会抛，握手请求就丢了。
  if (!state.open) {
    state.queue.push(text);
    return;
  }
  state.socket.send(text);
};

export const wsTransportOf = (url: string): ChromeTransport => {
  const socket = new globalThis.WebSocket(url);
  const state: SocketState = {
    socket,
    queue: [],
    messageListeners: [],
    closeListeners: [],
    open: false,
  };
  socket.onopen = () => {
    state.open = true;
    for (const text of state.queue.splice(0)) socket.send(text);
  };
  socket.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    if (text === "") return;
    for (const cb of state.messageListeners) cb(text);
  };
  socket.onclose = () => {
    for (const cb of state.closeListeners) cb();
  };
  return {
    send: (text) => {
      sendTo(state, text);
    },
    onMessage: (cb) => {
      state.messageListeners.push(cb);
    },
    onClose: (cb) => {
      state.closeListeners.push(cb);
    },
    close: () => {
      socket.close();
    },
  };
};

export interface FakeTransport extends ChromeTransport {
  readonly sent: readonly string[];
  receive(text: string): void;
  drop(): void;
}

export const fakeTransportOf = (): FakeTransport => {
  const sent: string[] = [];
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  return {
    sent,
    send: (text) => {
      sent.push(text);
    },
    onMessage: (cb) => {
      messageListeners.push(cb);
    },
    onClose: (cb) => {
      closeListeners.push(cb);
    },
    close: () => undefined,
    receive: (text) => {
      for (const cb of messageListeners) cb(text);
    },
    drop: () => {
      for (const cb of closeListeners) cb();
    },
  };
};
