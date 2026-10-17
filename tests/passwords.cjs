'use strict';
// Disposable profile, synthetic logins and intercepted .test HTTPS pages only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const appDir = path.resolve(__dirname,'..');
const runDir = path.resolve(appDir,'../../work',`passwords-${Date.now()}`), profile = path.join(runDir,'profile');
fs.mkdirSync(profile,{recursive:true});require('./legacy-profile.cjs')(profile);
const env={...process.env,ORBIT_TEST_MODE:'1',ORBIT_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
const results=[];let app,ui,wcId;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,accept=Boolean){let v;for(let n=0;n<100;n++){v=await fn();if(accept(v))return v;await sleep(70);}throw Error('Timed out: '+JSON.stringify(v));}
const action=(name,payload={})=>ui.evaluate(({name,payload})=>window.browser.action(name,payload),{name,payload});
const script=code=>app.evaluate(({webContents},{id,code})=>webContents.fromId(id).executeJavaScript(code,true),{id:wcId,code});
async function nav(url){await action('navigate',{input:url});wcId=await until(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL()===url&&!w.isLoading())?.id,url));}
async function capture(file){await ui.evaluate(async()=>{if(typeof hideToast==='function')hideToast();await Promise.allSettled(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});await ui.screenshot({path:file,scale:'css'});}
async function check(name,fn){await fn();results.push(name);console.log('PASS '+name);}
async function setup(){await app.evaluate(({session,dialog})=>{
  globalThis.testDialogResponse=1;globalThis.testPasswordPrompts=0;
  dialog.showMessageBox=async(_win,options)=>{if(options.title==='Orbit 비밀번호 관리자')globalThis.testPasswordPrompts++;return{response:globalThis.testDialogResponse};};
  const html='<!doctype html><title>Login fixture</title><form id="form"><label>Account<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Log in</button></form><script>document.querySelector("form").addEventListener("submit",e=>e.preventDefault())</script>';
  for(const id of ['personal','work'])session.fromPartition('persist:orbit-'+id).protocol.handle('https',request=>new Response(html,{headers:{'Content-Type':'text/html'}}));
});}
(async()=>{try{
  app=await electron.launch({args:[appDir],env,timeout:30000});ui=await app.firstWindow();await ui.waitForFunction(()=>window.browser&&document.querySelector('.pane'));await setup();
  await check('legacy spaces use theme-specific Orbit ribbon marks',async()=>{
    const data=await ui.locator('#spaceDots img').evaluateAll(nodes=>nodes.map(n=>({src:n.getAttribute('src'),loaded:n.complete&&n.naturalWidth>0})));
    assert.equal(data.length,2);assert.ok(data.every(n=>n.loaded));assert.notEqual(data[0].src,data[1].src);
    await capture(path.resolve(appDir,'../orbit-spaces-v4.png'));
  });
  await check('HTTPS login save uses real Windows encryption and metadata excludes secrets',async()=>{
    await nav('https://login.orbit.test/');await script('document.querySelector("[name=username]").value="fixture@example.test";document.querySelector("[name=password]").value="synthetic-secret-942"');
    await action('passwordSave');const list=await action('passwordList');assert.equal(list.available,true);assert.equal(list.entries.length,1);assert.equal(list.entries[0].username,'fixture@example.test');assert.ok(!JSON.stringify(list).includes('synthetic-secret'));
    const bytes=fs.readFileSync(path.join(profile,'orbit-passwords.bin'));assert.equal(bytes.includes(Buffer.from('synthetic-secret')),false);assert.equal(bytes.includes(Buffer.from('fixture@example.test')),false);
  });
  await check('saved login automatically fills only the same HTTPS origin',async()=>{
    await nav('https://login.orbit.test/again');await until(()=>script('document.querySelector("[name=password]").value'),v=>v==='synthetic-secret-942');
    assert.equal(await script('document.querySelector("[name=username]").value'),'fixture@example.test');
    await nav('https://different.orbit.test/');assert.equal(await script('document.querySelector("[name=password]").value'),'');
    const list=await action('passwordList');await assert.rejects(()=>action('passwordFill',{id:list.entries[0].id}));
  });
  await check('work space cannot read or fill personal credentials',async()=>{
    await action('switchSpace',{id:'work'});await nav('https://login.orbit.test/work');assert.deepEqual((await action('passwordList')).entries,[]);assert.equal(await script('document.querySelector("[name=password]").value'),'');
    await action('switchSpace',{id:'personal'});
  });
  await check('manager is visible and never renders password plaintext',async()=>{
    await nav('https://login.orbit.test/manager');await ui.locator('#passwordButton').click();await ui.getByText('fixture@example.test',{exact:true}).waitFor();assert.ok(!(await ui.locator('#overlay').innerText()).includes('synthetic-secret'));
    await capture(path.resolve(appDir,'../orbit-password-manager-v4.png'));await ui.evaluate(()=>closeOverlay());
  });
  await check('trusted login form submit offers storage through sandboxed preload',async()=>{
    await nav('https://submit.orbit.test/');
    // Chromium generates a trusted submit when requestSubmit is called; no UI-facing bridge is exposed.
    assert.equal(await script('typeof window.browser'),'undefined');
    await script('document.querySelector("[name=username]").value="submitted@example.test";document.querySelector("[name=password]").value="submit-synthetic-372";document.querySelector("form").requestSubmit()');
    await until(()=>action('passwordList'),v=>v.entries.some(e=>e.username==='submitted@example.test'));
  });
  await check('cancelled saving does not add a credential',async()=>{
    await app.evaluate(()=>{globalThis.testDialogResponse=0;});await script('document.querySelector("[name=username]").value="cancelled@example.test";document.querySelector("[name=password]").value="cancelled-synthetic"');await action('passwordSave');assert.ok(!(await action('passwordList')).entries.some(e=>e.username==='cancelled@example.test'));await app.evaluate(()=>{globalThis.testDialogResponse=1;});
  });
  await check('saved data survives restart and deletion removes only its selected account',async()=>{
    await action('newTab');await app.close();app=await electron.launch({args:[appDir],env,timeout:30000});ui=await app.firstWindow();await ui.waitForFunction(()=>window.browser&&document.querySelector('.pane'));await setup();const list=await action('passwordList');assert.equal(list.entries.length,2);await action('passwordDelete',{id:list.entries[0].id});assert.equal((await action('passwordList')).entries.length,1);
  });
  await check('incognito cannot list or save passwords',async()=>{
    const next=app.waitForEvent('window');await action('newIncognitoWindow');const privateUI=await next;await privateUI.waitForFunction(()=>window.browser);const result=await privateUI.evaluate(()=>window.browser.action('passwordList'));assert.equal(result.available,false);assert.deepEqual(result.entries,[]);await assert.rejects(()=>privateUI.evaluate(()=>window.browser.action('passwordSave')));
  });
  console.log(results.length+' password and space checks passed.');
}catch(error){console.error(error.stack);process.exitCode=1;if(ui&&!ui.isClosed())await ui.screenshot({path:path.join(runDir,'failure.png')}).catch(()=>{});}finally{if(app)await app.close().catch(()=>app.process().kill());fs.writeFileSync(path.join(runDir,'results.json'),JSON.stringify({results},null,2));}})();
