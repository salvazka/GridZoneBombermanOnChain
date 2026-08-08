import { io } from "socket.io-client";

/**
 * The server URL. In development, Vite proxies /api and /socket.io to
 * localhost:3001, so an empty string (same-origin) works. In production the
 * client is a static site on Vercel and the server lives on a different domain
 * (e.g. Render), so the full URL must be specified via the VITE_SERVER_URL env
 * variable at build time.
 */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";

/** Socket wrapper. */
export class Net {
  constructor() {
    this.socket = SERVER_URL
      ? io(SERVER_URL, { transports: ["websocket", "polling"], autoConnect: true })
      : io({ transports: ["websocket", "polling"], autoConnect: true });
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
  // Prefix relative URLs with the server base when deployed cross-origin.
  const fullUrl = url.startsWith("/") && SERVER_URL ? `${SERVER_URL}${url}` : url;
  const res = await fetch(fullUrl, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Unexpected response from ${fullUrl}: ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}
