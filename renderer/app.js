'use strict';

const icons = window.OrbitIcons || {};

function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
  svg.innerHTML=icons[name] || icons.globe;
  return svg;
}
document.querySelectorAll('[data-icon]').forEach(el=>el.replaceChildren(icon(el.dataset.icon)));
const $=id=>document.getElementById(id);
const bridge=window.browser;
let state=null, overlayKind=null, toastTimer=null, lastNotice=null, paletteIndex=0, paletteResults=[], paletteTarget=null, lastCompletedIds=new Set(), downloadStateInitialized=false;
let paletteRemote=[],paletteTimer=null,paletteSuggestionEpoch=0;
let overlayEpoch=0, closingOverlay=null, overlayFocus=null, toastEpoch=0, loadTimer=null;
const motionQuery=window.matchMedia('(prefers-reduced-motion: reduce)');
const motionEase='cubic-bezier(.22,1,.36,1)';
const presets=['#c8d8cb','#d1d8e7','#e1cdd6','#e4d8c4','#cbc6de','#c7dcdc','#c7cac8'];

function el(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;}
function button(className,label,iconName,handler){const n=el('button',className);n.setAttribute('aria-label',label);n.title=label;if(iconName)n.append(icon(iconName));if(handler)n.addEventListener('click',handler);return n;}
function activeTab(){return state?.tabs.find(t=>t.id===state.activeTabId);}
function paintSpace(node,space){const color=/^#[0-9a-f]{6}$/i.test(space?.color||'')?space.color:'#c8d8cb';if(node.dataset.color===color&&node.querySelector('img'))return;node.textContent='';node.classList.add('space-symbol');node.dataset.kind='orbit';node.dataset.color=color;const img=document.createElement('img');img.src=OrbitSpaceBrand.logo(color);img.alt='';img.draggable=false;node.append(img);}
function currentSpace(){return state?.spaces.find(s=>s.id===state.activeSpaceId)||state?.spaces[0];}
function isHome(tab){return !tab||!tab.url||tab.url==='orbit://newtab'||tab.url==='orbit://newtab/';}
function siteName(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url||'새 탭';}}
function prettyUrl(tab){if(tab?.url?.startsWith('orbit://')&&!isHome(tab))return tab.url;if(isHome(tab))return '새로운 가능성을 열어보세요';try{const u=new URL(tab.url);return u.hostname.replace(/^www\./,'')+(u.pathname==='/'?'':u.pathname)+u.search;}catch{return tab.url;}}

