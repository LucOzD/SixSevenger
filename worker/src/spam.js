// High-confidence anti-spam scoring shared by post creation, voting and feeds.

export const SPAM_HIDE_THRESHOLD = 0.90;
export const SPAM_QUARANTINE_THRESHOLD = 0.70;
export const POST_RATE_LIMIT = 5;
export const POST_RATE_WINDOW_MS = 60_000;
export const POST_MUTE_MS = 5 * 60_000;
export const IDENTICAL_POST_WINDOW_MS = 5 * 60 * 60 * 1000;
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
  const recent = recentPosts.filter((post) => now - Number(post.timestamp) <= DAY_MS);
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

/** Apply spam to the complete score, including recency and social proof. */
export function spamRankMultiplier(score) {
  const clamped = Math.max(0, Math.min(1, Number(score) || 0));
  return Math.pow(1 - clamped, 4);
}