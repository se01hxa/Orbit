'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBookmarkHTML, parseChromiumBookmarks } = require('../lib/bookmarks.cjs');

test('Chromium imports nested folders, preserves order and strips URL credentials', () => {
  const source = { roots: { bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
    { type: 'url', name: 'Example', url: 'https://user:password@example.com/a?b=1' },
    { type: 'folder', name: 'Work', children: [{ type: 'url', name: '문서', url: 'https://docs.example.com/' }] },
  ] } } };
  assert.deepEqual(parseChromiumBookmarks(JSON.stringify(source)), {
    folders: [{ key: 'folder-1', name: 'Bookmarks bar' }, { key: 'folder-2', name: 'Work', parentKey: 'folder-1' }],
    bookmarks: [{ title: 'Example', url: 'https://example.com/a?b=1', folderKey: 'folder-1' }, { title: '문서', url: 'https://docs.example.com/', folderKey: 'folder-2' }],
  });
});

test('Chromium skips malformed trees and unsafe protocols and bounds cycles and depth', () => {
  const cyclic = { type: 'folder', name: 'Cycle', children: [] };
  cyclic.children.push(cyclic, null, 1, [], { type: 'url', name: 'Bad', url: 'javascript:alert(1)' }, { type: 'url', name: 'File', url: 'file:///C:/test' }, { type: 'url', name: 'Safe', url: 'https://safe.example/' });
  const result = parseChromiumBookmarks({ roots: { one: cyclic, other: { type: 'nonsense', children: [{ type: 'url', url: 'https://ignored.test/' }] } } });
  assert.equal(result.folders.length, 1);
  assert.deepEqual(result.bookmarks, [{ title: 'Safe', url: 'https://safe.example/', folderKey: 'folder-1' }]);
  for (const value of [null, [], {}, { roots: [] }, { roots: { bad: { children: 'wrong' } } }]) assert.deepEqual(parseChromiumBookmarks(value), { folders: [], bookmarks: [] });
  assert.throws(() => parseChromiumBookmarks('{bad json'), SyntaxError);
  assert.throws(() => parseChromiumBookmarks(' '.repeat(10 * 1024 * 1024 + 1)), RangeError);
  let deep = { type: 'url', url: 'https://too-deep.test/' };
  for (let i = 0; i < 100; i += 1) deep = { type: 'folder', name: 'Nested', children: [deep] };
  const bounded = parseChromiumBookmarks({ roots: { deep } });
  assert.ok(bounded.folders.length <= 65);
  assert.equal(bounded.bookmarks.length, 0);
});

test('Netscape bookmark HTML imports nested folders and decodes text and URL entities once', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><TITLE>Bookmarks</TITLE><DL><p>
    <DT><H3 ADD_DATE="1">Work &amp; Play</H3><DL><p>
      <DT><A HREF="https://example.com/?one=1&amp;two=2" ICON="data:ignored">Example &lt;docs&gt;</A>
      <DT><H3>한글 &#x1F30D;</H3><DL><p><DT><A HREF='https://user:pass@safe.example/'><B>Nested</B> &#38; safe</A></DL><p>
      <DT><A HREF="https://example.com/?q=&amp;amp;">Decode once</A>
    </DL><p><DT><A HREF=https://outside.example/>Outside</A></DL><p>`;
  assert.deepEqual(parseBookmarkHTML(html), {
    folders: [{ key: 'folder-1', name: 'Work & Play' }, { key: 'folder-2', name: '한글 🌍', parentKey: 'folder-1' }],
    bookmarks: [
      { title: 'Example <docs>', url: 'https://example.com/?one=1&two=2', folderKey: 'folder-1' },
      { title: 'Nested & safe', url: 'https://safe.example/', folderKey: 'folder-2' },
      { title: 'Decode once', url: 'https://example.com/?q=&amp;', folderKey: 'folder-1' },
      { title: 'Outside', url: 'https://outside.example/' },
    ],
  });
});

test('HTML ignores active content, unsafe URLs and misleading attributes without executing markup', () => {
  const html = `<DL><script><A HREF="https://evil.test/">Fake</A></script>
    <!-- <A HREF="https://comment.test/">Fake</A> -->
    <A data-href="https://fake.test/" HREF="javascript:alert(1)" onclick="steal()">Bad</A>
    <A HREF="data:text/html,hello">Data</A><A HREF="file:///C:/private">File</A>
    <A HREF="https://safe.example/?x=&quot;quoted&gt;value&quot;" onclick="alert('x')">Safe <style>hidden</style> link</A>
    <A HREF="https://safe.example/&#10;malformed">Control</A></DL>`;
  assert.deepEqual(parseBookmarkHTML(html), { folders: [], bookmarks: [{ title: 'Safe link', url: 'https://safe.example/?x=%22quoted%3Evalue%22' }] });
});

test('malformed HTML repairs unclosed anchors and handles empty or truncated input', () => {
  assert.deepEqual(parseBookmarkHTML(''), { folders: [], bookmarks: [] });
  assert.deepEqual(parseBookmarkHTML('<A HREF="https://one.example/">One<DT><A HREF="https://two.example/">Two'), {
    folders: [], bookmarks: [{ title: 'One', url: 'https://one.example/' }, { title: 'Two', url: 'https://two.example/' }],
  });
  assert.deepEqual(parseBookmarkHTML('<A HREF="https://one.example/'), { folders: [], bookmarks: [] });
  assert.throws(() => parseBookmarkHTML(null), TypeError);
  assert.throws(() => parseBookmarkHTML(' '.repeat(10 * 1024 * 1024 + 1)), RangeError);
});

test('both import formats cap bookmark counts while retaining valid folder references', () => {
  const children = Array.from({ length: 650 }, (_, i) => ({ type: 'url', name: `Tab ${i}`, url: `https://example.com/${i}` }));
  const chromium = parseChromiumBookmarks({ roots: { bar: { type: 'folder', name: 'Bar', children } } });
  const html = parseBookmarkHTML('<DL><DT><H3>Bar</H3><DL>' + children.map((item) => `<DT><A HREF="${item.url}">${item.name}</A>`).join('') + '</DL></DL>');
  for (const result of [chromium, html]) {
    assert.equal(result.bookmarks.length, 500);
    assert.equal(result.bookmarks.at(-1).title, 'Tab 499');
    assert.equal(result.bookmarks.every((bookmark) => result.folders.some((folder) => folder.key === bookmark.folderKey)), true);
  }
});
