/** Bounded horizontal gallery. Wheel gestures belong to the page. */
export function mountCarousel(host:HTMLElement,signal:AbortSignal){
  const cards=[...host.children] as HTMLElement[];
  if(cards.length<2)return ()=>{};
  host.classList.add('lingxi-carousel');
  const previous=document.createElement('button'),next=document.createElement('button');
  for(const [button,label,text] of [[previous,'上一项','←'],[next,'下一项','→']] as const){button.type='button';button.className='carousel-arrow';button.setAttribute('aria-label',label);button.textContent=text;host.append(button);}
  previous.dataset.carouselPrev='';next.dataset.carouselNext='';
  const controls=document.createElement('div');controls.className='carousel-controls';controls.setAttribute('aria-label','预览项目');
  const dots=cards.map((_,i)=>{const dot=document.createElement('button');dot.type='button';dot.className='carousel-dot';dot.setAttribute('aria-label',`查看第 ${i+1} 项，共 ${cards.length} 项`);dot.addEventListener('click',()=>{index=i;paint();},{signal});controls.append(dot);return dot;});host.after(controls);
  let index=0,start=0,moving=false,dragged=false,frame=0,height=0;
  const paint=()=>{
    cards.forEach((card,i)=>{let d=(i-index+cards.length)%cards.length;if(d>cards.length/2)d-=cards.length;card.style.setProperty('--carousel-offset',String(d));card.style.setProperty('--carousel-distance',String(Math.abs(d)));card.dataset.carouselCurrent=String(d===0);card.dataset.carouselVisible=String(Math.abs(d)<=1);card.inert=d!==0;});
    dots.forEach((dot,i)=>dot.setAttribute('aria-current',String(i===index)));
  };
  const move=(direction:number)=>{index=(index+direction+cards.length)%cards.length;paint();};
  previous.addEventListener('click',()=>move(-1),{signal});next.addEventListener('click',()=>move(1),{signal});
  host.addEventListener('pointerdown',event=>{if(event.button!==0||(event.target as Element).closest('button,input,select,textarea,a'))return;start=event.clientX;moving=true;dragged=false;host.setPointerCapture(event.pointerId);},{signal});
  host.addEventListener('pointermove',event=>{if(moving&&Math.abs(event.clientX-start)>8)dragged=true;},{signal});
  host.addEventListener('pointerup',event=>{if(!moving)return;moving=false;if(Math.abs(event.clientX-start)>40)move(event.clientX<start?1:-1);},{signal});
  host.addEventListener('pointercancel',()=>{moving=false;dragged=false;},{signal});
  host.addEventListener('click',event=>{if(dragged){event.preventDefault();event.stopPropagation();dragged=false;}},{signal,capture:true});
  host.tabIndex=0;host.addEventListener('keydown',event=>{if(event.target!==host)return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move(event.key==='ArrowLeft'?-1:1);}},{signal});
  const size=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const measured=Math.max(...cards.map(c=>c.offsetHeight))+24;if(measured!==height){height=measured;host.style.setProperty('--carousel-height',height+'px');}});};
  const observer=new ResizeObserver(size);cards.forEach(card=>observer.observe(card));paint();size();
  return ()=>{cancelAnimationFrame(frame);observer.disconnect();previous.remove();next.remove();controls.remove();};
}
