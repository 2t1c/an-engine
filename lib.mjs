// Shared helpers for Project Infinity: env loader + thin API clients.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TABLES, CONFIG_RECORD, TELEGRAM_ROUTES, COMMAND_CENTER_CHAT_ID, COMMAND_CENTER_TOPICS, FOLDED_TABLES } from './config.mjs';
import { expandFolded, parseVirtualId, withFoldFields } from './thread-fold.mjs';
import { ApiError, collectCursorPages, jsonWithSchema, requestWithPolicy } from './api-reliability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HERE_DIR = HERE;

/** One definition. It was declared identically inside airtable(), typefully() and anthropic(). */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------- Ops Log (the anti-silence bus) ----------------
// One append-only Airtable stream of what every job did — run summaries, actions taken, failures.
// The dashboard derives per-job HEARTBEATS from it, so a job that stops logging surfaces as loudly
// as one that fails. That inverts the usual failure model: a disabled cron, an expired secret whose
// guard step "skips" green, a toggled-off n8n workflow — none of them ever FAIL, they just stop
// appearing, and until now nothing was pointed at absence.

export const OPS_LOG_TABLE = 'Ops Log'; // REGISTRY_BASE_ID, by name like REGISTRY_TABLE

/** Compose one Ops Log row. Pure and exported so tests can pin the shape without a network. */
export function buildOpsRow(source, level, event, detail) {
  return {
    fields: {
      Event: String(event ?? '').slice(0, 240),
      At: new Date().toISOString(),
      Source: String(source ?? 'unknown').slice(0, 60),
      Level: ['info', 'action', 'warn', 'error'].includes(level) ? level : 'info',
      Detail: detail == null ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 4000),
    },
  };
}

/**
 * Append to the Ops Log. NEVER throws and never blocks the caller's outcome: a job must not fail
 * because its diary was unreachable. Callers that end with process.exit() should await it (an
 * explicit exit tears down in-flight fetches); plain script-end drains the event loop and the
 * fire-and-forget write completes on its own.
 */
export async function opsLog(env, { source, level = 'info', event, detail } = {}) {
  try {
    const e = env || loadEnv();
    if (!e.AIRTABLE_PAT || !e.REGISTRY_BASE_ID) return false;
    await airtable(e, e.REGISTRY_BASE_ID).create(OPS_LOG_TABLE, [buildOpsRow(source, level, event, detail)]);
    return true;
  } catch { return false; }
}

// Write a structured run-metrics log (the retro loop's raw material) to logs/<pipeline>-<date>.json,
// and mirror a one-line summary to the Ops Log so the run is visible off-repo. The mirror is
// fire-and-forget by default (returned promise is awaitable for callers that process.exit).
export function logRun(pipeline, metrics) {
  // Any LLM calls this process made ride along: into the metrics file (retro's raw material) and,
  // via the flush, into the LLM Spend table — per-pipeline cost visibility with no caller changes.
  // runSeconds = process uptime at log time ≈ the task's own duration (excludes runner checkout/npm
  // overhead, which is workflow plumbing, not the task) — the Ops page shows it next to the cost.
  const spend = llmSpendSummary();
  // runSeconds FIRST (2026-08-30). It was appended last, which put it at the very end of the file —
  // and retro-core.mjs reads these logs as JSON.stringify(...).slice(0, 3000), so on any log past
  // that size the one field describing how long the run took never reached the reader. Cheap to
  // move, and it costs the tail nothing: nothing indexes these objects by position.
  const withLlm = { runSeconds: Math.round(process.uptime()), ...(spend.calls ? { ...metrics, llm: spend } : metrics) };
  const dir = join(HERE, 'logs'); mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, `${pipeline}-${day}.json`), JSON.stringify({ pipeline, ranAt: new Date().toISOString(), ...withLlm }, null, 1));
  // Event line: the few numbers that say how the run went, not the whole metrics dump.
  // Nested objects have to be JSON'd, not String()'d: `${{a:1}}` is "[object Object]", which is how
  // funnel-watch spent its life logging `epc=[object Object]` — the one number that line existed to
  // carry. Objects get a wider budget than scalars because a useful one ({fire,winEpc,baseEpc}) does
  // not fit in 24 chars.
  const bits = Object.entries(metrics || {}).slice(0, 6).map(([k, v]) => {
    if (typeof v === 'number') return `${k}=${v}`;
    if (v && typeof v === 'object') { try { return `${k}=${JSON.stringify(v).slice(0, 96)}`; } catch { return `${k}=?`; } }
    return `${k}=${String(v).slice(0, 24)}`;
  });
  return Promise.all([
    opsLog(null, { source: pipeline, level: 'info', event: `run: ${bits.join(' · ') || 'done'}`, detail: withLlm }),
    spend.calls ? flushLlmSpend(null, pipeline) : Promise.resolve(false),
  ]).then(([ops]) => ops);
}

export function loadEnv() {
  let raw = '';
  try { raw = readFileSync(join(HERE, '.env'), 'utf8'); } catch {}
  const env = { ...process.env };
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
// The keys llmEndpoint() will actually accept, in its own precedence order. Every entry point that
// needs a model requires THIS rather than one key by name.
export const LLM_KEYS = ['LLM_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];

// An entry is either a STRING (that key must be set) or an ARRAY (any ONE of them will do).
//
// The any-of form exists because every generation entry point used to demand ANTHROPIC_API_KEY by
// name while llmEndpoint() has long accepted three different keys. In an environment holding only
// OPENROUTER_API_KEY the model layer worked perfectly and the preflight refused to start anyway —
// and because the error read ".env is missing: ANTHROPIC_API_KEY", the refusal was mistaken for
// "no model access here" and written down as an environment limit rather than a wrong key name.
// It blocked the whole engine lane in this sandbox for weeks (found 2026-08-30 by calling llm()
// directly, which answered on the first try for $0.0001).
export function requireEnv(env, keys) {
  const missing = keys.filter((k) => (Array.isArray(k) ? !k.some((x) => env[x]) : !env[k]));
  if (missing.length) throw new Error(`.env is missing: ${missing.map((k) => (Array.isArray(k) ? k.join(' or ') : k)).join(', ')}`);
}

// ---------------- Airtable ----------------
// Airtable enforces ~5 req/s PER BASE with a ~30s all-requests-fail penalty after a 429. Parallel
// batch children (run-weekly --all: several recreate/media processes, each doing serial getRecord
// loops over source tweets) WILL brush that cap — so every read retries 429/5xx with backoff sized
// to outlast the penalty window (mirrors anthropic()) instead of dying and burning the slot.
// BASE IS A PARAMETER (2026-08-30). This was hardcoded to XDB_BASE_ID and read-only, which is the
// whole reason 33 modules hand-rolled their own `fetch` against api.airtable.com: anything touching
// REGISTRY_BASE_ID, and EVERY write in the repo, simply could not reach this client — and so could
// not reach its retry either. registry-sync.mjs paid for that with four `if (!r.ok) break` paginated
// reads (a transient 429 read as "no more pages", silently truncating the scan) and an unguarded
// upsert. Defaulted so all 24 existing callers keep byte-identical behaviour.
const AIRTABLE_NEXT_REQUEST = new Map();
export function airtable(env, base = env.XDB_BASE_ID, transport = {}) {
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const now = transport.now || Date.now;
  const wait = transport.sleepImpl || sleep;
  async function schedule() {
    const current = now();
    const allowedAt = Math.max(current, AIRTABLE_NEXT_REQUEST.get(base) || current);
    AIRTABLE_NEXT_REQUEST.set(base, allowedAt + 210);
    if (allowedAt > current) await wait(allowedAt - current);
  }
  async function atFetch(url, what, init, { idempotentWrite = false } = {}) {
    // THREE CLASSES, NOT TWO.
    //
    // A GET may be replayed freely.
    //
    // A PATCH that sets named fields on named records — update() and upsert() below — is idempotent
    // BY CONSTRUCTION: applying it twice lands the same table state as applying it once. So it may
    // be replayed on a 5xx or a dropped connection like a read. This matters: the fleet's only
    // hand-rolled write retry (scrape-freeze) retried every failure precisely because its PATCHes
    // are safe to repeat, and folding it into a 429-only client would have LOST that coverage.
    //
    // A POST that CREATES rows may not. The request may have landed, and a replay writes a second
    // row — in vendor-snapshot's case, a duplicate entry in the history table that exists to be a
    // trustworthy record. Only an explicit 429 is retried there, because Airtable rejects a 429
    // outright and nothing can have landed.
    const isRead = !init || !init.method || init.method === 'GET';
    const replayable = isRead || idempotentWrite;
    const result = await requestWithPolicy({
      provider: 'Airtable', operation: what, url,
      init: { ...init, headers: { ...h, ...(init?.headers || {}) } },
      replayable,
      fetchImpl: transport.fetchImpl,
      sleepImpl: wait,
      now,
      random: transport.random,
      attemptTimeoutMs: transport.attemptTimeoutMs || 15_000,
      overallTimeoutMs: transport.overallTimeoutMs || 120_000,
      maxAttempts: 7,
      retryableStatuses: RETRYABLE,
      beforeAttempt: schedule,
    });
    return result;
  }
  // ONE ROW PER THREAD (2026-10-20, thread-fold.mjs). In the folded tables a head's body tweets live in
  // its {Body JSON}; every read here expands them back, so a head's {Tweets} lists virtual ids and
  // getRecord serves those ids from this cache (or by re-reading the head). Writes never see them.
  const folded = new Map();
  // transport.fold === false reads the rows as they are (swipe-fold.mjs, which does the folding).
  const isFolded = (table) => transport.fold !== false && FOLDED_TABLES.includes(table);
  const foldFields = (table, fields) => (isFolded(table) ? withFoldFields(fields) : fields);
  function expand(table, records) {
    if (!isFolded(table) || !Array.isArray(records)) return records;
    return records.map((r) => {
      const { head, virtuals } = expandFolded(r);
      for (const v of virtuals) folded.set(v.id, v);
      return head;
    });
  }
  const real = (ids) => {
    const out = ids.filter((id) => !parseVirtualId(id));
    if (out.length < ids.length) console.warn(`airtable: skipped ${ids.length - out.length} folded body tweet id(s): a folded tweet has no row to write`);
    return out;
  };
  const client = {
    async getRecord(table, id) {
      const v = isFolded(table) && parseVirtualId(id);
      if (v) {
        if (!folded.has(id)) await client.getRecord(table, v.headId);
        const rec = folded.get(id);
        if (!rec) throw new ApiError(`Airtable get ${id} failed: folded tweet not found`, { provider: 'Airtable', operation: `get ${id}`, code: 'not_found' });
        return rec;
      }
      const rec = await jsonWithSchema(await atFetch(`https://api.airtable.com/v0/${base}/${table}/${id}`, `get ${id}`), {
        provider: 'Airtable', operation: `get ${id}`, validate: (value) => value && typeof value === 'object',
      });
      return expand(table, [rec])[0];
    },
    /** The cached folded body tweet for a virtual id (after a read expanded its head), else null. */
    foldedRecord(id) {
      return folded.get(id) || null;
    },
    // PAGINATES ONLY WHEN ASKED (2026-08-28). This returned ONE page and nothing else, so every
    // caller was silently capped at Airtable's 100-record page maximum. The planner's donor query
    // asked for a 21-day window and got 100 rows; widening it to 30 days returned 100 rows again,
    // which is how the cap was finally noticed — a wider net catching the same number of fish.
    //
    // `max` defaults to `pageSize`, so every existing caller keeps its exact current behaviour and
    // the ones that pass pageSize:1 to mean "one record" still get one. A caller that wants the
    // whole table opts in by passing a larger max.
    async listUpTo(table, { formula, sort, fields, pageSize = 50, max = pageSize } = {}) {
      fields = foldFields(table, fields);
      const out = [];
      let offset;
      const seen = new Set();
      do {
        const remaining = max - out.length;
        if (remaining <= 0) break;
        const p = new URLSearchParams();
        if (formula) p.set('filterByFormula', formula);
        if (sort) sort.forEach((s, i) => { p.append(`sort[${i}][field]`, s.field); p.append(`sort[${i}][direction]`, s.direction || 'desc'); });
        if (fields) fields.forEach((f) => p.append('fields[]', f));
        p.set('pageSize', String(Math.min(100, pageSize, remaining)));
        if (offset) p.set('offset', offset);
        const result = await atFetch(`https://api.airtable.com/v0/${base}/${table}?${p}`, 'list');
        const j = await jsonWithSchema(result, { provider: 'Airtable', operation: 'list', validate: (value) => value && typeof value === 'object' });
        if (!Array.isArray(j.records)) throw new ApiError('Airtable list failed: schema_mismatch', { provider: 'Airtable', operation: 'list', code: 'schema_mismatch', partialCount: out.length });
        out.push(...j.records);
        const next = j.offset || null;
        if (next && (next === offset || seen.has(next))) throw new ApiError('Airtable list failed: pagination_cycle', { provider: 'Airtable', operation: 'list', code: 'pagination_cycle', partialCount: out.length });
        if (next) seen.add(next);
        offset = next;
      } while (offset && out.length < max);
      return { records: expand(table, out.slice(0, max)), complete: !offset && out.length <= max, nextCursor: offset || null };
    },
    // Backward-compatible bounded read. New code should call listUpTo so the cap is observable.
    async list(table, options = {}) {
      return (await this.listUpTo(table, options)).records;
    },
    // ALWAYS paginates to exhaustion, ALWAYS throws. The counterpart to `list`'s opt-in cap above:
    // when a caller needs the WHOLE table, a short read is not a smaller table, it is a lie, and the
    // caller cannot tell the difference. Use this for any scan whose completeness the run depends on.
    async listAll(table, { formula, fields, pageSize = 100, maxPages = 1000 } = {}) {
      fields = foldFields(table, fields);
      return expand(table, await collectCursorPages({ provider: 'Airtable', operation: `listAll ${table}`, maxPages, fetchPage: async (offset) => {
        const p = new URLSearchParams();
        if (formula) p.set('filterByFormula', formula);
        if (fields) fields.forEach((f) => p.append('fields[]', f));
        p.set('pageSize', String(Math.min(100, pageSize)));
        if (offset) p.set('offset', offset);
        const result = await atFetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?${p}`, `listAll ${table}`);
        const j = await jsonWithSchema(result, { provider: 'Airtable', operation: `listAll ${table}`, validate: (value) => value && typeof value === 'object' });
        if (!Array.isArray(j.records)) return null;
        return { items: j.records, nextCursor: j.offset || null };
      } }));
    },
    // Batched PATCH of existing records BY RECORD ID (no merge key, no creation). Same batching and
    // same write-retry rules as upsert below. `typecast` defaults to true (every existing caller);
    // pass false where an unknown select value must FAIL instead of silently minting a new option
    // (swipe-reclassify's Niche writes).
    async update(table, records, { typecast = true } = {}) {
      if (isFolded(table)) { const keep = new Set(real(records.map((r) => r.id))); records = records.filter((r) => keep.has(r.id)); }
      const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
      for (let i = 0; i < records.length; i += 10) {
        await atFetch(url, `update ${table} batch ${i / 10}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ typecast: Boolean(typecast), records: records.slice(i, i + 10) }),
        }, { idempotentWrite: true });
      }
      return records.length;
    },
    // Batched DELETE, 10 ids per call. Idempotent by nature — a replayed DELETE of an already-gone
    // record is a 404 the retry path treats as done, and re-deleting cannot destroy anything twice.
    // There is no undo in Airtable, so every caller of this must be dry by default.
    async remove(table, ids) {
      if (isFolded(table)) ids = real(ids);
      for (let i = 0; i < ids.length; i += 10) {
        const p = new URLSearchParams();
        ids.slice(i, i + 10).forEach((id) => p.append('records[]', id));
        const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?${p}`;
        await atFetch(url, `delete ${table} batch ${i / 10}`, { method: 'DELETE' }, { idempotentWrite: true });
      }
      return ids.length;
    },
    // Batched CREATE. Deliberately NOT marked idempotent: a replayed POST writes a second row.
    async create(table, records, { typecast = false } = {}) {
      const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
      for (let i = 0; i < records.length; i += 10) {
        await atFetch(url, `create ${table} batch ${i / 10}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(typecast ? { typecast: true } : {}), records: records.slice(i, i + 10) }),
        });
      }
      return records.length;
    },
    // Batched upsert on a merge key — the first WRITE path this client has ever had. Airtable caps a
    // PATCH at 10 records, so a failure is per-batch: the index is reported because a torn write
    // (batches 0..n applied, the rest not) is a legible state to recover from and an anonymous stack
    // trace is not.
    async upsert(table, mergeOn, rows) {
      const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
      for (let i = 0; i < rows.length; i += 10) {
        const batch = rows.slice(i, i + 10);
        await atFetch(url, `upsert ${table} batch ${i / 10} (rows ${i}-${i + batch.length - 1})`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ typecast: true, performUpsert: { fieldsToMergeOn: [mergeOn] }, records: batch.map((fields) => ({ fields })) }),
        }, { idempotentWrite: true });
      }
      return rows.length;
    },
  };
  return client;
}

