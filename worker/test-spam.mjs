import {
  IDENTICAL_POST_WINDOW_MS, SPAM_QUARANTINE_THRESHOLD, assessPostingSpam,
  communitySpamSignal, filterFeedSpam, isFeedEligiblePost, isPostingRateLimited,
  matchingIdenticalPosts, normalizeSpamText, postingCadenceSignal,
  postingLimitViolation, spamRankMultiplier,
} from './src/spam.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

const now = 1_700_000_000_000;
const post = (text, ageMs, spam_score = 0) =>
  ({ id: `${ageMs}`, text, timestamp: now - ageMs, spam_score });

console.log('\n1. Posting spam detection');
check('normalization defeats punctuation and case variation',
  normalizeSpamText('BUY!!! NOW') === normalizeSpamText('buy now'));
const retry = assessPostingSpam('same post', [post('Same post', 10_000, 0.4)], now);
check('an immediate duplicate is an idempotent retry', retry.retry?.id === '10000');
const duplicate = assessPostingSpam('same post', [post('same post', 60_000)], now);
check('a later duplicate reaches quarantine', duplicate.score >= SPAM_QUARANTINE_THRESHOLD,
  `score=${duplicate.score}`);
const burstHistory = [
  post('one', 10_000), post('two', 20_000), post('three', 30_000),
  post('four', 40_000), post('five', 50_000),
];
const burst = assessPostingSpam('new message', burstHistory, now);
check('the sixth post in two minutes is hidden as a rapid burst', burst.score >= 0.9,
  `score=${burst.score}`);
check('the first five posts in a rolling minute are allowed',
  !isPostingRateLimited(burstHistory.slice(0, 4), now));
check('a sixth attempted post sees five existing rows and is rate limited',
  isPostingRateLimited(burstHistory, now));

const establishedCreated = now - 2 * 24 * 60 * 60 * 1000;
const hourlyHistory = Array.from({ length: 15 }, (_, index) =>
  post(`hourly ${index}`, (index + 1) * 4 * 60_000));
check('an established account can make its first fifteen hourly posts',
  postingLimitViolation(hourlyHistory.slice(0, 14), establishedCreated, now) === null);
check('the next established-account hourly post is blocked',
  postingLimitViolation(hourlyHistory, establishedCreated, now)?.code ===
    'POSTING_LONG_RATE_LIMIT');
const probationHistory = Array.from({ length: 8 }, (_, index) =>
  post(`probation ${index}`, (index + 1) * 7 * 60_000));
check('new accounts receive a stricter hourly probation budget',
  postingLimitViolation(probationHistory, now - 60_000, now)?.code ===
    'POSTING_PROBATION_LIMIT');

const timerHistory = Array.from({ length: 6 }, (_, index) =>
  post(`generated realistic message ${index}`, (index + 1) * 5 * 60_000));
check('a low-variance posting timer produces an automation signal',
  postingCadenceSignal(timerHistory, now) >= 0.65);
const timerAssessment = assessPostingSpam('another realistic generated message', timerHistory, now);
check('timer cadence plus sustained volume reaches quarantine',
  timerAssessment.score >= SPAM_QUARANTINE_THRESHOLD &&
  timerAssessment.reasons.includes('machine-like posting cadence'),
  `score=${timerAssessment.score}`);
const irregularHistory = [1, 3, 10, 18, 40, 55].map((minutes, index) =>
  post(`human ${index}`, minutes * 60_000));
check('irregular human timing does not trigger cadence detection',
  postingCadenceSignal(irregularHistory, now) === 0);

const identicalHistory = [
  post('SAME post!', 31_000), post('same POST', 60_000),
  post('same post', 120_000), post('same post', IDENTICAL_POST_WINDOW_MS),
  post('same post', IDENTICAL_POST_WINDOW_MS + 1),
];
check('identical matching normalizes case and punctuation',
  matchingIdenticalPosts('same post', identicalHistory, now).length === 4);
check('posts outside five hours do not count as identical',
  !matchingIdenticalPosts('same post', identicalHistory, now)
    .some((item) => item.id === String(IDENTICAL_POST_WINDOW_MS + 1)));
check('the retry window takes precedence over duplicate enforcement',
  assessPostingSpam('same post', [post('SAME POST!', 20_000), ...identicalHistory], now)
    .retry?.id === '20000');

console.log('\n2. Feed safety filtering');
const feedPost = (id, userId, text, ageMs, overrides = {}) => ({
  id, userId, text, timestamp: now - ageMs, deleted: 0,
  category_id: 1, spam_score: 0, ...overrides,
});
check('a clean categorized post is feed eligible',
  isFeedEligiblePost(feedPost('clean', 'u1', 'hello', 1000)));
check('quarantined, deleted, uncategorized and invalid-score posts are ineligible',
  [
    feedPost('q', 'u1', 'q', 1000, { spam_score: 0.70 }),
    feedPost('d', 'u1', 'd', 1000, { deleted: 1 }),
    feedPost('c', 'u1', 'c', 1000, { category_id: -1 }),
    feedPost('n', 'u1', 'n', 1000, { spam_score: null }),
  ].every((item) => !isFeedEligiblePost(item)));
const legacyDuplicates = Array.from({ length: 5 }, (_, index) =>
  feedPost(`duplicate-${index}`, 'legacy', 'BUY this now!', index * 60_000));
check('a five-copy legacy set is removed even when every stored score is zero',
  filterFeedSpam(legacyDuplicates).length === 0);
const legacyBurst = Array.from({ length: 6 }, (_, index) =>
  feedPost(`burst-${index}`, 'flooder', `different ${index}`, index * 9000));
check('a six-post legacy burst is removed even when its text differs',
  filterFeedSpam(legacyBurst).length === 0);
check('four spaced duplicate posts do not trigger feed-set removal',
  filterFeedSpam(legacyDuplicates.slice(0, 4)).length === 4);

console.log('\n3. Community evidence and ranking punishment');
check('a few dislikes cannot classify spam', communitySpamSignal({ likes: 0, dislikes: 4 }) === 0);
check('strong community rejection contributes a severe signal',
  communitySpamSignal({ likes: 1, dislikes: 9 }) >= 0.85);
check('clean content keeps its full rank', spamRankMultiplier(0) === 1);
check('moderate spam loses over 90% of its rank', spamRankMultiplier(0.5) < 0.1,
  `multiplier=${spamRankMultiplier(0.5)}`);
check('near-quarantine spam loses over 99% of its rank', spamRankMultiplier(0.69) < 0.01,
  `multiplier=${spamRankMultiplier(0.69)}`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);