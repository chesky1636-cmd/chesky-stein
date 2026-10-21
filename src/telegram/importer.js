// Turns incoming Telegram updates into published occasion records.
// - Every Telegram message is stored once (UNIQUE chat_id+message_id), so webhook retries are harmless.
// - Recognised announcements are published automatically (no approval step).
// - A repeat announcement from a different message is imported and published too, but it is linked to
//   the same boy, so the shidduch statistics (distinct boys) never double count.
// - The original text and JSON are preserved for administrators.
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { branches, isBranch } from '../branches.js';
import { getSetting, setSetting } from '../settings.js';
import { isAfterSunset, nowInSchoolTz, isoFromHebrew, parseIsoDate } from '../hebrew.js';
import { storeImage } from '../media.js';
import { allCategories } from '../repo/categories.js';
import { findBoyMatches, createBoy, addAlias } from '../repo/boys.js';
import { createOccasion, addOccasionMedia } from '../repo/occasions.js';
import { generatedText } from '../privacy.js';
import { parseAnnouncement } from './parser.js';
import { downloadFile } from './client.js';

export function allowedChatIds() {
  const s = String(getSetting('telegram_source_chat_ids') || config.telegram.sourceChatIds || '');
  return s.split(/[,\s]+/).filter(Boolean).map(String);
}

function messageOf(update) {
  if (update.channel_post) return { msg: update.channel_post, edited: false };
  if (update.edited_channel_post) return { msg: update.edited_channel_post, edited: true };
  if (update.message) return { msg: update.message, edited: false };
  if (update.edited_message) return { msg: update.edited_message, edited: true };
  return { msg: null };
}

async function recordStatus(patch) {
  const prev = getSetting('telegram_status') || {};
  await setSetting('telegram_status', { ...prev, ...patch });
}

function largestPhotoId(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return [...msg.photo].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0].file_id;
  }
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document.file_id;
  return null;
}

async function fetchPicture(msg) {
  const fileId = largestPhotoId(msg);
  if (!fileId) return { mediaId: null };
  try {
    const buf = await downloadFile(fileId);
    return { mediaId: await storeImage(buf, 'telegram') };
  } catch (err) {
    return { mediaId: null, error: `בילד: ${err.message}` };
  }
}

// Decide the civil + Jewish date of the occasion.
function resolveDate(parsed, msgDate) {
  const msgIso = nowInSchoolTz(msgDate);
  if (parsed.hebDate) {
    let { year, month, day, explicitYear } = parsed.hebDate;
    let iso = isoFromHebrew(year, month, day);
    // A date written without a year that lies more than ~6 months in the past means next year.
    if (iso && !explicitYear && (parseIsoDate(msgIso) - parseIsoDate(iso)) / 864e5 > 180) iso = isoFromHebrew(year + 1, month, day) || iso;
    if (iso) return { gregDate: iso, afterSunset: false };
  }
  if (parsed.gregDate) return { gregDate: parsed.gregDate, afterSunset: false };
  // Otherwise the occasion took place when it was announced; after sunset it is the next Jewish day.
  return { gregDate: msgIso, afterSunset: isAfterSunset(msgDate) };
}

// Find or create the boy. Never creates a second profile when a match is reliable.
async function resolveBoy(parsed, c) {
  const branchHint = parsed.branchId;
  const { exact, similar } = await findBoyMatches(parsed.boyName, branchHint);
  const notes = [];
  const inBranch = (list) => (branchHint ? list.filter((b) => b.branch === branchHint) : list);
  if (exact.length) {
    const pick = inBranch(exact).length ? inBranch(exact) : exact;
    if (pick.length > 1) notes.push('עטלעכע בחורים מיט דעם זעלבן נאמען – ביטע באשטעטיגט דעם ריכטיגן');
    return { boyId: pick[0].id, branch: pick[0].branch, notes };
  }
  const spelling = similar.filter((s) => s.via === 'spelling');
  const spellPick = inBranch(spelling).length ? inBranch(spelling) : spelling;
  if (spellPick.length === 1) {
    await addAlias(spellPick[0].id, parsed.boyName, c);
    notes.push(`פארבונדן לויט ענליכן אויסלייג מיט "${spellPick[0].official_name}"`);
    return { boyId: spellPick[0].id, branch: spellPick[0].branch, notes };
  }
  if (!branchHint) return { boyId: null, notes: ['נייער בחור אבער דער סניף איז נישט דערקענט'] };
  const boyId = await createBoy({ name: parsed.boyName, branch: branchHint, aliases: parsed.aliases || [] }, c);
  if (similar.length) notes.push(`מעגליך א דופליקאט פון: ${similar.slice(0, 3).map((s) => s.official_name).join(', ')}`);
  return { boyId, branch: branchHint, notes, created: true };
}

