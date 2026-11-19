'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = (process.versions.electron ? require('original-fs') : require('node:fs')).promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WindowsUpdater, verifyManifest, verifyArchive, stageArchive, downloadArchive, newer, feedURL } = require('./updater.cjs');
const { replaceApplication, validatePlan, waitForParent } = require('./update-helper.cjs');
const data = path.join(__dirname, 'testdata');
const archive = path.join(data, 'NanoBridge-0.0.1-Windows-x64.zip');
// The signed fixture is older than every production release and cannot update a released app.
async function signedFixture() {
  const bytes = await fs.readFile(path.join(data, 'windows-update.json'));
  const signature = await fs.readFile(path.join(data, 'windows-update.json.sig'), 'utf8');
  return { bytes, signature, manifest: verifyManifest(bytes, signature) };
}
async function temporary(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'NanoBridge-update-check-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('release signature interoperates with Sparkle; tampering, invalid signatures and downgrades are rejected', async () => {
  const { bytes, signature, manifest } = await signedFixture();
  assert.equal(manifest.version, '0.0.1');
  assert.throws(() => verifyManifest(Buffer.from(bytes.toString().replace('0.0.1', '9.0.0')), signature), /签名/);
  assert.throws(() => verifyManifest(bytes, '!'.repeat(88)), /签名/);
  assert.throws(() => verifyManifest(bytes, Buffer.alloc(64).toString('base64')), /签名/);
  assert.equal(newer('0.10.0', '0.2.9'), true);
  for (const v of ['0.1.0', '0.0.9']) assert.equal(newer(v, '0.1.0'), false);
  for (const v of ['1.0.0-beta', '1.0', '01.0.0', '../9.0.0', '9007199254740992.0.0']) assert.throws(() => newer(v, '0.1.0'));
});

test('archive size/hash verification, safe native extraction, and path traversal rejection', async () => temporary(async dir => {
  const { manifest } = await signedFixture();
  await verifyArchive(archive, manifest);
  await assert.rejects(verifyArchive(archive, { ...manifest, sha256: '0'.repeat(64) }), /校验/);
  const root = await stageArchive(archive, path.join(dir, 'good'), manifest);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'resources/app/package.json'))).version, '0.0.1');
  const bad = path.join(data, 'update-traversal.zip'), bytes = await fs.readFile(bad);
  await assert.rejects(stageArchive(bad, path.join(dir, 'bad'), { ...manifest, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
  await assert.rejects(fs.access(path.join(dir, 'outside.txt')));
  const failed = path.join(dir, 'download.zip');
  await assert.rejects(downloadArchive(new Response('wrong bytes'), failed, manifest), /校验/);
  await assert.rejects(fs.access(failed));
}));

test('check, download, restore and queue protection retain only verified update state', async () => temporary(async dir => {
  const fixture = await signedFixture();
  let busy = false, count = 1;
  const fetcher = async url => new Response(url === feedURL ? fixture.bytes : url === feedURL + '.sig' ? fixture.signature : await fs.readFile(archive));
  const make = () => new WindowsUpdater({ version: '0.0.0', directory: dir, target: path.join(dir, 'app'), supported: true,
    getActivity: () => ({ busy, count }), changed: () => {}, fetcher });
  const updater = make();
  busy = true; await assert.rejects(updater.check(), /处理中/); busy = false;
  await updater.check(); assert.equal(updater.state.phase, 'available');
  await updater.download(); assert.equal(updater.state.phase, 'ready');
  assert.equal(updater.state.progress, 100);
  updater.requestInstall(); assert.equal(updater.state.phase, 'deferred');
  assert.equal(await updater.prepareInstall(), null);
  const restored = make(); await restored.restore(); assert.equal(restored.state.phase, 'ready');
  count = 0; assert.equal(updater.occupied, false);
  await fs.mkdir(updater.target); await fs.writeFile(path.join(updater.target, 'NanoBridge.exe'), 'MZ fixture');
  const prepared = await updater.prepareInstall();
  assert.equal(await fs.readFile(path.join(prepared.plan.candidate, 'resources/default_app.asar'), 'utf8'), 'ASAR bytes must be copied as a physical file');
  await fs.appendFile(restored.ready.archive, 'corruption');
  const corrupt = make(); await corrupt.restore(); assert.equal(corrupt.state.phase, 'error'); assert.equal(corrupt.ready, null);
  const current = new WindowsUpdater({ version: '0.1.0', directory: dir, supported: false, getActivity: () => ({ busy: false, count: 0 }), changed: () => {}, fetcher });
  await current.check(); assert.equal(current.state.phase, 'current'); assert.equal(current.ready, null);
  const missing = make(); missing.fetcher = async () => new Response('', { status: 404 });
  await assert.rejects(missing.check(), /尚未发布/); assert.equal(missing.state.phase, 'error');
}));

test('replacement waits for parent exit; startup failure rolls back and user files remain recoverable', async () => temporary(async dir => {
  const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { parent.once('spawn', resolve); parent.once('error', reject); });
  const begin = Date.now(); await waitForParent(parent.pid); assert.ok(Date.now() - begin >= 200);
  for (const fail of [false, true]) {
    const base = path.join(dir, fail ? 'rollback' : 'success'); await fs.mkdir(base);
    const id = crypto.randomUUID(), work = path.join(base, 'updates', id);
    const plan = { id, parentPid: parent.pid, version: '0.0.1', work, target: path.join(base, 'app'),
      candidate: path.join(base, `.NanoBridge-update-${id}`), backup: path.join(base, `.NanoBridge-previous-${id}`) };
    validatePlan(plan);
    assert.throws(() => validatePlan({ ...plan, backup: path.join(dir, 'unrelated') }), /Unsafe/);
    await fs.mkdir(work, { recursive: true }); await fs.mkdir(plan.target);
    await fs.writeFile(path.join(plan.target, 'user-file.txt'), 'original');
    await fs.mkdir(path.join(plan.candidate, 'resources', 'app'), { recursive: true });
    await fs.writeFile(path.join(plan.candidate, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'nanobridge', version: plan.version }));
    let launches = 0;
    const result = await replaceApplication(plan, async (_target, updateId) => {
      launches++;
      if (updateId && fail) throw new Error('synthetic startup failure');
      if (updateId) await fs.writeFile(path.join(work, 'started.json'), JSON.stringify({ version: plan.version }));
      return { exitCode: null, kill() {} };
    });
    assert.equal(result, !fail);
    assert.equal(await fs.readFile(path.join(fail ? plan.target : plan.backup, 'user-file.txt'), 'utf8'), 'original');
    assert.equal(launches, fail ? 2 : 1);
    if (fail) assert.match(await fs.readFile(path.join(base, 'updates', 'last-error.txt'), 'utf8'), /startup failure/);
    else await fs.access(path.join(work, 'complete'));
  }
}));
