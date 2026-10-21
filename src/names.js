// Name normalization for matching different spellings of the same boy.
// key  : exact-ish form (no niqqud, no punctuation, unified final letters, no honorifics)
// skel : spelling-tolerant skeleton (also drops the vowel letters א ע ו י ה that vary in Yiddish spelling)

const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const HONORIFICS = new Set([
  'הבחור', 'בחור', 'החתן', 'חתן', 'הבה"ח', 'הבה״ח', 'הב', 'ר', 'רב', 'הרב', 'הר"ר', 'מו"ה', 'הרה"ח', 'הרה"ג', 'הרה"צ',
  'ני"ו', 'נ"י', 'שיחי', 'הי"ו', 'שליט"א', 'נרו', 'תלמידנו', 'ידידנו', 'החשוב', 'היקר', 'המופלג', 'המצויין', 'הנעלה', 'כמר', 'הת\'',
  'התלמיד', 'הבחור החשוב',
]);
const HONORIFICS_BARE = new Set([...HONORIFICS].map((h) => h.replace(/["'״׳]/g, '')));

export function stripNiqqud(s) {
  return String(s || '').replace(/[֑-ׇ]/g, '');
}

function unifyLetters(s) {
  return s
    .replace(/װ/g, 'וו').replace(/ױ/g, 'וי').replace(/ײ/g, 'יי').replace(/ﬞ/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c]);
}

export function nameKey(name) {
  let s = stripNiqqud(name).replace(/[״”“]/g, '"').replace(/[׳’‘`]/g, "'");
  const words = s.split(/[\s,.;:()\-–—_/\\!?]+/).filter(Boolean)
    .filter((w) => !HONORIFICS.has(w) && !HONORIFICS_BARE.has(w.replace(/["'״׳]/g, '')));
  return unifyLetters(words.join(' ').replace(/["'״׳]/g, '')).replace(/[^א-ת0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function nameSkel(name) {
  return nameKey(name).split(' ').map((w) => {
    const core = w.length > 1 ? w[0] + w.slice(1).replace(/[אעויה]/g, '') : w;
    return core.replace(/(.)\1+/g, '$1');
  }).filter(Boolean).join(' ');
}

// Generic text normalization for search (keeps all words).
export function textKey(s) {
  return unifyLetters(stripNiqqud(s).replace(/["'״׳”“’‘`]/g, '')).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function textSkel(s) {
  return textKey(s).split(' ').map((w) => (w.length > 1 ? w[0] + w.slice(1).replace(/[אעויה]/g, '') : w).replace(/(.)\1+/g, '$1')).join(' ');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// 0..1 similarity between two names, tolerant to vowel-letter spelling differences.
export function similarity(a, b) {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const sa = nameSkel(a), sb = nameSkel(b);
  if (sa === sb) return 0.95;
  const d = levenshtein(sa, sb);
  return Math.max(0, 1 - d / Math.max(sa.length, sb.length)) * 0.9;
}
