'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { aes, decodeNcm, parseLink, safeName, downloadURL, runFfmpeg, convert } = require('./core.cjs');
const data = path.join(__dirname, 'testdata');

test('independent Python/OpenSSL NCM fixture: exact audio, Chinese tags, cover and input bounds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'NanoBridge-check-'));
  try {
    const result = await decodeNcm(path.join(data, 'fixture.ncm'), directory);
    assert.deepEqual(await fs.readFile(result.source), await fs.readFile(path.join(data, 'tone.flac')));
    assert.deepEqual(result.tags, { title: '测试音乐 / Test', artist: 'Nano Artist', album: 'Synthetic' });
    assert.deepEqual(await fs.readFile(result.coverPath), await fs.readFile(path.join(data, 'cover.png')));
    const source = await fs.readFile(path.join(data, 'fixture.ncm'));
    for (const size of [0, 7, 10, 13, 20, 100]) {
      const broken = path.join(directory, 'broken.ncm');
      await fs.writeFile(broken, source.subarray(0, size));
      await assert.rejects(decodeNcm(broken, directory));
    }
    const bad = Buffer.from(source); bad.writeUInt32LE(0xffffffff, 10);
    await fs.writeFile(path.join(directory, 'bad.ncm'), bad);
    await assert.rejects(decodeNcm(path.join(directory, 'bad.ncm'), directory), /长度异常/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('Windows-safe names, share links and full-download permissions', () => {
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('aux.txt'), '_aux.txt');
  assert.equal(safeName('a/b:c<>?. '), 'a_b_c___');
  assert.deepEqual(parseLink('分享音乐 https://music.163.com/#/song?id=347230'), { kind: 'song', id: 347230 });
  assert.deepEqual(parseLink('https://y.music.163.com/m/song/347230/?userid=1'), { kind: 'song', id: 347230 });
  assert.deepEqual(parseLink('https://music.163.com/playlist?id=123'), { kind: 'playlist', id: 123 });
  for (const input of ['https://evil.example/song?id=1', 'https://music.163.com.evil.example/song?id=1', 'https://music.163.com/song?id=-1', 'https://music.163.com/song?id=0']) assert.throws(() => parseLink(input));
  for (const body of [{}, { data: { url: null } }, { data: { url: 'https://m7.music.126.net/a.mp3', freeTrialInfo: {} } }, { data: { url: 'https://evil.example/a.mp3' } }, { data: { url: 'https://m7.music.126.net/a.mp3', code: 404 } }]) assert.throws(() => downloadURL(body));
  assert.equal(downloadURL({ data: { url: 'http://m7.music.126.net/a.mp3' } }).protocol, 'https:');
  const text = Buffer.from('cipher roundtrip');
  assert.deepEqual(aes(aes(text, '0123456789abcdef'), '0123456789abcdef', true), text);
});
test('AAC conversion, metadata/cover preservation, repeat run and worker pipeline', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'NanoBridge-aac-'));
  try {
    const ffmpeg = require('ffmpeg-static');
    const temporary = path.join(directory, 'work'); await fs.mkdir(temporary);
    const audio = await decodeNcm(path.join(data, 'fixture.ncm'), temporary);
    const target = await convert(audio, path.join(directory, 'output'), 256, ffmpeg, temporary);
    const log = await runFfmpeg(ffmpeg, ['-i', target, '-map', '0:a:0', '-f', 'null', '-']);
    assert.match(log, /Audio: aac \(LC\).*44100 Hz, stereo/);
    assert.match(log, /测试音乐 \/ Test/);
    assert.match(log, /Nano Artist/);
    assert.match(log, /Synthetic/);
    assert.match(log, /attached pic/);
    assert.match(log, /Duration: 00:00:01\./);
    assert.equal(await convert(audio, path.join(directory, 'output'), 256, ffmpeg, temporary), target);
    const plainTemporary = path.join(directory, 'plain-work'); await fs.mkdir(plainTemporary);
    const plain = await convert({ source: path.join(data, 'tone.flac') }, path.join(directory, 'plain-output'), 128, ffmpeg, plainTemporary);
    assert.equal((await fs.stat(plain)).isFile(), true);
    const original = await fs.readFile(path.join(data, 'fixture.ncm'));
    const output = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'core.cjs'), { workerData: { item: { local: path.join(data, 'fixture.ncm') }, folder: path.join(directory, 'worker-output'), bitrate: 192, ffmpeg } });
      worker.on('message', result => { if (result.error) reject(new Error(result.error)); else if (result.output) resolve(result.output); });
      worker.on('error', reject);
      worker.on('exit', code => { if (code) reject(new Error('Worker exit: ' + code)); });
    });
    assert.equal((await fs.stat(output)).isFile(), true);
    assert.deepEqual(await fs.readFile(path.join(data, 'fixture.ncm')), original);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(convert(audio, path.join(directory, 'cancel'), 256, ffmpeg, temporary, cancelled.signal));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
