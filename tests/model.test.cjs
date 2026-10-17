'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInput, isWebURL, isYoutubeURL, createDefaultState, sanitizeState, publicTab, sanitizeFaviconURL } = require('../lib/model.cjs');

test('address input opens domains, ports, localhost, IPs and explicit HTTP URLs', () => {
  assert.equal(normalizeInput(' example.com/docs '), 'https://example.com/docs');
  assert.equal(normalizeInput('example.com:8443/path?q=one'), 'https://example.com:8443/path?q=one');
  assert.equal(normalizeInput('localhost:3000/hello'), 'http://localhost:3000/hello');
  assert.equal(normalizeInput('demo.localhost:8080'), 'http://demo.localhost:8080/');
  assert.equal(normalizeInput('127.0.0.1:8080/test'), 'https://127.0.0.1:8080/test');
  assert.equal(normalizeInput('[::1]:8080/test'), 'https://[::1]:8080/test');
  assert.equal(normalizeInput('http://example.com'), 'http://example.com/');
  assert.equal(normalizeInput('HTTPS://EXAMPLE.COM/a'), 'https://example.com/a');
  assert.equal(normalizeInput(''), 'orbit://newtab');
  assert.equal(normalizeInput('orbit://newtab'), 'orbit://newtab');
});

test('search input remains a search and is encoded safely', () => {
  assert.equal(normalizeInput('브라우저 디자인'), `https://www.google.com/search?q=${encodeURIComponent('브라우저 디자인')}`);
  assert.equal(normalizeInput('hello'), 'https://www.google.com/search?q=hello');
  assert.equal(normalizeInput('example.com useful tips'), 'https://www.google.com/search?q=example.com%20useful%20tips');
  assert.equal(normalizeInput('cats & dogs?'), 'https://www.google.com/search?q=cats%20%26%20dogs%3F');
});

test('unsupported protocols, credentials and malformed addresses are rejected', () => {
  for (const input of [
    'javascript:alert(1)', 'javascript:alert("hello world")', 'file:///C:/Windows',
    'data:text/html,hello', 'about:blank',  'ftp://example.com',
    'https://user:secret@example.com', 'user@example.com', 'http:/example.com',
    'https://', 'https://example.com:99999', 'https://exa\nmple.com',
  ]) assert.throws(() => normalizeInput(input), undefined, input);
  assert.throws(() => normalizeInput({}), TypeError);
});

test('web URL validation excludes non-web URLs, missing hosts and credentials', () => {
  assert.equal(isWebURL('https://example.com/a?q=1#part'), true);
  assert.equal(isWebURL('http://localhost:3000/'), true);
  for (const input of ['javascript:alert(1)', 'file:///tmp/x', 'orbit://newtab', '//example.com', 'https:', 'http:example.com', 'https://u:p@example.com', ' https://example.com', 'https://example.com/a b', null]) {
    assert.equal(isWebURL(input), false, String(input));
  }
});

test('YouTube detection matches its hosts and excludes lookalikes', () => {
  for (const url of ['https://youtube.com/watch?v=1', 'https://www.youtube.com/watch?v=1', 'https://m.youtube.com', 'https://youtu.be/1']) assert.equal(isYoutubeURL(url), true, url);
  for (const url of ['https://youtube.com.evil.test', 'https://notyoutube.com', 'https://youtu.be.evil.test', 'https://evil.test/?next=youtube.com', 'https://youtube.com@evil.test', 'data:youtube.com']) assert.equal(isYoutubeURL(url), false, url);
});

test('default state contains independent spaces, tabs and IDs', () => {
  const state = createDefaultState();
  assert.deepEqual(state.spaces, [{ id: 'personal', name: '시작의 궤도', color: '#c8d8cb' }]);
  assert.equal(state.tabs.length, 1);
  assert.equal(new Set(state.tabs.map((tab) => tab.id)).size, 1);
  assert.equal(state.tabs.find((tab) => tab.id === state.activeTabId).spaceId, state.activeSpaceId);
  assert.equal(state.autoPip, true);
  state.spaces[0].name = 'changed';
  assert.equal(createDefaultState().spaces[0].name, '시작의 궤도');
});

