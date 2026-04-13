import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typesPath = path.resolve(__dirname, '../src/integrations/supabase/types.ts');
const file = fs.readFileSync(typesPath, 'utf8');

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
