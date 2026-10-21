// The four school branches are fixed here. No code path can add a fifth one; the database also
// enforces this with CHECK constraints. A super administrator may change the display name,
// description and Telegram recognition keywords of each branch (stored in settings), but the
// set of branches itself never changes.
import { getSetting } from './settings.js';

export const BRANCH_IDS = ['b1', 'b2', 'b3', 'b4'];

const DEFAULTS = {
  b1: { slug: 'b1', name: 'סניף א׳', description: '', keywords: [] },
  b2: { slug: 'b2', name: 'סניף ב׳', description: '', keywords: [] },
  b3: { slug: 'b3', name: 'סניף ג׳', description: '', keywords: [] },
  b4: { slug: 'b4', name: 'סניף ד׳', description: '', keywords: [] },
};

export function isBranch(id) {
  return BRANCH_IDS.includes(id);
}

export function branches() {
  const overrides = getSetting('branches') || {};
  return BRANCH_IDS.map((id) => ({ ...DEFAULTS[id], ...(overrides[id] || {}), id, slug: id }));
}

export function branch(id) {
  return branches().find((b) => b.id === id) || null;
}

export function branchName(id) {
  return branch(id)?.name || '';
}
