// jev.mjs — TypeSafe's Jev (a System One model) wired the way every other provider in lib.mjs is:
// a client built from env, spend metered into the same LLM Spend accumulator, provider errors
// normalised to the api-reliability contract, and a presence / live check. Jev does not write
// text: it answers typed questions (choice / score / noul) over a `state` and returns calibrated
// probabilities, so code keeps the workflow and Jev supplies the judgment. Read docs/typesafe-jev.md
// first; the TypeSafe skill (`/typesafe:typesafe-ai`) and https://docs.typesafe.ai/llms.txt carry
// the current request contract — never invent request or response fields.
//
//   node jev.mjs --check          # presence only, offline: key set? model? host? — values never printed
//   node jev.mjs --check --live   # + GET /v1/models and a one-question probe (about $0.00001)
//
// Two routes, same SDK: TypeSafe direct (TYPESAFE_API_KEY), or OpenRouter's TypeSafe-compatible
// System One route when only OPENROUTER_API_KEY is set (https://openrouter.ai/docs/guides/community/typesafe-sdk).
// On OpenRouter the pinned id is `jev-1.13` (routed as typesafe/jev-1.13); `jev-1.13.0` does not exist there.
//
// Questions and thresholds are the part a human must be able to review, so each feature keeps its
// questions in ONE named export beside its caller (PROBE_QUESTIONS below is the pattern), never
// inline at the call site.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APIConnectionError, APIError, APITimeoutError, APIUserAbortError, TypeSafeClient, VERSION as SDK_VERSION,
  choice, noul, score,
} from '@typesafe-ai/sdk';
import { ApiError } from './api-reliability.mjs';
import { loadEnv, meterLlmCall, priceUsage } from './lib.mjs';

export { choice, noul, score, SDK_VERSION };

// The alias follows TypeSafe's current stable release (jev-1.13.0 today) and moves when a new one
// ships. Once confidence thresholds are tuned against a version, pin it via TYPESAFE_DEFAULT_MODEL
// and move on your own schedule; every answer reports the versioned id that produced it.
export const JEV_MODEL = 'jev-latest';
export const JEV_HOST = 'https://api.typesafe.ai';
export const JEV_OPENROUTER_HOST = 'https://openrouter.ai/api';

// Every value is trimmed: a key pasted with a trailing newline otherwise rides into the auth header
// and 401s every call — the same trap lib.mjs documents for MODEL_GENERATE (2026-07-12).
// With no TYPESAFE_API_KEY, OPENROUTER_API_KEY is used and the host defaults to OpenRouter's System
// One route, so the fleet's existing LLM key reaches Jev with no second secret.
export function jevConfig(env = {}) {
  const read = (key) => String(env[key] ?? '').trim();
  const viaOpenRouter = !read('TYPESAFE_API_KEY') && Boolean(read('OPENROUTER_API_KEY'));
  return {
    apiKey: read('TYPESAFE_API_KEY') || read('OPENROUTER_API_KEY'),
    defaultModel: read('TYPESAFE_DEFAULT_MODEL') || JEV_MODEL,
    baseURL: (read('TYPESAFE_BASE_URL') || (viaOpenRouter ? JEV_OPENROUTER_HOST : JEV_HOST)).replace(/\/+$/, ''),
  };
}

const isOpenRouter = (baseURL) => /^https:\/\/openrouter\.ai(\/|$)/.test(baseURL);

// Provider errors follow docs/api-reliability.md: a stable code, no response body in the message,
// the SDK error kept as `cause`. A request-shape rejection (400 / 422) keeps a short excerpt because
// that text describes OUR question and is what fixes it. Transport loss and timeouts are `unknown`
// (the request may have been billed), everything else is a known failure.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
export function normalizeJevError(error, operation = 'systemOne') {
  if (error instanceof ApiError) return error;
  const status = error instanceof APIError && Number.isInteger(error.status) ? error.status : null;
  const aborted = error instanceof APIUserAbortError;
  const timeout = error instanceof APITimeoutError;
  const lost = !aborted && !timeout && error instanceof APIConnectionError;
  const code = status != null ? `http_${status}` : aborted ? 'aborted' : timeout ? 'timeout' : lost ? 'transport_exhausted' : 'client_error';
  const retryable = timeout || lost || (status != null && RETRYABLE_STATUSES.has(status));
  const details = { provider: 'TypeSafe', operation, status, retryable, outcome: timeout || lost ? 'unknown' : 'known-failed', code };
  if (status === 400 || status === 422) details.safeExcerpt = String(error.message || '').slice(0, 240);
  const normalized = new ApiError(`TypeSafe ${operation} failed${status != null ? ` (${status})` : ''}: ${code}`, details);
  normalized.cause = error;
  return normalized;
}

// jev(env, transport) -> { client, model, ask }. `transport` is the SDK config escape hatch (fetch,
// retry, timeout) used by tests and never by callers; retries, Retry-After and per-attempt timeouts
// are the SDK's own defaults, which TypeSafe documents against its rate limits.
export function jev(env, transport = {}) {
  const config = jevConfig(env);
  if (!config.apiKey) throw new Error('.env is missing: TYPESAFE_API_KEY (or OPENROUTER_API_KEY)');
  const client = new TypeSafeClient({ ...config, ...transport });
  return {
    client,
    config,
    model: config.defaultModel,
    // One evaluation: `state` (string / object / array) plus a map of questions built with
    // choice() / score() / noul(). `role` tags the spend row the way anthropic() tags generate /
    // aux / retro, so a run's Jev cost is visible beside its LLM cost. Failures are never metered.
    async ask({ state, questions, model, role = 'jev' }, options) {
      let result;
      try { result = await client.systemOne({ state, questions, ...(model ? { model } : {}) }, options); }
      catch (error) { throw normalizeJevError(error); }
      // OpenRouter returns the billed cost in usage.cost; TypeSafe direct is priced from llm-prices.json.
      meterLlmCall({ model: result.model, role, usage: result.usage, exactCost: result.usage?.cost });
      return result;
    },
  };
}

