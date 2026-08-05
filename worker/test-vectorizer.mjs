// Verify the JS vectorizer reproduces the clustering behaviour the Python
// HashingVectorizer gave us. Run: node worker/test-vectorizer.mjs
import {
  vectorize, cosineSimilarity, norm, murmurhash3_32,
  tokenize, buildNgrams, cleanText, extractHashtags, updateMean, meanVector,
} from './src/vectorizer.js';

let failures = 0;
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n1. Hash determinism and range');
const h1 = murmurhash3_32('geometry dash');
const h2 = murmurhash3_32('geometry dash');
check('same input gives same hash', h1 === h2, `${h1}`);
check('different input gives different hash', murmurhash3_32('coca cola') !== h1);
check('hash is unsigned 32-bit', h1 >= 0 && h1 <= 0xffffffff);

console.log('\n2. Tokenising drops stop words and short tokens');
const toks = tokenize('I love the six seven so much');
check('stop words removed', !toks.includes('the') && !toks.includes('so'));
check('"six" removed (it is a sklearn stop word)', !toks.includes('six'), toks.join(','));
check('"seven" kept', toks.includes('seven'));
check('content words kept', toks.includes('love') && toks.includes('seven'));

console.log('\n3. Bigrams are generated');
const grams = buildNgrams(['geometry', 'dash', 'levels']);
check('unigrams present', grams.includes('geometry'));
check('bigrams present', grams.includes('geometry dash'), grams.join(' | '));

console.log('\n4. L2 normalisation');
const v = vectorize('i love geometry dash so much');
check('norm is 1.0', Math.abs(norm(v) - 1) < 1e-9, `norm=${norm(v).toFixed(6)}`);
check('vector is sparse', Object.keys(v).length < 30, `${Object.keys(v).length} features`);
check('empty text gives empty vector', Object.keys(vectorize('')).length === 0);

console.log('\n5. Hashtags get triple weight');
const cleaned = cleanText('i love #geometrydash so much');
const tagCount = (cleaned.match(/geometrydash/g) || []).length;
check('hashtag repeated 3x plus original', tagCount === 4, `appears ${tagCount}x`);
check('extractHashtags works', extractHashtags('#PaulHogan and #cocacola').join(',') === 'paulhogan,cocacola');

console.log('\n6. Topic clustering — the behaviour that actually matters');
const gd = [
  'i love geometry dash', 'geometry dash is peak gaming',
  'geometry dash levels are fun', 'i hate geometry dash',
];
const cola = [
  'coca cola is the best drink', 'i love drinking coca cola',
  'coca cola is disgusting', 'coca cola tastes great',
];

function avgSim(a, b) {
  let total = 0, n = 0;
  for (const x of a) for (const y of b) {
    if (x === y) continue;
    total += cosineSimilarity(vectorize(x), vectorize(y));
    n++;
  }
  return total / n;
}

const withinGd = avgSim(gd, gd);
const withinCola = avgSim(cola, cola);
const across = avgSim(gd, cola);

console.log(`     within geometry dash : ${withinGd.toFixed(4)}`);
console.log(`     within coca cola     : ${withinCola.toFixed(4)}`);
console.log(`     across topics        : ${across.toFixed(4)}`);

check('same-topic similarity beats cross-topic', withinGd > across && withinCola > across);
check('same-topic clears 0.12 threshold', withinGd > 0.12 && withinCola > 0.12);
check('cross-topic falls below 0.12 threshold', across < 0.12);

console.log('\n7. Centroid maths');
const a = vectorize('geometry dash is great');
const b = vectorize('geometry dash is fun');
const centroid = updateMean(a, b, 1);
check('centroid sits between its members',
  cosineSimilarity(centroid, a) > 0.3 && cosineSimilarity(centroid, b) > 0.3,
  `simA=${cosineSimilarity(centroid, a).toFixed(3)} simB=${cosineSimilarity(centroid, b).toFixed(3)}`);
const mv = meanVector([a, b]);
check('meanVector agrees with updateMean', cosineSimilarity(mv, centroid) > 0.999);

console.log(failures === 0
  ? '\nAll checks passed.\n'
  : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
