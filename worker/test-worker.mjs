// Structural tests for the Worker: modules import, routes are well formed,
// password hashing round-trips, CORS behaves, and the router dispatches.
import worker from './src/index.js';
import { matchPath, corsHeaders } from './src/http.js';
import { hashPassword, verifyPassword, readCookie, sessionCookie, newSessionToken } from './src/auth.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('\n1. Path matching');
check('exact path', matchPath('/me', '/me') !== null);
check('non-match returns null', matchPath('/me', '/you') === null);
check('length mismatch returns null', matchPath('/post/:id/like', '/post/abc') === null);
const m = matchPath('/post/:id/like', '/post/abc-123/like');
check('params extracted', m && m.params.id === 'abc-123', JSON.stringify(m?.params));
const enc = matchPath('/api/hashtag/:tag', '/api/hashtag/six%20seven');
check('params url-decoded', enc && enc.params.tag === 'six seven', JSON.stringify(enc?.params));

console.log('\n2a. Origin allow-listing');
const { isOriginAllowed, parseAllowedOrigins, diagnoseOrigin, unsafeWildcardReason } =
  await import('./src/http.js');
const projectList = ['https://sixsevenger.pages.dev', 'https://*.sixsevenger.pages.dev'];
check('exact production origin allowed',
  isOriginAllowed('https://sixsevenger.pages.dev', projectList));
check('preview deployment subdomain allowed',
  isOriginAllowed('https://a1b2c3.sixsevenger.pages.dev', projectList));
check('another project on pages.dev is rejected',
  !isOriginAllowed('https://someoneelse.pages.dev', projectList));
check('lookalike domain rejected',
  !isOriginAllowed('https://sixsevenger.pages.dev.evil.com', projectList));
check('http against an https entry rejected',
  !isOriginAllowed('http://sixsevenger.pages.dev', projectList));
check('empty origin rejected', !isOriginAllowed('', projectList));
check('trailing slashes in config tolerated',
  parseAllowedOrigins({ ALLOWED_ORIGINS: 'https://a.example/, https://b.example' })
    .join(',') === 'https://a.example,https://b.example');

console.log('\n2b. Custom domain wildcards');
const customList = ['https://*.lucasdrane.com', 'https://lucasdrane.com'];
check('own-domain wildcard allows a subdomain',
  isOriginAllowed('https://sixseven.lucasdrane.com', customList));
check('own-domain wildcard allows another subdomain',
  isOriginAllowed('https://67.lucasdrane.com', customList));
check('apex domain allowed via its own entry',
  isOriginAllowed('https://lucasdrane.com', customList));
check('wildcard alone does not cover the apex',
  !isOriginAllowed('https://lucasdrane.com', ['https://*.lucasdrane.com']));
check('a different domain is rejected',
  !isOriginAllowed('https://evil.com', customList));
check('suffix-confusion attack rejected',
  !isOriginAllowed('https://evil-lucasdrane.com', customList));

console.log('\n2c. Unsafe wildcards refused');
check('shared hosting wildcard refused', unsafeWildcardReason('.pages.dev') !== null);
check('workers.dev wildcard refused', unsafeWildcardReason('.workers.dev') !== null);
check('bare TLD wildcard refused', unsafeWildcardReason('.com') !== null);
check('own domain wildcard permitted', unsafeWildcardReason('.lucasdrane.com') === null);
check('project subdomain of shared host permitted',
  unsafeWildcardReason('.myproject.pages.dev') === null);
check('bare *.pages.dev does not match anything',
  !isOriginAllowed('https://anything.pages.dev', ['https://*.pages.dev']));

console.log('\n2d. Rejection is explained');
// The mistake that actually happened: custom domains entered as http:// when
// Cloudflare serves them over https://
const schemeHints = diagnoseOrigin('https://67.lucasdrane.com', ['http://67.lucasdrane.com']);
check('scheme mismatch is identified',
  schemeHints.some((h) => /Scheme mismatch/.test(h)), schemeHints[0]);
const unsafeHints = diagnoseOrigin('https://x.pages.dev', ['https://*.pages.dev']);
check('unsafe wildcard is called out',
  unsafeHints.some((h) => /shared hosting/.test(h)), unsafeHints[0]);
const apexHints = diagnoseOrigin('https://lucasdrane.com', ['https://*.lucasdrane.com']);
check('apex-vs-wildcard confusion is called out',
  apexHints.some((h) => /only covers subdomains/.test(h)), apexHints[0]);
