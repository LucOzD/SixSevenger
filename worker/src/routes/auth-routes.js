// auth-routes.js — signup, login, logout, current user, profile updates.

import {
  hashPassword, verifyPassword, createSession, deleteSession,
  sessionCookie, clearSessionCookie,
} from '../auth.js';
import { json, badRequest, unauthorized, readJson, uuid } from '../http.js';

const MAX_BIO_WORDS = 40;
const MIN_PASSWORD_LENGTH = 4;

// Avatars are a single emoji rather than an uploaded image, which avoids
// needing object storage. Some emoji are several codepoints joined with
// zero-width joiners, so the limit is generous rather than 1.
const MAX_AVATAR_LENGTH = 8;

function trimBio(bio) {
  if (!bio) return '';
  return String(bio).split(/\s+/).slice(0, MAX_BIO_WORDS).join(' ');
}

/**
 * Accept a short emoji, reject anything else. Returns null when absent or
 * invalid, in which case the frontend derives one from the username.
 * Characters meaningful in HTML are refused outright as defence in depth,
 * even though render sites escape.
 */
export function sanitiseAvatar(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (str.length === 0 || str.length > MAX_AVATAR_LENGTH) return null;
  if (/[<>&"'`\\/]/.test(str)) return null;
  // Must not be ordinary alphanumeric text
  if (/^[A-Za-z0-9 ._-]+$/.test(str)) return null;
  return str;
}

export async function handleSignup(ctx) {
  const { request, env, db } = ctx;
  const body = await readJson(request);
  const username = (body.username || '').trim();
  const password = body.password || '';

  if (!username) return badRequest('Username required', ctx);
  if (username.length > 32) return badRequest('Username too long', ctx);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, ctx);
  }

  const existing = await db
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (existing) return badRequest('Username already taken', ctx);

  const id = uuid();
  const passwordHash = await hashPassword(password);

  await db
    .prepare(
      `INSERT INTO users (id, username, passwordHash, bio, avatar, guest, created)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(id, username, passwordHash, trimBio(body.bio),
          sanitiseAvatar(body.avatar), Date.now())
    .run();

  const { token, expires } = await createSession(db, id);
  return json({ success: true, id, username }, {
    request, env,
    extraHeaders: { 'Set-Cookie': sessionCookie(token, expires, env) },
  });
}

export async function handleLogin(ctx) {
  const { request, env, db } = ctx;
  const body = await readJson(request);
  const username = (body.username || '').trim();
  const password = body.password || '';

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first();

  // Same message either way, so the response cannot be used to discover
  // which usernames exist.
  const invalid = () => badRequest('Invalid username or password', ctx);
  if (!user) return invalid();

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return invalid();

  const { token, expires } = await createSession(db, user.id);
  return json({ success: true, id: user.id, username: user.username }, {
    request, env,
    extraHeaders: { 'Set-Cookie': sessionCookie(token, expires, env) },
  });
}

export async function handleLogout(ctx) {
  const { request, env, db, sessionToken } = ctx;
  await deleteSession(db, sessionToken);
  return json({ success: true }, {
    request, env,
    extraHeaders: { 'Set-Cookie': clearSessionCookie(env) },
  });
}

export async function handleMe(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) {
    return json({ loggedIn: false, guest: true }, { request, env });
  }

  const [followers, following, unread, pending] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followingId = ?').bind(user.id).first(),
    db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followerId = ?').bind(user.id).first(),
    db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE userId = ? AND read = 0').bind(user.id).first(),
    db.prepare('SELECT COUNT(*) AS c FROM follow_requests WHERE toUserId = ?').bind(user.id).first(),
  ]);

  return json({
    loggedIn: true,
    guest: false,
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    bio: user.bio,
    isAdmin: user.username === 'admin',
    followers: followers?.c || 0,
    following: following?.c || 0,
    unreadNotifications: unread?.c || 0,
    incomingRequests: pending?.c || 0,
  }, { request, env });
}

export async function handleUpdateProfile(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const body = await readJson(request);
  const updates = [];
  const values = [];

  if (body.username) {
    const taken = await db
      .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .bind(body.username.trim(), user.id)
      .first();
    if (taken) return badRequest('Username already taken', ctx);
    updates.push('username = ?');
    values.push(body.username.trim());
  }

  if (body.bio !== undefined) {
    updates.push('bio = ?');
    values.push(trimBio(body.bio));
  }

  if (body.avatar !== undefined) {
    const avatar = sanitiseAvatar(body.avatar);
    if (body.avatar && !avatar) return badRequest('Avatar must be a single emoji', ctx);
    updates.push('avatar = ?');
    values.push(avatar);
  }

  if (body.password) {
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, ctx);
    }
    updates.push('passwordHash = ?');
    values.push(await hashPassword(body.password));
  }

  if (updates.length === 0) return json({ success: true }, { request, env });

  values.push(user.id);
  await db
    .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return json({ success: true }, { request, env });
}
