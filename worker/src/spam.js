// High-confidence anti-spam scoring shared by post creation, voting and feeds.

export const SPAM_HIDE_THRESHOLD = 0.90;
export const SPAM_QUARANTINE_THRESHOLD = 0.70;
export const POST_RATE_LIMIT = 5;
export const POST_RATE_WINDOW_MS = 60_000;
export const POST_MUTE_MS = 5 * 60_000;
export const IDENTICAL_POST_WINDOW_MS = 5 * 60 * 60 * 1000;
export const ACCOUNT_PROBATION_MS = 24 * 60 * 60 * 1000;
export const POST_VIOLATION_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FEED_BURST_WINDOW_MS = 60_000;
const RETRY_WINDOW_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeSpamText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function words(text) {
  return new Set(normalizeSpamText(text).split(' ').filter((word) => word.length > 1));
}

function nearDuplicate(a, b) {
  const left = words(a);
  const right = words(b);
  if (left.size < 5 || right.size < 5) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared) >= 0.82;
}

function combineSignals(signals) {
  return Math.min(0.99, 1 - signals.reduce((remaining, signal) =>
    remaining * (1 - Math.max(0, Math.min(0.99, signal))), 1));
}

export function isPostingRateLimited(recentPosts = [], now = Date.now()) {
  const count = recentPosts.filter((post) => {
    const age = now - Number(post.timestamp);
    return age >= 0 && age <= POST_RATE_WINDOW_MS;
  }).length;
  return count >= POST_RATE_LIMIT;
}

export function postingLimitViolation(
  recentPosts = [],
  userCreated = null,
  now = Date.now()
) {
  const created = Number(userCreated);
  const probation = Number.isFinite(created) && created > 0 && now - created < ACCOUNT_PROBATION_MS;
  const limits = probation
    ? [
        { windowMs: 10 * 60_000, limit: 5, muteMs: 30 * 60_000, code: 'POSTING_PROBATION_LIMIT' },
        { windowMs: HOUR_MS, limit: 8, muteMs: 2 * HOUR_MS, code: 'POSTING_PROBATION_LIMIT' },
        { windowMs: DAY_MS, limit: 20, muteMs: DAY_MS, code: 'POSTING_PROBATION_LIMIT' },
      ]
    : [
        { windowMs: 10 * 60_000, limit: 8, muteMs: 30 * 60_000, code: 'POSTING_LONG_RATE_LIMIT' },
        { windowMs: HOUR_MS, limit: 15, muteMs: 2 * HOUR_MS, code: 'POSTING_LONG_RATE_LIMIT' },
        { windowMs: DAY_MS, limit: 40, muteMs: DAY_MS, code: 'POSTING_LONG_RATE_LIMIT' },
      ];

  for (const limit of limits) {
    const count = recentPosts.filter((post) => {
      const age = now - Number(post.timestamp);
      return age >= 0 && age <= limit.windowMs;
    }).length;
    if (count >= limit.limit) return { ...limit, count, probation };
  }
  return null;
}

