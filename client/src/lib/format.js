/** USDC has 6 decimals. */
export function formatUsdc(value, { sign = false } = {}) {
  const v = typeof value === "bigint" ? value : BigInt(value ?? 0);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / 1_000_000n;
  const cents = (abs % 1_000_000n) / 10_000n;
  const body = `$${whole}.${cents.toString().padStart(2, "0")}`;
  if (negative) return `-${body}`;
  return sign ? `+${body}` : body;
}

export function formatMon(wei, dp = 3) {
  const v = typeof wei === "bigint" ? wei : BigInt(wei ?? 0);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, dp);
  return `${whole}.${frac}`;
}

export function shortAddress(address) {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Stable per-player colour so the arena, leaderboard and toasts agree. */
const PLAYER_COLORS = [
  0x22d3ee, 0xf43f5e, 0x34d399, 0xfbbf24, 0xa78bfa, 0xfb923c, 0xf472b6, 0x60a5fa,
  0x4ade80, 0xe879f9, 0x2dd4bf, 0xfacc15, 0x818cf8, 0xfca5a5, 0x86efac, 0xc084fc,
];

export function colorForPlayer(id) {
  let hash = 0;
  const key = String(id);
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

export function cssColor(int) {
  return `#${int.toString(16).padStart(6, "0")}`;
}
