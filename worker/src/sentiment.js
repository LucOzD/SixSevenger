// sentiment.js
// Faithful JavaScript port of NLTK's VADER sentiment analyser.
//
// Ported directly from nltk/sentiment/vader.py so scores match the Python
// implementation exactly. This removes the last reason the recommender needed
// a Python runtime, letting the whole thing run in a Cloudflare Worker.
//
// Quirks deliberately preserved for parity with NLTK:
//   - polarity_scores uses each token's FIRST occurrence index, not its loop
//     position, so repeated tokens are scored against the same context.
//   - Single-character tokens are dropped before scoring.

import { VADER_LEXICON } from './vader-lexicon.js';

// --- Constants (from VaderConstants) ---------------------------------------
const B_INCR = 0.293;
const B_DECR = -0.293;
const C_INCR = 0.733;
const N_SCALAR = -0.74;

const PUNC_LIST = [
  '.', '!', '?', ',', ';', ':', '-', "'", '"',
  '!!', '!!!', '??', '???', '?!?', '!?!', '?!?!', '!?!?',
];

const REGEX_REMOVE_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

const NEGATE = new Set([
  "ain't", 'aint', "aren't", 'arent', "can't", 'cannot', 'cant', "couldn't",
  'couldnt', "daren't", 'darent', 'despite', "didn't", 'didnt', "doesn't",
  'doesnt', "don't", 'dont', "hadn't", 'hadnt', "hasn't", 'hasnt', "haven't",
  'havent', "isn't", 'isnt', "mightn't", 'mightnt', "mustn't", 'mustnt',
  "needn't", 'neednt', 'neither', 'never', 'none', 'nope', 'nor', 'not',
  'nothing', 'nowhere', "oughtn't", 'oughtnt', 'rarely', 'seldom', "shan't",
  'shant', "shouldn't", 'shouldnt', 'uh-uh', 'uhuh', "wasn't", 'wasnt',
  "weren't", 'werent', 'without', "won't", 'wont', "wouldn't", 'wouldnt',
]);

const BOOSTER_DICT = {
  absolutely: B_INCR, almost: B_DECR, amazingly: B_INCR, awfully: B_INCR,
  barely: B_DECR, completely: B_INCR, considerably: B_INCR, decidedly: B_INCR,
  deeply: B_INCR, effing: B_INCR, enormously: B_INCR, entirely: B_INCR,
  especially: B_INCR, exceptionally: B_INCR, extremely: B_INCR,
  fabulously: B_INCR, flippin: B_INCR, flipping: B_INCR, frickin: B_INCR,
  fricking: B_INCR, friggin: B_INCR, frigging: B_INCR, fucking: B_INCR,
  fully: B_INCR, greatly: B_INCR, hardly: B_DECR, hella: B_INCR,
  highly: B_INCR, hugely: B_INCR, incredibly: B_INCR, intensely: B_INCR,
  'just enough': B_DECR, 'kind of': B_DECR, 'kind-of': B_DECR, kinda: B_DECR,
  kindof: B_DECR, less: B_DECR, little: B_DECR, majorly: B_INCR,
  marginally: B_DECR, more: B_INCR, most: B_INCR, occasionally: B_DECR,
  particularly: B_INCR, partly: B_DECR, purely: B_INCR, quite: B_INCR,
  really: B_INCR, remarkably: B_INCR, scarcely: B_DECR, slightly: B_DECR,
  so: B_INCR, somewhat: B_DECR, 'sort of': B_DECR, 'sort-of': B_DECR,
  sorta: B_DECR, sortof: B_DECR, substantially: B_INCR, thoroughly: B_INCR,
  totally: B_INCR, tremendously: B_INCR, uber: B_INCR, unbelievably: B_INCR,
  unusually: B_INCR, utterly: B_INCR, very: B_INCR,
};

const SPECIAL_CASE_IDIOMS = {
  'bad ass': 1.5, 'cut the mustard': 2, 'hand to mouth': -2,
  'kiss of death': -1.5, 'the bomb': 3, 'the shit': 3, 'yeah right': -2,
};

// --- Small helpers ---------------------------------------------------------

// Python's str.isupper(): true only if there is at least one cased character
// and all cased characters are uppercase. "ABC" true, "abc" false, "123" false.
function isUpper(word) {
  return word === word.toUpperCase() && word !== word.toLowerCase();
}

// Python 3's round() uses banker's rounding (half to even), which differs from
// JavaScript's Math.round. Replicated so scores match NLTK exactly.
function pyRound(value, digits = 0) {
  const factor = Math.pow(10, digits);
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const epsilon = 1e-9;

  let rounded;
  if (Math.abs(diff - 0.5) < epsilon) {
    // Exactly .5 — round to the even neighbour
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

function negated(words) {
  for (const word of words) {
    if (NEGATE.has(word.toLowerCase())) return true;
  }
  for (const word of words) {
    if (word.toLowerCase().includes("n't")) return true;
  }
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1].toLowerCase() === 'least' && words[i].toLowerCase() !== 'at') {
      return true;
    }
  }
  return false;
}

