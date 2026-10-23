import type {Config,State} from "./taskbar-plugin";
import {presetPalette} from "./theme-presets";
const rgb=(hex:string)=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
const luminance=(hex:string)=>rgb(hex).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
const ratio=(a:string,b:string)=>{const [x,y]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return(x+.05)/(y+.05)};
const valid=(v:unknown):v is string=>typeof v==="string"&&/^#[a-f\d]{6}$/i.test(v);
const mix=(a:string,b:string,p:number)=>"#"+rgb(a).map((v,i)=>Math.round(v*(1-p)+rgb(b)[i]*p).toString(16).padStart(2,"0")).join("");
const alpha=(c:string,a:number)=>`rgba(${rgb(c).join(",")},${a})`;
export function floatingAppearance(config:Config,state:State){
 const dark=config.theme==="dark"||(config.theme==="follow"&&state.appearance.theme==="dark");
 const base=config.surface,p=presetPalette(config.preset,dark?"dark":"light");
 const v=config.visual||{};
 let accent=valid(config.accent)?config.accent:p.accent;
 const rawBackground=valid(v.background)?v.background:dark?"#121b27":mix("#f8fafc",p.sidebar,.32);
 const background=rawBackground;
 const fallback=ratio("#000000",background)>ratio("#ffffff",background)?"#000000":"#ffffff";
 const requested=valid(v.text)?v.text:dark?"#eef4fa":"#172838";
 const text=ratio(requested,background)>=4.5?requested:fallback;
 const mutedRequest=valid(v.muted)?v.muted:dark?"#a7b6c8":"#63758a";
 const readableMuted=mix(text,background,.27);
 let muted=ratio(mutedRequest,background)>=3?mutedRequest:ratio(readableMuted,background)>=3?readableMuted:text;
 const candidatePanel=mix(background,"#ffffff",luminance(background)>.42?.65:.055);
 const panel=ratio(text,candidatePanel)>=4.5?candidatePanel:background;
 if(ratio(muted,panel)<3)muted=text;
 const requestedAccent=accent;
 if(Math.min(ratio(accent,background),ratio(accent,panel))<3)accent=text;
 const requestedChart=valid(v.chart)?v.chart:accent;
 const chart=Math.min(ratio(requestedChart,background),ratio(requestedChart,panel))>=3?requestedChart:accent;
 if(base==="transparent"&&dark&&!valid(v.muted))muted="#e0e8f2";
 const opacity=Number.isFinite(v.opacity)?Math.max(0,Math.min(100,v.opacity))/100:base==="transparent"?.6:1;
 const actualOpacity=base==="transparent"?opacity*(dark?.64:.22):1;
 return {dark,base,background,text,muted,accent,chart,opacity,clear:actualOpacity<1,protectedText:text!==requested||muted!==mutedRequest||accent!==requestedAccent||chart!==requestedChart,
  vars:{"--solid":background,"--popup-solid":dark?"#202c3b":"#ffffff","--readable":"transparent","--ink":text,"--muted":muted,"--accent":accent,"--chart":chart,
   "--canvas":alpha(background,actualOpacity),"--panel":alpha(panel,actualOpacity<1?0:.6),"--layer":alpha(panel,actualOpacity<1?0:.4),
   "--line":alpha(text,luminance(background)>.42?.1:.13),"--density":v.density==="compact"?.8:1,
   "--data-font":v.font==="mono"?'Consolas,"Cascadia Mono",monospace':'"Segoe UI Variable","Segoe UI",sans-serif'}};
}
