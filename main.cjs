const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, shell, session, clipboard, nativeImage, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { normalizeInput, isWebURL, isYoutubeURL, createDefaultState, sanitizeState, publicTab, sanitizeFaviconURL, nextSpaceName } = require('./lib/model.cjs');
const { popupTarget } = require('./lib/popup-policy.cjs');
const {addHistory,safeVisit,preferences}=require('./lib/history.cjs');
const {fetchSuggestions}=require('./lib/search-suggestions.cjs');

const { parseBookmarkHTML, parseChromiumBookmarks } = require('./lib/bookmarks.cjs');
const { resolveExtensionDirectory } = require('./lib/extension-path.cjs');
const { OrbitRpcBridge } = require('./lib/discord-rpc.cjs');
const { PasswordVault, loginOrigin } = require('./lib/passwords.cjs');
const { collectLoginScript, fillLoginScript } = require('./lib/login-page.cjs');
const {isInternal}=require('./lib/internal-pages.cjs');
const HOME = 'orbit://newtab';
const TEST = process.env.ORBIT_TEST_MODE === '1';
app.setName('Orbit');
if (process.platform === 'win32') app.setAppUserModelId('com.orbitbrowser.desktop');
app.setPath('userData', process.env.ORBIT_PROFILE ? path.resolve(process.env.ORBIT_PROFILE) : path.join(app.getPath('appData'), 'Orbit'));
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
const uiPath = path.join(__dirname, 'renderer', 'index.html');
const uiURL = pathToFileURL(uiPath).href;
const controllers = new Set();
const contentsOwners = new Map();
const sessions = new Map();
const permissionDecisions = new Map();
const rpcExtensions = new Map();
const rpcExtensionFile = path.join(app.getPath('userData'), 'orbit-rpc-extensions.json');
const passwordVault = new PasswordVault(path.join(app.getPath('userData'), 'orbit-passwords.bin'), safeStorage);
let rpcBridge;
let appQuitting = false;
const externalURLs = process.argv.filter(isWebURL).slice(0, 20);
const securePreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false };

function isRpcExtension(manifest) {
  return manifest?.orbit_rpc_bridge?.version === 1 && manifest.orbit_rpc_bridge.endpoint === 'http://127.0.0.1:39231';
}
function rpcExtensionRecord(spaceId, directory, manifest) {
  const id = createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  return { id, spaceId, directory, name: String(manifest.name || 'Discord Custom RPC').slice(0, 100), version: String(manifest.version || '1').slice(0, 40), compatibility: 'orbit-rpc' };
}
function saveRpcExtensions() {
  fs.mkdirSync(path.dirname(rpcExtensionFile), { recursive: true });
  fs.writeFileSync(rpcExtensionFile + '.tmp', JSON.stringify([...rpcExtensions.values()], null, 2));
  fs.renameSync(rpcExtensionFile + '.tmp', rpcExtensionFile);
}
async function restoreRpcExtensions() {
  try {
    if (fs.statSync(rpcExtensionFile).size > 1024 * 1024) return;
    const entries = JSON.parse(fs.readFileSync(rpcExtensionFile, 'utf8'));
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(0, 30)) {
      if (!entry || typeof entry.spaceId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(entry.spaceId) || typeof entry.directory !== 'string') continue;
      try {
        const { directory, manifest } = await resolveExtensionDirectory(entry.directory);
        if (isRpcExtension(manifest)) rpcExtensions.set(entry.spaceId, rpcExtensionRecord(entry.spaceId, directory, manifest));
      } catch {}
    }
  } catch {}
}