function normalizeScore(score, alpha = 15) {
  return score / Math.sqrt(score * score + alpha);
}

function scalarIncDec(word, valence, isCapDiff) {
  let scalar = 0.0;
  const wordLower = word.toLowerCase();
  if (wordLower in BOOSTER_DICT) {
    scalar = BOOSTER_DICT[wordLower];
    if (valence < 0) scalar *= -1;
    if (isUpper(word) && isCapDiff) {
      scalar += valence > 0 ? C_INCR : -C_INCR;
    }
  }
  return scalar;
}

// --- SentiText: tokenising and capitalisation analysis ---------------------

function wordsPlusPunc(text) {
  const noPunc = text.replace(REGEX_REMOVE_PUNCTUATION, '');
  const wordsOnly = new Set(noPunc.split(/\s+/).filter((w) => w.length > 1));

  const map = new Map();
  // punctuation before the word, then after — matching Python's dict update
  // order so "after" wins on collision
  for (const punc of PUNC_LIST) {
    for (const word of wordsOnly) map.set(punc + word, word);
  }
  for (const word of wordsOnly) {
    for (const punc of PUNC_LIST) map.set(word + punc, word);
  }
  return map;
}

function wordsAndEmoticons(text) {
  const map = wordsPlusPunc(text);
  return text
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => (map.has(w) ? map.get(w) : w));
}

function allcapDifferential(words) {
  let allcapWords = 0;
  for (const word of words) {
    if (isUpper(word)) allcapWords++;
  }
  const capDifferential = words.length - allcapWords;
  return capDifferential > 0 && capDifferential < words.length;
}

// --- Scoring ---------------------------------------------------------------

function leastCheck(valence, words, i) {
  if (
    i > 1 &&
    !(words[i - 1].toLowerCase() in VADER_LEXICON) &&
    words[i - 1].toLowerCase() === 'least'
  ) {
    if (
      words[i - 2].toLowerCase() !== 'at' &&
      words[i - 2].toLowerCase() !== 'very'
    ) {
      valence = valence * N_SCALAR;
    }
  } else if (
    i > 0 &&
    !(words[i - 1].toLowerCase() in VADER_LEXICON) &&
    words[i - 1].toLowerCase() === 'least'
  ) {
    valence = valence * N_SCALAR;
  }
  return valence;
}

function butCheck(words, sentiments) {
  const lower = words.map((w) => w.toLowerCase());
  const bi = lower.indexOf('but');
  if (bi === -1) return sentiments;
  return sentiments.map((s, idx) => {
    if (idx < bi) return s * 0.5;
    if (idx > bi) return s * 1.5;
    return s;
  });
}

function idiomsCheck(valence, words, i) {
  const onezero = `${words[i - 1]} ${words[i]}`;
  const twoonezero = `${words[i - 2]} ${words[i - 1]} ${words[i]}`;
  const twoone = `${words[i - 2]} ${words[i - 1]}`;
  const threetwoone = `${words[i - 3]} ${words[i - 2]} ${words[i - 1]}`;
  const threetwo = `${words[i - 3]} ${words[i - 2]}`;

  for (const seq of [onezero, twoonezero, twoone, threetwoone, threetwo]) {
    if (seq in SPECIAL_CASE_IDIOMS) {
      valence = SPECIAL_CASE_IDIOMS[seq];
      break;
    }
  }

  if (words.length - 1 > i) {
    const zeroone = `${words[i]} ${words[i + 1]}`;
    if (zeroone in SPECIAL_CASE_IDIOMS) valence = SPECIAL_CASE_IDIOMS[zeroone];
  }
  if (words.length - 1 > i + 1) {
    const zeroonetwo = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    if (zeroonetwo in SPECIAL_CASE_IDIOMS) valence = SPECIAL_CASE_IDIOMS[zeroonetwo];
  }

  if (threetwo in BOOSTER_DICT || twoone in BOOSTER_DICT) {
    valence = valence + B_DECR;
  }
  return valence;
}

function neverCheck(valence, words, startI, i) {
  if (startI === 0) {
    if (negated([words[i - 1]])) valence = valence * N_SCALAR;
  }
  if (startI === 1) {
    if (words[i - 2] === 'never' && (words[i - 1] === 'so' || words[i - 1] === 'this')) {
      valence = valence * 1.5;
    } else if (negated([words[i - (startI + 1)]])) {
      valence = valence * N_SCALAR;
    }
  }
  if (startI === 2) {
    if (
      (words[i - 3] === 'never' &&
        (words[i - 2] === 'so' || words[i - 2] === 'this')) ||
      words[i - 1] === 'so' ||
      words[i - 1] === 'this'
    ) {
      valence = valence * 1.25;
    } else if (negated([words[i - (startI + 1)]])) {
      valence = valence * N_SCALAR;
    }
  }
  return valence;
}

