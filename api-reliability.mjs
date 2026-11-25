const DEFAULT_RETRYABLE = new Set([429, 500, 502, 503, 504]);

function safeRequestId(headers) {
  for (const name of ['x-request-id', 'x-airtable-request-id', 'request-id']) {
    const value = headers?.get?.(name);
    if (value && /^[A-Za-z0-9._:-]{1,160}$/.test(value)) return value;
  }
  return null;
}

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, {
      provider: details.provider || 'unknown',
      operation: details.operation || 'request',
      status: details.status ?? null,
      retryable: Boolean(details.retryable),
      outcome: details.outcome || 'known-failed',
      requestId: details.requestId || null,
      attempts: details.attempts || 1,
      code: details.code || 'api_error',
      safeExcerpt: details.safeExcerpt || null,
      partialCount: details.partialCount ?? null,
    });
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function apiError(provider, operation, details) {
  const status = details.status == null ? '' : ` (${details.status})`;
  return new ApiError(`${provider} ${operation} failed${status}: ${details.code}`, {
    provider, operation, ...details,
  });
}

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('body deadline')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

const TELEGRAM_CODES = [
  [/message thread not found/i, 'TOPIC_NOT_FOUND'],
  [/TOPIC_CLOSED/i, 'TOPIC_CLOSED'],
  [/TOPIC_DELETED/i, 'TOPIC_DELETED'],
  [/chat not found/i, 'CHAT_NOT_FOUND'],
  [/can't parse entities/i, 'PARSE_ENTITIES'],
  [/message is too long/i, 'MESSAGE_TOO_LONG'],
  [/bot was kicked|not a member|have no rights/i, 'BOT_NOT_ALLOWED'],
];
/** PURE. Map a Telegram Bot API error description to a fixed code (null when unknown). */
export function telegramCode(description) {
  for (const [re, code] of TELEGRAM_CODES) if (re.test(String(description || ''))) return code;
  return null;
}
const SAFE_PROVIDER_CODES = new Set(['UNKNOWN_FIELD_NAME', 'INVALID_REQUEST', 'INVALID_PERMISSIONS', 'NOT_FOUND', ...TELEGRAM_CODES.map(([, c]) => c)]);
async function safeHttpCode(response, timeoutMs) {
  try {
    const raw = (await bounded(response.text(), timeoutMs)).trim();
    let candidate = raw;
    try {
      const parsed = JSON.parse(raw);
      candidate = parsed?.error?.type || parsed?.error?.code || parsed?.code || '';
      // Telegram answers {"ok":false,"description":"Bad Request: message thread not found"}: the
      // description is fixed Bot API text, never a secret, and without it every rejected send read
      // as a bare "http_rejected" (the Morning Brief failed that way every day from 2026-11-08 on).
      if (!candidate && typeof parsed?.description === 'string') candidate = telegramCode(parsed.description) || '';
    } catch {}
    return SAFE_PROVIDER_CODES.has(candidate) ? candidate : null;
  } catch { return null; }
}

export async function requestWithPolicy({
  provider,
  operation,
  url,
  init = {},
  replayable = false,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  random = Math.random,
  attemptTimeoutMs = 15_000,
  overallTimeoutMs = 60_000,
  maxAttempts = 4,
  retryableStatuses = DEFAULT_RETRYABLE,
  beforeAttempt,
}) {
  const started = now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = overallTimeoutMs - (now() - started);
    if (remaining <= 0) throw apiError(provider, operation, {
      retryable: replayable, outcome: replayable ? 'known-failed' : 'unknown', attempts: attempt - 1,
      code: 'overall_deadline',
    });
    if (beforeAttempt) await beforeAttempt({ attempt, remainingMs: remaining });
    const afterScheduleRemaining = overallTimeoutMs - (now() - started);
    if (afterScheduleRemaining <= 0) throw apiError(provider, operation, {
      retryable: replayable, outcome: replayable ? 'known-failed' : 'unknown', attempts: attempt - 1,
      code: 'overall_deadline',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('attempt deadline')), Math.min(attemptTimeoutMs, afterScheduleRemaining));
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      clearTimeout(timer);
      if (!replayable) throw apiError(provider, operation, {
        retryable: false, outcome: 'unknown', attempts: attempt, code: 'transport_unknown',
      });
      if (attempt === maxAttempts) throw apiError(provider, operation, {
        retryable: true, outcome: 'known-failed', attempts: attempt, code: 'transport_exhausted',
      });
      const wait = Math.min(10_000, 250 * 2 ** (attempt - 1)) * (1 + random() * 0.2);
      if (wait >= overallTimeoutMs - (now() - started)) throw apiError(provider, operation, {
        retryable: true, outcome: 'known-failed', attempts: attempt, code: 'overall_deadline',
      });
      await sleepImpl(wait);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const responseRemaining = overallTimeoutMs - (now() - started);
      if (responseRemaining <= 0) throw apiError(provider, operation, {
        retryable: replayable, outcome: replayable ? 'known-failed' : 'unknown', attempts: attempt,
        code: 'overall_deadline', requestId: safeRequestId(response.headers),
      });
      return {
        response, attempts: attempt, requestId: safeRequestId(response.headers),
        bodyTimeoutMs: Math.min(attemptTimeoutMs, responseRemaining),
        decodeFailureOutcome: replayable ? 'known-failed' : 'unknown',
        abort: () => controller.abort(new Error('response body deadline')),
      };
    }

    const retryable = retryableStatuses.has(response.status) && (replayable || response.status === 429);
    const uncertain = !replayable && response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      const providerCode = await safeHttpCode(response, Math.min(attemptTimeoutMs, Math.max(1, overallTimeoutMs - (now() - started))));
      throw apiError(provider, operation, {
      status: response.status,
      retryable,
      outcome: uncertain ? 'unknown' : 'known-failed',
      requestId: safeRequestId(response.headers),
      attempts: attempt,
      code: providerCode || (uncertain ? 'http_outcome_unknown' : retryable ? 'retry_exhausted' : 'http_rejected'),
      safeExcerpt: providerCode,
      });
    }
    const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'), now());
    const wait = retryAfter ?? Math.min(10_000, 250 * 2 ** (attempt - 1)) * (1 + random() * 0.2);
    if (wait >= overallTimeoutMs - (now() - started)) throw apiError(provider, operation, {
      status: response.status, retryable: true, outcome: 'known-failed', requestId: safeRequestId(response.headers),
      attempts: attempt, code: 'overall_deadline',
    });
    try { await response.body?.cancel(); } catch {}
    await sleepImpl(wait);
  }
  throw apiError(provider, operation, { code: 'retry_exhausted' });
}

