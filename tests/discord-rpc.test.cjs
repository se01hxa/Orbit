'use strict';

// Pure module tests: no Electron, Discord, existing browser profile or real RPC
// service is launched. A network guard allows only this file's ephemeral mocks.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { OrbitRpcBridge, collectPageScript, COLLECT_WORLD_ID } = require('../lib/discord-rpc.cjs');

const LIVE_RPC_PORT = 39231;
const approvedPorts = new Set();
const originalRequest = http.request;
let guardedRequest;

before(() => {
  guardedRequest = mock.method(http, 'request', function guardedHttpRequest(url, ...args) {
    const target = url instanceof URL ? url : new URL(url);
    assert.equal(target.protocol, 'http:', 'Tests must not contact TLS or external services');
    assert.equal(target.hostname, '127.0.0.1', 'Tests may contact only their loopback mock');
    assert.notEqual(Number(target.port), LIVE_RPC_PORT, 'Never contact the user RPC port');
    assert.ok(approvedPorts.has(Number(target.port)), 'The destination must be a running test fixture');
    return originalRequest.call(this, url, ...args);
  });
});

after(() => mock.restoreAll());

function fakeWebContents(sample, overrides = {}) {
  return {
    isDestroyed: () => false,
    getURL: () => 'https://example.test/watch',
    getTitle: () => 'Authoritative title',
    executeJavaScriptInIsolatedWorld: async (worldId, scripts, userGesture) => {
      assert.equal(worldId, COLLECT_WORLD_ID);
      assert.notEqual(worldId, 0, 'Collection must not use the page world');
      assert.notEqual(worldId, 999, 'Collection must not use the preload world');
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].code, collectPageScript, 'Only the fixed collector may execute');
      assert.equal(userGesture, false);
      return sample;
    },
    ...overrides,
  };
}

function candidate(webContents, overrides = {}) {
  return {
    id: 'test-tab-1', windowId: 1, active: true, windowFocused: true,
    url: 'https://example.test/watch', title: 'Candidate title', webContents,
    ...overrides,
  };
}

async function fixture(t, candidates, respond = null, options = {}) {
  const requests = [], serverErrors = [];
  let bridge, port;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      requests.push({ route: req.url, body: JSON.parse(bytes.toString('utf8')), bytes: bytes.length });
      if (respond) { await respond(req, res);return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (error) {
      serverErrors.push(error);
      if (!res.destroyed) { res.writeHead(500);res.end(); }
    }
  });

  t.after(async () => {
    await bridge?.stop({ notify: false });
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    approvedPorts.delete(port);
    assert.deepEqual(serverErrors, [], 'The mock server must finish without uncaught errors');
  });

  // Never reserve the user's fixed RPC port, even on systems whose dynamic
  // port range could otherwise allocate it to listen(0).
  do {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
    if (port === LIVE_RPC_PORT) await new Promise(resolve => server.close(resolve));
  } while (port === LIVE_RPC_PORT);
  approvedPorts.add(port);

  const endpoint = `http://127.0.0.1:${port}`;
  bridge = new OrbitRpcBridge({
    getCandidates: typeof candidates === 'function' ? candidates : () => candidates,
    endpoint,
    intervalMs: 60000,
    ...options,
  });
  return { bridge, requests, endpoint };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('RPC collector inspects metadata and media without reading editable or private data', () => {
  new vm.Script(collectPageScript);
  const selectors = [];
  const document = {
    title: 'Fixture',
    querySelector: selector => {
      selectors.push(selector);
      assert.doesNotMatch(selector, /textarea|input|contenteditable|textbox|message-author|user-message/i);
      return null;
    },
    querySelectorAll: selector => {
      assert.equal(selector, 'video,audio');
      return [];
    },
  };
  for (const name of ['cookie', 'forms']) Object.defineProperty(document, name, {
    get() { assert.fail(`The collector must not read document.${name}`); },
  });
  const context = {
    document, location: { href: 'https://example.test/', hostname: 'example.test' }, navigator: {}, URL,
  };
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(context, name, {
    get() { assert.fail(`The collector must not read ${name}`); },
  });
  const empty = vm.runInNewContext(collectPageScript, context);
  assert.equal(empty.media, null);
  assert.equal(empty.page.siteName, 'example.test');
  assert.ok(selectors.length > 0);

  const mediaElement = { tagName: 'AUDIO', paused: false, ended: false, readyState: 4, currentTime: 30, duration: 180, playbackRate: 1.25 };
  const playing = vm.runInNewContext(collectPageScript, {
    document: { ...document, querySelectorAll: () => [mediaElement] },
    location: { href: 'https://music.youtube.com/watch?v=fixture1234', hostname: 'music.youtube.com' },
    navigator: { mediaSession: { playbackState: 'playing', metadata: { title: 'A song', artist: 'An artist', album: 'An album', artwork: [{ src: 'https://cdn.test/cover.png' }] } } },
    URL,
  });
  assert.equal(playing.media.provider, 'youtubeMusic');
  assert.equal(playing.media.kind, 'music');
  assert.equal(playing.media.title, 'A song');
  assert.equal(playing.media.currentTime, 30);
  assert.equal(playing.media.duration, 180);
  assert.equal(playing.media.playbackRate, 1.25);
  assert.equal(playing.media.paused, false);
});

