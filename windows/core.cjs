'use strict';
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');

const FORMATS = new Set(['ncm', 'mp3', 'flac', 'm4a', 'aac', 'wav', 'aiff', 'aif', 'alac']);
const MAX_BLOCK = 32 * 1024 * 1024;
function aes(data, key, decrypt = false) {
  const cipher = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)('aes-128-ecb', Buffer.from(key), null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function ncmMask(key) {
  if (!key.length) throw new Error('NCM 音频密钥为空');
  const box = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (box[i] + j + key[i % key.length]) & 255;
    [box[i], box[j]] = [box[j], box[i]];
  }
  return Buffer.from(box.map((_, i) => {
    const j = (i + 1) & 255;
    return box[(box[j] + box[(box[j] + j) & 255]) & 255];
  }));
}

async function decodeNcm(source, directory, signal) {
  const file = await fs.open(source, 'r');
  let position = 0, output;
  async function read(length) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BLOCK) throw new Error('NCM 数据块长度异常');
    const data = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await file.read(data, total, length - total, position + total);
      if (!bytesRead) throw new Error('NCM 文件被截断');
      total += bytesRead;
    }
    position += length;
    return data;
  }
  async function uint() { return (await read(4)).readUInt32LE(); }
  try {
    if (!(await read(8)).equals(Buffer.from('CTENFDAM'))) throw new Error('不是有效的 NCM 文件');
    await read(2);
    const keyBlock = await read(await uint());
    for (let i = 0; i < keyBlock.length; i++) keyBlock[i] ^= 0x64;
    const clearKey = aes(keyBlock, 'hzHRAmso5kInbaxW', true);
    if (clearKey.length <= 17 || !clearKey.subarray(0, 17).equals(Buffer.from('neteasecloudmusic'))) throw new Error('NCM 密钥格式不支持');
    const mask = ncmMask(clearKey.subarray(17));
    let tags = { title: path.basename(source, path.extname(source)), artist: '', album: '' };
    const metadata = await read(await uint());
    if (metadata.length) {
      for (let i = 0; i < metadata.length; i++) metadata[i] ^= 0x63;
      if (metadata.length <= 22) throw new Error('NCM 标签损坏');
      const clear = aes(Buffer.from(metadata.subarray(22).toString(), 'base64'), "#14ljk_!\\]&0U<'(", true);
      if (clear.subarray(0, 6).toString() !== 'music:') throw new Error('NCM 标签格式不支持');
      const info = JSON.parse(clear.subarray(6).toString());
      tags = { title: info.musicName || tags.title, album: info.album || '', artist: (info.artist || []).map(a => a[0]).filter(Boolean).join(' / ') };
    }
    await read(5);
    const frameLength = await uint(), coverLength = await uint();
    if (coverLength > frameLength || frameLength > MAX_BLOCK) throw new Error('NCM 封面长度异常');
    const cover = await read(coverLength);
    await read(frameLength - coverLength);
    let coverPath;
    if (cover.length) {
      coverPath = path.join(directory, cover.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ? 'cover.png' : 'cover.jpg');
      await fs.writeFile(coverPath, cover, { flag: 'wx' });
    }
    let target, offset = 0;
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const bytes = buffer.subarray(0, bytesRead);
      for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[(offset + i) & 255];
      offset += bytes.length;
      if (!output) {
        const flac = bytes.subarray(0, 4).toString() === 'fLaC';
        const mp3 = bytes.subarray(0, 3).toString() === 'ID3' || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224);
        if (!flac && !mp3) throw new Error('NCM 内部音频不是支持的 MP3 / FLAC');
        target = path.join(directory, 'decoded.' + (flac ? 'flac' : 'mp3'));
        output = await fs.open(target, 'wx');
      }
      await output.writeFile(bytes);
    }
    if (!target) throw new Error('NCM 没有音频内容');
    return { source: target, tags, coverPath };
  } finally { await file.close(); await output?.close(); }
}