test('untrusted persisted state drops unknown data and repairs URL and active state', () => {
  const clean = sanitizeState({
    spaces: [{ id: 'safe', name: '  집중  ', color: '#AABBCC', injected: true }, { id: '../bad', name: 'bad' }, { id: 'safe', name: 'duplicate' }, { id: 'other', name: 12, color: 'red' }],
    tabs: [
      { id: 'tab-1', spaceId: 'safe', title: 'Hello', url: 'javascript:alert(1)', pinned: 'true', injected: true },
      { id: 'tab-2', spaceId: 'safe', title: 'Web', url: 'https://example.com/', pinned: true },
      { id: 'tab-2', spaceId: 'safe', url: 'https://duplicate.test/' },
      { id: 'tab-3', spaceId: 'missing', url: 'https://example.com/' },
      { id: 'bad id', spaceId: 'safe', url: 'https://example.com/' },
    ],
    activeSpaceId: 'safe', activeTabId: 'missing', splitTabIds: ['tab-1', 'tab-2'],
    sidebarCollapsed: 'true', themeColor: '#123456', autoPip: false, secret: 'discard',
  });
  assert.deepEqual(clean.spaces, [{ id: 'safe', name: '집중', color: '#aabbcc' }, { id: 'other', name: '스페이스', color: '#c8d8cb' }]);
  assert.equal(clean.tabs.length, 3);
  assert.equal(clean.tabs[0].url, 'orbit://newtab');
  assert.equal(clean.tabs[0].pinned, false);
  assert.equal(clean.tabs[1].pinned, true);
  assert.equal(clean.activeTabId, 'tab-1');
  assert.deepEqual(clean.splitTabIds, ['tab-1', 'tab-2']);
  assert.equal(clean.sidebarCollapsed, false);
  assert.equal(clean.autoPip, false);
  assert.equal('secret' in clean, false);
  assert.equal('injected' in clean.tabs[0], false);
});

test('invalid splits never cross spaces, duplicate a tab, or preserve more than two tabs', () => {
  const source = {
    spaces: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }],
    tabs: [{ id: 'a', spaceId: 'one' }, { id: 'b', spaceId: 'one' }, { id: 'c', spaceId: 'two' }],
    activeSpaceId: 'one', activeTabId: 'c',
  };
  for (const splitTabIds of [['a', 'c'], ['a', 'a'], ['a', 'missing'], ['a', 'b', 'c'], 'a,b', null]) {
    const clean = sanitizeState({ ...source, splitTabIds });
    assert.deepEqual(clean.splitTabIds, []);
    assert.equal(clean.activeTabId, 'a');
  }
});

test('restoring a split keeps the active page visible or preserves it by clearing the split', () => {
  const source = {
    spaces: [{ id: 'one', name: 'One' }],
    tabs: [{ id: 'a', spaceId: 'one' }, { id: 'b', spaceId: 'one' }, { id: 'c', spaceId: 'one' }],
    activeSpaceId: 'one', splitTabIds: ['a', 'b'],
  };
  const hiddenActive = sanitizeState({ ...source, activeTabId: 'c' });
  assert.equal(hiddenActive.activeTabId, 'c');
  assert.deepEqual(hiddenActive.splitTabIds, []);

  const activeRightPane = sanitizeState({ ...source, activeTabId: 'b' });
  assert.equal(activeRightPane.activeTabId, 'b');
  assert.deepEqual(activeRightPane.splitTabIds, ['a', 'b']);
});

test('malformed state falls back or fills missing tabs without exceeding limits', () => {
  for (const value of [null, [], 42, {}, { spaces: [] }, { spaces: [{ id: '<unsafe>' }] }]) {
    const clean = sanitizeState(value);
    assert.equal(clean.activeSpaceId, 'personal');
    assert.equal(clean.tabs.length, 1);
  }
  const spaces = Array.from({ length: 35 }, (_, i) => ({ id: `space-${i}`, name: `${i}` }));
  const tabs = Array.from({ length: 230 }, (_, i) => ({ id: `tab-${i}`, spaceId: 'space-0', url: 'https://example.com/' }));
  const clean = sanitizeState({ spaces, tabs, activeSpaceId: 'invalid', themeColor: 'url(evil)', autoPip: 0 });
  assert.equal(clean.spaces.length, 30);
  assert.equal(clean.tabs.length, 200);
  assert.equal(new Set(clean.tabs.map((tab) => tab.id)).size, 200);
  assert.equal(clean.tabs.every((tab) => /^[a-zA-Z0-9-]{1,100}$/.test(tab.id)), true);
  assert.equal(clean.spaces.every((space) => clean.tabs.some((tab) => tab.spaceId === space.id)), true);
  assert.equal(clean.themeColor, '#c8d8cb');
  assert.equal(clean.autoPip, true);
});

