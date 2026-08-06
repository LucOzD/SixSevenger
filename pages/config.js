// config.js — where the frontend finds the API.
//
// The site is served from Cloudflare Pages and the API from a Worker on a
// different domain, so every request is cross-origin. That has two
// consequences, both handled by the api() helper below:
//
//   1. Requests need an absolute URL, not a relative path.
//   2. They need credentials: 'include', or the browser will not send the
//      session cookie and every call looks logged out.
//
// Set PRODUCTION_API to your deployed Worker URL from `wrangler deploy`.
// A trailing slash is fine — it gets stripped.

const PRODUCTION_API = 'https://sixsevenger-api.lucas-a93.workers.dev';
const LOCAL_API = 'http://127.0.0.1:8787';

// Use the local Worker when browsing from localhost, production otherwise
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

// Strip trailing slashes so API_BASE + '/signup' cannot become '//signup'
window.API_BASE = (isLocal ? LOCAL_API : PRODUCTION_API).replace(/\/+$/, '');

/**
 * fetch() against the API with the session cookie attached.
 * Takes the same paths the old Express routes used, e.g. api('/me').
 */
window.api = function api(path, options = {}) {
  const url = window.API_BASE + (path.startsWith('/') ? path : '/' + path);
  return fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
};

/**
 * Turn a failed api() call into something actionable.
 *
 * When the browser blocks a cross-origin request it rejects the promise with a
 * bare TypeError and deliberately withholds the reason, so a CORS problem is
 * indistinguishable from the server being down. Since a misconfigured
 * ALLOWED_ORIGINS is by far the most common cause after deploying, the message
 * says so rather than only blaming connectivity.
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
