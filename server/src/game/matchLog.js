import { keccak256, toHex, concatHex } from "viem";

/**
 * Append-only log of everything that decided the outcome of a match, plus the
 * Merkle root committed on chain by `finalizeMatch`.
 *
 * This is the whole of the trust model in PRD §5.4. The relayer is a trusted
 * oracle: nothing on chain proves a kill really happened. What we can offer
 * instead of trustlessness is verifiability after the fact. The log records the
 * map seed and every state-changing event, so a third party can replay the match
 * deterministically and check that the committed root matches what they compute.
 * Anyone can therefore prove a relayer cheated, even though nobody can stop it
 * in real time.
 */
export class MatchLog {
  constructor(matchId, seed) {
    this.matchId = matchId;
    this.seed = seed;
    this.entries = [];
    this.append("match_seed", { seed });
  }

  append(type, data) {
    const entry = {
      seq: this.entries.length,
      type,
      at: Date.now(),
      ...data,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Canonical, stable serialisation. Key order must not depend on insertion
   *  order or two honest verifiers would compute different roots. */
  static leafHash(entry) {
    const canonical = JSON.stringify(entry, Object.keys(entry).sort());
    return keccak256(toHex(canonical));
  }

  /**
   * Standard binary Merkle root over keccak256 leaves. An odd node at any level
   * is promoted rather than duplicated: duplicating the last leaf allows two
   * different logs to produce the same root.
   */
  root() {
    if (this.entries.length === 0) {
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }

    let level = this.entries.map((e) => MatchLog.leafHash(e));

    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 === level.length) {
          next.push(level[i]);
        } else {
          next.push(keccak256(concatHex([level[i], level[i + 1]])));
        }
      }
      level = next;
    }

    return level[0];
  }

  toJSON() {
    return {
      matchId: this.matchId,
      seed: this.seed,
      logRoot: this.root(),
      entryCount: this.entries.length,
      entries: this.entries,
    };
  }
}
