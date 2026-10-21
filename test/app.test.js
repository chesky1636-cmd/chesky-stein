import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, client, channelPost, postWebhook, addMockPhoto, mockTg } from './helpers.js';

let env, url, pool;
const q = async (sql, p) => (await pool.query(sql, p)).rows;

before(async () => {
  env = await setupEnv();
  url = env.url;
  pool = env.pool;
});
after(async () => env && env.close());

const get = async (path) => { const r = await fetch(url + path); return { status: r.status, body: await r.text() }; };
const getJson = async (path) => (await fetch(url + path)).json();

// ---------------------------------------------------------------- dates
test('Jewish calendar calculations: leap years, Adar I/II, sunset', async () => {
  const h = await import('../src/hebrew.js');
  assert.equal(h.hebrewFromIso('2026-10-20').text, 'ט׳ חשון תשפ״ז');
  assert.equal(h.hebrewFromIso('2026-10-20', true).text, 'י׳ חשון תשפ״ז', 'after sunset is the next Jewish day');
  assert.equal(h.monthGrid(5787, 12).name, 'אדר א׳', '5787 is a leap year');
  assert.equal(h.monthGrid(5786, 12).name, 'אדר', '5786 is not a leap year');
  assert.equal(h.monthGrid(5786, 13).name, 'אדר', 'Adar II is normalised to Adar in a non-leap year');
  assert.deepEqual(h.shiftMonth(5787, 12, 1), { year: 5787, month: 13 });
  assert.deepEqual(h.shiftMonth(5786, 12, 1), { year: 5786, month: 1 });
  assert.deepEqual(h.shiftMonth(5787, 6, 1), { year: 5788, month: 7 }, 'Elul → Tishrei of next year');
  assert.equal(h.isoFromHebrew(5787, 7, 1), '2026-09-12');
  assert.equal(h.isoFromHebrew(5786, 13, 1), null);
  const p = h.parseHebrewDate('ביום כ"ה תשרי תשפ"ז');
  assert.equal(p.day, 25); assert.equal(p.month, 7); assert.equal(p.year, 5787); assert.ok(p.explicitYear);
  // Sunset in New York on 2026-10-20 is around 18:07 local (22:07 UTC)
  assert.equal(h.isAfterSunset(new Date('2026-10-20T21:00:00Z')), false);
  assert.equal(h.isAfterSunset(new Date('2026-10-20T23:30:00Z')), true);
});

test('name matching tolerates Yiddish spelling variants', async () => {
  const n = await import('../src/names.js');
  assert.equal(n.nameSkel('יואל משה פריעדמאן'), n.nameSkel('יואל משה פרידמן'));
  assert.equal(n.nameKey('הבה"ח יואל פריעדמאן ני"ו'), n.nameKey('יואל פריעדמאן'));
  assert.ok(n.similarity('יואל פריעדמאן', 'משה גרין') < 0.6);
});

// ---------------------------------------------------------------- telegram webhook security
test('webhook rejects requests without the secret token', async () => {
  assert.equal(await postWebhook(url, channelPost('מזל טוב'), 'wrong'), 401);
  assert.equal((await q('SELECT count(*)::int AS n FROM telegram_imports'))[0].n, 0);
});

