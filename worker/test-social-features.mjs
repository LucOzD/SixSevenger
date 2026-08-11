import {
  handleCommentLike, handleGetComments, handleMyComments, handleSavePost,
} from './src/routes/post-routes.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const NOW = 1_700_000_000_000;
const realDateNow = Date.now;
Date.now = () => NOW;
const user = { id: 'u1', username: 'tester', avatar: '🙂' };
const env = {};
const postRequest = (message) => new Request('https://api.test/save-message', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
});

function postingDb({ recent = [], mute = null, violationCount = 0 } = {}) {
  const runs = [];
  const batches = [];
  return {
    runs,
    batches,
    prepare(sql) {
      return {
        bind(...args) {
          const statement = { sql, args };
          return {
            ...statement,
            all: async () => /FROM posts WHERE userId/i.test(sql)
              ? { results: recent }
              : { results: [] },
            first: async () => {
              if (/FROM posting_mutes/i.test(sql)) return mute;
              if (/FROM posting_violations/i.test(sql)) return { c: violationCount };
              return null;
            },
            run: async () => { runs.push(statement); return {}; },
          };
        },
      };
    },
    batch: async (statements) => { batches.push(statements); return statements.map(() => ({})); },
  };
}

console.log('\n1. Posting controls');
const fiveRecent = Array.from({ length: 5 }, (_, index) => ({
  id: `p${index}`, text: `different ${index}`, timestamp: NOW - (index + 1) * 5000,
  deleted: index === 0 ? 1 : 0, spam_score: 0, category_id: -1, sentiment: 0,
}));
const limitedDb = postingDb({ recent: fiveRecent });
const limitedResponse = await handleSavePost({
  request: postRequest('sixth distinct post'), env, db: limitedDb, user,
});
const limitedBody = await limitedResponse.json();
check('sixth new post is rejected with HTTP 429', limitedResponse.status === 429);
check('rate rejection returns an actionable mute contract',
  limitedBody.code === 'POSTING_MUTED' && limitedBody.retryAfterMs === 300_000);
check('deleted rows count and the mute is persisted for this account',
  limitedDb.batches.some((batch) => batch.some((statement) =>
    /INSERT INTO posting_mutes/i.test(statement.sql) && statement.args[0] === user.id)));

const activeUntil = NOW + 120_000;
const mutedDb = postingDb({ mute: { muted_until: activeUntil } });
const mutedResponse = await handleSavePost({
  request: postRequest('blocked while muted'), env, db: mutedDb, user,
});
const mutedBody = await mutedResponse.json();
check('an active mute returns its original expiry', mutedBody.mutedUntil === activeUntil);
check('a blocked request does not extend an active mute', mutedDb.runs.length === 0);

const repeatedViolationDb = postingDb({ recent: fiveRecent, violationCount: 2 });
const repeatedViolationBody = await (await handleSavePost({
  request: postRequest('another distinct post'), env, db: repeatedViolationDb, user,
})).json();
check('repeated posting violations earn progressively longer mutes',
  repeatedViolationBody.retryAfterMs === 20 * 60_000,
  `retryAfterMs=${repeatedViolationBody.retryAfterMs}`);

const networkLimited = await handleSavePost({
  request: new Request('https://api.test/save-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
    body: JSON.stringify({ message: 'rotated account post' }),
  }),
  env: { POST_NETWORK_RATE_LIMITER: { limit: async () => ({ success: false }) } },
  db: postingDb(),
  user,
});
const networkLimitedBody = await networkLimited.json();
check('edge network limiting catches account rotation',
  networkLimited.status === 429 && networkLimitedBody.code === 'POST_NETWORK_RATE_LIMIT');

const retryDb = postingDb({
  recent: [{
    id: 'existing', text: 'same text', timestamp: NOW - 10_000,
    deleted: 0, spam_score: 0, category_id: 2, sentiment: 0,
  }],
  mute: { muted_until: NOW + 300_000 },
});
const retryResponse = await handleSavePost({
  request: postRequest('SAME TEXT!'), env, db: retryDb, user,
});
const retryBody = await retryResponse.json();
check('an immediate retry wins over an active mute',
  retryResponse.status === 200 && retryBody.duplicate === true && retryBody.id === 'existing');

