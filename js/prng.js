// Picture Logic — seeded PRNG streams.
// Separate streams are used for rules, content decoration, and audiovisual
// variants so cosmetic randomness can never influence rules outcomes.
'use strict';

// Mulberry32: small, fast, deterministic 32-bit seeded generator.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A named, serializable random stream.
export class Rng {
  constructor(seed, label = 'stream') {
    this.seed = seed >>> 0;
    this.label = label;
    this.next = mulberry32(this.seed);
    this.draws = 0;
  }
  float() { this.draws++; return this.next(); }
  int(min, max) { return min + Math.floor(this.float() * (max - min + 1)); } // inclusive
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  chance(p) { return this.float() < p; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  fork(label) { return new Rng((this.seed ^ 0x9E3779B9 ^ (this.draws * 2654435761)) >>> 0, label); }
}

// Stable 32-bit FNV-1a hash of a string. Used for save checksums,
// replay state hashes and seed derivation from date keys.
export function fnv1a(str) {
  let h = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashSeed(text) { return fnv1a(String(text)); }