test('public tab exposes navigation data without leaking internal browser objects', () => {
  const clean = publicTab({
    id: 'a', spaceId: 'one', title: 'Example', url: 'https://example.com/', pinned: true,
    loading: true, error: 'Connection failed', canGoBack: true, canGoForward: false,
    view: { secret: true }, webContents: { secret: true }, password: 'hidden',
  });
  assert.deepEqual(clean, { id: 'a', spaceId: 'one', title: 'Example', url: 'https://example.com/', pinned: true, folderId: null, faviconURL: null, loading: true, error: 'Connection failed', canGoBack: true, canGoForward: false });
  assert.equal(publicTab({ url: 'javascript:alert(1)' }).url, 'orbit://newtab');
  assert.equal(publicTab(null).error, null);
});

test('existing profiles migrate without changing their spaces or tabs', () => {
  const source = { spaces: [{ id: 'one', name: 'One' }], tabs: [{ id: 'a', spaceId: 'one', url: 'https://example.com/', pinned: true }], activeSpaceId: 'one', activeTabId: 'a' };
  const clean = sanitizeState(source);
  assert.equal(clean.tabs[0].id, 'a');
  assert.equal(clean.tabs[0].pinned, true);
  assert.equal(clean.tabs[0].folderId, null);
  assert.equal(clean.tabs[0].faviconURL, null);
  assert.deepEqual(clean.folders, []);
  assert.deepEqual(clean.favorites, []);
  assert.deepEqual(clean.archivedTabs, []);
  assert.equal(clean.profile.displayName, '나');
  assert.equal(clean.profile.tagline, '나만의 궤도');
  assert.equal(Number.isFinite(Date.parse(clean.profile.joinedAt)), true);
  assert.deepEqual(sanitizeState(clean), clean);
});

test('folders and their tabs remain in the same space and duplicate or unsafe IDs are discarded', () => {
  const clean = sanitizeState({
    spaces: [{ id: 'one' }, { id: 'two' }],
    folders: [
      { id: 'folder-1', spaceId: 'one', name: '  Research\n ', collapsed: true, secret: true },
      { id: 'folder-1', spaceId: 'two', name: 'Duplicate' },
      { id: 'folder-2', spaceId: 'two', name: '', collapsed: 'true' },
      { id: '../bad', spaceId: 'one' }, { id: 'unknown', spaceId: 'missing' },
    ],
    tabs: [
      { id: 'a', spaceId: 'one', folderId: 'folder-1', faviconURL: 'https://example.com/favicon.ico' },
      { id: 'b', spaceId: 'one', folderId: 'folder-2', faviconURL: 'javascript:alert(1)' },
      { id: 'c', spaceId: 'two', folderId: 'missing' },
    ],
  });
  assert.deepEqual(clean.folders, [{ id: 'folder-1', spaceId: 'one', name: 'Research', collapsed: true }, { id: 'folder-2', spaceId: 'two', name: '폴더', collapsed: false }]);
  assert.equal(clean.tabs[0].folderId, 'folder-1');
  assert.equal(clean.tabs[0].faviconURL, 'https://example.com/favicon.ico');
  assert.equal(clean.tabs[1].folderId, null);
  assert.equal(clean.tabs[1].faviconURL, null);
  assert.equal(clean.tabs[2].folderId, null);
});

