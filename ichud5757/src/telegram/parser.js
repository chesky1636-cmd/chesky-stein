// Recognises school announcements in Telegram posts (Yiddish / Hebrew).
//
// Two formats are supported:
//  1. Structured posts with labelled lines, e.g.
//        קאטעגאריע: שידוך
//        נאמען: יואל משה פריעדמאן
//        סניף: סניף א׳
//        שווער: ר׳ אברהם גרין
//        וואוינונג: וויליאמסבורג
//        דאטום: כ״ה תשרי תשפ״ז
//  2. Free-text "מזל טוב" posts, from which the category, the boy's name, the wife's father and the
//     residence are extracted with keyword rules.
//
// Privacy: the parser never extracts a wife's name or a baby's name. Only the text that follows the
// "daughter of" marker is read for the wife's father; text about the bride or the baby is ignored.
import { stripNiqqud, textKey } from '../names.js';
import { parseHebrewDate, parseGregDate } from '../hebrew.js';

const KIND_PRIORITY = ['birth_boy', 'upsheren', 'tenaim', 'wedding', 'shidduch', 'other'];

const LABELS = {
  name: /^(נאמען|שם הבחור|שם|בחור|החתן|חתן|תלמיד)$/,
  aliases: /^(אנדערע נעמען|אויך באקאנט|כינוי)$/,
  branch: /^(סניף|צווייג)$/,
  category: /^(קאטעגאריע|קאטעגאריא|סוג|שמחה)$/,
  date: /^(דאטום|תאריך|טאג)$/,
  fatherInLaw: /^(שווער|מחותן|אבי הכלה|טאכטער פון|בת פון)$/,
  residence: /^(וואוינונג|וואוינט|מקום|שטאט|עיר|ישוב)$/,
};

const STOP = new Set([
  'ני"ו', 'נ"י', 'הי"ו', 'שיחי\'', 'שיחי', 'שליט"א', 'נרו', 'יצ"ו', 'פון', 'לרגל', 'צו', 'צום', 'מיט', 'עב"ג', 'עם', 'בן', 'בבן',
  'וב"ב', 'ובני', 'לאירוסיו', 'לנישואיו', 'להולדת', 'בהולדת', 'איז', 'האט', 'זיין', 'זיינע', 'די', 'דער', 'ביום', 'אויף', 'אין', 'סניף',
  'בשעה', 'טובה', 'ומוצלחת', 'בשעטו"מ', 'בשטומ"צ', 'לבחור', 'אונזער', 'אונזערע', 'תלמיד', 'מסניף', 'ובנו', 'וזוגתו', 'עכ"ג',
  'בת', 'בתו', 'המהוללה', 'הכלה', 'כלה', 'החתונה', 'ווארט', 'שידוך', 'תנאים', 'אפשערן', 'חתונה', 'מזל', 'טוב', 'געווארן', 'א', 'אן',
  'וואס', 'ווען', 'ביי', 'נולד', 'לו', 'נתברך', 'בבן', 'זכר', 'פארלאבט', 'פארקנסט', 'דורך', 'ב"ה', 'בס"ד', 'ער', 'זי',
]);
const HONOR = new Set(['הבה"ח', 'הבחור', 'בחור', 'החתן', 'חתן', 'החשוב', 'המופלג', 'היקר', 'הנעלה', 'המצוין', 'המצויין', 'ר\'', 'רבי',
  'הרה"ח', 'הרב', 'הר"ר', 'מו"ה', 'הרה"ג', 'הרה"צ', 'כמר', 'הת\'', 'התלמיד', 'תלמידנו', 'ידידנו', 'הב\'', 'הנכבד', 'הוו"ח', 'הרבני',
  'אי"א', 'כש"ת', 'החתן החשוב', 'בחורינו', 'לידידנו', 'לתלמידנו', 'להבה"ח', 'להבחור', 'לבחור', 'לר\'']);

