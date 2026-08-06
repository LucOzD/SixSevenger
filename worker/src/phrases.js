// phrases.js
// Collocation detection: finds word pairs that occur together far more often
// than chance and promotes them to single tokens.
//
// Without this, "geometry dash" competes with "geometry" and "dash" as three
// separate equal-weight features, so a post mentioning geometry in another
// context looks similar to a Geometry Dash post. Once promoted, the phrase
// carries the weight and its parts are damped.
//
// Scoring follows Mikolov et al.'s phrase measure from the word2vec paper:
//
//     score(a,b) = (count(ab) - discount) / (count(a) * count(b)) * totalTokens
//
// The discount is what stops two words that happened to appear side by side
// once from being treated as a phrase. Dividing by the individual counts is
// what stops common words pairing with everything.

// A pair must appear at least this many times to be considered at all
export const PHRASE_MIN_COUNT = 3;

// Subtracted from the pair count, so rare pairs score at or below zero
export const PHRASE_DISCOUNT = 1.5;

// Promotion threshold for the score above.
export const PHRASE_SCORE_THRESHOLD = 12;

/**
 * Second promotion route: cohesion.
 *
 * The score above is PMI-like, so it rewards pairs that are rare but exclusive
 * and penalises frequent ones. Measured on real posts, "paul hogan" (4
 * occurrences) scored 59 while "six seven" (32 occurrences, essentially never
 * apart) scored only 10 — the frequent, obvious phrase lost to the rare one.
 *
 * Cohesion asks a different question: of all the times the rarer word appears,
 * how often is it in this pair? "six seven" scores 0.97 there, while incidental
 * pairs like "hate geometry" score 0.56, which separates them cleanly.
 *
 * A pair is promoted if EITHER measure clears its threshold.
 */
export const PHRASE_COHESION_THRESHOLD = 0.7;

export function cohesion(pairCount, leftCount, rightCount) {
  const rarer = Math.min(leftCount, rightCount);
  if (!rarer) return 0;
  return pairCount / rarer;
}

// Cap on how many phrases are kept, so the token tables cannot grow unbounded
export const MAX_PHRASES = 500;

/**
 * Score a candidate pair. Higher means more phrase-like.
 * Returns 0 when the pair is too rare to judge.
 */
export function scorePhrase(pairCount, leftCount, rightCount, totalTokens) {
  if (pairCount < PHRASE_MIN_COUNT) return 0;
  if (!leftCount || !rightCount || !totalTokens) return 0;
  return ((pairCount - PHRASE_DISCOUNT) / (leftCount * rightCount)) * totalTokens;
}

/**
 * Count the unigrams and adjacent pairs in a token list.
 * Pairs are keyed with a space, matching how phrases are stored.
 */
export function countTokens(tokens) {
  const unigrams = new Map();
  const bigrams = new Map();

  for (const token of tokens) {
    unigrams.set(token, (unigrams.get(token) || 0) + 1);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const pair = `${tokens[i]} ${tokens[i + 1]}`;
    bigrams.set(pair, (bigrams.get(pair) || 0) + 1);
  }

  return { unigrams, bigrams };
}

/**
 * Decide which candidate pairs deserve promotion.
 *
 * @param candidates [{ bigram, count, leftCount, rightCount }]
 * @param totalTokens corpus size
 * @returns [{ phrase, score, count }] sorted strongest first
 */
export function selectPhrases(candidates, totalTokens) {
  const scored = [];

  for (const c of candidates) {
    const [left, right] = c.bigram.split(' ');

    // A word paired with itself is never a phrase. These appear because
    // cleanText() repeats hashtags to weight them, which produces runs like
    // "gdsucks gdsucks gdsucks" and therefore a self-pair with a real count.
    if (left === right) continue;

    const score = scorePhrase(c.count, c.leftCount, c.rightCount, totalTokens);
    const coh = cohesion(c.count, c.leftCount, c.rightCount);

    const qualifies =
      c.count >= PHRASE_MIN_COUNT &&
      (score >= PHRASE_SCORE_THRESHOLD || coh >= PHRASE_COHESION_THRESHOLD);

    if (qualifies) {
      scored.push({ phrase: c.bigram, score, cohesion: coh, count: c.count });
    }
  }

  // Rank by the stronger of the two signals, normalised so they are comparable
  scored.sort(
    (a, b) =>
      Math.max(b.score / PHRASE_SCORE_THRESHOLD, b.cohesion / PHRASE_COHESION_THRESHOLD) -
      Math.max(a.score / PHRASE_SCORE_THRESHOLD, a.cohesion / PHRASE_COHESION_THRESHOLD)
  );
  return scored.slice(0, MAX_PHRASES);
}

/**
 * Turn a stored phrase into its feature token.
 * "geometry dash" becomes "geometry_dash", which cannot collide with a real
 * token because the tokeniser splits on non-word characters.
 */
export function phraseToToken(phrase) {
  return phrase.replace(/ /g, '_');
}
