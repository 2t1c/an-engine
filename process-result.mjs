// Machine results are independent of human stdout. This file is a receipt, not an idempotency store.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const PHASES = new Set(['started', 'validated', 'confirmed', 'rejected', 'unknown']);
const KEY = /^[A-Za-z0-9:_.-]{1,200}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const exact = (object, fields) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every(key => fields.includes(key));
function safeShareUrl(value) {
  if (value == null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['typefully.com', 'www.typefully.com'].includes(url.hostname)
      && !url.username && !url.password && [...url.searchParams.keys()].every(key => key === 'd') ? String(value) : null;
  } catch { return null; }
}

export function validateResult(value, operationKey) {
  if (!exact(value, ['protocolVersion', 'operationKey', 'ok', 'phase', 'result', 'error', 'llmCost'])
    || value.protocolVersion !== 1 || typeof value.operationKey !== 'string' || !KEY.test(value.operationKey) || value.operationKey !== operationKey
    || typeof value.ok !== 'boolean' || !PHASES.has(value.phase)
    || !Number.isFinite(value.llmCost) || value.llmCost < 0) throw new Error('Invalid process result');
  if (value.result !== null) {
    if (!exact(value.result, ['draftId', 'shareUrl']) || typeof value.result.draftId !== 'string' || !ID.test(value.result.draftId)) throw new Error('Invalid process result');
    if (value.result.shareUrl != null) {
      if (!safeShareUrl(value.result.shareUrl)) throw new Error('Unsafe process result URL');
    }
  }
  if (value.error !== null && !['NO_CONFIRMED_DRAFT', 'PROCESS_FAILED', 'RESULT_UNAVAILABLE'].includes(value.error)) throw new Error('Invalid process result error');
  if (value.phase === 'confirmed' && !value.result) throw new Error('Missing confirmed draft');
  if (value.ok && (!['confirmed', 'validated'].includes(value.phase) || value.error !== null)) throw new Error('Invalid process success');
  if (value.phase === 'validated' && (value.result !== null || !value.ok)) throw new Error('Invalid validation result');
  if (value.phase !== 'confirmed' && value.result !== null) throw new Error('Unconfirmed process result');
  return value;
}

export function resultChannel(argv = process.argv.slice(2), { llmCost = null } = {}) {
  const index = argv.indexOf('--result-file');
  if (index < 0) return { confirm() {}, validated() {}, adopt() {}, finish() {}, fail() {} };
  const file = argv[index + 1];
  const operationKey = argv[argv.indexOf('--operation-key') + 1];
  if (!file || !isAbsolute(file) || !argv.includes('--operation-key') || typeof operationKey !== 'string' || !KEY.test(operationKey)) throw new Error('Result file requires an absolute path and operation key');
  let state = { protocolVersion: 1, operationKey, ok: false, phase: 'started', result: null, error: null, llmCost: 0 };
  const persist = () => {
    if (llmCost) state = { ...state, llmCost: Number(llmCost()) };
    validateResult(state, operationKey);
    const temporary = mkdtempSync(join(dirname(file), '.process-result-'));
    try {
      const path = join(temporary, 'result.json');
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
      renameSync(path, file);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  };
  persist(); // Validate destination permissions before any operation starts.
  return {
    confirm(draftId, shareUrl) {
      const safeUrl = safeShareUrl(shareUrl);
      state = { ...state, ok: true, phase: 'confirmed', result: { draftId: String(draftId), ...(safeUrl ? { shareUrl: safeUrl } : {}) }, error: null };
      persist(); // Persist immediately after creation, before optional bookkeeping can fail.
    },
    validated() { state = { ...state, ok: true, phase: 'validated', result: null, error: null }; persist(); },
    adopt(result) { state = validateResult(result, operationKey); persist(); },
    finish() {
      if (state.phase === 'started') state = { ...state, phase: 'rejected', error: 'NO_CONFIRMED_DRAFT' };
      persist();
    },
    fail() {
      state = { ...state, ok: false, phase: state.phase === 'confirmed' ? 'confirmed' : state.phase === 'validated' ? 'rejected' : 'unknown', error: 'PROCESS_FAILED' };
      persist();
    },
  };
}

export function processOperationKey(scope, parts) {
  if (!KEY.test(scope)) throw new Error('Invalid operation-key scope');
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const key = `${scope}:${hash}`;
  if (!KEY.test(key)) throw new Error('Operation-key scope is too long');
  return key;
}

export const mayRetryBeforeEffect = (outcome) => outcome?.phase === 'rejected' && outcome?.ok === false && outcome?.result === null;

export async function withProcessResult(run, argv = process.argv.slice(2), options = {}) {
  const channel = resultChannel(argv, options);
  try { const result = await run(channel); channel.finish(); return result; }
  catch (error) { channel.fail(); throw error; }
}

export async function runResultChild(script, args, { operationKey, cwd, timeout = 480000, execute = execFile, resultRoot = tmpdir() } = {}) {
  if (typeof operationKey !== 'string' || !KEY.test(operationKey)) throw new Error('A stable operation key is required');
  mkdirSync(resultRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(resultRoot, 'infinity-process-'));
  const file = join(directory, 'result.json');
  const processStatus = await new Promise(resolve => {
    try {
      execute(process.execPath, [script, ...args, '--result-file', file, '--operation-key', operationKey],
        { cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 },
        error => resolve(error ? 'failed' : 'completed'));
    } catch { resolve('failed'); }
  });
  let result;
  try { result = validateResult(JSON.parse(readFileSync(file, 'utf8')), operationKey); }
  catch { result = { protocolVersion: 1, operationKey, ok: false, phase: 'unknown', result: null, error: 'RESULT_UNAVAILABLE', llmCost: 0 }; }
  if (result.phase === 'started') result = { ...result, phase: 'unknown', error: 'RESULT_UNAVAILABLE' };
  if (processStatus === 'failed' && result.ok) result = {
    ...result,
    ok: false,
    phase: result.phase === 'validated' ? 'rejected' : result.phase,
    error: 'PROCESS_FAILED',
  };
  validateResult(result, operationKey);
  // Unknown/partial effects retain their receipt for reconciliation. Never retry based on logs.
  const evidencePath = result.ok || result.phase === 'rejected' ? null : join(directory, 'outcome.json');
  if (evidencePath) writeFileSync(evidencePath, JSON.stringify(result), { mode: 0o600 });
  if (!evidencePath) rmSync(directory, { recursive: true, force: true });
  return { ...result, evidencePath };
}
