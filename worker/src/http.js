// http.js — shared request/response helpers for the Worker.

/**
 * CORS. The frontend runs on Pages and the API on a Worker, so every request is
 * cross-origin. Credentials must be allowed for the session cookie to travel,
 * and when credentials are involved the browser refuses a wildcard origin — so
 * the origin is echoed back, but only if it appears in ALLOWED_ORIGINS.
 */
/**
 * Domains where anyone can host a site on a subdomain. A wildcard directly over
 * one of these would trust every other customer of that platform, so those are
 * refused. A more specific wildcard under one is fine:
 * `*.pages.dev` is refused, `*.myproject.pages.dev` is allowed.
 */
const SHARED_HOSTING_SUFFIXES = [
  '.pages.dev', '.workers.dev', '.github.io', '.gitlab.io',
  '.vercel.app', '.netlify.app', '.onrender.com', '.fly.dev',
  '.herokuapp.com', '.web.app', '.firebaseapp.com',
  '.azurewebsites.net', '.repl.co', '.glitch.me', '.surge.sh',
];

/**
 * Would this wildcard entry trust sites the operator does not control?
 * Returns a reason string when unsafe, or null when fine.
 */
export function unsafeWildcardReason(suffix) {
  const labels = suffix.split('.').filter(Boolean);

  // '*.com' or '*.dev' would match most of the internet
  if (labels.length < 2) {
    return `"${suffix}" is too broad — it needs at least a domain and a TLD`;
  }
  if (SHARED_HOSTING_SUFFIXES.includes(suffix)) {
    return `"${suffix}" is shared hosting — anyone can put a site on it. ` +
           `Use a wildcard under your own subdomain instead.`;
  }
  return null;
}

/**
 * Is this origin permitted?
 *
 * Entries are matched exactly, except that a leading `*.` wildcard is allowed in
 * the hostname — for example `https://*.sixsevenger.pages.dev` or
 * `https://*.yourdomain.com`.
 *
 * The wildcard exists because Cloudflare Pages gives every deployment its own
 * subdomain, so an exact-match list would reject every preview build.
 *
 * The scheme is compared strictly. Cloudflare serves custom domains over HTTPS,
 * so an `http://` entry for one will never match — see the scheme-mismatch
 * warning in index.js, which exists because this was easy to get wrong.
 */
export function isOriginAllowed(origin, allowedList) {
  if (!origin) return false;

  for (const entry of allowedList) {
    if (entry === origin) return true;

    const wildcardAt = entry.indexOf('://*.');
    if (wildcardAt === -1) continue;

    const scheme = entry.slice(0, wildcardAt + 3);  // 'https://'
    const suffix = entry.slice(wildcardAt + 4);      // '.yourdomain.com'

    if (unsafeWildcardReason(suffix)) continue;

    if (!origin.startsWith(scheme)) continue;

    // scheme already ends in '://', so strip exactly its length
    const host = origin.slice(scheme.length);

    // host must be longer than the suffix, so a wildcard requires an actual
    // subdomain: '*.a.com' matches 'x.a.com' but not 'a.com'
    if (host.length > suffix.length && host.endsWith(suffix)) return true;
  }
  return false;
}

export function parseAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '')) // tolerate trailing slashes
    .filter(Boolean);
}

/**
 * Explain why an origin was rejected. Returns human-readable hints.
 *
 * These exist because every one of them has actually caught someone out: the
 * browser refuses to say why it blocked a cross-origin request, so a
 * misconfiguration is indistinguishable from the server being down.
 */
export function diagnoseOrigin(origin, allowedList) {
  const hints = [];
  if (!origin) return hints;

  // Same host, wrong scheme. Cloudflare serves custom domains over HTTPS, so an
  // http:// entry never matches.
  const swapped = origin.startsWith('https://')
    ? origin.replace('https://', 'http://')
    : origin.replace('http://', 'https://');
  if (allowedList.includes(swapped)) {
    hints.push(
      `Scheme mismatch. The list has "${swapped}" but the browser sent ` +
      `"${origin}". Change it to "${origin}".`
    );
  }

  // Wildcards that were skipped for being unsafe
  for (const entry of allowedList) {
    const wildcardAt = entry.indexOf('://*.');
    if (wildcardAt === -1) continue;
    const reason = unsafeWildcardReason(entry.slice(wildcardAt + 4));
    if (reason) hints.push(`Ignoring wildcard "${entry}": ${reason}`);
  }

  // Wildcard exists for the domain but the origin is the apex, which '*.' does
  // not cover
  try {
    const host = new URL(origin).host;
    for (const entry of allowedList) {
      const wildcardAt = entry.indexOf('://*.');
      if (wildcardAt === -1) continue;
      const suffix = entry.slice(wildcardAt + 4);
      if (`.${host}` === suffix) {
        hints.push(
          `"${entry}" only covers subdomains. Add "${origin}" separately to ` +
          `allow the domain itself.`
        );
      }
    }
  } catch {
    hints.push(`"${origin}" is not a valid origin.`);
  }

  if (hints.length === 0) {
    hints.push(`Add "${origin}" to ALLOWED_ORIGINS, then redeploy the Worker.`);
  }
  return hints;
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowedOrigins(env);

  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    // Authorization must be listed or the preflight rejects the session header,
    // which is how auth travels when the site and API are on different sites
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (isOriginAllowed(origin, allowed)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function json(data, { status = 200, request, env, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(request ? corsHeaders(request, env) : {}),
      ...extraHeaders,
    },
  });
}

export const badRequest = (msg, ctx) => json({ error: msg }, { status: 400, ...ctx });
export const unauthorized = (msg, ctx) => json({ error: msg || 'Login required' }, { status: 401, ...ctx });
export const forbidden = (msg, ctx) => json({ error: msg || 'Not authorized' }, { status: 403, ...ctx });
export const notFound = (msg, ctx) => json({ error: msg || 'Not found' }, { status: 404, ...ctx });

/** Parse a JSON body, tolerating empty or malformed input. */
export async function readJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Tiny path router. Patterns use :name segments, e.g. '/post/:id/like'.
 * Returns { params } on a match, or null.
 */
export function matchPath(pattern, pathname) {
  const pParts = pattern.split('/').filter(Boolean);
  const uParts = pathname.split('/').filter(Boolean);
  if (pParts.length !== uParts.length) return null;

  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) {
      params[pParts[i].slice(1)] = decodeURIComponent(uParts[i]);
    } else if (pParts[i] !== uParts[i]) {
      return null;
    }
  }
  return { params };
}

export function uuid() {
  return crypto.randomUUID();
}
