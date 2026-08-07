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
// Minimal D1 stub: enough for /health and a 404, no query execution needed
const stubDb = {
  prepare() {
    return {
      bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }),
      first: async () => null,
      all: async () => ({ results: [] }),
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