function parseLink(text) {
  for (const candidate of String(text).matchAll(/https?:\/\/[^\s<>"，。]+/g)) {
    let url;
    try { url = new URL(candidate[0]); } catch { continue; }
    if (!['music.163.com', 'y.music.163.com'].includes(url.hostname)) continue;
    if (url.hash.startsWith('#/')) url = new URL('https://music.163.com' + url.hash.slice(1));
    const kind = /(?:^|\/)playlist(?:\/|$)/.test(url.pathname) ? 'playlist' : /(?:^|\/)song(?:\/|$)/.test(url.pathname) ? 'song' : null;
    const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).at(-1);
    if (kind && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0) return { kind, id: Number(id) };
  }
  throw new Error('请粘贴完整的网易云歌曲或歌单链接；短链接请先在浏览器打开后复制完整地址。');
}
function safeName(title) {
  let name = Array.from(String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim()).slice(0, 65).join('') || 'Untitled';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function mediaURL(text) {
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || !['music.126.net', 'music.163.com'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) throw new Error('音频下载地址不受支持');
  url.protocol = 'https:';
  return url;
}
function downloadURL(body) {
  const item = body?.data;
  if (!item || (item.code ?? 200) !== 200 || item.freeTrialInfo != null || !item.url) throw new Error('没有可下载的完整音源，请检查账号权限或使用客户端已下载文件');
  return mediaURL(item.url);
}
async function limitedBytes(response, limit) {
  if (!response.ok || !response.body) throw new Error('网络请求失败（' + response.status + '）');
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error('网络返回数据过大');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
class NetEase {
  constructor() { this.token = ''; }
  async request(route, parameters, signal) {
    const header = { os: 'osx', appver: '3.1.10.5100', osver: '15.5', deviceId: 'nanobridge-desktop', requestId: String(Date.now()), __csrf: '' };
    if (this.token) header.MUSIC_U = this.token;
    const json = JSON.stringify({ ...parameters, header, e_r: false });
    const digest = crypto.createHash('md5').update(`nobody${route}use${json}md5forencrypt`).digest('hex');
    const params = aes(Buffer.from(`${route}-36cd479b6b5-${json}-36cd479b6b5-${digest}`), 'e82ckenh8dichen8').toString('hex').toUpperCase();
    const response = await fetch('https://interface.music.163.com/eapi/' + route.slice(5), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', Cookie: Object.entries(header).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: new URLSearchParams({ params })
    });
    const body = JSON.parse((await limitedBytes(response, 16 * 1024 * 1024)).toString());
    if (body.code != null && body.code !== 200 && !(body.code >= 800 && body.code <= 803)) throw new Error(`网易云：${body.message || body.msg || '请求失败'}（${body.code}）`);
    return { body, cookies: response.headers.getSetCookie() };
  }
  async loginKey(signal) {
    const { body } = await this.request('/api/login/qrcode/unikey', { type: 3 }, signal);
    if (!body.unikey) throw new Error('没有取得登录二维码');
    return body.unikey;
  }
  async checkLogin(key, signal) {
    const { body, cookies } = await this.request('/api/login/qrcode/client/login', { key, type: 3 }, signal);
    const token = cookies.map(c => /^MUSIC_U=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return { code: body.code, token };
  }
  async details(ids, signal) {
    if (!ids.length) return [];
    const { body } = await this.request('/api/v3/song/detail', { c: JSON.stringify(ids.map(id => ({ id }))) }, signal);
    if (!Array.isArray(body.songs)) throw new Error('无法读取歌曲信息');
    const lookup = new Map(body.songs.map(s => [s.id, { id: s.id, title: s.name, artist: (s.ar || []).map(a => a.name).join(' / '), album: s.al?.name || '', cover: s.al?.picUrl }]));
    return ids.map(id => lookup.get(id)).filter(Boolean);
  }
  async songs(text, signal) {
    const link = parseLink(text);
    if (link.kind === 'song') return this.details([link.id], signal);
    const { body } = await this.request('/api/v6/playlist/detail', { id: String(link.id), n: 100000, s: 0 }, signal);
    const ids = body.playlist?.trackIds?.map(t => t.id);
    if (!ids?.length) throw new Error('歌单为空或当前账号没有访问权限');
    let songs = [];
    for (let i = 0; i < ids.length; i += 200) songs.push(...await this.details(ids.slice(i, i + 200), signal));
    return songs;
  }
  async download(song, directory, signal) {
    const { body } = await this.request('/api/song/enhance/download/url/v1', { id: String(song.id), level: 'exhigh', immerseType: 'c51' }, signal);
    const url = downloadURL(body);
    const ext = (body.data.type || 'mp3').toLowerCase();
    if (!['mp3', 'flac', 'm4a', 'aac'].includes(ext)) throw new Error('暂不支持下载音频格式：' + ext);
    const target = path.join(directory, 'download.' + ext);
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(600000), signal]) });
    if (!response.ok || !response.body) throw new Error('歌曲音频下载失败');
    await pipeline(Readable.fromWeb(response.body), require('node:fs').createWriteStream(target, { flags: 'wx' }), { signal });
    const size = (await fs.stat(target)).size;
    if (!size || (body.data.size > 0 && size !== body.data.size)) throw new Error('下载文件大小不符，请重试');
    let coverPath;
    if (song.cover) {
      try {
        const coverURL = mediaURL(song.cover); coverURL.search = 'param=600y600';
        const cover = await limitedBytes(await fetch(coverURL, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), signal]) }), 8 * 1024 * 1024);
        coverPath = path.join(directory, cover.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ? 'cover.png' : 'cover.jpg');
        await fs.writeFile(coverPath, cover, { flag: 'wx' });
      } catch (error) { signal.throwIfAborted(); /* Cover is optional; audio is retained. */ }
    }
    return { source: target, tags: { title: song.title, artist: song.artist, album: song.album }, coverPath };
  }
}

