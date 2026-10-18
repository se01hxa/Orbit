'use strict';

const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const {preferences,cleanHistory}=require('./history.cjs');

const {internalURL,isInternal}=require('./internal-pages.cjs');
const NEW_TAB = 'orbit://newtab';
const DEFAULT_COLOR = '#c8d8cb';
const MAX_SPACES = 30;
const MAX_TABS = 200;
const MAX_FOLDERS = 100;
const MAX_FAVORITES = 50;
const MAX_ARCHIVED_TABS = 100;
const MAX_FAVICON_LENGTH = 128 * 1024;
const SAFE_ID = /^[a-zA-Z0-9-]{1,100}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function text(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function color(value, fallback) {
  return typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : fallback;
}

function parseWebURL(value) {
  if (typeof value !== 'string' || value !== value.trim() || /\s/.test(value) || CONTROL_CHARACTERS.test(value)) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isWebURL(value) {
  return parseWebURL(value) !== null;
}

function sanitizeFaviconURL(value) {
  if (typeof value !== 'string' || value.length > MAX_FAVICON_LENGTH) return null;
  if (isWebURL(value)) return value;
  // Only inert raster image formats are persisted; arbitrary data URLs are not.
  const match = value.match(/^data:image\/(?:png|jpeg|x-icon|vnd\.microsoft\.icon|ico|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || match[1].length % 4 !== 0) return null;
  return Buffer.from(match[1], 'base64').toString('base64') === match[1] ? value : null;
}

function isYoutubeURL(value) {
  const url = parseWebURL(value);
  if (!url) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be';
}

function searchURL(value) {
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function looksLikeAddress(value) {
  if (/\s/.test(value) || CONTROL_CHARACTERS.test(value)) return false;
  try {
    const candidate = new URL(`https://${value}`);
    const hostname = candidate.hostname.replace(/\.$/, '');
    const address = hostname.replace(/^\[|\]$/g, '');
    return hostname.toLowerCase() === 'localhost'
      || hostname.toLowerCase().endsWith('.localhost')
      || isIP(address) !== 0
      || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(hostname);
  } catch {
    return false;
  }
}

function normalizeInput(value) {
  if (typeof value !== 'string') throw new TypeError('주소나 검색어를 입력해 주세요.');
  const input = value.trim();
  if (!input) return NEW_TAB;
  const internal=internalURL(input);if(internal)return internal;
  if (CONTROL_CHARACTERS.test(input)) throw new Error('주소에 사용할 수 없는 문자가 포함되어 있습니다.');

  const youtube=input.match(/^!y(?:\s+([\s\S]*))?$/i);
  if(youtube)return youtube[1]?.trim()?'https://www.youtube.com/results?search_query='+encodeURIComponent(youtube[1].trim()):'https://www.youtube.com/';

  const scheme = input.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  const bareAddress = looksLikeAddress(input);
  // A domain or localhost followed by a port also resembles a URI scheme.
  if (scheme && scheme !== 'http' && scheme !== 'https' && !bareAddress) {
    throw new Error('http와 https 주소만 열 수 있습니다.');
  }
  if (scheme === 'http' || scheme === 'https') {
    if (/\s/.test(input)) return searchURL(input);
    const url = parseWebURL(input);
    if (!url) throw new Error('올바른 웹 주소를 입력해 주세요. 사용자 정보가 포함된 주소는 열 수 없습니다.');
    return url.href;
  }
  if (!bareAddress) return searchURL(input);

  const candidate = new URL(`https://${input}`);
  if (candidate.username || candidate.password) throw new Error('사용자 정보가 포함된 주소는 열 수 없습니다.');
  const hostname = candidate.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) candidate.protocol = 'http:';
  if (!isWebURL(candidate.href)) throw new Error('올바른 웹 주소를 입력해 주세요.');
  return candidate.href;
}

function makeTab(spaceId, usedIds = new Set()) {
  let id;
  do { id = randomUUID(); } while (usedIds.has(id));
  usedIds.add(id);
  return { id, spaceId, title: '새 탭', url: NEW_TAB, pinned: false, folderId: null, faviconURL: null };
}

function defaultProfile() {
  return { displayName: '나', tagline: '나만의 궤도', cardSeed: 0, joinedAt: new Date().toISOString() };
}

function boundedTimestamp(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= Date.UTC(2000, 0, 1)
    && value <= Date.now() + 5 * 60 * 1000 ? Math.floor(value) : fallback;
}

function sanitizeProfile(value) {
  const fallback = defaultProfile();
  const profile = isRecord(value) ? value : {};
  const joinedAt = typeof profile.joinedAt === 'string' ? Date.parse(profile.joinedAt) : NaN;
  return {
    displayName: text(profile.displayName, fallback.displayName, 40),
    tagline: text(profile.tagline, fallback.tagline, 80),
    cardSeed: Number.isInteger(profile.cardSeed) && profile.cardSeed >= 0 && profile.cardSeed <= 0xffffffff ? profile.cardSeed : 0,
    joinedAt: new Date(boundedTimestamp(joinedAt, Date.parse(fallback.joinedAt))).toISOString(),
  };
}

function createDefaultState() {
  const spaces = [
    { id: 'personal', name: '시작의 궤도', color: DEFAULT_COLOR },
  ];
  const usedIds = new Set();
  const tabs = spaces.map((space) => makeTab(space.id, usedIds));
  return {
    spaces,
    activeSpaceId: 'personal',
    tabs,
    activeTabId: tabs[0].id,
    splitTabIds: [],
    sidebarCollapsed: false,
    themeColor: DEFAULT_COLOR,
    autoPip: true,
    searchPreferences: preferences(),
    history: [],
    folders: [],
    favorites: [],
    archivedTabs: [],
    profile: defaultProfile(),
  };
}

function storedURL(value) {
  try{return internalURL(value)|| (isWebURL(value)?value:NEW_TAB);}catch{return NEW_TAB;}
}

function sanitizeState(value) {
  if (!isRecord(value) || !Array.isArray(value.spaces)) return createDefaultState();
  const spaceIds = new Set();
  const spaces = [];
  for (const space of value.spaces) {
    if (spaces.length >= MAX_SPACES) break;
    if (!isRecord(space) || !safeId(space.id) || spaceIds.has(space.id)) continue;
    spaceIds.add(space.id);
    spaces.push({
      id: space.id,
      name: space.id === 'personal' && space.name === '개인' ? '시작의 궤도' : space.id === 'work' && space.name === '업무' ? '궤도 - 1' : text(space.name, '스페이스', 80),
      color: color(space.color, DEFAULT_COLOR),
    });
  }
  if (!spaces.length) return createDefaultState();

  const folderSpaces = new Map();
  const folders = [];
  for (const folder of Array.isArray(value.folders) ? value.folders : []) {
    if (folders.length >= MAX_FOLDERS) break;
    if (!isRecord(folder) || !safeId(folder.id) || folderSpaces.has(folder.id) || !spaceIds.has(folder.spaceId)) continue;
    folderSpaces.set(folder.id, folder.spaceId);
    folders.push({ id: folder.id, spaceId: folder.spaceId, name: text(folder.name, '폴더', 80), collapsed: folder.collapsed === true });
  }

  const favoriteIds = new Set();
  const favoriteURLs = new Set();
  const favorites = [];
  for (const favorite of Array.isArray(value.favorites) ? value.favorites : []) {
    if (favorites.length >= MAX_FAVORITES) break;
    if (!isRecord(favorite) || !safeId(favorite.id) || favoriteIds.has(favorite.id) || !isWebURL(favorite.url) || favoriteURLs.has(favorite.url)) continue;
    favoriteIds.add(favorite.id);
    favoriteURLs.add(favorite.url);
    favorites.push({ id: favorite.id, title: text(favorite.title, new URL(favorite.url).hostname, 200), url: favorite.url, faviconURL: sanitizeFaviconURL(favorite.faviconURL) });
  }

  const tabIds = new Set();
  const tabs = [];
  for (const tab of Array.isArray(value.tabs) ? value.tabs : []) {
    if (tabs.length >= MAX_TABS) break;
    if (!isRecord(tab) || !safeId(tab.id) || tabIds.has(tab.id) || !safeId(tab.spaceId) || !spaceIds.has(tab.spaceId)) continue;
    tabIds.add(tab.id);
    tabs.push({
      id: tab.id,
      spaceId: tab.spaceId,
      title: text(tab.title, '새 탭', 200),
      url: storedURL(tab.url),
      pinned: tab.pinned === true,
      folderId: safeId(tab.folderId) && folderSpaces.get(tab.folderId) === tab.spaceId ? tab.folderId : null,
      faviconURL: sanitizeFaviconURL(tab.faviconURL),
    });
  }

  const tabCounts = new Map(spaces.map((space) => [space.id, 0]));
  for (const tab of tabs) tabCounts.set(tab.spaceId, tabCounts.get(tab.spaceId) + 1);
  for (const space of spaces) {
    if (tabCounts.get(space.id) > 0) continue;
    // Keep the total bounded even if all persisted tabs belonged to one space.
    if (tabs.length >= MAX_TABS) {
      const removable = tabs.findLastIndex((tab) => tabCounts.get(tab.spaceId) > 1);
      const [removed] = tabs.splice(removable, 1);
      tabIds.delete(removed.id);
      tabCounts.set(removed.spaceId, tabCounts.get(removed.spaceId) - 1);
    }
    tabs.push(makeTab(space.id, tabIds));
    tabCounts.set(space.id, 1);
  }

  const activeSpaceId = safeId(value.activeSpaceId) && spaceIds.has(value.activeSpaceId) ? value.activeSpaceId : spaces[0].id;
  const requestedActiveTab = tabs.find((tab) => tab.id === value.activeTabId && tab.spaceId === activeSpaceId);
  const activeTabId = requestedActiveTab?.id || tabs.find((tab) => tab.spaceId === activeSpaceId).id;
  const split = value.splitTabIds;
  const splitTabIds = Array.isArray(split) && split.length === 2 && split[0] !== split[1] && split.includes(activeTabId)
    && split.every((id) => safeId(id) && tabs.some((tab) => tab.id === id && tab.spaceId === activeSpaceId))
    ? [...split] : [];

  const archiveIds = new Set();
  const archivedTabs = [];
  for (const tab of Array.isArray(value.archivedTabs) ? value.archivedTabs : []) {
    if (archivedTabs.length >= MAX_ARCHIVED_TABS) break;
    if (!isRecord(tab) || !safeId(tab.id) || archiveIds.has(tab.id) || !spaceIds.has(tab.spaceId)) continue;
    if (!isInternal(tab.url) && !isWebURL(tab.url)) continue;
    archiveIds.add(tab.id);
    archivedTabs.push({
      id: tab.id,
      spaceId: tab.spaceId,
      title: text(tab.title, '새 탭', 200),
      url: tab.url,
      pinned: tab.pinned === true,
      folderId: safeId(tab.folderId) && folderSpaces.get(tab.folderId) === tab.spaceId ? tab.folderId : null,
      closedAt: boundedTimestamp(tab.closedAt, Date.now()),
    });
  }

  return {
    spaces,
    activeSpaceId,
    tabs,
    activeTabId,
    splitTabIds,
    sidebarCollapsed: value.sidebarCollapsed === true,
    themeColor: color(value.themeColor, DEFAULT_COLOR),
    autoPip: typeof value.autoPip === 'boolean' ? value.autoPip : true,
    searchPreferences: preferences(value.searchPreferences),
    history: cleanHistory(value.history,spaceIds),
    folders,
    favorites,
    archivedTabs,
    profile: sanitizeProfile(value.profile),
  };
}

function publicTab(value) {
  const tab = isRecord(value) ? value : {};
  return {
    id: safeId(tab.id) ? tab.id : '',
    spaceId: safeId(tab.spaceId) ? tab.spaceId : '',
    title: text(tab.title, '새 탭', 200),
    url: storedURL(tab.url),
    pinned: tab.pinned === true,
    folderId: safeId(tab.folderId) ? tab.folderId : null,
    faviconURL: sanitizeFaviconURL(tab.faviconURL),
    loading: tab.loading === true,
    error: text(tab.error, null, 500),
    canGoBack: tab.canGoBack === true,
    canGoForward: tab.canGoForward === true,
  };
}

function nextSpaceName(spaces) {
  const names = new Set(spaces.map(space => space.name));
  let number = 1;while (names.has(`궤도 - ${number}`)) number++;
  return `궤도 - ${number}`;
}
module.exports = { normalizeInput, isWebURL, isYoutubeURL, createDefaultState, sanitizeState, publicTab, sanitizeFaviconURL, nextSpaceName };
