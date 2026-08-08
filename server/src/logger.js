const stamp = () => new Date().toISOString().slice(11, 23);

function emit(level, color, args) {
  // eslint-disable-next-line no-console
  console.log(`\x1b[90m${stamp()}\x1b[0m ${color}${level}\x1b[0m`, ...args);
}

export const log = {
  info: (...args) => emit("INFO ", "\x1b[36m", args),
  warn: (...args) => emit("WARN ", "\x1b[33m", args),
  error: (...args) => emit("ERROR", "\x1b[31m", args),
  chain: (...args) => emit("CHAIN", "\x1b[35m", args),
  game: (...args) => emit("GAME ", "\x1b[32m", args),
};
