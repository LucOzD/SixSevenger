# Deploying SixSevenger to Cloudflare

Two pieces get deployed:

| Piece | Goes to | Lives in |
|---|---|---|
| API + recommender | Cloudflare **Workers** | `worker/` |
| Website | Cloudflare **Pages** | `pages/` |

Your original Node + Python app in the project root is untouched and still runs
with `npm start`. Nothing here changes it.

---

## Before you start

You need a Cloudflare account (the free tier covers all of this) and the
Wrangler CLI. Wrangler is not installed yet — the commands below use `npx`,
which fetches it on demand, so there is nothing to install globally.

Log in first. This opens a browser window:

```
npx wrangler login
```

---

## Step 1 — Create the database

D1 is Cloudflare's SQLite. From the `worker` directory:

```
cd worker
npx wrangler d1 create sixsevenger
```

It prints something like:

```
[[d1_databases]]
binding = "DB"
database_name = "sixsevenger"
database_id = "a1b2c3d4-...."
```

**Copy that `database_id`** and paste it into `worker/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`. The deploy will fail with a binding error if
you skip this.

First time only — and after any update that adds tables (such as posting mutes
or comment likes) — apply the schema. The statements are idempotent, so it is
safe to rerun:

```
npx wrangler d1 execute sixsevenger --file=./schema.sql --remote
```

The `--remote` flag matters. Without it you create the tables in a local
simulated database and the deployed Worker sees nothing.

Check it worked:

```
npx wrangler d1 execute sixsevenger --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

You should see `users`, `posts`, `likes`, `categories`, `sessions` and the rest.

## Step 3 — Deploy the Worker

```
npx wrangler deploy
```

It prints your API URL, something like:

```
https://sixsevenger-api.your-subdomain.workers.dev
```

**Copy that URL.** Confirm it's alive:

```
curl https://sixsevenger-api.your-subdomain.workers.dev/health
```

Expect `{"ok":true,"time":...}`. If you get an error about the D1 binding, Step 1
did not take.

## Step 4 — Point the frontend at the Worker

Open `pages/config.js` and set `PRODUCTION_API` to the URL from Step 3:

```js
const PRODUCTION_API = 'https://sixsevenger-api.your-subdomain.workers.dev';
```

No trailing slash.

## Step 5 — Deploy the website

```
cd ..
npx wrangler pages deploy pages --project-name sixsevenger
```

First run asks whether to create the project — say yes. It prints your site URL:

```
https://sixsevenger.pages.dev
```

## Step 6 — Let the API trust the website

This step is easy to miss and **nothing will work without it**. The browser
blocks cross-origin requests carrying cookies unless the API explicitly names
the calling origin — and it hides the reason from the page, so the only symptom
is a generic "could not reach the API" message.

`ALLOWED_ORIGINS` in `worker/wrangler.toml` is already set up for a Pages
project named `sixsevenger`:

```toml
ALLOWED_ORIGINS = "https://sixsevenger.pages.dev,https://*.sixsevenger.pages.dev,http://localhost:8788,http://127.0.0.1:8788"
```

**If Step 5 printed a different URL, change both `sixsevenger` entries to
match.** Then redeploy the Worker so the change takes effect:

```
cd worker
npx wrangler deploy
```

The `*.` wildcard is there because Pages gives every deployment its own
subdomain, like `a1b2c3.sixsevenger.pages.dev`. Without it, preview builds would
all be blocked even though production worked.

It is scoped to your project's subdomains deliberately. Do not widen it to
`https://*.pages.dev` — that would let any site hosted on Pages call your API
using a logged-in visitor's cookie. The Worker refuses a wildcard that broad
anyway.

### Custom domains

If you attach custom domains to the Pages project, add them too. **Use
`https://`** — Cloudflare serves custom domains over HTTPS, so an `http://`
entry will never match what the browser sends, and the request is rejected with
no explanation in the page. Only `localhost` should be `http`.

A wildcard saves listing each subdomain:

```toml
ALLOWED_ORIGINS = "https://*.yourdomain.com,https://yourdomain.com,..."
```

