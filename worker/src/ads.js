// ads.js — pure validation and vector matching for sponsored feed cards.

import { cosineSimilarity, vectorize } from './vectorizer.js';

export const DEFAULT_AD_MIN_SIMILARITY = 0.08;
export const DEFAULT_AD_FREQUENCY_CAP = 3;
export const DEFAULT_AD_FREQUENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AD_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function normaliseAdKeywords(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const keywords = [];
  for (const item of raw) {
    const keyword = String(item).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!keyword || keyword.length > 40 || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= 30) break;
  }
  return keywords;
}

export function isSafeAdUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isSafeAdImagePath(value) {
  if (!value) return true;
  const path = String(value);
  return path.length <= 300 && /^\/ad-assets\/[a-z0-9_./%()-]+$/i.test(path) &&
    !path.includes('..') && !path.includes('//');
}

export function buildAdVector(keywords, phraseSet = null) {
  // Vectorize each keyword/phrase independently so adjacent list items do not
  // create a fake cross-keyword bigram such as "dash platform".
  const combined = {};
  for (const keyword of normaliseAdKeywords(keywords)) {
    const vector = vectorize(keyword, phraseSet);
    for (const [index, value] of Object.entries(vector)) {
      combined[index] = (combined[index] || 0) + value;
    }
  }
  return combined;
}

/** Combine positively weighted category centroids into one user taste vector. */
export function buildUserInterestVector(interests, topology) {
  const vector = {};
  for (const [categoryId, rawScore] of Object.entries(interests || {})) {
    const score = Number(rawScore);
    const centroid = topology?.centroids?.[categoryId];
    if (!centroid || !Number.isFinite(score) || score <= 0) continue;
    for (const [index, value] of Object.entries(centroid)) {
      vector[index] = (vector[index] || 0) + Number(value) * score;
    }
  }
  return vector;
}

/** Rank eligible ads and enforce each ad's own minimum similarity. */
export function rankAdsForUser(rows, interests, topology) {
  const userVector = buildUserInterestVector(interests, topology);
  if (Object.keys(userVector).length === 0) return [];

  const ranked = [];
  for (const row of rows || []) {
    let adVector;
    try {
      adVector = JSON.parse(row.ad_vector || '{}');
    } catch {
      continue;
    }
    const similarity = cosineSimilarity(userVector, adVector);
    const threshold = Number(row.min_similarity ?? DEFAULT_AD_MIN_SIMILARITY);
    if (!Number.isFinite(similarity) || similarity < threshold) continue;
    ranked.push({ ...row, similarity });
  }
  return ranked.sort((left, right) => right.similarity - left.similarity);
}