'use strict';
// Copy .asar files as physical files, not Electron's virtual archive directories.
const disk = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = disk.promises;
const { createWriteStream } = disk;
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { fingerprint } = require('./core.cjs');
const config = require('./update-config.json');
const releaseURL = `https://github.com/${config.repository}/releases`;
const feedURL = `${releaseURL}/latest/download/windows-update.json`;
const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(config.publicKey, 'base64')]), type: 'spki', format: 'der' });

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('更新版本号无效');
  const parts = value.split('.').map(Number);
  if (parts.some(n => !Number.isSafeInteger(n))) throw new Error('更新版本号无效');
  return parts;
}
function newer(version, current) {
  const a = versionParts(version), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function verifyManifest(bytes, signature) {
  const encoded = String(signature).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded) || !crypto.verify(null, bytes, publicKey, Buffer.from(encoded, 'base64'))) throw new Error('更新清单签名无效，已拒绝更新');
  const manifest = JSON.parse(bytes);
  versionParts(manifest.version);
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 512 * 1024 * 1024 ||
      manifest.url !== `${releaseURL}/download/v${manifest.version}/NanoBridge-${manifest.version}-Windows-x64.zip`) throw new Error('更新清单内容无效');
  return manifest;
}
async function fetchRelease(url, timeout = 30000, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'NanoBridge-Updater', 'Cache-Control': 'no-cache' } });
  if (response.status === 404) throw new Error('尚未发布 Windows 更新，请稍后再检查');
  if (!response.ok) throw new Error(`无法获取更新（HTTP ${response.status}），请稍后重试`);
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('更新连接不安全');
  return response;
}
async function limitedBody(response, limit) {
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('更新清单过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function verifyArchive(file, manifest) {
  if ((await fs.stat(file)).size !== manifest.size || await fingerprint(file) !== manifest.sha256) throw new Error('更新包校验失败，已保留当前版本');
}
async function downloadArchive(response, file, manifest, progress = () => {}) {
  let total = 0, percent = -1;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      total += chunk.length;
      if (total > manifest.size) { done(new Error('更新包大小超出清单')); return; }
      const next = Math.floor(total / manifest.size * 100);
      if (next !== percent) { percent = next; progress(percent); }
      done(null, chunk);
    } }), createWriteStream(file, { flags: 'wx' }));
    await verifyArchive(file, manifest);
  } catch (error) { await fs.rm(file, { force: true }); throw error; }
}
async function stageArchive(archive, directory, manifest) {
  await verifyArchive(archive, manifest);
  // Use the exact, hardened extractor already shipped with our pinned Electron tooling.
  const extract = (await import('@electron-internal/extract-zip')).default;
  await extract(archive, { dir: directory });
  let total = 0, count = 0;
  async function validateTree(dir) {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || ++count > 10000) throw new Error('更新包目录结构无效');
      if (stat.isDirectory()) await validateTree(file);
      else if (!stat.isFile() || (total += stat.size) > 2 * 1024 ** 3) throw new Error('更新包大小异常');
    }
  }
  const names = await fs.readdir(directory);
  if (names.length !== 1 || names[0] !== 'NanoBridge-Windows-x64') throw new Error('更新包目录结构无效');
  await validateTree(directory);
  const root = path.join(directory, 'NanoBridge-Windows-x64');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'resources', 'app', 'package.json'), 'utf8'));
  if (pkg.name !== 'nanobridge' || pkg.version !== manifest.version || pkg.main !== 'main.cjs') throw new Error('更新包与目标版本不匹配');
  for (const file of ['NanoBridge.exe', 'resources/bin/ffmpeg.exe', 'resources/app/main.cjs', 'resources/app/update-helper.cjs']) await fs.access(path.join(root, file));
  return root;
}

