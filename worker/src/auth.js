// auth.js
// Password hashing and session handling for the Worker.
//
// Two changes from the Express version, both required by the platform:
//
//  1. bcryptjs is replaced with PBKDF2 via WebCrypto. bcryptjs is pure
//     JavaScript and slow enough to risk the Worker CPU limit; WebCrypto is
//     native. Consequence: existing bcrypt hashes cannot be verified, so
//     accounts must be created fresh.
//
//  2. Sessions are rows in D1 rather than a bare userId cookie. The old cookie
//     held the user id in plain text with httpOnly disabled, meaning anyone
//     could impersonate any user by editing it. Tokens are random and opaque,
//     and the cookie is HttpOnly so scripts cannot read it.

const PBKDF2_ITERATIONS = 100_000;
const SESSION_DAYS = 30;

const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

/** Hash a password. Format: pbkdf2$iterations$salt$hash (all base64). */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Verify a password against a stored hash, comparing in constant time. */
export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterStr, saltB64, hashB64] = stored.split('$');
  const iterations = Number(iterStr);
  if (!iterations || !saltB64 || !hashB64) return false;

  const salt = fromBase64(saltB64);
  const expected = fromBase64(hashB64);
  const actual = await pbkdf2(password, salt, iterations);

  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function newSessionToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createSession(db, userId) {
  const token = newSessionToken();
  const now = Date.now();
  const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db
    .prepare('INSERT INTO sessions (token, userId, created, expires) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now, expires)
    .run();
  return { token, expires };
}

export async function getSessionUser(db, token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
         JOIN users u ON s.userId = u.id
        WHERE s.token = ? AND s.expires > ?`
    )
    .bind(token, Date.now())
    .first();
  return row || null;
}

export async function deleteSession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Build the session cookie.
 *
 * SameSite=None is required because the frontend (Pages) and the API (Worker)
 * are on different domains, and browsers block cross-site cookies otherwise.
 * SameSite=None is only honoured alongside Secure, so this needs HTTPS — fine
 * on Cloudflare, but it means plain-HTTP local testing will not keep you
 * logged in unless you set SESSION_SAMESITE=Lax for development.
 */
export function sessionCookie(token, expires, env = {}) {
  const sameSite = env.SESSION_SAMESITE || 'None';
  const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  const parts = [
    `session=${token}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
  ];
  if (sameSite === 'None') parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(env = {}) {
  const sameSite = env.SESSION_SAMESITE || 'None';
  const parts = ['session=', 'Path=/', 'HttpOnly', 'Max-Age=0', `SameSite=${sameSite}`];
  if (sameSite === 'None') parts.push('Secure');
  return parts.join('; ');
}
