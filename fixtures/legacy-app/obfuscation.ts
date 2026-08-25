/**
 * Per-boot cosmetic instability.
 *
 * This is the thesis of the whole project rendered as a fixture: CSS class names and generated
 * element ids are REGENERATED FROM A SEED ON EVERY BOOT, while roles, accessible names, visible
 * label text and legacy `name=` attributes stay exactly the same.
 *
 * A selector-based recording breaks the first time this app restarts. An accessibility-first
 * capability does not notice. The seed is logged and served from GET /__test__/seed so that a
 * restart can be PROVEN to have changed the cosmetics - PHASE 10 uses it as evidence rather than
 * asking a reader to take it on faith.
 */

const TOKEN_HEAD = 'abcdefghijklmnopqrstuvwxyz';
const TOKEN_TAIL = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface Obfuscation {
  readonly seed: number;
  /** A per-boot CSS class token for a logical element. Stable within a boot, different across boots. */
  cls(logicalName: string): string;
  /** A per-boot element id with a randomized numeric suffix, ASP-style. */
  id(logicalName: string): string;
}

/** mulberry32 - small, deterministic, and dependency-free. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random: () => number, alphabet: string): string {
  const index = Math.floor(random() * alphabet.length);
  return alphabet[Math.min(index, alphabet.length - 1)] ?? alphabet[0] ?? 'x';
}

export function createObfuscation(seed: number): Obfuscation {
  const random = mulberry32(seed);
  const classCache = new Map<string, string>();
  const idCache = new Map<string, string>();

  return {
    seed,

    cls(logicalName: string): string {
      const cached = classCache.get(logicalName);
      if (cached !== undefined) return cached;

      let token = pick(random, TOKEN_HEAD);
      for (let i = 0; i < 5; i += 1) token += pick(random, TOKEN_TAIL);
      classCache.set(logicalName, token);
      return token;
    },

    id(logicalName: string): string {
      const cached = idCache.get(logicalName);
      if (cached !== undefined) return cached;

      const suffix = 100000 + Math.floor(random() * 899999);
      const value = `ctl_${suffix}`;
      idCache.set(logicalName, value);
      return value;
    },
  };
}
