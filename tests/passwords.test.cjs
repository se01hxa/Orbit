'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PasswordVault, loginOrigin } = require('../lib/passwords.cjs');
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'orbit-vault-'));
  t.after(() => { if (path.dirname(fs.realpathSync(dir)) !== parent || !path.basename(dir).startsWith('orbit-vault-')) throw Error('Unsafe cleanup');fs.rmSync(dir, { recursive: true }); });
  const key = crypto.randomBytes(32);
  const provider = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);const out = Buffer.concat([c.update(value, 'utf8'), c.final()]);return Buffer.concat([iv, c.getAuthTag(), out]); },
    decryptString(bytes) { const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString(); } };
  const file = path.join(dir, 'passwords.bin');return { vault: new PasswordVault(file, provider), file, provider };
}
test('vault stores encrypted credentials and exposes metadata only', t => {
  const { vault, file } = fixture(t);
  const id = vault.save('personal', { origin: 'https://login.example.org/path', username: 'fixture-user', password: 'fixture-password-123' });
  const bytes = fs.readFileSync(file);
  for (const text of ['fixture-password-123','fixture-user','login.example.org']) assert.equal(bytes.includes(Buffer.from(text)), false);
  assert.equal(vault.matches('personal','https://login.example.org/')[0].password, 'fixture-password-123');
  assert.equal(vault.list('personal')[0].id, id);assert.equal('password' in vault.list('personal')[0], false);
  assert.equal(fs.existsSync(file + '.tmp'), false);
});
test('matching is restricted to the exact HTTPS origin and current space', t => {
  const { vault } = fixture(t);vault.save('personal', { origin:'https://example.org', username:'u', password:'p' });
  for (const origin of ['https://sub.example.org','https://example.org:444','http://example.org','https://example.org.evil.test']) assert.deepEqual(vault.matches('personal',origin), []);
  assert.deepEqual(vault.matches('work','https://example.org'), []);
  assert.deepEqual(vault.list('work'), []);
});
test('updating and deleting one login preserve the other space and accounts', t => {
  const { vault } = fixture(t);const value = {origin:'https://example.org',username:'u',password:'p'};
  const id = vault.save('personal', value);vault.save('work',value);vault.save('personal',{...value,username:'other'});
  assert.equal(vault.save('personal',{...value,password:'new'}),id);assert.equal(vault.matches('personal',value.origin).find(r=>r.id===id).password,'new');
  vault.remove('work',id);assert.equal(vault.list('personal').length,2);
  vault.remove('personal',id);assert.equal(vault.list('personal').length,1);assert.equal(vault.list('work').length,1);
});
test('unavailable encryption and corrupt ciphertext never overwrite the original', t => {
  const { vault, provider, file } = fixture(t);vault.save('personal',{origin:'https://example.org',username:'u',password:'p'});const original=fs.readFileSync(file);
  provider.isEncryptionAvailable=()=>false;assert.throws(()=>vault.save('personal',{origin:'https://example.org',username:'u',password:'new'}));assert.deepEqual(fs.readFileSync(file),original);
  provider.isEncryptionAvailable=()=>true;const broken=Buffer.from(original);broken[15]^=1;fs.writeFileSync(file,broken);
  assert.throws(()=>vault.save('personal',{origin:'https://example.org',username:'u',password:'new'}),/원본 파일/);assert.deepEqual(fs.readFileSync(file),broken);
});
test('unsafe origins and oversized or missing secrets are rejected', t => {
  const { vault } = fixture(t);
  for(const origin of ['http://example.org','file:///C:/a','https://user:pass@example.org','javascript:alert(1)']) { assert.equal(loginOrigin(origin),'');assert.throws(()=>vault.save('personal',{origin,username:'u',password:'p'})); }
  for(const password of ['', 'x'.repeat(2049), null]) assert.throws(()=>vault.save('personal',{origin:'https://example.org',username:'u',password}));
});
