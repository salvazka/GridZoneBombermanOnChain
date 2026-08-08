/**
 * Keyboard input, sent as intent rather than position.
 *
 * The client never moves its own player: it reports which keys are held and the
 * server simulates. That keeps the server authoritative, which matters because
 * the server is also what tells the contract who killed whom.
 *
 * Movement is sent only on change, plus a low-frequency heartbeat, instead of
 * every frame. At 60fps a naive implementation would push 60 messages per second
 * per player for state that changes a handful of times.
 */
const KEY_MAP = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
};

const HEARTBEAT_MS = 250;

export class InputController {
  constructor(net) {
    this.net = net;
    this.state = { up: false, down: false, left: false, right: false };
    this.enabled = false;
    this.lastSent = "";
    this.heartbeat = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
  }

  attach() {
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    // Without this, alt-tabbing while holding a key leaves the player walking
    // into a wall forever, since the keyup never arrives.
    window.addEventListener("blur", this._onBlur);
  }

  detach() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    this.disable();
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.heartbeat = setInterval(() => this._flush(true), HEARTBEAT_MS);
  }

  disable() {
    this.enabled = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this._reset();
  }

  _onKeyDown(event) {
    if (!this.enabled) return;

    if (event.code === "Space") {
      // Space scrolls the page by default, which shifts the canvas mid-match.
      event.preventDefault();
      if (!event.repeat) this.net.sendBomb();
      return;
    }

    const dir = KEY_MAP[event.code];
    if (!dir) return;
    event.preventDefault();
    if (this.state[dir]) return;
    this.state[dir] = true;
    this._flush();
  }

  _onKeyUp(event) {
    const dir = KEY_MAP[event.code];
    if (!dir) return;
    if (!this.state[dir]) return;
    this.state[dir] = false;
    this._flush();
  }

  _onBlur() {
    this._reset();
  }

  _reset() {
    const wasMoving = Object.values(this.state).some(Boolean);
    this.state = { up: false, down: false, left: false, right: false };
    if (wasMoving) this._flush();
  }

  _flush(isHeartbeat = false) {
    if (!this.enabled) return;
    const key = JSON.stringify(this.state);
    // The heartbeat re-sends the current state so a dropped packet cannot leave
    // the server holding stale input.
    if (!isHeartbeat && key === this.lastSent) return;
    this.lastSent = key;
    this.net.sendInput(this.state);
  }
}