async function send(name,payload={}){
  if(!bridge){showToast('앱을 실행하면 브라우저 기능을 사용할 수 있어요.');return null;}
  try{const next=await bridge.action(name,payload);if(next&&Array.isArray(next.tabs))render(next);return next;}
  catch(error){showToast(error?.message||'작업을 완료하지 못했어요. 다시 시도해 주세요.');return null;}
}
function showToast(message){
  if(!message)return;
  ++toastEpoch;clearTimeout(toastTimer);
  $('toast').classList.remove('is-closing');$('toastText').textContent=message;$('toast').hidden=false;
  toastTimer=setTimeout(hideToast,5000);
}
function hideToast(){
  clearTimeout(toastTimer);const epoch=++toastEpoch;$('toast').classList.add('is-closing');
  toastTimer=setTimeout(()=>{if(epoch===toastEpoch){$('toast').hidden=true;$('toast').classList.remove('is-closing');}},motionQuery.matches?0:160);
}
function enterMotion(node,className,duration=280){
  if(motionQuery.matches)return;
  node.classList.add(className);setTimeout(()=>node.classList.remove(className),duration);
}
// Reuse real controls across snapshots so focus, progress and animation survive.
function reconcile(container,items,key,create,update,animate=false){
  const children=[...container.children].filter(n=>!n.dataset.leaving);
  const existing=new Map(children.map(n=>[n.dataset.key,n]));
  const keys=items.map(key),changed=children.map(n=>n.dataset.key).join('|')!==keys.join('|');
  const moving=animate&&changed&&!motionQuery.matches&&items.length<45;
  const before=moving?new Map(children.map(n=>[n,n.getBoundingClientRect()])):new Map();
  const focused=document.activeElement;let lostFocus=false;
  const nodes=items.map(item=>{
    const id=key(item);let node=existing.get(id);
    if(!node){node=create(item);node.dataset.key=id;node._isNew=true;}
    else existing.delete(id);
    update(node,item);return node;
  });
  for(const node of existing.values()){
    if(node.contains(focused))lostFocus=true;
    if(moving&&node.getBoundingClientRect().height){
      const rect=node.getBoundingClientRect(),parent=container.getBoundingClientRect(),ghost=node.cloneNode(true);
      ghost.dataset.leaving='true';ghost.removeAttribute('data-tab-id');ghost.inert=true;ghost.setAttribute('aria-hidden','true');
      Object.assign(ghost.style,{position:'absolute',top:`${rect.top-parent.top+container.scrollTop}px`,left:`${rect.left-parent.left+container.scrollLeft}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:'0',pointerEvents:'none',zIndex:'2'});
      ghost.classList.remove('tab-enter');ghost.classList.add('tab-leave');container.append(ghost);setTimeout(()=>ghost.remove(),160);
    }
    node.remove();
  }
  let cursor=container.firstElementChild;
  for(const node of nodes){
    while(cursor?.dataset.leaving)cursor=cursor.nextElementSibling;
    if(cursor!==node)container.insertBefore(node,cursor);
    cursor=node.nextElementSibling;
    if(node._isNew){if(animate)enterMotion(node,'tab-enter',300);delete node._isNew;}
  }
  if(moving)for(const node of nodes){
    const old=before.get(node);if(!old)continue;
    const rect=node.getBoundingClientRect(),dx=old.left-rect.left,dy=old.top-rect.top;
    if(Math.abs(dx)+Math.abs(dy)>1)node.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],{duration:240,easing:motionEase});
  }
  if(lostFocus)requestAnimationFrame(()=>{
    if(document.activeElement===document.body){const target=[...$('tabList').children,...$('pinnedTabs').children].find(n=>n.dataset.tabId===state.activeTabId);target?.focus({preventScroll:true});}
  });
}
function replaceIcon(node,name){if(node.dataset.iconName!==name){node.replaceChildren(icon(name));node.dataset.iconName=name;}}

const bundledSiteIcons={
  'google.com':'sites/google.png','www.google.com':'sites/google.png',
  'youtube.com':'sites/youtube.png','www.youtube.com':'sites/youtube.png','youtu.be':'sites/youtube.png',
  'naver.com':'sites/naver.png','www.naver.com':'sites/naver.png',
  'github.com':'sites/github.png','www.github.com':'sites/github.png'
};
function favicon(tab){
  const n=el('span','tab-favicon');n.setAttribute('aria-hidden','true');
  if(isHome(tab)||tab?.url?.startsWith('orbit://')){n.classList.add('favicon-orbit');n.append(el('span','orbit-mark'));return n;}
  let host='';try{host=new URL(tab.url).hostname.toLowerCase();}catch{}
  const fallback=bundledSiteIcons[host];
  const source=tab.faviconURL||fallback;
  if(source){
    const image=el('img','site-icon');image.alt='';image.decoding='async';image.referrerPolicy='no-referrer';
    image.addEventListener('error',()=>{if(fallback&&image.getAttribute('src')!==fallback){image.src=fallback;return;}image.remove();n.append(icon('globe'));},{once:false});
    image.src=source;n.append(image);
  }else n.append(icon('globe'));
  return n;
}

function render(next){
  state=next;
  const space=currentSpace();
  const themeColor=space?.color||state.themeColor||'#c8d8cb';
  document.documentElement.style.setProperty('--theme',themeColor);
  const channels=themeColor.slice(1).match(/.{2}/g)?.map(part=>parseInt(part,16))||[200,216,203];
  $('app').classList.toggle('dark-chrome',channels[0]*.299+channels[1]*.587+channels[2]*.114<130);
  $('app').classList.toggle('collapsed',!!state.sidebarCollapsed);
  $('spaceName').textContent=space?.name||'내 공간';
  paintSpace($('spaceGlyph'),space);
  $('spaceGlyph').style.background='transparent';
  $('collapseButton').title=state.sidebarCollapsed?'사이드바 펼치기':'사이드바 접기';
  $('collapseButton').setAttribute('aria-label',$('collapseButton').title);
  renderTabs();renderSpaces();renderNavigation();renderPanes();renderDownloadBadge();renderFeatureUI();syncInternalPage();
  if(overlayKind==='downloads')updateDownloads();
  if(state.notice&&state.notice!==lastNotice)showToast(state.notice);
  lastNotice=state.notice;
}

function renderTabs(){
  const tabs=state.tabs.filter(t=>t.spaceId===state.activeSpaceId),pinned=tabs.filter(t=>t.pinned&&!t.folderId),regular=tabs.filter(t=>!t.pinned&&!t.folderId);
  $('tabCount').textContent=String(regular.length);$('pinnedSection').hidden=pinned.length===0;
  function make(tab,pin){
    const n=pin?button('pinned-tab',tab.title||'새 탭',null,()=>send('activateTab',{id:tab.id})):el('div','tab-row');
    n.dataset.tabId=tab.id;
    n.draggable=true;
    n.addEventListener('dragstart',event=>{
      if(!event.dataTransfer)return;
      event.dataTransfer.setData('application/x-orbit-tab',tab.id);event.dataTransfer.effectAllowed='move';n.classList.add('dragging');
    });
    n.addEventListener('dragend',()=>document.querySelectorAll('.dragging,.drop-target').forEach(node=>node.classList.remove('dragging','drop-target')));
    n.addEventListener('dragover',event=>{
      if(event.dataTransfer?.types.includes('application/x-orbit-tab')){event.preventDefault();event.dataTransfer.dropEffect='move';n.classList.add('drop-target');}
    });
    n.addEventListener('dragleave',event=>{if(!n.contains(event.relatedTarget))n.classList.remove('drop-target');});
    n.addEventListener('drop',async event=>{
      event.preventDefault();event.stopPropagation();n.classList.remove('drop-target');
      const id=event.dataTransfer?.getData('application/x-orbit-tab'),source=state.tabs.find(t=>t.id===id),target=state.tabs.find(t=>t.id===tab.id);
      if(!source||!target||id===target.id)return;
      await send('moveTab',{id,spaceId:target.spaceId,folderId:target.folderId||null});
      if(source.pinned!==target.pinned)await send('pinTab',{id});
      await send('reorderTab',{id,beforeId:target.id});
    });
    const visual=el('span','tab-visual');n.append(visual);n._visual=visual;
    if(!pin){
      n.setAttribute('role','button');n.tabIndex=0;
      const title=el('span','tab-title'),actions=el('span','tab-actions');n._title=title;
      actions.append(button('tab-action','탭 고정','pin',event=>{event.stopPropagation();send('pinTab',{id:tab.id});}),button('tab-action','탭 닫기','close',event=>{event.stopPropagation();send('closeTab',{id:tab.id});}));
      n.append(title,actions);n.addEventListener('click',()=>send('activateTab',{id:tab.id}));
      n.addEventListener('keydown',event=>{if(event.target===n&&(event.key==='Enter'||event.key===' ')){event.preventDefault();send('activateTab',{id:tab.id});}});
    }
    n.addEventListener('auxclick',event=>{if(event.button===1){event.preventDefault();send('closeTab',{id:tab.id});}});
    n.addEventListener('contextmenu',event=>{event.preventDefault();const current=state.tabs.find(t=>t.id===tab.id);if(current)openTabMenu(current);});return n;
  }
  function update(n,tab){
    const active=tab.id===state.activeTabId;
    n.classList.toggle('active',active);n.classList.toggle('in-split',state.splitTabIds?.includes(tab.id));
    n.title=tab.title||siteName(tab.url);n.setAttribute('aria-label',n.title+(active?', 현재 탭':''));n.setAttribute('aria-pressed',String(active));
    if(n._title)n._title.textContent=tab.title||'새 탭';
    const visualKey=tab.loading?'loading':siteName(tab.url)+'|'+(tab.faviconURL||'');
    if(n._visual.dataset.visual!==visualKey){n._visual.replaceChildren(tab.loading?el('span','loading-dot'):favicon(tab));n._visual.dataset.visual=visualKey;}
  }
  reconcile($('pinnedTabs'),pinned,t=>t.id,t=>make(t,true),update,true);
  reconcile($('tabList'),regular,t=>t.id,t=>make(t,false),update,true);
  renderFavorites();renderFolders(tabs,make,update);
  $('sidebarHint').hidden=tabs.length>7;
}

function renderSpaces(){
  reconcile($('spaceDots'),state.spaces,s=>s.id,space=>{
    const n=button('space-dot',space.name,null,()=>send('switchSpace',{id:space.id}));n.append(el('span'));return n;
  },(n,space)=>{
    n.classList.toggle('active',space.id===state.activeSpaceId);n.title=space.name;n.setAttribute('aria-label',space.name);
    paintSpace(n.querySelector('span'),space);n.style.setProperty('--dot-color',space.color||'#68866a');n.setAttribute('aria-pressed',String(space.id===state.activeSpaceId));
  });
}

function renderNavigation(){
  const tab=activeTab();$('backButton').disabled=!tab?.canGoBack;$('forwardButton').disabled=!tab?.canGoForward;
  $('reloadButton').disabled=isHome(tab);$('reloadButton').classList.toggle('spinning',!!tab?.loading);
  $('addressText').textContent=prettyUrl(tab);replaceIcon($('addressIcon'),isHome(tab)?'search':tab?.url?.startsWith('https:')?'lock':'globe');
  const split=state.splitTabIds?.length===2;$('splitButton').classList.toggle('active',split);$('splitButton').setAttribute('aria-pressed',String(split));$('splitButton').title=split?'분할 화면 닫기':'분할 화면 열기';
  replaceIcon($('maximizeButton'),state.isMaximized?'restore':'maximize');$('maximizeButton').setAttribute('aria-label',state.isMaximized?'이전 크기로':'최대화');
  let track=$('pageLoadTrack');
  if(!track){track=el('div','page-load-track');track.id='pageLoadTrack';track.setAttribute('aria-hidden','true');track.append(el('span'));document.querySelector('.toolbar').append(track);}
  const loading=!!tab?.loading;
  if(loading!==track.classList.contains('is-loading')){
    clearTimeout(loadTimer);const wasLoading=track.classList.contains('is-loading');track.classList.toggle('is-loading',loading);
    track.classList.toggle('is-complete',wasLoading&&!loading&&!tab?.error);
    if(!loading)loadTimer=setTimeout(()=>track.classList.remove('is-complete'),300);
  }
}

function renderPanes(){
  const split=state.splitTabIds?.length===2;$('workspaceSurface').classList.toggle('is-split',split);
  const tabs=(split?state.splitTabIds.map(id=>state.tabs.find(t=>t.id===id)):[activeTab()]).filter(Boolean);
  const kind=tab=>isHome(tab)?'home':tab.url?.startsWith('orbit://')?tab.url:tab.error?'error':'external';
  reconcile($('workspaceSurface'),tabs,t=>t.id+':'+kind(t),tab=>{
    const pane=el('section','pane');pane.dataset.tabId=tab.id;
    if(isHome(tab))pane.append(homePage(tab));
    else if(tab.url?.startsWith('orbit://'))pane.append(internalPage(tab));
    else if(tab.error)pane.append(errorPage(tab));
    else{const loading=el('div','external-placeholder');loading.append(el('span','loading-dot'));pane.append(loading);}
    enterMotion(pane,'pane-enter');return pane;
  },(pane,tab)=>{
    const index=tabs.indexOf(tab);pane.setAttribute('aria-label',split?(index+1)+'번째 웹페이지':'웹페이지');
    pane.classList.toggle('is-active',tab.id===state.activeTabId);
    const corner=pane.querySelector('.home-corner');if(corner){let label=corner.querySelector('.home-space-label');if(label)label.textContent=currentSpace()?.name||'내 공간';}
  });
}

function homePage(tab){
  const page=el('div','home-page'), corner=el('div','home-corner');corner.append(el('span'),el('span','home-space-label',currentSpace()?.name||'내 공간'));
  const content=el('div','home-content');content.append(el('p','home-eyebrow','A SPACE FOR YOUR EVERYDAY'));
  const title=el('h1','home-title');title.append(document.createTextNode('조금 더 가볍게,'),document.createElement('br'),el('em','', '나만의 궤도로.'));
  content.append(title,el('p','home-subtitle','어디로 향하고 싶으세요?\n아이디어도, 영감도. 여기서부터 시작하세요.'));
  const search=button('home-search','주소 또는 검색어 입력',null,()=>openPalette(tab?.id));search.append(icon('search'),el('span','','검색어 또는 웹 주소를 입력하세요'),el('kbd','','Ctrl L'));content.append(search);
  const quick=el('div','quick-links');
  for(const [name,url] of [['Google','https://www.google.com'],['YouTube','https://www.youtube.com'],['네이버','https://www.naver.com'],['GitHub','https://github.com']]){
    const link=button('quick-link',name,null,async()=>{if(tab?.id&&tab.id!==state.activeTabId)await send('activateTab',{id:tab.id});await send('newTab',{url});});link.append(favicon({url}),el('span','',name));quick.append(link);
  }
  content.append(quick);
  const footer=el('footer','home-footer');footer.append(el('span','','Less noise. More space.'));
  const customize=button('text-button','배경 색상 꾸미기',null,openSettings);customize.append(icon('sparkles'),document.createTextNode('내 공간 꾸미기'));footer.append(customize);
  page.append(el('div','home-watermark'),corner,content,footer);return page;
}

function errorPage(tab){
  const page=el('div','external-placeholder'),large=el('div','large-icon');large.append(icon('globe'));
  page.append(large,el('h2','','페이지를 열 수 없어요'),el('p','',`${siteName(tab.url)}에 연결하지 못했어요. 인터넷 연결과 주소를 확인해 주세요.`));
  const actions=el('div','error-actions');
  const retry=button('primary-button','다시 시도','reload',async()=>{await send('activateTab',{id:tab.id});await send('reload');});retry.append(document.createTextNode('다시 시도'));
  const home=button('secondary-button','새 탭으로 이동',null,async()=>{await send('activateTab',{id:tab.id});await send('navigate',{input:'orbit://newtab'});});home.textContent='새 탭으로';actions.append(retry,home);page.append(actions);return page;
}

function renderDownloadBadge(){
  const active=(state.downloads||[]).filter(d=>d.state==='progressing');
  $('downloadBadge').hidden=active.length===0;$('downloadBadge').textContent=String(active.length);
  $('downloadsButton').classList.toggle('downloading',active.length>0);
  const completed=(state.downloads||[]).filter(d=>d.state==='completed');
  if(downloadStateInitialized&&completed.some(d=>!lastCompletedIds.has(d.id))){
    $('downloadsButton').classList.remove('download-complete');void $('downloadsButton').offsetWidth;$('downloadsButton').classList.add('download-complete');
    setTimeout(()=>$('downloadsButton').classList.remove('download-complete'),1700);
  }
  lastCompletedIds=new Set(completed.map(d=>d.id));
  downloadStateInitialized=true;
}

async function openOverlay(kind){
  const epoch=++overlayEpoch;
  const route=routeFor(activeTab()?.url),mount=document.querySelector('[data-internal-tab="'+activeTab()?.id+'"]');
  if(route&&route[3]===kind&&mount){overlayKind=kind;mount.replaceChildren();$('overlay').hidden=true;$('overlay').replaceChildren();await send('overlay',{open:false});return epoch;}
  if($('overlay').hidden)overlayFocus=document.activeElement;
  overlayKind=kind;$('overlay').inert=false;$('overlay').classList.remove('is-closing');$('overlay').replaceChildren();$('overlay').hidden=false;
  await send('overlay',{open:true});
  return epoch;
}
function closeOverlay(){
  if(!overlayKind&&closingOverlay)return closingOverlay;
  ++paletteSuggestionEpoch;clearTimeout(paletteTimer);paletteRemote=[];const epoch=++overlayEpoch;overlayKind=null;$('overlay').classList.add('is-closing');$('overlay').inert=true;
  const job=(async()=>{
    await new Promise(resolve=>setTimeout(resolve,motionQuery.matches?0:160));
    if(epoch!==overlayEpoch)return;
    $('overlay').hidden=true;$('overlay').replaceChildren();$('overlay').classList.remove('is-closing');$('overlay').inert=false;
    await send('overlay',{open:false});
    if(epoch===overlayEpoch&&overlayFocus?.isConnected)overlayFocus.focus({preventScroll:true});
  })();
  closingOverlay=job;
  job.finally(()=>{if(closingOverlay===job)closingOverlay=null;});
  return job;
}
function dialog(title,subtitle,extraClass=''){
  const d=el('section','dialog '+extraClass);d.setAttribute('role','dialog');d.setAttribute('aria-modal','true');d.setAttribute('aria-label',title);
  const head=el('div','dialog-header');head.append(el('h2','dialog-heading',title),button('icon-button','닫기','close',closeOverlay));d.append(head);
  if(subtitle)d.append(el('p','dialog-subtitle',subtitle));
  const body=el('div','dialog-body');d.append(body);const route=routeFor(activeTab()?.url),mount=route&&route[3]===overlayKind?document.querySelector('[data-internal-tab="'+activeTab()?.id+'"]'):null;if(mount){d.classList.add('internal-dialog');d.removeAttribute('aria-modal');d.setAttribute('role','region');head.querySelector('button')?.remove();mount.append(d);}else $('overlay').append(d);setTimeout(()=>{if(d.isConnected)(d.querySelector('input')||d.querySelector('button'))?.focus();},0);return {root:d,body};
}

async function openPalette(tabId){
  if(!state)return;paletteRemote=[];++paletteSuggestionEpoch;clearTimeout(paletteTimer);paletteTarget=tabId||state.activeTabId;paletteIndex=0;
  if(tabId&&tabId!==state.activeTabId)await send('activateTab',{id:tabId});
  const epoch=await openOverlay('palette');
  if(overlayKind!=='palette'||epoch!==overlayEpoch)return;
  const root=el('section','dialog palette');root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','주소 및 탭 검색');
  const search=el('div','palette-search'),input=el('input','palette-input');input.id='paletteInput';input.placeholder='검색하거나, 웹 주소를 입력하세요';input.type='text';input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-label','검색어 또는 웹 주소');input.setAttribute('aria-controls','paletteResults');input.setAttribute('role','combobox');input.setAttribute('aria-expanded','true');
  search.append(icon('search'),input,el('kbd','','ESC'));root.append(search,el('div','palette-results'));root.lastChild.id='paletteResults';
  const footer=el('div','palette-footer');for(const [key,text] of [['↵','열기'],['↑ ↓','이동'],['esc','닫기']]){const s=el('span');s.append(el('kbd','',key),document.createTextNode(text));footer.append(s);}root.append(footer);$('overlay').append(root);
  input.addEventListener('input',()=>{paletteIndex=0;paletteRemote=[];const epoch=++paletteSuggestionEpoch;clearTimeout(paletteTimer);updatePalette(input.value);if(!state.incognito&&state.searchPreferences?.autocomplete&&state.searchPreferences?.onlineSuggestions){const query=input.value;paletteTimer=setTimeout(async()=>{const values=await bridge?.suggest(query).catch(()=>[]);if(epoch!==paletteSuggestionEpoch||overlayKind!=='palette'||input.value!==query)return;paletteRemote=values||[];updatePalette(query);},280);}});
  input.addEventListener('keydown',event=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();paletteIndex=(paletteIndex+(event.key==='ArrowDown'?1:-1)+paletteResults.length)%paletteResults.length;highlightPalette();}
    else if(event.key==='Enter'){event.preventDefault();choosePalette(paletteIndex);}
  });
  const targetTab=state.tabs.find(t=>t.id===paletteTarget);
  input.value=isHome(targetTab)?'':targetTab.url;
  updatePalette(input.value);input.focus();input.select();
}

function updatePalette(query){
  const trimmed=query.trim(),results=[];
  if(trimmed)results.push({kind:'navigate',title:looksLikeUrl(trimmed)?`이 주소 열기: ${trimmed}`:`“${trimmed}” 검색`,subtitle:looksLikeUrl(trimmed)?'웹페이지로 이동':'Google에서 검색',value:trimmed});
  else results.push({kind:'navigate',title:'검색어 또는 웹 주소 입력',subtitle:'새로운 아이디어를 찾아보세요',value:''});
  const enabled=state.searchPreferences?.autocomplete!==false;
  const matches=(enabled?state.tabs:[]).filter(t=>!isHome(t)&&(!trimmed||`${t.title} ${t.url}`.toLowerCase().includes(trimmed.toLowerCase()))).slice(0,6);
  for(const tab of matches)results.push({kind:'tab',title:tab.title||siteName(tab.url),subtitle:siteName(tab.url),tab});
  if(enabled&&trimmed)for(const r of internalRoutes){const url='orbit://'+r[0];if((url+' '+r[1]).toLowerCase().includes(trimmed.toLowerCase()))results.push({kind:'navigate',title:r[1],subtitle:'Orbit 내부 페이지 · '+url,value:url});}
  if(enabled){const used=new Set(results.map(r=>r.value||r.tab?.url));
    for(const entry of state.incognito?[]:(state.history||[]).filter(r=>r.spaceId===state.activeSpaceId&&(!trimmed||(r.title+' '+r.value).toLowerCase().includes(trimmed.toLowerCase()))).slice(0,6)){if(used.has(entry.value))continue;used.add(entry.value);results.push({kind:'navigate',title:entry.kind==='search'?entry.value:entry.title||siteName(entry.value),subtitle:entry.kind==='search'?'최근 검색':'방문 기록 · '+siteName(entry.value),value:entry.value,history:entry});}
    if(trimmed)for(const [title,url,aliases] of [['YouTube','https://www.youtube.com/','유튜브 youtube'],['Google','https://www.google.com/','구글 google'],['네이버','https://www.naver.com/','네이버 naver'],['GitHub','https://github.com/','깃허브 github'],['Pinterest','https://www.pinterest.com/','핀터레스트 pinterest']]){if(used.has(url)||!((title+' '+url+' '+aliases).toLowerCase().includes(trimmed.toLowerCase())))continue;used.add(url);results.push({kind:'navigate',title,subtitle:'사이트 추천 · '+siteName(url),value:url});}
    for(const item of state.favorites||[]){if(results.length>=12)break;if(used.has(item.url)||trimmed&&!(item.title+' '+item.url).toLowerCase().includes(trimmed.toLowerCase()))continue;used.add(item.url);results.push({kind:'navigate',title:item.title,subtitle:'즐겨찾기 · '+siteName(item.url),value:item.url});}
    for(const value of paletteRemote){if(used.has(value))continue;used.add(value);results.push({kind:'navigate',title:value,subtitle:'Google 추천 검색어',value});}
  }
  if(enabled&&!trimmed)for(const [title,url] of [['YouTube','https://www.youtube.com'],['Google','https://www.google.com']])results.push({kind:'navigate',title,subtitle:siteName(url),value:url});
  paletteResults=results;const container=$('paletteResults');if(!container)return;container.replaceChildren(el('div','palette-label',trimmed?'어디로 가볼까요?':'바로 시작하기'));
  results.forEach((result,index)=>{
    const n=button('palette-result'+(index===paletteIndex?' selected':''),result.title,null,()=>choosePalette(index));n.id=`palette-result-${index}`;n.setAttribute('role','option');n.setAttribute('aria-selected',String(index===paletteIndex));
    const thumb=el('span','result-icon');thumb.append(result.tab?favicon(result.tab):icon(result.history?'clock':result.value&&looksLikeUrl(result.value)?'globe':'search'));
    const text=el('span','result-content');text.append(el('strong','',result.title),el('small','',result.subtitle));n.append(thumb,text,icon(result.kind==='tab'?'arrow':'enter'));container.append(n);
  });$('paletteInput')?.setAttribute('aria-activedescendant',`palette-result-${paletteIndex}`);
}
function looksLikeUrl(value){if(/^(orbit|chrome|arc):\/\//i.test(value))return true;return /^(https?:|orbit:|localhost(?::\d+)?(?:\/|$)|127\.)/i.test(value)||/^[^\s]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value);}
function highlightPalette(){document.querySelectorAll('.palette-result').forEach((n,i)=>{n.classList.toggle('selected',i===paletteIndex);n.setAttribute('aria-selected',String(i===paletteIndex));});$('paletteInput')?.setAttribute('aria-activedescendant',`palette-result-${paletteIndex}`);}
async function choosePalette(index){
  const result=paletteResults[index];if(!result||result.kind==='navigate'&&!result.value){$('paletteInput')?.focus();return;}
  const target=paletteTarget;await closeOverlay();
  if(result.kind==='tab'){if(result.tab.spaceId!==state.activeSpaceId)await send('switchSpace',{id:result.tab.spaceId});await send('activateTab',{id:result.tab.id});}
  else {if(target&&state.tabs.some(t=>t.id===target))await send('activateTab',{id:target});await send('navigate',{input:result.value});}
}

async function openSettings(){
  if(!state)return;const epoch=await openOverlay('settings');if(overlayKind!=='settings'||epoch!==overlayEpoch)return;
  const {body}=dialog('내 공간 꾸미기','작은 취향까지 담아, 오래 머물고 싶은 브라우저로.');
  const browserSection=el('section','settings-section setting-toggle-row'),browserCopy=el('div');
  browserCopy.append(el('span','settings-label','기본 브라우저'),el('p','settings-description',state.packaged?'다른 앱의 웹 링크도 Orbit으로 열어보세요.':'설치 버전에서 Windows 기본 앱으로 선택할 수 있어요.'));
  const defaultButton=button('secondary-button','Windows 기본 브라우저 설정',null,()=>send('defaultBrowserSettings'));defaultButton.textContent='설정 열기';defaultButton.disabled=!state.packaged;browserSection.append(browserCopy,defaultButton);
  const colorSection=el('section','settings-section');colorSection.append(el('span','settings-label','브라우저 색상'),el('p','settings-description','오늘의 기분에 맞는 색을 골라보세요.'));
  const themeColor=currentSpace()?.color||state.themeColor||presets[0];
  const colors=el('div','color-presets');presets.forEach(color=>{const swatch=button('color-swatch'+(themeColor===color?' active':''),`배경색 ${color}`,null,()=>{send('theme',{color});updateColors(color);});swatch.style.setProperty('--swatch',color);swatch.dataset.color=color;colors.append(swatch);});
  const custom=el('label','color-custom'),picker=el('input','color-input');picker.type='color';picker.value=themeColor;picker.setAttribute('aria-label','사용자 지정 배경색');picker.id='themeColorInput';const code=el('span','color-code',picker.value);code.id='themeColorCode';
  picker.addEventListener('input',()=>{send('theme',{color:picker.value});updateColors(picker.value);});custom.append(picker,el('span','','직접 선택'),code);colorSection.append(colors,custom);
  const pip=el('section','settings-section setting-toggle-row'),pipCopy=el('div');pipCopy.append(el('span','settings-label','YouTube 자동 미니 플레이어'),el('p','settings-description','재생 중인 YouTube를 벗어나거나 다른 앱으로 이동하면, 영상을 항상 위에 떠 있는 창에서 이어 봅니다.'));
  const toggle=button('toggle','YouTube 자동 Picture-in-Picture',null,()=>{const enabled=toggle.getAttribute('aria-checked')!=='true';toggle.setAttribute('aria-checked',String(enabled));send('autoPip',{enabled});});toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(state.autoPip!==false));pip.append(pipCopy,toggle);
  const searchSection=el('section','settings-section');searchSection.append(el('span','settings-label','검색과 자동완성'));
  for(const [key,label,description] of [['autocomplete','주소창 자동완성','방문 사이트, 최근 검색, 열린 탭과 즐겨찾기를 추천합니다.'],['saveHistory','검색·방문 기록 저장','이 기기에 최대 500개 기록을 보관하고 스페이스별로 표시합니다. 시크릿 창은 제외됩니다.'],['onlineSuggestions','Google 추천 검색어','켜면 주소창에 입력하는 검색어를 Google에 전송해 추천을 받습니다. 기본값은 꺼짐입니다.']]){const row=el('div','setting-toggle-row'),copy=el('div');copy.append(el('span','settings-label',label),el('p','settings-description',description));const toggle=button('toggle',label,null,async()=>{const enabled=toggle.getAttribute('aria-checked')!=='true';const result=await send('searchPreferences',{[key]:enabled});if(result)toggle.setAttribute('aria-checked',String(result.searchPreferences[key]));});toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(state.searchPreferences?.[key]??(key!=='onlineSuggestions')));toggle.disabled=state.incognito;row.append(copy,toggle);searchSection.append(row);}
  const historyButton=button('secondary-button','검색·방문 기록 관리','clock',openHistory);historyButton.append(document.createTextNode('기록 보기·삭제'));searchSection.append(historyButton);body.append(searchSection);
  const passwords=button('secondary-button','비밀번호 관리자','lock',openPasswords);passwords.append(document.createTextNode('비밀번호 관리자'));body.append(passwords);
  const dataSection=el('section','settings-section');dataSection.append(el('span','settings-label','개인정보와 사이트 데이터'),el('p','settings-description','탭과 사이트 데이터는 이 기기에 저장됩니다. 필요한 경우 현재 스페이스의 쿠키와 캐시를 삭제할 수 있어요.'));
  const controls=el('div','dialog-actions');controls.style.justifyContent='flex-start';
  const privacy=button('secondary-button','개인정보 및 업데이트 안내',null,openAppInfo);privacy.textContent='개인정보 및 앱 정보';
  const clear=button('secondary-button','현재 스페이스 사이트 데이터 삭제',null,()=>send('clearSiteData'));clear.textContent='사이트 데이터 삭제';controls.append(privacy,clear);dataSection.append(controls);
  const footer=el('div','settings-footnote','Orbit 베타 · 스페이스마다 로그인과 쿠키가 분리됩니다.');
  const version=el('div','version-line');version.append(el('span','orbit-mark'),document.createTextNode(`Orbit ${state.version||'0.2.0-beta.1'}`));footer.append(version);body.append(browserSection,colorSection,pip,dataSection,footer);
}
async function openAppInfo(){
  if(!state)return;const epoch=await openOverlay('app-info');if(overlayKind!=='app-info'||epoch!==overlayEpoch)return;
  const {body}=dialog('Orbit 정보','나만의 인터넷, 나만의 속도로.');
  const sections=[
    ['내 기기에 보관되는 데이터','열린 탭의 주소·제목, 스페이스, 색상 설정과 사이트 쿠키·캐시는 이 기기에 저장됩니다. 스페이스별로 로그인 저장소가 분리됩니다.'],
    ['사이트에 전달되는 정보','Orbit 자체는 분석·광고·오류 업로드 서버를 운영하지 않습니다. 웹사이트를 방문하면 해당 사이트로 요청이 전달되며, 검색어를 입력하면 Google 검색으로 전달됩니다.'],
    ['데이터 삭제와 앱 제거','설정의 사이트 데이터 삭제는 현재 스페이스의 쿠키·캐시를 지우고 로그아웃합니다. 앱을 제거해도 브라우저 데이터와 다운로드한 파일은 보관합니다.'],
    ['업데이트','새 설치 파일을 실행하면 탭과 설정을 유지하며 업데이트합니다. 이 베타는 수동 업데이트 방식입니다.'],
    ['현재 지원 범위','Windows x64용 베타입니다. 비밀번호는 현재 기기에서 Windows 암호화로 저장하고 스페이스별로 관리합니다. 압축을 푼 확장은 일부 Chrome 확장 API를 지원합니다. Chrome 웹 스토어 전체 호환과 기기 간 동기화는 아직 제공하지 않습니다.']
  ];
  for(const [title,text] of sections){const section=el('section','settings-section');section.append(el('span','settings-label',title),el('p','settings-description',text));body.append(section);}
  body.append(el('p','settings-footnote',`Orbit ${state.version||'0.2.0-beta.1'} · Chromium ${state.engine?.chromium||'—'}`));
}
function updateColors(color){document.querySelectorAll('.color-swatch').forEach(n=>n.classList.toggle('active',n.dataset.color===color));if($('themeColorCode'))$('themeColorCode').textContent=color;if($('themeColorInput'))$('themeColorInput').value=color;}

async function openSpaces(){
  if(!state)return;const epoch=await openOverlay('spaces');if(overlayKind!=='spaces'||epoch!==overlayEpoch)return;
  const {body}=dialog('당신의 여러 가지 궤도','일할 때, 쉴 때, 좋아하는 것을 모을 때. 스페이스로 나눠보세요.');
  const list=el('div','space-list');
  state.spaces.forEach(space=>{const row=el('div','space-list-row'+(space.id===state.activeSpaceId?' active':''));row.setAttribute('role','button');row.tabIndex=0;row.setAttribute('aria-label',`${space.name} 스페이스로 전환`);const glyph=el('span','space-glyph',space.name.slice(0,1));paintSpace(glyph,space);glyph.style.background='transparent';row.append(glyph,el('strong','',space.name),el('small','',`${state.tabs.filter(t=>t.spaceId===space.id).length}개 탭`));
    row.append(button('icon-button','스페이스 수정','settings',event=>{event.stopPropagation();openSpaceEditor(space);}));const activate=async()=>{await closeOverlay();await send('switchSpace',{id:space.id});};row.addEventListener('click',activate);row.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();activate();}});list.append(row);
  });const add=button('space-add-button','새 스페이스 만들기','plus',()=>openSpaceEditor());add.append(document.createTextNode('새 스페이스 만들기'));body.append(list,add);
}
async function openSpaceEditor(space){
  if(!state)return;const epoch=await openOverlay('space-editor');if(overlayKind!=='space-editor'||epoch!==overlayEpoch)return;
  const {body}=dialog(space?'스페이스 이름 바꾸기':'새로운 궤도 만들기',space?'내 공간에 어울리는 이름을 정해보세요.':'새 스페이스는 독립된 로그인과 쿠키를 사용합니다.');
  const label=el('label','field-label','스페이스 이름');label.htmlFor='spaceNameInput';const input=el('input','text-input');input.id='spaceNameInput';input.maxLength=24;input.placeholder='예: 일하는 공간, 주말의 영감';input.value=space?.name||OrbitSpaceBrand.nextName(state.spaces);body.append(label,input);
  let selectedColor=space?.color||presets[state.spaces.length%presets.length];
  const preview=el('div','space-brand-preview'),previewGlyph=el('span','space-glyph'),previewName=el('strong','',input.value);paintSpace(previewGlyph,{color:selectedColor});preview.append(previewGlyph,previewName);body.append(preview);input.addEventListener('input',()=>previewName.textContent=input.value.trim()||OrbitSpaceBrand.nextName(state.spaces));
  if(!space){body.append(el('span','field-label','스페이스 표시 색상'));const colors=el('div','color-presets');presets.forEach(color=>{const swatch=button('color-swatch'+(color===selectedColor?' active':''),`스페이스 색 ${color}`,null,()=>{selectedColor=color;paintSpace(previewGlyph,{color:selectedColor});colors.querySelectorAll('button').forEach(n=>n.classList.toggle('active',n===swatch));});swatch.style.setProperty('--swatch',color);colors.append(swatch);});body.append(colors);}
  const actions=el('div','dialog-actions');
  if(space&&state.spaces.length>1){const remove=button('secondary-button','스페이스 삭제','trash',()=>openDeleteSpace(space));remove.append(document.createTextNode('삭제'));remove.style.marginRight='auto';actions.append(remove);}
  const cancel=button('secondary-button','취소',null,closeOverlay);cancel.textContent='취소';
  const save=button('primary-button',space?'저장':'스페이스 만들기',null,async()=>{const name=input.value.trim()||(space?space.name:OrbitSpaceBrand.nextName(state.spaces));await closeOverlay();await send(space?'renameSpace':'createSpace',space?{id:space.id,name}:{name,color:selectedColor});});save.textContent=space?'저장':'만들기';input.addEventListener('keydown',event=>{if(event.key==='Enter')save.click();});actions.append(cancel,save);body.append(actions);input.focus();
}
async function openDeleteSpace(space){
  await closeOverlay();
  await send('deleteSpace',{id:space.id});
}
async function openTabMenu(tab){
  const epoch=await openOverlay('tab-menu');if(overlayKind!=='tab-menu'||epoch!==overlayEpoch)return;
  const {body}=dialog('탭 관리',tab.title||siteName(tab.url));
  const actions=el('div','tab-menu-actions');
  const perform=(name,payload)=>async()=>{await closeOverlay();await send(name,payload);};
  actions.append(menuRow(tab.pinned?'고정 해제':'탭 고정',tab.pinned?'unpin':'pin',perform('pinTab',{id:tab.id})),
    menuRow('즐겨찾기 추가 · 제거','star',perform('favoriteTab',{id:tab.id})),
    menuRow(tab.muted?'탭 소리 켜기':'탭 음소거',tab.muted?'volume':'volumeOff',perform('muteTab',{id:tab.id})),
    menuRow('주소 복사','link',perform('copyURL',{id:tab.id})),
    menuRow('탭 닫고 보관','archive',perform('closeTab',{id:tab.id})));body.append(actions);
  const movement=el('div','tab-move-select'),label=el('label','','폴더 이동'),select=document.createElement('select');
  select.setAttribute('aria-label','탭을 이동할 폴더');let option=new Option('폴더 밖으로','');select.add(option);
  for(const folder of (state.folders||[]).filter(f=>f.spaceId===tab.spaceId))select.add(new Option(folder.name,folder.id));
  select.value=tab.folderId||'';select.addEventListener('change',async()=>{await send('moveTab',{id:tab.id,folderId:select.value||null});await closeOverlay();});movement.append(label,select);body.append(movement);
  const spaces=el('div','tab-move-select'),spaceLabel=el('label','','스페이스'),spaceSelect=document.createElement('select');spaceSelect.setAttribute('aria-label','탭을 이동할 스페이스');
  for(const space of state.spaces)spaceSelect.add(new Option(space.name,space.id));spaceSelect.value=tab.spaceId;
  spaceSelect.addEventListener('change',async()=>{await closeOverlay();await send('moveTab',{id:tab.id,spaceId:spaceSelect.value,folderId:null});});spaces.append(spaceLabel,spaceSelect);body.append(spaces);
}

async function openDownloads(){
  if(!state)return;const epoch=await openOverlay('downloads');if(overlayKind!=='downloads'||epoch!==overlayEpoch)return;
  const {root,body}=dialog('다운로드','파일이 내 공간으로 도착하는 중이에요.','downloads-dialog');body.id='downloadList';const footer=el('div','downloads-footer');footer.append(el('span','','완료한 파일은 폴더에서 확인하세요.'));const clear=button('text-button','완료한 다운로드 기록 지우기',null,()=>send('clearDownloads'));clear.textContent='기록 지우기';footer.append(clear);root.append(footer);updateDownloads();
}
function bytes(value){if(!value||value<0)return '0 B';const units=['B','KB','MB','GB'];const index=Math.min(Math.floor(Math.log(value)/Math.log(1024)),3);return `${(value/1024**index).toFixed(index>0?1:0)} ${units[index]}`;}
function updateDownloads(){
  const list=$('downloadList');if(!list)return;
  const downloads=state.downloads||[];
  list.querySelector('.empty-state')?.remove();
  if(!downloads.length){
    list.replaceChildren();const empty=el('div','empty-state');empty.append(icon('download'),el('h3','','아직 다운로드가 없어요'),el('p','','다운로드한 파일과 진행 상황이 이곳에 차곡차곡 모입니다.'));list.append(empty);return;
  }
  reconcile(list,downloads,d=>d.id,download=>{
    const card=el('article','download-card');card.dataset.downloadId=download.id;
    const row=el('div','download-card-row'),file=el('span','download-file-icon'),info=el('div','download-file-info');
    const ring=el('span','download-ring'),ringSVG=document.createElementNS('http://www.w3.org/2000/svg','svg');ringSVG.setAttribute('viewBox','0 0 42 42');ringSVG.setAttribute('aria-hidden','true');
    const ringTrack=document.createElementNS('http://www.w3.org/2000/svg','circle'),ringValue=ringTrack.cloneNode();
    for(const circle of [ringTrack,ringValue]){circle.setAttribute('cx','21');circle.setAttribute('cy','21');circle.setAttribute('r','17');circle.setAttribute('pathLength','100');}
    ringTrack.setAttribute('class','ring-track');ringValue.setAttribute('class','ring-value');ringValue.setAttribute('stroke-dasharray','100');ringSVG.append(ringTrack,ringValue);
    const ringNumber=el('span','download-ring-value');ring.append(ringSVG,ringNumber);file.append(ring);
    const name=el('strong'),description=el('small'),action=button('icon-button','다운로드 취소','close',()=>{
      const current=state.downloads.find(d=>d.id===download.id);if(current?.state==='progressing')send('cancelDownload',{id:download.id});else if(current?.state==='completed')send('showDownload',{id:download.id});
    });
    info.append(name,description);row.append(file,info,action);
    const track=el('div','download-progress'),fill=el('span'),status=el('div','download-status'),size=el('span'),percent=el('span');
    track.append(fill);track.setAttribute('role','progressbar');status.append(size,percent);card.append(row,track,status);
    card._parts={file,ring,ringValue,ringNumber,name,description,action,track,fill,size,percent};return card;
  },(card,download)=>{
    const p=card._parts,done=download.state==='completed',progressing=download.state==='progressing';
    if(done&&card.dataset.state&&card.dataset.state!=='completed')enterMotion(card,'is-completing',500);
    card.dataset.state=download.state;card.classList.toggle('complete',done);
    p.name.textContent=download.filename||'다운로드 파일';
    const text=done?'다운로드 완료':download.state==='cancelled'?'취소됨':download.state==='interrupted'?'중단됨':'다운로드 중';
    p.description.textContent=done?bytes(download.totalBytes||download.receivedBytes):text;
    p.action.hidden=!progressing&&!done;p.action.title=done?'폴더에서 보기':'다운로드 취소';p.action.setAttribute('aria-label',p.action.title);replaceIcon(p.action,done?'folder':'close');
    const known=download.totalBytes>0,percent=done?100:known?Math.min(100,Math.floor(download.receivedBytes/download.totalBytes*100)):0;
    p.ring.classList.toggle('indeterminate',progressing&&!known);p.ringValue.style.strokeDashoffset=String(known||done?100-percent:75);
    if(done){if(p.ringNumber.dataset.done!=='true'){p.ringNumber.replaceChildren(icon('check'));p.ringNumber.dataset.done='true';}}
    else if(known){p.ringNumber.textContent=String(percent);p.ringNumber.dataset.done='false';}
    else if(p.ringNumber.dataset.done!=='unknown'){p.ringNumber.replaceChildren(icon('download'));p.ringNumber.dataset.done='unknown';}
    p.track.hidden=!progressing&&!done;p.track.classList.toggle('indeterminate',progressing&&!known);p.fill.style.width=percent+'%';
    p.track.setAttribute('aria-label',download.filename||'파일 다운로드');p.track.setAttribute('aria-valuemin','0');p.track.setAttribute('aria-valuemax','100');
    if(known||done)p.track.setAttribute('aria-valuenow',String(percent));else p.track.removeAttribute('aria-valuenow');
    p.size.textContent=bytes(download.receivedBytes)+(known?' / '+bytes(download.totalBytes):'');p.percent.textContent=done?'완료':progressing?(known?percent+'%':'파일을 받고 있어요'):text;
  });
}

async function newTab(){await send('newTab');await openPalette();}
$('homeButton').addEventListener('click',openAppMenu);
$('collapseButton').addEventListener('click',()=>send('toggleSidebar'));
$('newTabButton').addEventListener('click',newTab);
$('spaceSelector').addEventListener('click',openSpaces);$('addSpaceButton').addEventListener('click',()=>openSpaceEditor());
$('settingsButton').addEventListener('click',openSettings);$('downloadsButton').addEventListener('click',openDownloads);
$('addressButton').addEventListener('click',()=>openPalette());$('backButton').addEventListener('click',()=>send('back'));$('forwardButton').addEventListener('click',()=>send('forward'));$('reloadButton').addEventListener('click',()=>send('reload'));
$('splitButton').addEventListener('click',()=>send(state?.splitTabIds?.length===2?'unsplit':'split'));$('pipButton').addEventListener('click',()=>send('pip'));
$('minimizeButton').addEventListener('click',()=>send('minimize'));$('maximizeButton').addEventListener('click',()=>send('maximize'));$('closeButton').addEventListener('click',()=>send('closeWindow'));
$('dismissToast').addEventListener('click',hideToast);
$('overlay').addEventListener('click',event=>{if(event.target===$('overlay'))closeOverlay();});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&overlayKind){event.preventDefault();closeOverlay();return;}
  if(overlayKind){if(event.key==='Tab'){const focusable=[...$('overlay').querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(n=>!n.disabled&&n.getClientRects().length),first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}return;}
  if(event.ctrlKey&&!event.shiftKey&&event.key.toLowerCase()==='l'){event.preventDefault();openPalette();}
  else if(event.ctrlKey&&!event.shiftKey&&event.key.toLowerCase()==='t'){event.preventDefault();newTab();}
  else if(event.ctrlKey&&event.key.toLowerCase()==='w'){event.preventDefault();if(state?.activeTabId)send('closeTab',{id:state.activeTabId});}
  else if(event.ctrlKey&&event.key.toLowerCase()==='r'){event.preventDefault();send('reload');}
  else if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='d'){event.preventDefault();send(state?.splitTabIds?.length===2?'unsplit':'split');}
});

if(bridge){
  bridge.onState(render);
  const syncMotion=()=>send('motionPreference',{reduced:motionQuery.matches});
  motionQuery.addEventListener('change',syncMotion);
  syncMotion();
  bridge.onCommand(command=>{if(command==='new-tab')newTab();else if(command==='focus-address')openPalette();else if(command==='settings')openSettings();else if(command==='downloads')openDownloads();else if(command==='close-overlay')closeOverlay();else if(command==='find'){if(overlayKind||closingOverlay)closeOverlay().then(openFind);else openFind();}else if(command==='menu')openAppMenu();else if(command==='archives')openArchives();else if(command==='card')openProfileCard();else if(command==='favorites')openFavorites();else if(command==='folders'||command==='tabs')openTabLibrary();else if(command==='extensions')openExtensions();});
  bridge.getState().then(render).catch(()=>showToast('브라우저를 시작하지 못했어요. 앱을 다시 실행해 주세요.'));
} else {
  $('workspaceSurface').append(homePage());
  showToast('Orbit 앱에서 실행하면 웹 탐색을 시작할 수 있어요.');
}

$("passwordButton").addEventListener("click",openPasswords);
