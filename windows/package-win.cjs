'use strict';
const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { createRequire } = require('node:module');
const { signRelease } = require('./sign-release.cjs');

async function download(url, file) {
  try { if ((await fs.stat(file)).size) return; } catch { }
  console.log('Downloading ' + path.basename(file));
  const head = (await execFile('curl', ['--http1.1', '--fail', '--silent', '--show-error', '--location', '--retry', '2', '--retry-all-errors', '--head', '--max-time', '30', url], { windowsHide: true })).stdout;
  const length = Number([...head.matchAll(/^content-length:\s*(\d+)/gim)].at(-1)?.[1]);
  if (length > 8 * 1024 * 1024 && /accept-ranges:\s*bytes/i.test(head)) {
    const temporary = file + '.partial';
    const output = await fs.open(temporary, 'w');
    const chunkSize = 4 * 1024 * 1024;
    const total = Math.ceil(length / chunkSize);
    let next = 0, done = 0, failure;
    await output.truncate(length);
    try {
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (!failure) {
          const index = next++;
          if (index >= total) return;
          const start = index * chunkSize, end = Math.min(length, start + chunkSize) - 1;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const chunkPath = temporary + '.' + index;
              await execFile('curl', ['--http1.1', '--fail', '--silent', '--show-error', '--location', '--connect-timeout', '30', '--max-time', '120', '--range', `${start}-${end}`, '--output', chunkPath, url], { windowsHide: true });
              const bytes = await fs.readFile(chunkPath);
              await fs.rm(chunkPath);
              if (bytes.length !== end - start + 1) throw new Error('Truncated range');
              let written = 0;
              while (written < bytes.length) written += (await output.write(bytes, written, bytes.length - written, start + written)).bytesWritten;
              done++;
              console.log(path.basename(file) + ': ' + Math.round(done / total * 100) + '%');
              break;
            } catch (error) { console.log(`Retrying ${path.basename(file)} part ${index + 1}: ${error.message}`); if (attempt === 2) { failure = error; return; } }
          }
        }
      }));
    } finally { await output.close(); }
    if (failure) throw failure;
    await fs.rename(temporary, file);
    return;
  }
  const temporary = file + '.partial';
  await execFile('curl', ['--http1.1', '--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '1200', '--output', temporary, url], { windowsHide: true });
  if (length && (await fs.stat(temporary)).size !== length) throw new Error('Download truncated');
  await fs.rename(temporary, file);
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function packageWindows() {
  process.chdir(__dirname);
  const pkg = require('./package.json');
  const version = pkg.devDependencies.electron;
  const cache = path.resolve('../build/windows-cache');
  const output = path.resolve('dist/NanoBridge-Windows-x64');
  await fs.mkdir(cache, { recursive: true });
  const electronName = `electron-v${version}-win32-x64.zip`;
  const electronZip = path.join(cache, electronName);
  const ffmpegGzip = path.join(cache, 'ffmpeg-b6.1.1-win32-x64.gz');
  const ffmpegBase = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
  await Promise.all([
    download(`https://github.com/electron/electron/releases/download/v${version}/${electronName}`, electronZip),
    download(`${ffmpegBase}/ffmpeg-win32-x64.gz`, ffmpegGzip),
    download(`${ffmpegBase}/win32-x64.README`, path.join(cache, 'FFmpeg.README')),
    download(`${ffmpegBase}/win32-x64.LICENSE`, path.join(cache, 'FFmpeg.LICENSE'))
  ]);
  const expected = require('electron/checksums.json')[electronName];
  if (!expected || await sha256(electronZip) !== expected) throw new Error('Electron SHA-256 validation failed');
  console.log('Electron SHA-256 verified. Preparing Windows app…');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  if (process.platform === 'win32') execFileSync('tar', ['-xf', electronZip, '-C', output]);
  else execFileSync('unzip', ['-q', electronZip, '-d', output]);
  const appDirectory = path.join(output, 'resources', 'app');
  await fs.mkdir(appDirectory, { recursive: true });
  for (const file of ['main.cjs', 'preload.cjs', 'core.cjs', 'updater.cjs', 'update-helper.cjs', 'update-config.json', 'renderer.js', 'index.html', 'style.css', 'README.md']) await fs.copyFile(file, path.join(appDirectory, file));
  await fs.cp('assets', path.join(appDirectory, 'assets'), { recursive: true });
  await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, description: pkg.description }));
  // Copy only production dependencies, including each package's license.
  const copied = new Set();
  async function copyPackage(name, from) {
    if (copied.has(name)) return;
    const req = createRequire(path.join(from, 'package.json'));
    let manifest;
    try { manifest = req.resolve(name + '/package.json'); }
    catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; manifest = path.join(path.dirname(req.resolve(name)), 'package.json'); }
    const directory = path.dirname(manifest);
    const info = JSON.parse(await fs.readFile(manifest));
    copied.add(name);
    await fs.cp(directory, path.join(appDirectory, 'node_modules', name), { recursive: true, filter: source =>
      !source.includes(path.sep + 'node_modules' + path.sep + name + path.sep + 'node_modules') &&
      (!source.endsWith('.node') || source.endsWith('index.win32-x64-msvc.node')) });
    for (const dependency of Object.keys(info.dependencies || {})) await copyPackage(dependency, directory);
  }
  for (const dependency of Object.keys(pkg.dependencies)) await copyPackage(dependency, __dirname);
  await fs.mkdir(path.join(output, 'resources', 'bin'), { recursive: true });
  await pipeline(createReadStream(ffmpegGzip), createGunzip(), createWriteStream(path.join(output, 'resources', 'bin', 'ffmpeg.exe')));
  const notices = path.join(output, 'third-party-notices'); await fs.mkdir(notices);
  for (const file of ['FFmpeg.README', 'FFmpeg.LICENSE']) await fs.copyFile(path.join(cache, file), path.join(notices, file));
  await fs.writeFile(path.join(notices, 'Sources.txt'), 'Electron: https://github.com/electron/electron/tree/v' + version + '\nFFmpeg binary and corresponding build/source references: ' + ffmpegBase + '\nFFmpeg upstream source: https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz\nqrcode and dependencies: resources/app/node_modules (license files included)\n');
  const PE = await require('pe-library/cjs').load();
  const ResEdit = await require('resedit/cjs').load();
  const executablePath = path.join(output, 'electron.exe');
  const executable = PE.NtExecutable.from(await fs.readFile(executablePath), { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(await fs.readFile('assets/icon.ico'));
  const icons = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  for (const icon of icons) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, icon.id, icon.lang, iconFile.icons.map(i => i.data));
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  for (const info of versions) {
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    info.setFileVersion(major, minor, patch, 0, 1033);
    info.setProductVersion(major, minor, patch, 0, 1033);
    info.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'NanoBridge', ProductName: 'NanoBridge', InternalName: 'NanoBridge', OriginalFilename: 'NanoBridge.exe', CompanyName: 'NanoBridge' });
    info.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  await fs.writeFile(path.join(output, 'NanoBridge.exe'), Buffer.from(executable.generate()));
  await fs.rm(executablePath);
  await fs.copyFile('README.md', path.join(output, '使用说明.md'));
  const archive = path.resolve(`dist/NanoBridge-${pkg.version}-Windows-x64.zip`);
  await fs.rm(archive, { force: true });
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(output)} -DestinationPath ${quote(archive)}`]);
  } else execFileSync('zip', ['-q', '-r', archive, path.basename(output)], { cwd: path.dirname(output) });
  const checksum = await sha256(archive);
  await fs.writeFile(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`);
  const manifest = await signRelease(archive, pkg.version);
  console.log(archive);
  console.log('Upload alongside the ZIP: ' + manifest + ' and ' + manifest + '.sig');
  console.log('SHA-256: ' + checksum);
}
module.exports = { download };
if (require.main === module) packageWindows().catch(error => { console.error(error); process.exitCode = 1; });
