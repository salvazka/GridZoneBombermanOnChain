/** Runs `fn` over `items` with at most `limit` in flight.
 *  Public RPC endpoints rate-limit aggressively, and firing one request per
 *  relayer key at once is enough to trip it. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (err) {
        results[index] = { status: "rejected", reason: err };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** Retries on transient failures with linear backoff. */
export async function withRetry(fn, { attempts = 3, delayMs = 600, label = "op" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  lastError.message = `${label} failed after ${attempts} attempts: ${lastError.message}`;
  throw lastError;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