test('RPC payloads use authoritative tab identity and coalesce overlapping ticks', { timeout: 10000 }, async t => {
  let sample = {
    page: { url: 'https://forged.test/', title: 'Forged title', description: 'Page summary', image: 'file:///C:/private.png', favIconUrl: 'https://cdn.test/favicon.png' },
    media: { provider: 'youtube', kind: 'video', title: 'Playing video', paused: false, duration: 120, currentTime: 30, thumbnail: 'http://127.0.0.1/private', currentDraft: 'private input must not export' },
  };
  const wc = fakeWebContents(null, {
    executeJavaScriptInIsolatedWorld: async (worldId, scripts, userGesture) => {
      assert.equal(worldId, COLLECT_WORLD_ID);
      assert.notEqual(worldId, 0);assert.notEqual(worldId, 999);
      assert.equal(scripts[0].code, collectPageScript);
      assert.equal(userGesture, false);
      return sample;
    },
  });
  const { bridge, requests } = await fixture(t, [candidate(wc)], null, {
    onStatus: () => { throw new Error('A faulty UI observer must not break the bridge'); },
  });
  bridge.start();
  const first = bridge.tick(), second = bridge.tick();
  assert.equal(first, second);
  await first;
  const tab = requests.find(request => request.route === '/api/tab').body;
  assert.equal(tab.browser, 'orbit');assert.equal(tab.tabId, 'test-tab-1');
  assert.equal(tab.windowId, 1);assert.equal(tab.active, true);assert.equal(tab.windowFocused, true);
  assert.equal(tab.title, 'Authoritative title');assert.equal(tab.url, 'https://example.test/watch');
  assert.equal(tab.image, '');assert.equal(tab.media.thumbnail, '');
  assert.equal(tab.media.currentTime, 30);assert.equal(tab.media.duration, 120);
  assert.equal(JSON.stringify(tab).includes('private input'), false);
  assert.equal(requests.filter(request => request.route === '/api/tab').length, 1);
  assert.equal(requests[0].body.event, 'started');
  assert.deepEqual(requests[0].body.tabIds, ['test-tab-1']);
  assert.ok(requests.every(request => request.bytes <= 128 * 1024));
  assert.equal(bridge.getStatus().connected, true);
  assert.equal(bridge.getStatus().error, null);
  assert.ok(Number.isFinite(bridge.getStatus().lastSentAt));
  const detached = bridge.getStatus();detached.connected = false;
  assert.equal(bridge.getStatus().connected, true);

  sample = { ...sample, observedURL: 'https://previous-document.test/', page: { description: 'Old document' } };
  await bridge.tick();
  const latest = requests.filter(request => request.route === '/api/tab').at(-1).body;
  assert.equal(latest.description, '');assert.equal(latest.media, null);
  assert.equal(requests.filter(request => request.route === '/api/extension').at(-1).body.event, 'heartbeat');
});

test('RPC excludes incognito and home pages and emits a scoped idle signal', { timeout: 10000 }, async t => {
  let evaluated = false;
  const wc = fakeWebContents(null, { executeJavaScriptInIsolatedWorld: () => { evaluated = true;assert.fail('Excluded tabs must not be evaluated'); } });
  const { bridge, requests } = await fixture(t, [candidate(wc, { incognito: true }), candidate(wc, { id: 'home-tab', url: 'orbit://newtab' })]);
  bridge.start();await bridge.tick();
  assert.equal(evaluated, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, '/api/extension');
  assert.deepEqual(requests[0].body, { browser: 'orbit', event: 'idle', tabIds: [] });
});

