// config.js — where the frontend finds the API, and how it stays logged in.
//
// The site is served from Cloudflare Pages (or your own domain) and the API from
// a Worker on a different domain, so every request is cross-origin.
//
// Auth travels in an Authorization header rather than a cookie. A cookie set by
// the Worker's domain is a THIRD-PARTY cookie to this site, and browsers block
// those by default now — Safari and Firefox outright, Chrome progressively —
// regardless of SameSite=None. The symptom was signing up fine and then being
// logged out on the very next request.
//
// Set PRODUCTION_API to your deployed Worker URL. A trailing slash is fine.

const PRODUCTION_API = 'https://sixsevenger-api.lucas-a93.workers.dev';
const LOCAL_API = 'http://127.0.0.1:8787';

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

// Strip trailing slashes so API_BASE + '/signup' cannot become '//signup'
window.API_BASE = (isLocal ? LOCAL_API : PRODUCTION_API).replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Session token storage
//
// Kept in localStorage because it must survive a page load and be readable by
// script in order to be sent as a header. That does mean it is exposed to XSS,
// unlike an HttpOnly cookie — which is why every render path escapes user
// content. If you move the Worker onto a subdomain of this site
// (api.yourdomain.com) the cookie becomes first-party and this is no longer
// needed; the Worker accepts either.
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'sixsevenger_session';

window.getSessionToken = function getSessionToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private browsing can make localStorage throw
  }
};

window.setSessionToken = function setSessionToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing useful to do; the cookie fallback may still work
  }
};

window.clearSessionToken = function clearSessionToken() {
  window.setSessionToken(null);
};

/**
 * fetch() against the API with the session attached.
 * Takes the same paths the old Express routes used, e.g. api('/me').
 */
window.api = function api(path, options = {}) {
  const url = window.API_BASE + (path.startsWith('/') ? path : '/' + path);
  const token = window.getSessionToken();

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = 'Bearer ' + token;

  return fetch(url, {
    ...options,
    // Still included so the cookie is used when the API is same-site
    credentials: 'include',
    headers,
  });
};

/**
 * Call an auth endpoint and store the returned token.
 * Used by the login and signup forms.
 */
window.apiAuth = async function apiAuth(path, body) {
  const res = await window.api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: 'Unexpected response from server' }));
  if (data.success && data.token) window.setSessionToken(data.token);
  return data;
};

/**
 * Turn a failed api() call into something actionable.
 *
 * When the browser blocks a cross-origin request it rejects with a bare
 * TypeError and deliberately withholds the reason, so a CORS problem is
 * indistinguishable from the server being down.
 */
window.apiErrorMessage = function apiErrorMessage(err) {
  if (err && err.name === 'TypeError') {
    return (
      'Could not reach the API at ' + window.API_BASE + '. ' +
      'Either it is not deployed, or this site\'s address is missing from ' +
      'ALLOWED_ORIGINS in the Worker config. ' +
      'Open ' + window.API_BASE + '/health to check.'
    );
  }
  return (err && err.message) || 'Something went wrong.';
};