// ---------------- Typefully (v2 REST) ----------------
// Typefully reads had NO retry while Airtable's have had one for ages — a single transient 429 or
// 502 propagated straight out, and callers that paginate treated the failure as "end of results"
// (see the registry's per-account loops), silently returning PARTIAL data as if it were complete.
// That is worse than failing: a short draft list reads as an account with fewer posts, which quietly
// moves impressions, hit-rate and stall counts. Retry, then throw loudly so the caller decides.
//
// SAFETY: a GET may be retried on 429 AND 5xx because replaying it cannot change anything. A write is
// retried on 429 ONLY — a 429 is a definitive rejection (the request never ran), whereas a 5xx may
// mean the write half-landed, and replaying createDraft on one would publish the thread twice.
export function typefully(env, transport = {}) {
  const BASE = 'https://api.typefully.com/v2';
  const h = { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}`, 'Content-Type': 'application/json' };
  const RETRYABLE_READ = new Set([429, 500, 502, 503, 504]);
  async function call(method, path, body) {
    const idempotent = method === 'GET';
    const result = await requestWithPolicy({
      provider: 'Typefully', operation: `${method} ${path.split('?')[0]}`, url: `${BASE}${path}`,
      init: { method, headers: h, body: body ? JSON.stringify(body) : undefined }, replayable: idempotent,
      fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now,
      random: transport.random, attemptTimeoutMs: transport.attemptTimeoutMs || 15_000,
      overallTimeoutMs: transport.overallTimeoutMs || 90_000, maxAttempts: 6,
      retryableStatuses: RETRYABLE_READ,
    });
    return jsonWithSchema(result, { provider: 'Typefully', operation: `${method} ${path.split('?')[0]}`, validate: (j) => j && typeof j === 'object' });
  }
  return {
    /** Raw retrying GET, for paginated endpoints this client does not wrap. */
    get: (path) => call('GET', path),
    async listPage(path, { limit = 50, offset = 0 } = {}) {
      const separator = path.includes('?') ? '&' : '?';
      const value = await call('GET', `${path}${separator}limit=${limit}&offset=${offset}`);
      if (!Array.isArray(value.results)) throw new ApiError('Typefully listPage failed: schema_mismatch', { provider: 'Typefully', operation: `listPage ${path}`, code: 'schema_mismatch' });
      if (value.next && value.results.length === 0) throw new ApiError('Typefully listPage failed: empty_continuation', { provider: 'Typefully', operation: `listPage ${path}`, code: 'empty_continuation' });
      return { items: value.results, next: Boolean(value.next), offset };
    },
    async listAll(path, { limit = 50, maxPages = 200 } = {}) {
      return collectCursorPages({
        provider: 'Typefully', operation: `listAll ${path}`, firstCursor: 0, maxPages,
        fetchPage: async (offset) => {
          const page = await this.listPage(path, { limit, offset: Number(offset || 0) });
          return { items: page.items, nextCursor: page.next ? Number(offset || 0) + page.items.length : null };
        },
      });
    },
    /** Raw PATCH, for endpoints this client does not wrap (e.g. /webhooks/{id}). Writes are never
     *  replayed on a network error — see call() — so an ambiguous PATCH surfaces to the caller. */
    patch: (path, body) => call('PATCH', path, body),
    /** Raw POST, for endpoints this client does not wrap (e.g. /social-sets/{id}/tags). Same
     *  no-replay rule as patch(): an ambiguous network failure surfaces to the caller. */
    post: (path, body) => call('POST', path, body),
    // Default share:true so every draft we create has a LIVE public share_url (typefully.com/t/<slug>) —
    // the link anyone can open WITHOUT a Typefully login. The private/internal URL (typefully.com/?d=…&a=…)
    // only renders for members of that account, so it's useless in Telegram/team messages. Override with
    // share:false if a caller ever needs a non-shared draft.
    createDraft: (socialSetId, body) => call('POST', `/social-sets/${socialSetId}/drafts`, { share: true, ...body }),
    getDraft: (socialSetId, id) => call('GET', `/social-sets/${socialSetId}/drafts/${id}`),
    patchDraft: (socialSetId, id, body) => call('PATCH', `/social-sets/${socialSetId}/drafts/${id}`, body),
    createMediaUpload: (socialSetId, fileName) => call('POST', `/social-sets/${socialSetId}/media/upload`, { file_name: fileName }),
    getMediaStatus: (socialSetId, mediaId) => call('GET', `/social-sets/${socialSetId}/media/${mediaId}`),
    // Full flow: bytes -> presigned PUT (no extra headers!) -> poll until ready -> media_id
    async uploadMedia(socialSetId, fileName, bytes) {
      const { media_id, upload_url } = await this.createMediaUpload(socialSetId, fileName);
      await requestWithPolicy({
        provider: 'TypefullyUpload', operation: 'putMediaBytes', url: upload_url,
        init: { method: 'PUT', body: bytes }, replayable: true,
        fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now, random: transport.random,
        attemptTimeoutMs: transport.uploadTimeoutMs || 60_000, overallTimeoutMs: transport.uploadOverallTimeoutMs || 180_000,
      });
      for (let i = 0; i < 30; i++) {
        const st = await this.getMediaStatus(socialSetId, media_id);
        if ((st.status || '').toLowerCase() === 'ready') return media_id;
        if ((st.status || '').toLowerCase() === 'error') throw new Error(`media ${media_id} transcode error`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`media ${media_id} not ready after 60s`);
    },
  };
}

// ---------------- Levanta ----------------
/**
 * Product image URL out of a raw Levanta product payload, or '' if it exposes none.
 *
 * Levanta's preview shape is not fully documented and the image arrives under a different key than the
 * scalar fields (it may be a bare string, an object with a url, or an array of either). Read every
 * plausible spelling in one place: product-health.mjs persists this into products.json and
 * store-catalog.mjs bakes it into the storefront JSON, and a card with no picture is a dead card, so
 * the two must not drift on which key they believe.
 *
 * Pure and exported so the shape can be pinned by tests without a live pull.
 */
export function productImage(p) {
  const firstUrl = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v.startsWith('http') ? v : '';
    if (Array.isArray(v)) { for (const it of v) { const u = firstUrl(it); if (u) return u; } return ''; }
    if (typeof v === 'object') return firstUrl(v.url || v.link || v.src || v.large || v.hiRes || v.highRes || v.medium || v.small || v.thumbnail || '');
    return '';
  };
  // `image` (a flat https string) is the confirmed live field — verified against a Levanta pull
  // 2026-08-17. The rest are fallbacks kept for the day the preview shape changes under us.
  return firstUrl(
    p?.image ?? p?.imageUrl ?? p?.image_url ?? p?.images ?? p?.mainImage ?? p?.main_image ??
    p?.primaryImage ?? p?.primary_image ?? p?.imageLink ?? p?.thumbnailUrl ?? p?.thumbnail ?? p?.photo ?? p?.picture ?? '',
  );
}

export function levanta(env, transport = {}) {
  const BASE = 'https://app.levanta.io/api/creator/v2';
  const h = { Authorization: `Bearer ${env.LEVANTA_API_KEY}`, 'Content-Type': 'application/json' };
  async function readJson(url, operation) {
    const result = await requestWithPolicy({
      provider: 'Levanta', operation, url, init: { headers: h }, replayable: true,
      fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now, random: transport.random,
      attemptTimeoutMs: transport.attemptTimeoutMs || 15_000, overallTimeoutMs: transport.overallTimeoutMs || 90_000,
    });
    return jsonWithSchema(result, { provider: 'Levanta', operation, validate: (j) => j && typeof j === 'object' });
  }
  return {
    async listProducts({ access = true, limit = 500, cursor } = {}) {
      const p = new URLSearchParams({ marketplace: 'amazon.com', limit: String(limit) });
      if (access) p.set('access', 'true');
      if (cursor) p.set('cursor', cursor);
      return readJson(`${BASE}/preview/products?${p}`, 'listProducts');
    },
    // Full catalog, paginated defensively across whatever cursor field Levanta returns (the preview
    // shape isn't fully documented). Returns the RAW item array — callers normalize fields themselves.
    // Shared by browse-catalog / product-audit / product-health so the cursor walk lives in ONE place.
    async listAllProducts({ access = true, limit = 500, maxPages = 40 } = {}) {
      return collectCursorPages({
        provider: 'Levanta', operation: 'listAllProducts', maxPages,
        fetchPage: async (cursor) => {
          const j = await this.listProducts({ access, limit, cursor });
          const items = j.products || j.data || j.results;
          if (!Array.isArray(items)) return null;
          return { items, nextCursor: j.cursor || j.nextCursor || j.next || (j.paging && (j.paging.cursor || j.paging.next)) || null };
        },
      });
    },
    // Minting has no documented idempotency key. A transport loss or 5xx may follow provider
    // acceptance, so it is classified `unknown` and never replayed. Only a definitive 429 rejection
    // may retry; callers must reconcile an unknown outcome before submitting the intent again.
    async mintLink(asin, subid1, subid2) {
      const body = { product: { primary_id: asin, marketplace: 'amazon.com' }, subid1, ...(subid2 ? { subid2 } : {}) };
      const result = await requestWithPolicy({
        provider: 'Levanta', operation: 'mintLink', url: `${BASE}/links`,
        init: { method: 'POST', headers: h, body: JSON.stringify(body) }, replayable: false,
        fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now, random: transport.random,
        attemptTimeoutMs: transport.attemptTimeoutMs || 15_000, overallTimeoutMs: transport.overallTimeoutMs || 45_000,
      });
      return jsonWithSchema(result, { provider: 'Levanta', operation: 'mintLink', validate: (j) => j && typeof j === 'object' });
    },
    // Conversions (orders) in a date range; paginates. subid1 filters to one thread.
    // NB: this endpoint wants marketplace=all and full ISO datetimes (not bare dates).
    async listConversions({ start, end, subid1 } = {}) {
      const iso = (d, isEnd) => (!d ? d : new Date(d.includes('T') ? d : `${d}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString());
      return collectCursorPages({ provider: 'Levanta', operation: 'listConversions', maxPages: 200, fetchPage: async (cursor) => {
        const p = new URLSearchParams({ marketplace: 'all', limit: '200' });
        if (start) p.set('start', iso(start, false));
        if (end) p.set('end', iso(end, true));
        if (subid1) p.set('subid1', subid1);
        if (cursor) p.set('cursor', cursor);
        const j = await readJson(`${BASE}/reports/conversions?${p}`, 'listConversions');
        return Array.isArray(j.conversions) ? { items: j.conversions, nextCursor: j.cursor || null } : null;
      } });
    },
    // v1 daily performance per link/source (commissionEarned/sales/conversions/clicks) — this is the
    // dashboard's data source. The v2 /reports/conversions endpoint returns EMPTY for this account, so
    // revenue must read v1 /reports instead. Caps at a 60-day window; paginates via cursor.
    async listReports({ start, end } = {}) {
      const V1 = BASE.replace('/v2', '/v1');
      const iso = (d, isEnd) => (!d ? d : new Date(d.includes('T') ? d : `${d}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString());
      return collectCursorPages({ provider: 'Levanta', operation: 'listReports', maxPages: 200, fetchPage: async (cursor) => {
        const p = new URLSearchParams({ marketplace: 'all', limit: '200' });
        if (start) p.set('start', iso(start, false));
        if (end) p.set('end', iso(end, true));
        if (cursor) p.set('cursor', cursor);
        const j = await readJson(`${V1}/reports?${p}`, 'listReports');
        return Array.isArray(j.reports) ? { items: j.reports, nextCursor: j.cursor || null } : null;
      } });
    },
  };
}

// ---------------- Gumroad ----------------
export function gumroad(env, transport = {}) {
  const BASE = 'https://api.gumroad.com/v2';
  const tok = env.GUMROAD_ACCESS_TOKEN;
  return {
    // Sales in a date range (YYYY-MM-DD), following Gumroad's next_page_url pagination.
    async listSales({ after, before } = {}) {
      let url = `${BASE}/sales?access_token=${encodeURIComponent(tok)}`;
      if (after) url += `&after=${after}`;
      if (before) url += `&before=${before}`;
      return collectCursorPages({ provider: 'Gumroad', operation: 'listSales', maxPages: 100, fetchPage: async (nextUrl) => {
        const target = nextUrl || url;
        const parsed = new URL(target, 'https://api.gumroad.com');
        if (parsed.origin !== 'https://api.gumroad.com') throw new ApiError('Gumroad listSales failed: invalid_next_page', { provider: 'Gumroad', operation: 'listSales', code: 'invalid_next_page' });
        if (!parsed.searchParams.has('access_token')) parsed.searchParams.set('access_token', tok);
        const result = await requestWithPolicy({
          provider: 'Gumroad', operation: 'listSales', url: parsed.href, replayable: true,
          fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now, random: transport.random,
          attemptTimeoutMs: transport.attemptTimeoutMs || 15_000, overallTimeoutMs: transport.overallTimeoutMs || 90_000,
        });
        const j = await jsonWithSchema(result, { provider: 'Gumroad', operation: 'listSales', validate: (value) => value && Array.isArray(value.sales) });
        return { items: j.sales, nextCursor: j.next_page_url ? new URL(j.next_page_url, 'https://api.gumroad.com').href : null };
      } });
    },
  };
}
// Append a tracking ref to a Gumroad product URL (Gumroad records it as url_parameters).
export function tagGumroad(url, ref) {
  if (!/gumroad\.com/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `ref=${encodeURIComponent(ref)}`;
}

// ---------------- Geniuslink ----------------
// api.geni.us. The Swagger 2.0 spec is served at https://api.geni.us/openapi. Every call carries the
// account's key pair as X-Api-Key / X-Api-Secret; X-Impersonate (v3 only) acts as a sub-account.
// Unlike Levanta, api.geni.us is reachable from the agent sandbox (an unauthenticated probe answers
// 401, not a proxy 502), so this client runs anywhere the two keys are set and needs no runner.
// The account has Levanta added as an affiliate program (operator 2026-10-06). A geni.us link to a
// plain amazon.com product therefore makes Geniuslink request ITS OWN Levanta link on the first
// click, with no documented subid. That lv_ id never reaches ledger.jsonl, so it does not join to
// a thread. docs/geniuslink.md covers the two link modes and what each does to attribution.
export const GENIUSLINK_BASE = 'https://api.geni.us';

// v1 answers in PascalCase (its 401 body is {"ResponseStatus":…}) while the spec and v3 use
// camelCase. Every response is folded to camelCase so callers read one shape. Only a PascalCase
// word (capital then lowercase) is folded: an acronym or a data key such as a country code ("US")
// is left as it is.
export function camelKeys(value) {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (!value || typeof value !== 'object') return value;
  const fold = (k) => (/^[A-Z][a-z]/.test(k) ? k[0].toLowerCase() + k.slice(1) : k);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [fold(k), camelKeys(v)]));
}

export function geniuslink(env, transport = {}) {
  requireEnv(env, ['GENIUSLINK_API_KEY', 'GENIUSLINK_API_SECRET']);
  const h = { 'X-Api-Key': env.GENIUSLINK_API_KEY, 'X-Api-Secret': env.GENIUSLINK_API_SECRET, Accept: 'application/json' };
  if (env.GENIUSLINK_IMPERSONATE) h['X-Impersonate'] = env.GENIUSLINK_IMPERSONATE;
  const query = (params = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const fail = (operation, code, outcome, result) => new ApiError(`Geniuslink ${operation} failed: ${code}`, {
    provider: 'Geniuslink', operation, code, outcome, requestId: result?.requestId, attempts: result?.attempts,
  });
  async function call(operation, method, path, { params, body, replayable = method === 'GET', validate } = {}) {
    const init = { method, headers: body === undefined ? h : { ...h, 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const result = await requestWithPolicy({
      provider: 'Geniuslink', operation, url: `${GENIUSLINK_BASE}${path}${query(params)}`, init, replayable,
      fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now, random: transport.random,
      attemptTimeoutMs: transport.attemptTimeoutMs || 15_000, overallTimeoutMs: transport.overallTimeoutMs || (replayable ? 90_000 : 45_000),
    });
    const j = camelKeys(await jsonWithSchema(result, { provider: 'Geniuslink', operation, validate: (v) => v && typeof v === 'object' }));
    // v1 reports some refusals as a 200 carrying isError {errorMessage, errorTitle}.
    if (j.isError && (j.isError.errorMessage || j.isError.errorTitle)) throw fail(operation, 'provider_error', 'known-failed', result);
    if (validate && !validate(j)) throw fail(operation, 'schema_mismatch', replayable ? 'known-failed' : 'unknown', result);
    return j;
  }
  // One row per period: the date plus Geniuslink's BasicStats (clicks, clicksMinusBot, epcNoBots, …).
  // A body without the clicksByDate array is a schema mismatch, never zero clicks.
  const clickRows = (j) => j.clicksByDate.map((kv) => ({ date: kv?.key?.dateTime || null, ...(kv?.value || {}) }));
  const clicksValid = (j) => Array.isArray(j.clicksByDate);
  const linkOut = (api, s, fallbackUrl) => {
    const domain = s.domain || 'geni.us';
    return { api, code: s.code, domain, link: `https://${domain}/${s.code}`, destination: s.productUrl || s.newLink?.productUrl || fallbackUrl, groupId: s.groupId ?? s.newLink?.tsid ?? null };
  };

  // The dashboard API (my.geniuslink.com) takes a login session, not the key pair. One login per
  // client, made on first use; the session cookie never leaves this closure and is never logged.
  const dash = async (operation, method, path, { cookie, body, replayable = method === 'GET', validate } = {}) => {
    const headers = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    const result = await requestWithPolicy({
      provider: 'Geniuslink', operation, url: `${GENIUSLINK_DASHBOARD}${path}`, replayable,
      init: { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      fetchImpl: transport.fetchImpl, sleepImpl: transport.sleepImpl, now: transport.now, random: transport.random,
      attemptTimeoutMs: transport.attemptTimeoutMs || 15_000, overallTimeoutMs: transport.overallTimeoutMs || (replayable ? 90_000 : 45_000),
    });
    const j = await jsonWithSchema(result, { provider: 'Geniuslink', operation, validate: (v) => v && typeof v === 'object' });
    if (validate && !validate(j)) throw fail(operation, 'schema_mismatch', replayable ? 'known-failed' : 'unknown', result);
    return { j, result };
  };
  let session = null;
  const dashSession = () => {
    session ||= (async () => {
      requireEnv(env, ['GENIUSLINK_EMAIL', 'GENIUSLINK_PASSWORD']);
      // ServiceStack credentials auth.
      const login = await dash('dashboardLogin', 'POST', '/auth/credentials?format=json', {
        body: { userName: env.GENIUSLINK_EMAIL, password: env.GENIUSLINK_PASSWORD, rememberMe: true }, replayable: true,
        validate: (j) => Boolean(j.sessionId),
      });
      const cookie = (login.result.response.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => /^ss-/.test(c)).join('; ');
      if (!cookie) throw fail('dashboardLogin', 'no_session_cookie', 'known-failed', login.result);
      return cookie;
    })().catch((error) => { session = null; throw error; });
    return session;
  };
  const dashLinkPath = (code) => `/v3.5/links/${encodeURIComponent(code)}?jsconfig=dh:iso8601&format=json`;
  const dashRead = async (code, operation) => (await dash(operation, 'GET', dashLinkPath(code), {
    cookie: await dashSession(), validate: (j) => j.data?.id === code && j.data?.linkOptions,
  })).j.data;

  // set: the link ends with exactly the US-only rule. clear: the link ends with no rules.
  async function usOnly(mode, code, url, groupId, { dryRun, replaceRules = false, localize = [] }) {
    const op = mode === 'set' ? 'setUsOnlyRule' : 'clearUsOnlyRule';
    const keep = localizeList(localize, op);
    if (!/^[A-Za-z0-9_-]+$/.test(String(code ?? ''))) throw new Error(`${op} needs a short code`);
    if (!/^https:\/\/www\.amazon\.com\//.test(String(url ?? ''))) throw new Error(`${op} needs an https://www.amazon.com/ url`);
    if (!/^[1-9]\d*$/.test(String(groupId ?? ''))) throw new Error(`${op} needs a numeric groupId`);
    const before = await dashRead(code, 'dashboardReadLink');
    if (String(before.groupId) !== String(groupId)) throw fail('dashboardReadLink', 'group_mismatch', 'known-failed');
    if (before.linkOptions?.destination?.url !== url) throw fail('dashboardReadLink', 'destination_mismatch', 'known-failed');
    const rules = Array.isArray(before.rules) ? before.rules : [];
    // Ours = any US-only rule on this url, with or without localized countries, so moving a link
    // between the two shapes is not a foreign-rule wipe.
    const ours = rules.filter((r) => isUsOnlyRule(r, url, null)).length;
    const otherRules = rules.length - ours;
    const done = { code, url, groupId: String(groupId), rule: mode === 'set' ? `country NotIn ${['US', ...keep].join(',')} -> same url` : 'none', otherRules, localize: mode === 'set' ? keep : [] };
    const already = mode === 'set' ? rules.length === 1 && isUsOnlyRule(rules[0], url, keep) : rules.length === 0;
    if (already) return { ...done, changed: false, updatedUtc: before.updatedUtc || null };
    if (otherRules && !(mode === 'set' && replaceRules)) throw fail('dashboardReadLink', 'other_rules', 'known-failed');
    if (dryRun) return { ...done, changed: true, dryRun: true, updatedUtc: before.updatedUtc || null };
    const destination = (retailerName) => ({ url, retailer: { name: retailerName, id: '3' }, meta: { isAutoSuggestion: false } });
    const rule = { linkOptions: { type: 'SIMPLE', destination: destination('AMAZON') }, conditions: [US_ONLY_CONDITION, ...keep.map((i) => notCountries([i]))] };
    await dash('dashboardSaveLink', 'PUT', dashLinkPath(code), {
      cookie: await dashSession(), validate: (j) => j.id === code,
      body: {
        id: code, groupId: String(groupId), alias: { code: '', domain: '' },
        linkOptions: { type: 'SIMPLE', destination: destination('Amazon') }, rules: mode === 'set' ? [rule] : [],
        trackingMeta: before.trackingMeta || { utmSource: '', utmMedium: '', utmCampaign: '', utmTerm: '', utmContent: '' },
        notes: before.notes || '', trackingPixelIds: before.trackingPixelIds || [], monetizationEnabled: before.monetizationEnabled !== false,
      },
    });
    // The save answered; the read-back decides. A mismatch means the link may be half-changed.
    const after = await dashRead(code, 'dashboardReadBack');
    const afterRules = Array.isArray(after.rules) ? after.rules : [];
    const ok = after.linkOptions?.destination?.url === url
      && (mode === 'set' ? afterRules.length === 1 && isUsOnlyRule(afterRules[0], url, keep) : afterRules.length === 0);
    if (!ok) throw fail('dashboardReadBack', 'readback_mismatch', 'unknown');
    return { ...done, changed: true, updatedUtc: after.updatedUtc || null };
  }

  // Moves a live link to a new amazon.com destination (owner 2026-11-22: "the beauty of Geniuslink
  // is the ability to redirect"), so a posted thread's link can sell a better-paying product. Same
  // read / PUT / read-back as usOnly. Refuses a link whose destination is not `fromUrl`, or that has
  // any rule other than our US-only one on `fromUrl`; the link ends on `toUrl` with the US-only rule
  // pointing at `toUrl` (so non-US clicks never fall back to the old product).
  async function retarget(code, fromUrl, toUrl, groupId, { dryRun }) {
    const op = 'retargetLink';
    if (!/^[A-Za-z0-9_-]+$/.test(String(code ?? ''))) throw new Error(`${op} needs a short code`);
    for (const u of [fromUrl, toUrl]) if (!/^https:\/\/www\.amazon\.com\//.test(String(u ?? ''))) throw new Error(`${op} needs https://www.amazon.com/ urls`);
    if (fromUrl === toUrl) throw new Error(`${op}: fromUrl and toUrl are the same`);
    if (!/^[1-9]\d*$/.test(String(groupId ?? ''))) throw new Error(`${op} needs a numeric groupId`);
    const before = await dashRead(code, 'dashboardReadLink');
    if (String(before.groupId) !== String(groupId)) throw fail('dashboardReadLink', 'group_mismatch', 'known-failed');
    const done = { code, from: fromUrl, to: toUrl, groupId: String(groupId) };
    const rules = Array.isArray(before.rules) ? before.rules : [];
    const cur = before.linkOptions?.destination?.url;
    if (cur === toUrl && rules.length === 1 && isUsOnlyRule(rules[0], toUrl, [])) return { ...done, changed: false, updatedUtc: before.updatedUtc || null };
    if (cur !== fromUrl) throw fail('dashboardReadLink', 'destination_mismatch', 'known-failed');
    if (rules.some((r) => !isUsOnlyRule(r, fromUrl, null))) throw fail('dashboardReadLink', 'other_rules', 'known-failed');
    if (dryRun) return { ...done, changed: true, dryRun: true, updatedUtc: before.updatedUtc || null };
    const destination = (retailerName) => ({ url: toUrl, retailer: { name: retailerName, id: '3' }, meta: { isAutoSuggestion: false } });
    await dash('dashboardSaveLink', 'PUT', dashLinkPath(code), {
      cookie: await dashSession(), validate: (j) => j.id === code,
      body: {
        id: code, groupId: String(groupId), alias: { code: '', domain: '' },
        linkOptions: { type: 'SIMPLE', destination: destination('Amazon') },
        rules: [{ linkOptions: { type: 'SIMPLE', destination: destination('AMAZON') }, conditions: [US_ONLY_CONDITION] }],
        trackingMeta: before.trackingMeta || { utmSource: '', utmMedium: '', utmCampaign: '', utmTerm: '', utmContent: '' },
        notes: before.notes || '', trackingPixelIds: before.trackingPixelIds || [], monetizationEnabled: before.monetizationEnabled !== false,
      },
    });
    const after = await dashRead(code, 'dashboardReadBack');
    const afterRules = Array.isArray(after.rules) ? after.rules : [];
    if (!(after.linkOptions?.destination?.url === toUrl && afterRules.length === 1 && isUsOnlyRule(afterRules[0], toUrl, []))) throw fail('dashboardReadBack', 'readback_mismatch', 'unknown');
    return { ...done, changed: true, updatedUtc: after.updatedUtc || null };
  }

  const api = {
    // v3 liveness. Its 401 means bad keys OR an account without the team-API feature (the spec's
    // own 401 text), so listGroups() is the auth proof and this only says whether v3 is open.
    // The spec marks serviceName optional, but the live API answers 400 "ServiceName cannot be null
    // or empty" without it (verified 2026-10-06); any value returns {"success":true}.
    async ping() { return call('ping', 'POST', '/v3/ping', { params: { serviceName: 'ping' }, body: {}, replayable: true }); },
    async listGroups() {
      return (await call('listGroups', 'GET', '/v1/groups/list', { validate: (j) => Array.isArray(j.groups) })).groups;
    },
    // Enrolled / available affiliate programs: Amazon storefronts by country plus a few networks.
    // Levanta is not among the programs this endpoint reports (live 2026-10-06: 27 available, none of
    // them Levanta), so it cannot prove or disprove the Levanta enrollment.
    async affiliatePrograms() {
      return call('affiliatePrograms', 'GET', '/v1/affiliate/stats', { validate: (j) => Array.isArray(j.programsEnrolled) && Array.isArray(j.availablePrograms) });
    },
    async listDomains({ skip = 0, take = 50 } = {}) {
      return (await call('listDomains', 'GET', '/v3/custom-domains', { params: { skip, take }, validate: (j) => Array.isArray(j.domains) })).domains;
    },
    async listLinks({ groupId = 0, keyword, skip = 0, take = 100, includeArchived = false } = {}) {
      return (await call('listLinks', 'GET', '/v1/links/list', {
        params: { groupid: groupId, keyword, skip, take, includeArchived }, validate: (j) => Array.isArray(j.results),
      })).results;
    },
    // Pages until an EMPTY page, advancing by what each page returned. A short page is not taken as
    // the end, because the server may cap `take` below pageSize; the price is one extra read.
    async listAllLinks({ groupId = 0, keyword, includeArchived = false, pageSize = 100, maxPages = 50 } = {}) {
      return collectCursorPages({ provider: 'Geniuslink', operation: 'listAllLinks', maxPages, fetchPage: async (cursor) => {
        const skip = Number(cursor || 0);
        const items = await api.listLinks({ groupId, keyword, includeArchived, skip, take: pageSize });
        return { items, nextCursor: items.length ? String(skip + items.length) : null };
      } });
    },
    // Shorturl creation has no idempotency key: a transport loss or 5xx after acceptance is `unknown`
    // and never replayed (Levanta mintLink's contract). v3 goes first. A 401/403 there is a definitive
    // refusal (bad keys, or the account lacks the v3 feature), never an acceptance, so v1 — the
    // dashboard's own add-link call — is safe to try once. Bad keys then fail on v1 as well. With
    // GENIUSLINK_IMPERSONATE set there is no fallback: v1 ignores X-Impersonate and would file the
    // link under the parent account.
    async createLink({ url, groupId, domain, vanityCode, note } = {}) {
      if (!url || !/^[1-9]\d*$/.test(String(groupId ?? ''))) throw new Error('createLink needs url and a numeric groupId');
      try {
        const j = await call('createLink', 'POST', '/v3/shorturls', {
          body: { url, groupId: Number(groupId), domain, vanityCode, note }, validate: (v) => Boolean(v.shortUrl?.code),
        });
        return linkOut('v3', j.shortUrl, url);
      } catch (error) {
        if (!(error instanceof ApiError) || ![401, 403].includes(error.status) || env.GENIUSLINK_IMPERSONATE) throw error;
      }
      const j = await call('createLinkV1', 'POST', '/v1/links/add', {
        body: { url, tsid: Number(groupId), domain, vanityCode, note }, validate: (v) => Array.isArray(v.linkResponses) && v.linkResponses.length > 0,
      });
      const r = j.linkResponses[0];
      if (r.code && !r.errorMessage && !r.isError?.errorMessage) return linkOut('v1', r, url);
      throw fail('createLinkV1', 'provider_rejected', r.errorMessage || r.isError?.errorMessage ? 'known-failed' : 'unknown');
    },
    // Clicks for one link. start/end are YYYY-MM-DD; resolution is hour | day | month | lifetime.
    async linkClicks({ code, start, end, resolution = 'day', retailerId } = {}) {
      if (!code) throw new Error('linkClicks needs code');
      return clickRows(await call('linkClicks', 'GET', '/v1/reports/link-click-trend-by-resolution', {
        params: { shortcode: code, start, end, resolution, retailerid: retailerId }, validate: clicksValid,
      }));
    },
    // Clicks for the whole account, same shape as linkClicks.
    async accountClicks({ start, end, resolution = 'day', retailerId } = {}) {
      return clickRows(await call('accountClicks', 'GET', '/v1/reports/click-trend-by-resolution', {
        params: { start, end, resolution, retailerid: retailerId }, validate: clicksValid,
      }));
    },
    // The dashboard's own read of one link (my.geniuslink.com v3.5), with its rules. Needs the
    // dashboard login, not the key pair. Read-only.
    async readDashboardLink(code) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(code ?? ''))) throw new Error('readDashboardLink needs a short code');
      return dashRead(code, 'dashboardReadLink');
    },
    // Sets ONE per-link rule: "country is NOT United States → this same amazon.com URL", which stops
    // Geniuslink localizing non-US clicks (docs/geniuslink.md, Non-US routing). The public API
    // rejects every rule payload, so this goes through the dashboard's own API, which needs a login
    // session (GENIUSLINK_EMAIL / GENIUSLINK_PASSWORD), not the key pair. It reads the link, PUTs it
    // back with the rule, and reads it back to check. The PUT replaces the whole link, so notes, UTM
    // fields, pixels and monetization are carried over from the read; the title and images survive
    // without being sent (live 2026-10-08). Refuses before writing when `url` is not the link's
    // current destination, or when the link has other rules the PUT would wipe (`replaceRules`
    // overrides). A link that already has exactly this rule is left alone (changed: false).
    // `dryRun` reads and reports what it would do. geni-swap.mjs calls it for every link it mints.
    // `localize` (ISO codes from LOCALIZE_COUNTRIES) leaves those countries out of the rule, so their
    // clicks fall through to Geniuslink's own localization (local Amazon store + our Associates tag
    // there) while the US default and every other country keep the amazon.com URL (owner 2026-11-13).
    async setUsOnlyRule(code, url, groupId, { dryRun = false, replaceRules = false, localize = [] } = {}) {
      return usOnly('set', code, url, groupId, { dryRun, replaceRules, localize });
    },
    // Redirects a live link to another amazon.com url (see retarget above).
    async retargetLink(code, fromUrl, toUrl, groupId, { dryRun = false } = {}) {
      return retarget(code, fromUrl, toUrl, groupId, { dryRun });
    },
    // The undo: removes the rule setUsOnlyRule sets (PUT with no rules, same carry-over and
    // read-back), so a link localizes again. Refuses a link with any other rule, which it would wipe.
    async clearUsOnlyRule(code, url, groupId, { dryRun = false } = {}) {
      return usOnly('clear', code, url, groupId, { dryRun });
    },
  };
  return api;
}

export const GENIUSLINK_DASHBOARD = 'https://my.geniuslink.com/api/proxy';
// The dashboard's "if country is NOT United States" condition, as it saves it (captured 2026-10-08).
const US_ONLY_CONDITION = { type: 'COUNTRY', if: false, value: 'United States', meta: { isoCode: 'US' } };
// Countries a link may hand to Geniuslink's localization: the Amazon stores this Geniuslink account
// is enrolled in (geniuslink.mjs check, 2026-11-13: US, CA, FR, GB), named as the dashboard names them.
export const LOCALIZE_COUNTRIES = { GB: 'United Kingdom', CA: 'Canada', FR: 'France' };
// One "country is NOT X" condition per country goes in the PUT; the dashboard then stores them as
// ONE condition with comma lists ("is not US, CA or GB"). A PUT of that merged shape itself is
// refused (live 2026-11-13), so the matcher below reads both shapes and the writer sends the split one.
const COUNTRY_NAME = { US: 'United States', ...LOCALIZE_COUNTRIES };
const notCountries = (isos) => ({ type: 'COUNTRY', if: false, value: isos.map((i) => COUNTRY_NAME[i]).join(','), meta: { isoCode: isos.join(',') } });
function localizeList(localize, op) {
  const list = [...new Set((Array.isArray(localize) ? localize : String(localize || '').split(',')).map((c) => String(c).trim().toUpperCase()).filter(Boolean))].sort();
  const bad = list.filter((c) => !LOCALIZE_COUNTRIES[c]);
  if (bad.length) throw new Error(`${op} cannot localize ${bad.join(',')}: only ${Object.keys(LOCALIZE_COUNTRIES).join(',')}`);
  return list;
}
// A US-only rule on `url`: every condition is "country is NOT X[,Y…]", US among them. With `keep` (sorted
// ISO list) it must be exactly US + those; with null, any such rule counts.
const isUsOnlyRule = (rule, url, keep = []) => {
  const c = rule?.linkOptions?.destination?.url === url && Array.isArray(rule.conditions) ? rule.conditions : null;
  if (!c || !c.length || !c.every((x) => x?.type === 'COUNTRY' && x.if === false && x.meta?.isoCode)) return false;
  const isos = c.flatMap((x) => String(x.meta.isoCode).split(',').map((i) => i.trim()));
  if (!isos.includes('US') || new Set(isos).size !== isos.length) return false;
  if (keep === null) return isos.every((i) => i === 'US' || LOCALIZE_COUNTRIES[i]);
  return isos.length === keep.length + 1 && keep.every((k) => isos.includes(k));
};

// ---------------- Attribution keys (the money joins) ----------------
// Every dollar is joined back to a thread by one of two keys: the minted link's lv_ id (Levanta)
// or the ?ref subid (Gumroad). These helpers are the ONLY definition of those keys — ten scripts
// carried their own lvIdOf copies until 2026-08-24, and all ten mis-keyed direct-rail links.

// The lv_ join key of a link. Direct Amazon Attribution URLs carry THREE lv_ ids
// (aa_campaignid, aa_adgroupid, aa_creativeid) and the campaign id comes FIRST in the URL — but
// Levanta's /reports rows key on the ADGROUP id (recreate.mjs mint contract: "aa_adgroupid=<link
// id>"). A first-match parse therefore hands every direct-rail link the SHARED campaign id: 44
// ledger rows collapsed onto one key claimed by 8 different drafts (found 2026-08-24). Prefer the
// adgroup param; fall back to first-match for lvnta.com short links, which carry exactly one id.
export const lvIdOf = (link = '') => {
  const s = String(link || '');
  const adg = s.match(/[?&]aa_adgroupid=(lv_[A-Za-z0-9]+)/);
  return adg ? adg[1] : (s.match(/lv_[A-Za-z0-9]+/) || [])[0];
};

// Which money rail a stored link joins on. The amazon-attr rail is REAL tracked money (direct
// Amazon Attribution URLs minted 2026-08-15..19) — classifying it 'other' made those rows earn $0
// in every report that only knew lvnta/gumroad.
export const railOf = (link = '') => (/lvnta|levanta/.test(link) ? 'levanta'
  : /gumroad/.test(link) ? 'gumroad'
  : /amazon\.[a-z.]+\/.*(?:maas=maas_adg_api|aa_adgroupid=lv_)/.test(link) ? 'amazon-attr'
  : 'other');

// Pure date math on YYYY-MM-DD. Gumroad's `before` is date-EXCLUSIVE (created_at < before 00:00),
// so a window ending "today" must pass nextDay(today) or today's sales are silently dropped.
export const nextDay = (ymd) => new Date(Date.parse(ymd) + 864e5).toISOString().slice(0, 10);

/**
 * Parse ledger.jsonl text into the canonical attribution maps. Pure (tests pin it); loadLedger()
 * is the fs wrapper. Shape:
 *   entries    — ONE merged object per draftId. Metadata-only appends (self-qrt-topup, cta-restyle)
 *                overlay their fields; rows WITH attribution replace outright (evergreen re-mints
 *                supersede). Same rule registry-sync has run since the Rafael-10270558 clobber.
 *   orphans    — rows with no draftId (mint-only rows, future manual tags). Kept visible so a hand
 *                mint is never silently unjoinable.
 *   bySubid    — subid1/subid1b -> raw row (last wins). The Gumroad join key.
 *   byLvId     — lv_ id -> draftId (last line wins — today's claimant rule; resolveClaimants can
 *                re-resolve from the candidates when statuses are known).
 *   byLvIdCandidates / bySubidCandidates — key -> [draftId, ...] in ledger line order, deduped
 *                consecutively, for published-preference claimant resolution.
 */
export function parseLedger(text) {
  const byDraft = new Map(), bySubid = new Map(), byLvId = new Map();
  const byLvIdCandidates = new Map(), bySubidCandidates = new Map();
  // EVERY key a draft has EVER carried, accumulated across all its rows. byDraft cannot answer
  // this: a row with attribution REPLACES the previous entry outright (the anti-clobber rule), so a
  // draft whose plugs were minted across several rows — a repair, a re-mint, a 3rd/4th product —
  // keeps only the last row's link/link2 in the merged view. registry-sync read exactly those two
  // fields and silently dropped every earlier link: Marcos 10380538 reported 333 lifetime clicks
  // off its 5-link total of 1,225, and two qualifying threads vanished from the harvest pool.
  // Revenue joins must consume THESE maps (claimant-guarded), never the merged row's link fields.
  const linksByDraft = new Map(), subidsByDraft = new Map();
  // asinsByDraft (2026-09-02): every ASIN the draft ever plugged, same accumulation rule — the
  // Products link on the registry row is built from this, never from the merged row's asin/asin2.
  const asinsByDraft = new Map();
  const orphans = [];
  const addMember = (map, id, v) => { if (!map.has(id)) map.set(id, new Set()); map.get(id).add(v); };
  const addCandidate = (map, k, id) => {
    if (!map.has(k)) map.set(k, []);
    const arr = map.get(k);
    if (arr[arr.length - 1] !== id) arr.push(id);
  };
  for (const line of String(text || '').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e.draftId) {
        const id = String(e.draftId), prev = byDraft.get(id);
        // A SATELLITE ROW NEVER BECOMES THE DRAFT'S ENTRY (2026-08-30). `attributionOnly` marks a row
        // that exists only to carry one more link: products 3+ on a roundup, and every cross-post
        // mint. Such a row has BOTH subid1 and link, so the replace-on-attribution rule below handed
        // it the merged entry outright and took the parent's own fields with it. On the ledger as it
        // stands that masked 21 drafts, 6 of which lost their `hookId` (10537862 dropped hk_0m0bo6s)
        // — the key weekly-metrics groups on, so those threads had silently dropped out of hook
        // revenue analysis. Cross-posting made it visible; roundups had been doing it all along.
        // The satellite's link and subid still register in the join maps below, which is the only
        // thing a revenue join ever wanted from it.
        if (!(prev && e.attributionOnly)) {
          byDraft.set(id, prev && !(e.subid1 || e.link)
            ? { ...prev, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v != null)) }
            : e);
        }
        for (const l of [e.link, e.link2]) {
          const k = lvIdOf(l);
          if (k) { byLvId.set(k, id); addCandidate(byLvIdCandidates, k, id); addMember(linksByDraft, id, k); }
        }
        for (const s of [e.subid1, e.subid1b]) if (s) { addCandidate(bySubidCandidates, s, id); addMember(subidsByDraft, id, s); }
        for (const a of [e.asin, e.asin2]) if (a) addMember(asinsByDraft, id, String(a).toUpperCase());
      } else {
        orphans.push(e);
      }
      if (e.subid1) bySubid.set(e.subid1, e);
      if (e.subid1b) bySubid.set(e.subid1b, e); // second product's ?ref tag — else its Gumroad sales never join
    } catch {}
  }
  return { entries: [...byDraft.values()], orphans, byDraft, bySubid, byLvId, byLvIdCandidates, bySubidCandidates, linksByDraft, subidsByDraft, asinsByDraft };
}
export function loadLedger() {
  let raw = '';
  try { raw = readFileSync(join(HERE, 'ledger.jsonl'), 'utf8'); } catch {}
  return parseLedger(raw);
}

