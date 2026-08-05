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

## Step 2 — Create the tables

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
the calling origin.

In `worker/wrangler.toml`, add your Pages URL to `ALLOWED_ORIGINS`:

```toml
ALLOWED_ORIGINS = "https://sixsevenger.pages.dev,http://localhost:8788"
```

Then redeploy the Worker:

```
cd worker
npx wrangler deploy
```

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
table, in an `HttpOnly` cookie.

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

**Everything returns 401, or you cannot stay logged in.**
Almost always CORS or cookies. Check that your exact Pages origin is in
`ALLOWED_ORIGINS` (scheme included, no trailing slash) and that you redeployed
the Worker afterwards. Locally, check `SESSION_SAMESITE = "Lax"`.

**`D1 binding "DB" is missing`.**
`database_id` in `wrangler.toml` is still the placeholder, or you deployed
before saving it.

**Tables do not exist.**
You ran `d1 execute` without `--remote`, so the schema went to the local
database instead of the deployed one.

**The feed is empty on a new account.**
Expected. With no posts there is nothing to rank. Create a couple of accounts
and post from each — the recommender needs content before categories appear.

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

One thing to know: **profile picture uploads are not wired up yet.** The Express
version wrote them to disk with multer, which Workers cannot do. That needs R2
(Cloudflare's object storage) and is the main remaining gap — signup, posting,
voting, comments, follows, notifications, hashtags and the admin views all work
without it.
