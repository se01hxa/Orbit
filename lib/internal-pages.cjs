'use strict';
function internalURL(value){
 if(typeof value!=='string'||! /^(?:orbit|chrome|arc):\/\//i.test(value))return null;
 try{const u=new URL(value);if(u.username||u.password||u.port||u.search||u.hash||/\s/.test(value))throw Error();
 const aliases={'about':'urls','chrome-urls':'urls','orbit-urls':'urls','passwords':'password-manager'};
 const host=aliases[u.hostname.toLowerCase()]||u.hostname.toLowerCase();
 if(!host||!/^[a-z0-9-]+$/.test(host))throw Error();
 return 'orbit://'+host+(host==='newtab'?'':u.pathname==='/'?'':u.pathname);
 }catch{throw new Error('올바른 Orbit 내부 주소를 입력해 주세요.');}
}
const isInternal=value=>typeof value==='string'&&value.startsWith('orbit://');
module.exports={internalURL,isInternal};
