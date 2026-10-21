import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnouncement } from '../src/telegram/parser.js';

const categories = [
  { id: 1, key: 'shidduch', name: 'שידוך', kind: 'shidduch', sort_order: 10, enabled: true, keywords: ['שידוך', 'אירוסיו'] },
  { id: 3, key: 'wedding', name: 'חתונה', kind: 'wedding', sort_order: 30, enabled: true, keywords: ['חתונה', 'נישואיו'] },
  { id: 4, key: 'birth', name: 'בן זכר', kind: 'birth_boy', sort_order: 40, enabled: true, keywords: ['בן זכר'] },
];
const branches = [
  { id: 'b1', name: 'בארא פארק', keywords: [] }, { id: 'b2', name: 'וויליאמסבורג', keywords: [] },
  { id: 'b3', name: 'מאנסי', keywords: [] }, { id: 'b4', name: 'לייקוואוד', keywords: [] },
];
const parse = (t) => parseAnnouncement(t, { categories, branches, refIso: '2026-10-20' });

test('branch city of the father-in-law does not make the branch ambiguous', () => {
  const r = parse('מזל טוב צו הבחור שמואל ווייס ני"ו פון מאנסי צו זיין שידוך מיט די טאכטער פון ר\' יעקב קליין פון לייקוואוד');
  assert.equal(r.boyName, 'שמואל ווייס');
  assert.equal(r.fatherInLaw, 'יעקב קליין');
  assert.equal(r.residence, 'לייקוואוד');
  assert.equal(r.branchId, 'b3');
});

test('bride and baby names are never extracted', () => {
  const s = parse('מזל טוב! הבה"ח יואל פריעדמאן ני"ו לרגל אירוסיו עב"ג המהוללה מרת שרה תחי\' בת ר\' אברהם גרין');
  assert.ok(!JSON.stringify(s).includes('שרה'));
  const b = parse('מזל טוב! ביי ידידנו ר\' אהרן שווארץ ני"ו איז געבוירן געווארן א בן זכר ושמו בישראל מנחם מענדל');
  assert.equal(b.category.kind, 'birth_boy');
  assert.equal(b.boyName, 'אהרן שווארץ');
  assert.ok(!JSON.stringify(b).includes('מנחם'));
  assert.equal(b.fatherInLaw, null);
});

test('structured posts and unrelated posts', () => {
  const s = parse('קאטעגאריע: חתונה\nנאמען: דוד הערש\nסניף: לייקוואוד\nשווער: ר\' משה לוי\nדאטום: כ"ה חשון תשפ"ז');
  assert.equal(s.recognized, true);
  assert.equal(s.branchId, 'b4');
  assert.deepEqual([s.hebDate.day, s.hebDate.month, s.hebDate.year], [25, 8, 5787]);
  assert.equal(parse('היינט איז דא א שיעור').recognized, false);
});
