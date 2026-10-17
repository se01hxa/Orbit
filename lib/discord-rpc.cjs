'use strict';

// This bridge deliberately uses the browser's own tab model. Chrome extension
// tab/window APIs do not describe Electron WebContentsViews accurately.
const http = require('node:http');
const { isIP } = require('node:net');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:39231';
const COLLECT_WORLD_ID = 1137;
const MAX_CANDIDATES = 32;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 2000;
const COLLECT_TIMEOUT_MS = 1200;

// Only page metadata and media properties are inspected. This script never
// reads inputs, editable elements, chat messages, cookies, storage or credentials.
// It runs without a preload or Node bindings in its own isolated world.
const collectPageScript = `(() => {
  'use strict';
  const clean = (value, length = 300) => typeof value === 'string' ? value.replace(/[\\u0000-\\u001f\\u007f]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, length) : '';
  const url = value => {
    if (typeof value !== 'string' || value.length > 4096) return '';
    try {
      const result = new URL(value, location.href);
      return /^https?:$/.test(result.protocol) && !result.username && !result.password ? result.href : '';
    } catch { return ''; }
  };
  const meta = name => {
    const node = document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]');
    return clean(node?.getAttribute('content') || '', 1000);
  };
  const text = selector => clean(document.querySelector(selector)?.textContent || '');
  const attrURL = (selector, attr = 'href') => url(document.querySelector(selector)?.getAttribute(attr) || '');
  const clock = value => {
    const parts = String(value || '').trim().split(':').map(Number);
    if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const host = location.hostname.toLowerCase().replace(/^www\\./, '');
  const provider = host === 'music.youtube.com' ? 'youtubeMusic'
    : host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' ? 'youtube'
    : host === 'open.spotify.com' ? 'spotifyWeb'
    : host === 'netflix.com' || host.endsWith('.netflix.com') ? 'netflix' : 'genericMedia';
  const page = {
    description: meta('description') || meta('og:description'),
    siteName: meta('og:site_name') || clean(location.hostname, 200),
    image: url(meta('og:image') || meta('twitter:image')),
    favIconUrl: attrURL('link[rel~="icon"]') || attrURL('link[rel="shortcut icon"]') || attrURL('link[rel="apple-touch-icon"]') || url('/favicon.ico')
  };
  let session = null, metadata = null;
  try { session = navigator.mediaSession || null;metadata = session?.metadata || null; } catch {}
  const elements = [];
  for (const element of document.querySelectorAll('video,audio')) { elements.push(element);if (elements.length >= 12) break; }
  const element = elements.find(item => !item.paused && !item.ended && item.readyState >= 2)
    || elements.find(item => item.currentTime > 0) || elements[0] || null;
  if (!element && !metadata) return { observedURL: location.href, page, media: null };
  let artwork = '';
  try {
    const choices = Array.isArray(metadata?.artwork) ? metadata.artwork : [];
    for (const item of choices.slice(0, 5)) { artwork = url(item?.src || '');if (artwork) break; }
  } catch {}
  const media = {
    provider,
    kind: provider === 'youtubeMusic' || provider === 'spotifyWeb' || element?.tagName?.toLowerCase() === 'audio' ? 'music' : 'video',
    title: clean(metadata?.title || meta('og:title') || document.title),
    artist: clean(metadata?.artist || meta('author'), 200),
    album: clean(metadata?.album || '', 200),
    thumbnail: artwork || page.image,
    artistUrl: '',
    paused: element ? Boolean(element.paused || element.ended) : session?.playbackState !== 'playing',
    currentTime: element ? finite(element.currentTime) : null,
    duration: element ? finite(element.duration) : null,
    playbackRate: element && Number.isFinite(element.playbackRate) ? element.playbackRate : 1
  };
  if (provider === 'youtube' || provider === 'youtubeMusic') {
    media.title = clean(metadata?.title || text('#title h1 yt-formatted-string') || text('ytmusic-player-bar .title') || meta('og:title') || document.title).replace(/\\s+-\\s+YouTube(?: Music)?$/i, '');
    media.artist = clean(metadata?.artist || text('ytmusic-player-bar .byline') || text('#owner #channel-name a') || meta('author'), 200);
    media.artistUrl = attrURL('ytmusic-player-bar .byline a') || attrURL('#owner #channel-name a');
    media.thumbnail = artwork || attrURL('ytmusic-player-bar img', 'src') || page.image;
    try {
      const pageURL = new URL(location.href);
      const videoId = pageURL.hostname === 'youtu.be' ? pageURL.pathname.slice(1) : pageURL.searchParams.get('v');
      if (!media.thumbnail && /^[a-zA-Z0-9_-]{6,20}$/.test(videoId || '')) media.thumbnail = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';
    } catch {}
  } else if (provider === 'spotifyWeb') {
    media.title = clean(metadata?.title || text('[data-testid="context-item-info-title"]') || meta('og:title') || document.title);
    media.artist = clean(metadata?.artist || text('[data-testid="context-item-info-artist"]'), 200);
    media.artistUrl = attrURL('[data-testid="context-item-info-artist"] a');
    const position = clock(text('[data-testid="playback-position"]'));
    const duration = clock(text('[data-testid="playback-duration"]'));
    if (media.currentTime === null && position !== null) media.currentTime = position;
    if (media.duration === null && duration !== null) media.duration = duration;
  } else if (provider === 'netflix') {
    media.title = clean(metadata?.title || text('[data-uia="video-title"] h4') || meta('og:title') || document.title).replace(/\\s*\\|\\s*Netflix$/i, '') || 'Netflix';
    media.artist = clean(metadata?.artist || text('[data-uia="video-title"] span'), 200);
  }
  return { observedURL: location.href, page, media };
})()`;

