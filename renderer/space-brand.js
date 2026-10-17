/* Original Orbit ribbon geometry, recoloured from the current space theme. */
(() => {
  'use strict';
  function palette(color) {
    const hex = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#c8d8cb';
    const [r,g,b] = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255);
    const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2;
    const h=d===0?0:((max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4)*60);
    const s=d===0?0:Math.max(35,Math.min(78,d/(1-Math.abs(2*l-1))*100+18));
    return { hex, light:`hsl(${Math.round(h)} ${s}% ${l<.4?82:72}%)`,mid:`hsl(${Math.round(h+14)} ${s}% 53%)`,dark:`hsl(${Math.round(h+24)} ${s}% ${l<.4?48:30}%)` };
  }
  function logo(color) {
    const p=palette(color);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none"><defs><linearGradient id="r" x1="88" y1="47" x2="163" y2="220" gradientUnits="userSpaceOnUse"><stop stop-color="${p.light}"/><stop offset=".5" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient><linearGradient id="f"><stop stop-color="${p.light}"/><stop offset="1" stop-color="${p.mid}"/></linearGradient></defs><path d="M168.7 69.1a72 72 0 1 0 30.2 46.4" stroke="url(#r)" stroke-width="39" stroke-linecap="round"/><path d="M198.9 115.5a71.9 71.9 0 0 0-10.5-25.7" stroke="${p.dark}" stroke-opacity=".18" stroke-width="39"/><path d="m188.9 92.5 10 23" stroke="url(#f)" stroke-width="39" stroke-linecap="round"/><path d="M150.1 59.5a72 72 0 0 1 18.6 9.6" stroke="${p.light}" stroke-width="39" stroke-linecap="round"/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  }
  function nextName(spaces) { const names=new Set(spaces.map(s=>s.name));let n=1;while(names.has(`궤도 - ${n}`))n++;return `궤도 - ${n}`; }
  const api=Object.freeze({logo,palette,nextName});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.OrbitSpaceBrand=api;
})();