/**
 * Aggregate Levanta v1 /reports rows per link id. Rows are per-(date, link, ASIN) and the `clicks`
 * figure is LINK-level, repeated verbatim on every halo-ASIN row — summing raw rows inflated one
 * 31-day read 5.1x. Clicks are deduped as a running MAX per (date, link); money fields are
 * genuinely per-row and sum. Pure — extracted from registry-sync so every consumer counts alike.
 */
export function aggregateLevReports(reports) {
  const byLink = new Map(), clickByDayLink = new Map();
  for (const r of reports || []) {
    const id = r.link?.id; if (!id) continue;
    const g = byLink.get(id) || { commission: 0, sales: 0, orders: 0, clicks: 0 };
    g.commission += Number(r.commissionEarned) || 0;
    g.sales += Number(r.sales) || 0;
    g.orders += Number(r.conversions) || 0;
    const dayKey = `${String(r.date || '').slice(0, 10)}|${id}`;
    const seen = clickByDayLink.get(dayKey) || 0;
    const rowClicks = Number(r.clicks) || 0;
    if (rowClicks > seen) { g.clicks += rowClicks - seen; clickByDayLink.set(dayKey, rowClicks); }
    byLink.set(id, g);
  }
  return { byLink, clickByDayLink };
}

/** Resolve a shared attribution key's claimant from its candidate draftIds (ledger line order).
 *  Preference: the LAST candidate that is actually published, else the last the fleet still knows,
 *  else the last line — pure last-line-wins handed shared lv_ ids to whichever fan-out duplicate
 *  was ledgered last, and 24 PUBLISHED posts earned $0 while deleted twins held the claim. */
