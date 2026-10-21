// The ONLY place where database rows are turned into publicly visible data. Every public page,
// search result, calendar entry and public API response goes through these whitelisting functions.
//
// Privacy rules enforced here:
//  - A wife's name or picture is never stored in a dedicated field and never output.
//  - A baby's name is never output: birth records always render a fixed text ("had a baby boy" + date),
//    the stored announcement text and the record's pictures are suppressed.
//  - Upsheren records do not show the child's name either (fixed text, no family details).
//  - Wife's father / residence are shown only for shidduch, tenaim and wedding records, and only when
//    the record's show_family flag permits it.
import { branchName } from './branches.js';
import { gregText, weekdayName } from './hebrew.js';

export const FAMILY_KINDS = new Set(['shidduch', 'tenaim', 'wedding']);
export const FIXED_TEXT_KINDS = new Set(['birth_boy', 'upsheren']);

export const mediaUrl = (id) => (id ? `/media/${id}.webp` : null);
export const thumbUrl = (id) => (id ? `/media/${id}/thumb.webp` : null);

export function generatedText(kind, boyName, family) {
  const fam = family && (family.fatherInLaw || family.residence)
    ? ` ${family.fatherInLaw ? `מיט דער טאכטער פון ${family.fatherInLaw}` : ''}${family.residence ? ` פון ${family.residence}` : ''}`.replace(/\s+/g, ' ')
    : '';
  switch (kind) {
    case 'shidduch': return `מזל טוב! דער בחור ${boyName} איז געווארן א חתן${fam}.`;
    case 'tenaim': return `מזל טוב צו די תנאים פון ${boyName}${fam}.`;
    case 'wedding': return `מזל טוב צו דער חתונה פון ${boyName}${fam}.`;
    case 'birth_boy': return `מזל טוב! ${boyName} האט געהאט א בן זכר.`;
    case 'upsheren': return `מזל טוב צום אפשערן ביי ${boyName}.`;
    default: return `מזל טוב צו דער שמחה ביי ${boyName}.`;
  }
}

function familyOf(row) {
  if (!FAMILY_KINDS.has(row.cat_kind) || !row.show_family) return null;
  const f = {
    fatherInLaw: row.father_in_law_name || null,
    residence: row.residence || null,
    details: row.family_details || null,
  };
  return f.fatherInLaw || f.residence || f.details ? f : null;
}

export function publicOccasion(row, todayIso) {
  const kind = row.cat_kind;
  const family = familyOf(row);
  const text = FIXED_TEXT_KINDS.has(kind)
    ? generatedText(kind, row.boy_name)
    : (row.announcement_text && row.announcement_text.trim()) || generatedText(kind, row.boy_name, family);
  const pictures = kind === 'birth_boy' ? [] : (row.media_ids || []).filter(Boolean).map((id) => ({ url: mediaUrl(id), thumb: thumbUrl(id) }));
  return {
    id: row.id,
    url: `/occasion/${row.id}`,
    boy: { id: row.boy_id, name: row.boy_name, url: `/boy/${row.boy_id}`, photo: thumbUrl(row.boy_photo) },
    branch: { id: row.branch, name: branchName(row.branch), url: `/branch/${row.branch}` },
    category: { key: row.cat_key, name: row.cat_name, kind },
    date: {
      iso: row.greg_date, greg: gregText(row.greg_date), weekday: weekdayName(row.greg_date),
      hebrew: row.heb_date_text, afterSunset: !!row.after_sunset,
      upcoming: todayIso ? row.greg_date > todayIso : false, today: todayIso ? row.greg_date === todayIso : false,
    },
    text,
    family: family ? { fatherInLaw: family.fatherInLaw, residence: family.residence, details: family.details } : null,
    pictures,
  };
}

export function publicBoy(row) {
  return {
    id: row.id,
    name: row.official_name,
    url: `/boy/${row.id}`,
    photo: mediaUrl(row.photo_media_id),
    thumb: thumbUrl(row.photo_media_id),
    branch: { id: row.branch, name: branchName(row.branch), url: `/branch/${row.branch}` },
    occasionCount: row.occasion_count != null ? Number(row.occasion_count) : undefined,
  };
}

export function publicAnnouncement(row) {
  return {
    id: row.id,
    url: `/announcement/${row.id}`,
    title: row.title,
    body: row.body,
    branch: row.branch ? { id: row.branch, name: branchName(row.branch), url: `/branch/${row.branch}` } : null,
    featured: row.featured,
    eventDate: row.event_date ? { iso: row.event_date, greg: gregText(row.event_date) } : null,
    picture: row.media_id ? { url: mediaUrl(row.media_id), thumb: thumbUrl(row.media_id) } : null,
    createdAt: row.created_at,
  };
}
