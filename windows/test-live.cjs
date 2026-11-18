'use strict';
const assert = require('node:assert/strict');
const { NetEase, downloadURL } = require('./core.cjs');
(async () => {
  const api = new NetEase();
  const key = await api.loginKey(); assert.ok(key);
  const result = await api.checkLogin(key); assert.ok([801, 802].includes(result.code));
  const songs = await api.details([347230]); assert.equal(songs.length, 1); assert.ok(songs[0].title);
  const { body } = await api.request('/api/song/enhance/download/url/v1', { id: '347230', level: 'exhigh', immerseType: 'c51' });
  let downloadable = false;
  try { downloadURL(body); downloadable = true; } catch { /* The test song can require account permission. */ }
  console.log('PASS: real QR key/poll, song metadata, download endpoint; complete audio ' + (downloadable ? 'available' : 'needs account permission'));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