// Presence mirrors credential-status.mjs: a set key is configured-unverified; only the authorised
// --live probe promotes it to auth-ok. Values are never returned or printed.
export function jevPresence(env = {}) {
  const config = jevConfig(env);
  return {
    TYPESAFE_API_KEY: config.apiKey ? 'configured-unverified' : 'missing',
    keySource: String(env.TYPESAFE_API_KEY ?? '').trim() ? 'TYPESAFE_API_KEY' : config.apiKey ? 'OPENROUTER_API_KEY' : null,
    model: config.defaultModel,
    modelSource: String(env.TYPESAFE_DEFAULT_MODEL ?? '').trim() ? 'TYPESAFE_DEFAULT_MODEL' : 'default',
    host: config.baseURL,
    hostSource: String(env.TYPESAFE_BASE_URL ?? '').trim() ? 'TYPESAFE_BASE_URL' : 'default',
    sdk: SDK_VERSION,
  };
}

// The live probe's one question, kept as a named export like every reviewable question set.
export const PROBE_STATE = 'Help! My payouts have been failing for 3 days.';
export const PROBE_QUESTIONS = {
  urgent: noul('Does this message convey urgency?', { true: 'Explicitly time-sensitive', false: 'No urgency expressed' }),
};

// OpenRouter's GET /api/v1/models is its own Models API ({ data: [{ id }] }), which the SDK's
// models.list() cannot parse, so on that host the listing is read directly. Decision models are
// hidden from the default text listing; output_modalities=decisions returns them (checked 2026-09-23).
async function listOpenRouterJevModels({ apiKey, baseURL }, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseURL}/v1/models?output_modalities=decisions`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new ApiError(`TypeSafe models.list failed (${res.status}): http_${res.status}`, {
      provider: 'TypeSafe', operation: 'models.list', status: res.status, retryable: RETRYABLE_STATUSES.has(res.status), outcome: 'known-failed', code: `http_${res.status}`,
    });
  }
  const body = await res.json();
  return (body?.data || []).map((m) => m.id).filter((id) => String(id).startsWith('typesafe/'));
}

export async function jevProbe(env, transport = {}) {
  const j = jev(env, transport);
  let models;
  try {
    if (isOpenRouter(j.config.baseURL)) models = await listOpenRouterJevModels(j.config, transport.fetch);
    else {
      const listed = await j.client.models.list();
      models = (Array.isArray(listed) ? listed : listed?.models || []).map((m) => m.name);
    }
  } catch (error) { throw normalizeJevError(error, 'models.list'); }
  const started = Date.now();
  const result = await j.ask({ state: PROBE_STATE, questions: PROBE_QUESTIONS, role: 'probe' });
  return {
    models,
    model: result.model,
    noul: result.answers.urgent.noul,
    ms: Date.now() - started,
    usage: result.usage,
    costUsd: Number.isFinite(result.usage?.cost) ? result.usage.cost : priceUsage(result.model, result.usage),
    costBasis: Number.isFinite(result.usage?.cost) ? 'exact' : 'est',
  };
}

export function renderPresence(presence) {
  return [
    'TypeSafe Jev',
    `  TYPESAFE_API_KEY: ${presence.TYPESAFE_API_KEY}${presence.keySource === 'OPENROUTER_API_KEY' ? ' (via OPENROUTER_API_KEY)' : ''}`,
    `  model: ${presence.model} (${presence.modelSource === 'default' ? 'default alias — set TYPESAFE_DEFAULT_MODEL to pin a version' : 'from TYPESAFE_DEFAULT_MODEL'})`,
    `  host: ${presence.host}${presence.hostSource === 'default' ? (presence.keySource === 'OPENROUTER_API_KEY' ? ' (OpenRouter System One route)' : '') : ' (from TYPESAFE_BASE_URL)'}`,
    `  sdk: @typesafe-ai/sdk ${presence.sdk}`,
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--check')) { console.error('usage: node jev.mjs --check [--live]'); process.exit(1); }
  const env = loadEnv();
  const presence = jevPresence(env);
  console.log(renderPresence(presence));
  if (process.argv.includes('--live')) {
    if (presence.TYPESAFE_API_KEY === 'missing') { console.error('  --live needs TYPESAFE_API_KEY or OPENROUTER_API_KEY — see docs/web-environment-setup.md'); process.exit(1); }
    try {
      const probe = await jevProbe(env);
      console.log(`  models: ${probe.models.join(', ') || '(none listed)'}`);
      console.log(`  probe: ${probe.model} answered noul=${probe.noul.toFixed(3)} in ${probe.ms}ms · ${probe.usage.input_tokens} tokens in · ${probe.costUsd == null ? 'unpriced (add jev to llm-prices.json)' : `${probe.costBasis} $${probe.costUsd.toFixed(6)}`}`);
      console.log('  TYPESAFE_API_KEY: auth-ok');
    } catch (error) {
      console.error(`  probe failed: ${error.message}`);
      process.exit(1);
    }
  }
}
