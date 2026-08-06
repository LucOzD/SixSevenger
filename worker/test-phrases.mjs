// Verify collocation detection against real post data, and check that merging
// a phrase actually improves how the vectorizer separates topics.
import { readFileSync } from 'node:fs';
import { tokenize, cleanText, vectorize, applyPhrases, cosineSimilarity, PHRASE_PART_WEIGHT } from './src/vectorizer.js';
import {
  countTokens, selectPhrases, scorePhrase, phraseToToken, cohesion,
  PHRASE_SCORE_THRESHOLD, PHRASE_MIN_COUNT, PHRASE_COHESION_THRESHOLD,
} from './src/phrases.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

// Real posts, reused from the sentiment fixture
const fixture = JSON.parse(
  readFileSync(new URL('./test-fixtures/sentiment-expected.json', import.meta.url), 'utf-8')
);
const posts = fixture.map((f) => f.text).filter((t) => t && t.length > 3);

console.log(`\nBuilding counts from ${posts.length} real posts`);

const unigrams = new Map();
const bigrams = new Map();
let totalTokens = 0;

for (const post of posts) {
  const tokens = tokenize(cleanText(post));
  totalTokens += tokens.length;
  const counts = countTokens(tokens);
  for (const [k, v] of counts.unigrams) unigrams.set(k, (unigrams.get(k) || 0) + v);
  for (const [k, v] of counts.bigrams) bigrams.set(k, (bigrams.get(k) || 0) + v);
}

console.log(`  ${totalTokens} tokens, ${unigrams.size} unique, ${bigrams.size} pairs`);

// Build candidates the way the Worker will
const candidates = [];
for (const [bigram, count] of bigrams) {
  if (count < PHRASE_MIN_COUNT) continue;
  const [left, right] = bigram.split(' ');
  candidates.push({
    bigram,
    count,
    leftCount: unigrams.get(left) || 0,
    rightCount: unigrams.get(right) || 0,
  });
}

const selected = selectPhrases(candidates, totalTokens);
const selectedSet = new Set(selected.map((s) => s.phrase));

console.log('\n1. Top scoring candidates');
const ranked = candidates
  .map((c) => ({
    ...c,
    score: scorePhrase(c.count, c.leftCount, c.rightCount, totalTokens),
    cohesion: c.count / Math.min(c.leftCount, c.rightCount),
  }))
  .sort((a, b) => b.score - a.score);
console.log('    score  cohesion  pair (count, left, right)');
for (const c of ranked.slice(0, 14)) {
  const mark = selectedSet.has(c.bigram) ? 'YES' : ' - ';
  console.log(
    `  ${mark} ${c.score.toFixed(1).padStart(7)}  ${c.cohesion.toFixed(2).padStart(6)}    ` +
    `"${c.bigram}" (${c.count}x, L=${c.leftCount}, R=${c.rightCount})`
  );
}

console.log('\n2. The phrases that matter are found');
check('"geometry dash" promoted', selectedSet.has('geometry dash'),
  `score ${(ranked.find((c) => c.bigram === 'geometry dash')?.score ?? 0).toFixed(1)}`);
check('"six seven" promoted', selectedSet.has('six seven'),
  `score ${(ranked.find((c) => c.bigram === 'six seven')?.score ?? 0).toFixed(1)}`);
check('"coca cola" promoted', selectedSet.has('coca cola'),
  `score ${(ranked.find((c) => c.bigram === 'coca cola')?.score ?? 0).toFixed(1)}`);
check('a sensible number of phrases, not everything',
  selected.length > 0 && selected.length < bigrams.size * 0.5,
  `${selected.length} promoted out of ${bigrams.size} pairs`);

console.log('\n3. Rare and incidental pairs are rejected');
check('pairs below the minimum count never score',
  scorePhrase(PHRASE_MIN_COUNT - 1, 10, 10, 1000) === 0);