function boundedRaster(bytes) {
  const bounded = (width, height) => width > 0 && height > 0 && width <= 2048 && height <= 2048;
  if (bytes.length < 24) return false;
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return bytes.toString('ascii', 12, 16) === 'IHDR' && bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes.readUInt32LE(0) === 0x00010000) {
    const count = bytes.readUInt16LE(4);if (count < 1 || count > 64 || bytes.length < 6 + count * 16) return false;
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16, length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
      if (offset < 6 + count * 16 || length < 24 || offset + length > bytes.length) return false;
      const frame = bytes.subarray(offset, offset + length);
      if (frame.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') { if (!boundedRaster(frame)) return false; }
      else if (frame.length < 40 || frame.readUInt32LE(0) < 40 || !bounded(Math.abs(frame.readInt32LE(4)), Math.abs(frame.readInt32LE(8)) / 2)) return false;
    }
    return true;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset);if (length < 2 || offset + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return length >= 7 && bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      offset += length;
    }
    return false;
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X' && bytes.length >= 30) return bounded(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
    if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21);return bounded((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
    if (type === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).toString('hex') === '9d012a') return bounded(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  return false;
}

function createController({ incognito = false, initialState, primary = false } = {}) {
const windowId = randomUUID();
let win, state = initialState || createDefaultState();
let stateFile = incognito ? null : path.join(app.getPath('userData'), primary ? 'orbit-state.json' : path.join('windows', windowId + '.json'));
let overlayOpen = false, saveTimer, publishTimer, quitting = false;
let pipPending = false, pipTabId = null, blurTimer;
let reducedMotion = false, animatedSidebarWidth = null, sidebarAnimation = null;
const views = new Map();
const downloadItems = new Map();
const closeRequests = new Map();
const retainedTabs = new Set();
let closingWindow = false;
let downloads = [];
let notice = null, noticeTimer;
let findResult = null;
const findSessions = new Map();
const faviconRequests = new Map();
const faviconAborts = new Set();
const extensionWindows = new Set();
let actionQueue = Promise.resolve();
const controller = { get win() { return win; }, get incognito() { return incognito; }, get primary() { return primary; }, get state() { return state; }, snapshot, handleAction, publish, receiveDownload, saveNow, closeExtensionPopups, rpcCandidates, loginEvent, suggest };
controllers.add(controller);
let suggestionRequest;
async function suggest(query){
  suggestionRequest?.abort();
  if(incognito||!state.searchPreferences.autocomplete||!state.searchPreferences.onlineSuggestions||!overlayOpen)return [];
  const request=new AbortController();suggestionRequest=request;
  const result=await fetchSuggestions(query,request.signal);
  return request.signal.aborted||incognito||!state.searchPreferences.autocomplete||!state.searchPreferences.onlineSuggestions?[]:result;
}
function remember(kind,value,title,spaceId=state.activeSpaceId){
  if(incognito||!state.searchPreferences.saveHistory||!value)return;
  state.history=addHistory(state.history,{kind,value,title,spaceId,at:Date.now()},new Set(state.spaces.map(s=>s.id)));syncShared('history');persist();
}
let loginPromptOpen = false;
const loginPromptTimes = new Map();
async function fillSavedLogin(target, entry) {
  const contents = views.get(target?.id)?.webContents;
  if (incognito || !contents || contents.isDestroyed() || entry.spaceId !== target.spaceId || loginOrigin(contents.getURL()) !== entry.origin) return false;
  return await withDeadline(contents.executeJavaScriptInIsolatedWorld(1138, [{ code: fillLoginScript(entry) }]), 1500);
}
async function offerLogin(target, value, origin) {
  if (incognito || loginPromptOpen || !passwordVault.available() || !origin || !value || typeof value.username !== 'string' || typeof value.password !== 'string' || !value.password || value.password.length > 2048 || value.username.length > 320) return;
  const existing = passwordVault.matches(target.spaceId, origin).find(r => r.username === value.username);
  if (existing?.password === value.password) return;
  loginPromptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Orbit 비밀번호 관리자', message: `${new URL(origin).host} 로그인 정보를 ${existing ? '업데이트' : '저장'}할까요?`, detail: `계정: ${value.username || '(아이디 없음)'}\n현재 스페이스에 Windows 암호화로 저장합니다. 같은 사이트에 계정이 하나면 다음 방문에 자동 입력하며 로그인 버튼은 직접 누릅니다.`, buttons: ['나중에', existing ? '업데이트' : '저장'], defaultId: 0, cancelId: 0 });
    if (response === 1) { passwordVault.save(target.spaceId, { origin, username: value.username, password: value.password });notify('로그인 정보를 저장했습니다.'); }
  } finally { loginPromptOpen = false; }
}
async function loginEvent(event, type, value) {
  if (incognito || !win?.isFocused() || event.senderFrame !== event.sender.mainFrame) return;
  const target = state.tabs.find(t => views.get(t.id)?.webContents === event.sender);
  if (!target || target.id !== state.activeTabId || target.spaceId !== state.activeSpaceId) return;
  const origin = loginOrigin(event.senderFrame.url);
  if (!origin || loginOrigin(event.sender.getURL()) !== origin || !passwordVault.available()) return;
  if (type === 'ready') {
    const entries = passwordVault.matches(target.spaceId, origin);
    if (entries.length === 1) await fillSavedLogin(target, entries[0]);
  } else {
    if (Date.now() - (loginPromptTimes.get(target.id) || 0) < 15000) return;
    loginPromptTimes.set(target.id, Date.now());await offerLogin(target, value, origin);
  }
}

function tabById(id) { return state.tabs.find(tab => tab.id === id); }
function currentTab() { return tabById(state.activeTabId); }
function rpcCandidates() {
  if (incognito || !win || win.isDestroyed() || !rpcExtensions.has(state.activeSpaceId)) return [];
  return state.tabs.filter(tab => tab.spaceId === state.activeSpaceId && isWebURL(tab.url)).flatMap(tab => {
    const webContents = views.get(tab.id)?.webContents;
    if (!webContents || webContents.isDestroyed() || (tab.id !== state.activeTabId && !webContents.isCurrentlyAudible())) return [];
    return [{ id: tab.id, windowId: win.id, active: tab.id === state.activeTabId, windowFocused: win.isFocused(), url: tab.url, title: tab.title, faviconURL: tab.faviconURL, webContents }];
  });
}
function snapshot() {
  const extensions = configureSession(state.activeSpaceId).extensions.getAllExtensions().map(extension => ({ id: extension.id, name: extension.name, version: extension.version }));
  const rpc = !incognito && rpcExtensions.get(state.activeSpaceId);
  if (rpc) extensions.push({ id: rpc.id, name: rpc.name, version: rpc.version, compatibility: rpc.compatibility, connection: rpcBridge?.getStatus() || { connected: false } });
  return { ...state, history: incognito ? [] : state.history, tabs: state.tabs.map(entry => ({ ...publicTab(entry), muted: views.get(entry.id)?.webContents.isAudioMuted() || false })), incognito, windowCount: controllers.size, findResult, zoomFactor: views.get(state.activeTabId)?.webContents.getZoomFactor() || 1, extensions, extensionSupport: 'partial', downloads: downloads.map(({ ...item }) => item), notice,
    isMaximized: win?.isMaximized() || false, reducedMotion, packaged: app.isPackaged, version: app.getVersion(), engine: { electron: process.versions.electron, chromium: process.versions.chrome } };
}
function persist() {
  clearTimeout(saveTimer);
  if (quitting || incognito) return;
  saveTimer = setTimeout(saveNow, 180);
}
function saveNow(destination = stateFile) {
  if (incognito || !destination || !state) return;
  try {
    const data = { ...state, tabs: state.tabs.map(tab => ({ id: tab.id, spaceId: tab.spaceId, title: tab.title, url: tab.url, pinned: tab.pinned, folderId: tab.folderId || null, faviconURL: tab.faviconURL || null })) };
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(destination + '.tmp', destination);
  } catch (error) { console.error('Could not save browser state:', error.message); }
}
function publish(save = true) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('orbit:state-changed', snapshot());
  if (save) persist();
}
function publishSoon() {
  if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publish(false); }, 120);
}
function notify(message) {
  notice = message;
  publish(false);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = null; publish(false); }, 4500);
}
function command(name) {
  if (!win || win.isDestroyed()) return;
  if (name !== 'find') overlayOpen = true;
  layout();
  win.webContents.focus();
  win.webContents.send('orbit:command', name);
}
function visibleIds() { return state.splitTabIds.length === 2 ? state.splitTabIds : [state.activeTabId]; }
function finishSidebarMotion() {
  clearInterval(sidebarAnimation);sidebarAnimation = null;animatedSidebarWidth = null;
}
function easeSidebar(progress) {
  let lo = 0, hi = 1;
  for (let index = 0; index < 14; index++) {
    const t = (lo + hi) / 2, inv = 1 - t;
    const x = 3 * inv * inv * t * .22 + 3 * inv * t * t * .36 + t * t * t;
    if (x < progress) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2;
  return 1 - Math.pow(1 - t, 3);
}
function toggleSidebar() {
  const from = animatedSidebarWidth ?? (state.sidebarCollapsed ? 72 : 256);
  finishSidebarMotion();state.sidebarCollapsed = !state.sidebarCollapsed;
  if (reducedMotion) return;
  const target = state.sidebarCollapsed ? 72 : 256, started = performance.now();
  animatedSidebarWidth = from;
  sidebarAnimation = setInterval(() => {
    const progress = Math.min(1, (performance.now() - started) / 280);
    animatedSidebarWidth = from + (target - from) * easeSidebar(progress);
    if (progress >= 1) finishSidebarMotion();
    layout();
  }, 16);
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const sidebar = Math.round(animatedSidebarWidth ?? (state.sidebarCollapsed ? 72 : 256));
  const ids = visibleIds();
  const available = Math.max(20, width - sidebar - 20);
  const paneWidth = ids.length === 2 ? Math.floor((available - 10) / 2) : available;
  for (const [id, view] of views) {
    const tab = tabById(id), index = ids.indexOf(id);
    const show = !overlayOpen && index >= 0 && tab && tab.spaceId === state.activeSpaceId && !isInternal(tab.url) && !tab.error;
    view.setVisible(Boolean(show));
    if (show) view.setBounds({ x: sidebar + 10 + index * (paneWidth + 10), y: 66,
      width: index === 1 ? available - paneWidth - 10 : paneWidth, height: Math.max(20, height - 76) });
  }
}

function withDeadline(promise, milliseconds = 1500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page did not respond in time')), milliseconds); })]).finally(() => clearTimeout(timer));
}
const PIP_SCRIPT = `(() => {
  if (Date.now() > __ORBIT_DEADLINE__) return Promise.resolve({ok:false});
  if (document.pictureInPictureElement) return Promise.resolve({ok:true,already:true});
  if (!document.pictureInPictureEnabled) return Promise.resolve({ok:false,message:'PiP is unavailable'});
  const video = Array.from(document.querySelectorAll('video')).find(v => !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0 && !v.disablePictureInPicture);
  if (!video) return Promise.resolve({ok:false,message:'재생 중인 영상을 찾을 수 없어요.'});
  return video.requestPictureInPicture().then(p => ({ok:true,width:p.width,height:p.height})).catch(e => ({ok:false,name:e.name,message:e.message}));
})()`;
async function enterPip(tab, manual = false) {
  if (pipPending || !tab || (!manual && !state.autoPip)) return { ok: false };
  if (!manual && !isYoutubeURL(tab.url) && !(TEST && isWebURL(tab.url) && new URL(tab.url).hostname === '127.0.0.1')) return { ok: false };
  const view = views.get(tab.id);
  if (!view || view.webContents.isDestroyed()) return { ok: false };
  if (view.webContents.isLoadingMainFrame()) return { ok: false };
  pipPending = true;
  try {
    const result = await withDeadline(view.webContents.executeJavaScript(PIP_SCRIPT.replace('__ORBIT_DEADLINE__', String(Date.now() + 1400)), true));
    if (result?.ok) { pipTabId = tab.id; if (manual) notify('영상이 다른 앱 위에 표시됩니다.'); }
    else if (manual) notify(result?.message || '이 페이지에서는 PIP를 사용할 수 없어요.');
    return result;
  } catch (error) { if (manual) notify('PIP를 열 수 없어요. 영상 재생 상태를 확인해 주세요.'); return { ok: false, message: error.message }; }
  finally { pipPending = false; }
}
async function restorePipIfVisible() {
  if (!pipTabId || !visibleIds().includes(pipTabId)) return;
  const view = views.get(pipTabId);
  pipTabId = null;
  if (view && !view.webContents.isDestroyed() && !view.webContents.isLoadingMainFrame()) await withDeadline(view.webContents.executeJavaScript('document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true) : false')).catch(() => {});
}

function webOrigin(value) { return isWebURL(value) ? new URL(value).origin : null; }

function configureSession(spaceId) {
  const partition = incognito ? `orbit-private-${windowId}-${spaceId}` : `persist:orbit-${spaceId}`;
  if (sessions.has(partition)) return sessions.get(partition);
  const ses = session.fromPartition(partition);
  sessions.set(partition, ses);
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const origin = webOrigin(requestingOrigin);
    return origin !== null && (permission === 'fullscreen' || permissionDecisions.get(`${partition}|${origin}|${permission}`) === true);
  });
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const requestURL = details.requestingUrl || wc.getURL();
    if (permission === 'fullscreen') return callback(isWebURL(requestURL));
    if (!isWebURL(requestURL) || !['media', 'geolocation', 'notifications', 'clipboard-read'].includes(permission)) return callback(false);
    const origin = webOrigin(requestURL);
    const key = `${partition}|${origin}|${permission}`;
    if (permissionDecisions.has(key)) return callback(permissionDecisions.get(key));
    const labels = { media: '카메라 / 마이크', geolocation: '위치', notifications: '알림', 'clipboard-read': '클립보드 읽기' };
    try {
      const { response } = await dialog.showMessageBox(contentsOwners.get(wc.id)?.win, { type: 'question', title: '사이트 권한',
        message: `${origin}`, detail: `${labels[permission]} 권한을 허용할까요? 이 선택은 현재 실행 중에 유지됩니다.`, buttons: ['차단', '허용'], defaultId: 0, cancelId: 0 });
      permissionDecisions.set(key, response === 1); callback(response === 1);
    } catch { callback(false); }
  });
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.on('will-download', (_event, item, source) => {
    const owner = contentsOwners.get(source?.id);
    if (!owner || owner.win?.isDestroyed()) { item.cancel(); return; }
    owner.receiveDownload(item);
  });
  return ses;
}

