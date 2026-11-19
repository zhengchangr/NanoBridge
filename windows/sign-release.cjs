'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fingerprint } = require('./core.cjs');
const { verifyManifest, releaseURL } = require('./updater.cjs');
const config = require('./update-config.json');

async function signRelease(archive, version) {
  const manifestFile = path.join(path.dirname(archive), 'windows-update.json');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version, platform: 'win32', arch: 'x64',
    url: `${releaseURL}/download/v${version}/${path.basename(archive)}`, size: (await fs.stat(archive)).size,
    sha256: await fingerprint(archive) }, null, 2) + '\n');
  await fs.writeFile(manifestFile, bytes);
  let signature;
  if (process.env.NANOBRIDGE_SIGNING_KEY_FILE) {
    const seed = Buffer.from((await fs.readFile(process.env.NANOBRIDGE_SIGNING_KEY_FILE, 'utf8')).trim(), 'base64');
    if (seed.length !== 32) throw new Error('签名私钥文件必须为 Sparkle 导出的 32 字节 Ed25519 seed（Base64）');
    const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der' });
    const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    if (publicKey !== config.publicKey) throw new Error('签名私钥与应用内公钥不匹配');
    signature = crypto.sign(null, bytes, key).toString('base64');
  } else if (process.platform === 'darwin') {
    const bin = path.resolve(__dirname, '../build/Sparkle-2.10.1/bin');
    const account = 'local.caoyun.nanobridge.sparkle';
    const publicKey = execFileSync(path.join(bin, 'generate_keys'), ['--account', account, '-p'], { encoding: 'utf8' }).trim();
    if (publicKey !== config.publicKey) throw new Error('钥匙串签名密钥与应用内公钥不匹配');
    signature = execFileSync(path.join(bin, 'sign_update'), ['--account', account, '-p', manifestFile], { encoding: 'utf8' }).trim();
  } else throw new Error('请用 NANOBRIDGE_SIGNING_KEY_FILE 指定原发行签名私钥文件，或在持有原钥匙串的 Mac 上签名');
  verifyManifest(bytes, signature);
  await fs.writeFile(manifestFile + '.sig', signature + '\n');
  return manifestFile;
}
module.exports = { signRelease };
if (require.main === module) signRelease(path.resolve(process.argv[2]), process.argv[3] || require('./package.json').version)
  .then(file => console.log('Signed update manifest: ' + file)).catch(error => { console.error(error.message); process.exitCode = 1; });
