'use strict';

// Only this suite's random-port RPC server, loopback pages and disposable
// profile are used. No installed Orbit, Discord process or port 39231 is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const appDir = path.resolve(__dirname, '..');
const runDir = path.resolve(appDir, '..', '..', 'work', `rpc-${Date.now()}`);
const profileDir = path.join(runDir, 'profile');
require('./legacy-profile.cjs')(profileDir);
const extensionProject = path.join(runDir, 'fixture-project');
const extensionDir = path.join(extensionProject, 'extension');
const sidecar = path.join(profileDir, 'orbit-rpc-extensions.json');
const draftMarker = 'fixture-form-draft-do-not-send-707';
const privateMarker = 'fixture-incognito-do-not-send-483';
const unapprovedMarker = 'fixture-unapproved-space-do-not-send-621';
const results = [], runtimeErrors = [], rpcRequests = [];
let app, ui, shellID, baseURL, rpcOrigin, extensionID, personalSpace, env;
fs.mkdirSync(extensionDir, { recursive: true });
fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
  name: 'Discord Custom RPC Signal', version: '0.4.2', manifest_version: 3,
  orbit_rpc_bridge: { version: 1, endpoint: 'http://127.0.0.1:39231' },
}, null, 2));

const rpcServer = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    rpcRequests.push({ route: req.url, method: req.method, payload, receivedAt: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    if (!req.aborted) { res.writeHead(400, { 'Content-Type': 'application/json' });res.end(JSON.stringify({ ok: false })); }
  }
});
const siteServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/favicon.ico') { res.writeHead(404);res.end();return; }
  const media = pathname === '/media';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>RPC fixture ${pathname}</title>
    <meta name="description" content="Fixture page metadata, never form contents"><meta property="og:site_name" content="Orbit RPC local fixture">
    <style>body{font:18px Segoe UI,sans-serif;margin:48px;background:#f5f8fc;color:#253b51}video{width:320px;background:#162d43}</style>
    <h1>Orbit RPC local fixture</h1><input id="draft" value="${draftMarker}"><textarea id="notes">${draftMarker}</textarea><div contenteditable="true">${draftMarker}</div>
    ${media ? '<video id="video" autoplay muted playsinline></video>' : ''}
    <script>
      window.fixturePagePath=${JSON.stringify(pathname)};window.fixtureTrapReads=0;
      ${media ? `
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');let frame=0;
        const draw=()=>{ctx.fillStyle=frame++%2?'#4f8aa5':'#3263a0';ctx.fillRect(0,0,320,180);};
        draw();window.fixtureTimer=setInterval(draw,33);video.srcObject=canvas.captureStream(30);video.play().catch(error=>window.fixtureMediaError=error.message);
        navigator.mediaSession.metadata=new MediaMetadata({title:'RPC Media Fixture',artist:'Fixture Artist',album:'Fixture Album',artwork:[]});
        navigator.mediaSession.playbackState='playing';
      ` : ''}
      // A scraper in the page's main world would hit this trap. The real
      // browser collector must keep its own isolated DOM wrapper instead.
      document.querySelector=()=>{window.fixtureTrapReads++;throw new Error('Page-world querySelector trap');};
    </script></html>`);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, label, timeout = 12000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(read, accept, label, timeout = 12000) {
  const until = Date.now() + timeout;
  let last, lastError;
  while (Date.now() < until) {
    try { last = await read();if (accept(last)) return last; } catch (error) { lastError = error; }
    await sleep(70);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}; last=${JSON.stringify(last)}`);
}
async function check(name, callback) {
  const started = Date.now();
  console.log(`RUN  ${name}`);
  try { await callback();results.push({ name, passed: true, ms: Date.now() - started });console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, ms: Date.now() - started, error: error.stack });throw error; }
}
async function state(page = ui) { return page.evaluate(() => window.browser.getState()); }
async function action(name, payload = {}, page = ui) {
  return deadline(page.evaluate(({ name, payload }) => window.browser.action(name, payload), { name, payload }), `action ${name}`);
}
async function pageShellID(page) {
  const handle = await app.browserWindow(page);
  try { return await handle.evaluate(win => win.id); } finally { await handle.dispose(); }
}
async function guest(url, ownerID = shellID) {
  return eventually(() => app.evaluate(({ BrowserWindow }, { url, ownerID }) => {
    return BrowserWindow.fromId(ownerID)?.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL() === url && !view.webContents.isLoading())?.webContents.id;
  }, { url, ownerID }), Boolean, `fixture guest ${new URL(url).pathname}`);
}
async function script(id, code) {
  return deadline(app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code, true), { id, code }), `fixture script ${id}`, 6000);
}
async function navigate(pathname, { page = ui, newTab = false } = {}) {
  const url = `${baseURL}${pathname}`;
  await action(newTab ? 'newTab' : 'navigate', newTab ? { url } : { input: url }, page);
  return guest(url, await pageShellID(page));
}
async function dialogs(approve = true) {
  await app.evaluate(({ dialog }, { extensionProject, approve }) => {
    globalThis.__orbitRPCDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      globalThis.__orbitRPCDialogs.push({ kind: 'open', options: args.at(-1) });
      return { canceled: false, filePaths: [extensionProject] };
    };
    dialog.showMessageBox = async (...args) => {
      globalThis.__orbitRPCDialogs.push({ kind: 'approval', options: args.at(-1) });
      return { response: approve ? 1 : 0 };
    };
  }, { extensionProject, approve });
}
async function launch() {
  app = await electron.launch({ args: [appDir], env, timeout: 30000 });
  app.process().stderr.on('data', data => {
    const text = data.toString();if (/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(text)) runtimeErrors.push(text.trim());
  });
  ui = await app.firstWindow();
  ui.on('pageerror', error => runtimeErrors.push(error.message));
  await ui.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'));
  shellID = await pageShellID(ui);
  await action('autoPip', { enabled: false });
  await dialogs();
}
async function closeApp() {
  if (!app) return;
  const closing = app;app = null;
  await deadline(closing.close(), 'own RPC test app shutdown', 10000).catch(() => closing.process().kill());
}
function latest(route, predicate = () => true, after = 0) {
  return rpcRequests.slice(after).findLast(request => request.route === route && predicate(request.payload));
}
async function tabPayload(pathname, after = 0, predicate = () => true) {
  return eventually(() => latest('/api/tab', payload => payload.url === `${baseURL}${pathname}` && predicate(payload), after)?.payload, Boolean, `RPC payload for ${pathname}`);
}
async function idle(after = 0) {
  return eventually(() => latest('/api/extension', payload => payload.event === 'idle' && Array.isArray(payload.tabIds) && payload.tabIds.length === 0, after), Boolean, 'empty RPC idle heartbeat');
}
function assertNoExcludedPayloads() {
  const wire = JSON.stringify(rpcRequests);
  assert.equal(wire.includes(draftMarker), false, 'Form drafts or editable text reached the RPC API');
  assert.equal(wire.includes(privateMarker), false, 'A private-window URL reached the RPC API');
  assert.equal(wire.includes(unapprovedMarker), false, 'An unapproved-space URL reached the RPC API');
}

