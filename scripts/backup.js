// Usage: DATABASE_URL=... node scripts/backup.js [out.json]   (always includes pictures)
import fs from 'node:fs';
import { exportAll } from '../src/backup.js';
import { pool } from '../src/db.js';

const out = process.argv[2] || `backups/backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.mkdirSync(new URL('../backups/', import.meta.url), { recursive: true });
const data = await exportAll({ includeMedia: true });
fs.writeFileSync(out, JSON.stringify(data));
console.log(`backup written to ${out}`);
await pool.end();
