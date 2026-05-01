#!/usr/bin/env node
/**
 * Pre-build gate that catches "Cannot find name" / "Did you mean..." errors
 * across src/ — exactly the class of bug that shipped a runtime
 * `ReferenceError: Select is not defined` because Vite's build does not
 * type-check. Filters TS output for the two error codes that flag missing
 * imports / undefined identifiers (TS2304, TS2552).
 *
 * Why a custom script vs `npm run typecheck`: the project has many
 * pre-existing TS errors (TS7006 implicit-any, TS2339 GenericStringError,
 * etc.) that the team hasn't cleaned up. A blanket `tsc --noEmit` fails
 * with hundreds of unrelated lines and would block builds. This script
 * filters to the bug class that ALWAYS indicates a real bug — and never
 * fires false positives.
 */
import { spawnSync } from 'node:child_process';

const proc = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.app.json', '--noImplicitAny'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const allLines = ((proc.stdout || '') + (proc.stderr || '')).split(/\r?\n/);
// TS2304: Cannot find name 'X'.
// TS2552: Cannot find name 'X'. Did you mean 'Y'?
const offenders = allLines.filter((l) => /TS2304|TS2552/.test(l));

if (offenders.length === 0) {
  console.log('✓ No undefined-name issues. Build can proceed.');
  process.exit(0);
}

console.error('✗ Undefined identifiers detected — likely missing imports:');
for (const line of offenders) console.error('  ' + line);
console.error('');
console.error(`Found ${offenders.length} issue(s). Add the missing imports before the build can succeed.`);
process.exit(1);
