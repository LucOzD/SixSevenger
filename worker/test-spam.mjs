import {
  SPAM_QUARANTINE_THRESHOLD, assessPostingSpam, communitySpamSignal,
  normalizeSpamText, spamRankMultiplier,
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
const burst = assessPostingSpam('new message', [
  post('one', 10_000), post('two', 20_000), post('three', 30_000),
  post('four', 40_000), post('five', 50_000),
], now);
check('the sixth post in two minutes is hidden as a rapid burst', burst.score >= 0.9,
  `score=${burst.score}`);

console.log('\n2. Community evidence and ranking punishment');
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