function clean(value, length) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length) : '';
}

function webURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function publicAssetURL(value) {
  const safe = webURL(value);if (!safe) return '';
  const host = new URL(safe).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return '';
  if (isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)) return '';
  } else if (isIP(host) === 6 && (host === '::' || host === '::1' || /^(?:f[cd]|fe[89ab])/i.test(host) || host.startsWith('::ffff:'))) return '';
  return safe.length <= 4096 ? safe : '';
}

function endpointOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?\/?$/.test(value)) return null;
  try { const url = new URL(value);return url.origin; } catch { return null; }
}

function finite(value, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

function errorText(error) {
  if (error?.code === 'ECONNREFUSED') return '로컬 Discord RPC 앱에 연결할 수 없어요.';
  if (error?.code === 'ETIMEDOUT') return '로컬 Discord RPC 앱의 응답 시간이 초과됐어요.';
  if (error?.code === 'ERPCENDPOINT') return 'RPC 연결 주소는 127.0.0.1의 HTTP 주소여야 해요.';
  if (error?.code === 'ERPCHTTP') return '로컬 Discord RPC 앱이 요청을 받지 못했어요.';
  if (error?.code === 'ERPCRESPONSE') return '로컬 Discord RPC 앱의 응답을 확인할 수 없어요.';
  return 'Discord RPC 연결을 확인해 주세요.';
}

function failure(code) { const error = new Error(code);error.code = code;return error; }

class OrbitRpcBridge {
  constructor({ getCandidates = () => [], endpoint = DEFAULT_ENDPOINT, intervalMs = 3000, onStatus = null } = {}) {
    this._getCandidates = typeof getCandidates === 'function' ? getCandidates : () => [];
    this._endpoint = endpointOrigin(endpoint);
    this._intervalMs = Number.isFinite(intervalMs) ? Math.max(250, Math.min(60000, intervalMs)) : 3000;
    this._onStatus = typeof onStatus === 'function' ? onStatus : null;
    this._status = { enabled: false, connected: false, error: this._endpoint ? null : errorText(failure('ERPCENDPOINT')), lastSentAt: null, endpoint: this._endpoint || DEFAULT_ENDPOINT };
    this._running = false;
    this._generation = 0;
    this._needsStart = true;
    this._pending = null;
    this._timer = null;
    this._requests = new Set();
    this._samples = new Map();
  }

  getStatus() { return { ...this._status }; }

  _update(values) {
    this._status = { ...this._status, ...values };
    try { this._onStatus?.(this.getStatus()); } catch {}
  }

  start() {
    if (this._running) return this.getStatus();
    this._running = true;this._generation++;this._needsStart = true;
    this._update({ enabled: true });
    this._timer = setInterval(() => { void this.tick(); }, this._intervalMs);
    this._timer.unref?.();
    void this.tick();
    return this.getStatus();
  }

  async stop({ notify = true } = {}) {
    const wasRunning = this._running;
    this._running = false;this._generation++;
    clearInterval(this._timer);this._timer = null;
    for (const request of this._requests) request.destroy();
    this._samples.clear();
    this._update({ enabled: false, connected: false });
    if (notify && wasRunning && this._endpoint) {
      try { await this._post('/api/extension', { browser: 'orbit', event: 'idle', tabIds: [] }); } catch {}
    }
    return this.getStatus();
  }

  tick() {
    if (!this._running) return Promise.resolve(this.getStatus());
    if (this._pending) return this._pending;
    const generation = this._generation;
    const pending = this._runTick(generation).catch(error => {
      if (generation === this._generation && this._running) this._update({ connected: false, error: errorText(error) });
      return this.getStatus();
    }).finally(() => { if (this._pending === pending) this._pending = null; });
    this._pending = pending;
    return pending;
  }

  _isCurrent(generation) { return this._running && generation === this._generation; }

  _candidates(value) {
    const used = new Set(), output = [];
    for (const candidate of Array.isArray(value) ? value : []) {
      if (output.length >= MAX_CANDIDATES) break;
      if (!candidate || candidate.incognito === true || typeof candidate.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(candidate.id) || used.has(candidate.id) || !webURL(candidate.url)) continue;
      if (!candidate.webContents || candidate.webContents.isDestroyed?.()) continue;
      used.add(candidate.id);output.push(candidate);
    }
    return output;
  }

  async _runTick(generation) {
    if (!this._endpoint) throw failure('ERPCENDPOINT');
    const candidates = this._candidates(await this._getCandidates());
    if (!this._isCurrent(generation)) return this.getStatus();
    const event = candidates.length ? (this._needsStart ? 'started' : 'heartbeat') : 'idle';
    await this._post('/api/extension', { browser: 'orbit', event, tabIds: candidates.map(candidate => candidate.id) });
    if (!this._isCurrent(generation)) return this.getStatus();
    if (candidates.length) this._needsStart = false;
    this._update({ connected: true, error: null, lastSentAt: Date.now() });
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const group = candidates.slice(offset, offset + 4);
      const samples = await Promise.all(group.map(candidate => this._collect(candidate)));
      for (let index = 0; index < group.length; index++) {
        if (!this._isCurrent(generation)) return this.getStatus();
        const candidate = group[index];
        const fresh = this._candidates(await this._getCandidates()).find(current => current.id === candidate.id && current.webContents === candidate.webContents);
        if (!this._isCurrent(generation)) return this.getStatus();
        if (!fresh) continue;
        const payload = this._payload(fresh, samples[index]);
        if (!payload) continue;
        await this._post('/api/tab', payload);
        if (!this._isCurrent(generation)) return this.getStatus();
        this._update({ connected: true, error: null, lastSentAt: Date.now() });
      }
    }
    return this.getStatus();
  }

  async _collect(candidate) {
    const wc = candidate.webContents;
    if (wc.isDestroyed?.() || typeof wc.executeJavaScriptInIsolatedWorld !== 'function' || this._samples.has(wc)) return null;
    const sample = Promise.resolve().then(() => wc.executeJavaScriptInIsolatedWorld(COLLECT_WORLD_ID, [{ code: collectPageScript }], false))
      .then(value => { if (this._samples.get(wc) === sample) this._samples.delete(wc);return value; }, () => { if (this._samples.get(wc) === sample) this._samples.delete(wc);return null; });
    this._samples.set(wc, sample);
    let timer;
    try { return await Promise.race([sample, new Promise(resolve => { timer = setTimeout(() => resolve(null), COLLECT_TIMEOUT_MS); })]); }
    finally { clearTimeout(timer); }
  }

  _payload(candidate, sample) {
    const wc = candidate.webContents;if (wc.isDestroyed?.()) return null;
    const url = webURL(typeof wc.getURL === 'function' ? wc.getURL() : candidate.url);if (!url) return null;
    const title = clean(typeof wc.getTitle === 'function' ? wc.getTitle() : candidate.title, 500) || new URL(url).hostname;
    if (sample && typeof sample.observedURL === 'string' && webURL(sample.observedURL) !== url) sample = null;
    const page = sample && typeof sample.page === 'object' && sample.page ? sample.page : {};
    const source = sample && typeof sample.media === 'object' && sample.media ? sample.media : null;
    let media = null;
    if (source) {
      const provider = ['youtube', 'youtubeMusic', 'spotifyWeb', 'netflix', 'genericMedia'].includes(source.provider) ? source.provider : 'genericMedia';
      media = {
        provider, kind: source.kind === 'music' ? 'music' : 'video', title: clean(source.title, 300) || title,
        artist: clean(source.artist, 200), album: clean(source.album, 200), thumbnail: publicAssetURL(source.thumbnail),
        linkUrl: url, artistUrl: publicAssetURL(source.artistUrl), paused: source.paused !== false,
        currentTime: finite(source.currentTime), duration: finite(source.duration), playbackRate: finite(source.playbackRate, 16) || 1
      };
    }
    return {
      browser: 'orbit', id: candidate.id, tabId: candidate.id, windowId: Number.isInteger(candidate.windowId) && candidate.windowId > 0 ? candidate.windowId : 0,
      active: candidate.active === true, windowFocused: candidate.windowFocused === true, url, title,
      description: clean(page.description, 500), siteName: clean(page.siteName, 200), image: publicAssetURL(page.image),
      favIconUrl: publicAssetURL(page.favIconUrl) || publicAssetURL(candidate.faviconURL), media
    };
  }

  _post(route, payload) {
    return new Promise((resolve, reject) => {
      if (!this._endpoint) { reject(failure('ERPCENDPOINT'));return; }
      let body;
      try { body = Buffer.from(JSON.stringify(payload)); } catch { reject(failure('ERPCRESPONSE'));return; }
      if (body.length > MAX_BODY_BYTES) { reject(failure('ERPCRESPONSE'));return; }
      let finished = false, timer;
      const finish = error => {
        if (finished) return;finished = true;
        clearTimeout(timer);this._requests.delete(request);
        if (error) reject(error);else resolve();
      };
      const request = http.request(new URL(route, this._endpoint), { method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Connection': 'close' } }, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) { finish(failure('ERPCHTTP'));request.destroy();return; }
        if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) { finish(failure('ERPCRESPONSE'));request.destroy();return; }
        const chunks = [];let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { finish(failure('ERPCRESPONSE'));request.destroy();return; }
          chunks.push(chunk);
        });
        response.once('error', error => finish(error));
        response.once('aborted', () => finish(failure('ERPCRESPONSE')));
        response.once('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!result || result.ok !== true) { finish(failure('ERPCRESPONSE'));return; }
            finish();
          } catch { finish(failure('ERPCRESPONSE')); }
        });
      });
      this._requests.add(request);
      request.once('error', error => finish(error));
      timer = setTimeout(() => { finish(failure('ETIMEDOUT'));request.destroy(); }, REQUEST_TIMEOUT_MS);
      request.end(body);
    });
  }
}

module.exports = { OrbitRpcBridge, collectPageScript, COLLECT_PAGE_SCRIPT: collectPageScript, COLLECT_WORLD_ID };
