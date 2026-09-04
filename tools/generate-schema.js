/**
 * lib/schema.sql -> lib/schema.generated.js
 *
 * The SQL is imported as a JS module rather than read from disk at runtime: an
 * fs read inside lib/db.js makes Next trace the whole project into the
 * standalone output (lib/db.js explains the same thing from the other side).
 *
 * Run after any edit to lib/schema.sql:  node tools/generate-schema.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'lib/schema.sql'), 'utf8');

const INDEX_MARKER = '-- ============ INDEX ============';
const split = sql.indexOf(INDEX_MARKER);
if (split < 0) throw new Error(`lib/schema.sql is missing the "${INDEX_MARKER}" divider`);

// Drop the file's own header comment; keep everything the database needs.
const tables = sql.slice(0, split).replace(/^(?:--[^\n]*\n)+\n/, '').trim();
const indexes = sql.slice(split + INDEX_MARKER.length).trim();

// Backticks would end the template literal and ${ would start an
// interpolation. Neither appears in SQL, so treat either as a mistake rather
// than escaping it into something that silently differs from schema.sql.
for (const [name, body] of [['tables', tables], ['indexes', indexes]]) {
  if (/`|\$\{/.test(body)) throw new Error(`lib/schema.sql ${name} contain a backtick or \${`);
}

const out = `// GENERATED from lib/schema.sql -- do not hand-edit.
// Regenerate: node tools/generate-schema.js
//
// Split into two statements on purpose. An index such as
// idx_contractors_dataversion references a column that lib/db.js may still be
// about to add on an older database, so the run order must be:
//   tables -> additive columns -> indexes

export const SCHEMA_TABLES = \`${tables}
\`;

export const SCHEMA_INDEXES = \`${indexes}
\`;
`;

fs.writeFileSync(path.join(root, 'lib/schema.generated.js'), out);
console.log('wrote lib/schema.generated.js');
