'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveExtensionDirectory } = require('../lib/extension-path.cjs');

const workRoot = path.resolve(__dirname, '..', '..', '..', 'work');
const manifest = { manifest_version: 3, name: 'Local fixture extension', version: '1.0.0' };

async function fixture(t) {
  await fs.mkdir(workRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(workRoot, 'extension-path-'));
  t.after(async () => {
    const absolute = path.resolve(directory);
    const relative = path.relative(workRoot, absolute);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && path.basename(absolute).startsWith('extension-path-'), 'Only the newly created fixture directory may be removed');
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return directory;
}
async function writeManifest(directory, value = manifest) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

test('a selected extension folder is normalized and returns its parsed manifest', async t => {
  const directory = await fixture(t);
  await writeManifest(directory);
  const selected = path.relative(process.cwd(), directory) + path.sep + 'unused' + path.sep + '..' + path.sep + '.';
  assert.deepEqual(await resolveExtensionDirectory(selected), { directory, manifest });
});

test('a project root automatically selects its immediate extension subfolder', async t => {
  const project = await fixture(t);
  const directory = path.join(project, 'extension');
  await writeManifest(directory);
  assert.deepEqual(await resolveExtensionDirectory(project), { directory, manifest });
});

test('an existing root manifest takes precedence over a nested extension', async t => {
  const directory = await fixture(t);
  await writeManifest(directory);
  await writeManifest(path.join(directory, 'extension'), { ...manifest, name: 'Nested fixture' });
  assert.deepEqual(await resolveExtensionDirectory(directory), { directory, manifest });
});

test('an invalid root manifest reports its error instead of silently loading a nested extension', async t => {
  const directory = await fixture(t);
  await writeManifest(directory, '{invalid JSON');
  await writeManifest(path.join(directory, 'extension'));
  await assert.rejects(resolveExtensionDirectory(directory), /JSON 형식이 올바르지/);
});

test('resolution never searches other folders or recursively walks an extension tree', async t => {
  const directory = await fixture(t);
  await writeManifest(path.join(directory, 'src'));
  await writeManifest(path.join(directory, 'extension', 'nested'));
  await assert.rejects(resolveExtensionDirectory(directory), /extension 폴더에 manifest\.json이 없어요/);
});

test('missing paths, file selections and missing manifests explain which folder to choose', async t => {
  const directory = await fixture(t);
  await assert.rejects(resolveExtensionDirectory(path.join(directory, 'missing')), /선택한 폴더를 찾을 수 없어요/);
  const selectedFile = path.join(directory, 'selected-file');
  await fs.writeFile(selectedFile, 'fixture');
  await assert.rejects(resolveExtensionDirectory(selectedFile), /파일 대신.*폴더를 선택/);
  await assert.rejects(resolveExtensionDirectory(directory), /manifest\.json이 없어요/);
  for (const value of [null, undefined, 3, {}, '', '  ', 'bad\0path']) await assert.rejects(resolveExtensionDirectory(value), /폴더를 선택/);
});

test('a directory named manifest.json is rejected without using the nested fallback', async t => {
  const directory = await fixture(t);
  await fs.mkdir(path.join(directory, 'manifest.json'));
  await writeManifest(path.join(directory, 'extension'));
  await assert.rejects(resolveExtensionDirectory(directory), /manifest\.json은 일반 파일/);
});

test('manifest content must be an object and Windows UTF-8 BOM files are accepted', async t => {
  const directory = await fixture(t);
  for (const value of ['[]', 'null', '42', 'true', '"text"']) {
    await writeManifest(directory, value);
    await assert.rejects(resolveExtensionDirectory(directory), /JSON 객체여야/);
  }
  await writeManifest(directory, '\ufeff' + JSON.stringify(manifest));
  assert.deepEqual((await resolveExtensionDirectory(directory)).manifest, manifest);
});

test('the one MiB boundary is inclusive and larger manifest files are rejected', async t => {
  const directory = await fixture(t);
  const empty = JSON.stringify({ ...manifest, padding: '' });
  const exact = empty.replace('"padding":""', `"padding":"${'a'.repeat(1024 * 1024 - Buffer.byteLength(empty))}"`);
  assert.equal(Buffer.byteLength(exact), 1024 * 1024);
  await writeManifest(directory, exact);
  assert.equal((await resolveExtensionDirectory(directory)).manifest.name, manifest.name);
  await writeManifest(directory, exact + ' ');
  await assert.rejects(resolveExtensionDirectory(directory), /1MB 이하여야/);
});
