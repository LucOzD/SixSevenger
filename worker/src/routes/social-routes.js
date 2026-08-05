// social-routes.js — public profiles, follow requests and notifications.

import { json, badRequest, unauthorized, forbidden, notFound, uuid } from '../http.js';

export async function handleUserProfile(ctx, params) {
  const { request, env, db, user } = ctx;

  const target = await db
    .prepare('SELECT id, username, bio, profilePic FROM users WHERE id = ?')
    .bind(params.id)
    .first();
  if (!target) return notFound('User not found', ctx);

  const [posts, followers, following] = await Promise.all([
    db
      .prepare('SELECT * FROM posts WHERE userId = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 100')
      .bind(params.id)
      .all(),
    db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followingId = ?').bind(params.id).first(),
    db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followerId = ?').bind(params.id).first(),
  ]);

  let requestPending = false;
  let incomingRequestId = null;
  let isFollowing = false;

  if (user && user.id !== params.id) {
    const [outgoing, incoming, follow] = await Promise.all([
      db
        .prepare('SELECT id FROM follow_requests WHERE fromUserId = ? AND toUserId = ?')
        .bind(user.id, params.id)
        .first(),
      db
        .prepare('SELECT id FROM follow_requests WHERE fromUserId = ? AND toUserId = ?')
        .bind(params.id, user.id)
        .first(),
      db
        .prepare('SELECT id FROM follows WHERE followerId = ? AND followingId = ?')
        .bind(user.id, params.id)
        .first(),
    ]);
    requestPending = !!outgoing;
    incomingRequestId = incoming?.id || null;
    isFollowing = !!follow;
  }

  return json({
    user: target,
    posts: posts.results || [],
    followers: followers?.c || 0,
    following: following?.c || 0,
    requestPending,
    incomingRequestId,
    isFollowing,
  }, { request, env });
}

export async function handleRequestFollow(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);
  if (params.id === user.id) return badRequest('Cannot follow yourself', ctx);

  const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(params.id).first();
  if (!target) return notFound('User not found', ctx);

  const existingFollow = await db
    .prepare('SELECT id FROM follows WHERE followerId = ? AND followingId = ?')
    .bind(user.id, params.id)
    .first();
  if (existingFollow) return badRequest('Already following', ctx);

  const existingRequest = await db
    .prepare('SELECT id FROM follow_requests WHERE fromUserId = ? AND toUserId = ?')
    .bind(user.id, params.id)
    .first();
  if (existingRequest) return badRequest('Request already pending', ctx);

  await db.batch([
    db
      .prepare('INSERT INTO follow_requests (id, fromUserId, toUserId, created) VALUES (?, ?, ?, ?)')
      .bind(uuid(), user.id, params.id, Date.now()),
    db
      .prepare(
        `INSERT INTO notifications (id, userId, type, payload, read, created)
         VALUES (?, ?, 'follow_request', ?, 0, ?)`
      )
      .bind(uuid(), params.id, JSON.stringify({
        fromUserId: user.id,
        message: `${user.username || 'Someone'} wants to follow you.`,
      }), Date.now()),
  ]);

  return json({ success: true }, { request, env });
}

export async function handleFollowRequests(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const rows = await db
    .prepare(
      `SELECT fr.id, fr.fromUserId, fr.created, u.username, u.profilePic
         FROM follow_requests fr JOIN users u ON fr.fromUserId = u.id
        WHERE fr.toUserId = ? ORDER BY fr.created DESC`
    )
    .bind(user.id)
    .all();
  return json(rows.results || [], { request, env });
}

export async function handleAcceptFollow(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const req = await db
    .prepare('SELECT * FROM follow_requests WHERE id = ?')
    .bind(params.id)
    .first();
  if (!req) return notFound('Request not found', ctx);
  if (req.toUserId !== user.id) return forbidden(null, ctx);

  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO follows (id, followerId, followingId, created) VALUES (?, ?, ?, ?)')
      .bind(uuid(), req.fromUserId, user.id, Date.now()),
    db.prepare('DELETE FROM follow_requests WHERE id = ?').bind(params.id),
    db
      .prepare(
        `INSERT INTO notifications (id, userId, type, payload, read, created)
         VALUES (?, ?, 'follow_accept', ?, 0, ?)`
      )
      .bind(uuid(), req.fromUserId, JSON.stringify({
        fromUserId: user.id,
        message: `${user.username || 'Someone'} accepted your follow request.`,
      }), Date.now()),
  ]);

  return json({ success: true }, { request, env });
}

export async function handleUnfollow(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  await db
    .prepare('DELETE FROM follows WHERE followerId = ? AND followingId = ?')
    .bind(user.id, params.id)
    .run();
  return json({ success: true }, { request, env });
}

export async function handleMyFollowers(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const rows = await db
    .prepare(
      `SELECT u.id, u.username, u.profilePic
         FROM follows f JOIN users u ON f.followerId = u.id
        WHERE f.followingId = ? ORDER BY u.username`
    )
    .bind(user.id)
    .all();
  return json(rows.results || [], { request, env });
}

export async function handleMyFollowing(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const rows = await db
    .prepare(
      `SELECT u.id, u.username, u.profilePic
         FROM follows f JOIN users u ON f.followingId = u.id
        WHERE f.followerId = ? ORDER BY u.username`
    )
    .bind(user.id)
    .all();
  return json(rows.results || [], { request, env });
}

export async function handleNotifications(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const [rows, unread] = await Promise.all([
    db
      .prepare('SELECT * FROM notifications WHERE userId = ? AND read = 0 ORDER BY created DESC LIMIT 20')
      .bind(user.id)
      .all(),
    db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE userId = ? AND read = 0')
      .bind(user.id)
      .first(),
  ]);

  return json({
    notifications: rows.results || [],
    unread: unread?.c || 0,
  }, { request, env });
}

export async function handleMarkNotificationsRead(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);
  await db.prepare('UPDATE notifications SET read = 1 WHERE userId = ?').bind(user.id).run();
  return json({ success: true }, { request, env });
}

export async function handleDismissNotification(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);
  await db
    .prepare('UPDATE notifications SET read = 1 WHERE id = ? AND userId = ?')
    .bind(params.id, user.id)
    .run();
  return json({ success: true }, { request, env });
}