export function resolveClaimants(candidates, { published, known } = {}) {
  const arr = candidates || [];
  const pick = (pred) => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i]; return undefined; };
  return pick((id) => published?.has(id)) ?? pick((id) => known?.has(id)) ?? arr[arr.length - 1];
}

// Affiliate earnings-per-click. Levanta-only numerator over Levanta-only clicks: dividing by the
// all-links `Link Clicks` sensor diluted EPC with clicks that never touched an affiliate link, and
// mixing Gumroad net into the numerator overstated it. null (never 0) when there is no click data.
export const affiliateEpc = ({ levCommission = 0, levClicks = 0 } = {}) =>
  (levClicks > 0 ? levCommission / levClicks : null);

// Levanta's commission fields on OUR 0..1 fraction scale, where 60% arrives as 0.600. Both callers
// used to hedge with `v <= 1 ? v : Math.round(v) / 100`, on the theory that a big number must be a
// percent. Levanta sends fractions, and promo rates go ABOVE 1: PURE HEALTH MAX NAD (B0G399MQ2N)
// launched at totalCommission 1.010 — a 101% promo, $35.34/sale — and the weekly product-health
// sync read it as a percent, rounded it to 1 and divided by 100. A 101% rate became 1%, $35.34/sale
// became $0.35, and the best-paying product on the board sorted last in every payout ranking for
// nine days (caught 2026-09-09). Math.round was lossy on top of that: a real 37.5% would land 38%.
//
// PERCENT_FLOOR is where the two scales stop overlapping. A fraction is a rate, so it lives near
// 0..1 and a launch promo can reach ~1.5; a percent-scale value we would ever stock starts at 15.
// Anything between is ambiguous, and 2 sits inside that gap on the safe side: reading a genuine
// 200% promo as 2% is the error this exists to prevent, so the split refuses to shrink a value
// unless it is far too big to be a rate.
export const PERCENT_FLOOR = 2;
export const commissionFraction = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < PERCENT_FLOOR ? n : n / 100;
};

