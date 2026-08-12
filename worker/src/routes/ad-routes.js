// ad-routes.js — admin ad management, personalized selection and tracking.

import { badRequest, json, notFound, unauthorized, readJson, uuid } from '../http.js';
import { loadAnalyser } from '../storage.js';
import { requireAdmin } from './misc-routes.js';
import {
  DEFAULT_AD_FREQUENCY_CAP, DEFAULT_AD_FREQUENCY_WINDOW_MS,
  DEFAULT_AD_MIN_INTERVAL_MS, DEFAULT_AD_MIN_SIMILARITY,
  buildAdVector, isSafeAdImagePath, isSafeAdUrl,
  normaliseAdKeywords, rankAdsForUser,
} from '../ads.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function optionalTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : NaN;
}

function boundedNumber(value, fallback, min, max) {
  const number = value === '' || value === null || value === undefined
    ? fallback
    : Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : NaN;
}

function validateAd(body) {
  const title = String(body.title || '').trim();
  const adBody = String(body.body || '').trim();
  const emoji = String(body.emoji || '').trim();
  const imagePath = String(body.image_path || '').trim();
  const ctaUrl = String(body.cta_url || '').trim();
  const ctaLabel = String(body.cta_label || '').trim();
  const keywords = normaliseAdKeywords(body.keywords);
  const startsAt = optionalTime(body.starts_at);
  const endsAt = optionalTime(body.ends_at);
  const minSimilarity = boundedNumber(
    body.min_similarity, DEFAULT_AD_MIN_SIMILARITY, 0, 1
  );
  const frequencyCap = boundedNumber(
    body.frequency_cap, DEFAULT_AD_FREQUENCY_CAP, 1, 20
  );
  const frequencyWindowMs = boundedNumber(
    body.frequency_window_ms, DEFAULT_AD_FREQUENCY_WINDOW_MS, 60_000, 30 * DAY_MS
  );
  const minIntervalMs = boundedNumber(
    body.min_interval_ms, DEFAULT_AD_MIN_INTERVAL_MS, 0, 30 * DAY_MS
  );

  if (!title || title.length > 80) return { error: 'Title must be 1–80 characters.' };
  if (!adBody || adBody.length > 240) return { error: 'Body must be 1–240 characters.' };
  if (emoji.length > 8) return { error: 'Emoji is too long.' };
  if (!isSafeAdImagePath(imagePath)) {
    return { error: 'Image must be a same-site path under /ad-assets/.' };
  }
  if (!isSafeAdUrl(ctaUrl) || ctaUrl.length > 500) {
    return { error: 'CTA URL must be a valid HTTPS URL.' };
  }
  if (!ctaLabel || ctaLabel.length > 30) return { error: 'CTA label must be 1–30 characters.' };
  if (keywords.length === 0) return { error: 'Add at least one keyword.' };
  if ([startsAt, endsAt, minSimilarity, frequencyCap, frequencyWindowMs, minIntervalMs]
    .some(Number.isNaN)) return { error: 'One or more numeric settings are invalid.' };
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    return { error: 'End time must be later than start time.' };
  }

  return {
    value: {
      title, body: adBody, emoji: emoji || null, image_path: imagePath || null,
      cta_url: ctaUrl, cta_label: ctaLabel, keywords,
      active: body.active === true || body.active === 1,
      starts_at: startsAt, ends_at: endsAt, min_similarity: minSimilarity,
      frequency_cap: Math.trunc(frequencyCap),
      frequency_window_ms: Math.trunc(frequencyWindowMs),
      min_interval_ms: Math.trunc(minIntervalMs),
    },
  };
}

function publicAd(row, deliveryId) {
  return {
    kind: 'ad', id: row.id, deliveryId,
    title: row.title, body: row.body, emoji: row.emoji,
    image_path: row.image_path, cta_url: row.cta_url, cta_label: row.cta_label,
  };
}

export async function handleAdminAds(ctx) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const { request, env, db } = ctx;
  const rows = await db.prepare(
    `SELECT a.id, a.title, a.body, a.emoji, a.image_path, a.cta_url, a.cta_label,
            a.keywords, a.active, a.starts_at, a.ends_at, a.min_similarity,
            a.frequency_cap, a.frequency_window_ms, a.min_interval_ms,
            a.created_at, a.updated_at,
            COUNT(d.id) AS deliveries,
            SUM(CASE WHEN d.impression_at IS NOT NULL THEN 1 ELSE 0 END) AS impressions,
            SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks
       FROM ads a LEFT JOIN ad_deliveries d ON d.ad_id = a.id
      GROUP BY a.id ORDER BY a.updated_at DESC`
  ).all();
  return json((rows.results || []).map((row) => ({
    ...row,
    keywords: (() => { try { return JSON.parse(row.keywords); } catch { return []; } })(),
    active: Boolean(row.active),
  })), { request, env });
}

