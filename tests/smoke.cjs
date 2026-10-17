'use strict';

// Runs against a temporary profile and a loopback fixture server. No public site,
// existing browser profile, or real Downloads folder is used by this suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const appDir = path.resolve(__dirname, '..');
const workspace = path.resolve(appDir, '..', '..');
const runDir = path.join(workspace, 'work', `smoke-${Date.now()}`);
const profileDir = path.join(runDir, 'profile');
require('./legacy-profile.cjs')(profileDir);
const downloadDir = path.join(runDir, 'downloads');
const previewPath = path.resolve(appDir, '..', 'orbit-preview.png');
const fixtureBytes = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251));
const results = [];
const requests = [];
const consoleErrors = [];
let app, ui, baseURL;

fs.mkdirSync(downloadDir, { recursive: true });

function fixturePage(title, body, script = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
  <style>body{font:16px "Segoe UI",sans-serif;background:#f7faf6;color:#263b2c;margin:55px;line-height:1.8}h1{font-size:38px;font-weight:500}a,button{color:#3c7251}video{width:640px;max-width:100%;background:#172c21;border-radius:18px}small{letter-spacing:2px;color:#829380}article{max-width:700px}</style>
  <article><small>ORBIT LOCAL TEST</small><h1>${title}</h1>${body}</article><script>${script}</script></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  requests.push({ method: req.method, pathname: url.pathname, body });
  if (url.pathname === '/download') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="orbit-fixture.bin"', 'Content-Length': fixtureBytes.length });
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(fixtureBytes.subarray(offset, offset += 8192));
      if (offset >= fixtureBytes.length) { clearInterval(timer); res.end(); }
    }, 75);
    return;
  }
  let html;
  if (url.pathname === '/a') html = fixturePage('A calmer place to browse', '<p>Real Chromium pages, independent spaces, and room to focus.</p><p><a id="next" href="/b">Continue to the next page</a></p><p><a id="popup" rel="opener" target="_blank" href="/popup">Open a related page</a></p><form id="post" action="/post" rel="opener" target="_blank" method="post"><input name="message" value="orbit-post-value"><button>Open submitted form</button></form><p><a id="download" href="/download">Download local fixture</a></p>', 'window.fixtureOpenerToken="orbit-opener-token";');
  else if (url.pathname === '/b') html = fixturePage('A second perspective', '<p>Navigation history belongs to the page you are viewing.</p><a href="/a">Return to the first page</a>');
  else if (url.pathname === '/popup' || url.pathname === '/post') html = fixturePage(url.pathname === '/post' ? 'POST popup' : 'Linked popup', '<p id="opener">Checking opener…</p>', `document.querySelector('#opener').textContent=window.opener?.fixtureOpenerToken||'missing';document.body.dataset.method=${JSON.stringify(req.method)};document.body.dataset.body=${JSON.stringify(body)};`);
  else if (url.pathname === '/cookie') html = fixturePage('An independent space', '<p id="cookies"></p>', 'document.querySelector("#cookies").textContent=document.cookie||"No cookies";');
  else if (url.pathname === '/video') html = fixturePage('A little room for motion', '<video id="video" autoplay muted playsinline></video><p>The animation is created locally. No camera, network video, or permission prompt.</p>', `
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d');let tick=0;
    function frame(){tick++;ctx.fillStyle='#1f3f31';ctx.fillRect(0,0,640,360);ctx.fillStyle='#b8d7a6';ctx.beginPath();ctx.arc(320+Math.sin(tick/25)*170,175,58,0,Math.PI*2);ctx.fill();ctx.fillStyle='#eef7e9';ctx.font='24px Segoe UI';ctx.fillText('Orbit · local video',32,318);}
    frame();window.fixtureTimer=setInterval(frame,33);video.srcObject=canvas.captureStream(30);video.play().catch(e=>window.fixtureVideoError=e.message);
    window.fixturePipEvents=[];video.addEventListener('enterpictureinpicture',e=>fixturePipEvents.push({type:'enter',width:e.pictureInPictureWindow.width,height:e.pictureInPictureWindow.height}));video.addEventListener('leavepictureinpicture',()=>fixturePipEvents.push({type:'leave'}));`);
  else html = fixturePage('Fixture not found', '<p>Use the suite links to navigate.</p>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});

async function eventually(read, accept, label, timeout = 12000) {
  const started = Date.now();
  let last, error;
  while (Date.now() - started < timeout) {
    try { last = await read(); if (accept(last)) return last; } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}${error ? `; ${error.message}` : ''}`);
}

async function deadline(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout); })]);
  } finally { clearTimeout(timer); }
}

async function check(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, ms: Date.now() - started, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); throw error; }
}

async function launch() {
  const env = { ...process.env, ORBIT_TEST_MODE: '1', ORBIT_PROFILE: profileDir, ORBIT_DOWNLOAD_DIR: downloadDir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [appDir], env, timeout: 30000 });
  app.process().stderr.on('data', data => {
    const text = data.toString();
    if (/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(text)) consoleErrors.push(text.trim());
  });
  ui = await app.firstWindow();
  ui.on('pageerror', error => consoleErrors.push(error.message));
  await ui.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'), { timeout: 15000 });
  await ui.evaluate(() => window.browser.getState());
}

async function state() { return ui.evaluate(() => window.browser.getState()); }
async function action(name, payload = {}) { return ui.evaluate(({ name, payload }) => window.browser.action(name, payload), { name, payload }); }
async function guestID(url) {
  const spaceId = (await state()).activeSpaceId;
  return eventually(() => app.evaluate(({ webContents, session }, { url, spaceId }) => {
    const expectedSession = session.fromPartition(`persist:orbit-${spaceId}`);
    return webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL() === url && w.session === expectedSession && !w.isLoading()).map(w => w.id).sort((a, b) => a - b);
  }, { url, spaceId }), ids => ids.length > 0, `guest ${url} in space ${spaceId}`).then(ids => ids.at(-1));
}
async function guestEval(id, code, userGesture = false) {
  return deadline(app.evaluate(({ webContents }, { id, code, userGesture }) => {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) throw new Error(`Guest ${id} was destroyed`);
    return wc.executeJavaScript(code, userGesture);
  }, { id, code, userGesture }), `guest ${id} script`);
}
async function activeURL(url) { return eventually(state, value => value.tabs.find(t => t.id === value.activeTabId)?.url === url, `active URL ${url}`); }
async function capturePreview(outputPath = previewPath) {
  const png = await deadline(app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage();
    return image.toPNG().toString('base64');
  }), 'native screenshot', 6000);
  fs.writeFileSync(outputPath, Buffer.from(png, 'base64'));
}
async function exitPip(id) { await guestEval(id, 'document.pictureInPictureElement ? document.exitPictureInPicture().then(()=>true) : true'); }
async function pipState(id) { return guestEval(id, '({active:!!document.pictureInPictureElement,events:window.fixturePipEvents,paused:video.paused,ready:video.readyState,width:video.videoWidth})'); }

(async () => {
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    baseURL = `http://127.0.0.1:${server.address().port}`;
    await launch();
    let personalID, navigationTabID, navigationWC, videoTabID, videoWC, persisted;

    await check('Chromium shell renders with working preload and native screenshot', async () => {
      const value = await state();
      assert.equal(value.engine.electron, '44.8.0');
      assert.match(value.engine.chromium, /^152\./);
      assert.ok(value.spaces.length >= 2);
      assert.equal(await ui.locator('#newTabButton').isVisible(), true);
      personalID = value.activeSpaceId;
      await capturePreview();
      assert.ok(fs.statSync(previewPath).size > 15000);
    });

    await check('Real navigation, title and native back/forward history', async () => {
      await action('navigate', { input: `${baseURL}/a` });
      navigationWC = await guestID(`${baseURL}/a`); navigationTabID = (await state()).activeTabId;
      await eventually(state, value => value.tabs.find(t => t.id === navigationTabID)?.title === 'A calmer place to browse', 'page title');
      await guestEval(navigationWC, 'document.querySelector("#next").click();true', true);
      assert.equal(await guestID(`${baseURL}/b`), navigationWC);
      await activeURL(`${baseURL}/b`);
      await eventually(state, value => value.tabs.find(t => t.id === navigationTabID)?.canGoBack === true, 'native back history');
      await action('back'); assert.equal(await guestID(`${baseURL}/a`), navigationWC);
      await action('forward'); assert.equal(await guestID(`${baseURL}/b`), navigationWC);
      await guestEval(navigationWC, 'history.pushState({},"","/spa?step=2");true', true);
      await activeURL(`${baseURL}/spa?step=2`);
      await action('back'); await guestID(`${baseURL}/b`);
    });

    await check('Remote content has sandbox, context isolation and no Node or app bridge', async () => {
      const preferences = await app.evaluate(({ webContents }, id) => {
        const p = webContents.fromId(id).getLastWebPreferences();
        return { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox, webSecurity: p.webSecurity, allowRunningInsecureContent: p.allowRunningInsecureContent, preload: p.preload || null };
      }, navigationWC);
      assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, preload: null });
      assert.deepEqual(await guestEval(navigationWC, '({require:typeof require,process:typeof process,browser:typeof window.browser})'), { require: 'undefined', process: 'undefined', browser: 'undefined' });
    });

    await check('Address input and popup policy reject non-web protocols', async () => {
      const before = (await state()).tabs.length;
      const rejection = await ui.evaluate(() => window.browser.action('navigate', { input: 'javascript:window.orbitUnsafe=true' }).then(() => null, e => e.message));
      assert.match(rejection, /http/);
      await guestEval(navigationWC, 'window.open("file:///C:/Windows");true', true);
      assert.equal((await state()).tabs.length, before);
      assert.equal(await guestEval(navigationWC, 'typeof window.orbitUnsafe'), 'undefined');
    });

    await check('GET popup becomes a tab and preserves opener relationship', async () => {
      await action('navigate', { input: `${baseURL}/a` }); await guestID(`${baseURL}/a`);
      await guestEval(navigationWC, 'document.querySelector("#popup").click();true', true);
      const popupWC = await guestID(`${baseURL}/popup`);
      assert.equal(await guestEval(popupWC, 'document.querySelector("#opener").textContent'), 'orbit-opener-token');
      const current = await activeURL(`${baseURL}/popup`);
      assert.equal(current.tabs.length, 3);
      await action('closeTab', { id: current.activeTabId });
      await action('activateTab', { id: navigationTabID });
    });

    await check('POST target=_blank preserves form payload and opener', async () => {
      await guestEval(navigationWC, 'document.querySelector("#post").requestSubmit();true', true);
      const postWC = await guestID(`${baseURL}/post`);
      const result = await guestEval(postWC, '({method:document.body.dataset.method,body:document.body.dataset.body,opener:document.querySelector("#opener").textContent})');
      assert.deepEqual(result, { method: 'POST', body: 'message=orbit-post-value', opener: 'orbit-opener-token' });
      assert.ok(requests.some(r => r.pathname === '/post' && r.method === 'POST' && r.body === 'message=orbit-post-value'));
      await action('closeTab', { id: (await state()).activeTabId });
      await action('activateTab', { id: navigationTabID });
    });

    await check('Spaces isolate cookies while tabs in the same space share them', async () => {
      await guestEval(navigationWC, 'document.cookie="orbit=personal;path=/;max-age=3600";true');
      await action('newTab', { url: `${baseURL}/cookie` });
      let cookieWC = await guestID(`${baseURL}/cookie`);
      assert.match(await guestEval(cookieWC, 'document.cookie'), /orbit=personal/);
      await action('switchSpace', { id: 'work' });
      await action('navigate', { input: `${baseURL}/cookie` });
      cookieWC = await guestID(`${baseURL}/cookie`);
      assert.equal(await guestEval(cookieWC, 'document.cookie'), '');
      await guestEval(cookieWC, 'document.cookie="orbit=work;path=/;max-age=3600";true');
      await action('switchSpace', { id: personalID });
      await action('activateTab', { id: navigationTabID });
      assert.match(await guestEval(navigationWC, 'document.cookie'), /orbit=personal/);
    });

    await check('Two native web views split without overlap and resize with sidebar', async () => {
      let value = await action('split');
      assert.equal(value.splitTabIds.length, 2);
      const readViews = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents && v.getVisible()).map(v => ({ id: v.webContents.id, bounds: v.getBounds() })));
      let visible = await readViews();
      assert.equal(visible.length, 2);
      visible.sort((a, b) => a.bounds.x - b.bounds.x);
      assert.ok(visible[0].bounds.x >= 256);
      assert.ok(visible[0].bounds.width > 300 && visible[1].bounds.width > 300);
      assert.ok(visible[0].bounds.x + visible[0].bounds.width < visible[1].bounds.x);
      const previousWidth = visible[0].bounds.width;
      await action('toggleSidebar'); visible = await eventually(readViews, value => value.length === 2 && value.some(v => v.bounds.x === 82), 'collapsed sidebar animation');
      assert.ok(visible.some(v => v.bounds.x < 100));
      assert.ok(visible[0].bounds.width > previousWidth);
      await action('toggleSidebar'); await eventually(readViews, value => value.length === 2 && value.some(v => v.bounds.x === 266), 'expanded sidebar animation'); await action('unsplit');
      assert.equal((await readViews()).length, 1);
    });

    await check('Custom theme color and pinned tab update state and rendered UI', async () => {
      await action('theme', { color: '#c9bfe1' });
      await action('pinTab', { id: navigationTabID });
      const value = await state();
      assert.equal(value.themeColor, '#c9bfe1');
      assert.equal(value.tabs.find(t => t.id === navigationTabID).pinned, true);
      await eventually(() => ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme').trim()), value => value === '#c9bfe1', 'rendered theme color');
      assert.ok(await ui.locator('#pinnedTabs button').count() >= 1);
    });

    await check('Downloads report progress, animate and save exact bytes', async () => {
      await guestEval(navigationWC, 'document.querySelector("#download").click();true', true);
      await eventually(state, value => value.downloads.some(d => d.state === 'progressing'), 'download progress');
      await eventually(() => ui.locator('#downloadsButton').getAttribute('class'), value => value.includes('downloading'), 'download animation');
      const value = await eventually(state, value => value.downloads.some(d => d.state === 'completed'), 'download completed');
      const item = value.downloads.find(d => d.filename === 'orbit-fixture.bin');
      assert.equal(item.state, 'completed');
      assert.equal(item.receivedBytes, fixtureBytes.length);
      assert.deepEqual(fs.readFileSync(path.join(downloadDir, 'orbit-fixture.bin')), fixtureBytes);
      await eventually(() => ui.locator('#downloadsButton').getAttribute('class'), value => value.includes('download-complete'), 'download completion animation');
    });

    await check('Native video PiP opens from local canvas stream and closes cleanly', async () => {
      await action('newTab', { url: `${baseURL}/video` });
      videoWC = await guestID(`${baseURL}/video`); videoTabID = (await state()).activeTabId;
      await eventually(() => pipState(videoWC), value => value.ready >= 2 && value.width === 640 && !value.paused, 'local video playback');
      await action('pip');
      const pip = await eventually(() => pipState(videoWC), value => value.active, 'native PiP entry');
      assert.ok(pip.events.some(e => e.type === 'enter' && e.width > 0 && e.height > 0));
      await exitPip(videoWC);
      await eventually(() => pipState(videoWC), value => !value.active && value.events.some(e => e.type === 'leave'), 'native PiP exit');
    });

    await check('Changing tabs automatically starts PiP for playing fixture video', async () => {
      await action('activateTab', { id: navigationTabID });
      await eventually(() => pipState(videoWC), value => value.active, 'tab switch auto PiP');
      assert.equal((await state()).activeTabId, navigationTabID);
      await exitPip(videoWC);
      await action('activateTab', { id: videoTabID });
    });

    await check('Switching app focus automatically starts PiP and focus restores it', async () => {
      // A second native window changes real OS focus; emitting a fake blur event
      // would miss the isFocused guard used by the production implementation.
      await app.evaluate(async ({ BrowserWindow }) => {
        const primary = BrowserWindow.getAllWindows()[0]; primary.focus();
        const other = new BrowserWindow({ width: 320, height: 180, title: 'Orbit smoke focus fixture', show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
        globalThis.__orbitSmokeOtherWindow = other;
        await other.loadURL('data:text/html,<title>Focus fixture</title><p>Temporary focus fixture</p>');
        other.show(); other.focus();
      });
      await eventually(() => pipState(videoWC), value => value.active, 'real window blur auto PiP');
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.__orbitSmokeOtherWindow.close(); delete globalThis.__orbitSmokeOtherWindow;
        BrowserWindow.getAllWindows()[0].focus();
      });
      await eventually(() => pipState(videoWC), value => !value.active, 'return focus PiP restore');
    });

    await check('Auto PiP setting prevents background tab activation', async () => {
      await action('autoPip', { enabled: false });
      await action('activateTab', { id: navigationTabID });
      assert.equal((await pipState(videoWC)).active, false);
      await action('autoPip', { enabled: true });
    });

    await check('Closing tabs destroys guest contents without leaving native views', async () => {
      await action('closeTab', { id: videoTabID });
      assert.equal(await app.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), videoWC), false);
      const value = await state(); assert.equal(value.tabs.some(t => t.id === videoTabID), false);
    });

    await check('Restart restores tabs, pinned state, theme, settings and isolated cookies', async () => {
      await action('createSpace', { name: '집중', color: '#d8cbbb' });
      await action('switchSpace', { id: personalID });
      await action('activateTab', { id: navigationTabID });
      await action('theme', { color: '#c8d8cb' });
      persisted = await state();
      await app.close(); app = null;
      await launch();
      const value = await state();
      assert.equal(value.themeColor, '#c8d8cb');
      assert.equal(value.autoPip, true);
      assert.equal(value.activeTabId, persisted.activeTabId);
      assert.deepEqual(value.spaces, persisted.spaces);
      assert.deepEqual(value.tabs.map(({ id, spaceId, pinned, url }) => ({ id, spaceId, pinned, url })), persisted.tabs.map(({ id, spaceId, pinned, url }) => ({ id, spaceId, pinned, url })));
      navigationWC = await guestID(`${baseURL}/a`);
      assert.match(await guestEval(navigationWC, 'document.cookie'), /orbit=personal/);
      await action('switchSpace', { id: 'work' });
      const workCookieWC = await guestID(`${baseURL}/cookie`);
      assert.match(await guestEval(workCookieWC, 'document.cookie'), /orbit=work/);
    });

    await check('Renderer completes smoke flow without uncaught runtime errors', async () => {
      assert.deepEqual(consoleErrors, []);
    });
    console.log(`\n${results.length} smoke checks passed. Preview: ${previewPath}`);
  } catch (error) {
    console.error(error.stack);
    if (app) await capturePreview(path.join(runDir, 'failure.png')).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (app) await deadline(app.close(), 'app shutdown', 6000).catch(() => app.process().kill());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ results, consoleErrors, requests, previewPath }, null, 2));
    console.log(`Smoke evidence: ${runDir}`);
  }
})();
