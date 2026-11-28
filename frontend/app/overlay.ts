import "./selects.css";

function place(popup:HTMLElement,left:number,below:number,above:number,desiredWidth?:number, beside?:DOMRect){
 popup.style.position='fixed';popup.style.left='0px';popup.style.top='0px';
 const origin=popup.getBoundingClientRect(),scale=origin.width/Math.max(1,parseFloat(getComputedStyle(popup).width))||1;
 const width=Math.min(desiredWidth??origin.width,innerWidth-24);
 popup.style.width=width/scale+'px';popup.style.maxHeight='';
 const limit=parseFloat(getComputedStyle(popup).maxHeight);
 const belowSpace=Math.max(0,innerHeight-12-below),aboveSpace=Math.max(0,above-12);
 const useAbove=popup.getBoundingClientRect().height>belowSpace&&aboveSpace>belowSpace;
 const available=beside?innerHeight-24:Math.max(32,useAbove?aboveSpace:belowSpace);
 popup.style.maxHeight=Math.min(available/scale,Number.isFinite(limit)?limit:Infinity)+'px';
 const bounds=popup.getBoundingClientRect(),x=Math.max(12,Math.min(left,innerWidth-width-12));
 const top=Math.max(12,Math.min(beside?beside.bottom-bounds.height:useAbove?above-bounds.height:below,innerHeight-bounds.height-12));
 popup.style.left=(x-origin.left)/scale+'px';popup.style.top=(top-origin.top)/scale+'px';
}
export function placePopup(popup:HTMLElement,button:HTMLElement,width?:number){const r=button.getBoundingClientRect();place(popup,r.left,r.bottom+5,r.top-5,width??Math.max(150,r.width));}
export function placePoint(popup:HTMLElement,x:number,y:number,gap=8){place(popup,x+gap,y+gap,y-gap);}
function visibleAnchor(trigger:HTMLElement){
 if(!trigger.isConnected||!trigger.getClientRects().length||getComputedStyle(trigger).visibility!=='visible')return false;
 const r=trigger.getBoundingClientRect();
 let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
 for(let parent=trigger.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
  const css=getComputedStyle(parent),bounds=parent.getBoundingClientRect();
  if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
  if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
 }
 return left<right&&top<bottom;
}
function follow(popup:HTMLElement,trigger:HTMLElement,width?:()=>number,onDetach?:()=>void,side?:'right'){
 const parent=popup.parentElement!,next=popup.nextSibling,portal=trigger.closest('dialog[open]')||document.body;
 const focused=document.activeElement,ownsFocus=popup.contains(focused);
 portal.append(popup);popup.dataset.overlayPortal='';let frame=0;
 const update=()=>{frame=0;if(!popup.isConnected||popup.hidden)return;if(!visibleAnchor(trigger)){popup.hidden=true;onDetach?.();return;}const box=trigger.getBoundingClientRect(),rendered=box.width/Math.max(1,parseFloat(getComputedStyle(trigger).width));popup.style.zoom=portal===document.body?String(rendered):'1';if(side==='right')place(popup,box.right+8,0,0,width?.(),box);else placePopup(popup,trigger,width?.());};
 const queue=()=>{if(!frame)frame=requestAnimationFrame(update);};
 const abort=new AbortController();document.addEventListener('scroll',queue,{capture:true,passive:true,signal:abort.signal});window.addEventListener('resize',queue,{signal:abort.signal});
 const observer=new ResizeObserver(queue);observer.observe(trigger);observer.observe(popup);
 const visibility=new IntersectionObserver(queue);visibility.observe(trigger);
 update();if(ownsFocus&&focused instanceof HTMLElement)focused.focus({preventScroll:true});
 return ()=>{abort.abort();observer.disconnect();visibility.disconnect();cancelAnimationFrame(frame);delete popup.dataset.overlayPortal;popup.style.cssText='';if(parent.isConnected)parent.insertBefore(popup,next?.parentNode===parent?next:null);};
}
function disclosure(shell:HTMLDetailsElement,popup:HTMLElement){
 const trigger=shell.querySelector<HTMLElement>('summary')!;let release:(()=>void)|undefined;
 popup.hidden=true;
 const toggle=()=>{release?.();release=undefined;popup.hidden=!shell.open;trigger.setAttribute('aria-expanded',String(shell.open));if(shell.open)release=follow(popup,trigger,undefined,()=>{shell.open=false;});};
 shell.addEventListener('toggle',toggle);
 const outside=(event:PointerEvent)=>{if(!shell.contains(event.target as Node)&&!popup.contains(event.target as Node))shell.open=false;};
 document.addEventListener('pointerdown',outside);
 const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();shell.open=false;trigger.focus({preventScroll:true});}};popup.addEventListener('keydown',key);
 return ()=>{shell.removeEventListener('toggle',toggle);document.removeEventListener('pointerdown',outside);popup.removeEventListener('keydown',key);release?.();popup.remove();};
}
(window as any).WorkbenchOverlay={place:placePopup,point:placePoint,follow,disclosure};
document.addEventListener('pointerdown',event=>document.querySelectorAll<HTMLDetailsElement>('[data-action-menu][open]').forEach(menu=>{if(!menu.contains(event.target as Node)&&!document.querySelector('[data-overlay-portal][data-menu-owner="'+menu.dataset.menuOwner+'"]')?.contains(event.target as Node))menu.open=false;}));
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=document.querySelector<HTMLDetailsElement>('[data-action-menu][open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();}},true);
let menuId=0;
document.addEventListener('toggle',event=>{const menu=event.target;if(!(menu instanceof HTMLDetailsElement)||!menu.hasAttribute('data-action-menu'))return;const state=menu as any;state._overlayRelease?.();state._overlayRelease=null;const panel=state._overlayPanel||menu.querySelector<HTMLElement>(':scope > div'),trigger=menu.querySelector<HTMLElement>('summary');if(panel&&trigger){state._overlayPanel=panel;panel.hidden=!menu.open;if(menu.open){menu.dataset.menuOwner||=String(++menuId);panel.dataset.menuOwner=menu.dataset.menuOwner;state._overlayRelease=follow(panel,trigger,undefined,()=>{menu.open=false;});menu.closest('dialog')?.addEventListener('close',()=>{state._overlayRelease?.();panel.remove();},{once:true});}}},true);