check('a plain missing origin gets actionable advice',
  diagnoseOrigin('https://new.example', []).some((h) => /Add .* redeploy/.test(h)));

console.log('\n2e. CORS headers');

const env = { ALLOWED_ORIGINS: 'https://sixsevenger.pages.dev,http://localhost:8788' };
const allowedReq = new Request('https://api.test/me', {
  headers: { Origin: 'https://sixsevenger.pages.dev' },
});
const deniedReq = new Request('https://api.test/me', {
  headers: { Origin: 'https://evil.example' },
});
const allowedHeaders = corsHeaders(allowedReq, env);
const deniedHeaders = corsHeaders(deniedReq, env);
check('allowed origin is echoed back',
  allowedHeaders['Access-Control-Allow-Origin'] === 'https://sixsevenger.pages.dev');
check('unlisted origin gets no allow-origin header',
  deniedHeaders['Access-Control-Allow-Origin'] === undefined);
check('credentials are allowed', allowedHeaders['Access-Control-Allow-Credentials'] === 'true');
check('Vary: Origin is set so caches do not mix origins', allowedHeaders.Vary === 'Origin');

console.log('\n3. Password hashing (WebCrypto PBKDF2)');
const hash = await hashPassword('correct horse battery staple');
check('hash has the expected format', hash.startsWith('pbkdf2$100000$'), hash.slice(0, 20) + '...');
check('correct password verifies', await verifyPassword('correct horse battery staple', hash));
check('wrong password rejected', !(await verifyPassword('wrong password', hash)));
check('empty password rejected', !(await verifyPassword('', hash)));
check('malformed hash rejected', !(await verifyPassword('x', 'not-a-hash')));
const hash2 = await hashPassword('correct horse battery staple');
check('same password gives a different hash (unique salt)', hash !== hash2);
check('bcrypt hashes are rejected rather than crashing',
  !(await verifyPassword('anything', '$2a$10$abcdefghijklmnopqrstuv')));

console.log('\n3b. Session token transport');
const { readBearerToken, readSessionToken } = await import('./src/auth.js');
const bearerReq = new Request('https://api.test/', {
  headers: { Authorization: 'Bearer abc.123-xyz' },
});
check('bearer token parsed', readBearerToken(bearerReq) === 'abc.123-xyz');
check('lowercase scheme accepted',
  readBearerToken(new Request('https://api.test/', {
    headers: { Authorization: 'bearer tok' },
  })) === 'tok');
check('no header gives null', readBearerToken(new Request('https://api.test/')) === null);
check('a non-bearer scheme is ignored',
  readBearerToken(new Request('https://api.test/', {
    headers: { Authorization: 'Basic dXNlcjpwYXNz' },
  })) === null);

// The header must win, since it is the transport that survives third-party
// cookie blocking
const bothReq = new Request('https://api.test/', {
  headers: { Authorization: 'Bearer from-header', Cookie: 'session=from-cookie' },
});
check('header takes precedence over cookie',
  readSessionToken(bothReq) === 'from-header');
check('cookie still works alone',
  readSessionToken(new Request('https://api.test/', {
    headers: { Cookie: 'session=only-cookie' },
  })) === 'only-cookie');
check('no session at all gives null',
  readSessionToken(new Request('https://api.test/')) === null);

console.log('\n4. Cookies');
check('session cookie is HttpOnly', sessionCookie('tok', Date.now() + 1000, {}).includes('HttpOnly'));
check('SameSite=None implies Secure',
  sessionCookie('tok', Date.now() + 1000, {}).includes('Secure'));
check('Lax mode omits Secure for local HTTP',
  !sessionCookie('tok', Date.now() + 1000, { SESSION_SAMESITE: 'Lax' }).includes('Secure'));
const cookieReq = new Request('https://api.test/', {
  headers: { Cookie: 'other=1; session=abc123; another=2' },
});
check('cookie parsed from a multi-value header', readCookie(cookieReq, 'session') === 'abc123');
check('missing cookie returns null', readCookie(cookieReq, 'nope') === null);
check('session tokens are long and random', newSessionToken().length >= 40);
check('session tokens are unique', newSessionToken() !== newSessionToken());

