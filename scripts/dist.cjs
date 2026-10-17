'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { DebugLogger } = require('builder-util');
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');

const projectDir = path.resolve(__dirname, '..');
const configFile = path.join(projectDir, 'electron-builder.yml');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const unsupported = [...args].filter(arg => arg !== '--dir' && arg !== '--check');
  if (unsupported.length) throw new Error(`Unsupported build option: ${unsupported.join(', ')}`);

  const config = await getConfig(projectDir, configFile, null);
  await validateConfiguration(config, new DebugLogger(false));
  if (args.has('--check')) {
    console.log('Windows distribution configuration is valid.');
    return;
  }

  if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows (or use the Windows release workflow).');

  // Empty CI secrets mean an explicitly unsigned beta. A supplied certificate
  // makes signing mandatory, so a broken credential cannot silently ship unsigned.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
    if (process.env[key] === '') delete process.env[key];
  }
  config.forceCodeSigning = !!(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
  const directoryOnly = args.has('--dir');
  const artifacts = await build({
    projectDir,
    config,
    targets: Platform.WINDOWS.createTarget(directoryOnly ? 'dir' : 'nsis', Arch.x64),
    publish: 'never'
  });

  if (directoryOnly) {
    console.log('Unpacked Windows application is ready.');
    return;
  }

  const installers = artifacts.filter(file => /^Orbit-Setup-.+-x64\.exe$/i.test(path.basename(file)));
  if (!installers.length) throw new Error('The installer build did not produce an Orbit Setup executable.');
  const lines = await Promise.all(installers.map(async file => `${await sha256(file)}  ${path.basename(file)}`));
  const checksumFile = path.join(path.dirname(installers[0]), 'SHA256SUMS.txt');
  await fs.writeFile(checksumFile, lines.join('\n') + '\n', 'utf8');
  console.log([...installers, checksumFile].join('\n'));
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
