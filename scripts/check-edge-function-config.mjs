// Verify every edge function under supabase/functions/<name>/index.ts
// has a matching [functions.<name>] stanza in supabase/config.toml.
//
// Audit P2-08: edge function auth flags are not fully source-controlled.
// A new function added without a stanza inherits the platform default
// (verify_jwt = true) which sometimes is wrong (cron jobs need false,
// public token endpoints need false). The 2026-05-13 audit found
// get-invite-info shipped this way and 401-ed every new-user invite
// (P1-13).
//
// Run via `npm run check:edge-function-config`. Wired into prebuild
// + CI so a stanza-less function fails the build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const functionsDir = path.join(repoRoot, 'supabase', 'functions');
const configPath = path.join(repoRoot, 'supabase', 'config.toml');

const configSrc = fs.readFileSync(configPath, 'utf8');
const stanzaRe = /^\[functions\.([^\]]+)\]/gm;
const stanzaNames = new Set();
for (const m of configSrc.matchAll(stanzaRe)) {
  stanzaNames.add(m[1]);
}

const functionDirs = fs
  .readdirSync(functionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
  .map((e) => e.name);

const missing = [];
const orphanStanzas = [];

for (const name of functionDirs) {
  const indexPath = path.join(functionsDir, name, 'index.ts');
  if (!fs.existsSync(indexPath)) {
    continue;
  }
  if (!stanzaNames.has(name)) {
    missing.push(name);
  }
}

const functionDirSet = new Set(functionDirs);
for (const stanza of stanzaNames) {
  if (!functionDirSet.has(stanza)) {
    orphanStanzas.push(stanza);
  }
}

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error('Edge functions missing a [functions.<name>] stanza in supabase/config.toml:');
  for (const name of missing) console.error(`  - ${name}`);
  console.error('');
  console.error('Add an explicit `verify_jwt = true|false` block per audit P2-08.');
}

if (orphanStanzas.length > 0) {
  failed = true;
  console.error('config.toml stanzas with no matching function directory:');
  for (const s of orphanStanzas) console.error(`  - ${s}`);
  console.error('');
  console.error('Either restore the function source or remove the stanza.');
}

if (failed) process.exit(1);

console.log(`All ${functionDirs.length} edge functions have matching config.toml stanzas.`);