function normalize(text) {
  return stripNiqqud(text)
    .replace(/[״”“„]/g, '"').replace(/[׳’‘`]/g, "'")
    .replace(/[*_~]/g, ' ').replace(/[‎‏‪-‮]/g, '')
    .replace(/[ \t]+/g, ' ');
}

function hasKeyword(textK, kw) {
  const k = textKey(kw);
  return k.length >= 2 && textK.includes(k);
}

export function detectCategory(text, categories) {
  const textK = ` ${textKey(text)} `;
  const enabled = categories.filter((c) => c.enabled);
  const ordered = [...enabled].sort((a, b) => {
    // custom categories (non-system keys) are checked before the generic system category of the same kind
    const pa = KIND_PRIORITY.indexOf(a.kind), pb = KIND_PRIORITY.indexOf(b.kind);
    if (a.kind === 'other' && b.kind === 'other') return (a.key === 'other') - (b.key === 'other');
    return pa - pb || a.sort_order - b.sort_order;
  });
  for (const c of ordered) {
    const words = [c.name, ...(c.keywords || [])];
    if (words.some((w) => hasKeyword(textK, w))) return c;
  }
  return null;
}

export function detectBranch(text, branches) {
  const textK = ` ${textKey(text)} `;
  const hits = branches.filter((b) => [b.name, ...(b.keywords || [])].some((w) => w && textKey(w).length >= 2 && textK.includes(` ${textKey(w)} `)));
  return hits.length === 1 ? hits[0].id : null;
}

const WORD = /^[א-ת][א-ת"'-]*$/;

// Read a name starting at token index i: skip honorifics, then take 2-5 name words until a stop word.
function readName(tokens, i, { min = 2, max = 5 } = {}) {
  while (i < tokens.length && HONOR.has(tokens[i])) i++;
  const words = [];
  for (; i < tokens.length && words.length < max; i++) {
    const t = tokens[i];
    if (t === '\n' || STOP.has(t) || !WORD.test(t) || HONOR.has(t)) break;
    words.push(t);
  }
  return words.length >= min ? { name: words.join(' '), end: i } : null;
}

function tokenize(line) {
  return line.replace(/([,.;:!?()[\]{}–—])/g, ' \n ').split(/\s+/).filter(Boolean);
}

const NAME_MARKERS = ['הבה"ח', 'הבחור', 'החתן', 'בחור', 'חתן', 'ידידנו', 'תלמידנו', 'לידידנו', 'לתלמידנו', 'להבה"ח', 'להבחור', 'לבחור', 'הת\'', 'התלמיד', 'הב\'', 'בחורינו'];
const FIL_MARKERS = [['מיט', 'די', 'טאכטער', 'פון'], ['מיט', 'דער', 'טאכטער', 'פון'], ['טאכטער', 'פון'], ['בתו', 'של'], ['בת']];

function findSeq(tokens, seq, from = 0) {
  for (let i = from; i <= tokens.length - seq.length; i++) {
    if (seq.every((s, k) => tokens[i + k] === s)) return i;
  }
  return -1;
}

function readResidence(tokens, i) {
  while (i < tokens.length && ['ני"ו', 'נ"י', 'הי"ו', 'שליט"א', 'שיחי\'', 'שיחי', 'יצ"ו'].includes(tokens[i])) i++;
  const t = tokens[i];
  if (!t) return null;
  if (t === 'פון' || t === 'מעיר' || t === 'מעיה"ק') {
    const w = [];
    for (let k = i + 1; k < tokens.length && w.length < 3; k++) {
      if (tokens[k] === '\n' || STOP.has(tokens[k]) || !WORD.test(tokens[k])) break;
      w.push(tokens[k]);
    }
    return w.length ? w.join(' ') : null;
  }
  // Hebrew "from" prefix: מוויליאמסבורג, מבני ברק
  if (/^מ[א-ת]{3,}$/.test(t) && !STOP.has(t)) {
    const w = [t.slice(1)];
    if (tokens[i + 1] && /^[א-ת]{2,}$/.test(tokens[i + 1]) && !STOP.has(tokens[i + 1]) && ['ברק', 'פארק', 'יארק', 'שמש', 'עלית', 'ביתר', 'אילית'].includes(tokens[i + 1])) w.push(tokens[i + 1]);
    return w.join(' ');
  }
  return null;
}

export function extractFreeText(text) {
  const tokens = [];
  for (const line of text.split('\n')) { tokens.push(...tokenize(line), '\n'); }
  let boy = null;
  for (let i = 0; i < tokens.length && !boy; i++) {
    if (NAME_MARKERS.includes(tokens[i])) boy = readName(tokens, i + 1);
  }
  if (!boy) {
    // Fallback: "מזל טוב [צו] [ר'] NAME"
    for (let i = 0; i < tokens.length - 2 && !boy; i++) {
      if (tokens[i] === 'מזל' && tokens[i + 1] === 'טוב') {
        let j = i + 2;
        while (tokens[j] === '\n' || tokens[j] === 'צו' || tokens[j] === 'פאר' || tokens[j] === '!') j++;
        boy = readName(tokens, j);
      }
    }
  }
  let fatherInLaw = null, residence = null;
  for (const seq of FIL_MARKERS) {
    const at = findSeq(tokens, seq, boy ? boy.end : 0);
    if (at < 0) continue;
    const r = readName(tokens, at + seq.length, { min: 1, max: 4 });
    if (r) {
      fatherInLaw = r.name;
      residence = readResidence(tokens, r.end);
      break;
    }
  }
  return { boyName: boy?.name || null, fatherInLaw, residence };
}

export function extractStructured(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const m = /^\s*([^:：]{1,20})\s*[:：]\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const label = m[1].trim();
    for (const [field, re] of Object.entries(LABELS)) {
      if (re.test(label) && !out[field]) out[field] = m[2].trim();
    }
  }
  return out;
}

function cleanPersonName(s) {
  if (!s) return null;
  const words = normalize(s).split(/\s+/).filter((w) => w && !HONOR.has(w) && !['ני"ו', 'נ"י', 'הי"ו', 'שליט"א', 'שיחי\''].includes(w));
  const v = words.join(' ').replace(/[^א-ת"' -]/g, '').trim();
  return v.length >= 2 ? v.slice(0, 120) : null;
}

// Main entry point. Returns a plain object describing what was recognised and why.
export function parseAnnouncement(rawText, { categories, branches, refIso }) {
  const text = normalize(rawText || '');
  const reasons = [];
  const s = extractStructured(text);
  const structured = !!(s.name && (s.category || s.branch));
  let category = null, boyName, fatherInLaw, residence, branchId = null, aliases = [];
  if (structured) {
    category = detectCategory(s.category || text, categories);
    boyName = cleanPersonName(s.name);
    fatherInLaw = cleanPersonName(s.fatherInLaw);
    residence = s.residence ? s.residence.replace(/[^א-ת"' -]/g, '').trim().slice(0, 120) || null : null;
    branchId = s.branch ? detectBranch(` ${s.branch} `, branches) : null;
    aliases = s.aliases ? s.aliases.split(/[,،]/).map(cleanPersonName).filter(Boolean) : [];
  } else {
    category = detectCategory(text, categories);
    const f = extractFreeText(text);
    boyName = cleanPersonName(f.boyName);
    fatherInLaw = cleanPersonName(f.fatherInLaw);
    residence = f.residence;
  }
  if (!branchId) branchId = detectBranch(text, branches);
  // A city in the father-in-law's residence may also be a branch name; ignore it when ambiguous.
  if (!branchId && residence) branchId = detectBranch(text.split(residence).join(' '), branches);
  const dateText = s.date || text;
  const hebDate = parseHebrewDate(dateText, refIso);
  const gregDate = hebDate ? null : parseGregDate(dateText);

  if (!category) reasons.push('קיין קאטעגאריע נישט דערקענט');
  if (!boyName) reasons.push('דעם בחורס נאמען נישט דערקענט');
  // Privacy: for births and upsheren never keep family details, even if something was extracted.
  if (category && !['shidduch', 'tenaim', 'wedding'].includes(category.kind)) { fatherInLaw = null; residence = null; }
  return {
    structured,
    category: category ? { id: category.id, key: category.key, kind: category.kind, name: category.name } : null,
    boyName, aliases, fatherInLaw, residence, branchId,
    hebDate, gregDate,
    recognized: !!(category && boyName),
    reasons,
  };
}
