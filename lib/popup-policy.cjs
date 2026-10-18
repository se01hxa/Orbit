'use strict';
const {isWebURL}=require('./model.cjs');
// Blob documents are live, creator-scoped resources, never arbitrary file/data URLs.
function sameOriginBlob(url,creator){try{if(typeof url!=='string'||!url.startsWith('blob:')||!isWebURL(creator)||!isWebURL(url.slice(5)))return false;return new URL(url).origin===new URL(creator).origin;}catch{return false;}}
function popupTarget(url,creator){return url===''||url==='about:blank'?'about:blank':isWebURL(url)||sameOriginBlob(url,creator)?url:null;}
module.exports={popupTarget,sameOriginBlob};
