// Verify the ported recommender: every post gets a category, topics group
// together, opposite-sentiment categories get demoted, and state survives the
// JSON round-trip that D1 persistence relies on.
import {
  PostAnalyser, UserProfiler, POST_INTEREST_WEIGHT, SIGNAL_WEIGHTS,
  FEED_SCORE_WEIGHTS, postInteractionScore, feedCandidateScore,
} from './src/recommender.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

const gdLove = [
  'i LOVE geometry dash', 'geometry dash is peak gaming',
  'geometry dash levels are fun', 'GD is the best game ever',
  'geometry dash music goes so hard',
];
const gdHate = [
  'i HATE geometry dash', 'geometry dash controls are terrible',
  'geometry dash is a scam on your time', 'GD is unplayable garbage',
];
const sixSeven = [
  'six seven is amazing', 'six seven is love six seven is life',
  'i HATE six seven', 'six seven is a plague upon humanity',
  'six seven appreciation post',
];
const cola = [
  'coca cola is the best drink ever', 'i love drinking coke',
  'coca cola is the DEVILS DRINK', 'coca cola is disgusting poison',
];

console.log('\n1. Every post gets a category');
const analyser = new PostAnalyser();
const assigned = [];
for (const text of [...gdLove, ...gdHate, ...sixSeven, ...cola]) {
  const r = analyser.addPost(text);
  assigned.push({ text, ...r });
}
check('no post left uncategorised',
  assigned.every((a) => Number.isInteger(a.categoryId) && a.categoryId >= 0));
check('more than one category emerged', analyser.numCategories > 1,
  `${analyser.numCategories} categories`);
check('fewer categories than posts (grouping happened)',
  analyser.numCategories < assigned.length,
  `${analyser.numCategories} categories from ${assigned.length} posts`);

console.log('\n2. Topics group together');
function catsFor(list) {
  return new Set(assigned.filter((a) => list.includes(a.text)).map((a) => a.categoryId));
}
const gdCats = catsFor([...gdLove, ...gdHate]);
const colaCats = catsFor(cola);
const overlap = [...gdCats].filter((c) => colaCats.has(c));
check('geometry dash and coca cola do not share a category',
  overlap.length === 0,
  `gd=${[...gdCats]} cola=${[...colaCats]}`);

console.log('\n3. Sentiment is tracked per category and per post');
const lovePost = assigned.find((a) => a.text === 'i LOVE geometry dash');
const hatePost = assigned.find((a) => a.text === 'i HATE geometry dash');
check('positive post scores positive', lovePost.sentiment > 0.05, `${lovePost.sentiment.toFixed(3)}`);
check('negative post scores negative', hatePost.sentiment < -0.05, `${hatePost.sentiment.toFixed(3)}`);

console.log('\n4. Hashtags are extracted');
const tagged = analyser.addPost('i love #geometrydash and #GD so much');
check('hashtags returned lowercased', tagged.hashtags.includes('geometrydash') && tagged.hashtags.includes('gd'),
  tagged.hashtags.join(','));

console.log('\n5. Author context disambiguates a vague post');
const vagueAlone = new PostAnalyser().addPost('when someone plays geometry dash i see RED');
const vagueWithHistory = new PostAnalyser().addPost(
  'when someone plays geometry dash i see RED',
  { avgSentiment: -0.6, topCategories: [] }
);
check('vague post pulled negative by a negative author history',
  vagueWithHistory.sentiment < vagueAlone.sentiment,
  `alone=${vagueAlone.sentiment.toFixed(3)} withHistory=${vagueWithHistory.sentiment.toFixed(3)}`);

console.log('\n6. State survives a JSON round-trip (needed for D1)');
const state = JSON.parse(JSON.stringify(analyser.toState()));
const restored = new PostAnalyser({}, state);
check('category count preserved', restored.numCategories === analyser.numCategories,
  `${restored.numCategories} vs ${analyser.numCategories}`);
check('nextId preserved', restored.nextId === analyser.nextId);
check('postCount preserved', restored.postCount === analyser.postCount);
const probe = 'geometry dash is fun';
const before = analyser.nearestCategory(
  (await import('./src/vectorizer.js')).vectorize((await import('./src/vectorizer.js')).cleanText(probe))
);
const after = restored.nearestCategory(
  (await import('./src/vectorizer.js')).vectorize((await import('./src/vectorizer.js')).cleanText(probe))
);
check('restored model assigns the same nearest category', before.catId === after.catId,
  `${before.catId} vs ${after.catId}`);

