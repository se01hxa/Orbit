'use strict';

// Feature regressions run against disposable profiles, loopback pages and
// explicitly selected fixtures. They never inspect an installed browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const appDir = path.resolve(__dirname, '..');
const runDir = path.resolve(appDir, '..', '..', 'work', `features-${Date.now()}`);
const profileDir = path.join(runDir, 'profile');
require('./legacy-profile.cjs')(profileDir);
const fixtureDir = path.join(runDir, 'fixtures');
const results = [];
const runtimeErrors = [];
const requests = [];
const windows = [];
const previewPaths = {
  home: path.resolve(appDir, '..', 'orbit-preview-v3.png'),
  menu: path.resolve(appDir, '..', 'orbit-menu-v3.png'),
  card: path.resolve(appDir, '..', 'orbit-card-v3.png'),
};
let app, ui, baseURL, mainShellID, primaryTabID, mainWC;
fs.mkdirSync(fixtureDir, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}
function fixturePNG() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((16 * 4 + 1) * 16);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const index = y * 65 + 1 + x * 4;
    pixels.set([38 + x * 9, 110 + y * 6, 190, 255], index);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const iconBytes = fixturePNG();
fs.writeFileSync(path.join(fixtureDir, 'favicon.png'), iconBytes);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push(url.pathname);
  if (url.pathname === '/favicon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(iconBytes); return;
  }
  if (url.pathname === '/bad-favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>window.faviconExecuted=true</script><rect width="16" height="16"/></svg>'); return;
  }
  const favicon = url.pathname === '/svg-favicon' ? '/bad-favicon.svg' : '/favicon.png';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Feature fixture ${url.pathname}</title>
    <link rel="icon" type="${favicon.endsWith('svg') ? 'image/svg+xml' : 'image/png'}" href="${favicon}">
    <style>body{margin:48px;font:18px sans-serif;line-height:2;color:#1e3449;background:#f5fafb}article{max-width:700px}</style>
    <article><h1>Orbit feature fixture</h1><p>Find this orbitword. A second orbitword. A third orbitword.</p><p id="cookie"></p></article>
    <script>document.querySelector('#cookie').textContent=document.cookie;window.fixtureIdentity=${JSON.stringify(url.pathname)};</script></html>`);
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
    await sleep(70);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}${lastError ? ` (${lastError.message})` : ''}`);
}
async function check(name, callback) {
  const started = Date.now();
  try { await callback(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, ms: Date.now() - started, error: error.stack }); throw error; }
}
async function state(page = ui) { return page.evaluate(() => window.browser.getState()); }
async function action(name, payload = {}, page = ui) {
  return deadline(page.evaluate(({ name, payload }) => window.browser.action(name, payload), { name, payload }), `action ${name}`);
}
async function capture(output) {
  await ui.evaluate(async () => {
    document.activeElement?.blur();
    if (typeof hideToast === 'function') hideToast();
    await new Promise(resolve => setTimeout(resolve, 200));
    await Promise.allSettled(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await ui.screenshot({ path: output, scale: 'css' });
}
async function shellID(page) {
  const handle = await app.browserWindow(page);
  try { return await handle.evaluate(win => win.id); } finally { await handle.dispose(); }
}
async function guest(url, shell = mainShellID) {
  return eventually(() => app.evaluate(({ BrowserWindow }, { url, shell }) => {
    const owner = BrowserWindow.fromId(shell);
    return owner?.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL() === url && !view.webContents.isLoading())?.webContents.id;
  }, { url, shell }), Boolean, `guest ${url} in window ${shell}`);
}
async function script(id, code) {
  return deadline(app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code, true), { id, code }), `guest ${id} script`, 6000);
}
async function navigate(pathname, page = ui) {
  await action('navigate', { input: `${baseURL}${pathname}` }, page);
  return guest(`${baseURL}${pathname}`, await shellID(page));
}
async function newWindow(name) {
  const created = app.waitForEvent('window');
  await action(name);
  const page = await deadline(created, name);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  try{await page.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'));}catch(error){console.error('New window diagnostics:',JSON.stringify({url:page.url(),errors:runtimeErrors,body:await page.locator('body').innerText().catch(()=>''),state:await page.evaluate(()=>({bridge:!!window.browser,ready:document.readyState})).catch(()=>null)}));throw error;}
  windows.push(page);
  return page;
}
async function fixtureDialogs({ openPath = null, savePath = null } = {}) {
  await app.evaluate(({ dialog }, { openPath, savePath }) => {
    globalThis.__orbitFeatureDialogs ||= [];
    dialog.showOpenDialog = async (...args) => {
      globalThis.__orbitFeatureDialogs.push({ kind: 'open', options: args.at(-1) });
      return { canceled: !openPath, filePaths: openPath ? [openPath] : [] };
    };
    dialog.showSaveDialog = async (...args) => {
      globalThis.__orbitFeatureDialogs.push({ kind: 'save', options: args.at(-1) });
      return { canceled: !savePath, filePath: savePath || undefined };
    };
    dialog.showMessageBox = async (...args) => {
      globalThis.__orbitFeatureDialogs.push({ kind: 'message', options: args.at(-1) });
      return { response: 1 };
    };
  }, { openPath, savePath });
}
function profileFiles(directory = profileDir) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? profileFiles(absolute) : [absolute];
  });
}
function assertNoPrivateMarkers(files) {
  for (const file of files) {
    if (fs.statSync(file).size > 12 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes(Buffer.from('private-secret-marker-48391')), false, `private URL leaked to ${path.relative(profileDir, file)}`);
    assert.equal(bytes.includes(Buffer.from('secret-48391')), false, `private cookie leaked to ${path.relative(profileDir, file)}`);
  }
}