function receiveDownload(item) {
    const id = randomUUID();
    const record = { id, filename: item.getFilename(), receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'progressing', path: '' };
    downloads.unshift(record); downloads = downloads.slice(0, 50); downloadItems.set(id, item);
    if (TEST && process.env.ORBIT_DOWNLOAD_DIR) {
      fs.mkdirSync(process.env.ORBIT_DOWNLOAD_DIR, { recursive: true });
      item.setSavePath(path.join(process.env.ORBIT_DOWNLOAD_DIR, path.basename(item.getFilename())));
    } else item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.on('updated', (_event, status) => {
      record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); record.state = status;
      const total = downloads.filter(d => d.state === 'progressing').reduce((n, d) => n + d.totalBytes, 0);
      const received = downloads.filter(d => d.state === 'progressing').reduce((n, d) => n + d.receivedBytes, 0);
      win?.setProgressBar(total ? received / total : 2); publishSoon();
    });
    item.once('done', (_event, status) => {
      record.state = status; record.path = item.getSavePath(); record.receivedBytes = item.getReceivedBytes();
      downloadItems.delete(id); win?.setProgressBar(-1); publish(false);
      notify(status === 'completed' ? `${record.filename} 다운로드 완료` : `${record.filename} 다운로드 ${status === 'cancelled' ? '취소' : '중단'}`);
    });
    publish(false);
}
function bindShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    const consume = fn => { event.preventDefault(); Promise.resolve().then(fn).catch(error => notify(error.message)); };
    if (mod && key === 'n') return consume(() => handleAction(input.shift ? 'newIncognitoWindow' : 'newWindow'));
    if (mod && key === 't' && input.shift) return consume(() => handleAction('reopenTab'));
    if (mod && key === 'f') return consume(() => command('find'));
    if (mod && key === 'p') return consume(() => handleAction(input.shift ? 'savePDF' : 'print'));
    if (mod && key === 'd') return consume(() => handleAction(input.shift ? 'split' : 'favoriteTab', { id: state.activeTabId }));
    if (mod && ['+', '=', '-', '0'].includes(key)) return consume(() => handleAction('zoom', key === '0' ? { reset: true } : { delta: key === '-' ? -.1 : .1 }));
    if (key === 'f12' || (mod && input.shift && key === 'i')) return consume(() => handleAction('devTools'));
    if (mod && key === 'l') return consume(() => command('focus-address'));
    if (mod && key === 't') return consume(() => command('new-tab'));
    if (mod && key === 'w') return consume(() => handleAction('closeTab', { id: state.activeTabId }));
    if (mod && key === 'b') return consume(() => handleAction('toggleSidebar', {}));
    if (mod && key === 'j') return consume(() => command('downloads'));
    if (mod && key === ',') return consume(() => command('settings'));
    if (mod && key === '\\') return consume(() => handleAction('split', {}));
    if ((mod && key === 'r') || key === 'f5') return consume(() => handleAction('reload', {}));
    if (input.alt && key === 'arrowleft') return consume(() => handleAction('back', {}));
    if (input.alt && key === 'arrowright') return consume(() => handleAction('forward', {}));
    if (mod && key === 'tab') return consume(() => {
      const tabs = state.tabs.filter(t => t.spaceId === state.activeSpaceId), index = tabs.findIndex(t => t.id === state.activeTabId);
      const target = tabs[(index + (input.shift ? tabs.length - 1 : 1)) % tabs.length];
      if (target) handleAction('activateTab', { id: target.id });
    });
    if (key === 'f11') return consume(() => win.setFullScreen(!win.isFullScreen()));
  });
}
function updateNavigation(tab, wc) {
  if (wc.isDestroyed()) return;
  const url = wc.getURL();
  if (isWebURL(url)) { if (webOrigin(tab.url) !== webOrigin(url)) tab.faviconURL = null;tab.url = url; }
  tab.canGoBack = wc.navigationHistory.canGoBack(); tab.canGoForward = wc.navigationHistory.canGoForward();
  publish();
}
function ensureView(tab, shouldLoad = true, popupOptions = {}) {
  if (isInternal(tab.url)) return null;
  if (views.has(tab.id)) {
    if (!views.get(tab.id).webContents.isDestroyed()) return views.get(tab.id);
    views.delete(tab.id);
  }
  const view = new WebContentsView({ ...(popupOptions.webContents ? { webContents: popupOptions.webContents } : {}),
    webPreferences: { ...popupOptions.webPreferences, ...securePreferences, session: configureSession(tab.spaceId), preload: incognito ? undefined : path.join(__dirname, 'login-preload.cjs') } });
  views.set(tab.id, view); win.contentView.addChildView(view); view.setVisible(false);
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(12);
  const wc = view.webContents;
  contentsOwners.set(wc.id, controller);
  wc.once('destroyed', () => contentsOwners.delete(wc.id));
  bindShortcuts(wc);
  wc.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(win, { type: 'question', title: '페이지에서 나갈까요?',
      message: '저장하지 않은 내용이 있을 수 있어요.', detail: '나가면 입력 중인 내용이 사라질 수 있습니다.',
      buttons: ['계속 작성', '나가기'], defaultId: 0, cancelId: 0, noLink: true });
    if (response === 1) event.preventDefault();
    else {
      retainedTabs.delete(tab.id);
      closeRequests.get(tab.id)?.resolve(false);closeRequests.delete(tab.id);
    }
  });
  wc.once('destroyed', () => {
    findSessions.delete(tab.id);
    const request = closeRequests.get(tab.id);closeRequests.delete(tab.id);
    if (views.get(tab.id) === view) {
      views.delete(tab.id);try { win?.contentView.removeChildView(view); } catch {}
      if (!quitting && !closingWindow && !retainedTabs.has(tab.id)) removeTab(tab.id, tab.openerId);
      retainedTabs.delete(tab.id);
      layout();publish();
    }
    request?.resolve(true);
  });
  wc.on('focus', () => {
    if (visibleIds().includes(tab.id) && state.activeTabId !== tab.id) { state.activeTabId = tab.id; publish(); }
  });
  const checkNavigation = (event, url) => {
    const target = typeof url === 'string' ? url : event.url;
    if (!isWebURL(target)) { event.preventDefault(); notify('이 브라우저는 웹 주소(http/https)만 열 수 있어요.'); }
  };
  wc.on('will-navigate', checkNavigation); wc.on('will-redirect', checkNavigation);
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const target = popupTarget(url);
    if (!target) return { action: 'deny' };
    if (state.tabs.length >= 200) { notify('탭이 200개에 도달했어요. 사용하지 않는 탭을 닫아 주세요.'); return { action: 'deny' }; }
    return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: { ...securePreferences, session: configureSession(tab.spaceId), preload: incognito ? undefined : path.join(__dirname, 'login-preload.cjs') } },
      createWindow: options => {
        if (state.tabs.length >= 200) throw new Error('Tab limit reached');
        const popup = { id: randomUUID(), spaceId: tab.spaceId, title: target === 'about:blank' ? '로그인 창 연결 중…' : new URL(target).hostname, url: target, pinned: false, openerId: tab.id };
        state.tabs.push(popup);
        if (disposition !== 'background-tab') { enterPip(tab); state.activeSpaceId = tab.spaceId; state.activeTabId = popup.id; state.splitTabIds = []; }
        const popupView = ensureView(popup, !options.webContents, options); publish(); layout();
        return popupView.webContents;
      } };
  });
  wc.on('page-title-updated', (_event, title) => {
    tab.title = String(title || tab.url).slice(0, 500);
    if(!incognito&&state.searchPreferences.saveHistory){const url=safeVisit(wc.getURL());const entry=state.history.find(r=>r.kind==='visit'&&r.spaceId===tab.spaceId&&r.value===url);if(entry){entry.title=tab.title;syncShared('history');}}
    publish();
  });
  wc.on('page-favicon-updated', (_event, urls) => {
    const pageOrigin = webOrigin(tab.url);
    const candidates = Array.isArray(urls) ? urls.filter(isWebURL).slice(0, 4) : [];
    if (isWebURL(tab.url)) candidates.push(new URL('/favicon.ico', tab.url).href);
    (async () => { for (const url of [...new Set(candidates)]) if (webOrigin(tab.url) !== pageOrigin || await updateFavicon(tab, url)) break; })().catch(() => {});
  });
  wc.on('found-in-page', (_event, result) => {
    if (state.activeTabId !== tab.id) return;
    findResult = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal };
    publish(false);
  });
  wc.on('audio-state-changed', () => { tab.muted = wc.isAudioMuted();publish(false); });
  wc.on('did-start-loading', () => { tab.loading = true; tab.error = null; publish(false); layout(); });
  wc.on('did-stop-loading', () => { tab.loading = false; updateNavigation(tab, wc);if(!tab.error&&isWebURL(wc.getURL())&&!(new URL(wc.getURL()).hostname==='www.google.com'&&new URL(wc.getURL()).pathname==='/search'))remember('visit',safeVisit(wc.getURL()),tab.title,tab.spaceId);layout(); });
  wc.on('did-navigate', () => { findSessions.delete(tab.id);updateNavigation(tab, wc); });
  wc.on('did-navigate-in-page', () => updateNavigation(tab, wc));
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = `${description} (${code})`; tab.loading = false; publish(false); layout(); }
  });
  wc.on('render-process-gone', () => { tab.error = '페이지가 응답을 멈췄어요. 새로고침해 주세요.'; tab.loading = false; publish(false); layout(); });
  wc.on('enter-html-full-screen', () => win?.setFullScreen(true));
  wc.on('leave-html-full-screen', () => win?.setFullScreen(false));
  if (shouldLoad) wc.loadURL(tab.url).catch(error => {
    if (error.code !== 'ERR_ABORTED' && tabById(tab.id) && !wc.isDestroyed()) { tab.error = error.message; tab.loading = false; publish(false); layout(); }
  });
  return view;
}
function closeView(id) {
  const view = views.get(id);
  if (!view) return;
  views.delete(id);
  try { win?.contentView.removeChildView(view); if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
}
function requestCloseView(id, retain = false) {
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) return Promise.resolve(true);
  if (closeRequests.has(id)) return closeRequests.get(id).promise;
  if (retain) retainedTabs.add(id);
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  closeRequests.set(id, { promise, resolve });
  try { view.webContents.close({ waitForBeforeUnload: true }); }
  catch { closeRequests.delete(id);retainedTabs.delete(id);resolve(false); }
  return promise;
}
function removeTab(id, preferredId) {
  const target = tabById(id);if (!target) return;
  if (!incognito && isWebURL(target.url)) {
    state.archivedTabs.unshift({ id: target.id, spaceId: target.spaceId, title: target.title, url: target.url,
      pinned: target.pinned === true, folderId: target.folderId || null, closedAt: Date.now() });
    state.archivedTabs = state.archivedTabs.slice(0, 100);
  }
  state.tabs = state.tabs.filter(t => t.id !== id);
  if (!state.tabs.some(t => t.spaceId === target.spaceId)) makeTab(HOME, target.spaceId);
  if (state.splitTabIds.includes(id)) state.splitTabIds = [];
  if (state.activeTabId === id) {
    const preferred = tabById(preferredId);
    state.activeTabId = preferred?.spaceId === state.activeSpaceId ? preferred.id : state.tabs.find(t => t.spaceId === state.activeSpaceId).id;
    ensureView(currentTab());
  }
}
function makeTab(url = HOME, spaceId = state.activeSpaceId) {
  if (state.tabs.length >= 200) throw new Error('탭은 최대 200개까지 열 수 있어요. 사용하지 않는 탭을 닫아 주세요.');
  const tab = { id: randomUUID(), spaceId, title: url === HOME ? '새 탭' : new URL(url).hostname, url, pinned: false, folderId: null, faviconURL: null };
  state.tabs.push(tab); return tab;
}
async function activateTab(tab) {
  const old = currentTab();
  if (old?.id !== tab.id && !state.splitTabIds.includes(tab.id)) await enterPip(old);
  tab = tabById(tab.id);if (!tab) return;
  if (state.splitTabIds.length && !state.splitTabIds.includes(tab.id)) {
    const index = state.splitTabIds.indexOf(state.activeTabId); state.splitTabIds[index < 0 ? 0 : index] = tab.id;
  }
  state.activeTabId = tab.id; state.activeSpaceId = tab.spaceId;
  ensureView(tab); layout(); publish();
  if (!overlayOpen) views.get(tab.id)?.webContents.focus();
}
async function updateFavicon(tab, url) {
  if (quitting || !isWebURL(url) || !tabById(tab.id)) return;
  const sourceOrigin = webOrigin(tab.url), sourceSpaceId = tab.spaceId;
  const key = `${sourceSpaceId}|${url}`;
  let pending = faviconRequests.get(key);
  if (!pending) {
    if (faviconAborts.size >= 4) return false;
    pending = (async () => {
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4000);
      faviconAborts.add(abort);
      try {
        let current = url, response;
        for (let redirects = 0; redirects <= 3; redirects++) {
          if (quitting) return null;
          response = await configureSession(sourceSpaceId).fetch(current, { credentials: 'omit', redirect: 'manual', signal: abort.signal });
          if (response.status < 300 || response.status >= 400) break;
          const next = new URL(response.headers.get('location') || '', current).href;
          if (!isWebURL(next) || redirects === 3) return null;
          current = next;
        }
        if (!response?.ok || /svg|xml|html/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > 256 * 1024) return null;
        const chunks = [];let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;if (length > 256 * 1024) { abort.abort();return null; }
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);if (!boundedRaster(bytes)) return null;
        const icon = nativeImage.createFromBuffer(bytes);
        if (icon.isEmpty()) return null;
        const png = icon.resize({ width: 32, height: 32, quality: 'best' }).toPNG();
        return sanitizeFaviconURL(`data:image/png;base64,${png.toString('base64')}`);
      } catch { return null; } finally { clearTimeout(timer);abort.abort();faviconAborts.delete(abort); }
    })();
    faviconRequests.set(key, pending);
    if (faviconRequests.size > 200) faviconRequests.delete(faviconRequests.keys().next().value);
  }
  const data = await pending;
  if (data && !quitting && tabById(tab.id) === tab && tab.spaceId === sourceSpaceId && webOrigin(tab.url) === sourceOrigin) { tab.faviconURL = data;publish();return true; }
  return false;
}
function blankWindowState(privateMode, source = state) {
  const next = JSON.parse(JSON.stringify(source));
  next.tabs = next.spaces.map(space => ({ id: randomUUID(), spaceId: space.id, title: '새 탭', url: HOME, pinned: false }));
  next.activeTabId = next.tabs.find(entry => entry.spaceId === next.activeSpaceId).id;
  next.splitTabIds = [];
  if (privateMode) { next.archivedTabs = [];next.history=[]; }
  return sanitizeState(next);
}
function syncShared(key) {
  for (const other of controllers) {
    if (other === controller || (key === 'history' && other.incognito)) continue;
    other.state[key] = JSON.parse(JSON.stringify(state[key]));
    other.publish();
  }
}
async function importBookmarks() {
  if (incognito) throw new Error('북마크 가져오기는 일반 창에서 사용할 수 있어요.');
  const picked = await dialog.showOpenDialog(win, { title: '다른 브라우저의 북마크 가져오기', properties: ['openFile'],
    filters: [{ name: '북마크 HTML / JSON', extensions: ['html', 'htm', 'json'] }, { name: '모든 파일', extensions: ['*'] }] });
  if (picked.canceled || !picked.filePaths[0]) return;
  const filename = picked.filePaths[0], stat = await fs.promises.stat(filename);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('북마크 파일은 8MB 이하의 HTML 또는 JSON 파일이어야 해요.');
  const input = await fs.promises.readFile(filename, 'utf8');
  const parsed = /^\s*</.test(input) ? parseBookmarkHTML(input) : parseChromiumBookmarks(input);
  const room = 200 - state.tabs.length;
  if (!room) throw new Error('북마크를 가져오기 전에 사용하지 않는 탭을 닫아 주세요.');
  const folderIds = new Map();
  for (const folder of parsed.folders || []) {
    if (state.folders.length >= 100) break;
    const id = randomUUID();folderIds.set(folder.key, id);
    state.folders.push({ id, spaceId: state.activeSpaceId, name: String(folder.name || '가져온 북마크').slice(0, 80), collapsed: true });
  }
  let imported = 0;
  for (const bookmark of parsed.bookmarks || []) {
    if (imported >= room) break;
    if (!isWebURL(bookmark.url)) continue;
    const entry = makeTab(bookmark.url);entry.title = String(bookmark.title || new URL(bookmark.url).hostname).slice(0, 200);
    entry.pinned = true;entry.folderId = folderIds.get(bookmark.folderKey) || null;imported++;
  }
  notify(imported ? `${imported}개의 북마크를 고정 탭으로 가져왔습니다.${parsed.bookmarks.length > room ? ' 탭 한도로 일부 항목은 가져오지 못했어요.' : ''}` : '가져올 웹 북마크를 찾지 못했어요.');
}
async function loadExtension() {
  if (incognito) throw new Error('확장 프로그램은 일반 창에서만 불러올 수 있어요.');
  const picked = await dialog.showOpenDialog(win, { title: '압축 해제된 확장 프로그램 폴더 선택', properties: ['openDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return;
  const { directory, manifest } = await resolveExtensionDirectory(picked.filePaths[0]);
  const rpc = isRpcExtension(manifest);
  const contentMatches = (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).flatMap(script => Array.isArray(script?.matches) ? script.matches : []);
  const permissions = [...new Set([...(Array.isArray(manifest.permissions) ? manifest.permissions : []), ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []), ...contentMatches].map(String))].slice(0, 50).map(value => value.slice(0, 300)).join(', ');
  const approved = await dialog.showMessageBox(win, { type: 'warning', title: '확장 프로그램 불러오기',
    message: `“${String(manifest.name || '확장 프로그램').slice(0, 100)}”을(를) 현재 스페이스에서 실행할까요?`,
    detail: rpc ? '현재 스페이스의 일반 탭 제목·주소·재생 중인 미디어를 이 기기의 Discord Custom RPC 앱(127.0.0.1:39231)에 전달합니다. 시크릿 창과 입력 중인 글은 전달하지 않습니다. 이 연결은 재시작 후에도 유지되며 확장 목록에서 제거할 수 있습니다.' : `신뢰하는 확장 프로그램만 사용하세요. 웹페이지와 사이트 데이터에 접근할 수 있습니다.\n요청 권한: ${permissions || '명시된 권한 없음'}\nElectron에서 지원하는 일부 확장 API만 동작하며 Chrome 웹 스토어 설치는 지원하지 않습니다. 재시작 시 다시 불러와야 합니다.`,
    buttons: ['취소', '불러오기'], defaultId: 0, cancelId: 0 });
  if (approved.response !== 1) return;
  if (rpc) {
    rpcExtensions.set(state.activeSpaceId, rpcExtensionRecord(state.activeSpaceId, directory, manifest));
    saveRpcExtensions();
    rpcBridge?.start();
    rpcBridge?.tick();
    for (const owner of controllers) owner.publish(false);
    notify('Discord Custom RPC를 Orbit 호환 방식으로 연결했습니다. RPC 앱이 실행 중이면 활동이 전송됩니다.');return;
  }
  const extension = await configureSession(state.activeSpaceId).extensions.loadExtension(directory, { allowFileAccess: false });
  notify(`${extension.name}을(를) 현재 스페이스에 불러왔습니다.`);
}
async function showExtension(id) {
  const rpc = !incognito && rpcExtensions.get(state.activeSpaceId);
  if (rpc?.id === id) { await activateTab(makeTab('http://127.0.0.1:39231'));return; }
  const ses = configureSession(state.activeSpaceId), extension = ses.extensions.getExtension(id);
  if (!extension) return;
  const manifest = JSON.parse(await fs.promises.readFile(path.join(extension.path, 'manifest.json'), 'utf8'));
  const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
  if (typeof popup !== 'string' || !popup || popup.length > 2000 || popup.includes('\\') || popup.includes(':') || popup.startsWith('/')) { notify('이 확장 프로그램에는 열 수 있는 팝업이 없어요.');return; }
  const resolved = path.resolve(extension.path, popup), relative = path.relative(extension.path, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('잘못된 확장 프로그램 팝업 경로입니다.');
  const popupWindow = new BrowserWindow({ width: 440, height: 600, parent: win, title: extension.name, autoHideMenuBar: true,
    webPreferences: { ...securePreferences, session: ses } });
  extensionWindows.add(popupWindow);
  popupWindow.orbitExtensionId = extension.id;
  const base = `chrome-extension://${extension.id}/`;
  popupWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(base)) event.preventDefault(); });
  popupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popupWindow.once('closed', () => extensionWindows.delete(popupWindow));
  await popupWindow.loadURL(base + popup.split('/').map(encodeURIComponent).join('/'));
}
function closeExtensionPopups(id, ses) {
  for (const popup of extensionWindows) {
    if (!popup.isDestroyed() && popup.orbitExtensionId === id && popup.webContents.session === ses) popup.destroy();
  }
}
function cardImage(dataURL) {
  if (typeof dataURL !== 'string' || dataURL.length > 2 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataURL)) throw new Error('올바른 PNG 카드 이미지가 필요해요.');
  const bytes = Buffer.from(dataURL.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096) throw new Error('카드 이미지는 4096픽셀 이하의 PNG여야 해요.');
  const image = nativeImage.createFromBuffer(bytes);if (image.isEmpty()) throw new Error('카드 이미지를 읽지 못했어요.');
  return image;
}
function handleAction(name, payload = {}) {
  const result = actionQueue.then(() => performAction(name, payload));
  actionQueue = result.catch(() => {});
  return result.catch(error => { notify(error.message);throw error; });
}
async function performAction(name, payload = {}) {
  if (quitting) return snapshot();
  if (typeof name !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid action');
  const tab = currentTab(), wc = views.get(tab?.id)?.webContents;
  switch (name) {
    case 'searchPreferences': {
      if(incognito)break;
      state.searchPreferences=preferences({...state.searchPreferences,...Object.fromEntries(Object.entries(payload).filter(([key])=>['autocomplete','saveHistory','onlineSuggestions'].includes(key)))});
      suggestionRequest?.abort();syncShared('searchPreferences');break;
    }
    case 'clearHistory': if(!incognito){state.history=state.history.filter(r=>r.spaceId!==state.activeSpaceId);syncShared('history');}break;
    case 'deleteHistory': if(!incognito){state.history=state.history.filter(r=>!(r.spaceId===state.activeSpaceId&&r.kind===payload.kind&&r.value===payload.value));syncShared('history');}break;
    case 'passwordList': { const available = !incognito && passwordVault.available();return { entries: available ? passwordVault.list(state.activeSpaceId) : [], available, origin: loginOrigin(wc?.getURL()) }; }
    case 'passwordSave': {
      if (incognito || !wc || !loginOrigin(wc.getURL())) throw new Error('일반 창의 HTTPS 로그인 페이지에서 사용해 주세요.');
      const origin = loginOrigin(wc.getURL());
      const value = await withDeadline(wc.executeJavaScriptInIsolatedWorld(1138, [{ code: collectLoginScript }]), 1500);
      if (origin !== loginOrigin(wc.getURL())) throw new Error('페이지가 변경되었습니다. 다시 시도해 주세요.');
      if (!value) throw new Error('입력한 아이디와 비밀번호가 있는 로그인 폼을 찾지 못했습니다.');
      await offerLogin(tab, value, origin);break;
    }
    case 'passwordFill': {
      if (incognito || !wc) throw new Error('일반 창에서 사용해 주세요.');
      const entry = passwordVault.matches(state.activeSpaceId, wc.getURL()).find(r => r.id === payload.id);
      if (!entry || !await fillSavedLogin(tab, entry)) throw new Error('같은 사이트의 비어 있는 로그인 폼에서 사용해 주세요.');
      notify('로그인 정보를 입력했습니다. 로그인 버튼을 눌러 주세요.');break;
    }
    case 'passwordDelete': {
      if (incognito) break;
      const entry = passwordVault.list(state.activeSpaceId).find(r => r.id === payload.id);
      if (!entry) break;
      const { response } = await dialog.showMessageBox(win, { type: 'question', title: '저장된 로그인 삭제', message: `${new URL(entry.origin).host}의 ${entry.username || '저장된 계정'}을 삭제할까요?`, buttons: ['취소', '삭제'], defaultId: 0, cancelId: 0 });
      if (response === 1) passwordVault.remove(state.activeSpaceId, entry.id);break;
    }
    case 'newWindow':
    case 'newIncognitoWindow': {
      const privateMode = name === 'newIncognitoWindow';
      const source = incognito && !privateMode ? [...controllers].find(owner => !owner.incognito)?.state || createDefaultState() : state;
      const other = createController({ incognito: privateMode, initialState: blankWindowState(privateMode, source) });
      await other.ready;break;
    }
    case 'createFolder': {
      if (state.folders.length >= 100) throw new Error('폴더는 최대 100개까지 만들 수 있어요.');
      const name = String(payload.name || '').trim().slice(0, 80);if (!name) throw new Error('폴더 이름을 입력해 주세요.');
      state.folders.push({ id: randomUUID(), spaceId: state.activeSpaceId, name, collapsed: false });break;
    }
    case 'renameFolder': {
      const folder = state.folders.find(entry => entry.id === payload.id);
      const name = String(payload.name || '').trim().slice(0, 80);if (folder && name) folder.name = name;break;
    }
    case 'toggleFolder': { const folder = state.folders.find(entry => entry.id === payload.id);if (folder) folder.collapsed = !folder.collapsed;break; }
    case 'deleteFolder': {
      const folder = state.folders.find(entry => entry.id === payload.id);if (!folder) break;
      state.folders = state.folders.filter(entry => entry.id !== folder.id);
      for (const entry of state.tabs) if (entry.folderId === folder.id) entry.folderId = null;break;
    }
    case 'moveTab': {
      const target = tabById(payload.id);if (!target) break;
      const spaceId = typeof payload.spaceId === 'string' ? payload.spaceId : target.spaceId;
      if (!state.spaces.some(entry => entry.id === spaceId)) break;
      const folder = payload.folderId ? state.folders.find(entry => entry.id === payload.folderId && entry.spaceId === spaceId) : null;
      if (payload.folderId && !folder) break;
      const oldSpace = target.spaceId;
      if (spaceId !== oldSpace) {
        // A view's storage session cannot change. Recreate it only after the page permits closing.
        if (!await requestCloseView(target.id, true)) break;
        target.spaceId = spaceId;target.faviconURL = null;
        if (!state.tabs.some(entry => entry.spaceId === oldSpace)) makeTab(HOME, oldSpace);
        if (state.splitTabIds.includes(target.id)) state.splitTabIds = [];
        if (state.activeTabId === target.id) state.activeTabId = state.tabs.find(entry => entry.spaceId === state.activeSpaceId).id;
      }
      target.folderId = folder?.id || null;
      if (target.id === state.activeTabId) ensureView(target);break;
    }
    case 'reorderTab': {
      const target = tabById(payload.id), before = tabById(payload.beforeId);
      if (!target || !before || target.id === before.id || target.spaceId !== before.spaceId) break;
      state.tabs = state.tabs.filter(entry => entry.id !== target.id);state.tabs.splice(state.tabs.indexOf(before), 0, target);break;
    }
    case 'favoriteTab': {
      if (incognito) throw new Error('즐겨찾기 변경은 일반 창에서 사용할 수 있어요.');
      const target = tabById(payload.id || state.activeTabId);if (!target || !isWebURL(target.url)) break;
      const existing = state.favorites.find(entry => entry.url === target.url);
      if (existing) state.favorites = state.favorites.filter(entry => entry.id !== existing.id);
      else {
        if (state.favorites.length >= 50) throw new Error('즐겨찾기는 최대 50개까지 저장할 수 있어요.');
        state.favorites.push({ id: randomUUID(), title: target.title, url: target.url, faviconURL: target.faviconURL || null });
      }
      syncShared('favorites');break;
    }
    case 'removeFavorite': {
      if (incognito) throw new Error('즐겨찾기 변경은 일반 창에서 사용할 수 있어요.');
      state.favorites = state.favorites.filter(entry => entry.id !== payload.id);syncShared('favorites');break;
    }
    case 'openFavorite': {
      const favorite = state.favorites.find(entry => entry.id === payload.id);if (!favorite) break;
      const existing = state.tabs.find(entry => entry.spaceId === state.activeSpaceId && entry.url === favorite.url);
      await activateTab(existing || makeTab(favorite.url));break;
    }
    case 'archiveTab': {
      const target = tabById(payload.id || state.activeTabId);if (target && await requestCloseView(target.id)) removeTab(target.id, target.openerId);break;
    }
    case 'archiveAll': {
      for (const target of [...state.tabs].filter(entry => entry.spaceId === state.activeSpaceId && !entry.pinned)) {
        if (await requestCloseView(target.id)) removeTab(target.id);
      }break;
    }
    case 'reopenTab': {
      if (incognito) break;
      const archived = payload.id ? state.archivedTabs.find(entry => entry.id === payload.id) : state.archivedTabs[0];
      if (!archived || !isWebURL(archived.url)) break;
      const spaceId = state.spaces.some(entry => entry.id === archived.spaceId) ? archived.spaceId : state.activeSpaceId;
      const restored = makeTab(archived.url, spaceId);restored.title = archived.title;restored.pinned = archived.pinned;
      restored.folderId = state.folders.some(folder => folder.id === archived.folderId && folder.spaceId === spaceId) ? archived.folderId : null;
      state.archivedTabs = state.archivedTabs.filter(entry => entry.id !== archived.id);state.splitTabIds = [];
      await activateTab(restored);break;
    }
    case 'clearArchive': state.archivedTabs = [];break;
    case 'profile': {
      const displayName = payload.displayName ?? payload.name, seed = payload.cardSeed ?? payload.seed;
      if (typeof displayName === 'string' && displayName.trim()) state.profile.displayName = displayName.trim().slice(0, 40);
      if (typeof payload.tagline === 'string') state.profile.tagline = payload.tagline.trim().slice(0, 80);
      if (Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) state.profile.cardSeed = seed;
      if (!incognito) syncShared('profile');break;
    }
    case 'find': {
      if (!wc) { findResult = { matches: 0, activeMatchOrdinal: 0 };break; }
      const query = typeof payload.query === 'string' ? payload.query.slice(0, 1000) : '';
      if (!query) { wc.stopFindInPage('clearSelection');findSessions.delete(tab.id);findResult = null;break; }
      // Electron 44 names this option findNext, but true begins a session.
      // The renderer's findNext flag means advance within an existing search.
      const beginSession = payload.findNext !== true || findSessions.get(tab.id) !== query;
      wc.findInPage(query, { forward: payload.forward !== false, findNext: beginSession });
      findSessions.set(tab.id, query);
      break;
    }
    case 'stopFind': wc?.stopFindInPage('clearSelection');if (tab) findSessions.delete(tab.id);findResult = null;break;
    case 'zoom': if (wc) {
      const current = wc.getZoomFactor(), delta = Number(payload.delta);
      if (payload.reset === true) wc.setZoomFactor(1);
      else if (Number.isFinite(delta) && Math.abs(delta) <= 1) wc.setZoomFactor(Math.max(.5, Math.min(3, Math.round((current + delta) * 100) / 100)));
    }break;
    case 'print': {
      if (!wc) { notify('인쇄할 웹페이지를 먼저 열어 주세요.');break; }
      wc.print({ silent: false, printBackground: true }, (success, reason) => { if (!success && reason && reason !== 'cancelled') notify('인쇄하지 못했어요: ' + String(reason).slice(0, 200)); });break;
    }
    case 'savePDF': {
      if (!wc) { notify('PDF로 저장할 웹페이지를 먼저 열어 주세요.');break; }
      const filename = (tab.title || 'Orbit').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) + '.pdf';
      const picked = await dialog.showSaveDialog(win, { title: '페이지를 PDF로 저장', defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (picked.canceled || !picked.filePath) break;
      const pdf = await wc.printToPDF({ printBackground: true });await fs.promises.writeFile(picked.filePath, pdf);notify('페이지를 PDF로 저장했습니다.');break;
    }
    case 'saveCard': {
      const image = cardImage(payload.dataURL);
      const picked = await dialog.showSaveDialog(win, { title: '나의 Orbit 카드 저장', defaultPath: path.join(app.getPath('pictures'), 'Orbit-Card.png'), filters: [{ name: 'PNG', extensions: ['png'] }] });
      if (!picked.canceled && picked.filePath) { await fs.promises.writeFile(picked.filePath, image.toPNG());notify('카드를 저장했습니다.'); }break;
    }
    case 'copyCard': {
      const image = cardImage(payload.dataURL);
      clipboard.writeImage(image);notify('카드를 클립보드에 복사했습니다.');break;
    }
    case 'devTools': if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });break;
    case 'copyURL': { const target = tabById(payload.id || state.activeTabId);if (target && isWebURL(target.url)) { clipboard.writeText(target.url);notify('주소를 복사했습니다.'); }break; }
    case 'muteTab': { const target = tabById(payload.id || state.activeTabId), targetWC = views.get(target?.id)?.webContents;
      if (targetWC) { targetWC.setAudioMuted(!targetWC.isAudioMuted());target.muted = targetWC.isAudioMuted(); }break;
    }
    case 'importBookmarks': await importBookmarks();break;
    case 'loadExtension': await loadExtension();break;
    case 'removeExtension': {
      if (incognito) throw new Error('확장 프로그램 변경은 일반 창에서 사용할 수 있어요.');
      if (typeof payload.id === 'string' && /^[a-p]{32}$/.test(payload.id)) {
        const rpc = rpcExtensions.get(state.activeSpaceId);
        if (rpc?.id === payload.id) { rpcExtensions.delete(state.activeSpaceId);saveRpcExtensions();if (rpcExtensions.size) rpcBridge?.tick();else await rpcBridge?.stop(); }
        else {
          const ses = configureSession(state.activeSpaceId);
          for (const owner of controllers) owner.closeExtensionPopups(payload.id, ses);
          ses.extensions.removeExtension(payload.id);
        }
        for (const owner of controllers) owner.publish(false);
      }break;
    }
    case 'showExtension': if (typeof payload.id === 'string' && /^[a-p]{32}$/.test(payload.id)) await showExtension(payload.id);break;
    case 'checkUpdates': await dialog.showMessageBox(win, { type: 'info', title: 'Orbit 업데이트', message: `현재 버전 ${app.getVersion()}`,
      detail: '이 베타 버전은 수동 업데이트를 지원합니다. 배포받은 새 Orbit 설치 파일을 실행하면 기존 스페이스와 로그인 정보가 유지됩니다. 공개 업데이트 서버와 자동 업데이트는 아직 연결되지 않았습니다.', buttons: ['확인'] });break;
    case 'newTab': {
      const url = payload.url ? normalizeInput(payload.url) : HOME;
      await activateTab(makeTab(url)); break;
    }
    case 'activateTab': {
      const target = tabById(payload.id); if (target && target.spaceId === state.activeSpaceId) await activateTab(target); break;
    }
    case 'closeTab': {
      const target = tabById(payload.id); if (!target) break;
      if (await requestCloseView(target.id)) removeTab(target.id, target.openerId);
      break;
    }
    case 'pinTab': { const target = tabById(payload.id); if (target) target.pinned = !target.pinned; break; }
    case 'navigate': {
      const url = normalizeInput(payload.input);
      if(url!==HOME){const parsed=new URL(url);if(parsed.hostname==='www.google.com'&&parsed.pathname==='/search'&&parsed.searchParams.get('q')===String(payload.input||'').trim())remember('search',String(payload.input).trim(),String(payload.input).trim());}
      if (isInternal(tab.url) || !wc) { tab.url = url; tab.title = url === HOME ? '새 탭' : new URL(url).hostname; tab.error = null; ensureView(tab); }
      else if (isInternal(url)) { if (!await requestCloseView(tab.id, true)) break; Object.assign(tab, { url, title: url===HOME?'새 탭':new URL(url).hostname, faviconURL:null, error: null, loading: false, canGoBack: false, canGoForward: false }); }
      else { if (webOrigin(tab.url) !== webOrigin(url)) tab.faviconURL = null;tab.url = url; tab.error = null; wc.loadURL(url).catch(() => {}); }
      if (!overlayOpen && url !== HOME) views.get(tab.id)?.webContents.focus();
      break;
    }
    case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': if (wc) { tab.error = null; wc.reload(); } else ensureView(tab); break;
    case 'switchSpace': {
      const target = state.spaces.find(s => s.id === payload.id); if (!target || target.id === state.activeSpaceId) break;
      await enterPip(tab); state.activeSpaceId = target.id; state.splitTabIds = [];
      state.activeTabId = state.tabs.find(t => t.spaceId === target.id).id; ensureView(currentTab()); break;
    }
    case 'createSpace': {
      if (state.spaces.length >= 30) throw new Error('스페이스는 최대 30개까지 만들 수 있어요.');
      if (state.tabs.length >= 200) throw new Error('새 스페이스를 만들기 전에 사용하지 않는 탭을 닫아 주세요.');
      const name = String(payload.name || '').trim().slice(0, 40) || nextSpaceName(state.spaces);
      await enterPip(tab);
      const space = { id: randomUUID(), name, color: /^#[0-9a-f]{6}$/i.test(payload.color) ? payload.color : '#c8d8cb' };
      state.spaces.push(space); state.activeSpaceId = space.id; state.splitTabIds = []; state.activeTabId = makeTab(HOME, space.id).id; break;
    }
    case 'renameSpace': { const space = state.spaces.find(s => s.id === payload.id); const name = String(payload.name || '').trim().slice(0, 40); if (space && name) space.name = name; break; }
    case 'deleteSpace': {
      if (state.spaces.length === 1) throw new Error('스페이스는 하나 이상 필요해요.');
      const space = state.spaces.find(s => s.id === payload.id); if (!space) break;
      const { response } = await dialog.showMessageBox(win, { type: 'question', title: '스페이스 삭제', message: `“${space.name}” 스페이스와 탭을 삭제할까요?`, detail: '이 작업은 되돌릴 수 없어요.', buttons: ['취소', '삭제'], defaultId: 0, cancelId: 0 });
      if (response !== 1) break;
      let allowed = true;
      for (const entry of state.tabs.filter(t => t.spaceId === space.id)) {
        if (!await requestCloseView(entry.id)) { allowed = false;break; }
      }
      if (!allowed) break;
      state.tabs = state.tabs.filter(t => t.spaceId !== space.id); state.spaces = state.spaces.filter(s => s.id !== space.id);
      if (state.activeSpaceId === space.id) { state.activeSpaceId = state.spaces[0].id; state.activeTabId = state.tabs.find(t => t.spaceId === state.activeSpaceId).id; state.splitTabIds = []; ensureView(currentTab()); }
      state.folders = state.folders.filter(folder => folder.spaceId !== space.id);
      state.archivedTabs = state.archivedTabs.filter(entry => entry.spaceId !== space.id);
      if(!incognito){state.history=state.history.filter(entry=>entry.spaceId!==space.id);syncShared('history');}
      if (!incognito && rpcExtensions.delete(space.id)) {
        saveRpcExtensions();
        if (rpcExtensions.size) rpcBridge?.tick(); else await rpcBridge?.stop();
      }
      configureSession(space.id).clearStorageData().catch(() => {}); break;
    }
    case 'theme': if (/^#[0-9a-f]{6}$/i.test(payload.color)) { state.themeColor = payload.color; const space = state.spaces.find(s => s.id === state.activeSpaceId); space.color = payload.color; } break;
    case 'autoPip': state.autoPip = payload.enabled === true; break;
    case 'pip': await enterPip(tab, true); break;
    case 'split': {
      if (state.splitTabIds.length) { state.splitTabIds = []; break; }
      const other = state.tabs.find(t => t.spaceId === state.activeSpaceId && t.id !== tab.id && t.url !== HOME) || state.tabs.find(t => t.spaceId === state.activeSpaceId && t.id !== tab.id) || makeTab(HOME);
      state.splitTabIds = [tab.id, other.id]; ensureView(tab); ensureView(other); break;
    }
    case 'unsplit': state.splitTabIds = []; break;
    case 'toggleSidebar': toggleSidebar(); break;
    case 'motionPreference': reducedMotion = payload.reduced === true; if (reducedMotion) finishSidebarMotion(); break;
    case 'defaultBrowserSettings':
      if (process.platform === 'win32') await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Orbit');
      break;
    case 'clearSiteData': {
      const space = state.spaces.find(s => s.id === state.activeSpaceId);
      const { response } = await dialog.showMessageBox(win, { type: 'question', title: '사이트 데이터 삭제',
        message: `“${space.name}”의 쿠키와 캐시를 삭제할까요?`, detail: '이 스페이스의 사이트에서 로그아웃됩니다. 탭과 고정 탭은 유지됩니다.', buttons: ['취소', '삭제'], defaultId: 0, cancelId: 0 });
      if (response !== 1) break;
      const ses = configureSession(space.id);await ses.clearCache();await ses.clearStorageData();
      const partition = incognito ? `orbit-private-${windowId}-${space.id}` : `persist:orbit-${space.id}`;
      for (const key of permissionDecisions.keys()) if (key.startsWith(`${partition}|`)) permissionDecisions.delete(key);
      notify('현재 스페이스의 사이트 데이터를 삭제했습니다.');break;
    }
    case 'overlay': if(!payload.open)suggestionRequest?.abort(); overlayOpen = payload.open === true; if (overlayOpen) win.webContents.focus(); break;
    case 'minimize': win.minimize(); break;
    case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'closeWindow': win.close(); return snapshot();
    case 'cancelDownload': downloadItems.get(payload.id)?.cancel(); break;
    case 'showDownload': { const item = downloads.find(d => d.id === payload.id && d.state === 'completed'); if (item?.path) shell.showItemInFolder(item.path); break; }
    case 'clearDownloads': downloads = downloads.filter(d => d.state === 'progressing'); break;
    default: throw new Error('Unknown action');
  }
  layout();
  if (win?.isFocused() && ['activateTab', 'switchSpace', 'split', 'unsplit', 'newTab'].includes(name)) await restorePipIfVisible();
  publish(); return snapshot();
}

async function startWindow() {
  win = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 600, frame: false,
    show: false, backgroundColor: state.themeColor, title: incognito ? 'Orbit · 시크릿' : 'Orbit', icon: path.join(__dirname, 'renderer', 'orbit.ico'), autoHideMenuBar: true,
    webPreferences: { ...securePreferences, preload: path.join(__dirname, 'preload.cjs') } });
  contentsOwners.set(win.webContents.id, controller);
  bindShortcuts(win.webContents);
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('resize', layout); win.on('maximize', () => publish(false)); win.on('unmaximize', () => publish(false));
  win.on('blur', () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { if (win && !win.isDestroyed() && !win.isFocused()) enterPip(currentTab()); }, 180);
  });
  win.on('focus', () => { clearTimeout(blurTimer); restorePipIfVisible(); });
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();if (closingWindow) return;closingWindow = true;
    (async () => {
      for (const id of [...views.keys()]) {
        if (!await requestCloseView(id)) {
          closingWindow = false;
          for (const visibleId of visibleIds()) { const entry = tabById(visibleId);if (entry) ensureView(entry); }
          layout();publish();return;
        }
      }
      finishSidebarMotion();clearTimeout(saveTimer);saveNow();
      const otherNormalWindow = [...controllers].some(owner => owner !== controller && !owner.incognito && owner.win && !owner.win.isDestroyed());
      if (!incognito && !otherNormalWindow) saveNow(path.join(app.getPath('userData'), 'orbit-state.json'));
      quitting = true;
      win.destroy();
    })().catch(error => { closingWindow = false;notify(error.message); });
  });
  win.on('closed', () => {
    clearTimeout(blurTimer);clearTimeout(noticeTimer);clearTimeout(publishTimer);clearTimeout(saveTimer);
    win = null;
    for (const abort of faviconAborts) abort.abort();
    for (const popup of extensionWindows) if (!popup.isDestroyed()) popup.destroy();
    for (const item of downloadItems.values()) { try { item.cancel(); } catch {} }
    for (const [id, owner] of contentsOwners) if (owner === controller) contentsOwners.delete(id);
    controllers.delete(controller);
    if (!incognito && !primary) {
      // Only this controller's generated files are disposable. The last normal
      // window has already copied its state to orbit-state.json above.
      const ownFile = path.join(app.getPath('userData'), 'windows', windowId + '.json');
      if (path.resolve(stateFile) === path.resolve(ownFile)) {
        try { fs.rmSync(ownFile, { force: true });fs.rmSync(ownFile + '.tmp', { force: true }); } catch {}
      }
    }
    if (incognito) {
      for (const [partition, ses] of sessions) if (partition.startsWith('orbit-private-' + windowId + '-')) {
        ses.clearStorageData().catch(() => {});ses.clearCache().catch(() => {});sessions.delete(partition);
        for (const key of permissionDecisions.keys()) if (key.startsWith(partition + '|')) permissionDecisions.delete(key);
      }
    }
    for (const owner of controllers) owner.publish(false);
  });
  await win.loadFile(uiPath);
  for (const id of visibleIds()) { const tab = tabById(id); if (tab) ensureView(tab); }
  layout(); publish(false); win.show();
  for (const owner of controllers) if (owner !== controller) owner.publish(false);
  return controller;
}
controller.ready = startWindow();
return controller;
}

