// vectorizer.js
// Pure-JavaScript replacement for scikit-learn's HashingVectorizer.
//
// The Python recommender only ever used sklearn for feature hashing — the
// clustering is hand-rolled centroid maths. Feature hashing is simple enough
// to implement directly, which removes the entire Python dependency and lets
// the recommender run inside a Cloudflare Worker.
//
// Matches the Python config:
//   n_features=4096, ngram_range=(1,2), stop_words='english',
//   alternate_sign=False, norm='l2', lowercase=True
//
// Hash indices will NOT match Python's (different hash implementation), so
// vectors are not interchangeable between the two. That's fine — the model is
// rebuilt from scratch, and only relative distances matter for clustering.

import { ENGLISH_STOP_WORDS } from './stopwords.js';

export const DEFAULT_N_FEATURES = 4096;

// ---------------------------------------------------------------------------
// MurmurHash3 (x86, 32-bit), the same family sklearn uses.
// Math.imul keeps multiplication in 32-bit space; >>> 0 forces unsigned.
// ---------------------------------------------------------------------------
export function murmurhash3_32(key, seed = 0) {
  const C1 = 0xcc9e2d51;
  const C2 = 0x1b873593;

  // Encode as UTF-8 bytes so non-ASCII text hashes consistently
  const bytes = new TextEncoder().encode(key);
  const len = bytes.length;
  const nblocks = len >> 2;

  let h1 = seed >>> 0;

  // Body — process 4-byte blocks
  for (let i = 0; i < nblocks; i++) {
    const o = i * 4;
    let k1 =
      (bytes[o] |
        (bytes[o + 1] << 8) |
        (bytes[o + 2] << 16) |
        (bytes[o + 3] << 24)) >>> 0;

    k1 = Math.imul(k1, C1) >>> 0;
    k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
    k1 = Math.imul(k1, C2) >>> 0;

    h1 = (h1 ^ k1) >>> 0;
    h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  // Tail — leftover 1-3 bytes
  let k1 = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3:
      k1 ^= bytes[tail + 2] << 16;
    // falls through
    case 2:
      k1 ^= bytes[tail + 1] << 8;
    // falls through
    case 1:
      k1 ^= bytes[tail];
      k1 = Math.imul(k1 >>> 0, C1) >>> 0;
      k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
      k1 = Math.imul(k1, C2) >>> 0;
      h1 = (h1 ^ k1) >>> 0;
  }

  // Finalisation mix
  h1 = (h1 ^ len) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
  h1 = (h1 ^ (h1 >>> 13)) >>> 0;
  h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;

  return h1 >>> 0;
}

// ---------------------------------------------------------------------------
// Tokenising — mirrors sklearn's default token_pattern r"(?u)\b\w\w+\b"
// (word characters, minimum length 2), then drops English stop words.
// ---------------------------------------------------------------------------
export function tokenize(text) {
  const matches = text.toLowerCase().match(/[a-z0-9_]{2,}/g);
  if (!matches) return [];
  return matches.filter((t) => !ENGLISH_STOP_WORDS.has(t));
}

// Build unigrams and bigrams, matching ngram_range=(1, 2).
// sklearn joins n-gram members with a single space.
export function buildNgrams(tokens) {
  const features = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) {
    features.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return features;
}

// How much weight a phrase's constituent words keep. "geometry dash" becoming
// one token should not erase "geometry" entirely — a post about geometry
// homework still deserves partial similarity — but it should not compete with
// the phrase either.
export const PHRASE_PART_WEIGHT = 0.3;

// Longest phrase length considered. Phrases can themselves be merged on a later
// pass, so a promoted "geometry_dash" plus "levels" can become a longer phrase
// over time without needing to scan further here.
const MAX_PHRASE_TOKENS = 3;

/**
 * Merge known phrases into single units, longest match first.
 *
 * @param tokens tokenised text
 * @param phraseSet Set of space-joined phrases, e.g. "geometry dash"
 * @returns [{ token, parts }] where parts is null for ordinary words
 */
