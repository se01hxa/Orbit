'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_MANIFEST_BYTES = 1024 * 1024;

function readableError(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new Error('확장 프로그램 폴더를 읽을 권한이 없어요. 읽을 수 있는 폴더를 선택해 주세요.', { cause: error });
  }
  return new Error('확장 프로그램 파일을 읽지 못했어요. 폴더가 이동되거나 삭제되지 않았는지 확인해 주세요.', { cause: error });
}

async function manifestExists(filename) {
  try { return await fs.stat(filename); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw readableError(error);
  }
}

async function readManifest(filename) {
  let file;
  try { file = await fs.open(filename, 'r'); }
  catch (error) { throw readableError(error); }
  let bytes;
  try {
    let stat;
    try { stat = await file.stat(); }
    catch (error) { throw readableError(error); }
    if (!stat.isFile()) throw new Error('manifest.json은 일반 파일이어야 해요. 확장 프로그램 파일을 다시 확인해 주세요.');
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error('확장 프로그램 manifest.json은 1MB 이하여야 해요.');
    // Keep the read bounded even if the selected file grows after its size check.
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      let result;
      try { result = await file.read(buffer, length, buffer.length - length, length); }
      catch (error) { throw readableError(error); }
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_MANIFEST_BYTES) throw new Error('확장 프로그램 manifest.json은 1MB 이하여야 해요.');
    bytes = buffer.subarray(0, length);
  } finally {
    try { await file.close(); }
    catch (error) { throw readableError(error); }
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, '')); }
  catch (error) { throw new Error('manifest.json을 읽었지만 JSON 형식이 올바르지 않아요. 파일 내용을 확인해 주세요.', { cause: error }); }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest.json은 확장 프로그램 정보를 담은 JSON 객체여야 해요.');
  }
  return manifest;
}

async function resolveExtensionDirectory(selectedDir) {
  if (typeof selectedDir !== 'string' || !selectedDir.trim() || selectedDir.includes('\0')) {
    throw new Error('확장 프로그램 폴더를 선택해 주세요.');
  }
  const selected = path.resolve(selectedDir);
  let stat;
  try { stat = await fs.stat(selected); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('선택한 폴더를 찾을 수 없어요. 확장 프로그램 폴더를 다시 선택해 주세요.', { cause: error });
    throw readableError(error);
  }
  if (!stat.isDirectory()) throw new Error('파일 대신 확장 프로그램이 들어 있는 폴더를 선택해 주세요.');

  let directory = selected;
  let filename = path.join(directory, 'manifest.json');
  let manifestStat = await manifestExists(filename);
  if (!manifestStat) {
    directory = path.join(selected, 'extension');
    filename = path.join(directory, 'manifest.json');
    manifestStat = await manifestExists(filename);
  }
  if (!manifestStat) throw new Error('선택한 폴더와 그 안의 extension 폴더에 manifest.json이 없어요. manifest.json이 들어 있는 확장 프로그램 폴더를 선택해 주세요.');
  if (!manifestStat.isFile()) throw new Error('manifest.json은 일반 파일이어야 해요. 확장 프로그램 파일을 다시 확인해 주세요.');
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('확장 프로그램 manifest.json은 1MB 이하여야 해요.');
  return { directory, manifest: await readManifest(filename) };
}

module.exports = { resolveExtensionDirectory };
