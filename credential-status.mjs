// Offline credential presence report. This command never authenticates, contacts a service, or
// prints values. Presence means configured-unverified; only a separate authorized probe may promote
// a credential to auth-ok or scope-ok.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CREDENTIALS = [
  { service: 'Airtable', names: ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID', 'HEALTH_XDB_BASE_ID'] },
  { service: 'Typefully', names: ['TYPEFULLY_API_KEY'] },
  { service: 'Levanta', names: ['LEVANTA_API_KEY', 'LEVANTA_TOKEN'] },
  { service: 'Gumroad', names: ['GUMROAD_ACCESS_TOKEN'] },
  { service: 'Geniuslink', names: ['GENIUSLINK_API_KEY', 'GENIUSLINK_API_SECRET', 'GENIUSLINK_IMPERSONATE', 'GENIUSLINK_EMAIL', 'GENIUSLINK_PASSWORD'] },
  { service: 'LLM transport', names: ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'LLM_BASE_URL', 'LLM_API_KEY'] },
  { service: 'TypeSafe Jev', names: ['TYPESAFE_API_KEY', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_BASE_URL'] },
  { service: 'RapidAPI', names: ['RAPIDAPI_KEY'] },
  { service: 'Clipper service', names: ['CLIPPER_URL', 'CLIPPER_SERVICE_KEY'] },
  { service: 'n8n administration', names: ['N8N_URL', 'N8N_API_KEY'] },
  { service: 'Railway Project Infinity observation', names: ['RAILWAY_TOKEN'] },
  { service: 'Railway n8n project observation', names: ['RAILWAY_N8N_TOKEN'] },
  { service: 'Stripe', names: ['STRIPE_SECRET_KEY'] },
  { service: 'PayPal', names: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_API_BASE'] },
  { service: 'Telegram', names: ['TELEGRAM_CEO_BOT_TOKEN', 'TELEGRAM_RT_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] },
  { service: 'Retweet bot', names: ['RT_BOT_URL', 'RT_BOT_WEBHOOK_SECRET'] },
  { service: 'Dashboard', names: ['DASHBOARD_URL'] },
  { service: 'Runtime state pilot', names: ['STATE_DATABASE_URL'] },
];

export const CREDENTIAL_NAMES = [...new Set(CREDENTIALS.flatMap((group) => group.names))];

function decodeValue(raw, lineNumber) {
  const value = raw.trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote)
      throw new Error(`invalid quoted value at line ${lineNumber}`);
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

export function parseEnvText(text) {
  const values = {};
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) throw new Error(`invalid environment assignment at line ${index + 1}`);
    values[match[1]] = decodeValue(match[2], index + 1);
  }
  return values;
}

export function credentialReport(fileValues = {}, environment = {}) {
  return CREDENTIALS.map(({ service, names }) => ({
    service,
    credentials: names.map((name) => ({
      name,
      status: String(environment[name] ?? fileValues[name] ?? '').trim()
        ? 'configured-unverified'
        : 'missing',
    })),
  }));
}

export function renderText(report) {
  return report.flatMap((group) => [
    group.service,
    ...group.credentials.map(({ name, status }) => `  ${name}: ${status}`),
  ]).join('\n');
}

function argsOf(argv) {
  const args = { file: '.env', json: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--json') args.json = true;
    else if (argv[index] === '--file') {
      if (!argv[index + 1]) throw new Error('--file requires a path');
      args.file = argv[++index];
    } else throw new Error('unknown option');
  }
  return args;
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const args = argsOf(argv);
  const file = resolve(args.file);
  let fileValues = {};
  if (existsSync(file)) {
    let contents;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      // Filesystem errors may embed the caller-supplied path, so expose only a fixed diagnostic.
      throw new Error('could not read credential file');
    }
    try {
      fileValues = parseEnvText(contents);
    } catch (error) {
      // Parser errors are generated above and contain only a line number, never source text.
      throw new Error(`could not parse credential file: ${error.message}`);
    }
  }
  const report = credentialReport(fileValues, environment);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`credential status failed: ${error.message}`);
    process.exitCode = 1;
  }
}
