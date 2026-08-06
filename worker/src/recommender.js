// recommender.js
// JavaScript port of recommender.py — category discovery, topology and user
// interest ranking. Pure logic with no storage dependency, so it can be unit
// tested directly and persisted by the caller (see storage.js for D1 wiring).
//
// Two deliberate deviations from the Python version, both forced by running in
// a Worker rather than a long-lived process:
//
//  1. Centroids are PRUNED to the strongest CENTROID_MAX_FEATURES dimensions.
//     Averaging many sparse vectors gradually fills all 4096 dimensions; left
//     unchecked, loading every centroid on each request would mean shifting
//     hundreds of KB from the database. The discarded tail carries very little
//     weight, so cosine similarity is essentially unchanged.
//
//  2. Split sampling is deterministic (strided pairs) instead of using
//     np.random.randint, so the same input always produces the same categories
//     and the behaviour is testable.

import {
  vectorize, cleanText, extractHashtags, tokenize,
  cosineSimilarity, sharedFeatureCount, updateMean, meanVector, norm,
} from './vectorizer.js';
import { ENGLISH_STOP_WORDS } from './stopwords.js';
import { sentimentScore } from './sentiment.js';

export const DEFAULT_SIMILARITY_THRESHOLD = 0.12;
export const CENTROID_MAX_FEATURES = 128;
export const SPLIT_THRESHOLD = 15;      // posts before a split is considered
export const SPLIT_COHESION = 0.25;     // below this average similarity, split
export const MAX_TRACKED_VECTORS = 30;  // per category, for split detection
export const REBUILD_EVERY = 25;

// A category match must share at least this many features. Without it, two
// short unrelated posts sharing one common word (e.g. "best") score a high
// enough cosine to merge, which is how "geometry dash" and "coca cola" ended
// up in one category.
export const MIN_SHARED_FEATURES = 2;

