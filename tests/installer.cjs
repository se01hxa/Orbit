'use strict';

// This test intentionally changes only its new work/ installation/profile and
// installer-owned HKCU entries and its own desktop shortcut. It aborts if a
// desktop shortcut already exists. It never changes Windows default-browser
// choices, kills a user's Orbit process, or deletes an application-data directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectDir = path.resolve(__dirname, '..');
const workspace = path.resolve(projectDir, '..', '..');
const version = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
const installer = path.resolve(projectDir, '..', 'Orbit-release', `Orbit-Setup-${version}-x64.exe`);
const legacyExe = path.resolve(projectDir, '..', 'Orbit-portable', 'Orbit-win32-x64', 'Orbit.exe');
const runDir = path.join(workspace, 'work', `installer-${Date.now()}`);
const installDir = path.join(runDir, 'app');
const installedExe = path.join(installDir, 'Orbit.exe');
const profileDir = path.join(runDir, 'profile');
const stateFile = path.join(profileDir, 'orbit-state.json');
const results = [];
const requests = [];
const evidence = { version, installer, installDir, profileDir, results, requests };
let baseURL, phase = 'preflight', baselineRegistry, installed = false, uninstalled = false;
let legacyTabID, legacyBrowser;
let desktopShortcut;

function assertInsideWorkspace(candidate) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(workspace, absolute);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'Test target must resolve inside the current workspace');
  return absolute;
}
for (const target of [runDir, installDir, profileDir]) assertInsideWorkspace(target);
fs.mkdirSync(runDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, label, timeout = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(read, accept, label, timeout = 20000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { const value = await read(); if (accept(value)) return value; } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}
async function check(name, callback) {
  console.log(`RUN  ${name}`);
  const started = Date.now();
  try { await callback(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, ms: Date.now() - started, error: error.stack }); throw error; }
}
function psQuote(text) { return `'${String(text).replaceAll("'", "''")}'`; }
async function powershell(code) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';${code}`], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8').on('data', text => { output += text; });
  child.stderr.setEncoding('utf8').on('data', text => { errors += text; });
  const [exitCode] = await deadline(once(child, 'exit'), 'PowerShell helper', 20000);
  if (exitCode !== 0) throw new Error(`PowerShell helper failed (${exitCode}): ${errors.trim()}`);
  return output.trim() ? JSON.parse(output.replace(/^\uFEFF/, '').trim()) : null;
}
async function registrySnapshot() {
  // Hash values are compared in memory only, never printed or written to evidence.
  return powershell(`
    function Read-Value([string]$subkey,[string]$name){$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey);if($null -eq $key){return $null};try{return $key.GetValue($name,$null)}finally{$key.Dispose()}}
    function Has-Key([string]$subkey){$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey);if($null -eq $key){return $false};$key.Dispose();return $true}
    function Read-Choice([string]$scheme){$subkey='Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\'+$scheme+'\\UserChoice';return @{exists=(Has-Key $subkey);progId=(Read-Value $subkey 'ProgId');hash=(Read-Value $subkey 'Hash')}}
    @{
      own=@{registered=(Read-Value 'Software\\RegisteredApplications' 'Orbit');classExists=(Has-Key 'Software\\Classes\\OrbitBrowserURL');classCommand=(Read-Value 'Software\\Classes\\OrbitBrowserURL\\shell\\open\\command' '');clientExists=(Has-Key 'Software\\Clients\\StartMenuInternet\\Orbit');clientCommand=(Read-Value 'Software\\Clients\\StartMenuInternet\\Orbit\\shell\\open\\command' '');http=(Read-Value 'Software\\Clients\\StartMenuInternet\\Orbit\\Capabilities\\URLAssociations' 'http');https=(Read-Value 'Software\\Clients\\StartMenuInternet\\Orbit\\Capabilities\\URLAssociations' 'https')};
      userChoice=@{http=(Read-Choice 'http');https=(Read-Choice 'https')}
    }|ConvertTo-Json -Depth 6 -Compress`);
}
async function desktopShortcutSnapshot() {
  assert.ok(typeof desktopShortcut === 'string' && path.isAbsolute(desktopShortcut), 'Resolve the Windows desktop before inspecting a shortcut');
  return powershell(`
    $shortcutPath=${psQuote(desktopShortcut)};
    if(!(Test-Path -LiteralPath $shortcutPath)){@{exists=$false}|ConvertTo-Json -Compress;exit}
    if(!(Test-Path -LiteralPath $shortcutPath -PathType Leaf)){throw 'The desktop shortcut path is not a file; leave it untouched'}
    $wsh=New-Object -ComObject WScript.Shell;
    $shortcut=$wsh.CreateShortcut($shortcutPath);
    @{exists=$true;target=$shortcut.TargetPath;iconLocation=$shortcut.IconLocation}|ConvertTo-Json -Compress`);
}
function assertOwnedDesktopShortcut(snapshot) {
  assert.equal(snapshot.exists, true, 'Expected the installer-created desktop shortcut');
  assert.ok(sameExecutable(snapshot.target, installedExe), 'Desktop shortcut ownership changed; leave the shortcut and installation untouched');
  const iconTarget = String(snapshot.iconLocation || '').replace(/,\s*-?\d+$/, '').replace(/^"(.*)"$/, '$1');
  assert.ok(sameExecutable(iconTarget, installedExe), 'Desktop shortcut icon must use the installed application icon');
}
function assertDefaultUnchanged(snapshot) {
  const same = ['http', 'https'].every(scheme => {
    const a = baselineRegistry.userChoice[scheme], b = snapshot.userChoice[scheme];
    return a.exists === b.exists && a.progId === b.progId && a.hash === b.hash;
  });
  assert.ok(same, 'The HTTP/HTTPS UserChoice values changed during the installer lifecycle');
}
async function orbitProcesses() {
  const value = await powershell(`@(Get-CimInstance Win32_Process -Filter "Name = 'Orbit.exe'"|ForEach-Object {@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;executable=$_.ExecutablePath;isMain=($_.CommandLine -notmatch '(?:^|\\s)--type(?:=|\\s)')}})|ConvertTo-Json -Depth 3 -Compress`);
  return value ? Array.isArray(value) ? value : [value] : [];
}
function sameExecutable(a, b) { return typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
async function ownProcesses(executable = installedExe) { return (await orbitProcesses()).filter(p => sameExecutable(p.executable, executable)); }
async function closeMainWindow(executable = installedExe) {
  const output = await powershell(`
    $target=${psQuote(executable)};
    $windows=@(Get-CimInstance Win32_Process -Filter "Name = 'Orbit.exe'"|Where-Object {$_.ExecutablePath -eq $target -and $_.CommandLine -notmatch '(?:^|\\s)--type(?:=|\\s)'}|ForEach-Object {
      $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;
      if($p){try{if(!$p.HasExited){$p.Refresh();if($p.MainWindowHandle -ne 0){@{pid=$p.Id;sent=$p.CloseMainWindow()}}}}catch{if(!$p.HasExited){throw}}}
    });
    ConvertTo-Json -InputObject $windows -Depth 3 -Compress`);
  const rows = output ? Array.isArray(output) ? output : [output] : [];
  assert.ok(rows.some(row => row.sent), 'No WM_CLOSE was delivered to the test application window');
  await eventually(() => ownProcesses(executable), rows => rows.length === 0, 'graceful application exit', 20000);
  return rows.map(row => row.pid);
}
function environment() {
  const env = { ...process.env, ORBIT_PROFILE: assertInsideWorkspace(profileDir), ORBIT_TEST_MODE: '1', ORBIT_DOWNLOAD_DIR: path.join(runDir, 'downloads') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  return env;
}
function startInstalled(args = []) {
  const child = spawn(installedExe, args, { env: environment(), shell: false, windowsHide: false, stdio: 'ignore' });
  child.on('error', error => { evidence.lastLaunchError = error.message; });
  return child;
}
async function runExecutable(executable, args, label, timeout = 180000) {
  const child = spawn(executable, args, { env: environment(), shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
  const [exitCode] = await deadline(once(child, 'exit'), label, timeout);
  assert.equal(exitCode, 0, `${label} failed`);
}
function readState() { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
async function persistedURL(url) { return eventually(readState, value => value.tabs.some(tab => tab.id === value.activeTabId && tab.url === url), `persisted active URL ${new URL(url).pathname}`); }
function hasCookie(header, name, value) { return String(header || '').split(';').some(piece => piece.trim() === `${name}=${value}`); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const hasLegacy = hasCookie(req.headers.cookie, 'orbit_upgrade_cookie', 'legacy-v1');
  const hasCurrent = hasCookie(req.headers.cookie, 'orbit_installer_cookie', 'current-v2');
  requests.push({ phase, pathname: url.pathname, hasLegacyCookie: hasLegacy, hasCurrentCookie: hasCurrent });
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (url.pathname === '/legacy' && phase === 'legacy') headers['Set-Cookie'] = 'orbit_upgrade_cookie=legacy-v1; Max-Age=3600; Path=/; SameSite=Lax';
  if (url.pathname === '/first') headers['Set-Cookie'] = 'orbit_installer_cookie=current-v2; Max-Age=3600; Path=/; SameSite=Lax';
  res.writeHead(200, headers);
  res.end(`<!doctype html><meta charset="utf-8"><title>Orbit installer ${url.pathname}</title><body style="font:24px Segoe UI;padding:60px;background:#f6faf3;color:#294a33"><h1>Orbit installation check</h1><p>${url.pathname}</p><p>Local fixture. No account or personal browser data is used.</p>`);
});

async function uninstallOwnInstallation() {
  assertInsideWorkspace(installDir);
  const running = await ownProcesses();
  if (running.length) await closeMainWindow();
  const foreign = (await orbitProcesses()).filter(p => !sameExecutable(p.executable, installedExe));
  assert.equal(foreign.length, 0, 'Another Orbit instance started during the test; leave it running and stop cleanup');
  const own = (await registrySnapshot()).own;
  assert.equal(own.classCommand, `"${installedExe}" "%1"`, 'Installer registration ownership changed; stop cleanup');
  const shortcut = await desktopShortcutSnapshot();
  if (shortcut.exists) assertOwnedDesktopShortcut(shortcut);
  const matches = fs.readdirSync(installDir).filter(name => /^Uninstall.*\.exe$/i.test(name));
  assert.equal(matches.length, 1, 'Expected one application uninstaller');
  await runExecutable(path.join(installDir, matches[0]), ['/S'], 'silent uninstaller');
  await eventually(() => fs.existsSync(installedExe), exists => !exists, 'installed executable removal', 30000);
  uninstalled = true;
}

(async () => {
  try {
    await check('Preflight preserves existing installations, processes and Windows default choices', async () => {
      assert.equal(process.platform, 'win32', 'This installer lifecycle test requires Windows');
      assert.ok(fs.existsSync(installer), 'Build the versioned NSIS installer before running this test');
      assert.ok(!fs.existsSync(installDir), 'The disposable installation directory must be new');
      const running = await orbitProcesses();
      assert.equal(running.length, 0, 'Orbit is already running. Close it yourself before this test; no process was stopped');
      baselineRegistry = await registrySnapshot();
      assert.ok(baselineRegistry.own.registered === null && !baselineRegistry.own.classExists && !baselineRegistry.own.clientExists, 'An existing Orbit browser registration was found. Test aborted before install to avoid overwriting it');
      const desktop = await powershell(`[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)|ConvertTo-Json -Compress`);
      assert.ok(typeof desktop === 'string' && path.isAbsolute(desktop), 'Windows did not provide an absolute current-user desktop directory');
      desktopShortcut = path.join(desktop, 'Orbit.lnk');
      assert.equal((await desktopShortcutSnapshot()).exists, false, 'An existing desktop Orbit.lnk was found. Test aborted before install to preserve it');
      evidence.desktopShortcut = desktopShortcut;
      evidence.defaultBrowser = { httpProgId: baselineRegistry.userChoice.http.progId, httpsProgId: baselineRegistry.userChoice.https.progId };
      evidence.resolvedTargetsInsideWorkspace = true;
    });

    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    baseURL = `http://127.0.0.1:${server.address().port}`;

    if (fs.existsSync(legacyExe)) {
      await check('The prior portable version seeds an isolated profile for upgrade migration', async () => {
        phase = 'legacy';
        const { _electron: electron } = require('playwright');
        legacyBrowser = await electron.launch({ executablePath: legacyExe, args: [], env: environment(), timeout: 30000 });
        const page = await legacyBrowser.firstWindow(); await page.waitForFunction(() => window.browser);
        await page.evaluate(url => window.browser.action('navigate', { input: url }), `${baseURL}/legacy`);
        const saved = await persistedURL(`${baseURL}/legacy`); legacyTabID = saved.activeTabId;
        await page.evaluate(id => window.browser.action('pinTab', { id }), legacyTabID);
        await eventually(() => requests, rows => rows.some(row => row.phase === 'legacy' && row.pathname === '/legacy'), 'legacy fixture request');
        evidence.legacyVersion = await legacyBrowser.evaluate(({ app }) => app.getVersion());
        const closed = legacyBrowser.waitForEvent('close');
        await closeMainWindow(legacyExe); await deadline(closed, 'legacy application close'); legacyBrowser = null;
        assert.equal(readState().tabs.find(tab => tab.id === legacyTabID).pinned, true);
      });
    } else evidence.legacyMigration = 'No previous portable executable was available; fresh-profile lifecycle only.';

    await check('Silent NSIS installation registers this exact application without changing defaults', async () => {
      phase = 'install';
      assertInsideWorkspace(installDir);
      assert.equal((await desktopShortcutSnapshot()).exists, false, 'A desktop shortcut appeared after preflight; stop before installing');
      // NSIS /D must remain the final argument and must not be quoted, even when
      // the path contains spaces. No shell interprets these raw argument values.
      await runExecutable(installer, ['/S', `/D=${installDir}`], 'silent installer');
      installed = true;
      await eventually(() => fs.existsSync(installedExe), Boolean, 'installed executable');
      assert.ok(fs.existsSync(path.join(installDir, 'resources', 'app.asar')));
      const snapshot = await registrySnapshot();
      assert.equal(snapshot.own.registered, 'Software\\Clients\\StartMenuInternet\\Orbit\\Capabilities');
      assert.equal(snapshot.own.classCommand, `"${installedExe}" "%1"`);
      assert.equal(snapshot.own.clientCommand, `"${installedExe}"`);
      assert.equal(snapshot.own.http, 'OrbitBrowserURL'); assert.equal(snapshot.own.https, 'OrbitBrowserURL');
      assertDefaultUnchanged(snapshot); evidence.defaultsUnchangedAfterInstall = true;
    });

    await check('Default silent installation creates a desktop shortcut with the installed app icon', async () => {
      const shortcut = await desktopShortcutSnapshot();
      assertOwnedDesktopShortcut(shortcut);
      evidence.desktopShortcutCreated = true;
      evidence.desktopShortcutTarget = shortcut.target;
      evidence.desktopShortcutIconLocation = shortcut.iconLocation;
    });

    await check('The installed executable contains the release security fuse settings', async () => {
      const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
      const wire = await getCurrentFuseWire(installedExe);
      const expected = { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true };
      evidence.fuses = {};
      for (const [name, enabled] of Object.entries(expected)) {
        assert.equal(wire[FuseV1Options[name]], enabled ? 49 : 48, `Unexpected release fuse ${name}`);
        evidence.fuses[name] = enabled;
      }
    });

    await check('The hardened installed app opens a launch URL and migrates the previous profile', async () => {
      phase = 'first'; startInstalled([`${baseURL}/first`]);
      await eventually(() => requests, rows => rows.some(row => row.phase === 'first' && row.pathname === '/first'), 'installed cold navigation');
      const saved = await persistedURL(`${baseURL}/first`);
      if (legacyTabID) {
        assert.ok(saved.tabs.some(tab => tab.id === legacyTabID && tab.pinned && tab.url === `${baseURL}/legacy`));
        assert.ok(requests.some(row => row.phase === 'first' && row.pathname === '/first' && row.hasLegacyCookie), 'The previous portable cookie did not survive the encryption-enabled upgrade');
        evidence.legacyCookieMigration = true;
      }
      const main = (await ownProcesses()).filter(p => p.isMain);
      assert.equal(main.length, 1, 'Expected one browser main process'); evidence.firstMainPID = main[0].pid;
    });

    await check('A second instance opens its URL in the running app and shares the session cookie', async () => {
      phase = 'second'; const secondary = startInstalled([`${baseURL}/second`]);
      const exited = once(secondary, 'exit');
      await persistedURL(`${baseURL}/second`);
      await eventually(() => requests, rows => rows.some(row => row.phase === 'second' && row.pathname === '/second' && row.hasCurrentCookie), 'second-instance shared cookie');
      const [exitCode] = await deadline(exited, 'secondary process exit', 15000); assert.equal(exitCode, 0);
      const main = (await ownProcesses()).filter(p => p.isMain);
      assert.equal(main.length, 1); assert.equal(main[0].pid, evidence.firstMainPID);
    });

    await check('WM_CLOSE exits gracefully and a relaunch restores tabs and persistent cookies', async () => {
      const before = readState();
      evidence.gracefulClosePIDs = await closeMainWindow();
      phase = 'relaunch'; startInstalled();
      await eventually(() => requests, rows => rows.some(row => row.phase === 'relaunch' && row.pathname === '/second' && row.hasCurrentCookie), 'persistent session after relaunch');
      const restored = await persistedURL(`${baseURL}/second`);
      assert.deepEqual(restored.tabs.map(({ id, spaceId, url, pinned }) => ({ id, spaceId, url, pinned })), before.tabs.map(({ id, spaceId, url, pinned }) => ({ id, spaceId, url, pinned })));
      assert.equal(restored.activeTabId, before.activeTabId);
      if (legacyTabID) assert.ok(requests.some(row => row.phase === 'relaunch' && row.pathname === '/second' && row.hasLegacyCookie));
      await closeMainWindow(); evidence.persistentCookiesRestored = true;
    });

    await check('Silent uninstall removes only the installation and its owned registration', async () => {
      const profileBefore = fs.readFileSync(stateFile, 'utf8');
      await uninstallOwnInstallation();
      const snapshot = await registrySnapshot();
      assert.ok(snapshot.own.registered === null && !snapshot.own.classExists && !snapshot.own.clientExists, 'The uninstall left installer-owned browser registration behind');
      assert.equal((await desktopShortcutSnapshot()).exists, false, 'The uninstaller left its owned desktop shortcut behind');
      assertDefaultUnchanged(snapshot);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), profileBefore, 'The uninstaller changed the private test profile');
      assert.ok(fs.existsSync(path.join(profileDir, 'Partitions', 'orbit-personal', 'Network', 'Cookies')) || fs.existsSync(path.join(profileDir, 'Partitions', 'orbit-personal', 'Cookies')), 'The preserved profile is missing its cookie database');
      evidence.defaultsUnchangedAfterUninstall = true; evidence.profilePreservedAfterUninstall = true;
      evidence.desktopShortcutRemoved = true;
    });

    await check('The no-desktop-shortcut option skips the shortcut through installation and removal', async () => {
      phase = 'install-without-desktop-shortcut';
      assert.equal((await desktopShortcutSnapshot()).exists, false, 'A desktop shortcut appeared before opt-out installation; leave it untouched');
      await runExecutable(installer, ['/S', '--no-desktop-shortcut', `/D=${installDir}`], 'silent installer without desktop shortcut');
      installed = true; uninstalled = false;
      await eventually(() => fs.existsSync(installedExe), Boolean, 'opt-out installed executable');
      assert.equal((await desktopShortcutSnapshot()).exists, false, 'The opt-out installation created a desktop shortcut');
      assertDefaultUnchanged(await registrySnapshot());
      const profileBefore = fs.readFileSync(stateFile, 'utf8');
      await uninstallOwnInstallation();
      assert.equal((await desktopShortcutSnapshot()).exists, false, 'The opt-out uninstall unexpectedly created a desktop shortcut');
      const snapshot = await registrySnapshot();
      assert.ok(snapshot.own.registered === null && !snapshot.own.classExists && !snapshot.own.clientExists);
      assertDefaultUnchanged(snapshot);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), profileBefore);
      evidence.desktopShortcutOptOutVerified = true;
    });
    console.log(`\n${results.length} installed application lifecycle checks passed.`);
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
  finally {
    if (legacyBrowser) {
      try { await closeMainWindow(legacyExe); } catch (error) { evidence.legacyCleanupError = error.message; }
    }
    if (installed && !uninstalled) {
      try { await uninstallOwnInstallation(); evidence.failureCleanup = 'Own test installation was uninstalled.'; }
      catch (error) { evidence.failureCleanup = `Left test installation in place: ${error.message}`; console.error(evidence.failureCleanup); }
    }
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(evidence, null, 2));
    console.log(`Installer evidence: ${runDir}`);
  }
})();
