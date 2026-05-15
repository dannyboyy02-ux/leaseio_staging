import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typesPath = path.resolve(__dirname, '../src/integrations/supabase/types.ts');
const file = fs.readFileSync(typesPath, 'utf8');

// Catch the case where the MCP/CLI response was saved verbatim — its JSON
// envelope (`{"types": "..."}`) parses as valid JSON but breaks every consumer.
const head = file.trimStart().slice(0, 200);
if (!/^(export|import|\/\/|\/\*)/.test(head)) {
  console.error(
    `Supabase types file does not start with valid TypeScript. ` +
    `Regenerate via "supabase gen types typescript" or the MCP generate_typescript_types tool ` +
    `and write the raw output (not the JSON wrapper) to ${path.relative(process.cwd(), typesPath)}.\n` +
    `First 200 chars: ${JSON.stringify(head)}`,
  );
  process.exit(1);
}

const requiredTables = [
  'dismissed_events',
  'processing_rate_limits',
  'user_preferences',
];

const missingTables = requiredTables.filter((table) => !file.includes(`${table}: {`));

if (missingTables.length > 0) {
  console.error(
    `Supabase generated types are missing table definitions for: ${missingTables.join(', ')}`,
  );
  process.exit(1);
}

console.log('Supabase type coverage check passed.');
