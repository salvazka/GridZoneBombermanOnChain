const HOLD_MS = 3200;

/** Transient match notifications. */
export class Toasts {
  constructor() {
    this.root = document.getElementById("toasts");
  }

  show(message, variant = "") {
    const el = document.createElement("div");
    el.className = `toast${variant ? ` toast--${variant}` : ""}`;
    el.textContent = message;
    this.root.appendChild(el);

    setTimeout(() => {
      el.style.transition = "opacity .3s ease, transform .3s ease";
      el.style.opacity = "0";
      el.style.transform = "translateY(-8px)";
      setTimeout(() => el.remove(), 320);
    }, HOLD_MS);

    // Cap the stack so a late-game burst of deaths cannot bury the screen.
    while (this.root.children.length > 4) this.root.removeChild(this.root.firstChild);
  }

  clear() {
    this.root.innerHTML = "";
  }
}
