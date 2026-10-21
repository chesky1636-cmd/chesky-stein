// Usage: DATABASE_URL=... node scripts/restore.js backup.json   (target database must be empty)
import fs from 'node:fs';
import { migrate } from '../src/migrate.js';
import { importAll } from '../src/backup.js';
import { pool } from '../src/db.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/restore.js backup.json'); process.exit(1); }
await migrate();
await importAll(JSON.parse(fs.readFileSync(file, 'utf8')));
console.log('restore complete');
await pool.end();
