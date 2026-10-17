'use strict';
// Explicit upgrade fixture for suites that exercise two pre-existing spaces.
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { createDefaultState } = require('../lib/model.cjs');
module.exports = function seedLegacyProfile(profile) {
  const file=path.join(profile,'orbit-state.json');if(fs.existsSync(file))return;
  const state=createDefaultState();state.spaces[0].name='개인';
  state.spaces.push({id:'work',name:'업무',color:'#bfcde1'});
  state.tabs.push({id:randomUUID(),spaceId:'work',title:'새 탭',url:'orbit://newtab',pinned:false,folderId:null,faviconURL:null});
  fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(file,JSON.stringify(state));
};