console.log('\n7. Categories split when they grow incoherent');
// Seed one category with two clearly separate groups of vectors. Relying on
// this emerging naturally does not work: unrelated posts share no features, so
// they get their own category rather than piling into one broad one.
// Four distinct groups, so average pairwise similarity lands near 0.2 —
// below the 0.25 cohesion threshold. Note two equal tight clusters average
// ~0.47 and correctly do NOT split; the rule only fires once a category has
// genuinely fragmented.
const splitter = new PostAnalyser();
const seeded = [];
const bases = [[10, 11], [500, 501], [1200, 1201], [3000, 3001]];
for (const [x, y] of bases) {
  for (let i = 0; i < 4; i++) {
    seeded.push({ [x]: 1 / Math.sqrt(2), [y]: 1 / Math.sqrt(2) });
  }
}
splitter.topology.centroids[0] = Object.fromEntries(
  bases.flatMap(([x, y]) => [[x, 0.18], [y, 0.18]])
);
splitter.topology.nPosts[0] = seeded.length;
splitter.categoryVectors[0] = seeded;
splitter.categoryWords[0] = ['seeded'];
splitter.wordCounts[0] = { seeded: seeded.length };
splitter.nextId = 1;

const newId = splitter.maybeSplitCategory(0);
check('incoherent category split in two', newId !== null, `new category id ${newId}`);
if (newId !== null) {
  check('both halves kept at least 3 posts',
    splitter.topology.nPosts[0] >= 3 && splitter.topology.nPosts[newId] >= 3,
    `${splitter.topology.nPosts[0]} / ${splitter.topology.nPosts[newId]}`);
  check('the two halves are now dissimilar',
    (await import('./src/vectorizer.js')).cosineSimilarity(
      splitter.topology.centroids[0], splitter.topology.centroids[newId]) < 0.1);
}

// A cohesive category should be left alone
const cohesive = new PostAnalyser();
cohesive.topology.centroids[0] = { 10: 0.7, 11: 0.7 };
cohesive.topology.nPosts[0] = 16;
cohesive.categoryVectors[0] = Array.from({ length: 16 },
  () => ({ 10: 1 / Math.sqrt(2), 11: 1 / Math.sqrt(2) }));
cohesive.nextId = 1;
check('cohesive category is not split', cohesive.maybeSplitCategory(0) === null);

console.log('\n8. Ranking favours the user\'s own topic');
const profiler = new UserProfiler();
// A user who posts and likes geometry dash content
const gdCat = assigned.find((a) => a.text === 'geometry dash is peak gaming').categoryId;
const colaCat = assigned.find((a) => a.text === 'i love drinking coke').categoryId;
const ranked = profiler.rankFromScores(
  { [gdCat]: 0.75, [colaCat]: 0.0 },
  analyser.topology,
);
check('top ranked category is the one they engage with', ranked[0][0] === gdCat,
  `top=${ranked[0][0]} (score ${ranked[0][1].toFixed(3)}), expected ${gdCat}`);

console.log('\n9. Opposite sentiment on the same topic is demoted');
// Constructed directly: the algorithm clusters by TOPIC, so positive and
// negative posts about one subject normally land in the SAME category. The
// penalty exists for when they do separate — via a hashtag or after a split.
const senti = new PostAnalyser();
// Two categories sharing most features, so they read as the same topic
senti.topology.centroids[0] = { 10: 0.6, 11: 0.6, 12: 0.5 };
senti.topology.centroids[1] = { 10: 0.6, 11: 0.6, 13: 0.5 };
senti.topology.nPosts[0] = 6;
senti.topology.nPosts[1] = 6;
senti.categorySentiment[0] = 0.7;   // positive take
senti.categorySentiment[1] = -0.6;  // negative take on the same topic
senti.sentimentCounts[0] = 6;
senti.sentimentCounts[1] = 6;
senti.nextId = 2;
senti.topology.rebuildRelations();

const topicSim = senti.topology.getSimilarCategories(0, 8);
check('the two categories register as similar', topicSim.some(([c]) => c === 1),
  JSON.stringify(topicSim));