export async function handleAdminSaveAd(ctx, params = {}) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const { request, env, db, user } = ctx;
  const validated = validateAd(await readJson(request));
  if (validated.error) return badRequest(validated.error, ctx);

  const value = validated.value;
  const now = Date.now();
  const analyser = await loadAnalyser(db);
  const adVector = buildAdVector(value.keywords, analyser.phrases);
  if (Object.keys(adVector).length === 0) return badRequest('Keywords produced an empty vector.', ctx);

  if (params.id) {
    const existing = await db.prepare('SELECT id FROM ads WHERE id = ?').bind(params.id).first();
    if (!existing) return notFound('Ad not found', ctx);
    await db.prepare(
      `UPDATE ads SET title = ?, body = ?, emoji = ?, image_path = ?, cta_url = ?,
              cta_label = ?, keywords = ?, ad_vector = ?, active = ?, starts_at = ?,
              ends_at = ?, min_similarity = ?, frequency_cap = ?,
              frequency_window_ms = ?, min_interval_ms = ?, updated_at = ?
        WHERE id = ?`
    ).bind(
      value.title, value.body, value.emoji, value.image_path, value.cta_url,
      value.cta_label, JSON.stringify(value.keywords), JSON.stringify(adVector),
      value.active ? 1 : 0, value.starts_at, value.ends_at, value.min_similarity,
      value.frequency_cap, value.frequency_window_ms, value.min_interval_ms,
      now, params.id
    ).run();
    return json({ success: true, id: params.id }, { request, env });
  }

  const id = uuid();
  await db.prepare(
    `INSERT INTO ads (
       id, title, body, emoji, image_path, cta_url, cta_label, keywords, ad_vector,
       active, starts_at, ends_at, min_similarity, frequency_cap,
       frequency_window_ms, min_interval_ms, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, value.title, value.body, value.emoji, value.image_path, value.cta_url,
    value.cta_label, JSON.stringify(value.keywords), JSON.stringify(adVector),
    value.active ? 1 : 0, value.starts_at, value.ends_at, value.min_similarity,
    value.frequency_cap, value.frequency_window_ms, value.min_interval_ms,
    user.id, now, now
  ).run();
  return json({ success: true, id }, { request, env });
}

export async function selectPersonalizedAd(db, userId, interests, topology, now = Date.now()) {
  const actorId = userId || '';

  // Scheduling is hard, but similarity and frequency controls are preferences:
  // if every campaign is below threshold or capped, the most relevant active
  // ad still fills the fixed feed cadence instead of leaving a blank slot.
  const rows = await db.prepare(
    `SELECT a.*,
            (SELECT COUNT(*) FROM ad_deliveries d
              WHERE d.ad_id = a.id AND d.user_id = ?
                AND d.impression_at > ? - a.frequency_window_ms) AS recent_impressions,
            COALESCE((SELECT MAX(d.impression_at) FROM ad_deliveries d
                       WHERE d.ad_id = a.id AND d.user_id = ?), 0) AS last_impression
       FROM ads a
      WHERE a.active = 1
        AND (a.starts_at IS NULL OR a.starts_at <= ?)
        AND (a.ends_at IS NULL OR a.ends_at > ?)
      ORDER BY a.updated_at DESC LIMIT 500`
  ).bind(actorId, now, actorId, now, now).all();

  const ranked = rankAdsForUser(rows.results || [], interests, topology);
  const withinFrequencyControls = ranked.filter((ad) =>
    Number(ad.recent_impressions || 0) < Number(ad.frequency_cap) &&
    Number(ad.last_impression || 0) <= now - Number(ad.min_interval_ms || 0)
  );
  const ad = withinFrequencyControls[0] || ranked[0];
  if (!ad) return null;

  // Guests receive the same cadence with a non-personalized fallback, but no
  // persistent tracking identity is created for them.
  if (!userId) return publicAd(ad, null);

  const deliveryId = uuid();
  await db.prepare(
    'INSERT INTO ad_deliveries (id, ad_id, user_id, selected_at) VALUES (?, ?, ?, ?)'
  ).bind(deliveryId, ad.id, userId, now).run();
  return publicAd(ad, deliveryId);
}

async function deliveryForUser(ctx, params) {
  const { db, user } = ctx;
  if (!user) return null;
  const body = await readJson(ctx.request);
  const deliveryId = String(body.deliveryId || '');
  if (!deliveryId) return null;
  return db.prepare(
    'SELECT id FROM ad_deliveries WHERE id = ? AND ad_id = ? AND user_id = ?'
  ).bind(deliveryId, params.id, user.id).first();
}

export async function handleAdImpression(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);
  const delivery = await deliveryForUser(ctx, params);
  if (!delivery) return notFound('Ad delivery not found', ctx);
  await db.prepare(
    'UPDATE ad_deliveries SET impression_at = COALESCE(impression_at, ?) WHERE id = ?'
  ).bind(Date.now(), delivery.id).run();
  return json({ success: true }, { request, env });
}

export async function handleAdClick(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);
  const delivery = await deliveryForUser(ctx, params);
  if (!delivery) return notFound('Ad delivery not found', ctx);
  await db.prepare(
    'UPDATE ad_deliveries SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?'
  ).bind(Date.now(), delivery.id).run();
  return json({ success: true }, { request, env });
}