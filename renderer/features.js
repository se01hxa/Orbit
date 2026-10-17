'use strict';

function menuRow(label, symbol, handler, shortcut, action) {
  const row=button('menu-row',label,null,handler);row.setAttribute('role','menuitem');
  if(action)row.dataset.action=action;
  row.append(icon(symbol),el('span','menu-row-label',label));
  if(shortcut)row.append(el('kbd','',shortcut));
  return row;
}
async function openAppMenu(){
  if(!state)return;const epoch=await openOverlay('menu');if(epoch!==overlayEpoch||overlayKind!=='menu')return;
  const menu=el('section','app-menu');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Orbit 메뉴');
  const heading=el('div','app-menu-brand');heading.append(el('span','orbit-mark'),el('strong','','Orbit'),el('span','version-pill',state.incognito?'시크릿':'BETA'));
  menu.append(heading);
  const direct=(name,payload={})=>async()=>{await closeOverlay();await send(name,payload);};
  const items=[
    ['업데이트 확인','update',direct('checkUpdates'),'수동 업데이트','updates'],
    ['다른 브라우저에서 가져오기','import',direct('importBookmarks'),'북마크','import'],
    null,
    ['새 탭','plus',async()=>{await closeOverlay();await newTab();},'Ctrl T','new-tab'],
    ['새 창','newWindow',direct('newWindow'),'Ctrl N','new-window'],
    ['새 시크릿 창','incognito',direct('newIncognitoWindow'),'Ctrl Shift N','incognito'],
    null,
    ['스페이스','spaces',openSpaces,'›','spaces'],
    ['탭과 폴더','tabs',openTabLibrary,'›','tabs'],
    ['즐겨찾기','star',openFavorites,'›','favorites'],
    ['닫은 탭 보관함','archive',openArchives,'Ctrl Shift T','archives'],
    null,
    ['확장 프로그램','extension',openExtensions,'›','extensions'],
    ['개발자 도구','code',direct('devTools'),'F12','developer'],
    ['내 Orbit 카드','card',openProfileCard,'›','card'],
    ['도움말과 단축키','help',openHelp,'›','help'],
    ['검색·방문 기록','clock',openHistory,'','history'],
    ['비밀번호 관리자','lock',openPasswords,'','passwords'],
    ['설정','settings',openSettings,'Ctrl ,','settings'],
    null,
    ['페이지에서 찾기','search',async()=>{await closeOverlay();openFind();},'Ctrl F','find'],
    ['인쇄','print',direct('print'),'Ctrl P','print'],
    ['PDF로 저장','save',direct('savePDF'),'Ctrl Shift P','pdf'],
    ['사이드바 '+(state.sidebarCollapsed?'펼치기':'접기'),'sidebar',direct('toggleSidebar'),'Ctrl B','sidebar'],
    ['창 닫기','close',direct('closeWindow'),'Alt F4','close']
  ];
  for(const item of items)menu.append(item?menuRow(...item):el('div','menu-divider'));
  const footer=el('div','menu-zoom');footer.append(el('span','','페이지 크기'));
  footer.append(button('icon-button','페이지 축소','zoomOut',()=>send('zoom',{delta:-.1})));
  const reset=button('zoom-reset','페이지 크기 초기화',null,()=>send('zoom',{reset:true}));reset.id='menuZoomReset';reset.textContent=Math.round((state.zoomFactor||1)*100)+'%';
  footer.append(reset,button('icon-button','페이지 확대','zoomIn',()=>send('zoom',{delta:.1})));menu.append(footer);
  $('overlay').append(menu);
  const controls=[...menu.querySelectorAll('[role="menuitem"]')];
  menu.addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();
    let index=controls.indexOf(document.activeElement);index=event.key==='Home'?0:event.key==='End'?controls.length-1:(index+(event.key==='ArrowDown'?1:-1)+controls.length)%controls.length;controls[index]?.focus();
  });controls[0]?.focus();
}

