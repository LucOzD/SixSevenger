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
  isOriginAllowed, parseAllowedOrigins, diagnoseOrigin,
} from './http.js';
import { getSessionUser, readSessionToken } from './auth.js';

import {
  handleSignup, handleLogin, handleLogout, handleMe, handleUpdateProfile,
} from './routes/auth-routes.js';

import {
  handleSavePost, handleMyPosts, handleMyComments, handleDeletePost, handleVote,
  handleGetComments, handleAddComment, handleCommentLike, handleTrackEngagement,
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
  handleAdminDeletePost, handleAdminDeleteUser,
} from './routes/misc-routes.js';

import {
  handleAdminAds, handleAdminSaveAd, handleAdImpression, handleAdClick,
} from './routes/ad-routes.js';

// Tables schema.sql creates. /health compares against this so a partially
// migrated database reports itself instead of failing obscurely at runtime.
const REQUIRED_TABLES = [
  'users', 'posts', 'likes', 'comments', 'comment_likes', 'posting_mutes',
  'posting_violations', 'follow_requests', 'follows', 'notifications',
  'user_interests', 'engagement', 'feed_seen',
  'hashtags', 'post_hashtags',
  'categories', 'model_meta', 'sessions',
  'token_counts', 'bigram_counts', 'phrases',
  'ads', 'ad_deliveries',
];

// Route table. Order matters only where patterns could overlap; these do not.
const ROUTES = [
  ['GET',  '/me',                        handleMe],
  ['POST', '/signup',                    handleSignup],
  ['POST', '/login',                     handleLogin],
  ['POST', '/logout',                    handleLogout],
  ['POST', '/update-profile',            handleUpdateProfile],

  ['POST', '/save-message',              handleSavePost],
  ['GET',  '/my-posts',                  handleMyPosts],
  ['GET',  '/my-comments',               handleMyComments],
  ['POST', '/post/:id/delete',           handleDeletePost],
  ['POST', '/post/:id/like',             handleVote],
  ['GET',  '/post/:id/comments',         handleGetComments],
  ['POST', '/post/:id/comment',          handleAddComment],
  ['POST', '/comment/:id/like',          handleCommentLike],
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
  ['GET',  '/admin/ads',                 handleAdminAds],
  ['POST', '/admin/ads',                 handleAdminSaveAd],
  ['POST', '/admin/ads/:id',             handleAdminSaveAd],
  ['GET',  '/admin/user/:id/interests',  handleAdminUserInterests],
  ['POST', '/admin/post/:id/delete',     handleAdminDeletePost],
  ['POST', '/admin/user/:id/delete',     handleAdminDeleteUser],

  ['POST', '/ads/:id/impression',        handleAdImpression],
  ['POST', '/ads/:id/click',             handleAdClick],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Warn loudly on a rejected origin. The browser hides the reason from the
    // page, so without this the only symptom is a generic network error.
    // Visible via: npx wrangler tail
    const origin = request.headers.get('Origin');
    if (origin) {
      const allowedList = parseAllowedOrigins(env);
      if (!isOriginAllowed(origin, allowedList)) {
        console.warn(
          `CORS: rejected origin ${origin}. ` +
          `Currently allowed: ${JSON.stringify(allowedList)}`
        );
        for (const hint of diagnoseOrigin(origin, allowedList)) {
          console.warn(`CORS hint: ${hint}`);
        }
      }
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

    // Health check. Reports how CORS sees the caller and whether the schema is
    // complete, because both fail in ways the browser reports only as a generic
    // error.
    if (url.pathname === '/health') {
      const origin = request.headers.get('Origin');
      const allowed = parseAllowedOrigins(env);
      const originAllowed = origin ? isOriginAllowed(origin, allowed) : null;

      const problems = [];
      if (originAllowed === false) problems.push(...diagnoseOrigin(origin, allowed));

      // Which tables actually exist. A missing table breaks specific features
      // while leaving others working, which is hard to diagnose from outside.
      let tables = null;
      let missing = [];
      if (env.DB) {
        try {
          const rows = await env.DB
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all();
          tables = (rows.results || []).map((r) => r.name).sort();
          missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
          if (missing.length > 0) {
            problems.push(
              `Missing tables: ${missing.join(', ')}. Run: ` +
              `npx wrangler d1 execute sixsevenger --file=./schema.sql --remote`
            );
          }
        } catch (err) {
          problems.push(`Could not read the schema: ${err.message}`);
        }
      }

      return json({
        ok: problems.length === 0,
        time: Date.now(),
        database: env.DB ? 'bound' : 'MISSING',
        schemaComplete: env.DB ? missing.length === 0 : null,
        tables,
        yourOrigin: origin || '(none - opened directly)',
        originAllowed,
        allowedOrigins: allowed,
        problems: problems.length > 0 ? problems : undefined,
      }, { request, env });
    }

    const db = env.DB;
    // Header first, cookie as fallback — see readSessionToken for why
    const sessionToken = readSessionToken(request);

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