console.log('\n5. Emoji avatar validation');
const { sanitiseAvatar } = await import('./src/routes/auth-routes.js');
check('accepts a plain emoji', sanitiseAvatar('😎') === '😎');
check('accepts a multi-codepoint emoji', sanitiseAvatar('☀️') === '☀️');
check('trims whitespace', sanitiseAvatar('  🔥  ') === '🔥');
check('rejects nothing', sanitiseAvatar(null) === null && sanitiseAvatar('') === null);
check('rejects ordinary text', sanitiseAvatar('hello') === null);
check('rejects a URL path', sanitiseAvatar('/default.png') === null);
check('rejects HTML injection', sanitiseAvatar('<img>') === null);
check('rejects a quote character', sanitiseAvatar('"') === null);
check('rejects an over-long value', sanitiseAvatar('😎😎😎😎😎😎😎😎😎😎') === null);

console.log('\n6. Router dispatch');
// Every table schema.sql creates, so stubs can present a complete schema
const ALL_TABLES = [
  'users', 'posts', 'likes', 'comments', 'follow_requests', 'follows',
  'notifications', 'user_interests', 'engagement', 'feed_seen', 'hashtags',
  'post_hashtags', 'categories', 'model_meta', 'sessions',
  'token_counts', 'bigram_counts', 'phrases',
];

// Minimal D1 stub: enough for /health and a 404, no query execution needed
const stubDb = {
  prepare(sql) {
    const all = async () =>
      /sqlite_master/i.test(sql)
        ? { results: ALL_TABLES.map((name) => ({ name })) }
        : { results: [] };
    return {
      bind: () => ({ first: async () => null, all, run: async () => ({}) }),
      first: async () => null,
      all,
      run: async () => ({}),
    };
  },
  batch: async () => [],
};

const health = await worker.fetch(new Request('https://api.test/health'), { ...env, DB: stubDb });
check('health check returns 200', health.status === 200, `got ${health.status}`);
const healthBody = await health.json();
check('health check reports ok', healthBody.ok === true);

const preflight = await worker.fetch(
  new Request('https://api.test/me', {
    method: 'OPTIONS',
    headers: { Origin: 'https://sixsevenger.pages.dev' },
  }),
  { ...env, DB: stubDb }
);
check('preflight returns 204', preflight.status === 204, `got ${preflight.status}`);
check('preflight carries CORS headers',
  preflight.headers.get('Access-Control-Allow-Origin') === 'https://sixsevenger.pages.dev');
// Without this the browser blocks the session header and auth silently fails
check('preflight permits the Authorization header',
  /Authorization/i.test(preflight.headers.get('Access-Control-Allow-Headers') || ''),
  preflight.headers.get('Access-Control-Allow-Headers'));

const missing = await worker.fetch(new Request('https://api.test/nope'), { ...env, DB: stubDb });
check('unknown route returns 404', missing.status === 404, `got ${missing.status}`);

const noDb = await worker.fetch(new Request('https://api.test/me'), { ...env });
check('missing D1 binding gives a clear 500', noDb.status === 500, `got ${noDb.status}`);
const noDbBody = await noDb.json();
check('the D1 error names the binding', /D1 binding/.test(noDbBody.error), noDbBody.error);

// A logged-out caller hitting /me should be told so, not error
const me = await worker.fetch(new Request('https://api.test/me'), { ...env, DB: stubDb });
check('/me works when logged out', me.status === 200, `got ${me.status}`);
const meBody = await me.json();
check('/me reports logged out', meBody.loggedIn === false);

// Protected endpoints must refuse anonymous writes
const post = await worker.fetch(
  new Request('https://api.test/save-message', {
    method: 'POST',
    body: JSON.stringify({ message: 'hello' }),
    headers: { 'Content-Type': 'application/json' },
  }),
  { ...env, DB: stubDb }
);
check('posting while logged out is rejected', post.status === 401, `got ${post.status}`);

console.log('\n7. A bearer token authenticates a request');
// D1 stub that resolves exactly one session token to a user, so we can prove
// the header path reaches the handlers — this is what was broken cross-site.
const SESSION = 'valid-token-123';
const USER = { id: 'u1', username: 'tester', avatar: null, bio: '', guest: 0 };
function authStubDb() {
  const make = (sql) => {
    const all = async () =>
      /sqlite_master/i.test(sql)
        ? { results: ALL_TABLES.map((name) => ({ name })) }
        : { results: [] };
    return {
      bind: (...args) => ({
        first: async () => {
          if (/FROM sessions/i.test(sql)) {
            return args[0] === SESSION ? { ...USER } : null;
          }
          if (/COUNT\(\*\)/i.test(sql)) return { c: 0 };
          return null;
        },
        all,
        run: async () => ({}),
      }),
      first: async () => null,
      all,
      run: async () => ({}),
    };
  };
  return { prepare: make, batch: async () => [] };
}

