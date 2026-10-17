'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function loginOrigin(value) {
  try { const u = new URL(value);return u.protocol === 'https:' && !u.username && !u.password ? u.origin : ''; } catch { return ''; }
}
class PasswordVault {
  constructor(file, crypto) { this.file = file;this.crypto = crypto; }
  available() { return this.crypto.isEncryptionAvailable() && (process.platform !== 'linux' || this.crypto.getSelectedStorageBackend?.() !== 'basic_text'); }
  read() {
    if (!this.available()) throw new Error('Windows 암호화를 사용할 수 없어 비밀번호를 열 수 없습니다.');
    if (!fs.existsSync(this.file)) return [];
    if (fs.statSync(this.file).size > 4 * 1024 * 1024) throw new Error('비밀번호 파일 크기를 확인해 주세요.');
    try {
      const data = JSON.parse(this.crypto.decryptString(fs.readFileSync(this.file)));
      if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 1000) throw Error();
      return data.records.filter(r => typeof r.id === 'string' && typeof r.spaceId === 'string' && loginOrigin(r.origin) === r.origin && typeof r.username === 'string' && typeof r.password === 'string');
    } catch { throw new Error('비밀번호 저장소를 열 수 없습니다. 원본 파일은 보존됩니다.'); }
  }
  write(records) {
    if (!this.available()) throw new Error('Windows 암호화를 사용할 수 없어 저장하지 않았습니다.');
    const bytes = this.crypto.encryptString(JSON.stringify({ version: 1, records }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', bytes);fs.renameSync(this.file + '.tmp', this.file);
  }
  list(spaceId) { return this.read().filter(r => r.spaceId === spaceId).map(({ password, ...r }) => r); }
  matches(spaceId, origin) { return this.read().filter(r => r.spaceId === spaceId && r.origin === loginOrigin(origin)); }
  save(spaceId, value) {
    const origin = loginOrigin(value.origin);
    if (!origin || typeof spaceId !== 'string' || !spaceId || typeof value.password !== 'string' || !value.password || value.password.length > 2048 || typeof value.username !== 'string' || value.username.length > 320) throw new Error('저장할 로그인 정보를 확인해 주세요.');
    const records = this.read();
    const old = records.find(r => r.spaceId === spaceId && r.origin === origin && r.username === value.username);
    if (!old && records.length >= 1000) throw new Error('최대 1,000개까지 저장할 수 있습니다.');
    const entry = { id: old?.id || randomUUID(), spaceId, origin, username: value.username, password: value.password, updatedAt: Date.now() };
    if (old) records[records.indexOf(old)] = entry;else records.push(entry);
    this.write(records);return entry.id;
  }
  remove(spaceId, id) { const records = this.read();this.write(records.filter(r => r.spaceId !== spaceId || r.id !== id)); }
}
module.exports = { PasswordVault, loginOrigin };