function trusted(event) {
  const owner = contentsOwners.get(event.sender.id);
  if (!owner?.win || owner.win.isDestroyed() || event.sender !== owner.win.webContents || event.senderFrame !== owner.win.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Untrusted caller');
  return owner;
}
ipcMain.handle('orbit:state', event => trusted(event).snapshot());
ipcMain.handle('orbit:action', async (event, name, payload) => trusted(event).handleAction(name, payload));
ipcMain.handle('orbit:suggest',(event,query)=>trusted(event).suggest(query));
for (const [channel, type] of [['orbit:login-ready', 'ready'], ['orbit:login-save', 'save']]) ipcMain.on(channel, (event, value) => {
  const owner = contentsOwners.get(event.sender.id);
  if (!owner || event.sender === owner.win?.webContents) return;
  owner.loginEvent(event, type, value).catch(() => {});
});

app.whenReady().then(async () => {
  if (!hasLock) return;
  let state;
  try { state = sanitizeState(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'orbit-state.json'), 'utf8'))); }
  catch { state = createDefaultState(); }
  Menu.setApplicationMenu(null);
  await restoreRpcExtensions();
  rpcBridge = new OrbitRpcBridge({
    endpoint: TEST ? process.env.ORBIT_RPC_ENDPOINT || undefined : undefined,
    getCandidates: () => {
      if ([...controllers].some(owner => owner.incognito && owner.win?.isFocused())) return [];
      return [...controllers].flatMap(owner => owner.rpcCandidates());
    },
    onStatus: () => { for (const owner of controllers) owner.publish(false); }
  });
  if (rpcExtensions.size) rpcBridge.start();
  const primary = createController({ initialState: state, primary: true });
  await primary.ready;
  for (const url of externalURLs.splice(0)) await primary.handleAction('newTab', { url });
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => rpcBridge?.stop());
app.on('before-quit', event => {
  const live = [...controllers].filter(owner => owner.win && !owner.win.isDestroyed());
  if (live.length && !appQuitting) { event.preventDefault();for (const owner of live) owner.win.close();return; }
  appQuitting = true;for (const owner of controllers) owner.saveNow();
});
app.on('second-instance', (_event, args) => {
  const urls = args.filter(isWebURL).slice(0, 20);
  const owner = [...controllers].find(candidate => candidate.win?.isFocused()) || [...controllers].find(candidate => !candidate.incognito) || [...controllers][0];
  if (owner?.win && !owner.win.isDestroyed()) {
    if (owner.win.isMinimized()) owner.win.restore();owner.win.show();owner.win.focus();
    for (const url of urls) owner.handleAction('newTab', { url }).catch(console.error);
  } else externalURLs.push(...urls);
});