const authed = await worker.fetch(
  new Request('https://api.test/me', {
    headers: { Authorization: `Bearer ${SESSION}` },
  }),
  { ...env, DB: authStubDb() }
);
const authedBody = await authed.json();
check('bearer token logs the user in', authedBody.loggedIn === true,
  JSON.stringify(authedBody).slice(0, 80));
check('the right user is resolved', authedBody.username === 'tester');

const badToken = await worker.fetch(
  new Request('https://api.test/me', {
    headers: { Authorization: 'Bearer not-a-real-token' },
  }),
  { ...env, DB: authStubDb() }
);
check('an unknown token is treated as logged out',
  (await badToken.json()).loggedIn === false);

// Same token via cookie, for the same-site deployment case
const viaCookie = await worker.fetch(
  new Request('https://api.test/me', { headers: { Cookie: `session=${SESSION}` } }),
  { ...env, DB: authStubDb() }
);
check('cookie transport still authenticates',
  (await viaCookie.json()).loggedIn === true);

console.log('\n8. An out-of-date schema degrades instead of breaking');
// This is the failure that took down posting and the feed: phrase detection
// added tables, and on a database without them "no such table" propagated out
// of loadAnalyser. Login kept working because it never touches the analyser.
const EXISTING_TABLES = [
  'users', 'posts', 'likes', 'comments', 'follow_requests', 'follows',
  'notifications', 'user_interests', 'engagement', 'feed_seen', 'hashtags',
  'post_hashtags', 'categories', 'model_meta', 'sessions',
]; // note: token_counts, bigram_counts and phrases are absent

function oldSchemaDb() {
  const make = (sql) => {
    const reject = () => {
      const table = /FROM\s+(\w+)/i.exec(sql)?.[1] || /INTO\s+(\w+)/i.exec(sql)?.[1];
      if (table && ['phrases', 'token_counts', 'bigram_counts'].includes(table)) {
        throw new Error(`D1_ERROR: no such table: ${table}`);
      }
    };
    return {
      bind: () => ({
        first: async () => { reject(); return null; },
        all: async () => { reject(); return { results: [] }; },
        run: async () => { reject(); return {}; },
      }),
      first: async () => { reject(); return null; },
      all: async () => {
        if (/sqlite_master/i.test(sql)) {
          return { results: EXISTING_TABLES.map((name) => ({ name })) };
        }
        reject();
        return { results: [] };
      },
      run: async () => { reject(); return {}; },
    };
  };
  return { prepare: make, batch: async () => [] };
}

const { loadAnalyser } = await import('./src/storage.js');
let degraded = null;
try {
  degraded = await loadAnalyser(oldSchemaDb());
  check('loadAnalyser survives a missing phrases table', true);
} catch (err) {
  check('loadAnalyser survives a missing phrases table', false, err.message);
}
check('it falls back to an empty phrase set',
  degraded !== null && degraded.phrases.size === 0);

const oldHealth = await worker.fetch(
  new Request('https://api.test/health'),
  { ...env, DB: oldSchemaDb() }
);
const oldHealthBody = await oldHealth.json();
check('health reports the schema as incomplete', oldHealthBody.schemaComplete === false);
check('health names the missing tables',
  (oldHealthBody.problems || []).some((p) => /phrases/.test(p) && /schema\.sql/.test(p)),
  (oldHealthBody.problems || [])[0]);
check('health flags itself as not ok', oldHealthBody.ok === false);

// And a complete schema should report clean
const goodHealth = await worker.fetch(
  new Request('https://api.test/health'),
  { ...env, DB: authStubDb() }
);
const goodBody = await goodHealth.json();
check('a database returning all tables has no problems',
  goodBody.problems === undefined || goodBody.problems.length === 0,
  JSON.stringify(goodBody.problems));

console.log('\n9. Feed refresh and comment response regressions');
const { handleGlobalFeed, handleAddComment } = await import('./src/routes/post-routes.js');