// ---------------- LLM (provider-agnostic) ----------------
// Was Anthropic-only; now speaks EITHER the Anthropic Messages API OR any OpenAI-compatible
// chat-completions endpoint (OpenRouter, Moonshot/Kimi, DeepSeek, …) so the workflow can route
// through a gateway without editing call sites. Same signature, same string return value.
//
//   Transport (base URL + key) — first match wins:
//     LLM_BASE_URL + LLM_API_KEY          -> that endpoint (OpenAI shape unless the URL is api.anthropic.com)
//     OPENROUTER_API_KEY (no LLM_BASE_URL) -> https://openrouter.ai/api/v1 (OpenAI shape, all providers)
//     ANTHROPIC_API_KEY (nothing else)     -> https://api.anthropic.com (native Messages — current default)
//
//   Model, per call — first match wins:  MODEL_<ROLE>  ->  LLM_MODEL  ->  the call's own `model`
//     Roles: 'generate' (the voice/plug rewrite), 'aux' (qc / product-fit / swap / tighten), 'retro'.
//     So MODEL_AUX=moonshotai/kimi-k2 moves ONLY the mechanical calls; LLM_MODEL=… moves everything.
//     With no env set, every call keeps its hardcoded Claude model -> behaviour is unchanged.
//
//   When routing through OpenRouter/etc., set the model env vars to THAT gateway's IDs — e.g.
//   Kimi `moonshotai/kimi-k2`, DeepSeek `deepseek/deepseek-chat`, Claude
//   `anthropic/claude-sonnet-4.6`. The bare `claude-sonnet-4-6` default only resolves on api.anthropic.com.
//
// Retries transient failures (429, 5xx, 529, network) with exponential backoff + jitter (honours
// Retry-After); non-transient errors (400/401/413/…) throw immediately.
function llmEndpoint(env) {
  const explicit = env.LLM_BASE_URL && env.LLM_BASE_URL.replace(/\/+$/, '');
  const key = (k) => (k || '').trim(); // trailing-newline paste protection (see resolveModel note)
  if (explicit) return { baseUrl: explicit, apiKey: key(env.LLM_API_KEY || env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY), native: /api\.anthropic\.com/.test(explicit) };
  if (env.OPENROUTER_API_KEY || env.LLM_API_KEY) return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: key(env.LLM_API_KEY || env.OPENROUTER_API_KEY), native: false };
  return { baseUrl: 'https://api.anthropic.com', apiKey: key(env.ANTHROPIC_API_KEY), native: true };
}
// ---- THE FLEET DEFAULT (operator 2026-08-25) -----------------------------------------------------
// ONE constant, so the fleet's model is a single edit rather than eight scattered literals. Written
// in the NATIVE spelling; gatewayModelId translates it for OpenRouter, which is where the fleet runs.
//
// Sonnet 5 over the previous Sonnet 4.6 default because it is strictly better on both axes: newer,
// and CHEAPER — $2/$10 per M against 4.6's $3/$15, same 1M context (OpenRouter's live rates,
// 2026-08-25). There is no Sonnet 4.7; the line runs 4 / 4.5 / 4.6 / 5 / 5.5.
// 2026-11-10: Sonnet 5.5 replaces Sonnet 5 at the same $2/$10 (cache reads half price), and
// STRONG_MODEL names the one Opus every "use the strong model" call site shares: Opus 5.5 is newer
// AND cheaper than the Opus 5 / 4.8 literals it replaces ($4/$20 vs $5/$25). Fable 5.2 ($8/$40) is
// deliberately not a default anywhere: no script call here needs it.
export const FLEET_MODEL = 'claude-sonnet-5-5';
export const STRONG_MODEL = 'claude-opus-5-5';
// Models on which thinking cannot be switched off (a `disabled` thinking config is a 400): Fable,
// Mythos, Opus 5.5, Sonnet 5.5, Haiku 5.5. Their depth is set with effort instead. Every current
// model from Opus 4.5 on takes output_config.effort; Haiku 4.5, Sonnet 4.5 and older do not.
export const thinkingAlwaysOn = (model) => /claude-(fable|mythos|opus-5[-.]5|sonnet-5[-.]5|haiku-5[-.]5)/i.test(String(model || ''));
export const takesEffort = (model) => thinkingAlwaysOn(model) || /claude-(opus-(4[-.][5-9]|5)|sonnet-(4[-.]6|5))/i.test(String(model || ''));
// Effort for a script call: the caller's, else LLM_EFFORT, else by size. The script calls are short,
// mechanical rewrites and classifications (max_tokens 200-1000), and thinking spends from the same
// max_tokens budget, so a short call runs at `low` to keep its answer from being cut off; longer ones
// at `medium` (Opus 5.5's own default; Sonnet's default is `high`).
export const effortFor = (env, { effort, max_tokens = 4096 } = {}) => String(effort || env?.LLM_EFFORT || (max_tokens <= 1000 ? 'low' : 'medium')).trim().toLowerCase();
const MODEL_ROLE_ENV = { generate: 'MODEL_GENERATE', aux: 'MODEL_AUX', retro: 'MODEL_RETRO' };
// .trim() everywhere: a secret pasted with a trailing newline (e.g. `echo val | gh secret set`)
// otherwise rides into the model id / auth header and 400s EVERY call it touches — that is
// exactly how the 2026-07-12 daily batch shipped 0/6 (MODEL_GENERATE had a trailing \n while
// the LLM_MODEL-routed aux calls worked, so the failure looked like a generation bug).
// ---- GATEWAY MODEL IDS (operator 2026-08-25: "funnel through OpenRouter") ------------------------
// Native Anthropic and OpenRouter spell the same model differently. Native takes hyphens and an
// optional date ("claude-sonnet-4-6", "claude-haiku-4-5-20251001"); OpenRouter takes a vendor prefix
// and a DOTTED version ("anthropic/claude-sonnet-4.6"). Every call site in this repo passes the
// native spelling as its default, so on the gateway path a bare default 404s — which is the trap
// waiting for anyone who deletes LLM_MODEL expecting the code default to take over.
//
// Verified against OpenRouter's live model list 2026-08-25: claude-sonnet-4.6, claude-opus-5,
// claude-haiku-4.5 all exist under the anthropic/ prefix; the hyphenated spellings do not.
// Anything already carrying a vendor prefix is left exactly as written — an explicit LLM_MODEL is
// the operator's word and this must never rewrite it.
export function gatewayModelId(model) {
  const id = String(model || '').trim();
  if (!id || id.includes('/')) return id;              // already vendor-qualified, or empty
  if (!/^claude-/i.test(id)) return id;                // not an Anthropic id — cannot guess a vendor
  const undated = id.replace(/-\d{8}$/, '');            // claude-haiku-4-5-20251001 -> claude-haiku-4-5
  const dotted = undated.replace(/-(\d+)-(\d+)$/, '-$1.$2'); // -4-6 -> -4.6 (a lone -5 is already right)
  return `anthropic/${dotted}`;
}
const resolveModel = (env, { model, role, native = true }) => {
  const picked = String(((role && env[MODEL_ROLE_ENV[role]]) || env.LLM_MODEL || model) || '').trim();
  return native ? picked : gatewayModelId(picked);
};