test('favicons accept bounded web URLs and raster data while excluding executable or invalid formats', () => {
  for (const value of ['https://example.com/favicon.svg', 'http://localhost/icon', 'data:image/png;base64,aWNvbg==', 'data:image/x-icon;base64,aWNvbg==', 'data:image/jpeg;base64,aWNvbg==', 'data:image/webp;base64,aWNvbg==']) assert.equal(sanitizeFaviconURL(value), value);
  for (const value of [null, {}, 'file:///C:/icon.ico', 'https://user:pass@example.com/icon', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PHN2Zz4=', 'data:image/png;base64,!!!!', 'data:image/png;base64,a', 'data:image/png;base64,ab==', `data:image/png;base64,${'a'.repeat(128 * 1024)}`]) assert.equal(sanitizeFaviconURL(value), null);
  const exposed = publicTab({ id: 'a', folderId: 'folder-1', faviconURL: 'data:image/png;base64,aWNvbg==', unsafe: 'hidden' });
  assert.equal(exposed.folderId, 'folder-1');
  assert.equal(exposed.faviconURL, 'data:image/png;base64,aWNvbg==');
  assert.equal('unsafe' in exposed, false);
});

test('favorites, archives and cards sanitize persisted data without leaking extra properties', () => {
  const closedAt = Date.UTC(2025, 0, 1);
  const clean = sanitizeState({
    spaces: [{ id: 'one' }],
    folders: [{ id: 'research', spaceId: 'one' }],
    favorites: [
      { id: 'google', title: 'Google', url: 'https://google.com/', faviconURL: 'https://google.com/favicon.ico', secret: 'no' },
      { id: 'duplicate-url', title: 'Another Google', url: 'https://google.com/' },
      { id: 'google', url: 'https://example.com/' },
      { id: 'danger', url: 'javascript:alert(1)' },
    ],
    archivedTabs: [
      { id: 'old', spaceId: 'one', title: '  Old tab  ', url: 'https://example.com/', folderId: 'research', pinned: true, closedAt, secret: 'no' },
      { id: 'old', spaceId: 'one', url: 'https://duplicate.test/' },
      { id: 'missing-space', spaceId: 'missing', url: 'https://example.com/' },
      { id: 'danger', spaceId: 'one', url: 'file:///C:/secret' },
      { id: 'bad-date', spaceId: 'one', url: 'https://example.com/', closedAt: 1e99, folderId: 'missing' },
    ],
    profile: { displayName: '\n' + 'a'.repeat(50), tagline: 'b'.repeat(100), cardSeed: 4294967295, joinedAt: '2025-01-01T00:00:00Z', secret: 'no' },
  });
  assert.deepEqual(clean.favorites, [{ id: 'google', title: 'Google', url: 'https://google.com/', faviconURL: 'https://google.com/favicon.ico' }]);
  assert.deepEqual(clean.archivedTabs[0], { id: 'old', spaceId: 'one', title: 'Old tab', url: 'https://example.com/', pinned: true, folderId: 'research', closedAt });
  assert.equal(clean.archivedTabs.length, 2);
  assert.equal(clean.archivedTabs[1].folderId, null);
  assert.ok(Math.abs(clean.archivedTabs[1].closedAt - Date.now()) < 1000);
  assert.deepEqual(clean.profile, { displayName: 'a'.repeat(40), tagline: 'b'.repeat(80), cardSeed: 4294967295, joinedAt: '2025-01-01T00:00:00.000Z' });
  const badCard = sanitizeState({ spaces: [{ id: 'one' }], profile: { displayName: {}, tagline: '', cardSeed: -1, joinedAt: '2099-01-01' } }).profile;
  assert.equal(badCard.cardSeed, 0);
  assert.equal(badCard.displayName, '나');
  assert.equal(badCard.tagline, '나만의 궤도');
  assert.ok(Math.abs(Date.parse(badCard.joinedAt) - Date.now()) < 1000);
});

test('new collection limits bound memory and discard references to trimmed folders', () => {
  const folders = Array.from({ length: 120 }, (_, i) => ({ id: `f-${i}`, spaceId: 'one' }));
  const favorites = Array.from({ length: 70 }, (_, i) => ({ id: `v-${i}`, url: `https://example.com/${i}` }));
  const archivedTabs = Array.from({ length: 130 }, (_, i) => ({ id: `a-${i}`, spaceId: 'one', url: 'https://example.com/', folderId: 'f-119' }));
  const clean = sanitizeState({ spaces: [{ id: 'one' }], folders, favorites, archivedTabs, tabs: [{ id: 'live', spaceId: 'one', folderId: 'f-119' }] });
  assert.equal(clean.folders.length, 100);
  assert.equal(clean.favorites.length, 50);
  assert.equal(clean.archivedTabs.length, 100);
  assert.equal(clean.tabs[0].folderId, null);
  assert.equal(clean.archivedTabs.every((tab) => tab.folderId === null), true);
});

