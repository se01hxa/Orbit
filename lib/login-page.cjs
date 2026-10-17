'use strict';
// Executed only in an isolated world of the current HTTPS main frame.
function collectLogin() {
  const visible = n => n.getClientRects().length && !n.disabled;
  const pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (!pw || !pw.value || pw.value.length > 2048) return null;
  const form = pw.form;
  if (form && new URL(form.action || location.href, location.href).origin !== location.origin) return null;
  const fields = [...(form || document).querySelectorAll('input')];
  const user = fields.find(n => n.autocomplete === 'username' && visible(n)) || fields.filter(n => ['text','email','tel'].includes(n.type) && visible(n) && fields.indexOf(n) < fields.indexOf(pw)).at(-1);
  return { username: (user?.value || '').slice(0, 320), password: pw.value };
}
function fillLogin(origin, username, password) {
  if (location.origin !== origin || location.protocol !== 'https:') return false;
  const visible = n => n.getClientRects().length && !n.disabled && !n.readOnly;
  const pw = [...document.querySelectorAll('input[type="password"]')].find(n => visible(n) && n.autocomplete !== 'new-password');
  if (!pw) return false;
  if (pw.form && new URL(pw.form.action || location.href, location.href).origin !== origin) return false;
  const fields = [...(pw.form || document).querySelectorAll('input')];
  const user = fields.find(n => n.autocomplete === 'username' && visible(n)) || fields.filter(n => ['text','email','tel'].includes(n.type) && visible(n) && fields.indexOf(n) < fields.indexOf(pw)).at(-1);
  if ((pw.value && pw.value !== password) || (user?.value && user.value !== username)) return false;
  const set = (n, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, v);n.dispatchEvent(new Event('input', { bubbles: true }));n.dispatchEvent(new Event('change', { bubbles: true })); };
  if (user) set(user, username);set(pw, password);return true;
}
module.exports = { collectLoginScript: `(${collectLogin.toString()})()`, fillLoginScript: entry => `(${fillLogin.toString()})(${JSON.stringify(entry.origin)},${JSON.stringify(entry.username)},${JSON.stringify(entry.password)})` };
