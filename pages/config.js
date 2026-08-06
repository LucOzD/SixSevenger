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
// Set API_BASE to your deployed Worker URL after running `wrangler deploy`.

const PRODUCTION_API = 'https://sixsevenger-api.lucas-a93.workers.dev/';
const LOCAL_API = 'http://127.0.0.1:8787';

// Use the local Worker when browsing from localhost, production otherwise
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
window.API_BASE = isLocal ? LOCAL_API : PRODUCTION_API;

/**
 * fetch() against the API with the session cookie attached.
 * Takes the same paths the old Express routes used, e.g. api('/me').
 */
window.api = function api(path, options = {}) {
  return fetch(window.API_BASE + path, {
    ...options,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
};