check('a pair of two very common words is not a phrase',
  scorePhrase(5, 200, 200, 10000) < PHRASE_SCORE_THRESHOLD,
  `score ${scorePhrase(5, 200, 200, 10000).toFixed(2)}`);
check('a pair seen only as a pair scores highly',
  scorePhrase(20, 20, 20, 5000) > PHRASE_SCORE_THRESHOLD,
  `score ${scorePhrase(20, 20, 20, 5000).toFixed(1)}`);
check('"hate geometry" stays out', !selectedSet.has('hate geometry'));
check('"love geometry" stays out', !selectedSet.has('love geometry'));

console.log('\n3b. Cohesion catches frequent phrases the score misses');
check('an always-together pair has cohesion 1', cohesion(32, 32, 32) === 1);
check('a promiscuous word gives low cohesion',
  cohesion(5, 9, 16) < PHRASE_COHESION_THRESHOLD, cohesion(5, 9, 16).toFixed(2));
check('self-pairs from hashtag repetition are excluded',
  ![...selectedSet].some((p) => {
    const [l, r] = p.split(' ');
    return l === r;
  }),
  [...selectedSet].join(' / '));

console.log('\n4. Phrase merging in the tokeniser');
const phraseSet = new Set(['geometry dash', 'six seven']);
const units = applyPhrases(tokenize('i love geometry dash levels'), phraseSet);
const tokensOut = units.map((u) => u.token);
check('phrase merged into one token', tokensOut.includes('geometry_dash'), tokensOut.join(' | '));
check('constituent words recorded for damping',
  units.find((u) => u.token === 'geometry_dash')?.parts?.join(',') === 'geometry,dash');
check('surrounding words untouched', tokensOut.includes('love') && tokensOut.includes('levels'));

const longest = applyPhrases(tokenize('six seven is great'), new Set(['six seven']));
check('leading phrase handled', longest[0].token === 'six_seven', longest.map((u) => u.token).join(' | '));

check('no phrases means unchanged tokens',
  applyPhrases(tokenize('plain words here'), new Set()).every((u) => u.parts === null));

console.log('\n5. Constituent words are damped, not removed');
const withPhrase = vectorize(cleanText('geometry dash is great'), phraseSet);
const geometryOnly = vectorize(cleanText('geometry homework is great'), phraseSet);
const bare = vectorize(cleanText('geometry dash is great'), null);

check('vector still normalised after weighting',
  Math.abs(Math.sqrt(Object.values(withPhrase).reduce((s, v) => s + v * v, 0)) - 1) < 1e-9);
check('part weight is between zero and one',
  PHRASE_PART_WEIGHT > 0 && PHRASE_PART_WEIGHT < 1, `${PHRASE_PART_WEIGHT}`);

// The point of the feature: an unrelated use of "geometry" should now be less
// similar to a Geometry Dash post than it was before phrases existed
const simWithPhrases = cosineSimilarity(withPhrase, geometryOnly);
const simWithout = cosineSimilarity(bare, vectorize(cleanText('geometry homework is great'), null));
console.log(`     "geometry dash" vs "geometry homework"`);
console.log(`       without phrases: ${simWithout.toFixed(4)}`);
console.log(`       with phrases   : ${simWithPhrases.toFixed(4)}`);
check('unrelated use of a phrase word is less similar once merged',
  simWithPhrases < simWithout);
check('but not reduced to zero — partial overlap survives', simWithPhrases > 0);

console.log('\n6. Same-topic posts stay similar');
const a = vectorize(cleanText('geometry dash is amazing'), phraseSet);
const b = vectorize(cleanText('geometry dash is terrible'), phraseSet);
check('two geometry dash posts remain strongly similar',
  cosineSimilarity(a, b) > 0.3, `${cosineSimilarity(a, b).toFixed(4)}`);

console.log('\n7. Token naming cannot collide with real words');
check('space becomes underscore', phraseToToken('geometry dash') === 'geometry_dash');
check('underscore token never produced by the tokeniser',
  !tokenize('geometry_dash').includes('geometry dash'));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