(async () => {
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    baseURL = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, ORBIT_TEST_MODE: '1', ORBIT_PROFILE: profileDir, ORBIT_DOWNLOAD_DIR: path.join(runDir, 'downloads') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [appDir], env, timeout: 30000 });
    app.process().stderr.on('data', data => {
      const text = data.toString();
      if (/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(text)) runtimeErrors.push(text.trim());
    });
    ui = await app.firstWindow(); windows.push(ui);
    ui.on('pageerror', error => runtimeErrors.push(error.message));
    await ui.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'));
    mainShellID = await shellID(ui);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setContentSize(1380, 900), mainShellID);
    await fixtureDialogs();

    await check('Home uses actual site image assets and controls use vector icons', async () => {
      await eventually(() => ui.locator('.quick-link img, .quick-links img, .quick-links .site-icon img').count(), count => count >= 4, 'four site icon images');
      const icons = await ui.locator('.quick-link img, .quick-links img, .quick-links .site-icon img').evaluateAll(nodes => nodes.map(node => ({ source: node.getAttribute('src'), loaded: node.complete && node.naturalWidth > 0 })));
      assert.ok(icons.every(icon => icon.loaded));
      assert.ok(icons.some(icon => /google/i.test(icon.source)));
      assert.ok(icons.some(icon => /youtube/i.test(icon.source)));
      const controls = await ui.locator('#newTabButton, #settingsButton, #downloadsButton, #minimizeButton, #maximizeButton, #closeButton').evaluateAll(nodes => nodes.map(node => ({ id: node.id, svg: Boolean(node.querySelector('svg')), text: node.textContent.trim() })));
      assert.ok(controls.length >= 3);
      assert.ok(controls.every(control => control.svg && !/[×✕✖📌]/u.test(control.text)), JSON.stringify(controls));
      await capture(previewPaths.home);
    });

    await check('A real page favicon is fetched and persisted as a raster image', async () => {
      mainWC = await navigate('/main'); primaryTabID = (await state()).activeTabId;
      const value = await eventually(state, value => /^data:image\/png;base64,/.test(value.tabs.find(tab => tab.id === primaryTabID)?.faviconURL || ''), 'native favicon update');
      const favicon = value.tabs.find(tab => tab.id === primaryTabID).faviconURL;
      assert.ok(favicon.length < 128 * 1024);
      assert.ok(requests.includes('/favicon.png'));
      assert.equal(await script(mainWC, 'typeof window.faviconExecuted'), 'undefined');
      await action('newTab', { url: `${baseURL}/svg-favicon` });
      await guest(`${baseURL}/svg-favicon`);
      const svgTab = (await state()).activeTabId;
      await eventually(() => requests.includes('/bad-favicon.svg'), Boolean, 'SVG fixture requested');
      await sleep(250);
      assert.doesNotMatch((await state()).tabs.find(tab => tab.id === svgTab).faviconURL || '', /^data:image\/svg/i);
      await action('activateTab', { id: primaryTabID });
    });

    await check('Folders create, rename, collapse and keep moved tabs after folder deletion', async () => {
      await action('createFolder', { name: 'Research' });
      let folder = (await state()).folders.find(folder => folder.name === 'Research');
      assert.ok(folder);
      await action('renameFolder', { id: folder.id, name: 'Focused research' });
      await action('moveTab', { id: primaryTabID, folderId: folder.id });
      await action('toggleFolder', { id: folder.id });
      let value = await state();
      assert.equal(value.folders.find(item => item.id === folder.id).name, 'Focused research');
      assert.equal(value.folders.find(item => item.id === folder.id).collapsed, true);
      assert.equal(value.tabs.find(tab => tab.id === primaryTabID).folderId, folder.id);
      await action('deleteFolder', { id: folder.id });
      value = await state();
      assert.equal(value.folders.some(item => item.id === folder.id), false);
      assert.equal(value.tabs.find(tab => tab.id === primaryTabID).folderId, null);
    });

    await check('Tab reordering updates sidebar order without changing the active page', async () => {
      await action('newTab', { url: `${baseURL}/reorder` });
      const moved = (await state()).activeTabId;
      await action('reorderTab', { id: moved, beforeId: primaryTabID });
      const value = await state();
      assert.ok(value.tabs.findIndex(tab => tab.id === moved) < value.tabs.findIndex(tab => tab.id === primaryTabID));
      assert.equal(value.activeTabId, moved);
      await action('activateTab', { id: primaryTabID });
    });

    await check('Moving a tab between spaces recreates its page with the destination cookie store', async () => {
      const personal = (await state()).activeSpaceId;
      await action('newTab', { url: `${baseURL}/move-space` });
      const movedID = (await state()).activeTabId, sourceWC = await guest(`${baseURL}/move-space`);
      await script(sourceWC, 'document.cookie="orbitMove=personal;path=/;max-age=3600";true');
      await action('moveTab', { id: movedID, spaceId: 'work', folderId: null });
      await action('switchSpace', { id: 'work' }); await action('activateTab', { id: movedID });
      const destinationWC = await guest(`${baseURL}/move-space`);
      assert.notEqual(destinationWC, sourceWC);
      assert.equal(await script(destinationWC, 'document.cookie'), '');
      await action('switchSpace', { id: personal }); await action('activateTab', { id: primaryTabID });
    });

    await check('Favorites retain the real favicon and open the selected site', async () => {
      await action('favoriteTab', { id: primaryTabID });
      const favorite = (await state()).favorites.find(item => item.url === `${baseURL}/main`);
      assert.ok(favorite);
      assert.match(favorite.faviconURL, /^data:image\/png;base64,/);
      await action('openFavorite', { id: favorite.id });
      const opened = await state();
      assert.equal(opened.tabs.find(tab => tab.id === opened.activeTabId)?.url, `${baseURL}/main`);
      await action('removeFavorite', { id: favorite.id });
      assert.equal((await state()).favorites.some(item => item.id === favorite.id), false);
    });

    await check('Closed tabs enter the archive and restore with their original URL', async () => {
      await action('newTab', { url: `${baseURL}/archive` });
      const archivedID = (await state()).activeTabId;
      await action('closeTab', { id: archivedID });
      const archived = (await state()).archivedTabs.find(tab => tab.id === archivedID);
      assert.ok(archived); assert.equal(archived.url, `${baseURL}/archive`);
      await action('reopenTab', { id: archivedID });
      let value = await state();
      assert.equal(value.tabs.find(tab => tab.id === value.activeTabId)?.url, `${baseURL}/archive`);
      assert.equal(value.archivedTabs.some(tab => tab.id === archivedID), false);
      await action('clearArchive'); assert.deepEqual((await state()).archivedTabs, []);
      await action('activateTab', { id: primaryTabID });
    });

    await check('Archiving the current space keeps pinned pages and records ordinary pages', async () => {
      await action('pinTab', { id: primaryTabID });
      await action('newTab', { url: `${baseURL}/archive-all` });
      const ordinaryID = (await state()).activeTabId;
      await action('archiveAll');
      const value = await state();
      assert.equal(value.tabs.find(tab => tab.id === primaryTabID)?.pinned, true);
      assert.equal(value.tabs.some(tab => tab.id === ordinaryID), false);
      assert.ok(value.archivedTabs.some(tab => tab.id === ordinaryID));
      assert.equal(value.activeTabId, primaryTabID);
      await action('clearArchive');
    });

    await check('Native find reports real matches and zoom controls update the page', async () => {
      mainWC = await guest(`${baseURL}/main`);
      assert.equal(await script(mainWC, 'document.body.textContent.includes("orbitword")'), true);
      await app.evaluate(({ webContents }, id) => {
        globalThis.__orbitFeatureFindEvents = [];
        webContents.fromId(id).on('found-in-page', (_event, result) => globalThis.__orbitFeatureFindEvents.push(result));
      }, mainWC);
      await ui.locator('#homeButton').click();
      await ui.locator('.app-menu [data-action="find"]').click();
      await ui.locator('#findInput').waitFor({ state: 'visible' });
      await ui.locator('#findInput').fill('orbitword');
      let found;
      try { found = await eventually(state, value => value.findResult?.matches === 3, 'native find results'); }
      catch (error) {
        await app.evaluate(({ webContents }, id) => {
          const wc = webContents.fromId(id);wc.focus();
          globalThis.__orbitFeatureDirectFind = wc.findInPage('orbitword');
        }, mainWC);
        await sleep(500);
        const diagnostic = await app.evaluate(({ BrowserWindow, webContents }, { shell, id }) => ({
          events: globalThis.__orbitFeatureFindEvents,
          directFind: globalThis.__orbitFeatureDirectFind,
          guest: { url: webContents.fromId(id)?.getURL(), destroyed: !webContents.fromId(id), focused: webContents.fromId(id)?.isFocused() },
          views: BrowserWindow.fromId(shell)?.contentView.children.map(view => ({ id: view.webContents?.id, visible: view.getVisible(), bounds: view.getBounds() })),
        }), { shell: mainShellID, id: mainWC });
        throw new Error(`${error.message}; native diagnostic=${JSON.stringify(diagnostic)}`);
      }
      assert.equal(found.findResult.activeMatchOrdinal, 1);
      assert.equal(await ui.locator('#findInput').evaluate(input => input === document.activeElement), true);
      await ui.locator('#findInput').press('Enter');
      await eventually(state, value => value.findResult?.activeMatchOrdinal === 2, 'next native find result');
      assert.equal(await ui.locator('#findInput').evaluate(input => input === document.activeElement), true);
      await ui.locator('#findClose').click();
      await action('zoom', { delta: .1 });
      assert.ok((await state()).zoomFactor > 1);
      await action('zoom', { reset: true });
      assert.equal((await state()).zoomFactor, 1);
    });

    await check('Copy URL and printing use the current native web page', async () => {
      // Intercept the native write so the suite never changes the user's clipboard.
      await app.evaluate(({ clipboard }) => {
        const original = clipboard.writeText;
        globalThis.__orbitFeatureCopiedURLs = [];
        clipboard.writeText = text => { globalThis.__orbitFeatureCopiedURLs.push(text); };
        globalThis.__orbitFeatureRestoreClipboard = () => { clipboard.writeText = original; };
      });
      try {
        await action('copyURL');
        assert.deepEqual(await app.evaluate(() => globalThis.__orbitFeatureCopiedURLs), [`${baseURL}/main`]);
      } finally { await app.evaluate(() => globalThis.__orbitFeatureRestoreClipboard()); }
      await app.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id);
        globalThis.__orbitFeaturePrintCalls = [];
        const original = wc.print;
        wc.print = (options, callback) => { globalThis.__orbitFeaturePrintCalls.push({ id, options }); callback?.(true); };
        globalThis.__orbitFeatureRestorePrint = () => { wc.print = original; };
      }, mainWC);
      try {
        await action('print');
        const calls = await app.evaluate(() => globalThis.__orbitFeaturePrintCalls);
        assert.equal(calls.length, 1); assert.equal(calls[0].id, mainWC);
      } finally { await app.evaluate(() => globalThis.__orbitFeatureRestorePrint()); }
    });

    await check('Save PDF creates a valid file only at the selected destination', async () => {
      const outputPath = path.join(runDir, 'fixture-page.pdf');
      await fixtureDialogs({ savePath: outputPath });
      await action('savePDF');
      await eventually(() => fs.existsSync(outputPath), Boolean, 'PDF output');
      assert.equal(fs.readFileSync(outputPath).subarray(0, 5).toString(), '%PDF-');
      await fixtureDialogs();
    });

    await check('Bookmark import requires a selected file and safely imports Chromium JSON and HTML', async () => {
      const jsonPath = path.join(fixtureDir, 'Bookmarks');
      fs.writeFileSync(jsonPath, JSON.stringify({ roots: { bar: { type: 'folder', name: 'Imported JSON', children: [{ type: 'url', name: 'JSON item', url: `${baseURL}/import-json` }, { type: 'url', name: 'Unsafe', url: 'javascript:alert(1)' }] } } }));
      const before = (await state()).tabs.length;
      await fixtureDialogs();
      await action('importBookmarks', { path: jsonPath });
      assert.equal((await state()).tabs.length, before, 'renderer-supplied paths must not bypass native selection');
      await fixtureDialogs({ openPath: jsonPath }); await action('importBookmarks');
      let value = await state();
      assert.ok(value.tabs.some(tab => tab.url === `${baseURL}/import-json` && tab.pinned));
      assert.ok(value.folders.some(folder => folder.name === 'Imported JSON'));
      const htmlPath = path.join(fixtureDir, 'bookmarks.html');
      fs.writeFileSync(htmlPath, `<DL><DT><H3>Imported HTML</H3><DL><DT><A HREF="${baseURL}/import-html?one=1&amp;two=2">HTML item</A><DT><A HREF="file:///C:/private">Unsafe</A></DL></DL>`);
      await fixtureDialogs({ openPath: htmlPath }); await action('importBookmarks');
      value = await state();
      assert.ok(value.tabs.some(tab => tab.url === `${baseURL}/import-html?one=1&two=2` && tab.pinned));
      assert.equal(value.tabs.some(tab => /^(?:javascript|file):/.test(tab.url)), false);
      await fixtureDialogs();
      await action('activateTab', { id: primaryTabID });
    });

    await check('Profile card stores bounded customization and saves only a selected PNG', async () => {
      await action('profile', { displayName: '나의 인터넷', tagline: '좋아하는 곳을, 나의 속도로', cardSeed: 7 });
      assert.deepEqual({ ...((await state()).profile), joinedAt: undefined }, { displayName: '나의 인터넷', tagline: '좋아하는 곳을, 나의 속도로', cardSeed: 7, joinedAt: undefined });
      const cardPath = path.join(runDir, 'orbit-card.png');
      await fixtureDialogs({ savePath: cardPath });
      await action('saveCard', { dataURL: `data:image/png;base64,${iconBytes.toString('base64')}` });
      const saved = fs.readFileSync(cardPath);
      assert.equal(saved.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(saved.readUInt32BE(16), 16); assert.equal(saved.readUInt32BE(20), 16);
      const badPath = path.join(runDir, 'bad-card.png');
      await fixtureDialogs({ savePath: badPath });
      await action('saveCard', { dataURL: 'data:image/svg+xml;base64,PHN2Zy8+' }).catch(() => {});
      assert.equal(fs.existsSync(badPath), false);
      await fixtureDialogs();
    });

    await check('The app menu exposes vector controls and draws a real personalized card', async () => {
      await ui.locator('#homeButton').click();
      const menu = ui.locator('.app-menu');
      await menu.waitFor({ state: 'visible' });
      const items = await menu.locator('[role="menuitem"]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent.trim(), svg: Boolean(node.querySelector('svg')) })));
      assert.ok(items.length >= 10);
      assert.ok(items.every(item => item.svg), JSON.stringify(items));
      await capture(previewPaths.menu);
      await menu.locator('[data-action="card"]').click();
      const card = ui.locator('.card-dialog');
      await card.waitFor({ state: 'visible' });
      assert.equal(await ui.locator('#orbitCardCanvas').evaluate(canvas => canvas.width), 800);
      assert.equal(await ui.locator('#orbitCardCanvas').evaluate(canvas => canvas.height), 1180);
      const pixels = await ui.locator('#orbitCardCanvas').evaluate(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const colors = new Set();
        // A prime pixel stride samples the artwork as well as its outer margin.
        for (let i = 0; i < data.length; i += 4 * 997) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
        return colors.size;
      });
      assert.ok(pixels > 5, `card must contain real artwork, sampled colors=${pixels}`);
      await capture(previewPaths.card);
      await ui.keyboard.press('Escape');
      await card.waitFor({ state: 'hidden' });
    });

    await check('Unpacked extensions load only after folder selection and can be removed', async () => {
      const extensionPath = path.join(fixtureDir, 'extension');
      fs.mkdirSync(extensionPath);
      fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Orbit local fixture', version: '1.0.0', description: 'Disposable regression fixture', content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }] }));
      fs.writeFileSync(path.join(extensionPath, 'content.js'), 'document.documentElement.dataset.orbitExtensionFixture="active";');
      const before = (await state()).extensions.length;
      await fixtureDialogs(); await action('loadExtension', { path: extensionPath });
      assert.equal((await state()).extensions.length, before);
      await fixtureDialogs({ openPath: extensionPath }); await action('loadExtension');
      const extension = (await state()).extensions.find(item => item.name === 'Orbit local fixture');
      assert.ok(extension); assert.equal((await state()).extensionSupport, 'partial');
      mainWC = await navigate('/extension-page');
      await eventually(() => script(mainWC, 'document.documentElement.dataset.orbitExtensionFixture'), value => value === 'active', 'actual extension content script');
      await action('removeExtension', { id: extension.id });
      assert.equal((await state()).extensions.some(item => item.id === extension.id), false);
      await fixtureDialogs();
      mainWC = await navigate('/main');
    });

    await check('Additional normal windows share space cookies while private windows isolate them', async () => {
      await script(mainWC, 'document.cookie="orbitFeature=normal;path=/;max-age=3600";true');
      const normal = await newWindow('newWindow');
      assert.equal((await state(normal)).incognito, false);
      const normalWC = await navigate('/normal-window', normal);
      assert.match(await script(normalWC, 'document.cookie'), /orbitFeature=normal/);
      const privatePage = await newWindow('newIncognitoWindow');
      assert.equal((await state(privatePage)).incognito, true);
      const privateWC = await navigate('/private-secret-marker-48391', privatePage);
      assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).session.isPersistent(), privateWC), false);
      assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).session.isPersistent(), normalWC), true);
      assert.equal(await script(privateWC, 'document.cookie'), '');
      await script(privateWC, 'document.cookie="orbitPrivate=secret-48391;path=/;max-age=3600";localStorage.setItem("privateMarker","48391");true');
      assert.doesNotMatch(await script(mainWC, 'document.cookie'), /orbitPrivate/);
      assert.ok((await state()).windowCount >= 3);
      await action('closeWindow', {}, privatePage).catch(error => { if (!/closed|destroyed|context/i.test(error.message)) throw error; });
      await eventually(() => privatePage.isClosed(), Boolean, 'private window closed');
      const nextPrivate = await newWindow('newIncognitoWindow');
      const nextPrivateWC = await navigate('/private-after-close', nextPrivate);
      assert.equal(await script(nextPrivateWC, 'document.cookie'), '');
      assert.equal(await script(nextPrivateWC, 'localStorage.getItem("privateMarker")'), null);
      await action('closeWindow', {}, nextPrivate).catch(error => { if (!/closed|destroyed|context/i.test(error.message)) throw error; });
      await action('closeWindow', {}, normal).catch(error => { if (!/closed|destroyed|context/i.test(error.message)) throw error; });
      await eventually(state, value => value.windowCount === 1, 'secondary windows closed');
    });

    await check('Remote pages have no Node or privileged browser bridge', async () => {
      assert.deepEqual(await script(mainWC, '({require:typeof require,process:typeof process,browser:typeof window.browser})'), { require: 'undefined', process: 'undefined', browser: 'undefined' });
      const preferences = await app.evaluate(({ webContents }, id) => {
        const preferences = webContents.fromId(id).getLastWebPreferences();
        return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, webSecurity: preferences.webSecurity, preload: preferences.preload || null };
      }, mainWC);
      assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: null });
    });

    await check('Private URLs and cookies never enter persisted profile files', async () => {
      await sleep(300);
      // Chromium holds database files open on Windows. Inspect all browser state
      // now, then scan every closed-profile file before the cold restart below.
      const files = profileFiles().filter(file => file.endsWith('.json'));
      assert.ok(files.some(file => path.basename(file) === 'orbit-state.json'));
      assertNoPrivateMarkers(files);
    });

    await check('The last normal window restores its own tabs after the original window closes first', async () => {
      const secondary = await newWindow('newWindow');
      await navigate('/last-normal-restored-marker', secondary);
      await action('closeWindow').catch(error => { if (!/closed|destroyed|context/i.test(error.message)) throw error; });
      await eventually(() => ui.isClosed(), Boolean, 'original window closed first');
      assert.equal((await state(secondary)).windowCount, 1);
      const exited = app.waitForEvent('close');
      await action('closeWindow', {}, secondary).catch(error => { if (!/closed|destroyed|context/i.test(error.message)) throw error; });
      await deadline(exited, 'last normal window exits the app');
      app = null;
      assertNoPrivateMarkers(profileFiles());
      app = await electron.launch({ args: [appDir], env, timeout: 30000 });
      app.process().stderr.on('data', data => {
        const text = data.toString();
        if (/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(text)) runtimeErrors.push(text.trim());
      });
      ui = await app.firstWindow();
      ui.on('pageerror', error => runtimeErrors.push(error.message));
      await ui.waitForFunction(() => window.browser && document.querySelector('#workspaceSurface .pane'));
      mainShellID = await shellID(ui);
      const restored = await state();
      assert.equal(restored.tabs.find(tab => tab.id === restored.activeTabId)?.url, `${baseURL}/last-normal-restored-marker`);
      assert.equal(restored.incognito, false);
      await guest(`${baseURL}/last-normal-restored-marker`);
      const windowSnapshots = path.join(profileDir, 'windows');
      assert.deepEqual(fs.existsSync(windowSnapshots) ? fs.readdirSync(windowSnapshots).filter(name => name.endsWith('.json')) : [], []);
    });

    await check('Expanded feature flow has no renderer or main runtime errors', async () => { assert.deepEqual(runtimeErrors, []); });
    console.log(`\n${results.length} feature checks passed.`);
  } catch (error) {
    console.error(error.stack); process.exitCode = 1;
    if (ui && !ui.isClosed()) await ui.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  } finally {
    if (app) await deadline(app.close(), 'feature shutdown', 8000).catch(() => app.process().kill());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ results, runtimeErrors, requests, previewPaths }, null, 2));
    console.log(`Feature evidence: ${runDir}`);
  }
})();
