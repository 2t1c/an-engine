#!/usr/bin/env node
// node scripts/secrets-status.mjs   which secrets are set (never their values); exit 1 if a required one is missing
import { secretsStatus } from '../lib/secrets.mjs';

const s = secretsStatus();
for (const r of s.rows) console.log(`${r.set ? 'set    ' : 'MISSING'}  ${r.name.padEnd(24)} ${r.owner.padEnd(9)} ${r.feature}${r.required ? '' : ' (optional)'}`);
for (const pair of s.halfPairs) console.log(`HALF    ${pair.join(' + ')}: set both or neither`);
console.log(s.ok ? 'secrets: ok' : `secrets: ${s.missing.length} required missing, ${s.halfPairs.length} half pair(s)`);
process.exit(s.ok ? 0 : 1);