function sentimentValence(valence, words, isCapDiff, item, i, sentiments) {
  const itemLower = item.toLowerCase();
  if (itemLower in VADER_LEXICON) {
    valence = VADER_LEXICON[itemLower];

    // ALL CAPS emphasis, but only when the text is mixed case
    if (isUpper(item) && isCapDiff) {
      valence += valence > 0 ? C_INCR : -C_INCR;
    }

    for (let startI = 0; startI < 3; startI++) {
      if (
        i > startI &&
        !(words[i - (startI + 1)].toLowerCase() in VADER_LEXICON)
      ) {
        let s = scalarIncDec(words[i - (startI + 1)], valence, isCapDiff);
        if (startI === 1 && s !== 0) s = s * 0.95;
        if (startI === 2 && s !== 0) s = s * 0.9;
        valence = valence + s;
        valence = neverCheck(valence, words, startI, i);
        if (startI === 2) {
          valence = idiomsCheck(valence, words, i);
        }
      }
    }

    valence = leastCheck(valence, words, i);
  }

  sentiments.push(valence);
  return sentiments;
}

function amplifyEp(text) {
  let epCount = (text.match(/!/g) || []).length;
  if (epCount > 4) epCount = 4;
  return epCount * 0.292;
}

function amplifyQm(text) {
  const qmCount = (text.match(/\?/g) || []).length;
  if (qmCount > 1) {
    return qmCount <= 3 ? qmCount * 0.18 : 0.96;
  }
  return 0;
}

function siftSentimentScores(sentiments) {
  let posSum = 0.0;
  let negSum = 0.0;
  let neuCount = 0;
  for (const score of sentiments) {
    // +1 / -1 compensate for neutral words counted as 1
    if (score > 0) posSum += score + 1;
    if (score < 0) negSum += score - 1;
    if (score === 0) neuCount += 1;
  }
  return { posSum, negSum, neuCount };
}

function scoreValence(sentiments, text) {
  if (sentiments.length === 0) {
    return { neg: 0.0, neu: 0.0, pos: 0.0, compound: 0.0 };
  }

  let sumS = sentiments.reduce((a, b) => a + b, 0);
  const punctAmp = amplifyEp(text) + amplifyQm(text);
  if (sumS > 0) sumS += punctAmp;
  else if (sumS < 0) sumS -= punctAmp;

  const compound = normalizeScore(sumS);
  let { posSum, negSum, neuCount } = siftSentimentScores(sentiments);

  if (posSum > Math.abs(negSum)) posSum += punctAmp;
  else if (posSum < Math.abs(negSum)) negSum -= punctAmp;

  const total = posSum + Math.abs(negSum) + neuCount;
  return {
    neg: pyRound(Math.abs(negSum / total), 3),
    neu: pyRound(Math.abs(neuCount / total), 3),
    pos: pyRound(Math.abs(posSum / total), 3),
    compound: pyRound(compound, 4),
  };
}

// --- Public API ------------------------------------------------------------

/**
 * Full VADER breakdown for a piece of text.
 * @returns {{neg:number, neu:number, pos:number, compound:number}}
 */
export function polarityScores(text) {
  const words = wordsAndEmoticons(text);
  const isCapDiff = allcapDifferential(words);

  // VADER looks up each token's FIRST index rather than its loop position.
  // Preserved for parity with NLTK.
  const firstIndex = new Map();
  words.forEach((token, idx) => {
    if (!firstIndex.has(token)) firstIndex.set(token, idx);
  });

  let sentiments = [];
  for (const item of words) {
    const i = firstIndex.get(item);
    const itemLower = item.toLowerCase();

    // Booster words and "kind of" contribute no valence of their own
    if (
      (i < words.length - 1 &&
        itemLower === 'kind' &&
        words[i + 1].toLowerCase() === 'of') ||
      itemLower in BOOSTER_DICT
    ) {
      sentiments.push(0);
      continue;
    }

    sentiments = sentimentValence(0, words, isCapDiff, item, i, sentiments);
  }

  sentiments = butCheck(words, sentiments);
  return scoreValence(sentiments, text);
}

/**
 * Compound sentiment only, in the range -1.0 to 1.0.
 * This is what the recommender stores against each post.
 */
export function sentimentScore(text) {
  return polarityScores(text).compound;
}

/** Standard VADER thresholds for a human-readable label. */
export function sentimentLabel(compound) {
  if (compound >= 0.05) return 'positive';
  if (compound <= -0.05) return 'negative';
  return 'neutral';
}
