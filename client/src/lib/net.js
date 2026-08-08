import { io } from "socket.io-client";

/** Socket wrapper. Same-origin because Vite proxies /socket.io to the server. */
export class Net {
  constructor() {
    this.socket = io({ transports: ["websocket", "polling"], autoConnect: true });
    this.socketId = null;
    this._ready = new Promise((resolve) => {
      this.socket.on("hello", ({ socketId }) => {
        this.socketId = socketId;
        resolve(socketId);
      });
    });
  }

  /** Resolves once the server has issued a socket id, which /api/join needs to
   *  hold a seat against this specific connection. */
  ready() {
    return this._ready;
  }

  on(event, handler) {
    this.socket.on(event, handler);
  }

  confirmSeat({ matchId, address, name }) {
    return new Promise((resolve) => {
      this.socket.emit("seat:confirm", { matchId, address, name }, (result) => {
        resolve(result ?? { ok: false, reason: "No response from server" });
      });
    });
  }

  sendInput(input) {
    this.socket.emit("input", input);
  }

  sendBomb() {
    this.socket.emit("bomb");
  }
}

export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Unexpected response from ${url}: ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}
