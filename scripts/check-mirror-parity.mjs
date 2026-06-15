// Parity check for Node/Deno mirror pairs (audit P2-04).
//
// Several pure-domain modules ship in two near-identical copies so
// the frontend (Node) and edge functions (Deno) can both import them
// without the Node-vs-Deno module-system split bleeding into the
// caller. The contract is "byte-equivalent in *behavior*" — the only
// legitimate diff between a pair is the header docstring, which
// swaps "Node mirror" / "Deno mirror" labels and the cross-reference
// paths.
//
// This script enforces the contract by stripping the leading block
// comment, normalizing trivial formatting (single vs double quotes,
// trailing whitespace), and comparing the rest of each pair. Any
// remaining diff fails the build.
//
// Mirror pairs:
//   src/lib/lifecycleStates.ts        ↔ supabase/functions/_shared/lifecycle.ts
//   src/lib/approvalChainLogic.ts     ↔ supabase/functions/_shared/approval_chain.ts
//   src/lib/leaseDocuments.ts         ↔ supabase/functions/_shared/lease_documents.ts
//   src/lib/asc842Report.ts           ↔ supabase/functions/_shared/asc842_report.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PAIRS = [
  {
    node: 'src/lib/lifecycleStates.ts',
    deno: 'supabase/functions/_shared/lifecycle.ts',
  },
  {
    node: 'src/lib/approvalChainLogic.ts',
    deno: 'supabase/functions/_shared/approval_chain.ts',
  },
  {
    node: 'src/lib/leaseDocuments.ts',
    deno: 'supabase/functions/_shared/lease_documents.ts',
  },
  {
    node: 'src/lib/asc842Report.ts',
    deno: 'supabase/functions/_shared/asc842_report.ts',
  },
  {
    node: 'src/lib/firmAccess.ts',
    deno: 'supabase/functions/_shared/firm_access.ts',
  },
];

/**
 * Strip the leading block of `//`-prefixed lines (the docstring that
 * legitimately diverges between the Node and Deno copies). Anything
 * after the first non-comment line is treated as code-body.
 */
function stripLeadingComment(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) {
      i++;
    } else {
      break;
    }
  }
  return lines.slice(i).join('\n');
}

/**
 * Normalize formatting + non-behavior comment noise:
 *   - quote chars (single → double)
 *   - trailing whitespace on each line
 *   - tab → 2 spaces
 *   - drop lines that are entirely a `//` comment (cross-reference
 *     prose that legitimately differs between Node/Deno copies)
 *   - collapse multiple blank lines
 *   - trim trailing newlines
 *
 * Real behavior-altering diffs survive normalization. Comments inside
 * a code line (e.g. `const x = 1; // why`) are not stripped — those
 * are rare in the mirror modules and tend to be the same in both
 * copies because they describe shared behavior.
 */
function normalize(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/'/g, '"')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
}

function readPair(p) {
  return {
    node: fs.readFileSync(path.join(repoRoot, p.node), 'utf8'),
    deno: fs.readFileSync(path.join(repoRoot, p.deno), 'utf8'),
  };
}

function firstDiffLine(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      return { line: i + 1, node: aLines[i] ?? '<EOF>', deno: bLines[i] ?? '<EOF>' };
    }
  }
  return null;
}

let failures = 0;
for (const p of PAIRS) {
  const { node, deno } = readPair(p);
  const a = normalize(stripLeadingComment(node));
  const b = normalize(stripLeadingComment(deno));
  if (a === b) {
    console.log(`OK  ${p.node}  ==  ${p.deno}`);
  } else {
    failures++;
    const diff = firstDiffLine(a, b);
    console.error(`FAIL  ${p.node}  !=  ${p.deno}`);
    if (diff) {
      console.error(`  First diff at code-body line ${diff.line}:`);
      console.error(`    node: ${JSON.stringify(diff.node.slice(0, 200))}`);
      console.error(`    deno: ${JSON.stringify(diff.deno.slice(0, 200))}`);
    }
  }
}

if (failures > 0) {
  console.error('');
  console.error(`${failures} mirror pair(s) out of sync. Update both copies in lockstep.`);
  process.exit(1);
}

console.log('All mirror pairs in sync.');