// ---- LLM spend metering (operator ask 2026-08-10: "what does each step actually cost?") ------------
// Every LLM call in the engine flows through anthropic() below, so ONE in-process accumulator sees a
// run's whole spend, tagged by role and model. OpenRouter answers carry the exact dollar cost
// (usage.cost — we already request it and printed it, then threw it away); native Anthropic calls are
// priced from llm-prices.json (estimate, flagged as such — reconcile against the invoice, not vice
// versa). logRun() flushes the accumulator into the LLM Spend table automatically, so every pipeline
// that already logs a run gets a spend row for free; recreate/qc/retro flush explicitly because they
// exit without logRun. Visibility must never fail a pipeline: everything here is fire-and-forget.
let LLM_PRICES = null;
function llmPrices() {
  if (!LLM_PRICES) {
    try { LLM_PRICES = JSON.parse(readFileSync(join(HERE, 'llm-prices.json'), 'utf8')); } catch { LLM_PRICES = {}; }
  }
  return LLM_PRICES;
}

// Estimate one NATIVE call's USD cost from the price table (longest matching model-id prefix wins).
// Returns null when the model is unpriced — callers keep the tokens and surface "unpriced" instead of
// silently booking $0 for real spend. Cache rates derive from the input rate (read 0.1x, write 1.25x)
// unless the row names its own `cacheRead` (Opus 5.5, Sonnet 5.5 and Fable 5.2 price reads below 0.1x).
export function priceUsage(model, u = {}) {
  const table = llmPrices();
  const key = Object.keys(table)
    .filter((k) => !k.startsWith('_') && String(model || '').replace(/^[^/]+\//, '').startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const p = table[key];
  return (
    ((u.input_tokens || 0) * p.in +
      (u.output_tokens || 0) * p.out +
      (u.cache_creation_input_tokens || 0) * p.in * 1.25 +
      (p.cacheRead != null ? (u.cache_read_input_tokens || 0) * p.cacheRead : (u.cache_read_input_tokens || 0) * p.in * 0.1)) / 1e6
  );
}

const LLM_SPEND = { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, exactCalls: 0, unpricedTokens: 0, byRole: {}, byModel: {} };

export function meterLlmCall({ model, role, usage = {}, exactCost }) {
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  let cost = null;
  let exact = false;
  if (exactCost != null && Number.isFinite(Number(exactCost))) { cost = Number(exactCost); exact = true; }
  else cost = priceUsage(model, usage);
  LLM_SPEND.calls++;
  LLM_SPEND.tokensIn += inTok;
  LLM_SPEND.tokensOut += outTok;
  LLM_SPEND.cacheRead += usage.cache_read_input_tokens || 0;
  LLM_SPEND.cacheWrite += usage.cache_creation_input_tokens || 0;
  if (cost != null) LLM_SPEND.costUsd += cost; else LLM_SPEND.unpricedTokens += inTok + outTok;
  if (exact) LLM_SPEND.exactCalls++;
  for (const [map, key] of [[LLM_SPEND.byRole, role || 'unspecified'], [LLM_SPEND.byModel, model || '?']]) {
    const b = (map[key] ||= { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    b.calls++; b.tokensIn += inTok; b.tokensOut += outTok;
    if (cost != null) b.costUsd += cost;
  }
  return cost;
}

export function llmSpendSummary() {
  const round = (n) => Number(n.toFixed(4));
  const shrink = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, costUsd: round(v.costUsd) }]));
  // basis says how to read costUsd: 'exact' = provider-reported dollars, 'estimated' = price-table
  // math, 'mixed' = a run that used both routes. The dashboard shows this label verbatim.
  const basis = LLM_SPEND.calls === 0 ? 'none' : LLM_SPEND.exactCalls === LLM_SPEND.calls ? 'exact' : LLM_SPEND.exactCalls === 0 ? 'estimated' : 'mixed';
  return { ...LLM_SPEND, costUsd: round(LLM_SPEND.costUsd), basis, byRole: shrink(LLM_SPEND.byRole), byModel: shrink(LLM_SPEND.byModel) };
}

export function resetLlmSpend() {
  Object.assign(LLM_SPEND, { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, exactCalls: 0, unpricedTokens: 0, byRole: {}, byModel: {} });
}

// One row per run into the LLM Spend table (registry base), then reset so a later flush in the same
// process can never double-count. `label` distinguishes runs within a pipeline (account, draft id).
export async function flushLlmSpend(env, pipeline, label = '') {
  if (!LLM_SPEND.calls) return false;
  const s = llmSpendSummary();
  resetLlmSpend();
  try {
    const e = env || loadEnv();
    if (!e.AIRTABLE_PAT || !e.REGISTRY_BASE_ID) return false;
    await airtable(e, e.REGISTRY_BASE_ID).create('LLM Spend', [{ fields: {
          Run: `${pipeline}${label ? ` · ${label}` : ''} · ${new Date().toISOString().slice(0, 16)}Z`,
          At: new Date().toISOString(),
          Pipeline: pipeline,
          Calls: s.calls,
          'Tokens In': s.tokensIn,
          'Tokens Out': s.tokensOut,
          'Cache Read': s.cacheRead,
          'Cost USD': s.costUsd,
          Basis: s.basis,
          // Task duration ≈ process uptime at flush (excludes runner checkout/npm overhead).
          Seconds: Math.round(process.uptime()),
          'By Role': JSON.stringify(s.byRole),
          'By Model': JSON.stringify(s.byModel),
          ...(s.unpricedTokens ? { Note: `${s.unpricedTokens} unpriced tokens — model missing from llm-prices.json` } : {}),
        } }], { typecast: true });
    return true;
  } catch { return false; }
}