// Keep only the strongest features so centroids stay small in storage.
export function pruneVector(v, maxFeatures = CENTROID_MAX_FEATURES) {
  const entries = Object.entries(v);
  if (entries.length <= maxFeatures) return { ...v };
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const pruned = {};
  for (let i = 0; i < maxFeatures; i++) {
    pruned[entries[i][0]] = entries[i][1];
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// CategoryTopology — centroids plus the pairwise similarity map
// ---------------------------------------------------------------------------
export class CategoryTopology {
  constructor(state = {}) {
    this.centroids = state.centroids || {};   // catId -> sparse vector
    this.nPosts = state.nPosts || {};         // catId -> count
    this.similarities = new Map();            // "a:b" -> similarity
    this._relationsBuilt = false;
  }

  update(catId, vector) {
    const n = this.nPosts[catId] || 0;
    if (!(catId in this.centroids)) {
      this.centroids[catId] = { ...vector };
    } else {
      this.centroids[catId] = pruneVector(updateMean(this.centroids[catId], vector, n));
    }
    this.nPosts[catId] = n + 1;
    this._relationsBuilt = false;
  }

  rebuildRelations() {
    const cats = Object.keys(this.centroids);
    this.similarities.clear();
    if (cats.length < 2) {
      this._relationsBuilt = true;
      return;
    }
    for (let i = 0; i < cats.length; i++) {
      for (let j = i + 1; j < cats.length; j++) {
        const a = cats[i];
        const b = cats[j];
        const sim = cosineSimilarity(this.centroids[a], this.centroids[b]);
        this.similarities.set(`${a}:${b}`, sim);
        this.similarities.set(`${b}:${a}`, sim);
      }
    }
    this._relationsBuilt = true;
  }

  // Mirrors the Python behaviour of rebuilding on demand when data is missing,
  // which is what stopped newly created categories showing no relationships.
  getSimilarCategories(catId, n = 5, minSimilarity = 0.01) {
    if (!this._relationsBuilt) this.rebuildRelations();

    const scores = [];
    for (const [key, sim] of this.similarities) {
      const [a, b] = key.split(':');
      if (a === String(catId) && sim >= minSimilarity) {
        scores.push([Number(b), sim]);
      }
    }
    scores.sort((x, y) => y[1] - x[1]);
    return scores.slice(0, n);
  }

  toJSON() {
    return { centroids: this.centroids, nPosts: this.nPosts };
  }
}

// ---------------------------------------------------------------------------
// PostAnalyser — assigns every post a category, splitting as they grow diverse
// ---------------------------------------------------------------------------
export class PostAnalyser {
  constructor(options = {}, state = {}) {
    this.similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.splitThreshold = options.splitThreshold ?? SPLIT_THRESHOLD;
    this.rebuildEvery = options.rebuildEvery ?? REBUILD_EVERY;

    this.topology = new CategoryTopology(state.topology);
    this.categoryWords = state.categoryWords || {};      // catId -> [words]
    this.wordCounts = state.wordCounts || {};            // catId -> {word: n}
    this.categorySentiment = state.categorySentiment || {};
    this.sentimentCounts = state.sentimentCounts || {};
    this.categoryVectors = state.categoryVectors || {};  // catId -> [vectors]
    this.nextId = state.nextId ?? 0;
    this.postCount = state.postCount ?? 0;

    // Learned collocations, e.g. "geometry dash". Merged into single tokens at
    // vectorisation time so a phrase outweighs the words composing it.
    this.phrases = state.phrases instanceof Set
      ? state.phrases
      : new Set(state.phrases || []);

    // Categories touched since load, so the caller only writes what changed
    this.dirty = new Set();
  }

  get numCategories() {
    return Object.keys(this.topology.centroids).length;
  }

  /**
   * Assign a category to a post. Always returns a real category id.
   *
   * @param text raw post text
   * @param authorContext optional { avgSentiment, topCategories } used to
   *        disambiguate vague posts from an author's history
   */
  addPost(text, authorContext = null) {
    const cleaned = cleanText(text);
    const vector = vectorize(cleaned, this.phrases);
    const rawSentiment = sentimentScore(text);

    // Lean on the author's history when the post itself is ambiguous
    let sentiment = rawSentiment;
    if (authorContext && Math.abs(rawSentiment) < 0.3) {
      const authorAvg = authorContext.avgSentiment ?? 0;
      const blend = 0.4 * (1 - Math.abs(rawSentiment) / 0.3);
      sentiment = rawSentiment * (1 - blend) + authorAvg * blend;
    }

    const { catId: bestCat, similarity: bestSim } = this.nearestCategory(vector);

    // An author who already posts in a category gets a slightly lower bar,
    // which stops one person's topic fragmenting across categories
    let threshold = this.similarityThreshold;
    if (authorContext && bestCat !== null) {
      const authorCats = authorContext.topCategories || [];
      if (authorCats.includes(bestCat)) threshold *= 0.75;
    }

    let catId;
    if (bestCat !== null && bestSim >= threshold) {
      catId = bestCat;                          // good match
    } else if (bestCat !== null && bestSim >= threshold * 0.5) {
      catId = bestCat;                          // partial match, absorb it
    } else {
      catId = this.nextId++;                    // nothing close, start fresh
    }

    this.topology.update(catId, vector);
    this.learnWords(catId, cleaned);
    this.updateCategorySentiment(catId, sentiment);
    this.trackVector(catId, vector);

    this.postCount++;
    this.dirty.add(catId);

    if (this.postCount % this.rebuildEvery === 0) {
      this.topology.rebuildRelations();
    }

    let splitInto = null;
    if ((this.topology.nPosts[catId] || 0) >= this.splitThreshold) {
      splitInto = this.maybeSplitCategory(catId);
    }

    return {
      categoryId: catId,
      vector,
      sentiment,
      hashtags: extractHashtags(text),
      splitInto, // new category id if this post triggered a split
      // Raw tokens, so the caller can fold them into the phrase counts
      tokens: tokenize(cleaned),
    };
  }

  nearestCategory(vector) {
    let bestCat = null;
    let bestSim = -1;
    if (norm(vector) === 0) return { catId: null, similarity: -1 };

    for (const catId of Object.keys(this.topology.centroids)) {
      const centroid = this.topology.centroids[catId];
      // Ignore matches resting on a single shared word
      if (sharedFeatureCount(vector, centroid) < MIN_SHARED_FEATURES) continue;

      const sim = cosineSimilarity(vector, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestCat = Number(catId);
      }
    }
    return { catId: bestCat, similarity: bestSim };
  }

  trackVector(catId, vector) {
    if (!this.categoryVectors[catId]) this.categoryVectors[catId] = [];
    this.categoryVectors[catId].push(vector);
    if (this.categoryVectors[catId].length > MAX_TRACKED_VECTORS) {
      this.categoryVectors[catId] = this.categoryVectors[catId].slice(-MAX_TRACKED_VECTORS);
    }
  }

  learnWords(catId, cleaned) {
    if (!this.wordCounts[catId]) this.wordCounts[catId] = {};
    const counts = this.wordCounts[catId];
    for (const w of cleaned.split(/\s+/)) {
      if (w.length > 1 && !ENGLISH_STOP_WORDS.has(w)) {
        counts[w] = (counts[w] || 0) + 1;
      }
    }
    this.categoryWords[catId] = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w]) => w);
  }

  updateCategorySentiment(catId, sentiment) {
    const n = this.sentimentCounts[catId] || 0;
    if (!(catId in this.categorySentiment)) {
      this.categorySentiment[catId] = sentiment;
    } else {
      this.categorySentiment[catId] =
        (this.categorySentiment[catId] * n + sentiment) / (n + 1);
    }
    this.sentimentCounts[catId] = n + 1;
  }

  getCategorySentiment(catId) {
    return this.categorySentiment[catId] ?? 0;
  }

  describe(catId) {
    const words = this.categoryWords[catId] || [];
    return words.length ? words.join(', ') : `category_${catId}`;
  }

  distinctiveWords(catA, catB, n = 6) {
    const a = this.categoryWords[catA] || [];
    const b = new Set(this.categoryWords[catB] || []);
    return a.filter((w) => !b.has(w)).slice(0, n);
  }

  /**
   * Split a category that has grown large and internally incoherent.
   * Returns the new category id, or null if no split happened.
   */
  maybeSplitCategory(catId) {
    let posts = this.categoryVectors[catId] || [];
    if (posts.length < this.splitThreshold) return null;

    posts = posts.slice(-MAX_TRACKED_VECTORS);
    this.categoryVectors[catId] = posts;

    const n = posts.length;
    if (n < 6) return null;

    // Average similarity over EVERY pair. The vector set is capped at
    // MAX_TRACKED_VECTORS (30), so this is at most 435 comparisons — cheap
    // enough to do exactly. Sampling was tried first and proved biased: any
    // scheme based on index proximity over-weights posts that arrived close
    // together, which are naturally more alike, so cohesion looked far higher
    // than it was and categories never split.
    let simTotal = 0;
    let simCount = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        simTotal += cosineSimilarity(posts[i], posts[j]);
        simCount++;
      }
    }
    if (simCount === 0) return null;

    const avgSim = simTotal / simCount;
    if (avgSim > SPLIT_COHESION) return null; // still cohesive, leave it alone

    // Seed with the two least similar posts
    let minSim = 1;
    let seedA = 0;
    let seedB = 1;
    const limit = Math.min(10, n);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        const s = cosineSimilarity(posts[i], posts[j]);
        if (s < minSim) {
          minSim = s;
          seedA = i;
          seedB = j;
        }
      }
    }

    const centroidA = posts[seedA];
    const centroidB = posts[seedB];

    let groupA = [];
    let groupB = [];
    for (const p of posts) {
      const simA = cosineSimilarity(p, centroidA);
      const simB = cosineSimilarity(p, centroidB);
      if (simA >= simB) groupA.push(p);
      else groupB.push(p);
    }

    if (groupA.length < 3 || groupB.length < 3) return null;

    // The original id keeps the larger group
    if (groupB.length > groupA.length) {
      const tmp = groupA;
      groupA = groupB;
      groupB = tmp;
    }

    const newCatId = this.nextId++;

    this.topology.centroids[catId] = pruneVector(meanVector(groupA));
    this.topology.nPosts[catId] = groupA.length;
    this.categoryVectors[catId] = groupA;

    this.topology.centroids[newCatId] = pruneVector(meanVector(groupB));
    this.topology.nPosts[newCatId] = groupB.length;
    this.categoryVectors[newCatId] = groupB;

    // The new category starts with no vocabulary; it rebuilds as posts arrive
    this.categoryWords[newCatId] = [];
    this.wordCounts[newCatId] = {};
    this.categorySentiment[newCatId] = this.categorySentiment[catId] ?? 0;
    this.sentimentCounts[newCatId] = 1;

    this.dirty.add(catId);
    this.dirty.add(newCatId);
    this.topology.rebuildRelations();

    return newCatId;
  }

  /** Category summary for the admin view. */
  categoriesOverview() {
    const out = {};
    for (const catId of Object.keys(this.topology.centroids)) {
      const id = Number(catId);
      const similar = this.topology.getSimilarCategories(id, 3);
      const sentiment = this.getCategorySentiment(id);
      out[catId] = {
        words: this.categoryWords[id] || [],
        description: this.describe(id),
        post_count: this.topology.nPosts[id] || 0,
        sentiment: sentiment >= 0.05 ? 'positive' : sentiment <= -0.05 ? 'negative' : 'neutral',
        sentiment_score: Math.round(sentiment * 1000) / 1000,
        similar_to: similar.map(([simId, simScore]) => ({
          category: simId,
          similarity: Math.round(simScore * 1000) / 1000,
          differs_by: this.distinctiveWords(id, simId),
        })),
      };
    }
    return out;
  }

  toState() {
    return {
      topology: this.topology.toJSON(),
      categoryWords: this.categoryWords,
      wordCounts: this.wordCounts,
      categorySentiment: this.categorySentiment,
      sentimentCounts: this.sentimentCounts,
      categoryVectors: this.categoryVectors,
      nextId: this.nextId,
      postCount: this.postCount,
    };
  }
}

