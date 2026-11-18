'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const QRCode = require('qrcode');
const { FORMATS, NetEase } = require('./core.cjs');

app.setName('NanoBridge');
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'NanoBridge'));
const api = new NetEase();
const state = { items: [], busy: false, loggedIn: false, status: '把喜欢的音乐，带回口袋。', bitrate: 256, outputFolder: '', loginMessage: '', qrImage: null };
let window, worker, stopping = false, loginController, loginKey, resolveController, allowQuit = false;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const credentialPath = () => path.join(app.getPath('userData'), 'login.bin');
const ffmpegPath = () => app.isPackaged ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe') : require('ffmpeg-static');
function emit() { if (window && !window.isDestroyed()) window.webContents.send('state', state); }
function update(patch) { Object.assign(state, patch); emit(); }
async function saveSettings() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const temporary = settingsPath() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify({ bitrate: state.bitrate, outputFolder: state.outputFolder }));
  await fs.rename(temporary, settingsPath());
}
async function loadSettings() {
  state.outputFolder = path.join(app.getPath('music'), 'NanoBridge');
  try {
    const data = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    if ([128, 192, 256].includes(data.bitrate)) state.bitrate = data.bitrate;
    if (typeof data.outputFolder === 'string' && path.isAbsolute(data.outputFolder)) state.outputFolder = data.outputFolder;
  } catch { /* First launch or missing settings: use defaults. */ }
  try {
    const encrypted = await fs.readFile(credentialPath());
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    api.token = decrypted.result;
    state.loggedIn = Boolean(api.token);
    if (decrypted.shouldReEncrypt) {
      try { await fs.writeFile(credentialPath(), await safeStorage.encryptStringAsync(api.token), { mode: 0o600 }); }
      catch { /* A failed key rotation must not discard the active session. */ }
    }
  } catch { /* Unavailable OS credential store: user can log in again. */ }
}
async function addFiles(paths) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('文件路径无效');
  const known = new Set(state.items.map(i => i.local).filter(Boolean));
  stopping = false;
  let added = 0;
  async function visit(file) {
    if (stopping) return;
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const child of await fs.readdir(file, { withFileTypes: true })) if (!child.name.startsWith('.')) await visit(path.join(file, child.name));
    } else if (info.isFile() && FORMATS.has(path.extname(file).slice(1).toLowerCase()) && !known.has(file)) {
      known.add(file);
      state.items.push({ id: crypto.randomUUID(), title: path.basename(file, path.extname(file)), subtitle: path.extname(file).slice(1).toUpperCase() + ' · 本地文件', local: file, stage: '等待处理' });
      added++;
    }
  }
  for (const file of paths) await visit(file);
  update({ status: stopping ? `已停止添加文件；已加入 ${added} 首音乐。` : added ? `已添加 ${added} 首音乐` : '没有新的支持文件，可添加 NCM、MP3、FLAC、M4A、WAV。' });
}
function oneItem(item) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const current = new Worker(path.join(__dirname, 'core.cjs'), { workerData: { item, folder: state.outputFolder, bitrate: state.bitrate, ffmpeg: ffmpegPath(), token: api.token } });
    worker = current;
    current.on('message', result => {
      if (result.stage) { item.stage = result.stage; emit(); }
      else {
        settled = true;
        if (result.output) resolve(result.output);
        else { const error = new Error(result.error || '转换失败'); error.cancelled = result.cancelled; reject(error); }
      }
    });
    current.once('error', reject);
    current.once('exit', code => { if (worker === current) worker = null; if (!settled) reject(new Error(`转码任务意外结束（${code}）`)); });
    if (stopping) current.postMessage('cancel');
  });
}
async function runQueue() {
  stopping = false;
  const pending = state.items.filter(i => ['等待处理', '失败', '已取消'].includes(i.stage));
  if (!pending.length) return;
  update({ busy: true });
  try {
    await fs.access(ffmpegPath());
    for (const [index, item] of pending.entries()) {
      if (stopping) break;
      item.message = '';
      update({ status: `${index + 1} / ${pending.length} · ${item.title}` });
      try {
        item.output = await oneItem(item);
        item.stage = '已转换';
        item.message = 'AAC 文件已保存，可通过 iPod 导入工具传输。';
      } catch (error) { item.stage = stopping || error.cancelled ? '已取消' : '失败'; item.message = error.message; }
      emit();
    }
    const done = state.items.filter(i => i.stage === '已转换').length;
    const failed = state.items.filter(i => i.stage === '失败').length;
    update({ status: stopping ? '已停止；已完成的音频仍然保留。' : `处理结束 · ${done} 首已转换${failed ? ` · ${failed} 首失败，可重试` : ''}` });
  } finally { update({ busy: false }); }
}
function register(name, handler, { busy = false } = {}) {
  ipcMain.handle(name, async (event, argument) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pathToFileURL(path.join(__dirname, 'index.html')).href) return { error: '无效的调用来源' };
    if (state.busy && !busy) return { error: '当前任务还在处理中' };
    try { return { value: await handler(argument) }; }
    catch (error) { return { error: error.message }; }
  });
}
register('state', () => state, { busy: true });
register('pick-files', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: '音频文件', extensions: [...FORMATS] }] });
  if (!result.canceled) { update({ busy: true }); try { await addFiles(result.filePaths); } finally { update({ busy: false }); } }
});
register('pick-folder', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
  if (!result.canceled) { update({ busy: true }); try { await addFiles(result.filePaths); } finally { update({ busy: false }); } }
});
register('drop-files', async paths => { update({ busy: true }); try { await addFiles(paths); } finally { update({ busy: false }); } });
register('resolve', async input => {
  if (typeof input !== 'string' || input.length > 50000) throw new Error('链接输入过长');
  update({ busy: true, status: '正在读取网易云歌曲信息…' });
  stopping = false;
  const controller = new AbortController(); resolveController = controller;
  const failures = []; let added = 0;
  try {
    const known = new Set(state.items.map(i => i.song?.id).filter(Boolean));
    const lines = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (controller.signal.aborted) break;
      try {
        const songs = await api.songs(line, controller.signal);
        if (!songs.length) throw new Error('链接没有返回可读取的歌曲');
        for (const song of songs) if (!known.has(song.id)) {
          known.add(song.id); added++;
          state.items.push({ id: crypto.randomUUID(), title: song.title, subtitle: song.artist + ' · 网易云', song, stage: '等待处理' });
        }
      } catch (error) { if (!controller.signal.aborted) failures.push(error.message); }
    }
  } finally { resolveController = null; update({ busy: false, status: `${controller.signal.aborted ? '已停止读取 · ' : ''}已添加 ${added} 首音乐${failures.length ? '，部分链接读取失败' : ''}` }); }
  if (failures.length) throw new Error(failures.join('\n'));
  return { cancelled: controller.signal.aborted };
});
register('settings', async data => {
  if (data?.bitrate != null) {
    if (![128, 192, 256].includes(data.bitrate)) throw new Error('码率无效');
    state.bitrate = data.bitrate;
  }
  await saveSettings(); emit();
});
register('pick-output', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled) { state.outputFolder = result.filePaths[0]; await saveSettings(); emit(); }
});
register('show-output', async id => {
  const item = state.items.find(i => i.id === id);
  if (item?.output) shell.showItemInFolder(item.output);
  else { await fs.mkdir(state.outputFolder, { recursive: true }); const error = await shell.openPath(state.outputFolder); if (error) throw new Error(error); }
}, { busy: true });
register('remove', id => { state.items = state.items.filter(i => i.id !== id); emit(); });
register('clear', () => update({ items: [], status: '把喜欢的音乐，带回口袋。' }));
register('run', () => { runQueue().catch(error => update({ status: error.message, busy: false })); });
register('stop', () => { stopping = true; worker?.postMessage('cancel'); resolveController?.abort(); update({ status: '正在停止当前任务…' }); }, { busy: true });
register('ipod-tool', () => shell.openExternal('https://tunesreloaded.com'), { busy: true });
register('login-start', async () => {
  loginController?.abort();
  const controller = new AbortController(); loginController = controller;
  update({ qrImage: null, loginMessage: '正在生成二维码…' });
  try {
    const key = await api.loginKey(controller.signal);
    controller.signal.throwIfAborted();
    loginKey = key;
    update({ qrImage: await QRCode.toDataURL('https://music.163.com/login?codekey=' + key, { width: 280, margin: 2, errorCorrectionLevel: 'M' }), loginMessage: '使用网易云音乐 App 扫码登录' });
    for (let i = 0; i < 90; i++) {
      await require('node:timers/promises').setTimeout(2000, undefined, { signal: controller.signal });
      const { code, token } = await api.checkLogin(key, controller.signal);
      controller.signal.throwIfAborted();
      if (loginKey !== key) return;
      if (code === 800) throw new Error('二维码已过期，请点击刷新');
      if (code === 802) update({ loginMessage: '已扫码，请在手机上确认' });
      if (code === 803) {
        if (!token) throw new Error('没有取得登录凭证，请刷新重试');
        api.token = token;
        let stored = false;
        try {
          if (await safeStorage.isAsyncEncryptionAvailable()) {
            const encrypted = await safeStorage.encryptStringAsync(token);
            await fs.mkdir(app.getPath('userData'), { recursive: true });
            await fs.writeFile(credentialPath(), encrypted, { mode: 0o600 });
            stored = true;
          }
        } catch { /* Keep session in memory if the OS credential store is unavailable. */ }
        update({ loggedIn: true, loginMessage: stored ? '登录成功，凭证已加密保存在本机。' : '登录成功；系统加密暂不可用，本次登录仅在退出前有效。' });
        return;
      }
    }
    update({ loginMessage: '二维码已过期，请点击刷新' });
  } catch (error) { if (!controller.signal.aborted) update({ loginMessage: error.message }); }
});
register('login-close', () => { loginController?.abort(); loginKey = null; }, { busy: true });
register('logout', async () => {
  loginController?.abort(); api.token = '';
  await fs.rm(credentialPath(), { force: true }); update({ loggedIn: false });
});

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  await loadSettings();
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1120, height: 800, minWidth: 940, minHeight: 680, title: 'NanoBridge', backgroundColor: '#f7faf9', icon: path.join(__dirname, 'assets', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.on('close', async event => {
    if (!state.busy || allowQuit) return;
    event.preventDefault();
    const answer = await dialog.showMessageBox(window, { type: 'question', message: '音乐正在处理中', detail: '退出会停止当前任务，已完成的文件仍然保留。', buttons: ['继续处理', '停止并退出'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) { allowQuit = true; stopping = true; await worker?.terminate(); app.quit(); }
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('window-all-closed', () => { loginController?.abort(); app.quit(); });