// ---------------------------------------------------------------- import + privacy
let shidduchMsg;
test('recognised shidduch post is imported and auto-published with picture; wife name never public', async () => {
  await q(`INSERT INTO settings (key, value) VALUES ('branches', $1)`, [JSON.stringify({
    b1: { name: 'בארא פארק', keywords: ['בארא פארק'] }, b2: { name: 'וויליאמסבורג', keywords: [] },
    b3: { name: 'מאנסי', keywords: ['מאנסי'] }, b4: { name: 'לאנדאן', keywords: [] },
  })]);
  const { loadSettings } = await import('../src/settings.js');
  await loadSettings();
  await addMockPhoto('photo1');
  shidduchMsg = channelPost(null, {
    caption: 'מזל טוב! הבה"ח יואל משה פריעדמאן ני"ו (בארא פארק) לרגל אירוסיו עב"ג המהוללה מרת שרה תחי\' בת הרה"ח ר\' אברהם גרין שליט"א מוויליאמסבורג',
    photo: [{ file_id: 'photo1s', width: 90, height: 60 }, { file_id: 'photo1', width: 900, height: 600, file_size: 50000 }],
  });
  delete shidduchMsg.channel_post.text;
  assert.equal(await postWebhook(url, shidduchMsg), 200);
  const [imp] = await q('SELECT * FROM telegram_imports');
  assert.equal(imp.status, 'recognized');
  assert.ok(imp.raw_text.includes('שרה'), 'original text preserved for admins');
  const [occ] = await q('SELECT o.*, b.official_name, b.branch AS boy_branch FROM occasions o JOIN boys b ON b.id=o.boy_id');
  assert.equal(occ.official_name, 'יואל משה פריעדמאן');
  assert.equal(occ.branch, 'b1');
  assert.equal(occ.status, 'published');
  assert.equal(occ.source, 'telegram');
  assert.equal(occ.father_in_law_name, 'אברהם גרין');
  assert.equal(occ.residence, 'וויליאמסבורג');
  const media = await q('SELECT * FROM occasion_media WHERE occasion_id=$1', [occ.id]);
  assert.equal(media.length, 1, 'picture downloaded and attached');

  const page = await get(`/occasion/${occ.id}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('אברהם גרין'));
  assert.ok(!page.body.includes('שרה'), 'wife name must not appear');
  const profile = await get(`/boy/${occ.boy_id}`);
  assert.ok(profile.body.includes('יואל משה פריעדמאן') && !profile.body.includes('שרה'));
  const img = await fetch(`${url}/media/${media[0].media_id}/thumb.webp`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
});

test('the same Telegram message delivered twice is stored once', async () => {
  assert.equal(await postWebhook(url, shidduchMsg), 200);
  assert.equal((await q('SELECT count(*)::int AS n FROM telegram_imports'))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM occasions'))[0].n, 1);
});

test('a reposted duplicate is published but statistics count the boy once', async () => {
  await postWebhook(url, channelPost('מזל טוב! הבה"ח יואל משה פריעדמאן ני"ו לרגל אירוסיו עב"ג בת ר\' אברהם גרין'));
  // different spelling of the same boy
  await postWebhook(url, channelPost('מזל טוב צו הבחור יואל משה פרידמאן ני"ו פון בארא פארק צו זיין שידוך'));
  const occs = await q(`SELECT * FROM occasions WHERE deleted_at IS NULL ORDER BY id`);
  assert.equal(occs.length, 3, 'all duplicates are published');
  assert.equal(new Set(occs.map((o) => o.boy_id)).size, 1, 'linked to the same boy profile');
  assert.ok(occs[1].duplicate_of && occs[2].duplicate_of, 'later ones flagged as duplicates');
  assert.equal((await q('SELECT count(*)::int AS n FROM boys'))[0].n, 1, 'no duplicate boy profile');
  const aliases = await q('SELECT alias FROM boy_aliases');
  assert.ok(aliases.some((a) => a.alias === 'יואל משה פרידמאן'), 'spelling variant saved as alias');
  const stats = await getJson('/api/stats');
  assert.equal(stats.total, 1);
  assert.equal(stats.byBranch.b1.total, 1);
});

let birthBoyId, birthOccId;
test('birth announcement never exposes the baby name or birth pictures, anywhere', async () => {
  await addMockPhoto('babyphoto');
  const upd = channelPost(null, {
    caption: 'מזל טוב! ביי ידידנו ר\' אהרן שווארץ ני"ו פון מאנסי איז געבוירן געווארן א בן זכר ושמו בישראל מנחם מענדל',
    photo: [{ file_id: 'babyphoto', width: 900, height: 600 }],
  });
  delete upd.channel_post.text;
  await postWebhook(url, upd);
  const [occ] = await q(`SELECT o.* FROM occasions o JOIN categories c ON c.id=o.category_id WHERE c.kind='birth_boy'`);
  assert.ok(occ, 'birth recognised');
  birthBoyId = occ.boy_id; birthOccId = occ.id;
  assert.equal(occ.father_in_law_name, null);
  const pages = [
    await get(`/boy/${occ.boy_id}`), await get(`/occasion/${occ.id}`), await get('/'), await get('/feed?category=birth'),
    await get('/search?q=' + encodeURIComponent('שווארץ')), await get(`/calendar?y=${occ.heb_year}&m=${occ.heb_month}&date=${occ.greg_date}`),
  ];
  for (const p of pages) assert.ok(!p.body.includes('מנחם'), 'baby name must not be shown');
  // Searching for the baby's name finds nothing (the page only echoes the visitor's own query).
  const babySearch = await get('/search?q=' + encodeURIComponent('מנחם מענדל'));
  assert.ok(babySearch.body.includes('קיין רעזולטאטן נישט געפונען'));
  assert.ok(!babySearch.body.includes('אהרן שווארץ'));
  assert.ok(pages[1].body.includes('האט געהאט א בן זכר'));
  const apis = [
    await getJson(`/api/boys/${occ.boy_id}`), await getJson('/api/search?q=' + encodeURIComponent('מנחם')),
    await getJson(`/api/calendar?y=${occ.heb_year}&m=${occ.heb_month}`), await getJson(`/api/day?date=${occ.greg_date}`),
    await getJson('/api/occasions?category=birth'),
  ];
  for (const a of apis) {
    const s = JSON.stringify(a);
    assert.ok(!s.includes('מנחם'), 'baby name must not be in API');
    assert.ok(!s.includes('raw_text') && !s.includes('announcement_text') && !s.includes('raw_json'), 'no internal fields in API');
  }
  const search = await getJson('/api/search?q=' + encodeURIComponent('מנחם מענדל'));
  assert.equal(search.total, 0, 'cannot find a record by the baby name');
  const tl = await getJson(`/api/boys/${occ.boy_id}`);
  assert.deepEqual(tl.timeline[0].pictures, [], 'no birth pictures');
  const [m] = await q('SELECT media_id FROM occasion_media WHERE occasion_id=$1', [occ.id]);
  assert.ok(m, 'picture is stored for admins');
  assert.equal((await fetch(`${url}/media/${m.media_id}.webp`)).status, 404, 'birth picture is not publicly served');
});

test('public API objects contain only whitelisted fields', async () => {
  const d = await getJson('/api/occasions');
  for (const o of d.items) {
    assert.deepEqual(Object.keys(o).sort(), ['boy', 'branch', 'category', 'date', 'family', 'id', 'pictures', 'text', 'url']);
    assert.deepEqual(Object.keys(o.boy).sort(), ['id', 'name', 'photo', 'url']);
    if (o.family) assert.deepEqual(Object.keys(o.family).sort(), ['details', 'fatherInLaw', 'residence']);
  }
});

test('unrecognised posts wait for review; other chats are ignored; edits are tracked', async () => {
  await postWebhook(url, channelPost('היינט איז דא א שיעור אין בית המדרש'));
  const [imp] = await q(`SELECT * FROM telegram_imports ORDER BY id DESC LIMIT 1`);
  assert.equal(imp.status, 'needs_review');
  assert.equal(imp.occasion_id, null);
  const other = channelPost('מזל טוב! הבה"ח משה קליין ני"ו לרגל אירוסיו');
  other.channel_post.chat.id = -100222;
  await postWebhook(url, other);
  const [ign] = await q(`SELECT * FROM telegram_imports ORDER BY id DESC LIMIT 1`);
  assert.equal(ign.status, 'ignored');
  assert.equal((await q(`SELECT count(*)::int AS n FROM boys WHERE official_name='משה קליין'`))[0].n, 0);
  // an edit of the unrecognised post that now contains a recognisable announcement gets imported
  const edit = { update_id: 99999, edited_channel_post: { ...JSON.parse(JSON.stringify(imp.raw_json)), text: 'מזל טוב! הבה"ח שמעון לוי ני"ו פון מאנסי לרגל אירוסיו', edit_date: imp.raw_json.date + 60 } };
  await postWebhook(url, edit);
  const [re] = await q(`SELECT * FROM telegram_imports WHERE message_id=$1`, [imp.message_id]);
  assert.equal(re.status, 'recognized');
});

test('album pictures without captions attach to the album occasion', async () => {
  await addMockPhoto('alb1'); await addMockPhoto('alb2');
  const first = channelPost(null, { caption: 'מזל טוב! הבה"ח בנימין גראס ני"ו פון מאנסי לרגל נישואיו', media_group_id: 'G1', photo: [{ file_id: 'alb1', width: 900, height: 600 }] });
  delete first.channel_post.text;
  const second = channelPost(null, { media_group_id: 'G1', photo: [{ file_id: 'alb2', width: 900, height: 600 }] });
  delete second.channel_post.text;
  await postWebhook(url, first); await postWebhook(url, second);
  const [occ] = await q(`SELECT o.id FROM occasions o JOIN boys b ON b.id=o.boy_id WHERE b.official_name='בנימין גראס'`);
  const media = await q('SELECT * FROM occasion_media WHERE occasion_id=$1', [occ.id]);
  assert.equal(media.length, 2);
});

// ---------------------------------------------------------------- calendar & search
test('calendar shows occasions on their Jewish date and handles sunset', async () => {
  const [occ] = await q(`SELECT * FROM occasions WHERE id=$1`, [birthOccId]);
  const cal = await getJson(`/api/calendar?y=${occ.heb_year}&m=${occ.heb_month}`);
  const cell = cal.weeks.flat().find((c) => c && c.hDay === occ.heb_day);
  assert.ok(cell.events.some((e) => e.id === occ.id));
  const html = await get(`/calendar?y=5787&m=13`);
  assert.ok(html.body.includes('אדר ב׳'));
  const frag = await get(`/calendar/fragment?y=5787&m=8&date=2026-10-20&base=home`);
  assert.equal(frag.status, 200);
  assert.ok(frag.body.includes('day-panel'));
});

test('search by alias, Jewish date, civil date, category and branch', async () => {
  const [occ] = await q(`SELECT * FROM occasions WHERE id=$1`, [birthOccId]);
  const byAlias = await getJson('/api/search?q=' + encodeURIComponent('פרידמאן'));
  assert.ok(byAlias.boys.some((b) => b.name === 'יואל משה פריעדמאן'));
  const bySpelling = await getJson('/api/search?q=' + encodeURIComponent('פרידמן'));
  assert.ok(bySpelling.boys.length >= 1, 'spelling-tolerant search');
  const h = await import('../src/hebrew.js');
  const hebText = h.hebrewFromIso(occ.greg_date, occ.after_sunset).text;
  const byHeb = await get('/search?q=' + encodeURIComponent(hebText));
  assert.ok(byHeb.body.includes('אהרן שווארץ'));
  const [y, m, d] = occ.greg_date.split('-');
  const byGreg = await get('/search?q=' + encodeURIComponent(`${Number(d)}/${Number(m)}/${y}`));
  assert.ok(byGreg.body.includes('אהרן שווארץ'));
  const byCatBranch = await getJson('/api/search?q=' + encodeURIComponent('שידוך בארא פארק'));
  assert.ok(byCatBranch.occasions.length >= 1 && byCatBranch.occasions.every((o) => o.category.key === 'shidduch' && o.branch.id === 'b1'));
});

// ---------------------------------------------------------------- admin
const admin = () => client(url);

test('admin area requires login; PINs are hashed; roles enforced on the server', async () => {
  const anon = admin();
  assert.equal((await anon.text('/admin/occasions')).status, 302);
  assert.equal((await anon.post('/admin/occasions', { categoryId: 1 })).status, 302);
  const [pin] = await q(`SELECT value FROM settings WHERE key='pin_admin'`);
  assert.ok(pin.value.hash && !JSON.stringify(pin.value).includes('123456'), 'PIN stored as hash');

  const a = admin();
  assert.equal((await a.post('/admin/login', { pin: '000000' })).status, 401);
  await q('DELETE FROM login_failures');
  const ok = await a.post('/admin/login', { pin: '123456' });
  assert.equal(ok.status, 302);
  assert.equal((await a.text('/admin')).status, 200);
  assert.equal((await a.text('/admin/categories')).status, 403, 'admin cannot open super pages');
  assert.equal((await a.text('/admin/settings')).status, 403);
  const csrf = await a.csrf();
  assert.equal((await a.post('/admin/settings', { _csrf: csrf, school_name: 'x' })).status, 403);
  assert.equal((await a.post('/admin/announcements', { title: 'בלי טאקען' })).status, 403, 'CSRF token required');
});

test('login is rate limited', async () => {
  await q('DELETE FROM login_failures');
  const c = admin();
  for (let i = 0; i < 5; i++) await c.post('/admin/login', { pin: '555555' });
  assert.equal((await c.post('/admin/login', { pin: '123456' })).status, 429, 'blocked even with the right PIN');
  await q('DELETE FROM login_failures');
});

async function loggedIn(pin) {
  const c = admin();
  await c.post('/admin/login', { pin });
  return c;
}

test('admin creates a record; similar names require confirmation (no duplicate profiles)', async () => {
  const a = await loggedIn('123456');
  const csrf = await a.csrf('/admin/occasions/new');
  const [cat] = await q(`SELECT id FROM categories WHERE key='tenaim'`);
  const r1 = await a.post('/admin/occasions', { _csrf: csrf, newBoyName: 'יואל משה פרידמן', branch: 'b1', categoryId: cat.id, dateMode: 'greg', gregDate: '2026-11-05', status: 'published', showFamily: '1' }, { multipart: true });
  assert.equal(r1.status, 400);
  assert.ok(r1.body.includes('ענליכן נאמען'));
  const [boy] = await q(`SELECT id FROM boys WHERE official_name='יואל משה פריעדמאן'`);
  const r2 = await a.post('/admin/occasions', { _csrf: csrf, boyId: boy.id, branch: 'b1', categoryId: cat.id, dateMode: 'heb', hebDay: '25', hebMonth: '8', hebYear: '5787', status: 'published', showFamily: '1', fatherInLaw: 'אברהם גרין' }, { multipart: true });
  assert.equal(r2.status, 302, r2.body.slice(0, 300));
  const [o] = await q(`SELECT * FROM occasions WHERE category_id=$1`, [cat.id]);
  assert.equal(o.greg_date, '2026-11-05', 'Jewish date converted to civil date');
  assert.equal(o.heb_date_text, 'כ״ה חשון תשפ״ז');
  assert.equal((await q('SELECT count(*)::int AS n FROM boys WHERE deleted_at IS NULL AND name_skel=(SELECT name_skel FROM boys WHERE id=$1)', [boy.id]))[0].n, 1);
  const stats = await getJson('/api/stats');
  assert.equal(stats.byBranch.b1.total, 1, 'tena\'im for the same boy does not double count');
  const tl = await getJson(`/api/boys/${boy.id}`);
  const dates = tl.timeline.map((t) => t.date.iso);
  assert.deepEqual(dates, [...dates].sort(), 'timeline is chronological');
  assert.ok(tl.timeline.some((t) => t.category.key === 'tenaim') && tl.timeline.some((t) => t.category.key === 'shidduch'));
  const upcoming = await get('/');
  assert.ok(upcoming.body.includes('קומענדיגע שמחות'));
});

test('announcements go to Telegram ONLY when explicitly selected; failures are retried', async () => {
  const a = await loggedIn('123456');
  const csrf = await a.csrf('/admin/announcements/new');
  const before = mockTg.sent.length;
  const r1 = await a.post('/admin/announcements', { _csrf: csrf, title: 'א מודעה פאר אלעמען', body: 'טעקסט', published: '1', featured: '1' }, { multipart: true });
  assert.equal(r1.status, 302);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mockTg.sent.length, before, 'not sent without the checkbox');
  assert.equal((await q('SELECT count(*)::int AS n FROM telegram_outbox'))[0].n, 0);
  assert.ok((await get('/')).body.includes('א מודעה פאר אלעמען'), 'featured announcement on homepage');

  const r2 = await a.post('/admin/announcements', { _csrf: csrf, title: 'צווייטע מודעה', body: 'שיקן', published: '1', sendTelegram: '1' }, { multipart: true });
  assert.equal(r2.status, 302);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(mockTg.sent.length, before + 1);
  assert.ok(mockTg.sent.at(-1).params.text.includes('צווייטע מודעה'));
  const [ob] = await q('SELECT * FROM telegram_outbox ORDER BY id DESC LIMIT 1');
  assert.equal(ob.status, 'sent');
  assert.equal(Number(ob.telegram_message_id), mockTg.sent.at(-1).id);

  // our own post coming back through the channel is not imported
  await postWebhook(url, { update_id: 777777, channel_post: { message_id: Number(ob.telegram_message_id), date: 1, chat: { id: -100999, type: 'channel' }, text: 'צווייטע מודעה' } });
  const [echo] = await q('SELECT status FROM telegram_imports WHERE message_id=$1', [ob.telegram_message_id]);
  assert.equal(echo.status, 'echo');

  mockTg.failNextSend = 1;
  const [ann] = await q(`SELECT id FROM announcements WHERE title='א מודעה פאר אלעמען'`);
  const r3 = await a.post(`/admin/announcements/${ann.id}`, { _csrf: csrf, title: 'א מודעה פאר אלעמען', body: 'טעקסט', published: '1', featured: '1', sendTelegram: '1' }, { multipart: true });
  assert.equal(r3.status, 302);
  await new Promise((r) => setTimeout(r, 500));
  const [failed] = await q('SELECT * FROM telegram_outbox ORDER BY id DESC LIMIT 1');
  assert.equal(failed.status, 'pending', 'temporary failure is queued for retry');
  assert.ok(failed.error.includes('Internal Server Error'));
  assert.ok(!failed.error.includes('TEST:TOKEN'), 'token never in error messages');
  await q(`UPDATE telegram_outbox SET next_attempt_at=now() WHERE id=$1`, [failed.id]);
  const { processOutbox } = await import('../src/telegram/outbox.js');
  await processOutbox();
  const [retried] = await q('SELECT status FROM telegram_outbox WHERE id=$1', [failed.id]);
  assert.equal(retried.status, 'sent');
  const tgPage = await a.text('/admin/telegram');
  assert.ok(!tgPage.body.includes('TEST:TOKEN'), 'token never shown in admin UI');
});

test('admin corrects a wrongly linked import and replaces the picture', async () => {
  const a = await loggedIn('123456');
  const [occ] = await q(`SELECT o.*, (SELECT array_agg(media_id) FROM occasion_media WHERE occasion_id=o.id) AS media FROM occasions o JOIN boys b ON b.id=o.boy_id WHERE b.official_name='בנימין גראס'`);
  const csrf = await a.csrf(`/admin/occasions/${occ.id}/edit`);
  const [cat] = await q(`SELECT id FROM categories WHERE key='wedding'`);
  const r = await a.post(`/admin/occasions/${occ.id}`, {
    _csrf: csrf, boyId: occ.boy_id, branch: 'b4', categoryId: cat.id, dateMode: 'greg', gregDate: '2026-10-21', status: 'published', showFamily: '1',
    removeMedia: String(occ.media[0]),
  }, { multipart: true });
  assert.equal(r.status, 302, r.body.slice(0, 200));
  const [after] = await q('SELECT * FROM occasions WHERE id=$1', [occ.id]);
  assert.equal(after.branch, 'b4');
  assert.equal((await q('SELECT count(*)::int AS n FROM occasion_media WHERE occasion_id=$1', [occ.id]))[0].n, 1);
  assert.equal((await fetch(`${url}/media/${occ.media[0]}.webp`)).status, 404, 'removed picture no longer served');
  const [imp] = await q('SELECT status FROM telegram_imports WHERE occasion_id=$1 AND raw_text <> \'\'', [occ.id]);
  assert.equal(imp.status, 'corrected');
});

test('super admin manages categories, merges duplicates; statistics update', async () => {
  const s = await loggedIn('987654');
  assert.equal((await s.text('/admin/categories')).status, 200);
  const csrf = await s.csrf('/admin/categories');
  const [other] = await q(`SELECT * FROM categories WHERE key='other'`);
  await s.post(`/admin/categories/${other.id}`, { _csrf: csrf, name: 'אנדערע', enabled: '1', keywords: 'בר מצוה', kind: 'other' });
  assert.equal((await q(`SELECT name FROM categories WHERE key='other'`))[0].name, 'אנדערע');
  await s.post('/admin/categories', { _csrf: csrf, name: 'בר מצוה', kind: 'other', keywords: 'בר מצוה, בר-מצוה' });
  const cats = await q('SELECT * FROM categories ORDER BY sort_order');
  assert.equal(cats.at(-1).name, 'בר מצוה');
  await s.post(`/admin/categories/${cats.at(-1).id}/move`, { _csrf: csrf, dir: 'up' });
  const cats2 = await q('SELECT key FROM categories ORDER BY sort_order');
  assert.equal(cats2.at(-2).key, cats.at(-1).key, 'reordered');
  // disabling a category hides its records
  const [birth] = await q(`SELECT * FROM categories WHERE key='birth'`);
  await s.post(`/admin/categories/${birth.id}`, { _csrf: csrf, name: birth.name, keywords: birth.keywords.join(',') });
  assert.equal((await get(`/occasion/${birthOccId}`)).status, 404);
  await s.post(`/admin/categories/${birth.id}`, { _csrf: csrf, name: birth.name, enabled: '1', keywords: birth.keywords.join(',') });
  assert.equal((await get(`/occasion/${birthOccId}`)).status, 200);

  // two profiles for the same person created by mistake → merge → counted once
  const { createBoy } = await import('../src/repo/boys.js');
  const { createOccasion } = await import('../src/repo/occasions.js');
  const [shid] = await q(`SELECT id FROM categories WHERE key='shidduch'`);
  const x = await createBoy({ name: 'חיים ראזענבערג', branch: 'b2' });
  const y = await createBoy({ name: 'חיים ראזנבערג', branch: 'b2' });
  await createOccasion({ boyId: x, branch: 'b2', categoryId: shid.id, gregDate: '2026-10-01' });
  await createOccasion({ boyId: y, branch: 'b2', categoryId: shid.id, gregDate: '2026-10-02' });
  assert.equal((await getJson('/api/stats')).byBranch.b2.total, 2);
  const dupPage = await s.text('/admin/duplicates');
  assert.ok(dupPage.body.includes('חיים ראזנבערג'), 'suspected duplicate listed');
  await s.post('/admin/duplicates/merge', { _csrf: csrf, fromId: y, toId: x });
  assert.equal((await getJson('/api/stats')).byBranch.b2.total, 1, 'counted once after merge');
  const redirect = await fetch(`${url}/boy/${y}`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), `/boy/${x}`);

  // deleting a record updates statistics immediately
  const a = await loggedIn('123456');
  const c2 = await a.csrf('/admin');
  const [occX] = await q('SELECT id FROM occasions WHERE boy_id=$1', [x]);
  const allX = await q('SELECT id FROM occasions WHERE boy_id=$1', [x]);
  for (const o of allX) await a.post(`/admin/occasions/${o.id}/delete`, { _csrf: c2 });
  assert.ok(occX);
  assert.equal((await getJson('/api/stats')).byBranch.b2.total, 0);
});

test('super admin changes a PIN; old PIN stops working; sessions revoked', async () => {
  const s = await loggedIn('987654');
  const csrf = await s.csrf('/admin/settings');
  const r = await s.post('/admin/settings/pins', { _csrf: csrf, role: 'admin', current: '987654', pin: '24681357', pin2: '24681357' });
  assert.equal(r.status, 302);
  assert.ok(decodeURIComponent(r.location).includes('געטוישט'));
  const oldAdmin = admin();
  assert.equal((await oldAdmin.post('/admin/login', { pin: '123456' })).status, 401);
  await q('DELETE FROM login_failures');
  assert.equal((await admin().post('/admin/login', { pin: '24681357' })).status, 302);
  const backup = await s.get('/admin/backup.json');
  const data = await backup.json();
  assert.equal(data.format, 'school-db-backup');
  assert.ok(!JSON.stringify(data).includes('pin_admin'), 'PIN hashes not exported');
});

test('pages render on all main routes', async () => {
  for (const p of ['/', '/branch/b1', '/branch/b2', '/branch/b3', '/branch/b4', '/feed', '/feed?category=wedding&branch=b4', '/calendar', '/boys', '/announcements', '/search?q=' + encodeURIComponent('גרין')]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.body.includes('dir="rtl"'));
  }
  assert.equal((await get('/branch/b5')).status, 404, 'only four branches exist');
});
