'use strict';
const defaults=Object.freeze({autocomplete:true,saveHistory:true,onlineSuggestions:false});
function preferences(value={}) { return Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,typeof value?.[k]==='boolean'?value[k]:v])); }
function safeVisit(value) {
  try {const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||/(?:oauth|signin|login|callback|authorize)/i.test(u.pathname)||[...u.searchParams.keys()].some(k=>/^(code|state|token|access_token|id_token|password)$/i.test(k)))return '';u.search='';u.hash='';return u.href.slice(0,2048);}catch{return '';}
}
function cleanHistory(records,spaceIds) {
  const output=[],seen=new Set();
  for(const r of Array.isArray(records)?records:[]){if(output.length>=500)break;if(!r||!spaceIds.has(r.spaceId)||!['visit','search'].includes(r.kind))continue;
    const value=r.kind==='visit'?safeVisit(r.value):typeof r.value==='string'?r.value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,200):'';
    if(!value)continue;const key=r.spaceId+'|'+r.kind+'|'+value.toLowerCase();if(seen.has(key))continue;seen.add(key);
    output.push({spaceId:r.spaceId,kind:r.kind,value,title:typeof r.title==='string'?r.title.slice(0,200):value,at:Number.isFinite(r.at)?Math.min(Date.now(),Math.max(0,r.at)):Date.now()});
  }return output;
}
function addHistory(records,record,spaceIds){return cleanHistory([record,...records],spaceIds);}
function onlineQuery(value){return typeof value==='string'&&!/^\s*!y(?:\s|$)/i.test(value)&&value.trim().length>=2&&value.length<=100&&!/[\u0000-\u001f@:/\\]/.test(value)&&!/^\S+\.\S+/.test(value)?value.trim():'';}
module.exports={preferences,cleanHistory,addHistory,safeVisit,onlineQuery};
