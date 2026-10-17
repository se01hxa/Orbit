'use strict';
const https=require('node:https');
const {onlineQuery}=require('./history.cjs');
function fetchSuggestions(query,signal,request=https.get){
  const q=onlineQuery(query);if(!q||signal?.aborted)return Promise.resolve([]);
  return new Promise(resolve=>{
    let settled=false,req;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(value);};
    const abort=()=>{req?.destroy();finish([]);};const timer=setTimeout(abort,1800);
    signal?.addEventListener('abort',abort,{once:true});
    try{req=request('https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&q='+encodeURIComponent(q),{headers:{Accept:'application/json'}},res=>{
      if(res.statusCode!==200){abort();return;}
      let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>65536){abort();return;}chunks.push(chunk);});res.on('error',()=>finish([]));res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(Array.isArray(data[1])?data[1].filter(s=>typeof s==='string'&&s.length<=150&&!/[\u0000-\u001f]/.test(s)).slice(0,6):[]);}catch{finish([]);}});
    });req.on('error',()=>finish([]));}catch{finish([]);}
  });
}
module.exports={fetchSuggestions};
