import { many, one, query, tx } from '../db.js';
import { isBranch } from '../branches.js';
import { nameKey, nameSkel, similarity, textKey, textSkel } from '../names.js';

export class ValidationError extends Error {}

function cleanName(s) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  if (v.length < 2 || v.length > 120) throw new ValidationError('א נאמען מוז זיין צווישן 2 און 120 אותיות');
  if (/[a-zA-Z<>]/.test(v)) throw new ValidationError('א נאמען מוז זיין געשריבן אין אידישע אותיות');
  if (!nameKey(v)) throw new ValidationError('דער נאמען איז נישט גילטיג');
  return v;
}

export async function refreshBoySearch(boyId, db = { query }) {
  const r = await db.query(
    `SELECT b.official_name, coalesce(string_agg(a.alias, ' '), '') AS aliases
     FROM boys b LEFT JOIN boy_aliases a ON a.boy_id = b.id WHERE b.id = $1 GROUP BY b.id`, [boyId]);
  if (!r.rows[0]) return;
  const all = `${r.rows[0].official_name} ${r.rows[0].aliases}`;
  await db.query('UPDATE boys SET search_key = $2 WHERE id = $1', [boyId, ` ${textKey(all)} | ${textSkel(all)} `]);
}

export async function createBoy({ name, branch, aliases = [], photoMediaId = null, notes = null }, db = null) {
  name = cleanName(name);
  if (!isBranch(branch)) throw new ValidationError('ביטע קלייבט א סניף');
  const run = async (c) => {
    const r = await c.query(
      `INSERT INTO boys (official_name, name_key, name_skel, branch, photo_media_id, admin_notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, nameKey(name), nameSkel(name), branch, photoMediaId, notes],
    );
    const id = r.rows[0].id;
    for (const a of aliases) await addAlias(id, a, c).catch(() => {});
    await refreshBoySearch(id, c);
    return id;
  };
  return db ? run(db) : tx(run);
}

export async function updateBoy(id, { name, branch, notes }) {
  name = cleanName(name);
  if (!isBranch(branch)) throw new ValidationError('ביטע קלייבט א סניף');
  await query(
    `UPDATE boys SET official_name=$2, name_key=$3, name_skel=$4, branch=$5, admin_notes=$6, updated_at=now() WHERE id=$1`,
    [id, name, nameKey(name), nameSkel(name), branch, notes || null],
  );
  await refreshBoySearch(id);
}

export async function addAlias(boyId, alias, db = { query }) {
  alias = cleanName(alias);
  const key = nameKey(alias);
  const boy = (await db.query('SELECT name_key FROM boys WHERE id=$1', [boyId])).rows[0];
  if (!boy || boy.name_key === key) return;
  await db.query(
    'INSERT INTO boy_aliases (boy_id, alias, alias_key) VALUES ($1,$2,$3) ON CONFLICT (boy_id, alias_key) DO NOTHING',
    [boyId, alias, key],
  );
  await refreshBoySearch(boyId, db);
}

export async function removeAlias(boyId, aliasId) {
  await query('DELETE FROM boy_aliases WHERE id=$1 AND boy_id=$2', [aliasId, boyId]);
  await refreshBoySearch(boyId);
}

export async function setBoyPhoto(boyId, mediaId) {
  await query('UPDATE boys SET photo_media_id=$2, updated_at=now() WHERE id=$1', [boyId, mediaId]);
}

export async function getBoy(id) {
  return one('SELECT * FROM boys WHERE id = $1', [id]);
}

export async function getAliases(boyId) {
  return many('SELECT id, alias FROM boy_aliases WHERE boy_id=$1 ORDER BY alias', [boyId]);
}

const ACTIVE = 'b.deleted_at IS NULL AND b.merged_into IS NULL';

// Find existing boys that may be the same person as `name`.
// Returns {exact: [...], similar: [...]}, each item {id, official_name, branch, score, via}.
export async function findBoyMatches(name, branch = null) {
  const key = nameKey(name), skel = nameSkel(name);
  if (!key) return { exact: [], similar: [] };
  const exact = await many(
    `SELECT DISTINCT b.id, b.official_name, b.branch, 1.0 AS score, 'exact' AS via FROM boys b
     LEFT JOIN boy_aliases a ON a.boy_id = b.id
     WHERE ${ACTIVE} AND (b.name_key = $1 OR a.alias_key = $1)`, [key]);
  const skelRows = await many(
    `SELECT DISTINCT b.id, b.official_name, b.branch, 0.95 AS score, 'spelling' AS via FROM boys b
     WHERE ${ACTIVE} AND b.name_skel = $1 AND NOT b.id = ANY($2::int[])`, [skel, exact.map((e) => e.id)]);
  // Fuzzy candidates: compare against everyone (the data set is small: a school's alumni).
  const seen = new Set([...exact, ...skelRows].map((r) => r.id));
  const others = await many(
    `SELECT b.id, b.official_name, b.branch, coalesce(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
     FROM boys b LEFT JOIN boy_aliases a ON a.boy_id = b.id WHERE ${ACTIVE} GROUP BY b.id`);
  const similar = [...skelRows];
  for (const o of others) {
    if (seen.has(o.id)) continue;
    const score = Math.max(similarity(name, o.official_name), ...o.aliases.map((a) => similarity(name, a)));
    if (score >= 0.72) similar.push({ id: o.id, official_name: o.official_name, branch: o.branch, score, via: 'similar' });
  }
  const byBranch = (a, b) => (branch ? (b.branch === branch) - (a.branch === branch) : 0) || b.score - a.score;
  return { exact: exact.sort(byBranch), similar: similar.sort(byBranch).slice(0, 8) };
}

// Merge `fromId` into `toId`: move occasions and aliases, keep the old name as an alias.
export async function mergeBoys(fromId, toId) {
  if (Number(fromId) === Number(toId)) throw new ValidationError('מען קען נישט צוזאמשטעלן א בחור מיט זיך אליין');
  await tx(async (c) => {
    const from = (await c.query('SELECT * FROM boys WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [fromId])).rows[0];
    const to = (await c.query('SELECT * FROM boys WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [toId])).rows[0];
    if (!from || !to) throw new ValidationError('בחור נישט געפונען');
    await c.query('UPDATE occasions SET boy_id=$2, updated_at=now() WHERE boy_id=$1', [fromId, toId]);
    const aliases = (await c.query('SELECT alias FROM boy_aliases WHERE boy_id=$1', [fromId])).rows.map((r) => r.alias);
    for (const a of [from.official_name, ...aliases]) await addAlias(toId, a, c);
    if (!to.photo_media_id && from.photo_media_id) await c.query('UPDATE boys SET photo_media_id=$2 WHERE id=$1', [toId, from.photo_media_id]);
    await c.query('UPDATE boys SET merged_into=$2, deleted_at=now(), updated_at=now() WHERE id=$1', [fromId, toId]);
    await c.query('UPDATE boys SET merged_into=$2 WHERE merged_into=$1', [fromId, toId]);
    await refreshBoySearch(toId, c);
  });
}

export async function deleteBoy(id) {
  const n = await one('SELECT count(*)::int AS n FROM occasions WHERE boy_id=$1 AND deleted_at IS NULL', [id]);
  if (n.n > 0) throw new ValidationError('דער בחור האט נאך רעקארדס. מעקט זיי אויס אדער פארבינדט זיי צו אן אנדער בחור ערשט.');
  await query('UPDATE boys SET deleted_at=now() WHERE id=$1', [id]);
}

export async function listBoysAdmin({ q = '', branch = '', limit = 50, offset = 0 } = {}) {
  const params = [];
  const where = [ACTIVE];
  if (branch && isBranch(branch)) { params.push(branch); where.push(`b.branch = $${params.length}`); }
  for (const tok of textKey(q).split(' ').filter(Boolean)) {
    params.push(`%${tok}%`);
    if (tok.length >= 4) {
      params.push(`%${textSkel(tok)}%`);
      where.push(`(b.search_key LIKE $${params.length - 1} OR b.search_key LIKE $${params.length})`);
    } else {
      where.push(`b.search_key LIKE $${params.length}`);
    }
  }
  params.push(limit, offset);
  return many(
    `SELECT b.*, (SELECT count(*) FROM occasions o WHERE o.boy_id=b.id AND o.deleted_at IS NULL) AS occasion_count,
            (SELECT string_agg(alias, '، ') FROM boy_aliases a WHERE a.boy_id=b.id) AS alias_list
     FROM boys b WHERE ${where.join(' AND ')} ORDER BY b.official_name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

// Pairs of boys whose names look like the same person (for the super-admin duplicates page).
export async function suspectedDuplicateBoys() {
  const rows = await many(`SELECT b.id, b.official_name, b.branch, b.name_skel FROM boys b WHERE ${ACTIVE} ORDER BY b.id`);
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const score = similarity(rows[i].official_name, rows[j].official_name);
      if (score >= 0.8) pairs.push({ a: rows[i], b: rows[j], score });
    }
    if (pairs.length > 200) break;
  }
  return pairs.sort((x, y) => y.score - x.score);
}