function renderFeatureUI(){
  $('app').classList.toggle('incognito-mode',!!state.incognito);
  const tab=activeTab(),favorite=(state.favorites||[]).some(item=>item.url===tab?.url);
  document.title=state.incognito?'Orbit — 시크릿':isHome(tab)?'Orbit':(tab.title||siteName(tab.url))+' — Orbit';
  $('favoriteButton').disabled=isHome(tab);$('favoriteButton').classList.toggle('active',favorite);
  $('favoriteButton').setAttribute('aria-label',favorite?'즐겨찾기에서 제거':'즐겨찾기에 추가');
  replaceIcon($('favoriteButton'),'star');$('favoriteButton').setAttribute('aria-pressed',String(favorite));
  if($('menuZoomReset'))$('menuZoomReset').textContent=Math.round((state.zoomFactor||1)*100)+'%';
  if($('findCount'))$('findCount').textContent=(state.findResult?.activeMatchOrdinal||0)+'/'+(state.findResult?.matches||0);
  if(overlayKind==='archives')updateArchives();
  if(overlayKind==='extensions')updateExtensions();
}
function renderFavorites(){
  const favorites=state.favorites||[];$('favoritesSection').hidden=!favorites.length;
  reconcile($('favoritesGrid'),favorites,item=>item.id,item=>{
    const n=button('favorite-tile',item.title,null,()=>send('openFavorite',{id:item.id}));
    n.dataset.favoriteId=item.id;n.addEventListener('contextmenu',event=>{event.preventDefault();openFavorites();});return n;
  },(n,item)=>{
    n.title=item.title||siteName(item.url);n.setAttribute('aria-label',n.title);
    const key=item.url+'|'+(item.faviconURL||'');if(n.dataset.visual!==key){n.replaceChildren(favicon(item));n.dataset.visual=key;}
  },true);
}
function renderFolders(tabs,makeTabNode,updateTabNode){
  const folders=(state.folders||[]).filter(folder=>folder.spaceId===state.activeSpaceId);
  reconcile($('folderList'),folders,folder=>folder.id,folder=>{
    const group=el('section','tab-folder');group.dataset.folderId=folder.id;
    const head=button('folder-heading',folder.name,null,()=>send('toggleFolder',{id:folder.id}));
    const arrow=el('span','folder-chevron'),name=el('span','folder-name'),count=el('span','folder-count');
    head.append(arrow,icon('folder'),name,count);head.addEventListener('contextmenu',event=>{event.preventDefault();openFolderEditor(folder.id);});
    const list=el('div','folder-tabs');group.append(head,list);group._parts={head,arrow,name,count,list};
    for(const type of ['dragenter','dragover'])head.addEventListener(type,event=>{if(event.dataTransfer?.types.includes('application/x-orbit-tab')){event.preventDefault();head.classList.add('drop-target');}});
    head.addEventListener('dragleave',()=>head.classList.remove('drop-target'));
    head.addEventListener('drop',async event=>{event.preventDefault();head.classList.remove('drop-target');const id=event.dataTransfer.getData('application/x-orbit-tab');if(id)await send('moveTab',{id,folderId:folder.id});});return group;
  },(group,folder)=>{
    const p=group._parts,children=tabs.filter(tab=>tab.folderId===folder.id);
    p.head.setAttribute('aria-expanded',String(!folder.collapsed));p.head.setAttribute('aria-label',folder.name+' 폴더');
    replaceIcon(p.arrow,folder.collapsed?'chevronRight':'chevronDown');p.name.textContent=folder.name;p.count.textContent=children.length||'';p.list.hidden=folder.collapsed;
    reconcile(p.list,children,tab=>tab.id,tab=>makeTabNode(tab,false),updateTabNode,true);
  });
}
async function openFolderEditor(id){
  const folder=(state.folders||[]).find(entry=>entry.id===id);
  const epoch=await openOverlay('folder-editor');if(epoch!==overlayEpoch)return;
  const {body}=dialog(folder?'폴더 관리':'새 폴더','함께 보고 싶은 탭을 한곳에 모아보세요.');
  const label=el('label','field-label','폴더 이름'),input=el('input','text-input');input.id='folderNameInput';input.value=folder?.name||'';input.maxLength=60;input.placeholder='예: 매일 보는 사이트';label.htmlFor=input.id;body.append(label,input);
  const actions=el('div','dialog-actions');
  if(folder){const remove=button('secondary-button','폴더 삭제','trash',async()=>{await send('deleteFolder',{id});await closeOverlay();});remove.append(document.createTextNode('폴더만 삭제'));actions.append(remove);}
  const save=button('primary-button','폴더 저장',null,async()=>{if(!input.value.trim()){input.focus();return;}await send(folder?'renameFolder':'createFolder',folder?{id,name:input.value}:{name:input.value});await closeOverlay();});save.textContent=folder?'저장':'만들기';actions.append(save);body.append(actions);input.addEventListener('keydown',event=>{if(event.key==='Enter')save.click();});input.focus();
}
async function openTabLibrary(){
  const epoch=await openOverlay('tab-library');if(epoch!==overlayEpoch)return;
  const {body}=dialog('탭과 폴더','모든 스페이스의 탭을 찾아 이동하고 정리하세요.','feature-dialog');
  const tools=el('div','library-tools');
  const add=button('secondary-button','새 폴더','folderPlus',()=>openFolderEditor());add.append(document.createTextNode('새 폴더'));
  const archive=button('secondary-button','고정되지 않은 탭 모두 보관','archive',async()=>{await closeOverlay();await send('archiveAll');});archive.append(document.createTextNode('일반 탭 보관'));tools.append(add,archive);body.append(tools);
  const input=el('input','text-input library-search');input.placeholder='탭 제목 또는 주소로 검색';input.setAttribute('aria-label','탭 검색');body.append(input);
  const list=el('div','library-list');body.append(list);
  const draw=()=>{
    const query=input.value.toLowerCase();list.replaceChildren();
    for(const tab of state.tabs.filter(entry=>(entry.title+' '+entry.url).toLowerCase().includes(query))){
      const row=el('div','library-row'),open=button('library-open',tab.title,null,async()=>{await closeOverlay();if(tab.spaceId!==state.activeSpaceId)await send('switchSpace',{id:tab.spaceId});await send('activateTab',{id:tab.id});});
      const text=el('span','library-copy');text.append(el('strong','',tab.title||'새 탭'),el('small','',(state.spaces.find(space=>space.id===tab.spaceId)?.name||'')+' · '+siteName(tab.url)));open.append(favicon(tab),text);
      row.append(open,button('icon-button','탭 관리','more',()=>openTabMenu(tab)));list.append(row);
    }
  };input.addEventListener('input',draw);draw();input.focus();
}
async function openFavorites(){
  const epoch=await openOverlay('favorites');if(epoch!==overlayEpoch)return;
  const {body}=dialog('즐겨찾기','스페이스를 바꾸어도 자주 찾는 사이트를 가까이.');
  if(!(state.favorites||[]).length){body.append(el('p','settings-description','웹페이지에서 상단 별 버튼이나 Ctrl + D로 즐겨찾기에 추가하세요.'));return;}
  for(const item of state.favorites){
    const row=el('div','library-row'),open=button('library-open',item.title,null,async()=>{await closeOverlay();await send('openFavorite',{id:item.id});});
    const copy=el('span','library-copy');copy.append(el('strong','',item.title),el('small','',siteName(item.url)));open.append(favicon(item),copy);
    const remove=button('icon-button','즐겨찾기 제거','close',async()=>{await send('removeFavorite',{id:item.id});await openFavorites();});row.append(open,remove);body.append(row);
  }
}
async function openArchives(){
  const epoch=await openOverlay('archives');if(epoch!==overlayEpoch)return;
  const {body}=dialog('닫은 탭 보관함',state.incognito?'시크릿 창의 닫은 탭은 기록하지 않습니다.':'최근 닫은 탭을 다시 이어서 보세요.','feature-dialog');
  const list=el('div','library-list');list.id='archiveList';body.append(list);updateArchives();
}
function updateArchives(){
  const list=$('archiveList');if(!list)return;list.replaceChildren();
  if(!(state.archivedTabs||[]).length){list.append(el('p','settings-description','보관된 탭이 없습니다.'));return;}
  for(const tab of state.archivedTabs){
    const row=button('library-row library-open',tab.title,null,async()=>{await closeOverlay();await send('reopenTab',{id:tab.id});});
    const copy=el('span','library-copy');copy.append(el('strong','',tab.title),el('small','',siteName(tab.url)));row.append(favicon(tab),copy,icon('restoreTab'));list.append(row);
  }
  const clear=button('text-button','보관함 비우기',null,()=>send('clearArchive'));clear.textContent='보관함 비우기';list.append(clear);
}
async function openExtensions(){
  const epoch=await openOverlay('extensions');if(epoch!==overlayEpoch)return;
  const {body}=dialog('확장 프로그램','현재 스페이스에서 사용할 확장 프로그램을 관리합니다.','feature-dialog');
  body.append(el('p','settings-description','manifest.json이 있는 폴더나 그 위의 프로젝트 폴더를 선택하세요. Discord Custom RPC는 Orbit의 탭·미디어 정보를 전달하는 호환 연결을 지원하며 재시작 후에도 유지됩니다. 다른 확장은 Electron이 지원하는 일부 Chrome 확장 API 범위에서 동작합니다.'));
  const add=button('secondary-button extension-add','확장 프로그램 폴더 추가','plus',()=>send('loadExtension'));add.append(document.createTextNode('폴더에서 추가'));add.disabled=state.incognito;body.append(add);
  const list=el('div','library-list');list.id='extensionList';body.append(list);updateExtensions();
}
function updateExtensions(){
  const list=$('extensionList');if(!list)return;
  const entries=state.extensions||[];
  if(!entries.length){list.replaceChildren(el('p','settings-description',state.incognito?'시크릿 창에서는 확장 프로그램을 사용하지 않습니다.':'추가한 확장 프로그램이 없습니다.'));return;}
  list.querySelector('.settings-description')?.remove();
  reconcile(list,entries,entry=>entry.id,entry=>{
    const row=el('div','library-row'),copy=el('span','library-copy'),name=el('strong'),detail=el('small'),mark=el('span','extension-mark');
    mark.append(entry.compatibility==='orbit-rpc'?el('span','orbit-mark'):icon('extension'));copy.append(name,detail);
    row.append(mark,copy,button('icon-button','확장 프로그램 열기','external',()=>send('showExtension',{id:entry.id})),button('icon-button','확장 프로그램 제거','trash',()=>send('removeExtension',{id:entry.id})));row._parts={name,detail};return row;
  },(row,entry)=>{
    row._parts.name.textContent=entry.name;
    row._parts.detail.textContent=entry.compatibility==='orbit-rpc'?'Orbit 호환 연결 · '+(entry.connection?.connected?'RPC 앱 연결됨':'RPC 앱 연결 대기')+' · '+entry.version:entry.version;
  });
}
function openFind(){
  $('findToolbar').hidden=false;$('findInput').focus();$('findInput').select();
  if($('findInput').value)send('find',{query:$('findInput').value});
}
async function closeFind(){
  $('findToolbar').hidden=true;await send('stopFind');
}
async function openHelp(){
  const epoch=await openOverlay('help');if(epoch!==overlayEpoch)return;
  const {body}=dialog('Orbit 사용하기','생각의 흐름을 끊지 않는 작은 단축키들.','feature-dialog');
  for(const [label,keys] of [['주소·탭 검색','Ctrl L / Ctrl T'],['새 창 / 새 시크릿 창','Ctrl N / Ctrl Shift N'],['즐겨찾기 추가·제거','Ctrl D'],['닫은 탭 다시 열기','Ctrl Shift T'],['페이지에서 찾기','Ctrl F'],['확대 / 축소 / 초기화','Ctrl + / Ctrl - / Ctrl 0'],['인쇄 / PDF 저장','Ctrl P / Ctrl Shift P'],['사이드바 접기·펼치기','Ctrl B'],['설정 / 다운로드','Ctrl , / Ctrl J'],['개발자 도구','F12']]){
    const row=el('div','help-shortcut');row.append(el('span','',label),el('kbd','',keys));body.append(row);
  }
  body.append(el('p','settings-footnote','북마크 가져오기는 다른 브라우저에서 내보낸 HTML 파일이나 Chromium Bookmarks JSON을 사용합니다. 로그인·암호는 가져오지 않습니다. 시크릿 창도 방문 사이트·네트워크 운영자로부터 활동을 숨기는 기능은 아닙니다.'));
}