// ---------------------------------------------------------------------------
// UserProfiler — turns per-category interest scores into a ranked feed order
// ---------------------------------------------------------------------------
export const SIGNAL_WEIGHTS = {
  like: 0.20,
  dislike: -0.25,
  comment: 0.12,
  save: 0.25,
  view: 0.02,
};

export const POST_INTEREST_WEIGHT = 0.15;

export class UserProfiler {
  /**
   * Stateless ranking, recomputed on every feed request.
   *
   * @param directScores {catId: score} from the database
   * @param topology CategoryTopology
   * @param opts.collaborative {catId: score} from users with similar taste
   * @param opts.categorySentiments {catId: avgSentiment}
   * @param opts.userSentimentPref {catId: sentiment the user engages with}
   */
  rankFromScores(directScores, topology, opts = {}) {
    const { collaborative, categorySentiments, userSentimentPref, n = 30 } = opts;

    const direct = {};
    for (const [k, v] of Object.entries(directScores || {})) {
      direct[Number(k)] = Number(v);
    }

    const allCats = new Set([
      ...Object.keys(topology.centroids).map(Number),
      ...Object.keys(direct).map(Number),
    ]);

    const scores = {};
    for (const cat of allCats) scores[cat] = direct[cat] ?? 0.01;

    // "People like you also liked"
    if (collaborative) {
      for (const [cat, collabScore] of Object.entries(collaborative)) {
        const id = Number(cat);
        scores[id] = (scores[id] ?? 0.01) + Number(collabScore) * 0.3;
      }
    }

    // The user's overall taste direction, for alignment scoring below
    let interest = null;
    for (const [cat, sc] of Object.entries(direct)) {
      const centroid = topology.centroids[cat];
      if (!centroid) continue;
      const scaled = {};
      for (const idx in centroid) scaled[idx] = centroid[idx] * sc;
      if (interest === null) {
        interest = scaled;
      } else {
        for (const idx in scaled) interest[idx] = (interest[idx] || 0) + scaled[idx];
      }
    }

    // Lift categories similar to ones the user likes
    for (const [cat, likedScore] of Object.entries(direct)) {
      if (likedScore <= 0) continue;
      for (const [simCat, simScore] of topology.getSimilarCategories(Number(cat), 5)) {
        scores[simCat] = (scores[simCat] ?? 0.01) + likedScore * simScore * 0.5;
      }
    }

    // Push down categories similar to ones they dislike
    for (const [cat, dislikedScore] of Object.entries(direct)) {
      if (dislikedScore >= 0) continue;
      for (const [simCat, simScore] of topology.getSimilarCategories(Number(cat), 5)) {
        scores[simCat] = (scores[simCat] ?? 0.01) - Math.abs(dislikedScore) * simScore * 0.4;
      }
    }

    // Same topic, opposite opinion — demote it. Someone who likes positive
    // Geometry Dash posts should not be fed the ones trashing it.
    if (categorySentiments && userSentimentPref) {
      for (const [cat, likedScore] of Object.entries(direct)) {
        if (likedScore <= 0) continue;
        const userSent = Number(userSentimentPref[cat] ?? 0);
        if (Math.abs(userSent) < 0.1) continue;

        for (const [simCat, simScore] of topology.getSimilarCategories(Number(cat), 8)) {
          const catSent = Number(categorySentiments[simCat] ?? 0);
          const product = userSent * catSent;
          if (product < -0.05) {
            const penalty = Math.abs(product) * simScore * likedScore * 0.6;
            scores[simCat] = (scores[simCat] ?? 0.01) - penalty;
          }
        }
      }
    }

    // Scale by how well each category aligns with the user's taste direction
    if (interest !== null && norm(interest) > 0) {
      for (const catId of Object.keys(topology.centroids)) {
        const alignment = cosineSimilarity(interest, topology.centroids[catId]);
        const factor = Math.max(0.05, (alignment + 1) / 2);
        const id = Number(catId);
        scores[id] = (scores[id] ?? 0.01) * factor;
      }
    }

    return Object.entries(scores)
      .map(([cat, score]) => [Number(cat), score])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }
}
