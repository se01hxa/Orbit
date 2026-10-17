'use strict';

// Motion regression checks use a temporary profile and local fixture only.
// Node identity matters here: rebuilding a card each progress event restarts
// its animation and also discards keyboard focus, even when it looks identical.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const appDir = path.resolve(__dirname, '..');
const workspace = path.resolve(appDir, '..', '..');
const runDir = path.join(workspace, 'work', `motion-${Date.now()}`);
const downloadDir = path.join(runDir, 'downloads');
const results = [];
const errors = [];
const fixtureBytes = Buffer.alloc(512 * 1024, 73);
const previewPath = path.resolve(appDir, '..', 'orbit-preview-v3.png');
const palettePath = path.resolve(appDir, '..', 'orbit-palette-v3.png');
const settingsPath = path.resolve(appDir, '..', 'orbit-settings-v3.png');
let app, ui, baseURL, guestId, tabId, homeTabId;
fs.mkdirSync(downloadDir, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="orbit-motion.bin"', 'Content-Length': fixtureBytes.length });
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      const end = Math.min(offset + 8192, fixtureBytes.length);
      res.write(fixtureBytes.subarray(offset, end)); offset = end;
      if (offset === fixtureBytes.length) { clearInterval(timer); res.end(); }
    }, 80);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  setTimeout(() => res.end('<!doctype html><html><meta charset="utf-8"><title>Motion fixture</title><style>body{background:#f6f9f3;color:#314332;font:18px Segoe UI,sans-serif;padding:60px}h1{font-size:42px;font-weight:400}</style><h1>Room for a little motion.</h1><p>A local page for testing Orbit interactions.</p><a id="download" href="/download">Download fixture</a></html>'), 200);
});