Note `https://*.yourdomain.com` covers `www.` and `app.` but **not**
`yourdomain.com` itself — a wildcard requires a subdomain, so list the apex
separately if you use it.

Wildcards directly over shared hosting (`https://*.pages.dev`,
`https://*.workers.dev`) are ignored by the Worker, since they would trust every
other site on that platform. A wildcard under your own subdomain of one, like
`https://*.myproject.pages.dev`, is fine.

Worth considering: the API currently runs on `workers.dev` while the site is on
your domain, so cookies are cross-site and depend on `SameSite=None`. Putting
the Worker on a custom domain of its own (`api.yourdomain.com`) would make
requests same-site, which is more robust and lets you use `SameSite=Lax`. Set it
under Workers → your worker → Settings → Domains & Routes, then update
`PRODUCTION_API` in `pages/config.js`.

To check what the API thinks, open this in a browser:

```
https://sixsevenger-api.YOUR-SUBDOMAIN.workers.dev/health
```

It reports the D1 binding status and the origins it accepts. Called from your
site's console it also reports whether *your* origin passes:

```js
fetch(API_BASE + '/health', { credentials: 'include' }).then(r => r.json()).then(console.log)
```

Look for `"originAllowed": true`.

Now open your Pages URL and create an account.

---

## Local development

Two terminals.

**Terminal 1** — the API, on `http://127.0.0.1:8787`:

```
cd worker
npx wrangler dev
```

First time only, create the local tables (note: no `--remote`):

```
npx wrangler d1 execute sixsevenger --file=./schema.sql
```

**Terminal 2** — the website, on `http://localhost:8788`:

```
npx wrangler pages dev pages
```

`config.js` detects localhost and points at the local Worker automatically.

One catch: session cookies are set with `SameSite=None`, which browsers only
accept over HTTPS. Over local HTTP the cookie is dropped and you stay logged
out. For local testing set this in `worker/wrangler.toml`:

```toml
SESSION_SAMESITE = "Lax"
```

Set it back to `None` before deploying, or logins break in production.

---

## Running the tests

The recommender logic has no Cloudflare dependencies, so it tests in plain Node:

```
cd worker
npm test
```

