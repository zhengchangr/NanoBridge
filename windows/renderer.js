'use strict';
const $ = id => document.getElementById(id);
let state = { items: [], busy: false };
function errorDialog(error) { $('error-message').textContent = error.message || String(error); if (!$('error-dialog').open) $('error-dialog').showModal(); }
async function call(name, argument) { try { return await window.nano[name](argument); } catch (error) { errorDialog(error); throw error; } }
function on(id, handler) { $(id).addEventListener('click', () => Promise.resolve().then(handler).catch(() => {})); }
function text(tag, content, className) { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; }
function render(next) {
  state = next;
  const updating = state.update?.phase === 'installing';
  const locked = state.busy || updating;
  $('status').textContent = !state.items.length && state.status === '把喜欢的音乐，带回口袋。' ? '先添加音乐，再开始转换。' : state.status;
  $('count').textContent = state.items.length + ' 首音乐';
  $('output-summary').textContent = `AAC · ${state.bitrate} kbps · 仅保存文件`;
  $('output-folder').textContent = state.outputFolder || '';
  $('output-folder').title = state.outputFolder || '';
  $('bitrate').value = String(state.bitrate);
  $('account-status').textContent = state.loggedIn ? '已登录网易云 · 按账号权限下载' : '未登录 · 可尝试下载免费歌曲';
  $('login-button').textContent = state.loggedIn ? '退出登录' : '▦ 网易云登录';
  for (const id of ['pick-files', 'pick-folder', 'resolve', 'clear', 'login-button', 'pick-output', 'bitrate', 'links', 'source-local', 'source-online', 'settings-button']) $(id).disabled = locked;
  $('clear').disabled ||= !state.items.length;
  $('resolve').disabled ||= !$('links').value.trim();
  $('run').hidden = state.busy;
  $('stop').hidden = !state.busy;
  $('run').disabled = locked || !state.items.some(i => ['等待处理', '失败', '已取消'].includes(i.stage));
  $('run').textContent = state.items.some(i => i.stage === '失败') ? '▶ 转换 / 重试失败项' : '▶ 开始转换为 AAC';
  const u = state.update || {};
  $('updates-button').textContent = u.phase === 'deferred' ? '↓ 更新待安装' : u.phase === 'ready' ? '↓ 更新已就绪' : '↓ 检查更新';
  $('current-version').textContent = '当前版本 ' + (u.currentVersion || '—');
  $('auto-check').checked = Boolean(u.automaticChecks);
  $('auto-download').checked = Boolean(u.automaticDownloads);
  $('auto-check').disabled = updating;
  $('auto-download').disabled = updating || !u.automaticChecks;
  $('update-status').textContent = u.message || '点击“立即检查”查找新版本。';
  $('update-progress').hidden = u.phase !== 'downloading';
  $('update-progress').value = u.progress || 0;
  $('update-check').disabled = state.busy || ['checking', 'downloading', 'installing', 'deferred'].includes(u.phase);
  $('update-download').hidden = u.phase !== 'available';
  $('update-download').disabled = !u.supported;
  $('update-download').title = u.supported ? '' : '自动安装仅支持打包后的 Windows x64 版本';
  $('update-install').hidden = !['ready', 'deferred'].includes(u.phase);
  $('update-install').disabled = !u.supported || u.phase === 'deferred';
  if (state.qrImage) { $('qr-image').src = state.qrImage; $('qr-image').hidden = false; $('qr-loading').hidden = true; }
  else { $('qr-image').removeAttribute('src'); $('qr-image').hidden = true; $('qr-loading').hidden = false; }
  $('login-message').textContent = state.loginMessage || '正在生成二维码…';
  if (!state.items.length) {
    $('queue').replaceChildren();
    const empty = text('div', '', 'empty');
    empty.append(text('h3', '还没有添加音乐'), text('p', '从上方添加后，在这里查看队列和转换进度。'));
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
    if (!locked) {
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
on('settings-button', () => $('settings-dialog').showModal());
on('settings-close', () => $('settings-dialog').close());
on('updates-button', () => $('updates-dialog').showModal());
on('updates-close', () => $('updates-dialog').close());
on('update-check', () => window.nano['update-check']().catch(() => {}));
on('update-download', () => window.nano['update-download']().catch(() => {}));
on('update-install', () => call('update-install'));
on('releases', () => call('update-releases'));
$('auto-check').addEventListener('change', () => call('update-settings', { automaticChecks: $('auto-check').checked }).catch(() => {}));
$('auto-download').addEventListener('change', () => call('update-settings', { automaticDownloads: $('auto-download').checked }).catch(() => {}));
function selectSource(source, focus = false) {
  for (const name of ['local', 'online']) {
    const selected = name === source, tab = $('source-' + name);
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(name + '-source').hidden = !selected;
    if (selected && focus) tab.focus();
  }
}
for (const name of ['local', 'online']) {
  on('source-' + name, () => selectSource(name));
  $('source-' + name).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); selectSource(event.key === 'Home' ? 'local' : event.key === 'End' ? 'online' : name === 'local' ? 'online' : 'local', true);
    }
  });
}
on('guide-button', () => $('guide-dialog').showModal());
on('guide-close', () => $('guide-dialog').close());
on('guide-open', () => call('ipod-tool'));
on('error-close', () => $('error-dialog').close());
$('links').addEventListener('input', () => { $('resolve').disabled = state.busy || state.update?.phase === 'installing' || !$('links').value.trim(); });
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
document.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; if (!state.busy && state.update?.phase !== 'installing') document.body.classList.add('dragging'); });
document.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = state.busy || state.update?.phase === 'installing' ? 'none' : 'copy'; });
document.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  if (state.busy || state.update?.phase === 'installing') return;
  const files = [...event.dataTransfer.files].map(file => window.nano.filePath(file)).filter(Boolean);
  if (files.length) call('drop-files', files).catch(() => {});
});
window.nano.onState(render);
call('state').then(render).catch(() => {});
