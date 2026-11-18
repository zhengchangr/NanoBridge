'use strict';
const $ = id => document.getElementById(id);
let state = { items: [], busy: false };
function errorDialog(error) { $('error-message').textContent = error.message || String(error); if (!$('error-dialog').open) $('error-dialog').showModal(); }
async function call(name, argument) { try { return await window.nano[name](argument); } catch (error) { errorDialog(error); throw error; } }
function on(id, handler) { $(id).addEventListener('click', () => Promise.resolve().then(handler).catch(() => {})); }
function text(tag, content, className) { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; }
function render(next) {
  state = next;
  $('status').textContent = state.status;
  $('count').textContent = state.items.length;
  $('output-folder').textContent = state.outputFolder || '';
  $('output-folder').title = state.outputFolder || '';
  $('bitrate').value = String(state.bitrate);
  $('account-status').textContent = state.loggedIn ? '已登录网易云 · 按账号权限下载' : '未登录 · 可尝试下载免费歌曲';
  $('login-button').textContent = state.loggedIn ? '退出登录' : '▦ 网易云登录';
  for (const id of ['pick-files', 'pick-folder', 'resolve', 'clear', 'login-button', 'pick-output', 'bitrate', 'links']) $(id).disabled = state.busy;
  $('clear').disabled ||= !state.items.length;
  $('resolve').disabled ||= !$('links').value.trim();
  $('run').hidden = state.busy;
  $('stop').hidden = !state.busy;
  $('run').disabled = !state.items.some(i => ['等待处理', '失败', '已取消'].includes(i.stage));
  $('run').textContent = state.items.some(i => i.stage === '失败') ? '▶ 转换 / 重试失败项' : '▶ 转换为 AAC';
  if (state.qrImage) { $('qr-image').src = state.qrImage; $('qr-image').hidden = false; $('qr-loading').hidden = true; }
  else { $('qr-image').removeAttribute('src'); $('qr-image').hidden = true; $('qr-loading').hidden = false; }
  $('login-message').textContent = state.loginMessage || '正在生成二维码…';
  if (!state.items.length) {
    $('queue').replaceChildren();
    const empty = text('div', '', 'empty');
    empty.append(text('div', '♫', 'empty-symbol'), text('h3', '下一站，你的 iPod'), text('p', '添加链接，或拖入 NCM、FLAC、MP3 等音乐文件。'));
    $('queue').append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  state.items.forEach((item, index) => {
    const row = text('div', '', 'track');
    const body = text('div', '', 'track-body');
    body.append(text('div', item.title, 'track-title'), text('div', item.subtitle, 'track-subtitle'));
    if (item.message) body.append(text('div', item.message, 'track-message' + (item.stage === '失败' ? ' failure' : '')));
    const stage = text('span', item.stage, 'stage' + (item.stage === '已转换' ? ' success' : item.stage === '失败' ? ' failure' : ''));
    const actions = text('div', '', 'track-actions');
    if (item.output) {
      const show = text('button', '↗'); show.title = '在文件管理器中显示'; show.setAttribute('aria-label', '显示 ' + item.title);
      show.onclick = () => call('show-output', item.id).catch(() => {}); actions.append(show);
    }
    if (!state.busy) {
      const remove = text('button', '×'); remove.title = '移出队列，保留文件'; remove.setAttribute('aria-label', '移出 ' + item.title);
      remove.onclick = () => call('remove', item.id).catch(() => {}); actions.append(remove);
    }
    row.append(text('span', String(index + 1).padStart(2, '0'), 'track-number'), body, stage, actions);
    fragment.append(row);
  });
  $('queue').replaceChildren(fragment);
}
on('pick-files', () => call('pick-files'));
on('pick-folder', () => call('pick-folder'));
on('pick-output', () => call('pick-output'));
on('clear', () => call('clear'));
on('resolve', async () => { const result = await call('resolve', $('links').value); if (!result?.cancelled) { $('links').value = ''; $('resolve').disabled = true; } });
on('run', () => call('run'));
on('stop', () => call('stop'));
on('ipod-tool', () => call('ipod-tool'));
on('guide-button', () => $('guide-dialog').showModal());
on('guide-close', () => $('guide-dialog').close());
on('guide-open', () => call('ipod-tool'));
on('error-close', () => $('error-dialog').close());
$('links').addEventListener('input', () => { $('resolve').disabled = state.busy || !$('links').value.trim(); });
$('bitrate').addEventListener('change', () => call('settings', { bitrate: Number($('bitrate').value) }).catch(() => {}));
on('login-button', () => {
  if (state.loggedIn) return call('logout');
  $('login-dialog').showModal();
  call('login-start').catch(() => {});
});
on('login-refresh', () => { call('login-start').catch(() => {}); });
on('login-close', () => $('login-dialog').close());
$('login-dialog').addEventListener('close', () => call('login-close').catch(() => {}));
let dragDepth = 0;
document.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; if (!state.busy) document.body.classList.add('dragging'); });
document.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = state.busy ? 'none' : 'copy'; });
document.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  if (state.busy) return;
  const files = [...event.dataTransfer.files].map(file => window.nano.filePath(file)).filter(Boolean);
  if (files.length) call('drop-files', files).catch(() => {});
});
window.nano.onState(render);
call('state').then(render).catch(() => {});