function feedRegressionDb(posts) {
  const recentlySeen = new Set();

  const executeAll = async (sql) => {
    if (/SELECT postId FROM feed_seen/i.test(sql)) {
      return { results: [...recentlySeen].map((postId) => ({ postId })) };
    }
    if (/SELECT p\.\*, u\.username, u\.avatar/i.test(sql)) {
      let results = posts.filter((post) => post.userId !== USER.id);
      if (/NOT EXISTS/i.test(sql)) {
        results = results.filter((post) => !recentlySeen.has(post.id));
      }
      return { results };
    }
    return { results: [] };
  };

  const executeFirst = async (sql) => {
    if (/WHERE p\.userId = \?.*p\.timestamp > \?/is.test(sql)) {
      return posts
        .filter((post) => post.userId === USER.id && post.deleted === 0)
        .filter((post) => !/NOT EXISTS/i.test(sql) || !recentlySeen.has(post.id))
        .sort((a, b) => b.timestamp - a.timestamp)[0] || null;
    }
    return null;
  };

  const prepare = (sql) => ({
    bind: (...args) => ({
      sql,
      args,
      all: () => executeAll(sql),
      first: () => executeFirst(sql),
      run: async () => ({}),
    }),
    all: () => executeAll(sql),
    first: () => executeFirst(sql),
    run: async () => ({}),
  });

  return {
    prepare,
    batch: async (statements) => {
      for (const statement of statements) {
        if (/INSERT INTO feed_seen/i.test(statement.sql || '')) {
          recentlySeen.add(statement.args[1]);
        }
      }
      return statements.map(() => ({}));
    },
    recentlySeen,
  };
}

const ownRecentPost = {
  id: 'own-new-post',
  userId: USER.id,
  username: USER.username,
  avatar: USER.avatar,
  text: 'My new post',
  timestamp: Date.now(),
  deleted: 0,
  category_id: 0,
  spam_score: 0,
  sentiment: 0,
};
const feedPosts = [ownRecentPost, ...Array.from({ length: 22 }, (_, index) => ({
  id: `post-${index}`,
  userId: `author-${index % 11}`,
  username: `author${index % 11}`,
  avatar: '🙂',
  text: `Post ${index}`,
  timestamp: Date.now() - (index + 1) * 1000,
  deleted: 0,
  category_id: 0,
  spam_score: 0,
  sentiment: 0,
}))];
const feedDb = feedRegressionDb(feedPosts);
const feedContext = {
  request: new Request('https://api.test/global-feed?limit=20'),
  env,
  db: feedDb,
  user: USER,
};
const firstFeed = await (await handleGlobalFeed(feedContext)).json();
const firstSeenCount = feedDb.recentlySeen.size;
const refreshedFeed = await (await handleGlobalFeed(feedContext)).json();
check('first feed load fills the requested page', firstFeed.length === 20,
  `got ${firstFeed.length}`);
check('latest unseen authored post is pinned first', firstFeed[0]?.id === ownRecentPost.id,
  `first=${firstFeed[0]?.id}`);
check('internal own-post marker is not exposed', firstFeed[0]?._ownRecent === undefined);
check('first feed load records served posts', firstSeenCount === 20,
  `recorded ${firstSeenCount}`);
check('immediate refresh backfills to a full page', refreshedFeed.length === 20,
  `got ${refreshedFeed.length}`);
check('refresh response contains no duplicate IDs',
  new Set(refreshedFeed.map((postItem) => postItem.id)).size === refreshedFeed.length);

const commentDb = {
  prepare(sql) {
    return {
      bind: () => ({
        first: async () => /SELECT userId, category_id FROM posts/i.test(sql)
          ? { userId: 'author-1', category_id: -1 }
          : null,
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
    };
  },
  batch: async () => [],
};
const commentResponse = await handleAddComment({
  request: new Request('https://api.test/post/post-1/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'A real comment' }),
  }),
  env,
  db: commentDb,
  user: USER,
}, { id: 'post-1' });
const commentBody = await commentResponse.json();
const createdComment = commentBody.comment;
check('comment creation uses the canonical response envelope',
  commentBody.success === true && createdComment !== undefined,
  JSON.stringify(commentBody));
check('created comment includes every renderer field',
  createdComment && ['id', 'text', 'timestamp', 'userId', 'username', 'avatar']
    .every((field) => createdComment[field] !== undefined),
  JSON.stringify(createdComment));
check('created comment text and username are defined',
  createdComment?.text === 'A real comment' && createdComment?.username === USER.username);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
