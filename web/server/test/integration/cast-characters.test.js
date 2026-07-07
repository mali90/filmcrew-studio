// Character profiles: CRUD, reference linking (filename-prefix renames), voice re-keying, and
// starring a cast in a run. All cast roots are isolated tmp dirs — the real repo's profiles/,
// elements/ and voices/ are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-cast-'));
const dirs = {
  runs: path.join(tmpRoot, 'runs'),
  out: path.join(tmpRoot, 'out'),
  profiles: path.join(tmpRoot, 'profiles'),
  elements: path.join(tmpRoot, 'elements'),
  voices: path.join(tmpRoot, 'voices'),
};
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const app = await buildApp({
  root: HOST_ROOT,
  runsDir: dirs.runs,
  outDir: dirs.out,
  profilesDir: dirs.profiles,
  elementsRoot: dirs.elements,
  voicesFile: path.join(dirs.voices, 'voices.json'),
  childEnv: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  },
});

test.after(async () => { await app.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const put = (url, payload) => app.inject({ method: 'PUT', url, payload });
const del = (url) => app.inject({ method: 'DELETE', url });

// tiny valid PNG for uploads
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const uploadRef = async (filename, character) => {
  const boundary = '----kvatest';
  const parts = [];
  if (character) parts.push(`--${boundary}\r\ncontent-disposition: form-data; name="character"\r\n\r\n${character}\r\n`);
  parts.push(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: image/png\r\n\r\n`);
  const body = Buffer.concat([Buffer.from(parts.join('')), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return app.inject({ method: 'POST', url: '/api/cast/references', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
};

test('profile CRUD: create → read (character-first view) → update → duplicate 409 → bad name 400', async () => {
  const created = await post('/api/cast/profiles', { name: 'The Keeper', description: 'Calm, wry, weathered.' });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().slug, 'the-keeper');
  assert.ok(fs.existsSync(path.join(dirs.profiles, 'the-keeper.md')), 'the same artifact a CLI user would make');

  let chars = (await get('/api/cast/characters')).json().characters;
  assert.equal(chars.length, 1);
  assert.equal(chars[0].name, 'The Keeper');
  assert.deepEqual(chars[0].refs, []);
  assert.equal(chars[0].voice, null);

  const updated = await put('/api/cast/profiles/the-keeper', { description: 'Now with a limp.' });
  assert.equal(updated.statusCode, 200);
  chars = (await get('/api/cast/characters')).json().characters;
  assert.match(chars[0].description, /Now with a limp/);
  assert.equal(chars[0].name, 'The Keeper', 'display name survives a description-only update');

  assert.equal((await post('/api/cast/profiles', { name: 'the keeper' })).statusCode, 409, 'slug-insensitive uniqueness');
  assert.equal((await post('/api/cast/profiles', { name: '../evil' })).statusCode, 400);
  assert.equal((await post('/api/cast/profiles', { name: '' })).statusCode, 400);
});

test('references: character upload auto-names <slug>-NN, assign/unassign rename on disk', async () => {
  const up = await uploadRef('face.png', 'The Keeper');
  assert.equal(up.statusCode, 201, up.body);
  assert.equal(up.json().added, 'the-keeper-01.png');

  let view = (await get('/api/cast/characters')).json();
  assert.equal(view.characters[0].refs.length, 1);
  assert.equal(view.characters[0].refs[0].id, 'the-keeper-01');
  assert.match(view.characters[0].refs[0].url, /^\/api\/media\/elements\/references\//);
  assert.equal(view.unassigned.references.length, 0);

  // a plain upload lands unassigned; assigning renames it into the character's prefix
  assert.equal((await uploadRef('harbor.png')).statusCode, 201);
  view = (await get('/api/cast/characters')).json();
  assert.equal(view.unassigned.references.length, 1);
  const assign = await post('/api/cast/references/harbor/assign', { character: 'the-keeper' });
  assert.equal(assign.statusCode, 200, assign.body);
  assert.equal(assign.json().id, 'the-keeper-harbor');
  assert.ok(fs.existsSync(path.join(dirs.elements, 'references', 'the-keeper-harbor.png')));

  // unassign strips the prefix again
  const unassign = await post('/api/cast/references/the-keeper-harbor/assign', {});
  assert.equal(unassign.json().id, 'harbor');
  view = (await get('/api/cast/characters')).json();
  assert.equal(view.characters[0].refs.length, 1);
  assert.equal(view.unassigned.references.length, 1);

  assert.equal((await post('/api/cast/references/harbor/assign', { character: 'nobody' })).statusCode, 404);
});

test('voices: re-keying links a minted voice to a character without ever destroying the paid id', async () => {
  fs.mkdirSync(dirs.voices, { recursive: true });
  fs.writeFileSync(path.join(dirs.voices, 'voices.json'), JSON.stringify({
    oldvoice: { name: 'oldvoice', voice_id: 'v_123', ref_clip: null, minted_at: 'then' },
    spare: { name: 'spare', voice_id: 'v_456', ref_clip: null, minted_at: 'then' },
  }));

  const linked = await post('/api/cast/voices/oldvoice/assign', { character: 'The Keeper' });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().key, 'the-keeper');

  let view = (await get('/api/cast/characters')).json();
  assert.equal(view.characters[0].voice.voiceId, 'v_123');
  assert.equal(view.characters[0].voice.name, 'The Keeper');
  assert.equal(view.unassigned.voices.length, 1);

  // a second voice cannot silently replace the first (it cost money)
  assert.equal((await post('/api/cast/voices/spare/assign', { character: 'The Keeper' })).statusCode, 409);

  // unlink keeps the entry under an unassigned key
  const unlinked = await post('/api/cast/voices/the-keeper/assign', {});
  assert.match(unlinked.json().key, /^unassigned-/);
  view = (await get('/api/cast/characters')).json();
  assert.equal(view.characters[0].voice, null);
  assert.equal(view.unassigned.voices.length, 2);
  const map = JSON.parse(fs.readFileSync(path.join(dirs.voices, 'voices.json'), 'utf8'));
  assert.ok(Object.values(map).some((v) => v.voice_id === 'v_123'), 'the paid voice id survives');
});

test('starring a cast: the run records it and the engine filters to those profiles', async () => {
  const res = await post('/api/runs', { idea: 'the keeper at dusk', backend: 'kling', aspect: '9:16', durationS: null, cast: ['the-keeper'] });
  assert.equal(res.statusCode, 201, res.body);
  const { runId } = res.json();

  for (let t = 0; ; t += 150) {
    const run = (await get(`/api/runs/${runId}`)).json().run;
    if (run.status === 'plan-ready') break;
    if (run.status === 'attention') assert.fail(`plan failed: ${JSON.stringify(run.error)}`);
    if (t > 60000) assert.fail(`timeout (last: ${run.status})`);
    await sleep(150);
  }
  const run = (await get(`/api/runs/${runId}`)).json().run;
  assert.deepEqual(run.manifest.cast, ['the-keeper']);
  assert.deepEqual(run.spec.cast, ['the-keeper'], 'the engine stamped the starred cast onto the spec');
});

test('starring an unknown character is a 400 BEFORE any engine spend', async () => {
  const res = await post('/api/runs', { idea: 'x', backend: 'kling', aspect: '9:16', durationS: null, cast: ['nobody'] });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().hint, /Cast page/);
});

test('deleting a character unlinks its assets by default (they move to Unassigned)', async () => {
  const before = (await get('/api/cast/characters')).json();
  const refCount = before.characters[0].refs.length;
  assert.ok(refCount >= 1);

  const res = await del('/api/cast/profiles/the-keeper');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().refsDeleted, 0);

  const after = (await get('/api/cast/characters')).json();
  assert.equal(after.characters.length, 0);
  assert.ok(after.unassigned.references.length >= refCount, 'refs survive into the pool');
});

test('a description that already starts with the heading never doubles it (editor regression)', async () => {
  const created = await post('/api/cast/profiles', { name: 'Echo', description: '# Echo\n\nSpeaks twice.' });
  assert.equal(created.statusCode, 201);
  let content = fs.readFileSync(path.join(dirs.profiles, 'echo.md'), 'utf8');
  assert.equal((content.match(/^# Echo$/gm) ?? []).length, 1, `create doubled the heading:\n${content}`);

  // saving from the editor used to grow one heading per save — PUT must be idempotent
  await put('/api/cast/profiles/echo', { description: '# Echo\n\nSpeaks once now.' });
  await put('/api/cast/profiles/echo', { description: (await get('/api/cast/characters')).json().characters.find((c) => c.slug === 'echo').description });
  content = fs.readFileSync(path.join(dirs.profiles, 'echo.md'), 'utf8');
  assert.equal((content.match(/^# Echo$/gm) ?? []).length, 1, `PUT doubled the heading:\n${content}`);
  await del('/api/cast/profiles/echo');
});

test('validate-llm (cli transport) pings with the CHILD env — valid at setup means valid at run time', async () => {
  // the harness routes the child env to the fake CLI; if validate used the server process env it
  // would try the real `claude` binary instead and this would not deterministically succeed
  const res = await post('/api/setup/validate-llm', { provider: 'claude', transport: 'cli' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true });
});

test('voice staging: a selected clip is SAVED with the character before any minting', async () => {
  await post('/api/cast/profiles', { name: 'Stager' });
  const boundary = '----kvastage';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="character"\r\n\r\nStager\r\n`),
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="clip"; filename="take.mp3"\r\ncontent-type: audio/mpeg\r\n\r\nFAKE-MP3\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({ method: 'POST', url: '/api/cast/voices/stage', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().key, 'stager');
  assert.equal(res.json().clipName, 'stager.mp3');
  assert.ok(fs.existsSync(path.join(dirs.voices, 'stager.mp3')), 'the clip survives on disk');

  // the character now shows a staged voice: no paid id yet, but lip-sync ready (clip exists)
  const view = (await get('/api/cast/characters')).json();
  const stager = view.characters.find((c) => c.slug === 'stager');
  assert.equal(stager.voice.voiceId, null);
  assert.equal(stager.voice.refClipAvailable, true);
  assert.equal(stager.voice.clipName, 'stager.mp3');

  // mint-from-staged: a JSON POST (no re-upload) queues the paid mint using the saved clip
  const mint = await post('/api/cast/voices', { name: 'Stager' });
  assert.equal(mint.statusCode, 202, mint.body);
  assert.ok(mint.json().queued);
  await post('/api/runs/voice-Stager/cancel', {}).catch(() => {}); // don't let the fake mint child run on

  // and minting from nothing is a clean 400
  await del('/api/cast/profiles/stager');
  const none = await post('/api/cast/voices', { name: 'Nobody' });
  assert.equal(none.statusCode, 400);
  assert.match(none.json().hint, /saved before minting/);
});

test('a bundled voice clip in the voices dir (no voices.json entry) shows as a STAGED voice — the sample cast', async () => {
  await post('/api/cast/profiles', { name: 'Wren' });
  fs.mkdirSync(dirs.voices, { recursive: true });
  fs.writeFileSync(path.join(dirs.voices, 'wren.mp3'), 'FAKE-MP3'); // the shipped sample clip, NOT in voices.json
  const wren = (await get('/api/cast/characters')).json().characters.find((c) => c.slug === 'wren');
  assert.ok(wren, 'the Wren character is listed');
  assert.equal(wren.voice.voiceId, null, 'staged, not minted');
  assert.equal(wren.voice.refClipAvailable, true, "the shipped clip is recognized as Wren's voice");
  const vf = path.join(dirs.voices, 'voices.json');
  const map = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8')) : {};
  assert.equal(map.wren, undefined, 'the synthetic entry is read-only — never written into the account voices.json');
  fs.rmSync(path.join(dirs.voices, 'wren.mp3'));
  await del('/api/cast/profiles/wren');
});

test('a character holds at most 7 reference images (Kling per-job cap) — upload and assign both refuse the 8th', async () => {
  await post('/api/cast/profiles', { name: 'Crowd' });
  for (let i = 0; i < 7; i++) {
    const r = await uploadRef(`shot${i}.png`, 'Crowd');
    assert.equal(r.statusCode, 201, r.body);
  }
  const eighth = await uploadRef('extra.png', 'Crowd');
  assert.equal(eighth.statusCode, 400);
  assert.match(eighth.json().hint, /at most 7 per job/);

  // linking an existing unassigned ref hits the same ceiling
  assert.equal((await uploadRef('loose.png')).statusCode, 201);
  const assign = await post('/api/cast/references/loose/assign', { character: 'crowd' });
  assert.equal(assign.statusCode, 400);
  assert.match(assign.json().hint, /unlink one first/);

  await del('/api/cast/profiles/crowd?deleteRefs=1');
  await post('/api/cast/references/loose/assign', {}).catch(() => {});
});
