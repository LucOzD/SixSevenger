// index.js — Cloudflare Worker entry point for the SixSevenger API.
//
// Replaces the Express server. The frontend is served separately from
// Cloudflare Pages, so this Worker only speaks JSON and handles CORS.
//
// Request flow: resolve the session cookie to a user, match the path against
// the route table, run the handler. Handlers receive a ctx object holding the
// request, env, D1 binding and the resolved user.

import {
  corsHeaders, json, notFound, matchPath,
  isOriginAllowed, parseAllowedOrigins,
} from './http.js';
import { getSessionUser, readCookie } from './auth.js';

import {
  handleSignup, handleLogin, handleLogout, handleMe, handleUpdateProfile,
} from './routes/auth-routes.js';

import {
  handleSavePost, handleMyPosts, handleDeletePost, handleVote,
  handleGetComments, handleAddComment, handleTrackEngagement,
  handlePostDetails, handleGlobalFeed,
} from './routes/post-routes.js';

import {
  handleUserProfile, handleRequestFollow, handleFollowRequests,
  handleAcceptFollow, handleUnfollow, handleMyFollowers, handleMyFollowing,
  handleNotifications, handleMarkNotificationsRead, handleDismissNotification,
} from './routes/social-routes.js';

import {
  handleHashtag, handleAdminUsers, handleAdminCategories,
  handleAdminUserInterests, handleAdminPhrases,
} from './routes/misc-routes.js';

// Route table. Order matters only where patterns could overlap; these do not.
const ROUTES = [
  ['GET',  '/me',                        handleMe],
  ['POST', '/signup',                    handleSignup],
  ['POST', '/login',                     handleLogin],
  ['POST', '/logout',                    handleLogout],
  ['POST', '/update-profile',            handleUpdateProfile],

  ['POST', '/save-message',              handleSavePost],
  ['GET',  '/my-posts',                  handleMyPosts],
  ['POST', '/post/:id/delete',           handleDeletePost],
  ['POST', '/post/:id/like',             handleVote],
  ['GET',  '/post/:id/comments',         handleGetComments],
  ['POST', '/post/:id/comment',          handleAddComment],
  ['GET',  '/post-details/:id',          handlePostDetails],
  ['GET',  '/global-feed',               handleGlobalFeed],
  ['POST', '/track-engagement',          handleTrackEngagement],

  ['GET',  '/user/:id',                  handleUserProfile],
  ['POST', '/user/:id/request-follow',   handleRequestFollow],
  ['GET',  '/follow-requests',           handleFollowRequests],
  ['POST', '/follow-request/:id/accept', handleAcceptFollow],
  ['POST', '/unfollow/:id',              handleUnfollow],
  ['GET',  '/my-followers',              handleMyFollowers],
  ['GET',  '/my-following',              handleMyFollowing],

  ['GET',  '/notifications',             handleNotifications],
  ['POST', '/notifications/mark-read',   handleMarkNotificationsRead],
  ['POST', '/notifications/:id/dismiss', handleDismissNotification],

  ['GET',  '/api/hashtag/:tag',          handleHashtag],

  ['GET',  '/admin/users',               handleAdminUsers],
  ['GET',  '/admin/categories',          handleAdminCategories],
  ['GET',  '/admin/phrases',             handleAdminPhrases],
  ['GET',  '/admin/user/:id/interests',  handleAdminUserInterests],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Warn loudly on a rejected origin. The browser hides the reason from the
    // page, so without this the only symptom is a generic network error.
    // Visible via: npx wrangler tail
    const origin = request.headers.get('Origin');
    if (origin && !isOriginAllowed(origin, parseAllowedOrigins(env))) {
      console.warn(
        `CORS: rejected origin ${origin}. ` +
        `Add it to ALLOWED_ORIGINS in wrangler.toml and redeploy. ` +
        `Currently allowed: ${JSON.stringify(parseAllowedOrigins(env))}`
      );
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (!env.DB) {
      return json(
        { error: 'D1 binding "DB" is missing. Check wrangler.toml.' },
        { status: 500, request, env }
      );
    }

    // Health check. Also reports how CORS sees the caller, because a blocked
    // origin looks identical to an unreachable server from the browser's side.
    if (url.pathname === '/health') {
      const origin = request.headers.get('Origin');
      const allowed = parseAllowedOrigins(env);
      return json({
        ok: true,
        time: Date.now(),
        database: env.DB ? 'bound' : 'MISSING',
        yourOrigin: origin || '(none - opened directly)',
        originAllowed: origin ? isOriginAllowed(origin, allowed) : null,
        allowedOrigins: allowed,
      }, { request, env });
    }

    const db = env.DB;
    const sessionToken = readCookie(request, 'session');

    let user = null;
    try {
      user = await getSessionUser(db, sessionToken);
    } catch {
      user = null; // an invalid or expired token is simply treated as logged out
    }

    const ctx = { request, env, db, user, sessionToken };

    for (const [method, pattern, handler] of ROUTES) {
      if (method !== request.method) continue;
      const match = matchPath(pattern, url.pathname);
      if (!match) continue;

      try {
        return await handler(ctx, match.params);
      } catch (err) {
        // Log for `wrangler tail`, but never leak internals to the client
        console.error(`${request.method} ${url.pathname} failed:`, err?.stack || err);
        return json({ error: 'Internal error' }, { status: 500, request, env });
      }
    }

    return notFound(`No route for ${request.method} ${url.pathname}`, ctx);
  },
};
