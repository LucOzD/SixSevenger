// Verify the JavaScript VADER port matches NLTK's output exactly.
// Expected values come from gen_sentiment_expected.py.
// Run from the worker directory: npm run test:sentiment
import { readFileSync } from 'node:fs';
import { polarityScores, sentimentLabel } from './src/sentiment.js';

const expected = JSON.parse(
  readFileSync(new URL('./test-fixtures/sentiment-expected.json', import.meta.url), 'utf-8')
);

let exact = 0;
let close = 0;
const mismatches = [];

for (const { text, scores } of expected) {
  const got = polarityScores(text);

  const compoundDiff = Math.abs(got.compound - scores.compound);
  const allMatch =
    got.compound === scores.compound &&
    got.pos === scores.pos &&
    got.neg === scores.neg &&
    got.neu === scores.neu;

  if (allMatch) {
    exact++;
  } else if (compoundDiff < 0.001) {
    close++;
    mismatches.push({ text, scores, got, kind: 'rounding' });
  } else {
    mismatches.push({ text, scores, got, kind: 'MISMATCH', compoundDiff });
  }
}

const real = mismatches.filter((m) => m.kind === 'MISMATCH');

console.log(`\nCompared ${expected.length} cases against NLTK:`);
console.log(`  exact match      : ${exact}`);
console.log(`  rounding-only    : ${close}`);
console.log(`  real mismatches  : ${real.length}`);

if (real.length > 0) {
  console.log('\nMismatches:');
  for (const m of real.slice(0, 15)) {
    console.log(`\n  text: ${JSON.stringify(m.text)}`);
    console.log(`    python: compound=${m.scores.compound} pos=${m.scores.pos} neg=${m.scores.neg} neu=${m.scores.neu}`);
    console.log(`    js    : compound=${m.got.compound} pos=${m.got.pos} neg=${m.got.neg} neu=${m.got.neu}`);
  }
}

if (close > 0 && real.length === 0) {
  console.log('\nRounding-only differences (compound within 0.001):');
  for (const m of mismatches.slice(0, 5)) {
    console.log(`  ${JSON.stringify(m.text)}: python=${m.scores.compound} js=${m.got.compound}`);
  }
}

// Label agreement matters more than exact decimals for the recommender,
// since categories are bucketed positive / negative / neutral.
let labelAgree = 0;
for (const { text, scores } of expected) {
  const got = polarityScores(text);
  if (sentimentLabel(got.compound) === sentimentLabel(scores.compound)) labelAgree++;
}
console.log(`\nSentiment label agreement: ${labelAgree}/${expected.length}`);

const ok = real.length === 0 && labelAgree === expected.length;
console.log(ok ? '\nJavaScript VADER matches NLTK.\n' : '\nPort needs fixing.\n');
process.exit(ok ? 0 : 1);