async function eventually(read, accept, label, timeout = 10000) {
  const started = Date.now();
  let value, lastError;
  while (Date.now() - started < timeout) {
    try { value = await read(); if (accept(value)) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(value)}${lastError ? `; ${lastError.message}` : ''}`);
}
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, ms: Date.now() - started, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); throw error; }
}
async function state() { return ui.evaluate(() => window.browser.getState()); }
async function action(name, payload = {}) { return ui.evaluate(({ name, payload }) => window.browser.action(name, payload), { name, payload }); }
async function nativeViews() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents && v.getVisible()).map(v => ({ id: v.webContents.id, bounds: v.getBounds() })));
}
async function guestEval(code) {
  return app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code, true), { id: guestId, code });
}
async function capture(output, final = false) {
  // Capture the resting UI instead of an arbitrary half-transparent enter frame.
  if (final) await ui.evaluate(() => document.activeElement?.blur());
  await ui.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(finite.map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  // Home and dialogs contain no visible native guest, so capture their actual
  // CSS size without the host monitor's display scaling or focus test outline.
  if (final) return ui.screenshot({ path: output, scale: 'css' });
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(output, Buffer.from(png, 'base64'));
}
async function closeOverlay() {
  await ui.keyboard.press('Escape');
  await eventually(() => ui.locator('#overlay').isVisible(), visible => !visible, 'overlay finished closing');
}
async function openPalette() {
  await ui.locator('#addressButton').click();
  await ui.locator('#paletteInput').waitFor({ state: 'visible' });
  await eventually(() => nativeViews(), visible => visible.length === 0, 'native view hidden for palette');
}

(async () => {
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    baseURL = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, ORBIT_TEST_MODE: '1', ORBIT_PROFILE: path.join(runDir, 'profile'), ORBIT_DOWNLOAD_DIR: downloadDir };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [appDir], env, timeout: 30000 });
    app.process().stderr.on('data', data => { const line = data.toString(); if (/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(line)) errors.push(line.trim()); });
    ui = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1380, 900));
    ui.on('pageerror', error => errors.push(error.message));
    await ui.waitForFunction(() => window.browser && document.querySelector('.home-title'));
    homeTabId = (await state()).activeTabId;
    await ui.emulateMedia({ reducedMotion: 'no-preference' });
    await action('motionPreference', { reduced: false });

    await check('Unrelated state snapshots keep home content and focused controls mounted', async () => {
      await ui.evaluate(() => {
        window.__motionHome = document.querySelector('.home-page');
        window.__motionSearch = document.querySelector('.home-search');
        window.__motionSearch.focus();
      });
      const value = await state();
      for (let i = 0; i < 3; i++) await action('theme', { color: value.themeColor });
      assert.deepEqual(await ui.evaluate(() => ({ sameHome: window.__motionHome === document.querySelector('.home-page'), sameSearch: window.__motionSearch === document.querySelector('.home-search'), focused: document.activeElement === window.__motionSearch })), { sameHome: true, sameSearch: true, focused: true });
      await capture(previewPath, true);
      assert.ok(fs.statSync(previewPath).size > 15000);
    });

    await check('Tab entry and exit animate while existing keyboard focus survives', async () => {
      const value = await action('newTab');
      const createdId = value.activeTabId;
      const entered = await eventually(() => ui.evaluate(id => {
        const node = document.querySelector(`#tabList [data-tab-id="${id}"]`);
        return node ? { exists: true, animated: node.getAnimations({ subtree: true }).some(a => a.playState === 'running') || node.classList.contains('tab-enter') } : { exists: false };
      }, createdId), value => value.exists, 'new tab row');
      assert.equal(entered.animated, true);
      await ui.evaluate(id => { const existing = document.querySelector(`#tabList [data-tab-id="${id}"]`); window.__motionExistingTab = existing; existing.focus(); }, homeTabId);
      await action('closeTab', { id: createdId });
      assert.equal(await ui.evaluate(() => document.activeElement === window.__motionExistingTab && window.__motionExistingTab.isConnected), true);
      const exiting = await ui.evaluate(() => [...document.querySelectorAll('#tabList .tab-leave')].map(node => ({ inert: node.inert, hidden: node.getAttribute('aria-hidden'), animated: node.getAnimations().some(a => a.playState === 'running') })));
      assert.ok(exiting.some(node => node.inert && node.hidden === 'true' && node.animated));
      await eventually(() => ui.evaluate(id => document.querySelectorAll(`#tabList [data-tab-id="${id}"]`).length, createdId), count => count === 0, 'closed tab row removed after exit');
      await eventually(() => ui.locator('#tabList .tab-leave').count(), count => count === 0, 'inert exit ghost cleaned up');
      assert.equal((await state()).tabs.some(t => t.id === createdId), false);
    });

    await check('Page title and loading updates retain tab row identity and safe literal text', async () => {
      await action('newTab', { url: `${baseURL}/motion` }); tabId = (await state()).activeTabId;
      guestId = await eventually(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL() === url && !w.isLoading()).map(w => w.id), `${baseURL}/motion`), ids => ids.length > 0, 'local web view').then(ids => ids.at(-1));
      await eventually(state, value => value.tabs.find(t => t.id === tabId)?.title === 'Motion fixture', 'initial title');
      await ui.evaluate(id => {
        const node = document.querySelector(`#tabList [data-tab-id="${id}"]`);
        window.__motionTab = node; window.__motionTabTitle = node.querySelector('.tab-title'); window.__motionTabAction = node.querySelector('.tab-action'); window.__motionTabAction.focus();
      }, tabId);
      const title = '<img src=x onerror="window.orbitInjected=true"> — updated title';
      await guestEval(`document.title=${JSON.stringify(title)};true`);
      await eventually(() => ui.evaluate(() => window.__motionTabTitle?.textContent), text => text === title, 'updated rendered title');
      assert.deepEqual(await ui.evaluate(id => ({ sameRow: window.__motionTab === document.querySelector(`#tabList [data-tab-id="${id}"]`), sameTitle: window.__motionTabTitle === window.__motionTab.querySelector('.tab-title'), focused: document.activeElement === window.__motionTabAction, noHTML: !window.__motionTab.querySelector('img') && !window.orbitInjected }), tabId), { sameRow: true, sameTitle: true, focused: true, noHTML: true });
      await action('reload');
      await eventually(state, value => value.tabs.find(t => t.id === tabId)?.loading, 'reload starts');
      assert.equal(await ui.evaluate(id => window.__motionTab === document.querySelector(`#tabList [data-tab-id="${id}"]`) && document.activeElement === window.__motionTabAction, tabId), true);
      await eventually(state, value => !value.tabs.find(t => t.id === tabId)?.loading && value.tabs.find(t => t.id === tabId)?.title === 'Motion fixture', 'reload completes');
      assert.equal(await ui.evaluate(id => window.__motionTab === document.querySelector(`#tabList [data-tab-id="${id}"]`) && window.__motionTabTitle === window.__motionTab.querySelector('.tab-title'), tabId), true);
    });

    await check('Download progress updates reuse card, progress bar, fill and keyboard focus', async () => {
      await guestEval('document.querySelector("#download").click();true');
      const value = await eventually(state, value => value.downloads.some(d => d.state === 'progressing' && d.receivedBytes > 0), 'download started');
      const item = value.downloads.find(d => d.state === 'progressing');
      await ui.locator('#downloadsButton').click();
      await ui.locator('.download-card').waitFor({ state: 'visible' });
      const before = await ui.evaluate(id => {
        const card = document.querySelector(`[data-download-id="${id}"]`);
        window.__motionCard = card; window.__motionTrack = card.querySelector('[role="progressbar"]'); window.__motionFill = window.__motionTrack.firstElementChild; window.__motionCancel = card.querySelector('button'); window.__motionCancel.focus();
        return Number(window.__motionTrack.getAttribute('aria-valuenow'));
      }, item.id);
      await eventually(state, value => value.downloads.find(d => d.id === item.id)?.receivedBytes >= item.receivedBytes + 65536, 'several download progress events');
      const after = await ui.evaluate(id => ({ sameCard: window.__motionCard === document.querySelector(`[data-download-id="${id}"]`), sameTrack: window.__motionTrack === window.__motionCard.querySelector('[role="progressbar"]'), sameFill: window.__motionFill === window.__motionTrack.firstElementChild, focused: document.activeElement === window.__motionCancel, percent: Number(window.__motionTrack.getAttribute('aria-valuenow')) }), item.id);
      assert.equal(after.sameCard && after.sameTrack && after.sameFill && after.focused, true);
      assert.ok(after.percent > before);
      const ring = await eventually(() => ui.evaluate(async id => {
        const download = (await window.browser.getState()).downloads.find(item => item.id === id);
        const card = document.querySelector(`[data-download-id="${id}"]`);
        return {
          expected: Math.min(100, Math.floor(download.receivedBytes / download.totalBytes * 100)),
          number: Number(card.querySelector('.download-ring-value').textContent),
          offset: Number(card.querySelector('.ring-value').style.strokeDashoffset),
        };
      }, item.id), value => value.expected > 0 && value.expected < 100 && value.number === value.expected && value.offset === 100 - value.expected, 'ring number and SVG arc follow actual received bytes');
      assert.deepEqual({ number: ring.number, offset: ring.offset }, { number: ring.expected, offset: 100 - ring.expected });
      await capture(path.join(runDir, 'downloads.png'));
      await eventually(state, value => value.downloads.find(d => d.id === item.id)?.state === 'completed', 'download completes');
      assert.deepEqual(fs.readFileSync(path.join(downloadDir, 'orbit-motion.bin')), fixtureBytes);
      await closeOverlay();
    });

    await check('Dialog exit keeps native page hidden until the overlay finishes', async () => {
      await openPalette();
      await ui.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      const during = await ui.evaluate(() => ({ hidden: document.querySelector('#overlay').hidden, dialog: Boolean(document.querySelector('#overlay [role="dialog"]')) }));
      assert.deepEqual(during, { hidden: false, dialog: true });
      assert.equal((await nativeViews()).length, 0);
      await eventually(() => ui.locator('#overlay').isVisible(), visible => !visible, 'dialog exit settles');
      await eventually(nativeViews, visible => visible.length === 1, 'native page restored');
    });

    await check('Rapid dialog reopening cancels stale close and preserves focused input', async () => {
      await openPalette();
      await ui.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.querySelector('#addressButton').click();
      });
      await ui.locator('#paletteInput').waitFor({ state: 'visible' });
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.deepEqual(await ui.evaluate(() => ({ hidden: document.querySelector('#overlay').hidden, dialogs: document.querySelectorAll('#overlay [role="dialog"]').length, focused: document.activeElement === document.querySelector('#paletteInput') })), { hidden: false, dialogs: 1, focused: true });
      assert.equal((await nativeViews()).length, 0);
      await ui.locator('#paletteInput').fill('오늘의 영감');
      await capture(palettePath, true);
      await closeOverlay();
      await eventually(nativeViews, visible => visible.length === 1, 'native view restored after rapid reopen');
    });

    await check('Overlay keyboard focus stays within the dialog', async () => {
      await ui.locator('#settingsButton').click();
      await ui.locator('#overlay [role="dialog"]').waitFor({ state: 'visible' });
      const count = await ui.locator('#overlay button, #overlay input, #overlay [tabindex="0"]').count();
      assert.ok(count > 2);
      await ui.evaluate(() => document.querySelector('#overlay button').focus());
      for (let i = 0; i < count + 2; i++) {
        await ui.keyboard.press('Tab');
        assert.equal(await ui.evaluate(() => document.querySelector('#overlay').contains(document.activeElement)), true);
      }
      await capture(settingsPath, true);
      await closeOverlay();
    });

    await check('Reduced motion disables sidebar interpolation and respects media changes', async () => {
      await ui.emulateMedia({ reducedMotion: 'reduce' });
      await eventually(state, value => value.reducedMotion === true, 'reduced-motion preference reaches native layout');
      const before = (await nativeViews())[0].bounds;
      const value = await action('toggleSidebar');
      const after = (await nativeViews())[0].bounds;
      const expectedX = value.sidebarCollapsed ? 82 : 266;
      assert.equal(after.x, expectedX);
      assert.notEqual(after.x, before.x);
      const durations = await ui.evaluate(() => ({ sidebar: getComputedStyle(document.querySelector('.sidebar')).transitionDuration, overlay: getComputedStyle(document.querySelector('#overlay')).animationDuration }));
      assert.ok(durations.sidebar.split(',').every(v => parseFloat(v) <= .01));
      await action('toggleSidebar');
      await ui.emulateMedia({ reducedMotion: 'no-preference' });
      await eventually(state, value => value.reducedMotion === false, 'normal motion preference restored');
      const expandedX = (await nativeViews())[0].bounds.x;
      await action('toggleSidebar');
      const frames = await app.evaluate(async ({ BrowserWindow }) => {
        const positions = [], primary = BrowserWindow.getAllWindows()[0];
        for (let i = 0; i < 32; i++) {
          const view = primary.contentView.children.find(v => v.webContents && v.getVisible());
          if (view) positions.push(view.getBounds().x);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return positions;
      });
      assert.ok(frames.some(x => x > 82 && x < expandedX), `expected intermediate native bounds; received ${frames.join(',')}`);
      await eventually(nativeViews, visible => visible[0]?.bounds.x === 82, 'animated sidebar settles');
      await action('toggleSidebar');
      await eventually(nativeViews, visible => visible[0]?.bounds.x === expandedX, 'expanded sidebar settles');
    });

    await check('Motion interaction flow has no renderer or main runtime errors', async () => { assert.deepEqual(errors, []); });
    console.log(`\n${results.length} motion checks passed. Preview: ${previewPath}`);
  } catch (error) {
    console.error(error.stack); process.exitCode = 1;
    if (app) await capture(path.join(runDir, 'failure.png')).catch(() => {});
  } finally {
    if (app) await app.close().catch(() => app.process().kill());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ results, errors, previewPath, palettePath, settingsPath }, null, 2));
    console.log(`Motion evidence: ${runDir}`);
  }
})();