const duplicates = Array.from({ length: 4 }, (_, index) => ({
  id: `duplicate-${index}`, text: index ? 'repeat me!' : 'REPEAT ME',
  timestamp: NOW - 31_000 - index * 60_000, deleted: 0,
  spam_score: 0.8, category_id: -1, sentiment: 0,
}));
const duplicateDb = postingDb({ recent: duplicates });
const duplicateResponse = await handleSavePost({
  request: postRequest('repeat me'), env, db: duplicateDb, user,
});
const duplicateBody = await duplicateResponse.json();
check('the fifth identical post is accepted only as an auto-deleted tombstone',
  duplicateBody.success === true && duplicateBody.autoDeleted === true &&
  duplicateBody.post?.deleted === 1);
check('the complete visible duplicate set is soft-deleted',
  duplicateBody.deletedPostIds.length === 5 && duplicateBody.deletedCount === 5);
check('auto-deleted duplicate skips recommendation training',
  duplicateDb.batches.length === 1 && duplicateDb.batches[0].length === 2);

console.log('\n2. Comment likes and profile comments');
function commentDb() {
  const likes = new Set();
  return {
    likes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (/SELECT c\.id FROM comments/i.test(sql)) return { id: args[0] };
              if (/SELECT COUNT\(\*\) AS likes/i.test(sql)) {
                return { likes: likes.size, userLiked: likes.has(args[0]) ? 1 : 0 };
              }
              return null;
            },
            all: async () => {
              if (/JOIN users u ON c\.userId/i.test(sql)) {
                return { results: [{
                  id: 'c1', text: 'hello', timestamp: NOW, userId: 'u2',
                  username: 'other', avatar: '🚀', likes: likes.size,
                  userLiked: likes.has(args[0]) ? 1 : 0,
                }] };
              }
              if (/JOIN posts p ON p\.id = c\.postId/i.test(sql)) {
                return { results: [{
                  id: 'c1', postId: 'p1', text: 'hello', timestamp: NOW,
                  postText: 'original post', postAuthorId: 'u2',
                  postAuthorUsername: 'other', postAuthorAvatar: '🚀',
                  likes: likes.size, userLiked: likes.has(args[0]) ? 1 : 0,
                }] };
              }
              return { results: [] };
            },
            run: async () => {
              if (/INSERT OR IGNORE INTO comment_likes/i.test(sql)) likes.add(args[1]);
              if (/DELETE FROM comment_likes/i.test(sql)) likes.delete(args[1]);
              return {};
            },
          };
        },
      };
    },
  };
}

const commentsDb = commentDb();
const likeRequest = (value) => new Request('https://api.test/comment/c1/like', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value }),
});
const anonLike = await handleCommentLike({
  request: likeRequest(1), env, db: commentsDb, user: null,
}, { id: 'c1' });
check('comment likes require authentication', anonLike.status === 401);

let likeBody = await (await handleCommentLike({
  request: likeRequest(1), env, db: commentsDb, user,
}, { id: 'c1' })).json();
check('a comment can be liked', likeBody.likes === 1 && likeBody.userLiked === true);
likeBody = await (await handleCommentLike({
  request: likeRequest(1), env, db: commentsDb, user,
}, { id: 'c1' })).json();
check('liking twice is idempotent', likeBody.likes === 1 && likeBody.userLiked === true);
likeBody = await (await handleCommentLike({
  request: likeRequest(0), env, db: commentsDb, user,
}, { id: 'c1' })).json();
check('a comment can be unliked', likeBody.likes === 0 && likeBody.userLiked === false);
const commentsBody = await (await handleGetComments({
  request: new Request('https://api.test/post/p1/comments'), env, db: commentsDb, user,
}, { id: 'p1' })).json();
check('comment listings expose canonical like state',
  commentsBody[0].likes === 0 && commentsBody[0].userLiked === false);

const myCommentsBody = await (await handleMyComments({
  request: new Request('https://api.test/my-comments'), env, db: commentsDb, user,
})).json();
check('profile comments include live post and author context',
  myCommentsBody[0].postId === 'p1' &&
  myCommentsBody[0].postText === 'original post' &&
  myCommentsBody[0].postAuthorUsername === 'other');
check('profile comments expose comment-like state',
  myCommentsBody[0].likes === 0 && myCommentsBody[0].userLiked === false);

Date.now = realDateNow;
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