/** Regular timing is weak evidence only; volume combines with it below. */
export function postingCadenceSignal(recentPosts = [], now = Date.now()) {
  const timestamps = recentPosts
    .map((post) => Number(post.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= DAY_MS)
    .sort((a, b) => a - b);
  timestamps.push(now);
  if (timestamps.length < 7) return 0;

  const intervals = [];
  for (let index = 1; index < timestamps.length; index++) {
    intervals.push(timestamps[index] - timestamps[index - 1]);
  }
  const sample = intervals.slice(-8);
  const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
  if (mean < 30_000 || mean > 30 * 60_000) return 0;

  const variance = sample.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
    sample.length;
  const coefficientOfVariation = Math.sqrt(variance) / mean;
  if (coefficientOfVariation <= 0.08) return 0.65;
  if (coefficientOfVariation <= 0.16) return 0.50;
  return 0;
}

export function findPostingRetry(text, recentPosts = [], now = Date.now()) {
  const normalized = normalizeSpamText(text);
  return recentPosts.find((post) =>
    normalizeSpamText(post.text) === normalized &&
    now - Number(post.timestamp) >= 0 &&
    now - Number(post.timestamp) <= RETRY_WINDOW_MS
  ) || null;
}

export function matchingIdenticalPosts(
  text,
  recentPosts = [],
  now = Date.now(),
  windowMs = IDENTICAL_POST_WINDOW_MS
) {
  const normalized = normalizeSpamText(text);
  return recentPosts.filter((post) =>
    normalizeSpamText(post.text) === normalized &&
    now - Number(post.timestamp) >= 0 &&
    now - Number(post.timestamp) <= windowMs
  );
}

export function assessPostingSpam(text, recentPosts = [], now = Date.now()) {
  const normalized = normalizeSpamText(text);
  const recent = recentPosts.filter((post) => {
    const age = now - Number(post.timestamp);
    return age >= 0 && age <= DAY_MS;
  });
  const retry = findPostingRetry(text, recent, now);
  if (retry) return { score: Number(retry.spam_score) || 0, retry, reasons: ['retry'] };

  const signals = [];
  const reasons = [];
  const inTwoMinutes = recent.filter((post) => now - Number(post.timestamp) <= 120_000).length;
  const inTenMinutes = recent.filter((post) => now - Number(post.timestamp) <= 600_000).length;
  if (inTwoMinutes >= 7) { signals.push(0.98); reasons.push('extreme burst'); }
  else if (inTwoMinutes >= 5) { signals.push(0.90); reasons.push('rapid burst'); }
  else if (inTwoMinutes >= 3) { signals.push(0.40); reasons.push('fast posting'); }
  if (inTenMinutes >= 12) { signals.push(0.98); reasons.push('sustained flood'); }
  else if (inTenMinutes >= 8) { signals.push(0.85); reasons.push('posting flood'); }
  else if (inTenMinutes >= 5) { signals.push(0.45); reasons.push('high posting rate'); }

  const inOneHour = recent.filter((post) => now - Number(post.timestamp) <= HOUR_MS).length;
  if (inOneHour >= 12) { signals.push(0.95); reasons.push('hourly automation volume'); }
  else if (inOneHour >= 8) { signals.push(0.75); reasons.push('very high hourly volume'); }
  else if (inOneHour >= 6) { signals.push(0.45); reasons.push('high hourly volume'); }

  const inOneDay = recent.length;
  if (inOneDay >= 30) { signals.push(0.95); reasons.push('daily automation volume'); }
  else if (inOneDay >= 20) { signals.push(0.75); reasons.push('very high daily volume'); }
  else if (inOneDay >= 12) { signals.push(0.35); reasons.push('high daily volume'); }

  const cadence = postingCadenceSignal(recent, now);
  if (cadence > 0) {
    signals.push(cadence);
    reasons.push('machine-like posting cadence');
  }

  const exactCount = recent.filter((post) => normalizeSpamText(post.text) === normalized).length;
  const nearCount = recent.filter((post) =>
    normalizeSpamText(post.text) !== normalized && nearDuplicate(post.text, text)).length;
  if (exactCount >= 2) { signals.push(0.98); reasons.push('repeated duplicate'); }
  else if (exactCount === 1) { signals.push(0.70); reasons.push('duplicate'); }
  if (nearCount >= 2) { signals.push(0.92); reasons.push('repeated near-duplicate'); }
  else if (nearCount === 1) { signals.push(0.55); reasons.push('near-duplicate'); }

  return { score: combineSignals(signals), retry: null, reasons };
}

export function communitySpamSignal({ likes = 0, dislikes = 0 } = {}) {
  const total = Number(likes) + Number(dislikes);
  if (total < 5) return 0;
  const ratio = Number(dislikes) / total;
  if (total >= 10 && ratio >= 0.85) return 0.85;
  if (ratio >= 0.80) return 0.75;
  if (ratio >= 0.65) return 0.45;
  return 0;
}

export function assessExistingSpam(post, priorPosts, votes) {
  // Move outside the retry window while preserving the post's creation-time
  // burst window, then combine behavior and recalculable community evidence.
  const behavior = assessPostingSpam(post.text, priorPosts, Number(post.timestamp) + 30_001);
  const community = communitySpamSignal(votes);
  return {
    score: combineSignals([behavior.score, community]),
    reasons: [...behavior.reasons, ...(community ? ['community reports'] : [])],
  };
}

export function isFeedEligiblePost(post) {
  if (!post || Number(post.deleted) !== 0) return false;
  const categoryId = Number(post.category_id);
  if (!Number.isFinite(categoryId) || categoryId < 0) return false;
  if (post.spam_score === null || post.spam_score === undefined) return false;
  const score = Number(post.spam_score);
  return Number.isFinite(score) && score >= 0 && score < SPAM_QUARANTINE_THRESHOLD;
}

function markDenseWindows(posts, windowMs, minimumCount, blocked) {
  const sorted = [...posts].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (Number(sorted[right].timestamp) - Number(sorted[left].timestamp) > windowMs) left++;
    if (right - left + 1 < minimumCount) continue;
    for (let index = left; index <= right; index++) blocked.add(sorted[index].id);
  }
}

/**
 * Defense-in-depth for legacy rows whose stored spam score predates the current
 * detector. Remove complete five-copy sets and six-post/minute author bursts
 * from a candidate page rather than merely sorting them lower.
 */
export function filterFeedSpam(posts = []) {
  const eligible = posts.filter(isFeedEligiblePost);
  const blocked = new Set();
  const byAuthor = new Map();
  const identical = new Map();

  for (const post of eligible) {
    if (!byAuthor.has(post.userId)) byAuthor.set(post.userId, []);
    byAuthor.get(post.userId).push(post);

    const key = `${post.userId}\u0000${normalizeSpamText(post.text)}`;
    if (!identical.has(key)) identical.set(key, []);
    identical.get(key).push(post);
  }

  for (const group of identical.values()) {
    markDenseWindows(group, IDENTICAL_POST_WINDOW_MS, 5, blocked);
  }
  for (const group of byAuthor.values()) {
    markDenseWindows(group, FEED_BURST_WINDOW_MS, POST_RATE_LIMIT + 1, blocked);
  }

  return eligible.filter((post) => !blocked.has(post.id));
}

/** Apply spam to the complete score, including recency and social proof. */
export function spamRankMultiplier(score) {
  const clamped = Math.max(0, Math.min(1, Number(score) || 0));
  return Math.pow(1 - clamped, 4);
}