(async () => {
  try {
    rpcServer.listen(0, '127.0.0.1');siteServer.listen(0, '127.0.0.1');
    await Promise.all([once(rpcServer, 'listening'), once(siteServer, 'listening')]);
    assert.notEqual(rpcServer.address().port, 39231, 'The real RPC app port must never be used');
    assert.notEqual(siteServer.address().port, 39231, 'The real RPC app port must never be used');
    rpcOrigin = `http://127.0.0.1:${rpcServer.address().port}`;
    baseURL = `http://127.0.0.1:${siteServer.address().port}`;
    env = { ...process.env, ORBIT_PROFILE: profileDir, ORBIT_TEST_MODE: '1', ORBIT_RPC_ENDPOINT: rpcOrigin, ORBIT_DOWNLOAD_DIR: path.join(runDir, 'downloads') };
    delete env.ELECTRON_RUN_AS_NODE;
    await launch();
    personalSpace = (await state()).activeSpaceId;
    let pageA, pageAID, pageBID, mediaWC;

    await check('No RPC traffic starts before the project-root extension receives approval', async () => {
      pageA = await navigate('/page-a');pageAID = (await state()).activeTabId;
      await dialogs(false);await action('loadExtension');
      assert.equal((await state()).extensions.some(extension => extension.compatibility === 'orbit-rpc'), false);
      assert.equal(fs.existsSync(sidecar), false);
      assert.equal(rpcRequests.length, 0);
      const prompts = await app.evaluate(() => globalThis.__orbitRPCDialogs);
      assert.equal(prompts.filter(prompt => prompt.kind === 'approval').length, 1);
      assert.match(prompts.find(prompt => prompt.kind === 'approval').options.detail, /현재 스페이스.*제목·주소.*미디어/);
    });

    await check('Selecting the project root loads extension/ and enables the Orbit RPC adapter', async () => {
      await dialogs();await action('loadExtension');
      const extension = (await state()).extensions.find(extension => extension.compatibility === 'orbit-rpc');
      assert.ok(extension);extensionID = extension.id;
      assert.equal(extension.name, 'Discord Custom RPC Signal');assert.equal(extension.version, '0.4.2');
      const records = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      assert.equal(records.length, 1);assert.equal(records[0].directory, extensionDir);assert.equal(records[0].spaceId, personalSpace);
      const payload = await tabPayload('/page-a');
      assert.equal(payload.browser, 'orbit');assert.equal(payload.tabId, pageAID);assert.equal(payload.active, true);
      assert.equal(payload.title, 'RPC fixture /page-a');
      assert.equal(payload.description, 'Fixture page metadata, never form contents');
      assert.equal(payload.siteName, 'Orbit RPC local fixture');
      assert.ok(latest('/api/extension', value => value.event === 'started' && value.tabIds.includes(pageAID)));
      assert.equal((await state()).extensions.find(extension => extension.id === extensionID).connection.endpoint, rpcOrigin);
    });

    await check('Collection uses an isolated world and never exposes a page bridge or form values', async () => {
      assert.deepEqual(await script(pageA, '({trapReads:fixtureTrapReads,require:typeof require,process:typeof process,browser:typeof window.browser,bridge:typeof window.OrbitRpcBridge})'), { trapReads: 0, require: 'undefined', process: 'undefined', browser: 'undefined', bridge: 'undefined' });
      assertNoExcludedPayloads();
    });

    await check('Switching real tabs updates the active browser URL, title and tab ID', async () => {
      const start = rpcRequests.length;
      await navigate('/page-b', { newTab: true });pageBID = (await state()).activeTabId;
      const payload = await tabPayload('/page-b', start);
      assert.equal(payload.tabId, pageBID);assert.equal(payload.active, true);assert.equal(payload.title, 'RPC fixture /page-b');
      assert.notEqual(pageBID, pageAID);
      await action('activateTab', { id: pageAID });
      const back = await tabPayload('/page-a', rpcRequests.length);
      assert.equal(back.tabId, pageAID);assert.equal(back.active, true);
    });

    await check('Actual canvas video and Media Session metadata are delivered as media activity', async () => {
      const start = rpcRequests.length;
      mediaWC = await navigate('/media', { newTab: true });
      await eventually(() => script(mediaWC, '({ready:video.readyState,paused:video.paused,width:video.videoWidth})'), value => value.ready >= 2 && !value.paused && value.width === 320, 'real fixture video playback');
      const payload = await tabPayload('/media', start, value => value.media?.title === 'RPC Media Fixture' && value.media.paused === false);
      assert.equal(payload.media.provider, 'genericMedia');assert.equal(payload.media.kind, 'video');
      assert.equal(payload.media.artist, 'Fixture Artist');assert.equal(payload.media.album, 'Fixture Album');
      assert.equal(payload.media.linkUrl, `${baseURL}/media`);assert.ok(payload.media.currentTime >= 0);
      assert.equal(payload.media.duration, null);
      assert.equal(await script(mediaWC, 'fixtureTrapReads'), 0);
      assertNoExcludedPayloads();
    });

    await check('An unapproved space sends idle and never exposes its URL or form draft', async () => {
      const start = rpcRequests.length;
      await action('switchSpace', { id: 'work' });
      await navigate('/' + unapprovedMarker);
      assert.equal((await state()).extensions.some(extension => extension.compatibility === 'orbit-rpc'), false);
      await idle(start);
      assertNoExcludedPayloads();
      await action('switchSpace', { id: personalSpace });
      await script(mediaWC, 'video.pause();clearInterval(fixtureTimer);true');
    });

    await check('The new-tab home sends an empty idle heartbeat without an internal URL', async () => {
      const start = rpcRequests.length;
      await action('newTab');await idle(start);
      assert.equal(rpcRequests.some(request => request.route === '/api/tab' && String(request.payload.url).startsWith('orbit:')), false);
    });

    await check('Incognito browsing stays outside RPC registration and all activity payloads', async () => {
      const created = app.waitForEvent('window');await action('newIncognitoWindow');
      const privatePage = await deadline(created, 'private test window');
      privatePage.on('pageerror', error => runtimeErrors.push(error.message));
      await privatePage.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'));
      const start = rpcRequests.length;
      await navigate('/' + privateMarker, { page: privatePage });
      assert.equal((await state(privatePage)).incognito, true);
      assert.equal((await state(privatePage)).extensions.some(extension => extension.compatibility === 'orbit-rpc'), false);
      const rejected = await action('loadExtension', {}, privatePage).then(() => '', error => error.message);
      assert.match(rejected, /일반 창/);
      await idle(start);assertNoExcludedPayloads();
      await action('closeWindow', {}, privatePage).catch(error => { if (!/closed|destroyed|context/i.test(error.message)) throw error; });
      await eventually(state, value => value.windowCount === 1, 'own private fixture window closed');
    });

    await check('A cold restart restores the approved sidecar adapter and resumes real tab updates', async () => {
      await closeApp();
      const start = rpcRequests.length;
      await launch();
      const restored = (await state()).extensions.find(extension => extension.compatibility === 'orbit-rpc');
      assert.ok(restored);assert.equal(restored.id, extensionID);
      await navigate('/restored');
      const payload = await tabPayload('/restored', start);
      assert.equal(payload.title, 'RPC fixture /restored');assert.equal(payload.active, true);
      assertNoExcludedPayloads();
    });

    await check('Removing the adapter sends idle, clears the sidecar and stops further posts', async () => {
      const start = rpcRequests.length;
      await action('removeExtension', { id: extensionID });await idle(start);
      assert.equal((await state()).extensions.some(extension => extension.id === extensionID), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, 'utf8')), []);
      const stoppedCount = rpcRequests.length;
      await sleep(3300);assert.equal(rpcRequests.length, stoppedCount);
      await closeApp();await launch();
      assert.equal((await state()).extensions.some(extension => extension.compatibility === 'orbit-rpc'), false);
      const coldCount = rpcRequests.length;
      await sleep(3300);assert.equal(rpcRequests.length, coldCount);
    });

    await check('Deleting an approved space removes its RPC registration and sends idle', async () => {
      const created = await action('createSpace', { name: 'RPC deletion fixture', color: '#bbccee' });
      const deletedSpaceID = created.activeSpaceId;
      assert.notEqual(deletedSpaceID, personalSpace);
      await navigate('/space-delete-fixture');
      await dialogs();
      const started = rpcRequests.length;
      await action('loadExtension');
      const approved = (await state()).extensions.find(extension => extension.compatibility === 'orbit-rpc');
      assert.ok(approved);
      assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8'))[0].spaceId, deletedSpaceID);
      await tabPayload('/space-delete-fixture', started);

      const deleting = rpcRequests.length;
      await action('deleteSpace', { id: deletedSpaceID });
      await idle(deleting);
      const remaining = await state();
      assert.equal(remaining.spaces.some(space => space.id === deletedSpaceID), false);
      assert.ok(remaining.spaces.some(space => space.id === personalSpace));
      assert.equal(remaining.extensions.some(extension => extension.compatibility === 'orbit-rpc'), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, 'utf8')), []);
      const stoppedCount = rpcRequests.length;
      await sleep(3300);
      assert.equal(rpcRequests.length, stoppedCount, 'The deleted space kept an RPC heartbeat running');
      assertNoExcludedPayloads();
    });

    await check('RPC integration finishes without uncaught errors or excluded data', async () => {
      assert.deepEqual(runtimeErrors, []);assertNoExcludedPayloads();
      assert.ok(rpcRequests.every(request => request.method === 'POST' && ['/api/tab', '/api/extension'].includes(request.route)));
    });
    console.log(`\n${results.length} RPC integration checks passed.`);
  } catch (error) {
    console.error(error.stack);process.exitCode = 1;
    if (ui && !ui.isClosed()) await ui.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  } finally {
    await closeApp();
    for (const server of [rpcServer, siteServer]) { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ results, runtimeErrors, rpcOrigin, fixtureOrigin: baseURL, requests: rpcRequests }, null, 2));
    console.log(`RPC evidence: ${runDir}`);
  }
})();
