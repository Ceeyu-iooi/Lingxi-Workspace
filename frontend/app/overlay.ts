/** Convert viewport coordinates using the actual portal geometry, never a stale scale. */
function place(popup:HTMLElement,left:number,below:number,above:number,desiredWidth?:number){
  popup.style.position='fixed';popup.style.left='0px';popup.style.top='0px';
  // offsetWidth rounds CSS pixels; at fractional zoom that error drifts large offsets.
  const origin=popup.getBoundingClientRect(),scale=origin.width/Math.max(1,parseFloat(getComputedStyle(popup).width))||1;
  const width=Math.min(desiredWidth??origin.width,innerWidth-16);
  popup.style.width=width/scale+'px';popup.style.maxHeight=(innerHeight-16)/scale+'px';popup.style.overflowY='auto';
  const bounds=popup.getBoundingClientRect(),x=Math.max(8,Math.min(left,innerWidth-width-8));
  const top=Math.max(8,below+bounds.height<=innerHeight-8?below:Math.min(above-bounds.height,innerHeight-bounds.height-8));
  popup.style.left=(x-origin.left)/scale+'px';popup.style.top=(top-origin.top)/scale+'px';
}
export function placePopup(popup:HTMLElement,button:HTMLElement){const r=button.getBoundingClientRect();place(popup,r.left,r.bottom+5,r.top-5,Math.max(150,r.width));}
export function placePoint(popup:HTMLElement,x:number,y:number,gap=8){place(popup,x+gap,y+gap,y-gap);}
(window as any).WorkbenchOverlay={place:placePopup,point:placePoint};

// Shared light-dismiss and keyboard behavior for action menus, not disclosure panels.
document.addEventListener('pointerdown',event=>document.querySelectorAll<HTMLDetailsElement>('[data-action-menu][open]').forEach(menu=>{if(!menu.contains(event.target as Node))menu.open=false;}));
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=document.querySelector<HTMLDetailsElement>('[data-action-menu][open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();}},true);
document.addEventListener('toggle',event=>{const menu=event.target;if(menu instanceof HTMLDetailsElement&&menu.open&&menu.hasAttribute('data-action-menu')){const panel=menu.querySelector<HTMLElement>(':scope > div'),trigger=menu.querySelector<HTMLElement>('summary');if(panel&&trigger)placePopup(panel,trigger);}},true);