// Map a bare Anthropic model id to its OpenRouter id (audit 2026-07-21 failover): prefix the vendor
// and dot the trailing version ("claude-sonnet-4-6" -> "anthropic/claude-sonnet-4.6"). Ids that already
// carry a vendor prefix pass through untouched. Pure + exported for tests.
export const openrouterModelId = (m) => {
  const id = String(m || '').trim();
  if (!id.startsWith('claude') || id.includes('/')) return id;
  return `anthropic/${id.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
};

// JEV PICKS THE MODEL (owner, 2026-09-24: "Not everything needs the highest model"). A call with no
// explicit `model`, for a role listed in laws.json modelRouting.roles, is routed by model-router.mjs:
// Jev reads the task and picks fast / standard / strong within the role's floor and ceiling. The
// operator's explicit word still wins (MODEL_<ROLE>, LLM_MODEL), as does a caller's explicit model and
// pinNative. `validate(text)` (optional) is the escalation: output it refuses is written once more one
// tier up, within the role's ceiling. Routing can never stop a call: any failure uses the call default.
// Owner, 2026-09-26: "We are using the Chat to generate the threads — NEVER the Claude API key", and for the
// scheduled run and its prep: "Remember to use claude chat token NOT Api." A session that must write only in
// the chat marks itself chat-only: the scheduled /run and its prep create CHAT_ONLY_MARKER first thing (or
// PI_CHAT_ONLY=1 is set). Every call here then throws before any request, so a script that would have
// written through a model API fails loudly, and the writing happens in the chat instead.
export const CHAT_ONLY_MARKER = join(homedir(), '.pi-chat-only');
// PI_CHAT_ONLY=0 is an explicit off, for a test that answers from a fake endpoint.
export function chatOnly(env = process.env, marker = CHAT_ONLY_MARKER) {
  const flags = [process.env.PI_CHAT_ONLY, env?.PI_CHAT_ONLY].map((v) => String(v ?? '').trim());
  if (flags.includes('1')) return true;
  if (flags.includes('0')) return false;
  return existsSync(marker);
}
export class ChatOnlyError extends Error {}

export async function anthropic(env, { model: explicitModel, role, max_tokens = 4096, system, messages, pinNative = false, validate = null, jevClient = null, effort }) {
  if (chatOnly(env)) {
    throw new ChatOnlyError(`chat-only session: ${role || 'this call'} would write through a model API (lib.mjs anthropic); write it in the chat instead`);
  }
  const roleEnv = role ? (env[MODEL_ROLE_ENV[role]] || env[`MODEL_${String(role).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]) : null;
  let route = null;
  if (explicitModel == null && !pinNative && role && !roleEnv && !String(env.LLM_MODEL || '').trim() && !env._noRoute) {
    try { route = await (await import('./model-router.mjs')).routeModel(env, { role, system, messages, client: jevClient }); } catch { route = null; } // optional-import: no SDK or no key -> the call default
  }
  const model = explicitModel ?? route?.model ?? FLEET_MODEL;
  if (route?.model) console.log(`  [route] ${role}: ${route.tier} (${route.by}${route.reasons?.length ? `: ${route.reasons.join('; ')}` : ''})`);
  const text = await anthropicOnce(env, { model, role, max_tokens, system, messages, pinNative, effort });
  if (!validate || validate(text)) return text;
  const { escalateTier, modelForTier, routingConfig } = await import('./model-router.mjs'); // optional-import: model-router itself needs only laws.mjs
  const roleCfg = routingConfig().roles[role] || {};
  const up = route ? escalateTier(route.tier, roleCfg) : null;
  if (!up || !modelForTier(up)) return text;
  console.log(`  [route] ${role}: output failed its check on ${route.tier} — once more on ${up}`);
  return anthropicOnce(env, { model: modelForTier(up), role, max_tokens, system, messages, pinNative, effort });
}

async function anthropicOnce(env, { model = FLEET_MODEL, role, max_tokens = 4096, system, messages, pinNative = false, effort }) {
  // pinNative: force THIS call onto native Anthropic with the call's own model, ignoring the
  // LLM_MODEL / MODEL_<ROLE> gateway routing. For the rare call whose correctness depends on strict
  // instruction-following (the bridge-priors pass: "final beat MUST contain this word verbatim" —
  // the gateway model ignored it three runs straight, 2026-08-17). Falls back to normal routing
  // when no ANTHROPIC_API_KEY exists, so a gateway-only environment still works.
  const pinned = pinNative && env.ANTHROPIC_API_KEY;
  const { baseUrl, apiKey, native } = pinned
    ? { baseUrl: 'https://api.anthropic.com', apiKey: String(env.ANTHROPIC_API_KEY).trim(), native: true }
    : llmEndpoint(env);
  if (!apiKey) throw new Error('No LLM API key set (OPENROUTER_API_KEY / LLM_API_KEY / ANTHROPIC_API_KEY).');
  const chosen = pinned ? model : resolveModel(env, { model, role, native });
  const label = native ? 'anthropic' : 'llm';
  const url = native ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
  const headers = native
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'project-infinity', ...(env.OPENROUTER_REFERER ? { 'HTTP-Referer': env.OPENROUTER_REFERER } : {}) };
  const payload = native
    ? { model: chosen, max_tokens, system, messages, ...(takesEffort(chosen) ? { output_config: { effort: effortFor(env, { effort, max_tokens }) } } : {}) }
    : { model: chosen, max_tokens, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] };
  if (!native) {
    // Reasoning control (OpenAI-shape only): many cheap models (GLM-5.x, Kimi K2.5, DeepSeek) enable
    // hidden "thinking" BY DEFAULT and can burn the whole completion budget on it, returning EMPTY
    // content — GLM-5.2 did exactly that (its only effort levels are high/xhigh). We want fast, cheap,
    // JSON-shaped completions, so reasoning is OFF by default. Models with MANDATORY reasoning (e.g.
    // openai/gpt-5-mini) reject enabled:false — set LLM_REASONING=minimal|low|medium|high for those.
    // Non-reasoning models ignore the parameter entirely (OpenRouter drops it), so this is always safe.
    // Claude models whose thinking cannot be switched off (Fable, Opus 5.5, Sonnet 5.5, Haiku 5.5) get
    // no `enabled: false`: Anthropic answers a disabled thinking config on them with a 400. They get
    // the same size-based effort as the native path, with the reasoning hidden from the reply.
    const reasoning = (env.LLM_REASONING || 'none').toLowerCase();
    if (reasoning === 'none') payload.reasoning = thinkingAlwaysOn(chosen) ? { effort: effortFor(env, { effort, max_tokens }), exclude: true } : { enabled: false };
    else payload.reasoning = { effort: reasoning, exclude: true };
    payload.usage = { include: true }; // OpenRouter echoes the exact $ cost back in the response's usage.cost
  }

  const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
  const MAX_ATTEMPTS = 7;
  const doRequest = async () => {
    let result;
    try {
      result = await requestWithPolicy({
        provider: label, operation: `generate ${chosen}`, url,
        init: { method: 'POST', headers, body: JSON.stringify(payload) },
        // A generation can consume money even when its response is lost. Retry only a definitive
        // 429 rejection; transport and 5xx outcomes remain unknown and are never replayed.
        replayable: false, maxAttempts: MAX_ATTEMPTS, retryableStatuses: RETRYABLE,
        attemptTimeoutMs: 90_000, overallTimeoutMs: 180_000,
      });
    } catch (error) {
      error.transient = error instanceof ApiError && error.retryable && error.outcome === 'known-failed';
      throw error;
    }
    const j = await jsonWithSchema(result, { provider: label, operation: `generate ${chosen}`, validate: (value) => value && typeof value === 'object' });
        // One line per call so run logs show real spend: model, tokens in/out, and dollars — exact
        // when OpenRouter reports usage.cost, price-table estimate ("est") on the native path. The
        // same numbers feed the in-process spend accumulator that logRun/flushLlmSpend persist.
        const u = j.usage || {};
        const spent = meterLlmCall({ model: chosen, role, usage: u, exactCost: u.cost });
        const tokIn = u.prompt_tokens ?? u.input_tokens ?? '?';
        const tokOut = u.completion_tokens ?? u.output_tokens ?? '?';
        console.log(`  [${label}] ${chosen}: ${tokIn} in / ${tokOut} out${spent != null ? ` / $${spent.toFixed(4)}${u.cost != null ? '' : ' est'}` : ''}`);
        return native
          ? (j.content || []).map((c) => c.text || '').join('')
          : (j.choices || []).map((c) => (c.message && c.message.content) || '').join('');
  };
  try { return await doRequest(); }
  catch (e) {
    // Failover is allowed only after a known-rejected retryable outcome such as exhausted 429s.
    // Transport and 5xx outcomes are unknown and cannot safely trigger a second billable generation
    // through another provider. _noOpenRouterFallback stops recursion.
    const fbKey = (env.OPENROUTER_API_KEY || '').trim();
    if (native && fbKey && e && e.transient && !env._noOpenRouterFallback) {
      console.warn(`anthropic exhausted (${String(e.message).slice(0, 90)}) — failing over to OpenRouter`);
      return anthropic(
        { ...env, LLM_BASE_URL: 'https://openrouter.ai/api/v1', LLM_API_KEY: fbKey, LLM_MODEL: openrouterModelId(chosen), _noOpenRouterFallback: '1' },
        { model, max_tokens, system, messages, effort },
      );
    }
    throw e;
  }
}
// Provider-agnostic alias — new code can import { llm }; existing imports of { anthropic } keep working.
export const llm = anthropic;

