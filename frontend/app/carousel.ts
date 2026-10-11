/** Two reviewable gallery layouts share one bounded, gesture-driven carousel. */
export function mountCarousel(host:HTMLElement,signal:AbortSignal){
  const cards=[...host.children] as HTMLElement[];
  if(cards.length<2)return ()=>{};
  host.classList.add('lingxi-carousel');host.dataset.scheme='stack';
  const controls=document.createElement('div');controls.className='carousel-controls';
  controls.innerHTML='<button type="button" data-carousel-prev aria-label="上一项">←</button><output aria-live="polite"></output><button type="button" data-carousel-next aria-label="下一项">→</button><label>预览方案<select aria-label="轮播方案"><option value="stack">A · 居中堆叠</option><option value="rail">B · 横向陈列</option></select></label>';
  host.after(controls);
  let index=0,start=0,moving=false,dragged=false,wheelAt=-Infinity;
  const paint=()=>{
    cards.forEach((card,i)=>{let d=(i-index+cards.length)%cards.length;if(d>cards.length/2)d-=cards.length;card.style.setProperty('--carousel-offset',String(d));card.style.setProperty('--carousel-distance',String(Math.abs(d)));card.dataset.carouselCurrent=String(d===0);card.dataset.carouselVisible=String(Math.abs(d)<=2);card.inert=Math.abs(d)>1;});
    controls.querySelector('output')!.textContent=`${index+1} / ${cards.length}`;
  };
  const move=(direction:number)=>{index=(index+direction+cards.length)%cards.length;paint();};
  controls.querySelector('[data-carousel-prev]')!.addEventListener('click',()=>move(-1),{signal});
  controls.querySelector('[data-carousel-next]')!.addEventListener('click',()=>move(1),{signal});
  controls.querySelector('select')!.addEventListener('change',event=>{host.dataset.scheme=(event.target as HTMLSelectElement).value;},{signal});
  cards.forEach((card,i)=>card.addEventListener('click',event=>{if(dragged){event.preventDefault();event.stopPropagation();dragged=false;return;}if(i!==index){event.preventDefault();event.stopPropagation();index=i;paint();}},{signal,capture:true}));
  host.addEventListener('pointerdown',event=>{if(event.button!==0||((event.target as Element).closest('button,input,select')))return;start=event.clientX;moving=true;dragged=false;host.setPointerCapture(event.pointerId);},{signal});
  host.addEventListener('pointermove',event=>{if(moving&&Math.abs(event.clientX-start)>8)dragged=true;},{signal});
  const end=(event:PointerEvent)=>{if(!moving)return;moving=false;if(Math.abs(event.clientX-start)>40)move(event.clientX<start?1:-1);};
  host.addEventListener('pointerup',end,{signal});host.addEventListener('pointercancel',()=>{moving=false;dragged=false;},{signal});
  host.addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey)return;const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;if(Math.abs(delta)<4)return;event.preventDefault();if(performance.now()-wheelAt>320){move(delta>0?1:-1);wheelAt=performance.now();}},{passive:false,signal});
  host.tabIndex=0;host.addEventListener('keydown',event=>{if(event.target!==host)return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move(event.key==='ArrowLeft'?-1:1);}},{signal});
  const size=()=>{host.style.setProperty('--carousel-height',Math.max(...cards.map(c=>c.offsetHeight))+24+'px');};
  const observer=new ResizeObserver(size);cards.forEach(card=>observer.observe(card));paint();size();
  return ()=>{observer.disconnect();controls.remove();};
}
