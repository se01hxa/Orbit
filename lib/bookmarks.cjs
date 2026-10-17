'use strict';

// Bookmark files are treated as data. Neither parser executes HTML or reads a
// browser profile; the caller chooses and reads the file to import.
const MAX_BOOKMARKS = 500;
const MAX_FOLDERS = 500;
const MAX_NODES = 10000;
const MAX_DEPTH = 64;
const MAX_INPUT_LENGTH = 10 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeEntities(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || match;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint) : '\ufffd';
  });
}

function plainText(value, fallback, maxLength = 200) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function bookmarkURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed) || /[\u0000-\u0020\u007f]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!url.hostname || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return null;
  }
}

function collector() {
  const folders = [];
  const bookmarks = [];
  return {
    folders,
    bookmarks,
    addFolder(name, parentKey) {
      if (folders.length >= MAX_FOLDERS) return null;
      const key = `folder-${folders.length + 1}`;
      folders.push({ key, name: plainText(name, '가져온 폴더', 80), ...(parentKey ? { parentKey } : {}) });
      return key;
    },
    addBookmark(title, candidate, folderKey) {
      if (bookmarks.length >= MAX_BOOKMARKS) return;
      const url = bookmarkURL(candidate);
      if (!url) return;
      bookmarks.push({ title: plainText(title, new URL(url).hostname), url, ...(folderKey ? { folderKey } : {}) });
    },
    result() { return { folders, bookmarks }; },
  };
}

function parseChromiumBookmarks(input) {
  if (typeof input === 'string' && input.length > MAX_INPUT_LENGTH) throw new RangeError('북마크 파일이 너무 큽니다.');
  const document = typeof input === 'string' ? JSON.parse(input.replace(/^\ufeff/, '')) : input;
  const out = collector();
  if (!isRecord(document) || !isRecord(document.roots)) return out.result();
  const roots = Object.values(document.roots).filter(isRecord);
  const pending = roots.reverse().map((node) => ({ node, depth: 0, parentKey: null }));
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length && visited < MAX_NODES && out.bookmarks.length < MAX_BOOKMARKS) {
    const { node, depth, parentKey } = pending.pop();
    if (!isRecord(node) || seen.has(node) || depth > MAX_DEPTH) continue;
    seen.add(node);
    visited += 1;
    if (node.type === 'url') {
      out.addBookmark(node.name, node.url, parentKey);
      continue;
    }
    if (!Array.isArray(node.children) || (node.type !== undefined && node.type !== 'folder')) continue;
    const folderKey = out.addFolder(node.name, parentKey) || parentKey;
    // Avoid queueing an unbounded or deeply nested external tree.
    const count = Math.min(node.children.length, MAX_NODES - visited - pending.length);
    for (let i = count - 1; i >= 0; i -= 1) pending.push({ node: node.children[i], depth: depth + 1, parentKey: folderKey });
  }
  return out.result();
}

function attribute(tag, name) {
  const body = tag.replace(/^<\/?[a-z][a-z0-9:-]*/i, '').replace(/>$/, '');
  const pattern = /([^\s=<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of body.matchAll(pattern)) {
    if (match[1].toLowerCase() === name) return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return null;
}

function parseBookmarkHTML(input) {
  if (typeof input !== 'string') throw new TypeError('HTML 북마크 파일이 필요합니다.');
  if (input.length > MAX_INPUT_LENGTH) throw new RangeError('북마크 파일이 너무 큽니다.');
  const out = collector();
  const folderStack = [];
  let pendingFolder = null;
  let capture = null;
  let ignoredTag = null;
  let offset = 0;
  let visited = 0;
  const currentFolder = () => folderStack.at(-1) || null;
  const finishCapture = () => {
    if (!capture) return;
    const title = decodeEntities(capture.text);
    if (capture.kind === 'a') out.addBookmark(title, capture.url, capture.folderKey);
    if (capture.kind === 'h3') pendingFolder = out.addFolder(title, capture.folderKey) || capture.folderKey;
    capture = null;
  };
  while (offset < input.length && visited < MAX_NODES && out.bookmarks.length < MAX_BOOKMARKS) {
    const start = input.indexOf('<', offset);
    if (start === -1) {
      if (capture && !ignoredTag) capture.text += input.slice(offset);
      break;
    }
    if (capture && !ignoredTag) capture.text += input.slice(offset, start);
    if (input.startsWith('<!--', start)) {
      const end = input.indexOf('-->', start + 4);
      offset = end === -1 ? input.length : end + 3;
      continue;
    }
    let end = start + 1;
    let quote = null;
    for (; end < input.length; end += 1) {
      const character = input[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end >= input.length) break;
    offset = end + 1;
    const tag = input.slice(start, offset);
    const match = tag.match(/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    if (!match) continue;
    visited += 1;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    if (ignoredTag) {
      if (closing && name === ignoredTag) ignoredTag = null;
      continue;
    }
    if (!closing && ['script', 'style', 'template'].includes(name)) { ignoredTag = name; continue; }
    if (name === 'a' || name === 'h3') {
      if (closing) {
        if (capture?.kind === name) finishCapture();
      } else {
        finishCapture();
        capture = { kind: name, text: '', folderKey: currentFolder(), url: name === 'a' ? attribute(tag, 'href') : null };
      }
    } else if (name === 'dt' && !closing) {
      finishCapture();
    } else if (name === 'dl') {
      finishCapture();
      if (closing) folderStack.pop();
      else if (folderStack.length < MAX_DEPTH) folderStack.push(pendingFolder || currentFolder());
      pendingFolder = null;
    }
  }
  finishCapture();
  return out.result();
}

module.exports = { parseBookmarkHTML, parseChromiumBookmarks };
