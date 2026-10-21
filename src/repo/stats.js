import { many } from '../db.js';
import { BRANCH_IDS } from '../branches.js';
import { HDate } from '@hebcal/core';
import { today } from '../hebrew.js';

// Shidduch statistics: every boy is counted ONCE, no matter how many announcements, duplicate
// Telegram imports, tena'im or wedding records point at him. Computed live from the database, so
// additions, corrections and deletions are reflected immediately.
export async function shidduchStats() {
  const hebYear = today().hebrew?.year || new HDate().getFullYear();
  const rows = await many(
    `SELECT b.branch,
            count(DISTINCT b.id)::int AS total,
            count(DISTINCT b.id) FILTER (WHERE o.heb_year = $1)::int AS this_year
     FROM occasions o
     JOIN categories c ON c.id = o.category_id
     JOIN boys b ON b.id = o.boy_id
     WHERE o.deleted_at IS NULL AND o.status = 'published' AND c.enabled AND c.counts_for_shidduch
       AND b.deleted_at IS NULL AND b.merged_into IS NULL
     GROUP BY b.branch`, [hebYear]);
  const byBranch = Object.fromEntries(BRANCH_IDS.map((id) => [id, { total: 0, thisYear: 0 }]));
  for (const r of rows) byBranch[r.branch] = { total: r.total, thisYear: r.this_year };
  const total = Object.values(byBranch).reduce((s, x) => s + x.total, 0);
  const thisYear = Object.values(byBranch).reduce((s, x) => s + x.thisYear, 0);
  return { byBranch, total, thisYear, hebYear };
}

export async function categoryCounts(branch = null) {
  const rows = await many(
    `SELECT c.key, count(*)::int AS n FROM occasions o JOIN categories c ON c.id = o.category_id JOIN boys b ON b.id = o.boy_id
     WHERE o.deleted_at IS NULL AND o.status='published' AND c.enabled AND b.deleted_at IS NULL
       AND ($1::text IS NULL OR o.branch = $1) GROUP BY c.key`, [branch]);
  return Object.fromEntries(rows.map((r) => [r.key, r.n]));
}