function runFfmpeg(binary, args, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const process = spawn(binary, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    const abort = () => process.kill();
    signal?.addEventListener('abort', abort, { once: true });
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', text => { diagnostic = (diagnostic + text).slice(-24000); });
    process.on('error', error => { signal?.removeEventListener('abort', abort); reject(new Error('无法启动转码工具：' + error.message)); });
    process.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error('音频转换失败：\n' + diagnostic.slice(-2500)));
      else resolve(diagnostic);
    });
  });
}
async function fingerprint(source, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(source, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function convert({ source, tags, coverPath }, folder, bitrate, ffmpeg, temporary, signal) {
  if (![128, 192, 256].includes(bitrate)) throw new Error('不支持的 AAC 码率');
  await fs.mkdir(folder, { recursive: true });
  const hash = await fingerprint(source, signal);
  const title = tags?.title || path.basename(source, path.extname(source));
  const destination = path.join(folder, `${safeName(title)}-${hash.slice(0, 16)}-${bitrate}.m4a`);
  try {
    await fs.access(destination);
    await runFfmpeg(ffmpeg, ['-v', 'error', '-i', destination, '-map', '0:a:0', '-t', '0.05', '-f', 'null', '-'], signal);
    return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = path.join(temporary, 'encoded.m4a');
  const args = ['-n', '-i', source];
  if (coverPath) args.push('-i', coverPath);
  args.push('-map', '0:a:0', '-map', coverPath ? '1:v:0' : '0:v:0?', '-map_metadata', '0', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', `${bitrate}k`, '-ar', '44100', '-ac', '2', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  for (const key of ['title', 'artist', 'album']) if (tags?.[key]) args.push('-metadata', `${key}=${tags[key]}`);
  args.push('-movflags', '+faststart', staging);
  await runFfmpeg(ffmpeg, args, signal);
  await runFfmpeg(ffmpeg, ['-v', 'error', '-i', staging, '-map', '0:a:0', '-t', '0.05', '-f', 'null', '-'], signal);
  signal?.throwIfAborted();
  await fs.copyFile(staging, destination, constants.COPYFILE_EXCL);
  return destination;
}
async function processItem({ item, folder, bitrate, ffmpeg, token }, signal, progress = () => {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'NanoBridge-'));
  try {
    let audio;
    if (item.song) {
      progress('下载中');
      const api = new NetEase(); api.token = token || '';
      audio = await api.download(item.song, temporary, signal);
    } else if (item.local) {
      progress('解码中');
      audio = path.extname(item.local).toLowerCase() === '.ncm' ? await decodeNcm(item.local, temporary, signal) : { source: item.local };
    } else throw new Error('找不到音乐来源');
    progress('转换中');
    return await convert(audio, folder, bitrate, ffmpeg, temporary, signal);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { FORMATS, aes, ncmMask, decodeNcm, parseLink, safeName, downloadURL, NetEase, runFfmpeg, fingerprint, convert, processItem };
if (!isMainThread) {
  const controller = new AbortController();
  parentPort.on('message', message => { if (message === 'cancel') controller.abort(); });
  processItem(workerData, controller.signal, stage => parentPort.postMessage({ stage }))
    .then(output => parentPort.postMessage({ output }))
    .catch(error => parentPort.postMessage({ error: error.message, cancelled: controller.signal.aborted }))
    .finally(() => parentPort.close());
}