// ---- shared CLI arg getter (audit 2026-07-21: 3 verbatim copies consolidated) ----------------------
// It takes the BARE name and adds the dashes itself. cliArg('--sources') looks for '----sources',
// matches nothing, and returns the default with no error — which is exactly what happened: --sources
// was dead from the day it shipped, and a week planned "CoachDanGo only" drew from the whole roster
// and read as if the flag had simply had no effect on the pool. Silent is the problem, so a dashed
// name is now a crash at the call site rather than a wrong plan an hour later.
export const cliArg = (n, d) => {
  if (String(n).startsWith('-')) throw new Error(`cliArg takes the bare name, not '${n}' — use cliArg('${String(n).replace(/^-+/, '')}')`);
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

// ---- crash-alert entry wrapper (audit 2026-07-21 ops gap) ------------------------------------------
// Scheduled entry scripts ended with main().catch(console.error + exit 1) — no alert of their own, so
// any workflow missing from failure-handler's name list failed in total silence. runMain(main, name)
// keeps the exit-1 contract AND best-effort telegrams ops on the way down, so a crash is visible even
// when the workflow-level handler misses it. Alert failure never masks the original error.
// Local crashes stay local (Phase 7b): a developer's crash is already on their screen, so paging
// ops for it is noise. Only a GitHub Actions run (GITHUB_ACTIONS=true) alerts.
export const crashAlertWanted = (env = process.env) => env.GITHUB_ACTIONS === 'true';
export function runMain(fn, pipeline = 'pipeline') {
  return fn().catch(async (e) => {
    console.error('ERROR:', e.stack || e.message);
    if (!crashAlertWanted()) console.error('(local run — crash alert not sent; only CI runs page ops)');
    else try { const env = loadEnv(); await telegram(env, `🛑 <b>${esc(pipeline)} crashed</b>\n<pre>${esc(String(e.message || e).slice(0, 400))}</pre>\n\n👉 <i>Check the workflow run log — the failure-handler retries once, then alerts here if it fails again.</i>`, 'ops'); }
    catch (te) { console.error(`(crash alert failed: ${te.message})`); }
    process.exit(1);
  });
}

/** Normalize DASHBOARD_URL down to an origin. The variable is pasted by a human from the browser
 *  bar, so it arrives carrying whatever page they were on ("…lovable.app/dashboard" — the live
 *  value on day one) — and every route lives at the origin root, so keeping that page path would
 *  aim each deep link at a dead nested route. A value that isn't an absolute URL falls back to
 *  slash-trimmed as-is rather than throwing: a shaggy link beats a crashed alert sender. */
export const dashBase = (url) => {
  if (!url) return null;
  try { return new URL(String(url)).origin; } catch { return String(url).replace(/\/+$/, '') || null; }
};

/** Absolute dashboard URL for a path like "/reports?post=recX", or null when DASHBOARD_URL is
 *  unset — callers render the link only when it exists, so alerts degrade to plain text rather
 *  than carrying dead hrefs. Set DASHBOARD_URL as a repo Actions variable. */
export const dashLink = (env, path) => {
  const base = dashBase(env.DASHBOARD_URL);
  return base ? `${base}${path}` : null;
};

// ---- per-alert dedupe (Phase 7b, 2026-09-23) ------------------------------------------------------
// telegram() has no memory, so a check on a 2h cron repeated the same page 12 times a day. A caller
// that passes `key` opts in: the same key with the same fingerprint inside the window is suppressed;
// a changed fingerprint, an elapsed window, or a recovery always sends. State is logs/alert-state.json,
// committed by the calling workflow with its other logs. No key = the old behaviour, unchanged. A
// failed send records nothing, so it is simply tried again next run.
export const ALERT_WINDOW_H = 6;
export const ALERT_STATE_FILE = join(HERE, 'logs', 'alert-state.json');
const alertFp = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export function readAlertState(file = ALERT_STATE_FILE) {
  try { const s = JSON.parse(readFileSync(file, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; }
}
export function writeAlertState(state, file = ALERT_STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 1) + '\n');
}
/** Failing: 'send' | 'suppress'. Healthy (ok): 'recovery' when the key was failing, else 'quiet'.
 *  A missing or unreadable timestamp sends — a broken memory must never swallow a page. */
export function alertDecision(prev, { fingerprint = '', ok = false, now = Date.now(), windowH = ALERT_WINDOW_H } = {}) {
  if (ok) return prev ? 'recovery' : 'quiet';
  if (!prev || prev.fp !== alertFp(fingerprint)) return 'send';
  const age = now - Date.parse(prev.sentAt);
  return age >= 0 && age < windowH * 36e5 ? 'suppress' : 'send';
}
/** Remember what was just sent; a recovery clears the key so the next failure pages at once. */
export function recordAlert(state, key, { fingerprint = '', ok = false, now = Date.now() } = {}) {
  if (ok) delete state[key];
  else state[key] = { fp: alertFp(fingerprint), sentAt: new Date(now).toISOString() };
  return state;
}

// ---------------- Telegram (token + chat id from Airtable Config) ----------------
// route (optional): 'harvest' | 'weekly' | 'revenue' | 'calendar' | 'retro' | 'alerts' | ...
// If the group has Topics enabled, Config's "Topics" JSON maps route -> message_thread_id
// and the message lands in that topic. No mapping (or no route) -> General / plain group.
// opts (optional): { key, fingerprint = text, ok, windowH, stateFile } — see the dedupe block above.
export async function telegram(env, text, route, { key, fingerprint = text, ok = false, windowH, stateFile = ALERT_STATE_FILE, now = Date.now(), sender = telegram } = {}) {
  if (key) {
    const state = readAlertState(stateFile);
    const decision = alertDecision(state[key], { fingerprint, ok, now, windowH });
    if (decision === 'suppress' || decision === 'quiet') {
      console.log(`telegram: '${key}' ${decision === 'quiet' ? 'healthy and was not failing' : `unchanged within ${windowH ?? ALERT_WINDOW_H}h`} — not sent`);
      return { sent: false, decision };
    }
    await sender(env, text, route);
    writeAlertState(recordAlert(state, key, { fingerprint, ok, now }), stateFile);
    return { sent: true, decision };
  }
  // Routing itself follows the live Topics map, so an unlisted-but-mapped route still lands in its
  // topic — this warn only flags the CODE list going stale (the fall-to-General case is the second
  // warn below, which checks the map).
  if (route && !TELEGRAM_ROUTES.includes(route)) console.warn(`telegram: route '${route}' is not in TELEGRAM_ROUTES (config.mjs) — add it there so the canonical list stays complete.`);
  let token = env.TELEGRAM_BOT_TOKEN, chatId = env.TELEGRAM_CHAT_ID, topics = {};
  if (!token || !chatId || route) {
    const result = await requestWithPolicy({
      provider: 'Airtable', operation: 'get Telegram config',
      url: `https://api.airtable.com/v0/${env.XDB_BASE_ID}/${TABLES.config}/${CONFIG_RECORD}`,
      init: { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } }, replayable: true,
      attemptTimeoutMs: 15_000, overallTimeoutMs: 60_000,
    });
    const rec = await jsonWithSchema(result, { provider: 'Airtable', operation: 'get Telegram config', validate: (value) => value && typeof value.fields === 'object' });
    token = token || rec.fields?.Token; chatId = chatId || rec.fields?.['Chat ID'];
    try { topics = JSON.parse(rec.fields?.Topics || '{}'); } catch { topics = {}; }
  }
  const threadId = route ? topics[route] : undefined;
  // The TELEGRAM_ROUTES check above catches a script inventing a route name. This catches the other
  // half — the half that actually bit: a route that IS canonical in config.mjs but has no entry in
  // the live Airtable Topics map falls back to General with no signal at all. `brief`, the one
  // message that matters every day, had been landing there because the map lists 11 routes and
  // config.mjs declares 12. Drift between code and data is invisible unless something says so.
  if (route && threadId === undefined) {
    console.warn(`telegram: route '${route}' has NO thread id in the Airtable Config Topics map — this message will land in General. Add "${route}": <thread_id> to that map.`);
  }
  const send = async (body) => (await requestWithPolicy({
    provider: 'Telegram', operation: 'sendMessage',
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    replayable: false, attemptTimeoutMs: 15_000, overallTimeoutMs: 45_000,
  })).response;
  // Telegram hard-caps a message at 4096 chars — split long bodies on line boundaries so a big report
  // (e.g. per-thread revenue) is delivered in parts instead of failing with "message is too long".
  const LIMIT = 3900, chunks = [];
  let buf = '';
  for (const ln of String(text).split('\n')) {
    if (buf && (buf.length + 1 + ln.length) > LIMIT) { chunks.push(buf); buf = ln; }
    else buf = buf ? `${buf}\n${ln}` : ln;
  }
  if (buf) chunks.push(buf);
  const parts = chunks.flatMap((c) => (c.length <= LIMIT ? [c] : c.match(new RegExp(`[\\s\\S]{1,${LIMIT}}`, 'g')) || []));
  for (const part of (parts.length ? parts : [''])) {
    await sendPart({ send, chatId, text: part, threadId, route });
  }
}

const TOPIC_GONE = new Set(['TOPIC_NOT_FOUND', 'TOPIC_CLOSED', 'TOPIC_DELETED']);

/**
 * One message part, with the three recoveries a daily report needs (pure over `send`; tested):
 *  - transport reset (no Telegram reply at all): retry ONCE after `retryDelayMs`. Owner rule
 *    2026-11-14 for vendor sends — a rare double message beats a lost one — applied here too,
 *    since these go to the owner's own group.
 *  - the topic is gone or closed (Config Topics map points at a deleted thread): send to General
 *    with a one-line note, so the report still arrives. The Morning Brief failed this way daily.
 *  - any other 400 (bad HTML): resend as plain text, as before.
 */
export async function sendPart({ send, chatId, text, threadId, route, retryDelayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = { chat_id: chatId, text, disable_web_page_preview: true, ...(threadId ? { message_thread_id: threadId } : {}) };
  const once = async (body) => {
    try { return await send(body); } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'transport_unknown') throw error;
      await sleep(retryDelayMs);
      return send(body);
    }
  };
  try {
    await once({ ...base, parse_mode: 'HTML' });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400) throw error;
    if (threadId && TOPIC_GONE.has(error.code)) {
      console.warn(`telegram: topic ${threadId} for route '${route}' is ${error.code} — sent to General instead. Fix "${route}" in the Airtable Config Topics map.`);
      const { message_thread_id: _gone, ...general } = base;
      const note = `<i>(topic for '${esc(route)}' is missing; fix the Config Topics map)</i>\n`;
      try { await once({ ...general, text: note + text, parse_mode: 'HTML' }); }
      catch (e2) { if (!(e2 instanceof ApiError) || e2.status !== 400) throw e2; await once(general); }
      return;
    }
    // A 400 definitively rejected the HTML payload, so a plain-text correction cannot duplicate it.
    await once(base);
  }
}

// What Telegram counts against its 4096 limit: the text AFTER HTML entity parsing (tags and the
// URLs inside them are free), in UTF-16 units like String.length. Only the entities our esc() emits
// decode here, so a page measured with this is never under-counted.
export const telegramTextLength = (html) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, '_').length;

// One durable Telegram card per logical key (for example `today:2026-09-12`). Unlike telegram(),
// this deliberately refuses to split: a card is one message whose identity must remain stable.
// State is supplied by the caller so GitHub Actions can commit it alongside the job's other queues.
export async function telegramCard(env, text, route, key, { state, fetchFn = fetch } = {}) {
  // Telegram's own limit is 4096 characters after entity parsing; 3900 keeps headroom. The raw cap only
  // stops a runaway payload (link-heavy HTML is legitimately much longer than what it displays).
  const shown = telegramTextLength(text);
  if (shown > 3900 || String(text).length > 16000) throw new Error(`Telegram card '${key}' is ${shown} chars shown / ${String(text).length} raw (max 3900 / 16000)`);
  requireEnv(env, ['TELEGRAM_CEO_BOT_TOKEN']);
  const token = env.TELEGRAM_CEO_BOT_TOKEN, chatId = COMMAND_CENTER_CHAT_ID;
  const threadId = COMMAND_CENTER_TOPICS[route];
  if (!threadId) throw new Error(`Unknown Command Center card route '${route}'`);
  // Message ids are scoped to chat and sender. Never reuse legacy RT-bot card state.
  const senderId = String(token).split(':')[0];
  const cards = state.cards ||= {};
  const saved = cards[key];
  const prior = saved?.chatId === chatId && saved?.threadId === threadId && saved?.senderId === senderId ? saved : null;
  if (prior?.text === text) return { action: 'unchanged', messageId: prior.messageId };
  const call = async (method, body, html = true) => fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...(html ? { parse_mode: 'HTML' } : {}), disable_web_page_preview: true }),
  });
  const base = { chat_id: chatId, text: String(text) };
  if (prior?.messageId) {
    let r = await call('editMessageText', { ...base, message_id: prior.messageId });
    if (r.ok) { cards[key] = { ...prior, text, updatedAt: new Date().toISOString() }; return { action: 'edited', messageId: prior.messageId }; }
    const detail = await r.text();
    if (/message is not modified/i.test(detail)) { cards[key] = { ...prior, text }; return { action: 'unchanged', messageId: prior.messageId }; }
    if (!/message to edit not found|message can't be edited/i.test(detail)) {
      r = await call('editMessageText', { ...base, message_id: prior.messageId }, false);
      if (r.ok) { cards[key] = { ...prior, text, updatedAt: new Date().toISOString() }; return { action: 'edited-plain', messageId: prior.messageId }; }
      throw new Error(`Telegram edit -> ${r.status}: ${await r.text()}`);
    }
  }
  let r = await call('sendMessage', { ...base, ...(threadId ? { message_thread_id: threadId } : {}) });
  if (!r.ok) r = await call('sendMessage', { ...base, ...(threadId ? { message_thread_id: threadId } : {}) }, false);
  if (!r.ok) throw new Error(`Telegram send -> ${r.status}: ${await r.text()}`);
  const sent = await r.json(); const messageId = sent.result?.message_id;
  if (!messageId) throw new Error('Telegram send returned no message_id');
  cards[key] = { messageId, route, chatId, threadId, senderId, text, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { action: prior ? 'recreated' : 'created', messageId };
}
// Escape dynamic text for Telegram HTML mode (hooks/titles may contain & < >).
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// "Mon 15 Jun" / "Mon 15 Jun, 19:00" in Saigon time, from an ISO string or Date.
export const fmtSaigon = (iso, withTime = false) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) })
    .format(new Date(iso)).replace(',', withTime ? ',' : '');

// ---------------- Canonical report layout ----------------
// Every pipeline report uses the same three glance-zones so you can skim CONTEXT -> OUTCOME -> ACTION:
//   header   <emoji> <b>NAME</b> · <i>scope</i>      WHAT this is + scope/when/account            (context)
//   status   one line, leads with a state glyph       the headline RESULT, readable on its own     (outcome)
//   sections optional <b>LABEL</b> + body blocks      the supporting detail / numbers / lists       (outcome)
//   action   👉 what to do next (or "no action")       the next step                                 (action)
// State glyph legend — keep CONSISTENT across every report:
//   ✅ done / healthy   🆕 new items   ⚠️ needs attention   🛑 critical / down   ℹ️ neutral info   💤 nothing to do
// `status` and section `body` are passed ALREADY formatted (caller escapes dynamic bits with esc() and may
// embed <b>/<a>); `title`/`scope`/`action` are plain strings and are escaped here. Empty parts are dropped,
// so a one-line report is just `report({ emoji, title, scope, status })`.
export function report({ emoji = 'ℹ️', title, scope = '', status = '', sections = [], action = '' }) {
  const head = `${emoji} <b>${esc(title)}</b>${scope ? ` · <i>${esc(scope)}</i>` : ''}` + (status ? `\n${status}` : '');
  const body = (sections || [])
    .filter((s) => s && s.body != null && String(s.body).trim() !== '')
    .map((s) => (s.label ? `<b>${esc(s.label)}</b>\n` : '') + s.body)
    .join('\n\n');
  const foot = action ? `👉 <i>${esc(action)}</i>` : '';
  return [head, body, foot].filter(Boolean).join('\n\n');
}
