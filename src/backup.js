// JSON export / import of all records. Railway's managed Postgres also keeps its own backups; this
// export is an additional, portable copy that a super administrator can download at any time.
import { many, tx } from './db.js';

const TABLES = ['settings', 'media', 'categories', 'boys', 'boy_aliases', 'telegram_imports', 'occasions', 'occasion_media', 'announcements', 'telegram_outbox', 'audit_log'];

export async function exportAll({ includeMedia = false } = {}) {
  const out = { format: 'school-db-backup', version: 1, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    let rows;
    if (t === 'media') {
      rows = includeMedia
        ? (await many('SELECT * FROM media ORDER BY id')).map((r) => ({ ...r, data: r.data.toString('base64'), thumb: r.thumb.toString('base64') }))
        : await many('SELECT id, mime, width, height, bytes, sha256, source, created_at FROM media ORDER BY id');
    } else if (t === 'settings') {
      // PIN hashes are not exported.
      rows = await many("SELECT * FROM settings WHERE key NOT IN ('pin_admin','pin_super') ORDER BY key");
    } else {
      rows = await many(`SELECT * FROM ${t} ORDER BY 1`);
    }
    out.tables[t] = rows;
  }
  out.includesMedia = includeMedia;
  return out;
}

// Restores a full backup (with media) into an EMPTY database. Used by scripts/restore.js.
export async function importAll(data) {
  if (data?.format !== 'school-db-backup') throw new Error('not a backup file');
  if (!data.includesMedia) throw new Error('backup has no media; export with ?media=1 for a full restore');
  await tx(async (c) => {
    const existing = await c.query('SELECT (SELECT count(*) FROM boys) + (SELECT count(*) FROM occasions) AS n');
    if (Number(existing.rows[0].n) > 0) throw new Error('target database is not empty');
    await c.query('DELETE FROM categories');
    await c.query('ALTER TABLE telegram_imports DROP CONSTRAINT IF EXISTS telegram_imports_occasion_fk');
    for (const t of TABLES) {
      for (const row of data.tables[t] || []) {
        const r = { ...row };
        if (t === 'media') { r.data = Buffer.from(r.data, 'base64'); r.thumb = Buffer.from(r.thumb, 'base64'); }
        if (t === 'settings' || t === 'telegram_imports') {
          for (const k of ['value', 'raw_json', 'parse_result']) if (k in r && r[k] !== null) r[k] = JSON.stringify(r[k]);
        }
        if (t === 'audit_log' && r.details !== null) r.details = JSON.stringify(r.details);
        const cols = Object.keys(r);
        await c.query(`INSERT INTO ${t} (${cols.map((x) => `"${x}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((k) => r[k]));
      }
      if (!['settings', 'occasion_media'].includes(t)) {
        await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), coalesce((SELECT max(id) FROM ${t}), 0) + 1, false)`);
      }
    }
    await c.query(`ALTER TABLE telegram_imports ADD CONSTRAINT telegram_imports_occasion_fk FOREIGN KEY (occasion_id) REFERENCES occasions(id) ON DELETE SET NULL`);
  });
}
