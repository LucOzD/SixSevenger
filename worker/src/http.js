// http.js — shared request/response helpers for the Worker.

/**
 * CORS. The frontend runs on Pages and the API on a Worker, so every request is
 * cross-origin. Credentials must be allowed for the session cookie to travel,
 * and when credentials are involved the browser refuses a wildcard origin — so
 * the origin is echoed back, but only if it appears in ALLOWED_ORIGINS.
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (origin && allowed.includes(origin)) {
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