async function openProfileCard(){
  if(!state)return;const epoch=await openOverlay('card');if(epoch!==overlayEpoch)return;
  const {body}=dialog('내 Orbit 카드','이 기기에 저장되는 나만의 작은 프로필.','card-dialog');
  const layout=el('div','card-layout'),poster=el('div','card-poster'),canvas=document.createElement('canvas');canvas.id='orbitCardCanvas';canvas.width=800;canvas.height=1180;canvas.className='orbit-profile-card';canvas.setAttribute('aria-label','나의 Orbit 프로필 카드');poster.append(canvas);
  const controls=el('div','card-controls'),label=el('label','field-label','표시 이름'),name=el('input','text-input'),taglabel=el('label','field-label','한 줄 소개'),tagline=el('input','text-input');
  name.id='cardDisplayName';name.maxLength=40;name.value=state.profile?.displayName||'나';label.htmlFor=name.id;
  tagline.id='cardTagline';tagline.maxLength=80;tagline.value=state.profile?.tagline||'나만의 궤도';taglabel.htmlFor=tagline.id;
  const apply=async()=>{await send('profile',{displayName:name.value,tagline:tagline.value});drawProfileCard(canvas,state.profile);};
  const save=button('primary-button','카드 PNG 저장','save',async()=>{await apply();await send('saveCard',{dataURL:canvas.toDataURL('image/png')});});save.append(document.createTextNode('이미지 저장'));
  const copy=button('secondary-button','카드 이미지 복사','copy',async()=>{await apply();await send('copyCard',{dataURL:canvas.toDataURL('image/png')});});copy.append(document.createTextNode('복사'));
  const shuffle=button('secondary-button','카드 모양 바꾸기','shuffle',async()=>{await send('profile',{cardSeed:((state.profile?.cardSeed||0)+1)%1000000});drawProfileCard(canvas,state.profile);});shuffle.append(document.createTextNode('다른 궤도'));
  const actions=el('div','card-actions');actions.append(save,copy,shuffle);controls.append(label,name,taglabel,tagline,actions,el('p','settings-description','카드는 온라인 계정이나 공유 링크를 만들지 않습니다. 저장하거나 복사해 직접 공유할 수 있어요.'));
  for(const input of [name,tagline])input.addEventListener('input',()=>drawProfileCard(canvas,{...state.profile,displayName:name.value,tagline:tagline.value}));
  name.addEventListener('change',apply);tagline.addEventListener('change',apply);layout.append(poster,controls);body.append(layout);drawProfileCard(canvas,state.profile);
}
function drawProfileCard(canvas,profile={}){
  const ctx=canvas.getContext('2d'),seed=profile.cardSeed||0,w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#fffceb';ctx.beginPath();ctx.roundRect(0,0,w,h,28);ctx.fill();
  ctx.save();ctx.beginPath();ctx.roundRect(52,52,696,650,14);ctx.clip();
  const palette=[['#a2cefa','#8270d7','#f5a293'],['#90ded4','#446caf','#dbbbec'],['#f5c4a5','#e890b7','#4b70c8'],['#bfc5f5','#6854a5','#b1dcf0']][seed%4];
  const bg=ctx.createLinearGradient(52,52,748,702);bg.addColorStop(0,palette[0]);bg.addColorStop(.5,palette[1]);bg.addColorStop(1,palette[2]);ctx.fillStyle=bg;ctx.fillRect(52,52,696,650);
  ctx.globalAlpha=.45;ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(180+(seed%5)*48,100,300,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
  const ring=ctx.createLinearGradient(150,100,650,650);ring.addColorStop(0,'#fff9f3');ring.addColorStop(.38,'#ffadac');ring.addColorStop(.7,'#8a8dec');ring.addColorStop(1,'#273987');
  ctx.strokeStyle=ring;ctx.lineWidth=116;ctx.lineCap='round';ctx.beginPath();ctx.ellipse(400,375,194,221,-.42,Math.PI*.16,Math.PI*1.98);ctx.stroke();
  ctx.strokeStyle='rgba(255,255,255,.6)';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(400,375,193,222,-.42,Math.PI*.16,Math.PI*1.98);ctx.stroke();ctx.restore();
  let size=66;ctx.fillStyle='#24384c';const name=profile.displayName||'나';do{ctx.font=`600 ${size}px "Segoe UI","Malgun Gothic",sans-serif`;if(ctx.measureText(name).width<690)break;size-=2;}while(size>22);
  ctx.fillText(name,52,809);ctx.font='26px "Segoe UI","Malgun Gothic",sans-serif';ctx.fillStyle='#5e6d7a';const tagline=profile.tagline||'나만의 궤도';ctx.fillText(tagline.length>36?tagline.slice(0,35)+'…':tagline,52,859,690);
  ctx.strokeStyle='#33485a';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(52,1073,340,42,7);ctx.stroke();ctx.fillStyle='#33485a';ctx.font='600 21px "Segoe UI",sans-serif';ctx.fillText('ORBIT',67,1101);
  const joined=new Date(profile.joinedAt||Date.now());ctx.font='21px "Segoe UI",sans-serif';ctx.fillText(joined.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Seoul'}),165,1101);ctx.font='600 25px "Segoe UI",sans-serif';ctx.textAlign='right';ctx.fillText('YOUR OWN',748,1090);ctx.fillText('ORBIT.',748,1121);ctx.textAlign='left';
}

document.addEventListener('DOMContentLoaded',()=>{
  $('moreButton').addEventListener('click',openAppMenu);
  $('favoriteButton').addEventListener('click',()=>{if(activeTab())send('favoriteTab',{id:state.activeTabId});});
  let findTimer;
  $('findInput').addEventListener('input',()=>{clearTimeout(findTimer);findTimer=setTimeout(()=>send('find',{query:$('findInput').value}),120);});
  $('findInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();send('find',{query:$('findInput').value,forward:!event.shiftKey,findNext:true});}else if(event.key==='Escape'){event.preventDefault();closeFind();}});
  $('findPrevious').addEventListener('click',()=>send('find',{query:$('findInput').value,forward:false,findNext:true}));$('findNext').addEventListener('click',()=>send('find',{query:$('findInput').value,forward:true,findNext:true}));$('findClose').addEventListener('click',closeFind);
});
async function openPasswords(){
  if(!state)return;
  const epoch=await openOverlay('passwords');if(overlayKind!=='passwords'||epoch!==overlayEpoch)return;
  const {body}=dialog('비밀번호 관리자','현재 스페이스의 로그인 정보를 이 기기에 보관합니다.');body.classList.add('password-manager');
  if(state.incognito){body.append(el('p','settings-description','시크릿 창에서는 비밀번호 저장소를 사용하지 않습니다.'));return;}
  const result=await send('passwordList');if(overlayKind!=='passwords'||epoch!==overlayEpoch)return;
  if(!result?.available){body.append(el('p','settings-description','Windows 암호화를 사용할 수 없어 저장소를 열지 않았습니다.'));return;}
  const save=button('primary-button','현재 페이지 로그인 저장','lock',async()=>{await closeOverlay();await send('passwordSave');});save.append(document.createTextNode('현재 페이지 로그인 저장'));body.append(save);
  const search=el('input','text-input');search.placeholder='사이트 또는 아이디 검색';search.setAttribute('aria-label','저장된 로그인 검색');body.append(search);
  const list=el('div','password-list');body.append(list);
  const refresh=()=>{list.replaceChildren();const query=search.value.toLowerCase();const entries=result.entries.filter(r=>(r.origin+' '+r.username).toLowerCase().includes(query));
    if(!entries.length){list.append(el('p','settings-description',query?'일치하는 계정이 없습니다.':'저장된 계정이 없습니다. HTTPS 로그인 화면에서 로그인하면 저장을 제안합니다.'));return;}
    for(const entry of entries){const row=el('div','library-row password-row'),copy=el('div','library-copy');copy.append(el('strong','',new URL(entry.origin).host),el('small','',entry.username||'아이디 없음'));row.append(icon('lock'),copy);
      const fill=button('secondary-button','로그인 정보 입력',null,async()=>{await closeOverlay();await send('passwordFill',{id:entry.id});});fill.textContent='입력';fill.disabled=result.origin!==entry.origin;row.append(fill,button('icon-button','저장된 로그인 삭제','trash',async()=>{await send('passwordDelete',{id:entry.id});await openPasswords();}));list.append(row);}
  };search.addEventListener('input',refresh);refresh();body.append(el('p','settings-footnote','저장 계정은 스페이스별로 분리됩니다. 같은 HTTPS 사이트에 저장 계정이 하나면 빈 로그인 폼에 자동 입력합니다. 비밀번호 원문은 관리 화면·클립보드에 표시하지 않습니다.'));
}

async function openHistory(){if(!state)return;const epoch=await openOverlay('history');if(overlayKind!=='history'||epoch!==overlayEpoch)return;const {body}=dialog('검색·방문 기록','현재 스페이스에 저장한 최근 기록입니다.');if(state.incognito){body.append(el('p','settings-description','시크릿 창에서는 기록을 저장하거나 표시하지 않습니다.'));return;}const rows=(state.history||[]).filter(r=>r.spaceId===state.activeSpaceId);const clear=button('secondary-button','현재 스페이스 기록 모두 삭제','trash',async()=>{await send('clearHistory');await openHistory();});clear.append(document.createTextNode('모두 삭제'));body.append(clear);const list=el('div','password-list');if(!rows.length)list.append(el('p','settings-description','저장된 기록이 없습니다.'));for(const entry of rows){const row=el('div','library-row'),open=button('library-open',entry.title,null,async()=>{await closeOverlay();await send('navigate',{input:entry.value});});const copy=el('span','library-copy');copy.append(el('strong','',entry.title||entry.value),el('small','',(entry.kind==='search'?'검색 · ':'방문 · ')+entry.value));open.append(icon(entry.kind==='search'?'search':'clock'),copy);row.append(open,button('icon-button','기록 삭제','trash',async()=>{await send('deleteHistory',{kind:entry.kind,value:entry.value});await openHistory();}));list.append(row);}body.append(list);}