class WindowsUpdater {
  constructor({ version, directory, target, supported, getActivity, changed, preferences = {}, fetcher = fetch }) {
    this.directory = directory; this.target = target; this.getActivity = getActivity; this.changed = changed; this.fetcher = fetcher;
    this.state = { currentVersion: version, phase: 'idle', message: '点击“立即检查”查找新版本。', latestVersion: null, progress: 0,
      supported, automaticChecks: preferences.automaticChecks !== false, automaticDownloads: preferences.automaticDownloads === true, lastCheck: preferences.lastCheck || 0 };
    this.ready = null; this.manifest = null; this.signed = null; this.installRequested = false;
  }
  patch(patch) { Object.assign(this.state, patch); this.changed(); }
  get active() { return ['checking', 'downloading', 'installing'].includes(this.state.phase); }
  get occupied() { const activity = this.getActivity(); return activity.busy || activity.count > 0; }
  async restore() {
    try {
      const pending = JSON.parse(await fs.readFile(path.join(this.directory, 'pending.json'), 'utf8'));
      const bytes = Buffer.from(pending.manifest, 'base64');
      const manifest = verifyManifest(bytes, pending.signature);
      if (!newer(manifest.version, this.state.currentVersion)) { await fs.rm(path.join(this.directory, 'pending.json'), { force: true }); return; }
      if (!/^[0-9a-f-]{36}$/.test(pending.id)) throw new Error('更新缓存无效');
      const archive = path.join(this.directory, pending.id, 'update.zip');
      await verifyArchive(archive, manifest);
      this.ready = { archive, id: pending.id, manifest };
      this.patch({ phase: 'ready', latestVersion: manifest.version, message: `版本 ${manifest.version} 已下载并验证，可安装更新。` });
    } catch (error) {
      if (error.code !== 'ENOENT') this.patch({ phase: 'error', message: '更新缓存验证失败，请重新检查并下载更新。' });
    }
    try {
      const failure = await fs.readFile(path.join(this.directory, 'last-error.txt'), 'utf8');
      await fs.rm(path.join(this.directory, 'last-error.txt'), { force: true });
      this.patch({ phase: this.ready ? 'ready' : 'error', message: `上次更新未完成，已保留旧版本。${failure}` });
    } catch { /* No previous installation failure. */ }
  }
  async check() {
    if (this.active) return;
    if (this.getActivity().busy) throw new Error('音乐正在处理中，请在任务完成后检查更新');
    this.patch({ phase: 'checking', message: '正在检查 GitHub 最新版本…' });
    try {
      const [bytes, signature] = await Promise.all([
        fetchRelease(feedURL, 30000, this.fetcher).then(r => limitedBody(r, 32768)),
        fetchRelease(feedURL + '.sig', 30000, this.fetcher).then(r => limitedBody(r, 256))
      ]);
      const manifest = verifyManifest(bytes, signature);
      this.state.lastCheck = Date.now();
      if (!newer(manifest.version, this.state.currentVersion)) {
        this.manifest = null; this.signed = null; this.ready = null; this.installRequested = false;
        this.patch({ phase: 'current', latestVersion: manifest.version, message: `您使用的就是最新版（${this.state.currentVersion}）。` });
      } else if (this.ready?.manifest.version === manifest.version && this.ready.manifest.sha256 === manifest.sha256) {
        this.patch({ phase: 'ready', latestVersion: manifest.version, message: `版本 ${manifest.version} 已下载并验证，可安装更新。` });
      } else {
        this.ready = null; this.manifest = manifest; this.signed = { manifest: bytes.toString('base64'), signature: String(signature).trim() };
        this.patch({ phase: 'available', latestVersion: manifest.version, message: `发现新版本 ${manifest.version}，可下载并安装。` });
        if (this.state.automaticDownloads && this.state.supported) await this.download();
      }
    } catch (error) { this.patch({ phase: this.ready ? 'ready' : 'error', message: error.message }); throw error; }
  }
  async download() {
    if (!this.state.supported) throw new Error('自动安装仅支持打包后的 Windows x64 版本');
    if (this.active || !this.manifest || !this.signed) return;
    const manifest = this.manifest, signed = this.signed, id = crypto.randomUUID();
    const directory = path.join(this.directory, id), archive = path.join(directory, 'update.zip');
    this.patch({ phase: 'downloading', message: '正在下载更新…', progress: 0 });
    try {
      await fs.mkdir(directory, { recursive: true });
      const response = await fetchRelease(manifest.url, 30 * 60 * 1000, this.fetcher);
      await downloadArchive(response, archive, manifest, progress => this.patch({ progress, message: `正在下载更新… ${progress}%` }));
      await fs.writeFile(path.join(this.directory, 'pending.json.tmp'), JSON.stringify({ ...signed, id }));
      await fs.rename(path.join(this.directory, 'pending.json.tmp'), path.join(this.directory, 'pending.json'));
      this.ready = { archive, manifest, id };
      this.patch({ phase: 'ready', message: `版本 ${manifest.version} 已下载并验证。${this.state.automaticDownloads ? '退出且队列清空后自动安装。' : '可安装并重新启动。'}` });
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); this.patch({ phase: 'error', message: error.message }); throw error; }
  }
  requestInstall() {
    if (!this.ready || this.state.phase === 'installing') return;
    this.installRequested = true;
    if (this.occupied) this.patch({ phase: 'deferred', message: '更新已准备好。处理完成并清空队列后，将自动安装并重新启动。' });
    else this.changed();
  }
  async prepareInstall() {
    if (!this.ready || !this.state.supported || this.occupied || this.state.phase === 'installing') return null;
    const { archive, id, manifest } = this.ready;
    this.patch({ phase: 'installing', message: '正在准备安装更新…' });
    const work = path.join(this.directory, id);
    const parent = path.dirname(this.target), candidate = path.join(parent, `.NanoBridge-update-${id}`), backup = path.join(parent, `.NanoBridge-previous-${id}`);
    try {
      const extracted = await stageArchive(archive, path.join(work, 'extracted'), manifest);
      await fs.rm(candidate, { recursive: true, force: true });
      await fs.cp(extracted, candidate, { recursive: true, errorOnExist: true, force: false });
      const helper = path.join(work, 'helper'); await fs.mkdir(helper, { recursive: true });
      // Run a copy of the installed runtime so Windows can unlock both app directories.
      for (const entry of await fs.readdir(this.target, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name === 'NanoBridge.exe' || /\.(dll|bin|dat)$/i.test(entry.name))) await fs.copyFile(path.join(this.target, entry.name), path.join(helper, entry.name));
      }
      await fs.copyFile(path.join(__dirname, 'update-helper.cjs'), path.join(helper, 'update-helper.cjs'));
      for (const file of [path.join(helper, 'ready'), path.join(work, 'started.json'), path.join(work, 'complete')]) await fs.rm(file, { force: true });
      const plan = { parentPid: process.pid, target: this.target, candidate, backup, work, version: manifest.version, id };
      await fs.writeFile(path.join(helper, 'plan.json'), JSON.stringify(plan));
      return { helper, plan };
    } catch (error) { await fs.rm(candidate, { recursive: true, force: true }); this.installRequested = false; this.patch({ phase: 'ready', message: `无法准备更新，当前版本保持不变。${error.message}` }); throw error; }
  }
  async launchInstaller(prepared) {
    const { helper } = prepared;
    const log = await fs.open(path.join(helper, 'install.log'), 'a');
    let child;
    try {
      child = spawn(path.join(helper, 'NanoBridge.exe'), [path.join(helper, 'update-helper.cjs'), path.join(helper, 'plan.json')], {
        detached: true, cwd: helper, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', log.fd, log.fd]
      });
      let failed; child.once('error', error => { failed = error; }); child.unref();
      for (let i = 0; i < 100; i++) {
        if (failed) throw failed;
        try { await fs.access(path.join(helper, 'ready')); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      throw new Error('更新安装程序未能启动');
    } catch (error) { child?.kill(); throw error; }
    finally { await log.close(); }
  }
}
module.exports = { WindowsUpdater, verifyManifest, verifyArchive, stageArchive, downloadArchive, newer, feedURL, releaseURL };