Three suites run: the vectorizer, the VADER sentiment port (checked against
NLTK's own output on 96 cases), and the recommender.

---

## What changed from the Express version

Most of it is a straight port. Four things genuinely differ, and all four are
forced by the platform rather than choices:

**Python is gone.** The recommender used scikit-learn only for
`HashingVectorizer` and its stop-word list, plus NLTK for VADER. Both are now
JavaScript: feature hashing via MurmurHash3, and a VADER port that matches
NLTK's scores exactly on all 96 test cases. Workers cannot run a Flask process,
and this removed the need to.

**The model lives in D1, not a pickle file.** `recommender_state.pkl` needed a
disk, which Workers do not have. Category centroids, word counts and sentiment
averages are now rows in a `categories` table, loaded at the start of a request
and written back after. Centroids are pruned to their strongest 128 dimensions,
because averaging sparse vectors slowly fills all 4096 and loading full ones on
every request would move hundreds of KB per call.

**Sessions replaced the userId cookie.** The old cookie held your user id in
plain text with `httpOnly: false`, so anyone could impersonate any user by
editing it in devtools. Sessions are now random opaque tokens in a `sessions`
table.

**Auth travels in a header, not a cookie.** This one is worth understanding,
because the symptom is confusing: you can sign up successfully and then be
logged out on the very next request.

A cookie set by the Worker's domain is a **third-party cookie** to a frontend on
a different domain, and browsers block those by default now — Safari and Firefox
outright, Chrome progressively — no matter what `SameSite=None; Secure` says. So
the session token is returned in the login and signup response body, stored in
`localStorage`, and sent as `Authorization: Bearer <token>`. A header is
unaffected by cookie policy and works on any domain pairing.

The Worker accepts **either** transport, header first. The `HttpOnly` cookie is
still set and still honoured, which matters because it is safe from XSS whereas
`localStorage` is not. If you put the Worker on a subdomain of your own site
(`api.yourdomain.com`) the cookie becomes first-party and is used automatically —
that is the more secure setup, and nothing in the code needs changing for it.

Because `localStorage` is readable by script, every render path escapes user
content. That was already true, but it matters more now.

**Passwords use PBKDF2 instead of bcrypt.** bcryptjs is pure JavaScript and
slow enough to risk the Worker CPU limit; PBKDF2 runs on native WebCrypto.
Consequence: **old bcrypt hashes cannot be verified, so accounts must be
recreated.** Your existing posts also do not carry over, which you said was
fine — `database.db` is gitignored and the new database starts empty.

I also fixed two things the tests caught, which affect the original Python code
too:

- Two short unrelated posts sharing one common word (like "best") scored a high
  enough cosine to merge, which is how "GD is the best game ever" and "coca cola
  is the best drink ever" landed in one category. A match now needs at least two
  shared features.
- sklearn's stop-word list contains "six", so `six seven is amazing` reduced to
  `[seven, amazing]` and those posts fragmented into a category each. Number
  words are no longer stripped.

---

## Troubleshooting

**"Could not reach the API" when signing up or logging in.**
This is nearly always CORS, not connectivity. The browser blocks the request and
refuses to tell the page why, so it surfaces as a network error.

1. Open `<your-worker-url>/health` in a browser. If that fails, the Worker
   itself is not deployed.
2. From the failing site's console, run:
   ```js
   fetch(API_BASE + '/health', { credentials: 'include' }).then(r => r.json()).then(console.log)
   ```
   If `originAllowed` is `false`, a `problems` array explains exactly why —
   scheme mismatch, an ignored wildcard, or a missing entry.
3. Fix `ALLOWED_ORIGINS` in `worker/wrangler.toml`, then **redeploy the Worker** —
   editing the file alone changes nothing.
4. `npx wrangler tail` logs the same hints server-side on every rejection.

The most common cause with custom domains is `http://` where it should be
`https://`.

**Signup works but then you are logged out, and cannot post.**
The session is not reaching the API. Requests carry it as
`Authorization: Bearer <token>` from `localStorage`, so check in the browser
console:

```js
localStorage.getItem('sixsevenger_session')
```

If that is `null`, the login response did not include a token — make sure the
Worker is redeployed, since returning the token in the body was added alongside
this. If it has a value but requests still 401, the token may be expired; log out
and back in.

This used to fail because auth relied on a cookie, which is a third-party cookie
when the API is on a different domain and therefore blocked by default.

**Everything returns 401 immediately after deploying.**
Check `SESSION_SAMESITE` is `"None"` in production (it needs HTTPS), or `"Lax"`
for local HTTP. This only affects the cookie fallback, not the header.

**`D1 binding "DB" is missing`.**
`database_id` in `wrangler.toml` is still the placeholder, or you deployed
before saving it.

**Tables do not exist.**
You ran `d1 execute` without `--remote`, so the schema went to the local
database instead of the deployed one.

**The feed is empty on a new account.**
Expected. With no posts there is nothing to rank. Create a couple of accounts
and post from each — the recommender needs content before categories appear.

**Avatars all look the same.**
Users who have not picked an emoji get one derived from their username, so two
accounts with similar names can land nearby in the palette. Pick one explicitly
on the profile page.

**Watch live logs:**

```
cd worker
npx wrangler tail
```

---

## Costs

Everything here fits Cloudflare's free tier at this scale: 100,000 Worker
requests a day, 5 GB of D1 storage, and unlimited Pages requests. Verify current
limits yourself, as they change.

No object storage is used, so there is nothing to outgrow on the storage side
either — see the avatar note below.

---

## Phrase detection

Word pairs that occur together far more often than chance get promoted to a
single token. "geometry dash" becomes one feature `geometry_dash` instead of
competing with "geometry" and "dash" separately.

The constituent words are **damped, not removed** — they keep 30% weight, so a
post about geometry homework still registers partial similarity with a Geometry
Dash post rather than none at all.

Two measures decide promotion, and a pair qualifies on either:

- **Score** — the word2vec phrase measure, `(count(ab) - discount) / (count(a) *
  count(b)) * totalTokens`. Good at spotting rare-but-exclusive pairs.
- **Cohesion** — of all the times the rarer word appears, how often is it in this
  pair? Good at spotting frequent pairs.

Both are needed. Measured on real posts, "paul hogan" (4 occurrences) scored 59
on the first measure while "six seven" (32 occurrences, essentially never apart)
scored only 10 — the obvious phrase lost to the rare one, because that measure
divides by the product of individual counts and so penalises frequency. Cohesion
catches it at 0.97, where incidental pairs like "hate geometry" sit at 0.56.

Self-pairs are excluded. Repeating hashtags to weight them produces runs like
"gdsucks gdsucks gdsucks", which otherwise look like a strong collocation.

Review runs every 20 posts rather than on every post, since it rescans the top
pairs and rewrites the table. If it fails, the post is still saved.

Inspect what has been learned (as the admin user):

```
GET /admin/phrases
```

On the current sample data it finds: `paul hogan`, `coca cola`, `robert topalo`,
`geometry dash`, `six seven`.

Thresholds live in `worker/src/phrases.js` and are covered by
`npm run test:phrases`, which scores real posts and asserts the right pairs are
promoted.

---

## Avatars are emoji, not uploads

The Express version saved uploaded images to disk with multer. Workers have no
disk, and the usual answer is R2 (object storage), which this project
deliberately avoids. Instead each user picks an **emoji**, and the background
colour is derived from their username.

Why this is a good trade at this size:

- An emoji is a handful of bytes in D1. A small PNG is tens of kilobytes.
- Nothing is stored per user beyond that emoji — the colour is computed, not saved.
- There is no image request at all, so pages render faster.
- No object storage, no image resizing, no upload limits, no moderation of
  uploaded images.

How it works:

- `pages/avatar.js` holds the 48-emoji picker set, the colour palette, and
  `avatarHtml()` which every render site calls.
- Users who never choose one still get a distinct avatar: the username is hashed
  to pick from the same set, so it is stable and nobody is left blank.
- The Worker validates the value on the way in (`sanitiseAvatar`): max 8
  characters to allow multi-codepoint emoji like ☀️, and anything resembling
  text, a path, or HTML is rejected. Render sites escape as well.

If you ever want real image uploads, the change is contained: swap
`avatarHtml()` for an `<img>` and store a URL in the same `avatar` column.


---

## Personalized ads

The admin ad editor is available at `/admin-ads.html`. Each ad has text, an
optional emoji, an optional same-site image path, an HTTPS destination, and a
comma-separated keyword list. Keyword vectors are generated by the Worker and
compared with a logged-in user's weighted category-centroid vector. On each
full 20-slot feed page, the most relevant currently active campaign occupies
the final slot in place of an organic post; the displaced post remains eligible
for the next page. Minimum similarity and frequency settings guide preference
and rotation without leaving a scheduled ad slot empty when inventory exists.
Selection keeps the highest-ranked campaign as the 70% default and uses the
remaining 30% for weighted exploration among up to three strong alternatives,
so relevance remains dominant without one campaign monopolizing every slot.
Guests receive an untracked, non-personalized active fallback. Feed traversal
continues through successive ranked windows, while the browser keeps every
rendered post ID for the lifetime of that page and will never append that post
a second time. After the available pool is shown, quiet retries use backend
cycles only to discover newly-created posts; previously rendered posts and ads
from duplicate-only responses are discarded.

Ad images remain ordinary Pages assets—put them under `pages/ad-assets/` and
enter a path such as `/ad-assets/controller.png`. This keeps ads on the same
site and does not require R2 or third-party image requests.

Before deploying Worker code with ads for the first time, apply the migration:

```
cd worker
npx --yes wrangler@4.120.1 d1 execute sixsevenger --file=./migrations/0001_ads.sql --remote --yes
```

Deliveries reserve frequency-cap slots. An impression is counted after at least
half the card has been visible for one second; clicks and impressions are
idempotent per delivery. Targeting and tracking stay inside D1, and no interest
vector or category profile is sent to the destination site.