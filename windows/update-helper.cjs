'use strict';
// Runs outside the portable app directory, after the main process has exited.
const fs = (process.versions.electron ? require('original-fs') : require('node:fs')).promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function validatePlan(plan) {
  if (!plan || !/^[0-9a-f-]{36}$/.test(plan.id) || !Number.isSafeInteger(plan.parentPid) || plan.parentPid < 1 ||
      !/^\d+\.\d+\.\d+$/.test(plan.version) || ['target', 'candidate', 'backup', 'work'].some(key => typeof plan[key] !== 'string' || !path.isAbsolute(plan[key]))) throw new Error('Invalid update installation plan');
  const parent = path.dirname(plan.target);
  if (parent === plan.target || plan.candidate !== path.join(parent, `.NanoBridge-update-${plan.id}`) ||
      plan.backup !== path.join(parent, `.NanoBridge-previous-${plan.id}`) || path.basename(plan.work) !== plan.id) throw new Error('Unsafe update paths');
}
async function retryRename(from, to) {
  for (let i = 0; ; i++) {
    try { await fs.rename(from, to); return; }
    catch (error) { if (i >= 119 || !['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; await delay(250); }
  }
}
async function waitForParent(pid) {
  for (let i = 0; i < 480; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(250);
  }
  throw new Error('应用尚未退出，已取消更新');
}
async function launch(target, id) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(target, 'NanoBridge.exe'), id ? [`--nanobridge-update-id=${id}`] : [], { cwd: target, detached: true, env, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}
async function replaceApplication(plan, start = launch) {
  validatePlan(plan);
  const pkg = JSON.parse(await fs.readFile(path.join(plan.candidate, 'resources', 'app', 'package.json'), 'utf8'));
  if (pkg.name !== 'nanobridge' || pkg.version !== plan.version) throw new Error('待安装版本不匹配');
  let movedOld = false, movedNew = false, child;
  try {
    await retryRename(plan.target, plan.backup); movedOld = true;
    await retryRename(plan.candidate, plan.target); movedNew = true;
    child = await start(plan.target, plan.id);
    let started = false;
    for (let i = 0; i < 300; i++) {
      try {
        const receipt = JSON.parse(await fs.readFile(path.join(plan.work, 'started.json'), 'utf8'));
        if (receipt.version === plan.version) { started = true; break; }
      } catch { /* Wait for the new app's window to finish loading. */ }
      if (child.exitCode != null) break;
      await delay(100);
    }
    if (!started) throw new Error('新版应用未能正常启动，正在恢复旧版');
    // ponytail: retain the old portable folder so files placed there by users remain recoverable.
    await fs.rm(path.join(path.dirname(plan.work), 'pending.json'), { force: true });
    await fs.writeFile(path.join(plan.work, 'complete'), 'complete');
    return true;
  } catch (error) {
    child?.kill();
    if (movedNew) await retryRename(plan.target, plan.candidate);
    if (movedOld) await retryRename(plan.backup, plan.target);
    await fs.writeFile(path.join(path.dirname(plan.work), 'last-error.txt'), error.message);
    await start(plan.target);
    return false;
  }
}
async function main(file) {
  const plan = JSON.parse(await fs.readFile(file, 'utf8'));
  validatePlan(plan);
  await fs.writeFile(path.join(path.dirname(file), 'ready'), 'ready');
  await waitForParent(plan.parentPid);
  await replaceApplication(plan);
}
module.exports = { validatePlan, waitForParent, replaceApplication };
if (require.main === module) main(process.argv[2]).catch(async error => {
  console.error(error);
  try {
    const plan = JSON.parse(await fs.readFile(process.argv[2], 'utf8')); validatePlan(plan);
    await fs.writeFile(path.join(path.dirname(plan.work), 'last-error.txt'), error.message);
    await launch(plan.target);
  } catch { /* The existing application remains available if setup or rollback fails. */ }
  process.exitCode = 1;
});
