'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDefaultState,sanitizeState,nextSpaceName}=require('../lib/model.cjs');
const {popupTarget}=require('../lib/popup-policy.cjs');
const brand=require('../renderer/space-brand.js');
test('a fresh profile starts with exactly one starting orbit',()=>{const s=createDefaultState();assert.equal(s.spaces.length,1);assert.equal(s.spaces[0].name,'시작의 궤도');assert.equal(s.tabs.length,1);assert.equal(s.tabs[0].spaceId,s.activeSpaceId);});
test('legacy labels migrate without deleting space IDs, tabs or custom names',()=>{
  const source={spaces:[{id:'personal',name:'개인',color:'#102030'},{id:'work',name:'업무',color:'#405060'},{id:'custom',name:'내 이름',color:'#aabbcc'}],tabs:[{id:'a',spaceId:'personal',url:'https://example.org/'},{id:'b',spaceId:'work',url:'https://example.net/'}],activeSpaceId:'work',activeTabId:'b'};
  const clean=sanitizeState(source);assert.deepEqual(clean.spaces.map(s=>s.name),['시작의 궤도','궤도 - 1','내 이름']);assert.deepEqual(clean.spaces.map(s=>s.id),source.spaces.map(s=>s.id));assert.equal(clean.activeSpaceId,'work');assert.equal(clean.tabs.find(t=>t.id==='b').url,'https://example.net/');assert.equal(clean.spaces[0].color,'#102030');
  assert.equal(sanitizeState({...source,spaces:[{id:'personal',name:'내 취향'}]}).spaces[0].name,'내 취향');
});
test('automatic names select the first free orbit number',()=>{for(const names of [[],['시작의 궤도'],['궤도 - 1'],['궤도 - 1','궤도 - 3']]){const spaces=names.map(name=>({name}));assert.equal(nextSpaceName(spaces),brand.nextName(spaces));}assert.equal(nextSpaceName([{name:'궤도 - 1'},{name:'궤도 - 3'}]),'궤도 - 2');});
test('Orbit geometry stays fixed while theme colours change safely',()=>{
  const green=brand.logo('#c8d8cb'),pink=brand.logo('#e1cdd6'),blue=brand.logo('#bfcde1');assert.notEqual(green,pink);assert.notEqual(pink,blue);
  for(const value of [green,pink,blue,brand.logo('#000000'),brand.logo('#ffffff')]) {const svg=decodeURIComponent(value.split(',')[1]);assert.ok(svg.includes('M168.7 69.1a72 72'));assert.doesNotMatch(svg,/script|href|NaN|undefined/);}
  assert.equal(brand.logo('<script>'),green);
});
test('only initial empty popup documents and web addresses are allowed',()=>{assert.equal(popupTarget(''),'about:blank');assert.equal(popupTarget('about:blank'),'about:blank');assert.equal(popupTarget('https://accounts.google.com/'),'https://accounts.google.com/');for(const url of ['file:///C:/Windows','javascript:alert(1)','data:text/html,hi','about:config','about:blank#unsafe','https://user:secret@example.org/'])assert.equal(popupTarget(url),null,url);});
