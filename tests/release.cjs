'use strict';

// Release regressions use loopback pages and a disposable browser profile.
// Native permission/unload dialogs are answered by test-only runtime stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const appDir = path.resolve(__dirname, '..');
const runDir = path.resolve(appDir, '..', '..', 'work', `release-${Date.now()}`);
const profileDir = path.join(runDir, 'profile');
const results = [];
const runtimeErrors = [];
let app, ui, baseURL;
fs.mkdirSync(runDir, { recursive: true });

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (pathname === '/loading') {
    // Chromium keeps this document loading until the test tears down the server.
    res.write('<!doctype html><title>Loading forever</title><p>Deliberately incomplete response.</p>');
    return;
  }
  res.end(`<!doctype html><meta charset="utf-8"><title>${pathname}</title><body><h1>${pathname}</h1><textarea id="draft">An unsaved draft</textarea><video id="video" muted autoplay playsinline></video><script>
    window.releaseOpenerToken='release-opener';
    window.makeDirty=()=>{addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue='';});return navigator.userActivation.hasBeenActive;};
    if(location.pathname==='/hung-pip'){
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');let t=0;
      window.releaseFrameTimer=setInterval(()=>{ctx.fillStyle=t++%2?'green':'blue';ctx.fillRect(0,0,320,180);},33);
      ctx.fillRect(0,0,320,180);video.srcObject=canvas.captureStream(30);video.play();
      HTMLVideoElement.prototype.requestPictureInPicture=()=>new Promise(()=>{});
    }
  </script>`);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, label, timeout = 12000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(read, accept, label, timeout = 10000) {
  const until = Date.now() + timeout;
  let last, lastError;
  while (Date.now() < until) {
    try { last = await read(); if (accept(last)) return last; } catch (error) { lastError = error; }
    await sleep(60);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}${lastError ? ` (${lastError.message})` : ''}`);
}
async function check(name, callback) {
  const started = Date.now();
  try { await callback(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, ms: Date.now() - started, error: error.stack }); throw error; }
}
function environment(profile = profileDir) {
  const env = { ...process.env, ORBIT_TEST_MODE: '1', ORBIT_PROFILE: profile, ORBIT_DOWNLOAD_DIR: path.join(runDir, 'downloads') };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
async function launch({ profile = profileDir, args = [] } = {}) {
  app = await electron.launch({ args: [appDir, ...args], env: environment(profile), timeout: 30000 });
  app.process().stderr.on('data', data => {
    const text = data.toString();
    if (/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(text)) runtimeErrors.push(text.trim());
  });
  ui = await app.firstWindow();
  ui.on('pageerror', error => runtimeErrors.push(error.message));
  await ui.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'));
  await stubDialogs();
}
async function stubDialogs() {
  await app.evaluate(({ dialog }) => {
    globalThis.__orbitReleaseDialogs = [];
    globalThis.__orbitReleaseUnloadResponse = 0;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.__orbitReleaseDialogs.push({ kind: 'permission', message: options.message, buttons: options.buttons });
      return { response: 1 };
    };
    dialog.showMessageBoxSync = (...args) => {
      const options = args.at(-1);
      globalThis.__orbitReleaseDialogs.push({ kind: 'unload', message: options.message, buttons: options.buttons });
      return globalThis.__orbitReleaseUnloadResponse;
    };
  });
}
async function state() { return ui.evaluate(() => window.browser.getState()); }
async function action(name, payload = {}) { return deadline(ui.evaluate(({ name, payload }) => window.browser.action(name, payload), { name, payload }), `action ${name}`); }
async function guest(url, { loading = false } = {}) {
  const spaceId = (await state()).activeSpaceId;
  return eventually(() => app.evaluate(({ webContents, session }, { url, spaceId, loading }) => {
    const ses = session.fromPartition(`persist:orbit-${spaceId}`);
    return webContents.getAllWebContents().find(w => w.getURL() === url && w.session === ses && (loading || !w.isLoading()))?.id;
  }, { url, spaceId, loading }), Boolean, `guest ${url}`);
}
async function script(id, code, userGesture = false) {
  return deadline(app.evaluate(({ webContents }, { id, code, userGesture }) => webContents.fromId(id).executeJavaScript(code, userGesture), { id, code, userGesture }), `guest ${id} script`, 6000);
}
async function navigate(pathname) {
  await action('navigate', { input: `${baseURL}${pathname}` });
  return guest(`${baseURL}${pathname}`);
}
async function setUnloadResponse(response) { await app.evaluate((_electron, value) => { globalThis.__orbitReleaseUnloadResponse = value; }, response); }
async function unloadDialogCount() { return app.evaluate(() => globalThis.__orbitReleaseDialogs.filter(d => d.kind === 'unload').length); }
async function closeApp() {
  if (!app) return;
  await setUnloadResponse(1).catch(() => {});
  const closingApp = app; app = null;
  await deadline(closingApp.close(), 'release fixture shutdown', 8000).catch(() => closingApp.process().kill());
}

(async () => {
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    baseURL = `http://127.0.0.1:${server.address().port}`;
    await launch();
    let mainTabID, mainWC;

    await check('Permission grants use the same origin key for request and later checks', async () => {
      mainWC = await navigate('/permissions'); mainTabID = (await state()).activeTabId;
      assert.equal(await script(mainWC, 'Notification.requestPermission()', true), 'granted');
      assert.equal(await script(mainWC, 'Notification.permission'), 'granted');
      assert.equal(await script(mainWC, 'navigator.permissions.query({name:"notifications"}).then(p=>p.state)'), 'granted');
      assert.equal(await script(mainWC, 'Notification.requestPermission()', true), 'granted');
      const dialogs = await app.evaluate(() => globalThis.__orbitReleaseDialogs.filter(d => d.kind === 'permission'));
      assert.equal(dialogs.length, 1);
      assert.equal(dialogs[0].message, baseURL);
    });

    await check('A self-closing popup is removed and its opener remains usable', async () => {
      const before = await state();
      await script(mainWC, 'window.open("/popup","releasePopup");true', true);
      const popupWC = await guest(`${baseURL}/popup`);
      const popupState = await state(), popupTabID = popupState.activeTabId;
      assert.notEqual(popupTabID, mainTabID);
      assert.equal(await script(popupWC, 'window.opener.releaseOpenerToken'), 'release-opener');
      await script(popupWC, 'window.close();true', true).catch(error => {
        if (!/closed|destroyed|context/i.test(error.message)) throw error;
      });
      await eventually(state, value => value.tabs.length === before.tabs.length && !value.tabs.some(t => t.id === popupTabID) && value.activeTabId === mainTabID, 'popup cleanup and opener restore');
      assert.equal(await app.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), popupWC), false);
      mainWC = await navigate('/after-popup');
      assert.equal((await state()).activeTabId, mainTabID);
    });

    await check('A document that never finishes loading cannot block tab switching', async () => {
      await action('navigate', { input: `${baseURL}/loading` });
      const loadingWC = await guest(`${baseURL}/loading`, { loading: true });
      assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).isLoading(), loadingWC), true);
      const started = Date.now();
      await deadline(action('newTab'), 'tab switch away from loading document', 3000);
      await deadline(action('theme', { color: '#cbd8e1' }), 'queued theme after loading document', 3000);
      assert.ok(Date.now() - started < 3000);
      assert.equal((await state()).themeColor, '#cbd8e1');
    });

    await check('A never-resolving page PiP Promise releases the action queue', async () => {
      const id = await navigate('/hung-pip');
      await eventually(() => script(id, '({ready:video.readyState,width:video.videoWidth,paused:video.paused})'), value => value.ready >= 2 && value.width > 0 && !value.paused, 'playing canvas stream');
      const started = Date.now();
      const pip = action('pip');
      const queuedTheme = action('theme', { color: '#c8d8cb' });
      await deadline(Promise.all([pip, queuedTheme]), 'PiP deadline and subsequent UI action', 4000);
      assert.ok(Date.now() - started < 3500);
      assert.equal((await state()).themeColor, '#c8d8cb');
      await action('autoPip', { enabled: false });
    });

    await check('Closing a dirty tab honors Stay, then discards only after Leave', async () => {
      const id = await navigate('/draft-tab');
      const tabID = (await state()).activeTabId;
      assert.equal(await script(id, 'window.makeDirty()', true), true);
      const beforeDialogs = await unloadDialogCount();
      await setUnloadResponse(0);
      await action('closeTab', { id: tabID });
      await eventually(unloadDialogCount, count => count === beforeDialogs + 1, 'Stay unload dialog');
      assert.ok((await state()).tabs.some(t => t.id === tabID));
      assert.equal(await app.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), id), true);
      await setUnloadResponse(1);
      await action('closeTab', { id: tabID });
      await eventually(state, value => !value.tabs.some(t => t.id === tabID), 'Leave tab removal');
      assert.equal(await app.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), id), false);
    });

    await check('Cancelling window close keeps the browser and restored tab metadata', async () => {
      await action('activateTab', { id: mainTabID });
      mainWC = await navigate('/draft-window');
      await action('pinTab', { id: mainTabID });
      assert.equal(await script(mainWC, 'window.makeDirty()', true), true);
      const before = await state(), beforeDialogs = await unloadDialogCount();
      await setUnloadResponse(0);
      await action('closeWindow');
      await eventually(unloadDialogCount, count => count > beforeDialogs, 'cancel window close prompt');
      await sleep(150);
      const after = await state();
      assert.equal(after.activeTabId, before.activeTabId);
      assert.deepEqual(after.tabs.map(t => ({ id: t.id, url: t.url, pinned: t.pinned })), before.tabs.map(t => ({ id: t.id, url: t.url, pinned: t.pinned })));
      assert.ok(await guest(`${baseURL}/draft-window`));
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    });

    await check('Accepting window close exits and a fresh launch restores the tab list', async () => {
      const before = await state();
      await setUnloadResponse(1);
      const closed = app.waitForEvent('close');
      await action('closeWindow').catch(error => {
        if (!/closed|destroyed|context/i.test(error.message)) throw error;
      });
      await deadline(closed, 'accepted window close', 12000); app = null;
      await launch();
      const restored = await state();
      assert.equal(restored.activeTabId, before.activeTabId);
      assert.deepEqual(restored.tabs.map(t => ({ id: t.id, spaceId: t.spaceId, url: t.url, pinned: t.pinned })), before.tabs.map(t => ({ id: t.id, spaceId: t.spaceId, url: t.url, pinned: t.pinned })));
      assert.equal(restored.themeColor, before.themeColor);
      assert.equal(restored.autoPip, before.autoPip);
      assert.ok(await guest(`${baseURL}/draft-window`));
    });

    if (process.env.ORBIT_TEST_URL_ARGUMENTS === '1') {
      await check('Cold launch and second instance open only validated HTTP URL arguments', async () => {
        await closeApp();
        const profile = path.join(runDir, 'url-argument-profile');
        await launch({ profile, args: [`${baseURL}/cold-launch`] });
        await eventually(state, value => value.tabs.find(t => t.id === value.activeTabId)?.url === `${baseURL}/cold-launch`, 'cold launch URL');
        const second = spawn(require('electron'), [appDir, `${baseURL}/second-instance`], { env: environment(profile), windowsHide: true, stdio: 'ignore' });
        const secondExit = once(second, 'exit');
        await eventually(state, value => value.tabs.find(t => t.id === value.activeTabId)?.url === `${baseURL}/second-instance`, 'second instance URL');
        await deadline(secondExit, 'second instance exit', 10000).catch(error => { second.kill(); throw error; });
        const before = (await state()).tabs.length;
        const unsafe = spawn(require('electron'), [appDir, 'javascript:window.unsafeReleaseArgument=true'], { env: environment(profile), windowsHide: true, stdio: 'ignore' });
        await deadline(once(unsafe, 'exit'), 'unsafe argument secondary exit', 10000).catch(error => { unsafe.kill(); throw error; });
        assert.equal((await state()).tabs.length, before);
        assert.equal(await ui.evaluate(() => typeof window.unsafeReleaseArgument), 'undefined');
      });
    }

    await check('Release regressions finish without uncaught renderer or main errors', async () => {
      assert.deepEqual(runtimeErrors, []);
    });
    console.log(`\n${results.length} release checks passed.`);
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
  finally {
    await closeApp();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ results, runtimeErrors }, null, 2));
    console.log(`Release evidence: ${runDir}`);
  }
})();
