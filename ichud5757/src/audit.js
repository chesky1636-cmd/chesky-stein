import { query } from './db.js';

export async function audit(req, action, entity, entityId, details) {
  try {
    await query(
      'INSERT INTO audit_log (role, action, entity, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [req?.admin?.role || null, action, entity || null, entityId != null ? String(entityId) : null,
        details ? JSON.stringify(details) : null, req?.ip || null],
    );
  } catch (err) {
    console.error('[audit] failed', err.message);
  }
}
