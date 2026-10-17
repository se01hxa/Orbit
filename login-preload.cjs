'use strict';
const { ipcRenderer } = require('electron');
if (process.isMainFrame) {
  let readySent = false, lastSubmit = 0;
  const inspect = () => {
    if (readySent || location.protocol !== 'https:') return;
    const pw = [...document.querySelectorAll('input[type="password"]')].find(n => n.getClientRects().length && n.autocomplete !== 'new-password');
    if (pw) { readySent = true;ipcRenderer.send('orbit:login-ready'); }
  };
  document.addEventListener('DOMContentLoaded', () => { inspect();const observer = new MutationObserver(inspect);observer.observe(document.documentElement, { childList: true, subtree: true });setTimeout(() => observer.disconnect(), 30000); }, { once: true });
  document.addEventListener('submit', event => {
    if (!event.isTrusted || location.protocol !== 'https:' || Date.now() - lastSubmit < 3000) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || new URL(form.action || location.href, location.href).origin !== location.origin) return;
    const pw = [...form.querySelectorAll('input[type="password"]')].find(n => n.value && n.getClientRects().length);
    if (!pw || pw.value.length > 2048) return;
    const fields = [...form.querySelectorAll('input')];
    const user = fields.find(n => n.autocomplete === 'username') || fields.filter(n => ['text','email','tel'].includes(n.type) && fields.indexOf(n) < fields.indexOf(pw)).at(-1);
    lastSubmit = Date.now();ipcRenderer.send('orbit:login-save', { username: (user?.value || '').slice(0, 320), password: pw.value });
  }, true);
}