test('RPC rejects non-loopback and non-root endpoints before making a request', { timeout: 10000 }, async t => {
  const { endpoint } = await fixture(t, []);
  const port = new URL(endpoint).port;
  const endpoints = [
    `https://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1.evil.test:${port}`,
    'http://example.test', `${endpoint}/api/tab`, `${endpoint}/?query=1`, `${endpoint}/#fragment`,
  ];
  for (const invalid of endpoints) {
    const beforeRequests = guardedRequest.mock.callCount();
    const bridge = new OrbitRpcBridge({ endpoint: invalid });
    try {
      bridge.start();
      const status = await bridge.tick();
      assert.equal(status.connected, false);assert.ok(status.error);
      assert.equal(guardedRequest.mock.callCount(), beforeRequests, `Invalid endpoint attempted a request: ${invalid}`);
    } finally { await bridge.stop({ notify: false }); }
  }
});

test('RPC rejects HTTP redirects instead of following them', { timeout: 10000 }, async t => {
  const { bridge, requests } = await fixture(t, [candidate(fakeWebContents(null))], (_req, res) => {
    res.writeHead(302, { Location: '/must-not-follow' });res.end();
  });
  bridge.start();await bridge.tick();
  assert.equal(requests.length, 1);
  assert.equal(requests.some(request => request.route === '/must-not-follow'), false);
  assert.equal(bridge.getStatus().connected, false);assert.ok(bridge.getStatus().error);
});

test('RPC rejects oversized responses before accepting a connection', { timeout: 10000 }, async t => {
  const { bridge, requests } = await fixture(t, [candidate(fakeWebContents(null))], (_req, res) => {
    res.writeHead(200, { 'Content-Length': 40000 });res.end('x'.repeat(40000));
  });
  bridge.start();await bridge.tick();
  assert.equal(bridge.getStatus().connected, false);assert.ok(bridge.getStatus().error);
  assert.equal(requests.some(request => request.route === '/api/tab'), false);
});

test('RPC bounds hung page collection and does not accumulate evaluations', { timeout: 10000 }, async t => {
  let calls = 0;
  const wc = fakeWebContents(null, { executeJavaScriptInIsolatedWorld: () => { calls++;return new Promise(() => {}); } });
  const { bridge, requests } = await fixture(t, [candidate(wc)]);
  bridge.start();
  await bounded(bridge.tick(), 3500, 'The hung page fallback');
  const first = requests.filter(request => request.route === '/api/tab');
  assert.equal(first.length, 1);
  assert.equal(first[0].body.title, 'Authoritative title');assert.equal(first[0].body.media, null);
  await bounded(bridge.tick(), 1000, 'The repeated hung page fallback');
  assert.equal(calls, 1);
  assert.equal(requests.filter(request => request.route === '/api/tab').length, 2);
});

test('RPC stop cancels a pending page report and emits idle without exposing its data', { timeout: 10000 }, async t => {
  const started = deferred(), result = deferred();
  const wc = fakeWebContents(null, { executeJavaScriptInIsolatedWorld: () => { started.resolve();return result.promise; } });
  const { bridge, requests } = await fixture(t, [candidate(wc)]);
  bridge.start();const pending = bridge.tick();
  await bounded(started.promise, 2000, 'The page collector');
  try { await bridge.stop(); }
  finally { result.resolve({ page: { description: 'private delayed metadata' }, media: null }); }
  await pending;
  assert.equal(requests.some(request => request.route === '/api/tab'), false);
  assert.equal(JSON.stringify(requests).includes('private delayed metadata'), false);
  assert.deepEqual(requests.at(-1).body, { browser: 'orbit', event: 'idle', tabIds: [] });
  assert.equal(bridge.getStatus().enabled, false);assert.equal(bridge.getStatus().connected, false);
});

test('RPC applies a total two second HTTP deadline and reports the error', { timeout: 10000 }, async t => {
  const { bridge, requests } = await fixture(t, [candidate(fakeWebContents(null))], () => {
    // Keep the connection open deliberately; the bridge must abort it itself.
  });
  const started = Date.now();
  bridge.start();await bounded(bridge.tick(), 5000, 'The HTTP deadline');
  assert.ok(Date.now() - started >= 1900, 'The request must reach the configured deadline');
  assert.equal(requests.length, 1);
  assert.equal(bridge.getStatus().connected, false);assert.ok(bridge.getStatus().error);
  assert.equal(requests.some(request => request.route === '/api/tab'), false);
});