export async function handleUpdate(update) {
  const { msg, edited } = messageOf(update || {});
  if (!msg || !msg.chat) return { status: 'skipped' };
  const chatId = String(msg.chat.id);
  const text = String(msg.text || msg.caption || '');
  const msgDate = new Date((msg.edit_date || msg.date || Date.now() / 1000) * 1000);
  await recordStatus({ lastUpdateAt: new Date().toISOString(), lastChatId: chatId, lastChatTitle: msg.chat.title || '' });

  // Our own outgoing posts come back as channel posts; never import them.
  const echo = await one('SELECT id FROM telegram_outbox WHERE chat_id = $1 AND telegram_message_id = $2', [chatId, msg.message_id]);

  if (edited) {
    const existing = await one('SELECT * FROM telegram_imports WHERE chat_id=$1 AND message_id=$2', [chatId, msg.message_id]);
    if (existing) {
      await query(`UPDATE telegram_imports SET raw_text=$2, raw_json=$3, edit_count=edit_count+1, processed_at=now() WHERE id=$1`,
        [existing.id, text, JSON.stringify(msg)]);
      // Re-process only if nothing was published yet and no administrator corrected it.
      if (existing.occasion_id || existing.status === 'corrected' || existing.status === 'echo') return { status: 'edited', importId: existing.id };
      await query('DELETE FROM telegram_imports WHERE id=$1', [existing.id]);
    }
  }

  const allowed = allowedChatIds();
  let status = null, error = null;
  if (echo) status = 'echo';
  else if (!allowed.includes(chatId)) { status = 'ignored'; error = `דער טשאט ${chatId} איז נישט אין דער ליסטע פון ערלויבטע מקורות`; }

  const inserted = await one(
    `INSERT INTO telegram_imports (update_id, chat_id, chat_title, message_id, media_group_id, message_date, raw_text, raw_json, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (chat_id, message_id) DO NOTHING RETURNING id`,
    [update.update_id ?? null, chatId, msg.chat.title || null, msg.message_id, msg.media_group_id || null, msgDate, text,
      JSON.stringify(msg), status || 'needs_review', error]);
  if (!inserted) return { status: 'duplicate_delivery' };
  const importId = inserted.id;
  if (status) return { status, importId };

  try {
    const pic = await fetchPicture(msg);
    const notes = pic.error ? [pic.error] : [];

    // Album item without its own caption: attach the picture to the album's occasion (if any).
    if (msg.media_group_id && !text.trim()) {
      const sib = await one(
        `SELECT occasion_id FROM telegram_imports WHERE media_group_id=$1 AND chat_id=$2 AND id<>$3 AND occasion_id IS NOT NULL LIMIT 1`,
        [msg.media_group_id, chatId, importId]);
      if (sib && pic.mediaId && getSetting('telegram_publish_pictures') !== false) await addOccasionMedia(sib.occasion_id, pic.mediaId);
      await query(`UPDATE telegram_imports SET status=$2, occasion_id=$3, parse_result=$4, processed_at=now() WHERE id=$1`,
        [importId, sib ? 'recognized' : 'needs_review', sib?.occasion_id || null, JSON.stringify({ album: true, mediaId: pic.mediaId, notes })]);
      return { status: sib ? 'recognized' : 'needs_review', importId, occasionId: sib?.occasion_id };
    }

    const parsed = parseAnnouncement(text, { categories: allCategories(), branches: branches(), refIso: nowInSchoolTz(msgDate) });
    const result = { ...parsed, mediaId: pic.mediaId, notes };
    if (!parsed.recognized) {
      await query(`UPDATE telegram_imports SET status='needs_review', parse_result=$2, processed_at=now() WHERE id=$1`, [importId, JSON.stringify(result)]);
      return { status: 'needs_review', importId, reasons: parsed.reasons };
    }

    const outcome = await tx(async (c) => {
      const boy = await resolveBoy(parsed, c);
      result.notes.push(...boy.notes);
      if (!boy.boyId) return { status: 'needs_review' };
      const branch = isBranch(parsed.branchId) ? parsed.branchId : boy.branch;
      const date = resolveDate(parsed, msgDate);
      const boyName = (await c.query('SELECT official_name FROM boys WHERE id=$1', [boy.boyId])).rows[0].official_name;
      const family = { fatherInLaw: parsed.fatherInLaw, residence: parsed.residence };
      const autoPublish = getSetting('telegram_auto_publish') !== false;
      const occasionId = await createOccasion({
        boyId: boy.boyId, branch, categoryId: parsed.category.id, gregDate: date.gregDate, afterSunset: date.afterSunset,
        fatherInLaw: parsed.fatherInLaw, residence: parsed.residence, showFamily: true,
        // The public text is generated from the recognised fields, never copied from the raw post,
        // so that names of the bride or baby that appear in the post are not published.
        announcementText: generatedText(parsed.category.kind, boyName, family),
        status: autoPublish ? 'published' : 'hidden',
      }, { source: 'telegram', importId, by: 'telegram', needsReview: result.notes.length > 0, reviewNote: result.notes.join(' · ') || null, db: c });
      const media = [pic.mediaId];
      // Pictures of earlier album items that arrived before the caption.
      if (msg.media_group_id) {
        const earlier = await c.query(`SELECT id, parse_result FROM telegram_imports WHERE media_group_id=$1 AND chat_id=$2 AND id<>$3`, [msg.media_group_id, chatId, importId]);
        for (const e of earlier.rows) {
          media.push(e.parse_result?.mediaId);
          await c.query(`UPDATE telegram_imports SET status='recognized', occasion_id=$2 WHERE id=$1`, [e.id, occasionId]);
        }
      }
      if (getSetting('telegram_publish_pictures') !== false) {
        for (const m of media.filter(Boolean)) await addOccasionMedia(occasionId, m, c);
      }
      await c.query(`UPDATE telegram_imports SET status='recognized', occasion_id=$2, parse_result=$3, processed_at=now() WHERE id=$1`,
        [importId, occasionId, JSON.stringify(result)]);
      return { status: 'recognized', occasionId };
    });
    if (outcome.status !== 'recognized') {
      await query(`UPDATE telegram_imports SET status='needs_review', parse_result=$2, processed_at=now() WHERE id=$1`, [importId, JSON.stringify(result)]);
    }
    return { ...outcome, importId };
  } catch (err) {
    console.error('[telegram] import failed', err);
    await query(`UPDATE telegram_imports SET status='error', error=$2, processed_at=now() WHERE id=$1`, [importId, String(err.message).slice(0, 500)]);
    await recordStatus({ lastError: String(err.message).slice(0, 300), lastErrorAt: new Date().toISOString() });
    return { status: 'error', importId, error: err.message };
  }
}

// Re-run recognition on a stored import (after an administrator changed keywords or settings).
export async function reprocessImport(id) {
  const imp = await one('SELECT * FROM telegram_imports WHERE id=$1', [id]);
  if (!imp) throw new Error('נישט געפונען');
  if (imp.occasion_id) throw new Error('דער אימפארט איז שוין פארבונדן מיט א רעקארד');
  await query('DELETE FROM telegram_imports WHERE id=$1', [id]);
  const msg = imp.raw_json;
  const update = { update_id: imp.update_id, [msg.chat?.type === 'channel' ? 'channel_post' : 'message']: msg };
  return handleUpdate(update);
}