const withoutPenalty = profiler.rankFromScores({ 0: 0.8 }, senti.topology);
const withPenalty = profiler.rankFromScores({ 0: 0.8 }, senti.topology, {
  categorySentiments: { 0: 0.7, 1: -0.6 },
  userSentimentPref: { 0: 0.7 },
});
const scoreOf = (list, cat) => (list.find(([c]) => c === cat) || [0, 0])[1];
check('opposite-sentiment category scores lower with the penalty applied',
  scoreOf(withPenalty, 1) < scoreOf(withoutPenalty, 1),
  `without=${scoreOf(withoutPenalty, 1).toFixed(4)} with=${scoreOf(withPenalty, 1).toFixed(4)}`);
check('the user\'s own category is unaffected',
  Math.abs(scoreOf(withPenalty, 0) - scoreOf(withoutPenalty, 0)) < 1e-9);

console.log('\n9b. Phrases keep an unrelated use of a topic word separate');
// "geometry dash" (the game) versus "geometry" (the school subject). Without
// phrase merging these share a strong feature and risk landing together.
const gdPosts = [
  'geometry dash is peak gaming', 'geometry dash levels are fun',
  'geometry dash is amazing', 'i love geometry dash',
];
const mathsPosts = [
  'geometry homework is due tomorrow', 'geometry test went badly',
  'geometry revision all evening', 'i hate geometry homework',
];

function categoriesFor(analyserInstance, list) {
  return new Set(list.map((t) => analyserInstance.addPost(t).categoryId));
}

const withoutPhrases = new PostAnalyser();
const gdNoPhrase = categoriesFor(withoutPhrases, gdPosts);
const mathsNoPhrase = categoriesFor(withoutPhrases, mathsPosts);
const overlapNoPhrase = [...gdNoPhrase].filter((c) => mathsNoPhrase.has(c));

const withPhrases = new PostAnalyser({}, { phrases: new Set(['geometry dash']) });
const gdPhrase = categoriesFor(withPhrases, gdPosts);
const mathsPhrase = categoriesFor(withPhrases, mathsPosts);
const overlapPhrase = [...gdPhrase].filter((c) => mathsPhrase.has(c));

console.log(`     without phrases: gd=${[...gdNoPhrase]} maths=${[...mathsNoPhrase]} shared=${overlapNoPhrase.length}`);
console.log(`     with phrases   : gd=${[...gdPhrase]} maths=${[...mathsPhrase]} shared=${overlapPhrase.length}`);
check('phrase merging does not increase category overlap',
  overlapPhrase.length <= overlapNoPhrase.length);
check('phrase set is carried on the analyser', withPhrases.phrases.has('geometry dash'));
check('tokens are returned for phrase counting',
  Array.isArray(withPhrases.addPost('geometry dash rocks').tokens));

console.log('\n10. Explicit actions outweigh passive recency');
check('like weight is a strong profile signal', SIGNAL_WEIGHTS.like === 0.60);
check('comment weight exceeds like weight', SIGNAL_WEIGHTS.comment > SIGNAL_WEIGHTS.like);
check('dislike weight is stronger than like', Math.abs(SIGNAL_WEIGHTS.dislike) > SIGNAL_WEIGHTS.like);
check('authoring weight stays weaker than reactions', POST_INTEREST_WEIGHT < SIGNAL_WEIGHTS.like);
check('recency has the smallest feed coefficient',
  FEED_SCORE_WEIGHTS.recency < FEED_SCORE_WEIGHTS.interactions &&
  FEED_SCORE_WEIGHTS.recency < FEED_SCORE_WEIGHTS.relevance);
check('comments count more than likes on a post',
  postInteractionScore({ comments: 1 }) > postInteractionScore({ likes: 1 }));
check('dislikes lower a post interaction score',
  postInteractionScore({ likes: 2, dislikes: 2 }) < postInteractionScore({ likes: 2 }));

const freshNoReactions = feedCandidateScore(0.01, 0.15, {});
const oldWithLike = feedCandidateScore(0.01, 0.01, { likes: 1 });
const oldWithComment = feedCandidateScore(0.01, 0.01, { comments: 1 });
check('one like outweighs the maximum recency advantage', oldWithLike > freshNoReactions,
  `liked=${oldWithLike.toFixed(4)} fresh=${freshNoReactions.toFixed(4)}`);
check('one comment outweighs the maximum recency advantage', oldWithComment > freshNoReactions,
  `commented=${oldWithComment.toFixed(4)} fresh=${freshNoReactions.toFixed(4)}`);

console.log('\n--- category summary ---');
const overview = analyser.categoriesOverview();
for (const [id, info] of Object.entries(overview)) {
  console.log(`  cat ${id}: ${info.post_count} posts, ${info.sentiment}, [${info.words.slice(0, 4).join(', ')}]`);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