export function applyPhrases(tokens, phraseSet) {
  if (!phraseSet || phraseSet.size === 0) {
    return tokens.map((t) => ({ token: t, parts: null }));
  }

  const units = [];
  let i = 0;

  while (i < tokens.length) {
    let matched = false;

    // Greedy longest match, so "six seven savant" wins over "six seven"
    for (let len = MAX_PHRASE_TOKENS; len >= 2; len--) {
      if (i + len > tokens.length) continue;
      const candidate = tokens.slice(i, i + len).join(' ');
      if (phraseSet.has(candidate)) {
        units.push({ token: candidate.replace(/ /g, '_'), parts: tokens.slice(i, i + len) });
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      units.push({ token: tokens[i], parts: null });
      i++;
    }
  }

  return units;
}

// ---------------------------------------------------------------------------
// Vectorise text into a sparse, L2-normalised map of { index: value }.
// Sparse is used rather than a 4096-length array because posts are short —
// typically well under 30 non-zero features — which keeps D1 rows small.
// ---------------------------------------------------------------------------
export function vectorize(text, phraseSet = null, nFeatures = DEFAULT_N_FEATURES) {
  const tokens = tokenize(text);
  const units = applyPhrases(tokens, phraseSet);

  // Weighted feature counts. Phrase tokens and ordinary words count 1; the
  // words making up a phrase are damped so the phrase dominates.
  const counts = new Map();
  const add = (feature, weight) => {
    const index = murmurhash3_32(feature) % nFeatures;
    counts.set(index, (counts.get(index) || 0) + weight);
  };

  for (const unit of units) {
    add(unit.token, 1);
    if (unit.parts) {
      for (const part of unit.parts) add(part, PHRASE_PART_WEIGHT);
    }
  }

  // Bigrams over the merged units, so "geometry_dash levels" is still captured
  for (let i = 0; i < units.length - 1; i++) {
    add(`${units[i].token} ${units[i + 1].token}`, 1);
  }

  // L2 normalise
  let sumSquares = 0;
  for (const value of counts.values()) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);

  const vector = {};
  if (norm === 0) return vector;
  for (const [index, value] of counts) {
    vector[index] = value / norm;
  }
  return vector;
}

// ---------------------------------------------------------------------------
// Sparse vector maths. All vectors here are plain objects keyed by index.
// ---------------------------------------------------------------------------

export function dot(a, b) {
  // Iterate the smaller vector for speed
  let [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let sum = 0;
  for (const index in small) {
    const other = large[index];
    if (other !== undefined) sum += small[index] * other;
  }
  return sum;
}

export function norm(v) {
  let sumSquares = 0;
  for (const index in v) sumSquares += v[index] * v[index];
  return Math.sqrt(sumSquares);
}

export function cosineSimilarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

// How many features two vectors have in common.
// Short posts can score a deceptively high cosine off a single shared common
// word ("best", "really"), which merges unrelated topics. Requiring a couple of
// shared features filters that out.
export function sharedFeatureCount(a, b) {
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let count = 0;
  for (const index in small) {
    if (large[index] !== undefined) count++;
  }
  return count;
}

// Weighted running mean, used to nudge a category centroid toward a new post.
// Equivalent to the Python: (centroid * n + vector) / (n + 1)
export function updateMean(centroid, vector, n) {
  const result = {};
  for (const index in centroid) {
    result[index] = (centroid[index] * n) / (n + 1);
  }
  for (const index in vector) {
    result[index] = (result[index] || 0) + vector[index] / (n + 1);
  }
  return result;
}

// Mean of several sparse vectors — used when splitting a category.
export function meanVector(vectors) {
  const result = {};
  if (vectors.length === 0) return result;
  for (const v of vectors) {
    for (const index in v) {
      result[index] = (result[index] || 0) + v[index];
    }
  }
  for (const index in result) {
    result[index] /= vectors.length;
  }
  return result;
}

// Extract hashtags from raw post text (kept identical to the Python version).
export function extractHashtags(text) {
  const matches = text.toLowerCase().match(/#([a-z0-9_]+)/g);
  if (!matches) return [];
  return matches.map((h) => h.slice(1));
}

// Clean text the same way the Python _clean() does, including the
// triple-weighting of hashtags so they dominate category assignment.
export function cleanText(text) {
  let t = text.toLowerCase();
  t = t.replace(/http\S+/g, '');
  t = t.replace(/@\w+/g, '');

  const hashtags = t.match(/#([a-z0-9_]+)/g) || [];
  const tags = hashtags.map((h) => h.slice(1));

  t = t.replace(/[^a-z0-9#\s]/g, ' ');

  if (tags.length > 0) {
    // Repeat 3x so hashtags outweigh ordinary words
    t = t + ' ' + [...tags, ...tags, ...tags].join(' ');
  }
  return t.trim();
}
