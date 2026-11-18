'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const methods = ['state', 'pick-files', 'pick-folder', 'drop-files', 'resolve', 'settings', 'pick-output', 'show-output', 'remove', 'clear', 'run', 'stop', 'ipod-tool', 'login-start', 'login-close', 'logout'];
const api = {};
for (const name of methods) api[name] = async argument => {
  const result = await ipcRenderer.invoke(name, argument);
  if (result.error) throw new Error(result.error);
  return result.value;
};
api.onState = callback => { ipcRenderer.on('state', (_event, state) => callback(state)); };
api.filePath = file => webUtils.getPathForFile(file);
contextBridge.exposeInMainWorld('nano', api);
