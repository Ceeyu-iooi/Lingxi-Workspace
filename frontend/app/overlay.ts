function place(popup:HTMLElement,left:number,below:number,above:number,desiredWidth?:number){
 popup.style.position='fixed';popup.style.left='0px';popup.style.top='0px';
 const origin=popup.getBoundingClientRect(),scale=origin.width/Math.max(1,parseFloat(getComputedStyle(popup).width))||1;
 const width=Math.min(desiredWidth??origin.width,innerWidth-24);
 popup.style.width=width/scale+'px';popup.style.maxHeight=(innerHeight-24)/scale+'px';
 const bounds=popup.getBoundingClientRect(),x=Math.max(12,Math.min(left,innerWidth-width-12));
 const top=Math.max(12,below+bounds.height<=innerHeight-12?below:Math.min(above-bounds.height,innerHeight-bounds.height-12));
 popup.style.left=(x-origin.left)/scale+'px';popup.style.top=(top-origin.top)/scale+'px';
}
export function placePopup(popup:HTMLElement,button:HTMLElement,width?:number){const r=button.getBoundingClientRect();place(popup,r.left,r.bottom+5,r.top-5,width??Math.max(150,r.width));}
export function placePoint(popup:HTMLElement,x:number,y:number,gap=8){place(popup,x+gap,y+gap,y-gap);}
function follow(popup:HTMLElement,trigger:HTMLElement,width?:()=>number){
 const parent=popup.parentElement!,next=popup.nextSibling,portal=trigger.closest('dialog[open]')||document.body;
 const focused=document.activeElement,ownsFocus=popup.contains(focused);
 portal.append(popup);popup.dataset.overlayPortal='';let frame=0;
 const update=()=>{frame=0;if(!popup.isConnected||popup.hidden)return;if(!trigger.isConnected||!trigger.getClientRects().length){popup.hidden=true;return;}const rendered=trigger.getBoundingClientRect().width/Math.max(1,parseFloat(getComputedStyle(trigger).width));popup.style.zoom=portal===document.body?String(rendered):'1';placePopup(popup,trigger,width?.());};
 const queue=()=>{if(!frame)frame=requestAnimationFrame(update);};
 const abort=new AbortController();document.addEventListener('scroll',queue,{capture:true,passive:true,signal:abort.signal});window.addEventListener('resize',queue,{signal:abort.signal});
 const observer=new ResizeObserver(queue);observer.observe(trigger);observer.observe(popup);update();if(ownsFocus&&focused instanceof HTMLElement)focused.focus({preventScroll:true});
 return ()=>{abort.abort();observer.disconnect();cancelAnimationFrame(frame);delete popup.dataset.overlayPortal;popup.style.cssText='';if(parent.isConnected)parent.insertBefore(popup,next?.parentNode===parent?next:null);};
}
function disclosure(shell:HTMLDetailsElement,popup:HTMLElement){
 const trigger=shell.querySelector<HTMLElement>('summary')!;let release:(()=>void)|undefined;
 popup.hidden=true;
 const toggle=()=>{release?.();release=undefined;popup.hidden=!shell.open;trigger.setAttribute('aria-expanded',String(shell.open));if(shell.open)release=follow(popup,trigger);};
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
document.addEventListener('toggle',event=>{const menu=event.target;if(!(menu instanceof HTMLDetailsElement)||!menu.hasAttribute('data-action-menu'))return;const state=menu as any;state._overlayRelease?.();state._overlayRelease=null;const panel=state._overlayPanel||menu.querySelector<HTMLElement>(':scope > div'),trigger=menu.querySelector<HTMLElement>('summary');if(panel&&trigger){state._overlayPanel=panel;panel.hidden=!menu.open;if(menu.open){menu.dataset.menuOwner||=String(++menuId);panel.dataset.menuOwner=menu.dataset.menuOwner;state._overlayRelease=follow(panel,trigger);menu.closest('dialog')?.addEventListener('close',()=>{state._overlayRelease?.();panel.remove();},{once:true});}}},true);