export async function jsonWithSchema(result, { provider, operation, validate }) {
  let value;
  try { value = await bounded(result.response.json(), result.bodyTimeoutMs || 15_000); }
  catch {
    result.abort?.();
    throw apiError(provider, operation, { code: 'invalid_json', outcome: result.decodeFailureOutcome, requestId: result.requestId, attempts: result.attempts });
  }
  if (validate && !validate(value)) throw apiError(provider, operation, {
    code: 'schema_mismatch', outcome: result.decodeFailureOutcome, requestId: result.requestId, attempts: result.attempts,
  });
  return value;
}

export async function collectCursorPages({ provider, operation, firstCursor = null, maxPages = 100, fetchPage }) {
  const items = [];
  const seen = new Set();
  let cursor = firstCursor;
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(cursor, page);
    if (!result || !Array.isArray(result.items)) throw apiError(provider, operation, {
      code: 'schema_mismatch', partialCount: items.length,
    });
    items.push(...result.items);
    const next = result.nextCursor || null;
    if (!next) return items;
    if (seen.has(next) || next === cursor) throw apiError(provider, operation, {
      code: 'pagination_cycle', partialCount: items.length,
    });
    seen.add(next);
    cursor = next;
  }
  throw apiError(provider, operation, { code: 'pagination_cap', partialCount: items.length });
}
