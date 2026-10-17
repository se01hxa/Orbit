'use strict';
const internalRoutes=[
 ['password-manager/passwords','비밀번호 관리자','key','passwords',()=>openPasswords()],
 ['settings','설정','settings','settings',()=>openSettings()],
 ['history','검색·방문 기록','clock','history',()=>openHistory()],
 ['downloads','다운로드','download','downloads',()=>openDownloads()],
 ['extensions','확장 프로그램','extension','extensions',()=>openExtensions()],
 ['bookmarks','즐겨찾기','star','favorites',()=>openFavorites()],
 ['spaces','스페이스','spaces','spaces',()=>openSpaces()],
 ['tabs','탭과 폴더','globe','tab-library',()=>openTabLibrary()],
 ['archives','보관한 탭','archive','archives',()=>openArchives()],
 ['version','Orbit 정보','info','app-info',()=>openAppInfo()],
 ['help','도움말','help','help',()=>openHelp()]
];
function routeFor(url){if(!url?.startsWith('orbit://')||isHome({url}))return null;const key=url.slice(8).replace(/\/$/,'');return internalRoutes.find(r=>r[0]===key)||(key==='password-manager'?internalRoutes[0]:key==='settings/passwords'?internalRoutes[0]:key==='settings/help'?internalRoutes.find(r=>r[0]==='version'):null);}
function internalPage(tab){
 const page=el('div','internal-page');const nav=el('nav','internal-nav');nav.append(el('h2','','Orbit'));
 for(const r of internalRoutes){const b=button('internal-link',r[1],r[2],()=>send('navigate',{input:'orbit://'+r[0]}));b.append(document.createTextNode(r[1]));b.classList.toggle('active',routeFor(tab.url)===r);nav.append(b);}page.append(nav);
 const content=el('section','internal-content');content.dataset.internalTab=tab.id;page.append(content);
 const route=routeFor(tab.url);if(route){content.append(el('h1','',route[1]));const launch=button('primary-button',route[1]+' 열기',route[2],route[4]);launch.append(document.createTextNode('관리 화면 열기'));content.append(launch);}
 else{content.append(el('h1','',tab.url==='orbit://urls'?'Orbit 내부 페이지':'지원하지 않는 내부 주소'),el('p','settings-description',tab.url==='orbit://urls'?'Orbit에서 사용할 수 있는 내부 주소입니다.':'이 Chromium 내부 기능은 현재 Orbit에 포함되어 있지 않습니다. 아래에서 지원하는 페이지를 열 수 있습니다.'));for(const r of internalRoutes){const b=button('library-row',r[1],r[2],()=>send('navigate',{input:'orbit://'+r[0]}));b.append(el('strong','',r[1]),el('code','','orbit://'+r[0]));content.append(b);}}
 return page;
}
let lastInternalKey='';
function syncInternalPage(){const tab=activeTab(),key=tab?.id+':'+tab?.url;if(key===lastInternalKey)return;lastInternalKey=key;const r=routeFor(tab?.url);if(r)queueMicrotask(()=>{if(activeTab()?.id+':'+activeTab()?.url===key)r[4]();});}
